//! The raw store (`health_record`, ADR 0019): written and read here only
//! (`no_reader_selects_health_record`). Nothing shows it; the server makes
//! Health Connect's nights, resting energy and day distance from it
//! (`nights_derive`, `resting_derive`, `distance_derive`). Upserted by key; a source's rows go when its data is
//! removed (Remove synced data, Remove the import) or with the profile;
//! exports leave it out, backups keep it.

use super::derived::{distance_derive, nights_derive, resting_derive};
use super::prelude::*;
use crate::model::{
    HEALTH_CONNECT, HealthRecord, RawCounts, RecordsPost, RecordsResult, health_connect_sleeps,
};

/// Upsert one record of `source`: its data replaces what the key held,
/// and `received_at` says when it last changed. The same record sent again
/// writes nothing (a phone resends its whole window every sync); whether it
/// was new or changed.
pub(super) fn record_put(
    tx: &Connection,
    pid: ProfileId,
    source: &str,
    r: &HealthRecord,
    now: i64,
) -> Result<bool, Error> {
    let changed = tx
        .prepare_cached(
            "INSERT INTO health_record (profile_id, source, kind, record_id, start_at, end_at,
                 day, data, received_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT (profile_id, source, kind, record_id) DO UPDATE SET
                 start_at = ?5, end_at = ?6, day = ?7, data = ?8, received_at = ?9
             WHERE data IS NOT ?8 OR start_at IS NOT ?5 OR end_at IS NOT ?6 OR day IS NOT ?7",
        )?
        .execute(params![
            pid, source, r.kind, r.id, r.start_at, r.end_at, r.day, r.data, now
        ])?;
    Ok(changed > 0)
}

