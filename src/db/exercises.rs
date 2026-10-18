//! Exercises: the base set and your own, variants and the in-use checks.

use super::prelude::*;
use super::{check_exercises, workout_list};

pub(super) const EXERCISE_COLS: &str = "id, name, measure, source, variant_of, traits, rev";

pub(super) fn exercise_row(r: &Row) -> rusqlite::Result<Exercise> {
    Ok(Exercise {
        id: r.get(0)?,
        name: r.get(1)?,
        measure: r.get(2)?,
        source: r.get(3)?,
        variant_of: r.get(4)?,
        traits: from_json(&r.get::<_, String>(5)?)?,
        rev: r.get(6)?,
    })
}

pub fn exercise_list(conn: &Connection) -> Result<Vec<Exercise>, Error> {
    let mut stmt = conn.prepare_cached(&format!(
        "SELECT {EXERCISE_COLS} FROM exercise ORDER BY name COLLATE NOCASE"
    ))?;
    Ok(stmt
        .query_map([], exercise_row)?
        .collect::<rusqlite::Result<_>>()?)
}

pub fn exercise_get(conn: &Connection, id: i64) -> Result<Option<Exercise>, Error> {
    Ok(conn
        .query_row(
            &format!("SELECT {EXERCISE_COLS} FROM exercise WHERE id = ?"),
            [id],
            exercise_row,
        )
        .optional()?)
}

/// The workouts whose steps use exercise `id`.
pub(super) fn workouts_using(conn: &Connection, id: i64) -> Result<Vec<Workout>, Error> {
    Ok(workout_list(conn)?
        .into_iter()
        .filter(|w| exercise_steps(&w.steps).iter().any(|s| s.exercise_id == id))
        .collect())
}

/// Base-set exercises are reference data, refreshed on every start.
pub(super) fn base_read_only(exercise: &Exercise) -> Result<(), Error> {
    if exercise.source == ExerciseSource::Base {
        return Err(Error::conflict(
            Conflict::BaseReadOnly,
            format!(
                "{} is from the base set and can't change; make an exercise of your own instead",
                exercise.name
            ),
        ));
    }
    Ok(())
}

/// "A, B and 3 more": a few names, for messages.
pub(super) fn some_names(names: &[String]) -> String {
    match names {
        [] => String::new(),
        [one] => one.clone(),
        [first, second] => format!("{first} and {second}"),
        [first, second, rest @ ..] => format!("{first}, {second} and {} more", rest.len()),
    }
}

/// A variant points at a root move: an exercise that exists, isn't itself a
/// variant, and isn't the exercise. An exercise with variants can't become
/// one.
pub(super) fn check_variant_of(
    conn: &Connection,
    id: Option<i64>,
    input: &ExerciseInput,
) -> Result<(), Error> {
    let Some(parent) = input.variant_of else {
        return Ok(());
    };
    let root = exercise_get(conn, parent)?
        .ok_or_else(|| Error::invalid(format!("variant of: unknown exercise {parent}")))?;
    if Some(parent) == id || root.variant_of.is_some() {
        return Err(Error::invalid(format!(
            "variant of: {} is a variant itself; pick its root move",
            root.name
        )));
    }
    if let Some(id) = id {
        let has_variants: bool = conn.query_row(
            "SELECT EXISTS (SELECT 1 FROM exercise WHERE variant_of = ?)",
            [id],
            |r| r.get(0),
        )?;
        if has_variants {
            return Err(Error::invalid(
                "variant of: this exercise has variants of its own",
            ));
        }
    }
    Ok(())
}

