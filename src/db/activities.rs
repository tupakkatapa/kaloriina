//! Activities done (a workout, a run, a walk…), per profile, with their
//! sets; the device's among them (see `sync_workouts`). History, bests and
//! last done are queries over `activity_set`.

use super::prelude::*;
use super::sync_workouts::{bury, claim_for};
use super::{workout_get, workout_list};
use crate::model::{
    BestSet, Bests, ExerciseHistory, ExerciseRecord, HistoryDay, KcalSource, Plan, PlanInput,
    Records, TypeBests, WorkoutDone,
};

/// `sets`: its `activity_set` rows, in order, as the JSON the API nests.
/// `weight_kg`: the weigh-in in effect on the activity's day (the latest on
/// or before it, else the earliest after), for its energy estimate;
/// `bmr_kcal` the resting energy in effect then (`resting_on`), to net a
/// total of.
pub(super) const ACTIVITY_COLS: &str = concat!(
    "id, day, workout_id, name, minutes, kcal, \
     (SELECT json_group_array(json_object('exercise_id', s.exercise_id, 'name', s.name, \
         'reps', s.reps, 'seconds', s.seconds, 'kg', s.kg, 'side', s.side) ORDER BY s.idx) \
      FROM activity_set s WHERE s.activity_id = activity.id), uid, rev, \
     type, distance_m, start_at, source, source_key, kcal_source, avg_hr, max_hr, \
     coalesce( \
         (SELECT kg FROM weight w WHERE w.profile_id = activity.profile_id \
             AND w.day <= activity.day ORDER BY w.day DESC LIMIT 1), \
         (SELECT kg FROM weight w WHERE w.profile_id = activity.profile_id \
             AND w.day > activity.day ORDER BY w.day LIMIT 1)), ",
    resting_on!("bmr_kcal", "activity.profile_id", "activity.day")
);

pub(super) fn activity_row(r: &Row) -> rusqlite::Result<Activity> {
    Ok(Activity {
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
        kcal_source: r.get(14)?,
        avg_hr: r.get(15)?,
        max_hr: r.get(16)?,
        weight_kg: r.get(17)?,
        bmr_kcal: r.get(18)?,
    })
}

/// A profile's activities in `[from, to]` (either end open when `None`),
/// oldest first; with `exercise`, only those with a set of it.
pub fn activity_list(
    conn: &Connection,
    profile: ProfileId,
    from: Option<&str>,
    to: Option<&str>,
    exercise: Option<i64>,
) -> Result<Vec<Activity>, Error> {
    activity_find(
        conn,
        profile,
        (from, to),
        &ActivityFilter {
            exercise,
            ..ActivityFilter::default()
        },
    )
}

/// Which of a range's activities to list: those with a set of `exercise`,
/// those of `workout` (done from it), the latest `limit`.
#[derive(Debug, Clone, Copy, Default)]
pub struct ActivityFilter {
    pub exercise: Option<i64>,
    pub workout: Option<i64>,
    pub limit: Option<u32>,
}

/// A profile's activities in `[from, to]` (either end open) that `filter`
/// keeps, oldest first (with a `limit`, the latest that many).
pub fn activity_find(
    conn: &Connection,
    profile: ProfileId,
    (from, to): (Option<&str>, Option<&str>),
    filter: &ActivityFilter,
) -> Result<Vec<Activity>, Error> {
    let mut stmt = conn.prepare_cached(&format!(
        "SELECT * FROM (SELECT {ACTIVITY_COLS} FROM activity
             WHERE {IN_RANGE}
               AND (?4 IS NULL OR id IN (SELECT activity_id FROM activity_set
                                         WHERE exercise_id = ?4))
               AND (?5 IS NULL OR workout_id = ?5)
             ORDER BY day DESC, id DESC LIMIT coalesce(?6, -1))
         ORDER BY day, id"
    ))?;
    Ok(stmt
        .query_map(
            params![
                profile,
                from,
                to,
                filter.exercise,
                filter.workout,
                filter.limit
            ],
            activity_row,
        )?
        .collect::<rusqlite::Result<_>>()?)
}