/// Keep a page of the phone's records, in one transaction. What the server
/// makes of its new or changed ones follows in it: the nights of the days
/// its sleep sessions woke on and the day before each, and of the nights
/// its HRV readings may fall in; the resting energy of the days its basal
/// metabolic rates name (an older phone posts its window before its pages). Its outcome adds to
/// the sync's records outcome (`sync_state.records_result`: its pages, the
/// first after a window starting it over), and is logged.
pub fn records_put(
    conn: &mut Connection,
    pid: ProfileId,
    post: &RecordsPost,
    now: i64,
    tz: &TimeZone,
) -> Result<RawCounts, Error> {
    let tx = write(conn)?;
    let mut changed = Vec::new();
    for r in &post.records {
        if record_put(&tx, pid, HEALTH_CONNECT, r, now)? {
            changed.push(r);
        }
    }
    let of = |kind: &'static str| changed.iter().copied().filter(move |r| r.kind == kind);
    let sessions: Vec<(String, String)> = of(SLEEP_SESSION)
        .map(|r| (r.id.clone(), r.data.clone()))
        .collect();
    let mut nights = BTreeSet::new();
    for day in health_connect_sleeps(&sessions, tz).days {
        nights.extend(day_and_before(&day));
    }
    for r in of(HRV) {
        // A reading late in the evening is the next night's.
        nights.extend(r.day.as_deref().and_then(next_day));
        nights.extend(r.day.clone());
    }
    nights_derive(&tx, pid, &nights, tz)?;
    let resting: BTreeSet<String> = of(BMR).filter_map(|r| r.day.clone()).collect();
    resting_derive(&tx, pid, &resting)?;
    let walked: BTreeSet<String> = of(DISTANCE).filter_map(|r| r.day.clone()).collect();
    distance_derive(&tx, pid, &walked)?;
    let counts = RawCounts {
        records: post.records.len() as u64,
        truncated: post.records.iter().filter(|r| r.truncated).count() as u64,
        skipped: post.skipped,
        failed: post.failed,
    };
    // A page after a window starts the next sync's outcome: the window
    // marks the outcome `closed` (`device_replace`), so no clock decides.
    let before: Option<String> = tx
        .query_row(
            "SELECT records_result FROM sync_state WHERE profile_id = ? AND source = ?
             AND NOT coalesce(json_extract(records_result, '$.closed'), 0)",
            params![pid, HEALTH_CONNECT],
            |r| r.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten();
    let ongoing: Option<RecordsResult> = before.as_deref().map(from_json).transpose()?;
    let total = ongoing.unwrap_or_default().add(counts, now);
    tx.execute(
        "INSERT INTO sync_state (profile_id, source, records_result) VALUES (?1, ?2, ?3)
         ON CONFLICT (profile_id, source) DO UPDATE SET records_result = ?3",
        params![pid, HEALTH_CONNECT, json(&total)],
    )?;
    tx.commit()?;
    tracing::info!(
        profile = pid.0,
        records = counts.records,
        truncated = counts.truncated,
        skipped = counts.skipped,
        failed = counts.failed,
        "health records kept"
    );
    Ok(counts)
}

/// Keep `records` of `source` unless their key is already there (an
/// import's ids are its rows' hashes: a key held is the same row), in one
/// transaction; how many were new.
pub fn records_add(
    conn: &mut Connection,
    pid: ProfileId,
    source: &str,
    records: &[HealthRecord],
    now: i64,
) -> Result<u64, Error> {
    let tx = write(conn)?;
    let mut add = tx.prepare_cached(
        "INSERT OR IGNORE INTO health_record (profile_id, source, kind, record_id, start_at,
             end_at, day, data, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )?;
    let mut added = 0;
    for r in records {
        added += add.execute(params![
            pid, source, r.kind, r.id, r.start_at, r.end_at, r.day, r.data, now
        ])? as u64;
    }
    drop(add);
    tx.commit()?;
    Ok(added)
}

/// The raw kinds the server makes days from.
pub(super) const SLEEP_SESSION: &str = "SleepSession";
pub(super) const HRV: &str = "HeartRateVariabilityRmssd";
pub(super) const BMR: &str = "BasalMetabolicRate";
pub(super) const DISTANCE: &str = "Distance";

/// `day` and the day before it (both when `day` reads).
fn day_and_before(day: &str) -> Vec<String> {
    let Ok(d) = day.parse::<jiff::civil::Date>() else {
        return Vec::new();
    };
    [d.yesterday().ok(), Some(d)]
        .into_iter()
        .flatten()
        .map(|d| d.to_string())
        .collect()
}

/// The day after `day`.
fn next_day(day: &str) -> Option<String> {
    Some(
        day.parse::<jiff::civil::Date>()
            .ok()?
            .tomorrow()
            .ok()?
            .to_string(),
    )
}

/// `pid`'s Health Connect records of `kind` whose day (their start's) is in
/// `[from, to]` (either end open): `(record id, data)`.
pub(super) fn raw_list(
    conn: &Connection,
    pid: ProfileId,
    kind: &str,
    from: Option<&str>,
    to: Option<&str>,
) -> Result<Vec<(String, String)>, Error> {
    Ok(conn
        .prepare_cached(&format!(
            "SELECT record_id, data FROM health_record
             WHERE {IN_RANGE} AND source = ?4 AND kind = ?5
             ORDER BY start_at, record_id"
        ))?
        .query_map(params![pid, from, to, HEALTH_CONNECT, kind], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })?
        .collect::<rusqlite::Result<_>>()?)
}

