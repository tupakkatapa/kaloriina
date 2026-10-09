//! Sessions: workouts done, per profile; watch workouts among them
//! (see `sync_workouts`).

use super::prelude::*;
use super::sync_workouts::{bury, claim_for};
use super::workout_get;
use crate::model::{Plan, PlanInput};

/// `weight_kg`: the weigh-in in effect on the session's day (the latest on
/// or before it, else the earliest after), for its energy estimate.
pub(super) const SESSION_COLS: &str = "id, day, workout_id, name, minutes, kcal, sets, uid, rev, \
     type, distance_m, start_at, source, source_key, \
     coalesce( \
         (SELECT kg FROM weight w WHERE w.profile_id = workout_session.profile_id \
             AND w.day <= workout_session.day ORDER BY w.day DESC LIMIT 1), \
         (SELECT kg FROM weight w WHERE w.profile_id = workout_session.profile_id \
             AND w.day > workout_session.day ORDER BY w.day LIMIT 1))";

pub(super) fn session_row(r: &Row) -> rusqlite::Result<Session> {
    Ok(Session {
        id: r.get(0)?,
        day: r.get(1)?,
        workout_id: r.get(2)?,
        name: r.get(3)?,
        minutes: r.get(4)?,
        kcal: r.get(5)?,
        sets: from_json(&r.get::<_, String>(6)?)?,
        uid: r.get(7)?,
        rev: r.get(8)?,
        kind: r.get(9)?,
        distance_m: r.get(10)?,
        start_at: r.get(11)?,
        source: r.get(12)?,
        source_key: r.get(13)?,
        weight_kg: r.get(14)?,
    })
}

/// A profile's sessions in `[from, to]` (either end open when `None`),
/// oldest first; with `exercise`, only those with a set of it.
pub fn session_list(
    conn: &Connection,
    profile: ProfileId,
    from: Option<&str>,
    to: Option<&str>,
    exercise: Option<i64>,
) -> Result<Vec<Session>, Error> {
    let mut stmt = conn.prepare_cached(&format!(
        "SELECT {SESSION_COLS} FROM workout_session
         WHERE profile_id = ?1 AND (?2 IS NULL OR day >= ?2) AND (?3 IS NULL OR day <= ?3)
         ORDER BY day, id"
    ))?;
    // ponytail: sets are scanned as JSON (4 ms over 1,000 sessions); a set
    // table if records ever show in timings.
    Ok(stmt
        .query_map(params![profile, from, to], session_row)?
        .filter(|s| {
            s.as_ref().map_or(true, |s| {
                exercise.is_none_or(|id| s.sets.iter().any(|set| set.exercise_id == id))
            })
        })
        .collect::<rusqlite::Result<_>>()?)
}

/// A session of `profile`; another profile's reads as missing.
pub fn session_get(
    conn: &Connection,
    profile: ProfileId,
    id: i64,
) -> Result<Option<Session>, Error> {
    Ok(conn
        .query_row(
            &format!("SELECT {SESSION_COLS} FROM workout_session WHERE profile_id = ? AND id = ?"),
            params![profile, id],
            session_row,
        )
        .optional()?)
}

/// The sets as saved: each named after its exercise, which must exist and
/// take the side given, or, for an exercise deleted since, after the name
/// the session already kept.
pub(super) fn named_sets(
    conn: &Connection,
    input: &SessionInput,
    old: Option<&Session>,
) -> Result<Vec<SessionSet>, Error> {
    let mut sets = input.sets.clone();
    for (i, set) in sets.iter_mut().enumerate() {
        let here = |msg: String| Error::invalid(format!("set {}: {msg}", i + 1));
        let kept = || {
            old?.sets
                .iter()
                .find(|s| s.exercise_id == set.exercise_id)
                .map(|s| s.name.clone())
        };
        set.name = match exercise_get(conn, set.exercise_id)? {
            Some(e) => {
                if set.side.is_some() && e.traits.laterality.as_deref() != Some("unilateral") {
                    return Err(here(format!("{} has no sides", e.name)));
                }
                e.name
            }
            None => kept().ok_or_else(|| here(format!("unknown exercise {}", set.exercise_id)))?,
        };
    }
    Ok(sets)
}

