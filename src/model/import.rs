//! A Cronometer export read (`crate::import`), before and after it is
//! written (`db::cronometer_apply`): what both sides share.

use std::collections::BTreeSet;

use serde::Serialize;

use super::{DayTotal, ImportedEntry};

/// What an import wrote.
#[derive(Debug, Serialize)]
pub struct Report {
    /// Entries from `servings.csv`.
    pub entries: usize,
    /// Days either file covers; each one's imported history was replaced.
    pub days: usize,
    pub summary: Option<SummaryReport>,
}

/// Outcome of a `dailysummary.csv` import.
#[derive(Debug, Serialize)]
pub struct SummaryReport {
    pub days: usize,
    pub groups: usize,
    /// Days whose group rows don't add up to the export's `Total` row.
    pub mismatched_days: Vec<String>,
}

/// Both export files, read and checked: nothing written yet.
pub struct Parsed {
    pub(crate) servings: Option<Vec<ImportedEntry>>,
    pub(crate) summary: Option<Summary>,
}

impl Parsed {
    /// What writing it writes.
    pub(crate) fn report(self) -> Report {
        let rows = self.servings.unwrap_or_default();
        let days: BTreeSet<&str> = rows
            .iter()
            .map(|r| r.day.as_str())
            .chain(
                self.summary
                    .iter()
                    .flat_map(|s| s.days.iter().map(String::as_str)),
            )
            .collect();
        Report {
            entries: rows.len(),
            days: days.len(),
            summary: self.summary.map(|s| s.report),
        }
    }
}

/// What matching imported rows to a food (`db::imported_match`) did.
#[derive(Debug, Default, Serialize)]
pub struct MatchReport {
    /// Rows that took the food now.
    pub matched: usize,
    /// Rows of the name left as they were, by why.
    pub skipped: Vec<Skipped>,
}

#[derive(Debug, Serialize)]
pub struct Skipped {
    pub reason: &'static str,
    pub count: usize,
}

/// Why a row isn't matched: its amount says no grams of the food.
pub const NOT_GRAMS: &str = "amount not in grams";

/// The grams an imported row's `amount` (as `crate::import` tidies it) is
/// of `food`: `5 g`, `2 x 35 g`, or `1.5 scoop` of one of its servings,
/// any case. `None` for anything else (`1 x 330 ml`).
#[must_use]
pub fn grams_in(amount: &str, food: &super::Food) -> Option<f64> {
    let words: Vec<&str> = amount.split_whitespace().collect();
    let number = |s: &str| s.parse::<f64>().ok().filter(|n| n.is_finite() && *n > 0.0);
    let grams = match words.as_slice() {
        [n, "g"] => number(n)?,
        [n, "x", m, "g"] => number(n)? * number(m)?,
        [n, label @ ..] => {
            let label = label.join(" ").to_lowercase();
            let serving = food
                .servings
                .iter()
                .find(|s| s.label.to_lowercase() == label)?;
            number(n)? * serving.grams
        }
        [] => return None,
    };
    super::grams(grams).ok()
}

/// A parsed `dailysummary.csv`.
pub(crate) struct Summary {
    pub(crate) days: Vec<String>,
    pub(crate) rows: Vec<DayTotal>,
    pub(crate) report: SummaryReport,
}
