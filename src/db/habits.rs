//! Habit trackers of your own and their daily totals, and the built-ins'
//! daily amounts read from what was eaten.

use super::prelude::*;
use super::{Eaten, is_known};
use crate::model::{
    ALCOHOL_ML_PER_G, BUILTINS, BuiltinSource, CheckedHabit, HABITS_MAX, Habit, HabitDay,
    HabitDayRow, PLANNED, dry_of, macro_dry, water_of,
};
use crate::nutrients::Nutrients;

const HABIT_COLS: &str = "id, name, unit, goal_value, goal_dir, archived, rev";

fn habit_row(r: &Row) -> rusqlite::Result<Habit> {
    let goal_value: Option<f64> = r.get(3)?;
    let goal_dir = r.get(4)?;
    Ok(Habit {
        id: r.get(0)?,
        name: r.get(1)?,
        unit: r.get(2)?,
        goal_value,
        goal_dir,
        archived: r.get(5)?,
        rev: r.get(6)?,
    })
}

/// A profile's trackers, archived included, oldest first.
pub fn habit_list(conn: &Connection, profile: ProfileId) -> Result<Vec<Habit>, Error> {
    let mut stmt = conn.prepare_cached(&format!(
        "SELECT {HABIT_COLS} FROM habit WHERE profile_id = ? ORDER BY id"
    ))?;
    Ok(stmt
        .query_map([profile], habit_row)?
        .collect::<rusqlite::Result<_>>()?)
}

/// Profile `profile`'s tracker `id`; another profile's is 404 too.
fn habit_owned(conn: &Connection, profile: ProfileId, id: i64) -> Result<Habit, Error> {
    conn.query_row(
        &format!("SELECT {HABIT_COLS} FROM habit WHERE id = ? AND profile_id = ?"),
        params![id, profile],
        habit_row,
    )
    .optional()?
    .ok_or_else(|| Error::not_found("habit", id))
}

/// Create (`id = None`) or replace a tracker. Names are unique per profile,
/// ignoring case; a profile has at most [`HABITS_MAX`].
pub fn habit_save(
    conn: &mut Connection,
    profile: ProfileId,
    id: Option<i64>,
    input: &CheckedHabit,
) -> Result<Habit, Error> {
    let tx = write(conn)?;
    if let Some(id) = id {
        habit_owned(&tx, profile, id)?;
    } else if let Some(uid) = &input.uid {
        let earlier: Option<i64> = tx
            .query_row(
                "SELECT id FROM habit WHERE profile_id = ? AND uid = ?",
                params![profile, uid],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(earlier) = earlier {
            return habit_owned(&tx, profile, earlier);
        }
    }
    let taken: bool = tx.query_row(
        "SELECT EXISTS (SELECT 1 FROM habit
             WHERE profile_id = ?1 AND name = ?2 COLLATE NOCASE AND id IS NOT ?3)",
        params![profile, input.name, id],
        |r| r.get(0),
    )?;
    if taken {
        return Err(Error::conflict(
            Conflict::NameTaken,
            format!("a habit named “{}” already exists", input.name),
        ));
    }
    let id = if let Some(id) = id {
        bump_rev(&tx, "habit", "habit", id, input.rev)?;
        tx.execute(
            "UPDATE habit SET name = ?, unit = ?, goal_value = ?, goal_dir = ?, archived = ?
             WHERE id = ?",
            params![
                input.name,
                input.unit,
                input.goal_value,
                input.goal_dir,
                input.archived,
                id
            ],
        )?;
        id
    } else {
        let full: bool = tx.query_row(
            "SELECT count(*) >= ?2 FROM habit WHERE profile_id = ?1",
            params![profile, HABITS_MAX],
            |r| r.get(0),
        )?;
        if full {
            return Err(Error::invalid(format!(
                "a profile has at most {HABITS_MAX} habits; delete one first"
            )));
        }
        tx.execute(
            "INSERT INTO habit (profile_id, name, unit, goal_value, goal_dir, archived, uid)
             VALUES (?, ?, ?, ?, ?, ?, ?)",
            params![
                profile,
                input.name,
                input.unit,
                input.goal_value,
                input.goal_dir,
                input.archived,
                input.uid
            ],
        )?;
        tx.last_insert_rowid()
    };
    let habit = habit_owned(&tx, profile, id)?;
    tx.commit()?;
    Ok(habit)
}

