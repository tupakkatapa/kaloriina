//! Habit trackers of your own and their daily totals, and the built-ins'
//! daily amounts read from what was eaten.

use super::prelude::*;
use crate::model::{
    BUILTINS, BuiltinSource, CheckedHabit, HABITS_MAX, Habit, HabitDay, HabitDayRow, PLANNED,
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
            "INSERT INTO habit (profile_id, name, unit, goal_value, goal_dir, archived)
             VALUES (?, ?, ?, ?, ?, ?)",
            params![
                profile,
                input.name,
                input.unit,
                input.goal_value,
                input.goal_dir,
                input.archived
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

/// Every tracker's totals in `[from, to]` (either end open), by day, then
/// tracker.
pub fn habit_days(
    conn: &Connection,
    profile: ProfileId,
    from: Option<&str>,
    to: Option<&str>,
) -> Result<Vec<HabitDay>, Error> {
    let mut stmt = conn.prepare_cached(
        "SELECT d.habit_id, d.day, d.amount FROM habit h JOIN habit_day d ON d.habit_id = h.id
         WHERE h.profile_id = ?1 AND (?2 IS NULL OR d.day >= ?2) AND (?3 IS NULL OR d.day <= ?3)
         ORDER BY d.day, d.habit_id",
    )?;
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

/// Every built-in's amounts in `[from, to]` (either end open), by day, then
/// in [`BUILTINS`] order; stored units. A nutrient built-in has a row
/// (0 when none) on every day with food eaten, so a day without one isn't
/// logged at all; a category built-in only where it was eaten.
pub fn builtin_days(
    conn: &Connection,
    profile: ProfileId,
    from: Option<&str>,
    to: Option<&str>,
) -> Result<Vec<HabitDayRow>, Error> {
    let (from, to) = (from.unwrap_or("0000-01-01"), to.unwrap_or("9999-12-31"));
    let mut eaten: BTreeMap<String, Nutrients> = BTreeMap::new();
    for ((day, group), n) in super::group_sums(super::group_rows(conn, profile, from, to)?)? {
        if group != PLANNED {
            eaten.entry(day).or_default().add(&n);
        }
    }
    let grams = category_grams(conn, profile, from, to)?;
    let mut days: BTreeSet<&str> = eaten.keys().map(String::as_str).collect();
    days.extend(grams.keys().map(|(day, _)| day.as_str()));
    let mut rows = Vec::new();
    for day in days {
        for b in BUILTINS {
            let amount = match b.source {
                BuiltinSource::Nutrient(key) => eaten.get(day).map(|n| n.get(key).unwrap_or(0.0)),
                BuiltinSource::Category(c) => {
                    grams.get(&(day.to_owned(), c.as_str().to_owned())).copied()
                }
            };
            if let Some(amount) = amount {
                rows.push(HabitDayRow {
                    habit: b.key.to_owned(),
                    day: day.to_owned(),
                    amount,
                });
            }
        }
    }
    Ok(rows)
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
                 JOIN food r ON r.id = p.food_id AND r.source = 'recipe' AND r.category IS NULL
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