/// An activity of `profile`; another profile's reads as missing.
pub fn activity_get(
    conn: &Connection,
    profile: ProfileId,
    id: i64,
) -> Result<Option<Activity>, Error> {
    Ok(conn
        .query_row(
            &format!("SELECT {ACTIVITY_COLS} FROM activity WHERE profile_id = ? AND id = ?"),
            params![profile, id],
            activity_row,
        )
        .optional()?)
}

/// The sets as saved: each named after its exercise, which must exist and
/// take the side given. A set of no exercise (deleted since) keeps its
/// name only when `kept` already has it so: an edit can't make one up.
pub(super) fn named_sets(
    conn: &Connection,
    input: &ActivityInput,
    kept: &[ActivitySet],
) -> Result<Vec<ActivitySet>, Error> {
    let mut sets = input.sets.clone();
    for (i, set) in sets.iter_mut().enumerate() {
        let here = |msg: String| Error::invalid(format!("set {}: {msg}", i + 1));
        let exercise = match set.exercise_id {
            Some(id) => exercise_get(conn, id)?,
            None => None,
        };
        let Some(e) = exercise else {
            // Deleted since (perhaps after an editor read it): as kept.
            if !kept
                .iter()
                .any(|k| k.exercise_id.is_none() && k.name == set.name)
            {
                return Err(here(match set.exercise_id {
                    Some(id) => format!("unknown exercise {id}"),
                    None => "give an exercise_id".to_owned(),
                }));
            }
            set.exercise_id = None;
            continue;
        };
        if set.side.is_some() && e.traits.laterality.as_deref() != Some("unilateral") {
            return Err(here(format!("{} has no sides", e.name)));
        }
        set.name = e.name;
    }
    Ok(sets)
}