/// Delete a tracker with its days.
pub fn habit_delete(conn: &Connection, profile: ProfileId, id: i64) -> Result<(), Error> {
    match conn.execute(
        "DELETE FROM habit WHERE id = ? AND profile_id = ?",
        params![id, profile],
    )? {
        0 => Err(Error::not_found("habit", id)),
        _ => Ok(()),
    }
}

/// Set tracker `id`'s total on `day`, replacing the one it had. Writing the
/// same twice is the same as once.
pub fn habit_day_set(
    conn: &Connection,
    profile: ProfileId,
    id: i64,
    day: &str,
    amount: f64,
) -> Result<HabitDay, Error> {
    habit_owned(conn, profile, id)?;
    conn.execute(
        "INSERT INTO habit_day (habit_id, day, amount) VALUES (?1, ?2, ?3)
         ON CONFLICT (habit_id, day) DO UPDATE SET amount = ?3",
        params![id, day, amount],
    )?;
    Ok(HabitDay {
        habit_id: id,
        day: day.to_owned(),
        amount,
    })
}

pub fn habit_day_delete(
    conn: &Connection,
    profile: ProfileId,
    id: i64,
    day: &str,
) -> Result<(), Error> {
    habit_owned(conn, profile, id)?;
    match conn.execute(
        "DELETE FROM habit_day WHERE habit_id = ? AND day = ?",
        params![id, day],
    )? {
        0 => Err(Error::not_found("habit_day", format!("{id} {day}"))),
        _ => Ok(()),
    }
}

/// A profile's tracker totals in `[?2, ?3]` ([`IN_RANGE`]: `profile_id`
/// is the habit's, `day` the total's).
fn habit_days_sql() -> String {
    format!(
        "SELECT d.habit_id, d.day, d.amount FROM habit h JOIN habit_day d ON d.habit_id = h.id
         WHERE {IN_RANGE} ORDER BY d.day, d.habit_id"
    )
}

