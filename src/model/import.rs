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

/// A parsed `dailysummary.csv`.
pub(crate) struct Summary {
    pub(crate) days: Vec<String>,
    pub(crate) rows: Vec<DayTotal>,
    pub(crate) report: SummaryReport,
}
