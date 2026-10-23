//! Imported history: entries and day totals from a diary export, and its
//! rows matched to a food.

use super::prelude::*;
use crate::model::import::{MatchReport, NOT_GRAMS, Skipped, grams_in};

/// Write a read Cronometer export (`crate::import::read`) in one
/// transaction: the imported history of every day it covers is replaced.
/// A name matched to a food ([`imported_match`]) before is matched again.
///
/// # Errors
/// A write fails; nothing is written then.
pub fn cronometer_apply(
    conn: &mut Connection,
    profile: ProfileId,
    parsed: crate::model::import::Parsed,
) -> Result<crate::model::import::Report, Error> {
    let tx = write(conn)?;
    let days: BTreeSet<&str> = parsed
        .servings
        .iter()
        .flatten()
        .map(|r| r.day.as_str())
        .chain(
            parsed
                .summary
                .iter()
                .flat_map(|s| s.days.iter().map(String::as_str)),
        )
        .collect();
    let matches = matches_undone(&tx, profile, &days)?;
    if let Some(rows) = &parsed.servings {
        imported_entries_replace(&tx, profile, rows)?;
    }
    if let Some(s) = &parsed.summary {
        day_totals_replace(&tx, profile, &s.days, &s.rows)?;
    }
    for (name, food_id) in matches {
        match_rows(&tx, profile, &name, &written(food_get(&tx, food_id)?))?;
    }
    tx.commit()?;
    Ok(parsed.report())
}

/// Replace imported entries for every day present in `rows`.
pub fn imported_entries_replace(
    tx: &Connection,
    profile: ProfileId,
    rows: &[ImportedEntry],
) -> Result<(), Error> {
    let days: BTreeSet<&str> = rows.iter().map(|r| r.day.as_str()).collect();
    for day in days {
        tx.execute(
            "DELETE FROM entry WHERE src_grp IS NOT NULL AND profile_id = ? AND day = ?",
            params![profile, day],
        )?;
    }
    for r in rows {
        tx.execute(
            "INSERT INTO entry (profile_id, day, grp, src_grp, name, amount)
             VALUES (?1, ?2, ?3, ?3, ?4, ?5)",
            params![profile, r.day, r.group, r.name, r.amount],
        )?;
    }
    Ok(())
}

/// Replace imported group totals for every day in `days`.
pub fn day_totals_replace(
    tx: &Connection,
    profile: ProfileId,
    days: &[String],
    rows: &[DayTotal],
) -> Result<(), Error> {
    for day in days {
        tx.execute(
            "DELETE FROM day_total WHERE profile_id = ? AND day = ?",
            params![profile, day],
        )?;
    }
    for r in rows {
        tx.execute(
            "INSERT INTO day_total (profile_id, day, grp, nutrients) VALUES (?, ?, ?, ?)",
            params![profile, r.day, r.group, json(&r.nutrients)],
        )?;
    }
    Ok(())
}

/// Match the profile's imported rows named `name` (any case), on every
/// day, to food `food_id`: each whose amount is grams of it ([`grams_in`])
/// takes the food, its grams and its values, and its import group's total
/// that day gives them up (never below 0). A row stays imported history:
/// read-only, removed with its group. One matched to another food is
/// matched anew; one matched to this food stays as it is.
///
/// # Errors
/// 400 `food_id` for an unknown food.
pub fn imported_match(
    conn: &mut Connection,
    profile: ProfileId,
    name: &str,
    food_id: i64,
) -> Result<MatchReport, Error> {
    let tx = write(conn)?;
    let food = food_get(&tx, food_id)?
        .ok_or_else(|| Error::invalid_field("food_id", format!("unknown food {food_id}")))?;
    let report = match_rows(&tx, profile, name, &food)?;
    tx.commit()?;
    Ok(report)
}