/// Every tracker's totals in `[from, to]` (either end open), by day, then
/// tracker.
pub fn habit_days(
    conn: &Connection,
    profile: ProfileId,
    from: Option<&str>,
    to: Option<&str>,
) -> Result<Vec<HabitDay>, Error> {
    let mut stmt = conn.prepare_cached(&habit_days_sql())?;
    Ok(stmt
        .query_map(params![profile, from, to], |r| {
            Ok(HabitDay {
                habit_id: r.get(0)?,
                day: r.get(1)?,
                amount: r.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?)
}

/// What the built-ins' amounts are read from, taken under the lock and
/// computed after it ([`builtin_days_of`]): the stored totals as text
/// (with what hydration and coverage read of them), the grams by
/// category, and the days with a food eaten that has none.
pub struct BuiltinInputs {
    eaten: Vec<super::EatenRow>,
    grams: BTreeMap<(String, String), f64>,
    uncategorised: BTreeSet<String>,
}

impl BuiltinInputs {
    /// Inputs of `eaten` rows alone, read before: enough for the nutrient
    /// and hydration built-ins, not the category ones (no grams read).
    #[must_use]
    pub fn of_eaten(eaten: Vec<super::EatenRow>) -> Self {
        Self {
            eaten,
            grams: BTreeMap::new(),
            uncategorised: BTreeSet::new(),
        }
    }
}

/// [`builtin_days_of`]'s inputs in `[from, to]` (either end open).
///
/// # Errors
/// A read fails.
pub fn builtin_inputs(
    conn: &Connection,
    profile: ProfileId,
    from: Option<&str>,
    to: Option<&str>,
) -> Result<BuiltinInputs, Error> {
    let (from, to) = (from.unwrap_or("0000-01-01"), to.unwrap_or("9999-12-31"));
    Ok(BuiltinInputs {
        eaten: super::eaten_rows(conn, profile, from, to)?,
        grams: category_grams(conn, profile, from, to)?,
        uncategorised: uncategorised_days(conn, profile, from, to)?,
    })
}

/// Every built-in's amounts in `[from, to]` (either end open), by day, then
/// in [`BUILTINS`] order; stored units. Each built-in has a row (0 when
/// none) on every day with food eaten, so a day without one isn't logged
/// at all. A nutrient built-in's amount is `known` once foods carrying its
/// nutrient were [`crate::nutrients::KNOWN`] of the day's food (ADR 0030:
/// by dry matter; caffeine, alcohol and creatine by what could hold them);
/// hydration's, once foods whose water is known were; a category's, once
/// every food eaten has a category (yours set, or an importer's).
pub fn builtin_days(
    conn: &Connection,
    profile: ProfileId,
    from: Option<&str>,
    to: Option<&str>,
) -> Result<Vec<HabitDayRow>, Error> {
    builtin_days_of(builtin_inputs(conn, profile, from, to)?)
}

/// A day's hydration being added up (ADR 0020): ml, and the dry matter of
/// its food in all and of the food whose water is known.
#[derive(Default)]
struct Drunk {
    ml: f64,
    dry: f64,
    dry_known: f64,
}

impl Drunk {
    /// Add `water` ml (`None`: not known) with `alcohol` g, of food of
    /// `dry` g dry matter: the water less alcohol's debit, never below 0.
    /// `vouched`: whether a water given is the food's (an export's sum
    /// isn't: it counts, as a floor).
    fn add(&mut self, water: Option<f64>, alcohol: f64, dry: f64, vouched: bool) {
        let w = water.unwrap_or(0.0);
        self.ml += w - (alcohol * ALCOHOL_ML_PER_G).min(w);
        self.dry += dry;
        if water.is_some() && vouched {
            self.dry_known += dry;
        }
    }

    fn known(&self) -> bool {
        self.dry <= 0.0 || self.dry_known >= crate::nutrients::KNOWN * self.dry
    }
}

/// [`builtin_days`] from inputs read before (no connection: a range of
/// years is parsed off the lock).
///
/// # Errors
/// A stored total isn't valid JSON.
pub fn builtin_days_of(inputs: BuiltinInputs) -> Result<Vec<HabitDayRow>, Error> {
    let BuiltinInputs {
        eaten: rows,
        grams,
        uncategorised,
    } = inputs;
    let mut eaten = Eaten::default();
    let mut hydration: BTreeMap<String, Drunk> = BTreeMap::new();
    for row in &rows {
        if row.group == PLANNED {
            continue;
        }
        let n: Nutrients = from_json(&row.text)?;
        let alcohol = n.get("alcohol").unwrap_or(0.0);
        let day = hydration.entry(row.day.clone()).or_default();
        match &row.basis {
            super::RowBasis::Food { drink, .. } => day.add(
                water_of(&n, row.grams, *drink),
                alcohol,
                dry_of(&n, row.grams, *drink),
                true,
            ),
            super::RowBasis::Recipe(cover) => {
                let h = cover.hydrates;
                day.add(
                    Some(h.water * row.grams),
                    h.alcohol * row.grams,
                    h.dry * row.grams,
                    true,
                );
                // The parts whose water isn't known.
                day.dry_known -= (h.dry - h.dry_known) * row.grams;
            }
            // An export's water counts, but can't be vouched for.
            super::RowBasis::Imported => day.add(n.get("water"), alcohol, macro_dry(&n), false),
        }
        eaten.add(&row.day, &n, row.grams, &row.basis);
    }
    let imported: BTreeSet<&str> = rows
        .iter()
        .filter(|r| matches!(r.basis, super::RowBasis::Imported))
        .map(|r| r.day.as_str())
        .collect();
    let eaten = eaten.days();
    let mut out = Vec::new();
    for (day, d) in &eaten {
        for b in BUILTINS {
            let (amount, known) = match b.source {
                BuiltinSource::Nutrient(key) => (d.0.get(key).unwrap_or(0.0), is_known(d, key)),
                BuiltinSource::Category(c) => (
                    grams
                        .get(&(day.clone(), c.as_str().to_owned()))
                        .copied()
                        .unwrap_or(0.0),
                    !uncategorised.contains(day) && !imported.contains(day.as_str()),
                ),
                BuiltinSource::Hydration => hydration
                    .get(day)
                    .map_or((0.0, true), |h| (h.ml, h.known())),
            };
            out.push(HabitDayRow {
                habit: b.key.to_owned(),
                day: day.clone(),
                amount,
                known,
            });
        }
    }
    Ok(out)
}

/// A recipe's hydration a gram (ADR 0020), through its parts (recipes in
/// recipes too): the water counted (ml), its alcohol (g), and its dry
/// matter in all and of the parts whose water is known. The weight cooking
/// takes or gives is water: off or onto the water of the parts,
/// never below none.
#[derive(Debug, Clone, Copy, Default)]
pub struct Hydrates {
    pub water: f64,
    pub alcohol: f64,
    pub dry: f64,
    pub dry_known: f64,
}

impl Hydrates {
    /// Whether its water is known: [`crate::nutrients::KNOWN`] of its dry
    /// matter is of parts whose water is.
    #[must_use]
    pub fn known(&self) -> bool {
        self.dry <= 0.0 || self.dry_known >= crate::nutrients::KNOWN * self.dry
    }
}

/// A recipe's [`Hydrates`] (`memo` keeps each once).
///
/// # Errors
/// A read fails, or stored values aren't valid JSON.
pub(super) fn recipe_hydration(
    conn: &Connection,
    id: i64,
    memo: &mut BTreeMap<i64, Hydrates>,
) -> Result<Hydrates, Error> {
    if let Some(&h) = memo.get(&id) {
        return Ok(h);
    }
    let items: Vec<(i64, bool, f64, bool, String)> = conn
        .prepare_cached(
            "SELECT i.food_id, f.kind = 'recipe', i.grams, f.drink, f.per100
             FROM recipe_item i JOIN food f ON f.id = i.food_id WHERE i.recipe_id = ?",
        )?
        .query_map([id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
        })?
        .collect::<rusqlite::Result<_>>()?;
    let cooked: Option<f64> =
        conn.query_row("SELECT cooked_g FROM food WHERE id = ?", [id], |r| r.get(0))?;
    let mut sum = Hydrates::default();
    let mut total = 0.0;
    for (food, recipe, grams, drink, per100) in items {
        total += grams;
        if recipe {
            let h = recipe_hydration(conn, food, memo)?;
            sum.water += h.water * grams;
            sum.alcohol += h.alcohol * grams;
            sum.dry += h.dry * grams;
            sum.dry_known += h.dry_known * grams;
            continue;
        }
        let n: Nutrients = from_json(&per100)?;
        let n = n.scale(grams / 100.0);
        sum.alcohol += n.get("alcohol").unwrap_or(0.0);
        let dry = dry_of(&n, grams, drink);
        sum.dry += dry;
        if let Some(water) = water_of(&n, grams, drink) {
            sum.water += water;
            sum.dry_known += dry;
        }
    }
    let weight = cooked.unwrap_or(total);
    let out = if weight > 0.0 {
        let water = if sum.water > 0.0 {
            (sum.water + weight - total).max(0.0)
        } else {
            0.0
        };
        Hydrates {
            water: water / weight,
            alcohol: sum.alcohol / weight,
            dry: sum.dry / weight,
            dry_known: sum.dry_known / weight,
        }
    } else {
        Hydrates::default()
    };
    memo.insert(id, out);
    Ok(out)
}

/// The days in `[from, to]` with a food eaten that has no category: a
/// food of your own without one (Fineli's and Open Food Facts' have their
/// importer's word), down through recipes without one of their own; and
/// any imported total. A category's grams are a floor on them.
fn uncategorised_days(
    conn: &Connection,
    profile: ProfileId,
    from: &str,
    to: &str,
) -> Result<BTreeSet<String>, Error> {
    let mut stmt = conn.prepare_cached(
        "WITH RECURSIVE
             part (day, food_id) AS (
                 SELECT day, food_id FROM entry
                 WHERE profile_id = ?1 AND day BETWEEN ?2 AND ?3 AND grp != ?4
                     AND food_id IS NOT NULL AND grams > 0
                 UNION
                 SELECT p.day, i.food_id
                 FROM part p
                 JOIN food r ON r.id = p.food_id AND r.kind = 'recipe' AND r.category IS NULL
                 JOIN recipe_item i ON i.recipe_id = r.id)
         SELECT DISTINCT p.day FROM part p JOIN food f ON f.id = p.food_id
         WHERE f.kind = 'food' AND f.category IS NULL AND f.source = 'custom'",
    )?;
    Ok(stmt
        .query_map(params![profile, from, to, PLANNED], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?)
}

/// Grams eaten per (day, category) in `[from, to]`. A recipe of its own
/// category counts whole; one without counts each ingredient's share,
/// `entry g × item g / (cooked g, else the items' total)`, down through
/// recipes in recipes.
fn category_grams(
    conn: &Connection,
    profile: ProfileId,
    from: &str,
    to: &str,
) -> Result<BTreeMap<(String, String), f64>, Error> {
    let mut stmt = conn.prepare_cached(
        "WITH RECURSIVE
             total (recipe_id, grams) AS (
                 SELECT recipe_id, sum(grams) FROM recipe_item GROUP BY recipe_id),
             part (day, food_id, grams) AS (
                 SELECT day, food_id, grams FROM entry
                 WHERE profile_id = ?1 AND day BETWEEN ?2 AND ?3 AND grp != ?4
                     AND food_id IS NOT NULL AND grams > 0
                 UNION ALL
                 SELECT p.day, i.food_id, p.grams * i.grams / coalesce(r.cooked_g, t.grams)
                 FROM part p
                 JOIN food r ON r.id = p.food_id AND r.kind = 'recipe' AND r.category IS NULL
                 JOIN total t ON t.recipe_id = r.id
                 JOIN recipe_item i ON i.recipe_id = r.id)
         SELECT p.day, f.category, sum(p.grams)
         FROM part p JOIN food f ON f.id = p.food_id
         WHERE f.category IS NOT NULL
         GROUP BY p.day, f.category",
    )?;
    Ok(stmt
        .query_map(params![profile, from, to, PLANNED], |r| {
            Ok(((r.get(0)?, r.get(1)?), r.get(2)?))
        })?
        .collect::<rusqlite::Result<_>>()?)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A range of days reads through the index's day bounds, open ends
    /// included (`?2 IS NULL OR d.day >= ?2` reads every day).
    #[test]
    fn habit_days_read_by_the_day_range() {
        let conn = super::super::open(std::path::Path::new(":memory:")).unwrap();
        let plan: Vec<String> = conn
            .prepare(&format!("EXPLAIN QUERY PLAN {}", habit_days_sql()))
            .unwrap()
            .query_map(params![1, "2026-10-01", Option::<&str>::None], |r| r.get(3))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert!(
            plan.iter().any(|p| p.contains("day>? AND day<?")),
            "{plan:#?}"
        );
    }
}