/// Create (`id` None) or replace a session. A create naming a `uid` that
/// was saved before answers with that session (a retried request saves
/// once). A linked workout deleted meanwhile is saved as no link. A
/// watch session keeps what the watch measured (409 `watch_read_only` if
/// changed); an unkeyed, timed hand log claims the watch workout it
/// matches.
pub fn session_save(
    conn: &mut Connection,
    profile: ProfileId,
    id: Option<i64>,
    input: &SessionInput,
) -> Result<Session, Error> {
    let tx = write(conn)?;
    if id.is_none()
        && let Some(uid) = &input.uid
    {
        let earlier: Option<i64> = tx
            .query_row(
                "SELECT id FROM workout_session WHERE profile_id = ? AND uid = ?",
                params![profile, uid],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(earlier) = earlier {
            return Ok(written(session_get(&tx, profile, earlier)?));
        }
    }
    let old = id
        .map(|id| session_get(&tx, profile, id)?.ok_or_else(|| Error::not_found("session", id)))
        .transpose()?;
    if let Some(old) = &old
        && old.source == SessionSource::HealthConnect
        && (old.day != input.day
            || old.start_at != input.start_at
            || old.minutes != input.minutes
            || old.kcal != input.kcal
            || old.kind != input.kind
            || old.distance_m != input.distance_m)
    {
        return Err(Error::conflict(
            Conflict::WatchReadOnly,
            "set by the watch: only the name and sets of a synced workout change",
        ));
    }
    let sets = json(&named_sets(&tx, input, old.as_ref())?);
    let workout_id = match input.workout_id {
        Some(w) if workout_get(&tx, w)?.is_some() => Some(w),
        _ => None,
    };
    let id = if let Some(id) = id {
        bump_rev(&tx, "workout_session", "session", id, input.rev)?;
        tx.execute(
            "UPDATE workout_session SET day = ?, workout_id = ?, name = ?, minutes = ?,
                 kcal = ?, sets = ?, type = ?, distance_m = ?, start_at = ?
             WHERE id = ?",
            params![
                input.day,
                workout_id,
                input.name,
                input.minutes,
                input.kcal,
                sets,
                input.kind,
                input.distance_m,
                input.start_at,
                id
            ],
        )?;
        id
    } else {
        tx.execute(
            "INSERT INTO workout_session (profile_id, day, workout_id, name, minutes, kcal, sets,
                 uid, type, distance_m, start_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                profile,
                input.day,
                workout_id,
                input.name,
                input.minutes,
                input.kcal,
                sets,
                input.uid,
                input.kind,
                input.distance_m,
                input.start_at
            ],
        )?;
        let new = tx.last_insert_rowid();
        // Done as planned: the plan (the oldest, if several) goes.
        tx.execute(
            "DELETE FROM planned_workout WHERE id = (
                 SELECT id FROM planned_workout
                 WHERE profile_id = ? AND day = ? AND workout_id = ?
                 ORDER BY id LIMIT 1)",
            params![profile, input.day, workout_id],
        )?;
        new
    };
    let mut session = written(session_get(&tx, profile, id)?);
    if claim_for(&tx, profile, &session)? {
        session = written(session_get(&tx, profile, id)?);
    }
    tx.commit()?;
    Ok(session)
}

/// Delete a session; one holding a watch workout leaves a tombstone, so
/// the next sync doesn't bring it back.
pub fn session_delete(conn: &mut Connection, profile: ProfileId, id: i64) -> Result<(), Error> {
    let tx = write(conn)?;
    let old = session_get(&tx, profile, id)?.ok_or_else(|| Error::not_found("session", id))?;
    tx.execute("DELETE FROM workout_session WHERE id = ?", [id])?;
    if let Some(key) = &old.source_key {
        bury(&tx, profile, key, &old)?;
    }
    tx.commit()?;
    Ok(())
}

const PLAN_COLS: &str = "p.id, p.uid, p.day, p.workout_id, w.name";
const PLAN_FROM: &str = "planned_workout p JOIN workout w ON w.id = p.workout_id";

fn plan_row(r: &Row) -> rusqlite::Result<Plan> {
    Ok(Plan {
        id: r.get(0)?,
        uid: r.get(1)?,
        day: r.get(2)?,
        workout_id: r.get(3)?,
        name: r.get(4)?,
    })
}

/// A profile's plans in `[from, to]` (either end open), by day, oldest first.
pub fn plan_list(
    conn: &Connection,
    profile: ProfileId,
    from: Option<&str>,
    to: Option<&str>,
) -> Result<Vec<Plan>, Error> {
    let mut stmt = conn.prepare_cached(&format!(
        "SELECT {PLAN_COLS} FROM {PLAN_FROM}
         WHERE p.profile_id = ?1 AND (?2 IS NULL OR p.day >= ?2) AND (?3 IS NULL OR p.day <= ?3)
         ORDER BY p.day, p.id"
    ))?;
    Ok(stmt
        .query_map(params![profile, from, to], plan_row)?
        .collect::<rusqlite::Result<_>>()?)
}

fn plan_get(conn: &Connection, id: i64) -> Result<Plan, Error> {
    Ok(conn.query_row(
        &format!("SELECT {PLAN_COLS} FROM {PLAN_FROM} WHERE p.id = ?"),
        [id],
        plan_row,
    )?)
}

/// Plan a workout on a day. A `uid` saved before answers with that plan.
///
/// # Errors
/// An unknown workout (400 `workout_id`).
pub fn plan_insert(
    conn: &mut Connection,
    profile: ProfileId,
    input: &PlanInput,
) -> Result<Plan, Error> {
    let tx = write(conn)?;
    if let Some(uid) = &input.uid {
        let earlier: Option<i64> = tx
            .query_row(
                "SELECT id FROM planned_workout WHERE profile_id = ? AND uid = ?",
                params![profile, uid],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(earlier) = earlier {
            return plan_get(&tx, earlier);
        }
    }
    if workout_get(&tx, input.workout_id)?.is_none() {
        return Err(Error::invalid_field(
            "workout_id",
            format!("unknown workout {}", input.workout_id),
        ));
    }
    tx.execute(
        "INSERT INTO planned_workout (profile_id, day, workout_id, uid) VALUES (?, ?, ?, ?)",
        params![profile, input.day, input.workout_id, input.uid],
    )?;
    let plan = plan_get(&tx, tx.last_insert_rowid())?;
    tx.commit()?;
    Ok(plan)
}

pub fn plan_delete(conn: &Connection, profile: ProfileId, id: i64) -> Result<(), Error> {
    match conn.execute(
        "DELETE FROM planned_workout WHERE profile_id = ? AND id = ?",
        params![profile, id],
    )? {
        0 => Err(Error::not_found("plan", id)),
        _ => Ok(()),
    }
}