/// Replace activity `id`'s sets with `sets`, in order.
pub(super) fn sets_put(tx: &Connection, id: i64, sets: &[ActivitySet]) -> Result<(), Error> {
    tx.execute("DELETE FROM activity_set WHERE activity_id = ?", [id])?;
    let mut insert = tx.prepare_cached(
        "INSERT INTO activity_set (activity_id, idx, exercise_id, name, reps, seconds, kg, side)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )?;
    for (idx, s) in (0_i64..).zip(sets) {
        insert.execute(params![
            id,
            idx,
            s.exercise_id,
            s.name,
            s.reps,
            s.seconds,
            s.kg,
            s.side
        ])?;
    }
    Ok(())
}

/// Create (`id` None) or replace an activity. A create naming a `uid`
/// that was saved before answers with that activity (a retried request saves
/// once). A linked workout deleted meanwhile is saved as no link. A
/// device session keeps what the device measured (409 `device_read_only` if
/// changed); an unkeyed, timed hand log claims the device workout it
/// matches.
pub fn activity_save(
    conn: &mut Connection,
    profile: ProfileId,
    id: Option<i64>,
    input: &ActivityInput,
) -> Result<Activity, Error> {
    let tx = write(conn)?;
    if id.is_none()
        && let Some(uid) = &input.uid
    {
        let earlier: Option<i64> = tx
            .query_row(
                "SELECT id FROM activity WHERE profile_id = ? AND uid = ?",
                params![profile, uid],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(earlier) = earlier {
            return Ok(written(activity_get(&tx, profile, earlier)?));
        }
    }
    let old = id
        .map(|id| activity_get(&tx, profile, id)?.ok_or_else(|| Error::not_found("activity", id)))
        .transpose()?;
    if let Some(old) = &old
        && old.source == ActivitySource::HealthConnect
        && (old.day != input.day
            || old.start_at != input.start_at
            || old.minutes != input.minutes
            || old.kcal != input.kcal
            || old.kind != input.kind
            || old.distance_m != input.distance_m)
    {
        return Err(Error::conflict(
            Conflict::DeviceReadOnly,
            "set by the device: only the name and sets of a synced workout change",
        ));
    }
    let sets = named_sets(&tx, input, old.as_ref().map_or(&[], |o| &o.sets))?;
    // Energy typed (or changed) here is the hand's; kept, it keeps its source.
    let kcal_source = match (&old, input.kcal) {
        (_, None) => None,
        (Some(o), k) if o.kcal == k => o.kcal_source,
        _ => Some(KcalSource::Hand),
    };
    let workout_id = match input.workout_id {
        Some(w) if workout_get(&tx, w)?.is_some() => Some(w),
        _ => None,
    };
    let id = if let Some(id) = id {
        bump_rev(&tx, "activity", "activity", id, input.rev)?;
        tx.execute(
            "UPDATE activity SET day = ?, workout_id = ?, name = ?, minutes = ?,
                 kcal = ?, type = ?, distance_m = ?, start_at = ?, kcal_source = ?
             WHERE id = ?",
            params![
                input.day,
                workout_id,
                input.name,
                input.minutes,
                input.kcal,
                input.kind,
                input.distance_m,
                input.start_at,
                kcal_source,
                id
            ],
        )?;
        id
    } else {
        tx.execute(
            "INSERT INTO activity (profile_id, day, workout_id, name, minutes, kcal,
                 uid, type, distance_m, start_at, kcal_source)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                profile,
                input.day,
                workout_id,
                input.name,
                input.minutes,
                input.kcal,
                input.uid,
                input.kind,
                input.distance_m,
                input.start_at,
                kcal_source
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
    sets_put(&tx, id, &sets)?;
    let mut session = written(activity_get(&tx, profile, id)?);
    if claim_for(&tx, profile, &session)? {
        session = written(activity_get(&tx, profile, id)?);
    }
    tx.commit()?;
    Ok(session)
}

/// Delete an activity; one holding a device workout leaves a tombstone, so
/// the next sync doesn't bring it back.
pub fn activity_delete(conn: &mut Connection, profile: ProfileId, id: i64) -> Result<(), Error> {
    let tx = write(conn)?;
    let old = activity_get(&tx, profile, id)?.ok_or_else(|| Error::not_found("activity", id))?;
    tx.execute("DELETE FROM activity WHERE id = ?", [id])?;
    if let Some(key) = &old.source_key {
        bury(&tx, profile, key, &old)?;
    }
    tx.commit()?;
    Ok(())
}

/// The workouts, each with the day `profile` last did it.
pub fn workouts_done(conn: &Connection, profile: ProfileId) -> Result<Vec<WorkoutDone>, Error> {
    let last: BTreeMap<i64, String> = conn
        .prepare_cached(
            "SELECT workout_id, max(day) FROM activity
             WHERE profile_id = ? AND workout_id IS NOT NULL GROUP BY workout_id",
        )?
        .query_map([profile], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    Ok(workout_list(conn)?
        .into_iter()
        .map(|w| WorkoutDone {
            last_done: last.get(&w.id).cloned(),
            workout: w,
        })
        .collect())
}

/// A set read from `activity_set` columns `exercise_id, name, reps,
/// seconds, kg, side` starting at `at`.
fn set_at(r: &Row, at: usize) -> rusqlite::Result<ActivitySet> {
    Ok(ActivitySet {
        exercise_id: r.get(at)?,
        name: r.get(at + 1)?,
        reps: r.get(at + 2)?,
        seconds: r.get(at + 3)?,
        kg: r.get(at + 4)?,
        side: r.get(at + 5)?,
    })
}

/// `profile`'s bests at each exercise it did (or only `exercise`), by
/// exercise id: per measure, the set ranked first by it, then by the
/// latest day, activity and place.
fn bests(
    conn: &Connection,
    profile: ProfileId,
    exercise: Option<i64>,
) -> Result<BTreeMap<i64, Bests>, Error> {
    let rank = |col: &str| {
        format!(
            "row_number() OVER (PARTITION BY s.exercise_id
                 ORDER BY s.{col} DESC, a.day DESC, a.id DESC, s.idx DESC) AS by_{col}"
        )
    };
    let pick = |col: &str| {
        format!(
            "SELECT '{col}', exercise_id, name, reps, seconds, kg, side, day, activity_id
             FROM ranked WHERE by_{col} = 1 AND {col} > 0"
        )
    };
    let sql = format!(
        "WITH ranked AS (
             SELECT s.exercise_id, s.name, s.reps, s.seconds, s.kg, s.side, a.day,
                    s.activity_id, {}, {}, {}
             FROM activity_set s JOIN activity a ON a.id = s.activity_id
             WHERE a.profile_id = ?1 AND s.exercise_id IS NOT NULL
               AND (?2 IS NULL OR s.exercise_id = ?2))
         {} UNION ALL {} UNION ALL {}",
        rank("reps"),
        rank("seconds"),
        rank("kg"),
        pick("reps"),
        pick("seconds"),
        pick("kg")
    );
    let mut out: BTreeMap<i64, Bests> = BTreeMap::new();
    let mut stmt = conn.prepare_cached(&sql)?;
    let mut rows = stmt.query(params![profile, exercise])?;
    while let Some(r) = rows.next()? {
        let key: String = r.get(0)?;
        let best = Some(BestSet {
            set: set_at(r, 1)?,
            day: r.get(7)?,
            activity_id: r.get(8)?,
        });
        let at = out.entry(r.get(1)?).or_default();
        match key.as_str() {
            "reps" => at.reps = best,
            "seconds" => at.seconds = best,
            _ => at.kg = best,
        }
    }
    Ok(out)
}

/// Exercise `id` as `profile` did it: its bests, and its sets by activity,
/// newest first. 404 for an exercise that doesn't exist.
pub fn exercise_history(
    conn: &Connection,
    profile: ProfileId,
    id: i64,
) -> Result<ExerciseHistory, Error> {
    exercise_get(conn, id)?.ok_or_else(|| Error::not_found("exercise", id))?;
    let mut days: Vec<HistoryDay> = Vec::new();
    let mut stmt = conn.prepare_cached(
        "SELECT a.id, a.day, s.exercise_id, s.name, s.reps, s.seconds, s.kg, s.side
         FROM activity_set s JOIN activity a ON a.id = s.activity_id
         WHERE a.profile_id = ? AND s.exercise_id = ?
         ORDER BY a.day DESC, a.id DESC, s.idx",
    )?;
    let mut rows = stmt.query(params![profile, id])?;
    while let Some(r) = rows.next()? {
        let activity_id: i64 = r.get(0)?;
        let set = set_at(r, 2)?;
        match days.last_mut() {
            Some(d) if d.activity_id == activity_id => d.sets.push(set),
            _ => days.push(HistoryDay {
                day: r.get(1)?,
                activity_id,
                sets: vec![set],
            }),
        }
    }
    Ok(ExerciseHistory {
        bests: bests(conn, profile, Some(id))?
            .remove(&id)
            .unwrap_or_default(),
        days,
    })
}

/// Whether an `activity` row's distance is one (SQL): at least 50 m (less
/// is a device's leftover), and on an "other" only when typed by hand (a
/// class's distance is the phone's step metres, no route). As
/// `web/activities.mjs` `distanceOf`.
pub(super) const REAL_DISTANCE: &str =
    "(distance_m >= 50 AND (type != 'other' OR source = 'hand'))";

/// [`ActivityType::min_kmh`] as SQL over `type`.
fn min_kmh_sql() -> String {
    use std::fmt::Write as _;
    let mut sql = String::from("CASE type");
    for t in ActivityType::ALL.iter().filter(|t| t.min_kmh() > 0.0) {
        // Writing to a String can't fail.
        let _ = write!(sql, " WHEN '{}' THEN {}", t.as_str(), t.min_kmh());
    }
    sql.push_str(" ELSE 0 END");
    sql
}

/// `profile`'s records: each exercise's bests, by name; each activity
/// type's longest distance ([`REAL_DISTANCE`]) and time and fastest pace
/// (1 km or more, at a speed its type moves: [`ActivityType::min_kmh`]),
/// the later day (then the later logged) winning a tie.
pub fn records(conn: &Connection, profile: ProfileId) -> Result<Records, Error> {
    let names: BTreeMap<i64, String> = conn
        .prepare_cached("SELECT id, name FROM exercise")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let mut exercises: Vec<ExerciseRecord> = bests(conn, profile, None)?
        .into_iter()
        .map(|(id, bests)| ExerciseRecord {
            exercise_id: id,
            name: names.get(&id).cloned().unwrap_or_default(),
            bests,
        })
        .collect();
    exercises.sort_by_cached_key(|e| e.name.to_lowercase());
    let best = |key: &str, filter: &str, order: &str| {
        format!(
            "SELECT '{key}', type, id FROM (
                 SELECT type, id, row_number() OVER (
                     PARTITION BY type ORDER BY {order}, day DESC, id DESC) AS r
                 FROM activity WHERE profile_id = ?1 AND {filter})
             WHERE r = 1"
        )
    };
    let sql = [
        best("distance", REAL_DISTANCE, "distance_m DESC"),
        best("minutes", "minutes > 0", "minutes DESC"),
        best(
            "pace",
            &format!(
                "{REAL_DISTANCE} AND distance_m >= 1000 AND minutes > 0
                 AND distance_m * 0.06 / minutes >= {}",
                min_kmh_sql()
            ),
            "CAST(minutes AS REAL) / distance_m",
        ),
    ]
    .join(" UNION ALL ");
    let held: Vec<(String, ActivityType, i64)> = conn
        .prepare_cached(&sql)?
        .query_map([profile], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let mut types: BTreeMap<&'static str, TypeBests> = BTreeMap::new();
    for (key, kind, id) in held {
        let a = activity_get(conn, profile, id)?;
        let at = types.entry(kind.as_str()).or_default();
        match key.as_str() {
            "distance" => at.distance = a,
            "minutes" => at.minutes = a,
            _ => at.pace = a,
        }
    }
    Ok(Records { exercises, types })
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

/// A profile's plans in `[?2, ?3]`, as `IN_RANGE` bounds them: an open end
/// is a bound the day index serves.
fn plan_range() -> String {
    format!(
        "SELECT {PLAN_COLS} FROM {PLAN_FROM}
         WHERE p.profile_id = ?1 AND p.day >= coalesce(?2, '') AND p.day <= coalesce(?3, '9999-12-31')
         ORDER BY p.day, p.id"
    )
}

/// A profile's plans in `[from, to]` (either end open), by day, oldest first.
pub fn plan_list(
    conn: &Connection,
    profile: ProfileId,
    from: Option<&str>,
    to: Option<&str>,
) -> Result<Vec<Plan>, Error> {
    let mut stmt = conn.prepare_cached(&plan_range())?;
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

#[cfg(test)]
mod tests {
    use super::*;

    /// A range of plans reads through the day index, an open end included
    /// (`?2 IS NULL OR p.day >= ?2` reads every plan the profile has).
    #[test]
    fn plans_read_by_the_day_range() {
        let conn = super::super::open(std::path::Path::new(":memory:")).unwrap();
        let plan: Vec<String> = conn
            .prepare(&format!("EXPLAIN QUERY PLAN {}", plan_range()))
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
