//! Cronometer export import.
//!
//! `servings.csv` carries no nutrients, so its rows become name/amount-only
//! entries; nutrients come from `dailysummary.csv`, per group (or per day,
//! when the diary isn't split by meal).
//! Both imports replace whole days, so re-running with a newer export is safe.

use std::collections::{BTreeMap, HashMap};
use std::io::Read;

use rusqlite::Connection;

use crate::db;
use crate::error::Error;
use crate::model::{
    DayTotal, EATEN, ImportedEntry, LABEL_MAX, NAME_MAX, PLANNED, ProfileId, is_date, text,
};
use crate::nutrients::{Nutrients, REGISTRY};

use crate::model::import::Summary;
pub use crate::model::import::{Parsed, Report, SummaryReport};

/// The export writes amounts as `20.00 g` or `1.00 x 330.0 ml`; drop the
/// trailing zeros so they read `20 g`, `1 x 330 ml`.
fn tidy_amount(amount: &str) -> String {
    amount
        .split(' ')
        .map(|word| {
            if word.contains('.') && word.parse::<f64>().is_ok() {
                word.trim_end_matches('0').trim_end_matches('.')
            } else {
                word
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// The export's "Remaining" group is called "Planned" here, and
/// "Consumed" "Eaten".
fn group_name(name: &str) -> String {
    match name {
        "Remaining" => PLANNED,
        "Consumed" => EATEN,
        other => other,
    }
    .to_owned()
}

/// Index of column `name`; the error names the export the file should be.
fn column(headers: &csv::StringRecord, name: &str, file: &str) -> Result<usize, Error> {
    headers
        .iter()
        .position(|h| h == name)
        .ok_or_else(|| Error::invalid(format!("missing column {name:?}; is this {file}?")))
}

/// The line a record starts on, counting the header as line 1; a quoted
/// field may span lines.
fn line(r: &csv::StringRecord) -> u64 {
    r.position().map_or(0, csv::Position::line)
}

fn row_date(day: &str) -> Result<String, Error> {
    if is_date(day) {
        Ok(day.to_owned())
    } else {
        Err(Error::invalid(format!("bad date {day:?}")))
    }
}

/// The profile an import goes to: the named one, or the only one there is.
///
/// # Errors
/// Fails if the name is unknown, or if no name is given and there are several
/// profiles.
pub fn profile_for(conn: &Connection, name: Option<&str>) -> Result<ProfileId, Error> {
    if let Some(name) = name {
        return db::profile_by_name(conn, name)?
            .map(|p| p.id)
            .ok_or_else(|| Error::invalid(format!("no profile named {name:?}")));
    }
    match db::profile_list(conn)?.as_slice() {
        [only] => Ok(only.id),
        many => Err(Error::invalid(format!(
            "several profiles exist; choose one with --profile ({})",
            // Quoted and escaped: a name is shown in the admin's terminal.
            many.iter()
                .map(|p| format!("{:?}", p.name))
                .collect::<Vec<_>>()
                .join(", ")
        ))),
    }
}

/// Read both export files, without a connection: the server parses them
/// off the database lock, then writes them ([`db::cronometer_apply`]).
///
/// # Errors
/// Malformed CSV, unknown columns, bad values: `Invalid`, blamed on field
/// `servings` or `summary`, naming the file and line.
pub fn read(servings: Option<impl Read>, summary: Option<impl Read>) -> Result<Parsed, Error> {
    Ok(Parsed {
        servings: servings
            .map(read_servings)
            .transpose()
            .map_err(|e| blame(e, "servings", "servings.csv"))?,
        summary: summary
            .map(read_summary)
            .transpose()
            .map_err(|e| blame(e, "summary", "dailysummary.csv"))?,
    })
}

/// Read both export files, then write them in one transaction: a bad file
/// leaves the database as it was.
///
/// # Errors
/// As [`read`]; nothing is written then.
pub fn import(
    conn: &mut Connection,
    profile: ProfileId,
    servings: Option<impl Read>,
    summary: Option<impl Read>,
) -> Result<Report, Error> {
    db::cronometer_apply(conn, profile, read(servings, summary)?)
}

/// A file's error as bad input in `field`: the CSV reader's own errors
/// (a ragged row) included, prefixed with the file they're in.
fn blame(e: Error, field: &str, file: &str) -> Error {
    match e {
        Error::Invalid { message, .. } => Error::invalid_field(field, message),
        Error::Csv(e) => Error::invalid_field(field, format!("in {file}: {e}")),
        e => e,
    }
}

fn read_servings(reader: impl Read) -> Result<Vec<ImportedEntry>, Error> {
    let mut rdr = csv::Reader::from_reader(reader);
    let headers = rdr.headers()?.clone();
    let (day, group, name, amount) = (
        column(&headers, "Day", "servings.csv")?,
        column(&headers, "Group", "servings.csv")?,
        column(&headers, "Food Name", "servings.csv")?,
        column(&headers, "Amount", "servings.csv")?,
    );

    let mut rows = Vec::new();
    for record in rdr.records() {
        let r = record?;
        let at = |e: Error| Error::invalid(format!("line {} of servings.csv: {e}", line(&r)));
        rows.push(ImportedEntry {
            day: row_date(&r[day]).map_err(at)?,
            group: text(&group_name(&r[group]), "group", LABEL_MAX).map_err(at)?,
            name: text(&r[name], "food name", NAME_MAX).map_err(at)?,
            amount: text(&tidy_amount(&r[amount]), "amount", LABEL_MAX).map_err(at)?,
        });
    }
    Ok(rows)
}

fn parse_nutrients(
    r: &csv::StringRecord,
    cols: &[(usize, &'static str)],
) -> Result<Nutrients, Error> {
    let mut n = Nutrients::default();
    for &(i, key) in cols {
        let raw = r[i].trim();
        if raw.is_empty() {
            continue;
        }
        let v: f64 = raw
            .parse()
            .map_err(|_| Error::invalid(format!("bad number {raw:?} for {key}")))?;
        n.insert(key, v);
    }
    n.validate()
        .map_err(|k| Error::invalid(format!("bad value for {k}")))?;
    Ok(n)
}

/// The export's `dailysummary.csv` nutrient headers and their registry keys.
const EXPORT_COLUMNS: [(&str, &str); 61] = [
    ("Energy (kcal)", "energy"),
    ("Alcohol (g)", "alcohol"),
    ("Caffeine (mg)", "caffeine"),
    ("Oxalate (mg)", "oxalate"),
    ("Phytate (mg)", "phytate"),
    ("Water (g)", "water"),
    ("B1 (Thiamine) (mg)", "b1"),
    ("B2 (Riboflavin) (mg)", "b2"),
    ("B3 (Niacin) (mg)", "b3"),
    ("B5 (Pantothenic Acid) (mg)", "b5"),
    ("B6 (Pyridoxine) (mg)", "b6"),
    ("B12 (Cobalamin) (µg)", "b12"),
    ("Folate (µg)", "folate"),
    // µg RAE, where the app keeps RE (EFSA, as Fineli's is converted). The
    // export has no retinol or carotenoid split to convert it by, but RAE
    // never exceeds RE (carotenoids count half), and an imported total is
    // known only for energy and the macros (db::diary IMPORT_KNOWN): it
    // reads as a floor or "–", never as the day's RE.
    ("Vitamin A (µg)", "vitamin_a"),
    ("Vitamin C (mg)", "vitamin_c"),
    ("Vitamin D (IU)", "vitamin_d"),
    ("Vitamin E (mg)", "vitamin_e"),
    ("Vitamin K (µg)", "vitamin_k"),
    ("Calcium (mg)", "calcium"),
    ("Copper (mg)", "copper"),
    ("Iron (mg)", "iron"),
    ("Magnesium (mg)", "magnesium"),
    ("Manganese (mg)", "manganese"),
    ("Phosphorus (mg)", "phosphorus"),
    ("Potassium (mg)", "potassium"),
    ("Selenium (µg)", "selenium"),
    ("Sodium (mg)", "sodium"),
    ("Zinc (mg)", "zinc"),
    ("Net Carbs (g)", "net_carbs"),
    ("Carbs (g)", "carbs"),
    ("Fiber (g)", "fiber"),
    ("Insoluble Fiber (g)", "insoluble_fiber"),
    ("Soluble Fiber (g)", "soluble_fiber"),
    ("Starch (g)", "starch"),
    ("Sugars (g)", "sugars"),
    ("Added Sugars (g)", "added_sugars"),
    ("Fat (g)", "fat"),
    ("Cholesterol (mg)", "cholesterol"),
    ("Monounsaturated (g)", "monounsaturated"),
    ("Polyunsaturated (g)", "polyunsaturated"),
    ("Saturated (g)", "saturated"),
    ("Trans-Fats (g)", "trans_fats"),
    ("Omega-3 (g)", "omega_3"),
    ("ALA (g)", "ala"),
    ("DHA (g)", "dha"),
    ("EPA (g)", "epa"),
    ("Omega-6 (g)", "omega_6"),
    ("AA (g)", "aa"),
    ("LA (g)", "la"),
    ("Cystine (g)", "cystine"),
    ("Histidine (g)", "histidine"),
    ("Isoleucine (g)", "isoleucine"),
    ("Leucine (g)", "leucine"),
    ("Lysine (g)", "lysine"),
    ("Methionine (g)", "methionine"),
    ("Phenylalanine (g)", "phenylalanine"),
    ("Protein (g)", "protein"),
    ("Threonine (g)", "threonine"),
    ("Tryptophan (g)", "tryptophan"),
    ("Tyrosine (g)", "tyrosine"),
    ("Valine (g)", "valine"),
];

/// Map nutrient columns to registry keys; every other column must be one
/// of `known` or `Completed`.
fn nutrient_columns(
    headers: &csv::StringRecord,
    known: &[usize],
) -> Result<Vec<(usize, &'static str)>, Error> {
    let by_header: HashMap<&str, &'static str> = EXPORT_COLUMNS.into_iter().collect();
    let mut cols = Vec::new();
    let mut unknown = Vec::new();
    for (i, h) in headers.iter().enumerate() {
        match by_header.get(h) {
            Some(key) => cols.push((i, *key)),
            None if known.contains(&i) || h == "Completed" => {}
            None => unknown.push(h.to_owned()),
        }
    }
    if unknown.is_empty() {
        Ok(cols)
    } else {
        Err(Error::invalid(format!(
            "unknown columns in dailysummary.csv: {}",
            unknown.join(", ")
        )))
    }
}

/// Days whose group totals don't add up to the export's `Total` row.
fn mismatched_days(rows: &[DayTotal], totals: &BTreeMap<String, Nutrients>) -> Vec<String> {
    let mut sums: BTreeMap<&str, Nutrients> = BTreeMap::new();
    for r in rows {
        sums.entry(&r.day).or_default().add(&r.nutrients);
    }
    totals
        .iter()
        .filter(|(day, total)| {
            mismatched(
                sums.get(day.as_str()).unwrap_or(&Nutrients::default()),
                total,
            )
        })
        .map(|(day, _)| day.clone())
        .collect()
}

fn mismatched(groups: &Nutrients, total: &Nutrients) -> bool {
    REGISTRY.iter().any(|n| {
        let g = groups.get(n.key).unwrap_or_default();
        let t = total.get(n.key).unwrap_or_default();
        // The export rounds each row to 2 decimals.
        (g - t).abs() > 0.05 + t.abs() * 0.001
    })
}

fn read_summary(reader: impl Read) -> Result<Summary, Error> {
    let mut rdr = csv::Reader::from_reader(reader);
    let headers = rdr.headers()?.clone();
    let date = column(&headers, "Date", "dailysummary.csv")?;
    // Without `Group` (a diary not split by meal) each row is the day's
    // total, eaten: there are no groups to check against it.
    let group = headers.iter().position(|h| h == "Group");
    let known: Vec<usize> = [Some(date), group].into_iter().flatten().collect();
    let cols = nutrient_columns(&headers, &known)?;

    let mut days = Vec::new();
    let mut rows = Vec::new();
    let mut totals: BTreeMap<String, Nutrients> = BTreeMap::new();
    for record in rdr.records() {
        let r = record?;
        let at = |e: Error| Error::invalid(format!("line {} of dailysummary.csv: {e}", line(&r)));
        let day = row_date(&r[date]).map_err(at)?;
        let n = parse_nutrients(&r, &cols).map_err(at)?;
        days.push(day.clone());
        if n.is_empty() {
            continue;
        }
        match group.map(|g| &r[g]) {
            Some("Total") => {
                totals.insert(day, n);
            }
            g => rows.push(DayTotal {
                day,
                group: g.map_or_else(|| EATEN.to_owned(), group_name),
                nutrients: n,
            }),
        }
    }
    days.sort();
    days.dedup();

    let report = SummaryReport {
        days: days.len(),
        groups: rows.len(),
        mismatched_days: mismatched_days(&rows, &totals),
    };
    Ok(Summary { days, rows, report })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_nutrient_has_exactly_one_export_column() {
        // Except creatine and derived ones: the export has no column for them.
        assert!(REGISTRY.iter().any(|n| n.key == "creatine"));
        for n in &REGISTRY {
            let hits = EXPORT_COLUMNS.iter().filter(|(_, k)| *k == n.key).count();
            let exported = n.key != "creatine" && !n.derived();
            assert_eq!(hits, usize::from(exported), "{}", n.key);
        }
        let headers: std::collections::HashSet<_> = EXPORT_COLUMNS.iter().map(|(h, _)| h).collect();
        assert_eq!(headers.len(), EXPORT_COLUMNS.len(), "headers are unique");
        assert!(EXPORT_COLUMNS.contains(&("B12 (Cobalamin) (µg)", "b12")));
    }

    #[test]
    fn amounts_drop_trailing_zeros() {
        assert_eq!(tidy_amount("20.00 g"), "20 g");
        assert_eq!(tidy_amount("1.00 x 330.0 ml"), "1 x 330 ml");
        assert_eq!(tidy_amount("0.50 tab"), "0.5 tab");
        assert_eq!(tidy_amount("1.25 Serving"), "1.25 Serving");
        assert_eq!(tidy_amount("3.00 Tbsp (15ml)"), "3 Tbsp (15ml)");
        assert_eq!(
            tidy_amount("1.00 large - 7\" to 8 1/4\" long"),
            "1 large - 7\" to 8 1/4\" long"
        );
    }

    #[test]
    fn mismatch_tolerates_rounding_only() {
        // Tolerance at 1000 kcal: 0.05 + 0.1 % = 1.05.
        let total = Nutrients::of(&[("energy", 1000.0)]);
        assert!(!mismatched(&Nutrients::of(&[("energy", 1001.04)]), &total));
        assert!(mismatched(&Nutrients::of(&[("energy", 1001.06)]), &total));
        assert!(mismatched(&Nutrients::default(), &total));
    }
}
