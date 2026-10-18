//! Imported history: entries and day totals from a diary export.

use super::prelude::*;

/// Write a read Cronometer export (`crate::import::read`) in one
/// transaction: the imported history of every day it covers is replaced.
///
/// # Errors
/// A write fails; nothing is written then.
pub fn cronometer_apply(
    conn: &mut Connection,
    profile: ProfileId,
    parsed: crate::model::import::Parsed,
) -> Result<crate::model::import::Report, Error> {
    let tx = write(conn)?;
    if let Some(rows) = &parsed.servings {
        imported_entries_replace(&tx, profile, rows)?;
    }
    if let Some(s) = &parsed.summary {
        day_totals_replace(&tx, profile, &s.days, &s.rows)?;
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
