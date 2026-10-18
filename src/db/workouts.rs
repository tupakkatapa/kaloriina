//! Workouts: step trees whose exercises must exist and fit their steps.

use super::foods::created_before;
use super::prelude::*;
use crate::model::WorkoutUsage;

pub(super) const WORKOUT_COLS: &str = "id, name, steps, minutes, kcal, rev, archived, notes";

pub(super) fn workout_row(r: &Row) -> rusqlite::Result<Workout> {
    Ok(Workout {
        id: r.get(0)?,
        name: r.get(1)?,
        steps: from_json(&r.get::<_, String>(2)?)?,
        minutes: r.get(3)?,
        kcal: r.get(4)?,
        rev: r.get(5)?,
        archived: r.get(6)?,
        notes: r.get(7)?,
    })
}

pub fn workout_list(conn: &Connection) -> Result<Vec<Workout>, Error> {
    let mut stmt = conn.prepare_cached(&format!(
        "SELECT {WORKOUT_COLS} FROM workout ORDER BY name COLLATE NOCASE, id"
    ))?;
    Ok(stmt
        .query_map([], workout_row)?
        .collect::<rusqlite::Result<_>>()?)
}

pub fn workout_get(conn: &Connection, id: i64) -> Result<Option<Workout>, Error> {
    Ok(conn
        .query_row(
            &format!("SELECT {WORKOUT_COLS} FROM workout WHERE id = ?"),
            [id],
            workout_row,
        )
        .optional()?)
}

/// Each exercise step names an exercise that exists and fits it
/// ([`step_fits`]).
pub(super) fn check_exercises(conn: &Connection, steps: &[Step]) -> Result<(), Error> {
    for step in exercise_steps(steps) {
        let here = |msg: String| Error::invalid(format!("step {}: {msg}", step.at));
        let e = exercise_get(conn, step.exercise_id)?
            .ok_or_else(|| here(format!("unknown exercise {}", step.exercise_id)))?;
        step_fits(&e, &step).map_err(here)?;
    }
    Ok(())
}

pub fn workout_save(
    conn: &mut Connection,
    id: Option<i64>,
    input: &WorkoutInput,
) -> Result<Workout, Error> {
    let tx = write(conn)?;
    if id.is_none()
        && let Some(earlier) = created_before(&tx, "workout", input.uid.as_deref())?
    {
        return Ok(written(workout_get(&tx, earlier)?));
    }
    check_exercises(&tx, &input.steps)?;
    let steps = json(&input.steps);
    let id = if let Some(id) = id {
        let old = workout_get(&tx, id)?.ok_or_else(|| Error::not_found("workout", id))?;
        bump_rev(&tx, "workout", "workout", id, input.rev)?;
        tx.execute(
            "UPDATE workout SET name = ?, steps = ?, minutes = ?, kcal = ?, archived = ?,
             notes = ? WHERE id = ?",
            params![
                input.name,
                steps,
                input.minutes,
                input.kcal,
                input.archived,
                input.notes,
                id
            ],
        )?;
        // A rename is yours: sessions done from it under its old name read
        // the new one (ADR 0006), and move on a revision, so an editor that
        // read the old name is stale.
        if old.name != input.name {
            tx.execute(
                "UPDATE activity SET name = ?1, rev = rev + 1
                 WHERE workout_id = ?2 AND name = ?3",
                params![input.name, id, old.name],
            )?;
        }
        id
    } else {
        insert_workout(&tx, input)?
    };
    let workout = written(workout_get(&tx, id)?);
    tx.commit()?;
    Ok(workout)
}

/// A new workout row for `input` (its exercises checked by the caller);
/// the API's create and an import's both make it here.
pub(super) fn insert_workout(conn: &Connection, input: &WorkoutInput) -> Result<i64, Error> {
    conn.execute(
        "INSERT INTO workout (name, steps, minutes, kcal, archived, notes, uid)
         VALUES (?, ?, ?, ?, ?, ?, ?)",
        params![
            input.name,
            json(&input.steps),
            input.minutes,
            input.kcal,
            input.archived,
            input.notes,
            input.uid
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

/// A copy of workout `id`, its steps, estimates and notes, not archived. A
/// `uid` copied before answers with that copy.
///
/// # Errors
/// 404 workout.
pub fn workout_copy(conn: &mut Connection, id: i64, uid: Option<&str>) -> Result<Workout, Error> {
    let tx = write(conn)?;
    if let Some(earlier) = created_before(&tx, "workout", uid)? {
        return Ok(written(workout_get(&tx, earlier)?));
    }
    workout_get(&tx, id)?.ok_or_else(|| Error::not_found("workout", id))?;
    let new = super::foods::copy_row(&tx, "workout", id, uid)?;
    let workout = written(workout_get(&tx, new)?);
    tx.commit()?;
    Ok(workout)
}

/// How many activities and plans name workout `id`, in any profile; 404
/// when there's no such workout.
pub fn workout_usage(conn: &Connection, id: i64) -> Result<WorkoutUsage, Error> {
    workout_get(conn, id)?.ok_or_else(|| Error::not_found("workout", id))?;
    Ok(conn.query_row(
        "SELECT (SELECT count(*) FROM activity WHERE workout_id = ?1),
             (SELECT count(*) FROM planned_workout WHERE workout_id = ?1)",
        [id],
        |r| {
            Ok(WorkoutUsage {
                activities: r.get(0)?,
                plans: r.get(1)?,
            })
        },
    )?)
}

/// Delete a workout no activity or plan of any profile used (they are
/// history: a used one is archived instead).
pub fn workout_delete(conn: &mut Connection, id: i64) -> Result<(), Error> {
    let tx = write(conn)?;
    let usage = workout_usage(&tx, id)?;
    if usage.activities + usage.plans > 0 {
        return Err(Error::conflict(
            Conflict::WorkoutInUse,
            "an activity or plan used this workout: archive it instead",
        ));
    }
    tx.execute("DELETE FROM workout WHERE id = ?", [id])?;
    tx.commit()?;
    Ok(())
}
