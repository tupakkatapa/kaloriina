//! Reports over the diary: where a nutrient came from.

use super::prelude::*;
use super::{group_rows, group_sums};
use crate::model::PLANNED;

/// A food's part of one nutrient over a range.
#[derive(Debug, Serialize)]
pub struct Contributor {
    pub food_id: i64,
    pub name: String,
    /// In the nutrient's stored unit.
    pub amount: f64,
    /// Of the range's total, 0–1.
    pub share: f64,
}

#[derive(Debug, Serialize)]
pub struct NutrientSources {
    pub nutrient: String,
    /// Everything eaten in the range, imported history included: the same
    /// number the Summary averages.
    pub total: f64,
    /// The part no food can be named for: imported day totals.
    pub unattributed: f64,
    /// The largest contributors first, at most [`SOURCES_MAX`].
    pub foods: Vec<Contributor>,
}

/// Contributors listed by [`nutrient_sources`].
pub const SOURCES_MAX: usize = 20;

/// Which eaten foods (every group but Planned) supplied `nutrient` (a
/// registry key) in `[from, to]`. Entries of one food add up under the
/// food's current name.
pub fn nutrient_sources(
    conn: &Connection,
    profile: ProfileId,
    from: &str,
    to: &str,
    nutrient: &str,
) -> Result<NutrientSources, Error> {
    let total: f64 = group_sums(group_rows(conn, profile, from, to)?)?
        .into_iter()
        .filter(|((_, group), _)| group != PLANNED)
        .filter_map(|(_, n)| n.get(nutrient))
        .sum();
    let mut stmt = conn.prepare_cached(
        "SELECT e.food_id, f.name,
             sum(json_extract(e.nutrients, '$.' || ?5)) AS part
         FROM entry e JOIN food f ON f.id = e.food_id
         WHERE e.profile_id = ?1 AND e.day BETWEEN ?2 AND ?3 AND e.grp != ?4
             AND e.nutrients IS NOT NULL
         GROUP BY e.food_id
         HAVING part > 0
         ORDER BY part DESC, fold(f.name)",
    )?;
    let all = stmt
        .query_map(params![profile, from, to, PLANNED, nutrient], |r| {
            Ok(Contributor {
                food_id: r.get(0)?,
                name: r.get(1)?,
                amount: r.get(2)?,
                share: 0.0,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let attributed: f64 = all.iter().map(|c| c.amount).sum();
    let foods = all
        .into_iter()
        .take(SOURCES_MAX)
        .map(|c| Contributor {
            share: if total > 0.0 {
                (c.amount / total).min(1.0)
            } else {
                0.0
            },
            ..c
        })
        .collect();
    Ok(NutrientSources {
        nutrient: nutrient.to_owned(),
        total,
        // Float sums in two orders can differ in the last bits.
        unattributed: (total - attributed).max(0.0),
        foods,
    })
}