/// Every day of `pid`'s Health Connect records of `kind`.
pub(super) fn raw_days(
    conn: &Connection,
    pid: ProfileId,
    kind: &str,
) -> Result<BTreeSet<String>, Error> {
    Ok(conn
        .prepare_cached(
            "SELECT DISTINCT day FROM health_record
             WHERE profile_id = ? AND source = ? AND kind = ? AND day IS NOT NULL",
        )?
        .query_map(params![pid, HEALTH_CONNECT, kind], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?)
}

/// The profiles with Health Connect records of `kind`.
pub(super) fn raw_profiles(conn: &Connection, kind: &str) -> Result<Vec<ProfileId>, Error> {
    Ok(conn
        .prepare_cached(
            "SELECT DISTINCT profile_id FROM health_record WHERE source = ? AND kind = ?
             ORDER BY profile_id",
        )?
        .query_map(params![HEALTH_CONNECT, kind], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?)
}

/// `pid`'s HRV readings on days in `[from, to]` (either end open): their
/// time and RMSSD in thousandths of a millisecond.
pub(super) fn hrv_list(
    conn: &Connection,
    pid: ProfileId,
    from: Option<&str>,
    to: Option<&str>,
) -> Result<Vec<(String, i64)>, Error> {
    Ok(conn
        .prepare_cached(&format!(
            "SELECT start_at, CAST(round(json_extract(data, '$.ms') * 1000) AS INTEGER)
             FROM health_record
             WHERE {IN_RANGE} AND source = ?4 AND kind = ?5
               AND json_type(data, '$.ms') IN ('integer', 'real')"
        ))?
        .query_map(params![pid, from, to, HEALTH_CONNECT, HRV], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })?
        .collect::<rusqlite::Result<_>>()?)
}

/// A basal metabolic rate the phone kept: its day, resting energy (kcal a
/// day) and the app that wrote it.
pub(super) struct RawBmr {
    pub(super) day: String,
    pub(super) kcal: f64,
    pub(super) origin: String,
}

/// The latest day of `pid`'s Health Connect records of `kind`.
pub(super) fn raw_latest(
    conn: &Connection,
    pid: ProfileId,
    kind: &str,
) -> Result<Option<String>, Error> {
    Ok(conn
        .prepare_cached(
            "SELECT max(day) FROM health_record
             WHERE profile_id = ? AND source = ? AND kind = ? AND day IS NOT NULL",
        )?
        .query_row(params![pid, HEALTH_CONNECT, kind], |r| r.get(0))?)
}

/// The basal metabolic rates `pid`'s phone kept on days from `from` (every
/// day when `None`), by day and time (a day's latest last).
pub(super) fn bmr_list(
    conn: &Connection,
    pid: ProfileId,
    from: Option<&str>,
) -> Result<Vec<RawBmr>, Error> {
    Ok(conn
        .prepare_cached(&format!(
            "SELECT day, json_extract(data, '$.kcal_per_day'),
                    json_extract(data, '$.metadata.data_origin')
             FROM health_record
             WHERE {IN_RANGE} AND source = ?4 AND kind = ?5
               AND json_type(data, '$.kcal_per_day') IN ('integer', 'real')
               AND json_type(data, '$.metadata.data_origin') = 'text'
             ORDER BY day, start_at"
        ))?
        .query_map(params![pid, from, None::<&str>, HEALTH_CONNECT, BMR], |r| {
            Ok(RawBmr {
                day: r.get(0)?,
                kcal: r.get(1)?,
                origin: r.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?)
}

/// `pid`'s distance records on days from `from` (every day when `None`),
/// by day and the app that wrote them: `(day, origin, the records' sum in
/// whole metres)`, by day.
pub(super) fn distance_list(
    conn: &Connection,
    pid: ProfileId,
    from: Option<&str>,
) -> Result<Vec<(String, String, i64)>, Error> {
    Ok(conn
        .prepare_cached(&format!(
            "SELECT day, json_extract(data, '$.metadata.data_origin') AS origin,
                    CAST(round(sum(json_extract(data, '$.meters'))) AS INTEGER)
             FROM health_record
             WHERE {IN_RANGE} AND source = ?4 AND kind = ?5
               AND json_type(data, '$.meters') IN ('integer', 'real')
               AND json_type(data, '$.metadata.data_origin') = 'text'
             GROUP BY day, origin ORDER BY day, origin"
        ))?
        .query_map(
            params![pid, from, None::<&str>, HEALTH_CONNECT, DISTANCE],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )?
        .collect::<rusqlite::Result<_>>()?)
}

/// Remove `pid`'s Health Connect records of `kind` on days in `[from, to]`
/// but those in `kept`: what the phone read there, the rest Health Connect
/// no longer holds (deleted on the phone). How many went.
pub(super) fn raw_prune(
    tx: &Connection,
    pid: ProfileId,
    kind: &str,
    (from, to): (&str, &str),
    kept: &BTreeSet<String>,
) -> Result<usize, Error> {
    let ids: Vec<String> = tx
        .prepare_cached(&format!(
            "SELECT record_id FROM health_record WHERE {IN_RANGE} AND source = ?4 AND kind = ?5"
        ))?
        .query_map(params![pid, from, to, HEALTH_CONNECT, kind], |r| r.get(0))?
        .collect::<rusqlite::Result<Vec<String>>>()?
        .into_iter()
        .filter(|id| !kept.contains(id))
        .collect();
    let mut delete = tx.prepare_cached(
        "DELETE FROM health_record
         WHERE profile_id = ? AND source = ? AND kind = ? AND record_id = ?",
    )?;
    for id in &ids {
        delete.execute(params![pid, HEALTH_CONNECT, kind, id])?;
    }
    Ok(ids.len())
}