fn match_rows(
    tx: &Connection,
    profile: ProfileId,
    name: &str,
    food: &Food,
) -> Result<MatchReport, Error> {
    type Read = (i64, String, String, Option<i64>, String);
    let rows: Vec<Read> = tx
        .prepare_cached(
            "SELECT id, day, src_grp, food_id, amount FROM entry
             WHERE profile_id = ? AND src_grp IS NOT NULL AND name = ? COLLATE NOCASE",
        )?
        .query_map(params![profile, name], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
        })?
        .collect::<rusqlite::Result<_>>()?;
    let mut report = MatchReport::default();
    let mut not_grams = 0;
    for (id, day, group, matched, amount) in rows {
        if matched == Some(food.id) {
            continue;
        }
        if matched.is_some() {
            unmatch(tx, profile, id)?;
        }
        let Some(grams) = grams_in(&amount, food) else {
            not_grams += 1;
            continue;
        };
        let n = food.per100.scale(grams / 100.0);
        tx.execute(
            "UPDATE entry SET food_id = ?, grams = ?, nutrients = ? WHERE id = ?",
            params![food.id, grams, json(&n), id],
        )?;
        total_less(tx, profile, (&day, &group), &n, 1.0)?;
        report.matched += 1;
    }
    if not_grams > 0 {
        report.skipped.push(Skipped {
            reason: NOT_GRAMS,
            count: not_grams,
        });
    }
    Ok(report)
}

/// Undo the matches of the profile's imported rows on `days`, which an
/// import is about to replace; what each matched name was matched to.
fn matches_undone(
    tx: &Connection,
    profile: ProfileId,
    days: &BTreeSet<&str>,
) -> Result<BTreeMap<String, i64>, Error> {
    let rows: Vec<(i64, String, String, i64)> = tx
        .prepare_cached(
            "SELECT id, day, name, food_id FROM entry
             WHERE profile_id = ? AND src_grp IS NOT NULL AND food_id IS NOT NULL
             ORDER BY id",
        )?
        .query_map([profile], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })?
        .collect::<rusqlite::Result<_>>()?;
    let mut matches = BTreeMap::new();
    for (id, day, name, food_id) in rows {
        if days.contains(day.as_str()) {
            unmatch(tx, profile, id)?;
        }
        matches.insert(name, food_id);
    }
    Ok(matches)
}

/// A matched row back to imported history: its values go back into its
/// group's total.
fn unmatch(tx: &Connection, profile: ProfileId, id: i64) -> Result<(), Error> {
    let (day, group, text): (String, String, String) = tx.query_row(
        "SELECT day, src_grp, nutrients FROM entry WHERE id = ?",
        [id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;
    total_less(tx, profile, (&day, &group), &from_json(&text)?, -1.0)?;
    tx.execute(
        "UPDATE entry SET food_id = NULL, grams = NULL, nutrients = NULL WHERE id = ?",
        [id],
    )?;
    Ok(())
}

/// Take `sign` × `n` from the profile's imported total of `(day, group)`,
/// key by key where the total has one, never below 0.
fn total_less(
    tx: &Connection,
    profile: ProfileId,
    (day, group): (&str, &str),
    n: &Nutrients,
    sign: f64,
) -> Result<(), Error> {
    let at = params![profile, day, group];
    let Some(text) = tx
        .query_row(
            "SELECT nutrients FROM day_total WHERE profile_id = ? AND day = ? AND grp = ?",
            at,
            |r| r.get::<_, String>(0),
        )
        .optional()?
    else {
        return Ok(());
    };
    let mut total: Nutrients = from_json(&text)?;
    for key in total.keys().collect::<Vec<_>>() {
        if let (Some(t), Some(v)) = (total.get(key), n.get(key)) {
            total.insert(key, sign.mul_add(-v, t).max(0.0));
        }
    }
    tx.execute(
        "UPDATE day_total SET nutrients = ? WHERE profile_id = ? AND day = ? AND grp = ?",
        params![json(&total), profile, day, group],
    )?;
    Ok(())
}
