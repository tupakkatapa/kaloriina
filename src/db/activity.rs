//! Health Connect activity: days and the watch's raw
//! workouts, replaced a window at a time; the sessions promoted from them
//! (`sync_workouts`); and the sync's status row in `sync_state`.

use super::prelude::*;
use super::sync_workouts::{promote, refresh_synced, synced_workout_list};
use crate::model::{
    Activity, ActivityDay, ActivitySession, HEALTH_CONNECT, HealthCounts, HealthPost, HealthResult,
    HealthStatus, SessionSource,
};

pub fn health_status(conn: &Connection, pid: ProfileId) -> Result<HealthStatus, Error> {
    let row = conn
        .query_row(
            "SELECT last_seen, last_result FROM sync_state WHERE profile_id = ? AND source = ?",
            params![pid, HEALTH_CONNECT],
            |r| {
                let last: Option<String> = r.get(1)?;
                Ok((r.get(0)?, last.as_deref().map(from_json).transpose()?))
            },
        )
        .optional()?;
    let (last_seen, last_result) = row.unwrap_or((None, None));
    Ok(HealthStatus {
        last_seen,
        last_result,
        workouts: synced_workout_list(conn, pid)?,
    })
}

const DAY_COLS: &str = "day, active_kcal, steps, resting_hr, hrv_ms, asleep_min, in_bed_min, \
                        bedtime, wake_time, deep_min, rem_min, light_min";

/// Write `days` and `sessions` (checked) for `pid`; sessions with a key
/// already stored are replaced.
pub(super) fn activity_insert(
    tx: &Connection,
    pid: ProfileId,
    days: &[ActivityDay],
    sessions: &[ActivitySession],
) -> Result<(), Error> {
    let mut day = tx.prepare_cached(&format!(
        "INSERT INTO activity_day (profile_id, {DAY_COLS})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ))?;
    for d in days {
        day.execute(params![
            pid,
            d.day,
            d.active_kcal,
            d.steps,
            d.resting_hr,
            d.hrv_ms,
            d.asleep_min,
            d.in_bed_min,
            d.bedtime,
            d.wake_time,
            d.deep_min,
            d.rem_min,
            d.light_min
        ])?;
    }
    let mut session = tx.prepare_cached(
        "INSERT OR REPLACE INTO activity_session
             (profile_id, source_key, day, start_at, end_at, type, name, kcal, distance_m,
              recording_method)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )?;
    for s in sessions {
        session.execute(params![
            pid,
            s.key,
            s.day,
            s.start_at,
            s.end_at,
            s.kind,
            s.name,
            s.kcal,
            s.distance_m,
            s.recording_method
        ])?;
    }
    Ok(())
}

/// Apply one sync in one transaction: the window's days and raw
/// workouts are replaced by the POST's (a workout whose day moved goes too,
/// by its key); the window's watch sessions follow them; every candidate is
/// claimed or promoted; and the status row records it.
pub fn activity_replace(
    conn: &mut Connection,
    pid: ProfileId,
    post: &HealthPost,
    now: i64,
) -> Result<HealthCounts, Error> {
    let tx = write(conn)?;
    let window = params![pid, post.from, post.to];
    tx.execute(
        "DELETE FROM activity_day WHERE profile_id = ? AND day BETWEEN ? AND ?",
        window,
    )?;
    tx.execute(
        "DELETE FROM activity_session WHERE profile_id = ? AND day BETWEEN ? AND ?",
        window,
    )?;
    activity_insert(&tx, pid, &post.days, &post.sessions)?;
    let status = health_status(&tx, pid)?;
    let previous_device = status.last_result.and_then(|r| r.device);
    refresh_synced(
        &tx,
        pid,
        &post.from,
        &post.to,
        post.device == previous_device,
    )?;
    promote(&tx, pid, status.workouts)?;
    let counts = HealthCounts {
        days: post.days.len() as u64,
        sessions: post.sessions.len() as u64,
        nights: post.days.iter().filter(|d| d.in_bed_min.is_some()).count() as u64,
        skipped: post.skipped,
    };
    let result = HealthResult {
        counts,
        from: post.from.clone(),
        to: post.to.clone(),
        device: post.device.clone(),
        previous_device,
    };
    tx.execute(
        "INSERT INTO sync_state (profile_id, source, last_seen, last_result) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (profile_id, source) DO UPDATE SET last_seen = ?3, last_result = ?4",
        params![pid, HEALTH_CONNECT, now, json(&result)],
    )?;
    tx.commit()?;
    Ok(counts)
}

/// A profile's activity in `[from, to]` (either end open), oldest first.
pub fn activity_list(
    conn: &Connection,
    pid: ProfileId,
    from: Option<&str>,
    to: Option<&str>,
) -> Result<Activity, Error> {
    let range = params![pid, from, to];
    let days = conn
        .prepare_cached(&format!(
            "SELECT {DAY_COLS} FROM activity_day
             WHERE profile_id = ?1 AND (?2 IS NULL OR day >= ?2) AND (?3 IS NULL OR day <= ?3)
             ORDER BY day"
        ))?
        .query_map(range, |r| {
            Ok(ActivityDay {
                day: r.get(0)?,
                active_kcal: r.get(1)?,
                steps: r.get(2)?,
                resting_hr: r.get(3)?,
                hrv_ms: r.get(4)?,
                asleep_min: r.get(5)?,
                in_bed_min: r.get(6)?,
                bedtime: r.get(7)?,
                wake_time: r.get(8)?,
                deep_min: r.get(9)?,
                rem_min: r.get(10)?,
                light_min: r.get(11)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    let sessions = conn
        .prepare_cached(
            "SELECT source_key, day, start_at, end_at, type, name, kcal, distance_m,
                    recording_method
             FROM activity_session
             WHERE profile_id = ?1 AND (?2 IS NULL OR day >= ?2) AND (?3 IS NULL OR day <= ?3)
             ORDER BY day, start_at",
        )?
        .query_map(range, |r| {
            Ok(ActivitySession {
                key: r.get(0)?,
                day: r.get(1)?,
                start_at: r.get(2)?,
                end_at: r.get(3)?,
                kind: r.get(4)?,
                name: r.get(5)?,
                kcal: r.get(6)?,
                distance_m: r.get(7)?,
                recording_method: r.get(8)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(Activity { days, sessions })
}

/// Forget everything synced from Health Connect, and its status: the
/// sessions the sync added go; hand logs keep what they took; tombstones,
/// the mode and the openScale connection stay.
pub fn activity_delete(conn: &mut Connection, pid: ProfileId) -> Result<(), Error> {
    let tx = write(conn)?;
    tx.execute("DELETE FROM activity_day WHERE profile_id = ?", [pid])?;
    tx.execute("DELETE FROM activity_session WHERE profile_id = ?", [pid])?;
    tx.execute(
        "DELETE FROM workout_session WHERE profile_id = ? AND source = ?",
        params![pid, SessionSource::HealthConnect],
    )?;
    tx.execute(
        "DELETE FROM sync_state WHERE profile_id = ? AND source = ?",
        params![pid, HEALTH_CONNECT],
    )?;
    tx.commit()?;
    Ok(())
}
