//! Workouts: step trees whose exercises must exist and fit their steps.

use super::prelude::*;

pub(super) const WORKOUT_COLS: &str = "id, name, steps, minutes, kcal, rev";

pub(super) fn workout_row(r: &Row) -> rusqlite::Result<Workout> {
    Ok(Workout {
        id: r.get(0)?,
        name: r.get(1)?,
        steps: from_json(&r.get::<_, String>(2)?)?,
        minutes: r.get(3)?,
        kcal: r.get(4)?,
        rev: r.get(5)?,
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
    check_exercises(&tx, &input.steps)?;
    let steps = json(&input.steps);
    let id = if let Some(id) = id {
        bump_rev(&tx, "workout", "workout", id, input.rev)?;
        tx.execute(
            "UPDATE workout SET name = ?, steps = ?, minutes = ?, kcal = ? WHERE id = ?",
            params![input.name, steps, input.minutes, input.kcal, id],
        )?;
        id
    } else {
        tx.execute(
            "INSERT INTO workout (name, steps, minutes, kcal) VALUES (?, ?, ?, ?)",
            params![input.name, steps, input.minutes, input.kcal],
        )?;
        tx.last_insert_rowid()
    };
    let workout = written(workout_get(&tx, id)?);
    tx.commit()?;
    Ok(workout)
}

pub fn workout_delete(conn: &Connection, id: i64) -> Result<(), Error> {
    match conn.execute("DELETE FROM workout WHERE id = ?", [id])? {
        0 => Err(Error::not_found("workout", id)),
        _ => Ok(()),
    }
}