/// Create or replace an exercise of yours; names are unique, ignoring case.
/// A change is refused if a workout using the exercise would no longer fit
/// it (renaming always works).
pub fn exercise_save(
    conn: &mut Connection,
    id: Option<i64>,
    input: &ExerciseInput,
) -> Result<Exercise, Error> {
    let tx = write(conn)?;
    if id.is_none()
        && let Some(earlier) = super::foods::created_before(&tx, "exercise", input.uid.as_deref())?
    {
        return Ok(written(exercise_get(&tx, earlier)?));
    }
    let taken: bool = tx.query_row(
        "SELECT EXISTS (SELECT 1 FROM exercise WHERE name = ?1 AND id IS NOT ?2)",
        params![input.name, id],
        |r| r.get(0),
    )?;
    if taken {
        return Err(Error::conflict(
            Conflict::NameTaken,
            format!("an exercise named “{}” already exists", input.name),
        ));
    }
    check_variant_of(&tx, id, input)?;
    let id = if let Some(id) = id {
        let old = exercise_get(&tx, id)?.ok_or_else(|| Error::not_found("exercise", id))?;
        base_read_only(&old)?;
        bump_rev(&tx, "exercise", "exercise", id, input.rev)?;
        tx.execute(
            "UPDATE exercise SET name = ?, measure = ?, variant_of = ?, traits = ? WHERE id = ?",
            params![
                input.name,
                input.measure,
                input.variant_of,
                json(&input.traits),
                id
            ],
        )?;
        // A rename is yours: sets recorded under the old name read the new
        // one (ADR 0006), their activities a revision on.
        if old.name != input.name {
            tx.execute(
                "UPDATE activity SET rev = rev + 1 WHERE id IN (
                     SELECT activity_id FROM activity_set WHERE exercise_id = ?1 AND name = ?2)",
                params![id, old.name],
            )?;
            tx.execute(
                "UPDATE activity_set SET name = ?3 WHERE exercise_id = ?1 AND name = ?2",
                params![id, old.name, input.name],
            )?;
        }
        // Re-check what uses it against the new definition.
        for w in workouts_using(&tx, id)? {
            match check_exercises(&tx, &w.steps) {
                Ok(()) => {}
                Err(Error::Invalid { message: why, .. }) => {
                    return Err(Error::conflict(
                        Conflict::ExerciseInUse,
                        format!("{} is used by {}, where {why}", old.name, w.name),
                    ));
                }
                Err(e) => return Err(e),
            }
        }
        id
    } else {
        tx.execute(
            "INSERT INTO exercise (name, measure, variant_of, traits, uid) VALUES (?, ?, ?, ?, ?)",
            params![
                input.name,
                input.measure,
                input.variant_of,
                json(&input.traits),
                input.uid
            ],
        )?;
        tx.last_insert_rowid()
    };
    let exercise = written(exercise_get(&tx, id)?);
    tx.commit()?;
    Ok(exercise)
}

/// Delete an exercise of yours that no workout uses and no variant points at.
pub fn exercise_delete(conn: &mut Connection, id: i64) -> Result<(), Error> {
    let tx = write(conn)?;
    let exercise = exercise_get(&tx, id)?.ok_or_else(|| Error::not_found("exercise", id))?;
    base_read_only(&exercise)?;
    let workouts: Vec<String> = workouts_using(&tx, id)?
        .into_iter()
        .map(|w| w.name)
        .collect();
    if !workouts.is_empty() {
        return Err(Error::conflict(
            Conflict::ExerciseInUse,
            format!("{} is used by {}", exercise.name, some_names(&workouts)),
        ));
    }
    let variants: Vec<String> = tx
        .prepare_cached("SELECT name FROM exercise WHERE variant_of = ? ORDER BY name")?
        .query_map([id], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    if !variants.is_empty() {
        return Err(Error::conflict(
            Conflict::ExerciseInUse,
            format!("{} has variants: {}", exercise.name, some_names(&variants)),
        ));
    }
    tx.execute("DELETE FROM exercise WHERE id = ?", [id])?;
    tx.commit()?;
    Ok(())
}

/// The base set, as shipped in `exercises.json`; `variant_of` names the root
/// move.
#[derive(serde::Deserialize)]
pub(super) struct BaseExercise {
    pub(super) name: String,
    pub(super) measure: Measure,
    pub(super) variant_of: Option<String>,
    #[serde(flatten)]
    pub(super) traits: ExerciseTraits,
}

pub(super) const BASE_EXERCISES: &str = include_str!("../exercises.json");

/// Bring the base set up to date: refresh what it says about the exercises
/// it has, add those it gained, then link variants to their roots. Writes
/// only what changed. An exercise of yours with a base name stays yours.
/// Base exercises are never removed, renamed or re-measured here: a release
/// that needs that writes a migration (tested: names only grow).
pub(super) fn seed_exercises(conn: &mut Connection) -> Result<(), Error> {
    let base: Vec<BaseExercise> =
        serde_json::from_str(BASE_EXERCISES).expect("exercises.json is valid (tested)");
    let tx = write(conn)?;
    for e in &base {
        let traits = json(&e.traits);
        tx.execute(
            "UPDATE exercise SET traits = ?2
             WHERE name = ?1 AND source = 'base' AND traits IS NOT ?2",
            params![e.name, traits],
        )?;
        tx.execute(
            "INSERT INTO exercise (name, measure, source, traits)
             SELECT ?1, ?2, 'base', ?3
             WHERE NOT EXISTS (SELECT 1 FROM exercise WHERE name = ?1)",
            params![e.name, e.measure, traits],
        )?;
    }
    for e in &base {
        tx.execute(
            "UPDATE exercise
             SET variant_of = (SELECT id FROM exercise WHERE name = ?2 AND source = 'base')
             WHERE name = ?1 AND source = 'base'
               AND variant_of IS NOT (SELECT id FROM exercise WHERE name = ?2 AND source = 'base')",
            params![e.name, e.variant_of],
        )?;
    }
    tx.commit()?;
    Ok(())
}
