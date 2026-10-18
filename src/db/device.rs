//! Health Connect device data: days and the device's raw
//! workouts, replaced a window at a time; the activities promoted from them
//! (`sync_workouts`); and the sync's status row in `sync_state`.

use super::derived::{days_between, distance_derive, nights_derive, resting_derive, shift};
use super::health_record::{BMR, raw_prune};
use super::prelude::*;
use super::scale::{health_readings_delete, health_readings_replace};
use super::sync_workouts::{import_workouts, promote, refresh_synced, synced_workout_list};
use jiff::Timestamp;

use crate::model::{
    ActivitySource, DayResting, DeviceDay, DeviceDays, DeviceSession, GOOGLE_HEALTH,
    HEALTH_CONNECT, HealthCounts, HealthPost, HealthResult, HealthStatus, IMPORT_KEY_PREFIX,
    ImportCounts, ImportedWorkout, NAPS_MAX, Nap, NapIn, NapInput, NapSource, Provenance, Resting,
    ShownDay, SleepStage, StageSource, awake_tail_cut, span_minutes,
};

pub fn health_status(conn: &Connection, pid: ProfileId) -> Result<HealthStatus, Error> {
    let row = conn
        .query_row(
            "SELECT last_seen, last_result, records_result FROM sync_state
             WHERE profile_id = ? AND source = ?",
            params![pid, HEALTH_CONNECT],
            |r| {
                let last: Option<String> = r.get(1)?;
                let records: Option<String> = r.get(2)?;
                Ok((
                    r.get(0)?,
                    last.as_deref().map(from_json).transpose()?,
                    records.as_deref().map(from_json).transpose()?,
                ))
            },
        )
        .optional()?;
    let (last_seen, last_result, records_result) = row.unwrap_or((None, None, None));
    Ok(HealthStatus {
        last_seen,
        last_result,
        records_result,
        workouts: synced_workout_list(conn, pid)?,
    })
}

/// Every day column, in [`day_row`]'s order: the day, its values
/// ([`DAY_VALUE_COLS`]: each shows the device's, else the import's) and
/// its night ([`NIGHT_COLS`]: one group, the device's when it has a night,
/// else the import's).
pub(super) const DAY_COLUMNS: &[&str] = &[
    "day",
    "active_kcal",
    "total_kcal",
    "steps",
    "resting_hr",
    "hrv_ms",
    "avg_hr",
    "min_hr",
    "max_hr",
    "bmr_kcal",
    "bmr_origin",
    "distance_m",
    "in_bed_min",
    "asleep_min",
    "bedtime",
    "wake_time",
    "deep_min",
    "rem_min",
    "light_min",
    "sleep_avg_hr",
];
const SPLIT: (&[&str], &[&str]) = DAY_COLUMNS.split_at(12);
pub(super) const DAY_VALUE_COLS: &[&str] = SPLIT.0.split_at(1).1;
pub(super) const NIGHT_COLS: &[&str] = SPLIT.1;

/// [`DAY_COLUMNS`] as SQL.
fn day_cols() -> String {
    DAY_COLUMNS.join(", ")
}

/// A day's values in [`DAY_COLUMNS`]' order.
fn day_values(d: &DeviceDay) -> [&dyn rusqlite::ToSql; 20] {
    [
        &d.day,
        &d.active_kcal,
        &d.total_kcal,
        &d.steps,
        &d.resting_hr,
        &d.hrv_ms,
        &d.avg_hr,
        &d.min_hr,
        &d.max_hr,
        &d.bmr_kcal,
        &d.bmr_origin,
        &d.distance_m,
        &d.in_bed_min,
        &d.asleep_min,
        &d.bedtime,
        &d.wake_time,
        &d.deep_min,
        &d.rem_min,
        &d.light_min,
        &d.sleep_avg_hr,
    ]
}

/// Write `days` with `sql` (`INSERT … INTO <table> (profile_id, <every day
/// column>) VALUES (?1, ?2 … ?21) …`) for `pid`.
fn days_put(tx: &Connection, sql: &str, pid: ProfileId, days: &[DeviceDay]) -> Result<(), Error> {
    let mut put = tx.prepare_cached(sql)?;
    for d in days {
        let mut args: Vec<&dyn rusqlite::ToSql> = vec![&pid];
        args.extend(day_values(d));
        put.execute(args.as_slice())?;
    }
    Ok(())
}

/// `INSERT INTO <table> (profile_id, <every day column>) VALUES (…)`.
fn day_insert(table: &str) -> String {
    let marks = (1..=DAY_COLUMNS.len() + 1)
        .map(|i| format!("?{i}"))
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "INSERT INTO {table} (profile_id, {}) VALUES ({marks})",
        day_cols()
    )
}

/// Every day column as shown: `a` the device's row, `i` the import's.
fn shown_cols() -> String {
    let mut cols = vec!["d.day".to_owned()];
    cols.extend(
        DAY_VALUE_COLS
            .iter()
            .map(|c| format!("coalesce(a.{c}, i.{c})")),
    );
    cols.extend(NIGHT_COLS.iter().map(|c| {
        format!(
            "CASE WHEN a.in_bed_min IS NULL AND i.in_bed_min IS NOT NULL THEN i.{c} ELSE a.{c} END"
        )
    }));
    cols.join(", ")
}

/// Write `days` and `sessions` (checked) for `pid`; sessions with a key
/// already stored are replaced.
pub(super) fn device_insert(
    tx: &Connection,
    pid: ProfileId,
    days: &[DeviceDay],
    sessions: &[DeviceSession],
) -> Result<(), Error> {
    days_put(tx, &day_insert("device_day"), pid, days)?;
    let mut session = tx.prepare_cached(
        "INSERT OR REPLACE INTO device_session
             (profile_id, source_key, day, start_at, end_at, type, name, kcal, distance_m,
              recording_method, avg_hr, max_hr, total_kcal)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
            s.recording_method,
            s.avg_hr,
            s.max_hr,
            s.total_kcal
        ])?;
    }
    Ok(())
}

/// Store `naps` from `source`, each by its key (a key stored before moves;
/// another source's key is never taken). Overlaps are kept: which nap shows
/// is read time's ([`shown_naps`]). How many were new.
pub(super) fn naps_insert(
    tx: &Connection,
    pid: ProfileId,
    source: NapSource,
    naps: &[NapIn],
) -> Result<u64, Error> {
    let count = |tx: &Connection| -> Result<i64, Error> {
        Ok(tx.query_row(
            "SELECT count(*) FROM nap WHERE profile_id = ? AND source = ?",
            params![pid, source],
            |r| r.get(0),
        )?)
    };
    let before = count(tx)?;
    let mut put = tx.prepare_cached(
        "INSERT INTO nap (profile_id, day, source_key, start_at, end_at, source, asleep_min)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT (profile_id, source_key) DO UPDATE SET
             day = excluded.day, start_at = excluded.start_at, end_at = excluded.end_at,
             asleep_min = excluded.asleep_min
         WHERE nap.source = excluded.source",
    )?;
    for n in naps {
        put.execute(params![
            pid,
            n.day,
            n.key,
            n.start_at,
            n.end_at,
            source,
            n.asleep_min
        ])?;
    }
    Ok(u64::try_from(count(tx)? - before).unwrap_or(0))
}

/// The naps of `all` that show: one overlapping a nap of a source that
/// comes first ([`Provenance`]) is hidden, never deleted; by day and start.
fn shown_naps(all: Vec<Nap>) -> Vec<Nap> {
    let mut by_rank: BTreeMap<Provenance, Vec<Nap>> = BTreeMap::new();
    for n in all {
        by_rank.entry(n.source.into()).or_default().push(n);
    }
    let span = |n: &Nap| -> Option<(Timestamp, Timestamp)> {
        Some((n.start_at.parse().ok()?, n.end_at.parse().ok()?))
    };
    // What the naps kept so far cover: disjoint spans, by start.
    let mut covered: Vec<(Timestamp, Timestamp)> = Vec::new();
    let mut shown = Vec::new();
    for naps in by_rank.into_values() {
        let mut kept = Vec::new();
        for n in naps {
            if let Some((start, end)) = span(&n) {
                let before = covered.partition_point(|c| c.0 < end);
                if before > 0 && covered[before - 1].1 > start {
                    continue;
                }
                kept.push((start, end));
            }
            shown.push(n);
        }
        covered.extend(kept);
        covered.sort_unstable();
        let mut merged: Vec<(Timestamp, Timestamp)> = Vec::with_capacity(covered.len());
        for (start, end) in covered {
            match merged.last_mut() {
                Some(last) if start <= last.1 => last.1 = last.1.max(end),
                _ => merged.push((start, end)),
            }
        }
        covered = merged;
    }
    shown.sort_by(|a, b| (&a.day, &a.start_at).cmp(&(&b.day, &b.start_at)));
    shown
}

/// Store `stages` (checked), each replacing its source's span with the
/// same start.
pub(super) fn stages_put(
    tx: &Connection,
    pid: ProfileId,
    stages: &[SleepStage],
) -> Result<(), Error> {
    let mut put = tx.prepare_cached(
        "INSERT OR REPLACE INTO sleep_stage (profile_id, day, start_at, end_at, stage, source)
         VALUES (?, ?, ?, ?, ?, ?)",
    )?;
    for s in stages {
        put.execute(params![pid, s.day, s.start_at, s.end_at, s.stage, s.source])?;
    }
    Ok(())
}

/// `pid`'s sleep stage spans in `[from, to]` (either end open), every
/// source's, by day and start.
pub fn sleep_stage_list(
    conn: &Connection,
    pid: ProfileId,
    from: Option<&str>,
    to: Option<&str>,
) -> Result<Vec<SleepStage>, Error> {
    Ok(conn
        .prepare_cached(&format!(
            "SELECT day, start_at, end_at, stage, source FROM sleep_stage
             WHERE {IN_RANGE}
             ORDER BY day, start_at, source"
        ))?
        .query_map(params![pid, from, to], |r| {
            Ok(SleepStage {
                day: r.get(0)?,
                start_at: r.get(1)?,
                end_at: r.get(2)?,
                stage: r.get(3)?,
                source: r.get(4)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?)
}

/// The night's spans that show on `day` ([`shown_stages`]).
pub fn day_stages(conn: &Connection, pid: ProfileId, day: &str) -> Result<Vec<SleepStage>, Error> {
    let mut stages = shown_stages(conn, pid, Some(day), Some(day))?
        .remove(day)
        .unwrap_or_default();
    awake_tail_cut(&mut DeviceDay::default(), &mut stages);
    Ok(stages)
}

/// Each day's night spans that show in `[from, to]` (either end open), by
/// day: the device's when it has the night or sent spans, else the
/// import's; an awake tail is cut where it is read ([`awake_tail_cut`]).
fn shown_stages(
    conn: &Connection,
    pid: ProfileId,
    from: Option<&str>,
    to: Option<&str>,
) -> Result<BTreeMap<String, Vec<SleepStage>>, Error> {
    let device_nights: BTreeSet<String> = conn
        .prepare_cached(&format!(
            "SELECT day FROM device_day WHERE {IN_RANGE} AND in_bed_min IS NOT NULL"
        ))?
        .query_map(params![pid, from, to], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    let mut by_day: BTreeMap<String, Vec<SleepStage>> = BTreeMap::new();
    for s in sleep_stage_list(conn, pid, from, to)? {
        by_day.entry(s.day.clone()).or_default().push(s);
    }
    for (day, all) in &mut by_day {
        let synced = |s: &SleepStage| s.source == StageSource::HealthConnect;
        if device_nights.contains(day) || all.iter().any(synced) {
            all.retain(synced);
        }
    }
    Ok(by_day)
}

/// `pid`'s naps that show in `[from, to]` (either end open), by day and
/// start ([`shown_naps`]; a day either side is read for its overlaps).
pub fn nap_list(
    conn: &Connection,
    pid: ProfileId,
    from: Option<&str>,
    to: Option<&str>,
) -> Result<Vec<Nap>, Error> {
    let near: Vec<Nap> = conn
        .prepare_cached(
            "SELECT uid, day, start_at, end_at, source, source_key, asleep_min FROM nap
             WHERE profile_id = ?1 AND day >= coalesce(date(?2, '-1 day'), '')
               AND day <= coalesce(date(?3, '+1 day'), '9999-12-31')",
        )?
        .query_map(params![pid, from, to], nap_row)?
        .collect::<rusqlite::Result<_>>()?;
    Ok(shown_naps(near)
        .into_iter()
        .filter(|n| {
            from.is_none_or(|f| n.day.as_str() >= f) && to.is_none_or(|t| n.day.as_str() <= t)
        })
        .collect())
}

/// Every nap `pid` has stored, hidden ones too, by day and start (what is
/// exported).
pub(super) fn stored_naps(conn: &Connection, pid: ProfileId) -> Result<Vec<Nap>, Error> {
    Ok(conn
        .prepare_cached(
            "SELECT uid, day, start_at, end_at, source, source_key, asleep_min FROM nap
             WHERE profile_id = ? ORDER BY day, start_at",
        )?
        .query_map([pid], nap_row)?
        .collect::<rusqlite::Result<_>>()?)
}

/// Log a nap by hand; a `uid` stored before returns that nap.
pub fn nap_insert(conn: &mut Connection, pid: ProfileId, n: &NapInput) -> Result<Nap, Error> {
    let tx = write(conn)?;
    let uid: String = match &n.uid {
        Some(uid) => {
            tx.execute(
                "INSERT INTO nap (profile_id, uid, day, start_at, end_at, source)
                 VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (profile_id, uid) DO NOTHING",
                params![pid, uid, n.day, n.start_at, n.end_at, NapSource::Hand],
            )?;
            uid.clone()
        }
        None => tx.query_row(
            "INSERT INTO nap (profile_id, day, start_at, end_at, source)
             VALUES (?, ?, ?, ?, ?) RETURNING uid",
            params![pid, n.day, n.start_at, n.end_at, NapSource::Hand],
            |r| r.get(0),
        )?,
    };
    let nap = nap_get(&tx, pid, &uid)?.ok_or_else(|| Error::not_found("nap", &uid))?;
    tx.commit()?;
    Ok(nap)
}

fn nap_get(conn: &Connection, pid: ProfileId, uid: &str) -> Result<Option<Nap>, Error> {
    Ok(conn
        .query_row(
            "SELECT uid, day, start_at, end_at, source, source_key, asleep_min FROM nap
             WHERE profile_id = ? AND uid = ?",
            params![pid, uid],
            nap_row,
        )
        .optional()?)
}

/// Delete a nap logged by hand; a synced or imported one goes with its
/// source (409: remove the sync's data or the import in Connections).
pub fn nap_delete(conn: &mut Connection, pid: ProfileId, uid: &str) -> Result<(), Error> {
    let tx = write(conn)?;
    let nap = nap_get(&tx, pid, uid)?.ok_or_else(|| Error::not_found("nap", uid))?;
    if nap.source != NapSource::Hand {
        return Err(Error::conflict(
            Conflict::DeviceReadOnly,
            "this nap came from a device or an import: remove it in Connections",
        ));
    }
    tx.execute(
        "DELETE FROM nap WHERE profile_id = ? AND uid = ?",
        params![pid, uid],
    )?;
    tx.commit()?;
    Ok(())
}

fn nap_row(r: &Row) -> rusqlite::Result<Nap> {
    let (start_at, end_at): (String, String) = (r.get(2)?, r.get(3)?);
    let minutes = span_minutes(&start_at, &end_at).unwrap_or(0);
    let source: NapSource = r.get(4)?;
    Ok(Nap {
        uid: r.get(0)?,
        day: r.get(1)?,
        in_bed_min: minutes,
        // One logged by hand says when you slept.
        asleep_min: match source {
            NapSource::Hand => Some(minutes),
            _ => r.get(6)?,
        },
        start_at,
        end_at,
        source,
        source_key: r.get(5)?,
    })
}

/// Apply one sync in one transaction: the window's days and raw workouts
/// are replaced by the POST's (a workout whose day moved goes too, by its
/// key); its nights, naps, stage spans and resting energy are made from the
/// raw records kept (the phone posts its pages first); the
/// window's device sessions follow; every candidate is claimed or promoted;
/// and the status row records it (beside its pages' outcome).
pub fn device_replace(
    conn: &mut Connection,
    pid: ProfileId,
    post: &HealthPost,
    now: i64,
    tz: &TimeZone,
) -> Result<HealthCounts, Error> {
    let tx = write(conn)?;
    let window = params![pid, post.from, post.to];
    tx.execute(
        "DELETE FROM device_day WHERE profile_id = ? AND day BETWEEN ? AND ?",
        window,
    )?;
    tx.execute(
        "DELETE FROM device_session WHERE profile_id = ? AND day BETWEEN ? AND ?",
        window,
    )?;
    device_insert(&tx, pid, &post.days, &post.sessions)?;
    // A night's sessions may start the day before; resting is the day's own.
    let before = shift(&post.from, -1).unwrap_or_else(|| post.from.clone());
    for (kind, kept) in &post.read {
        let from = if kind == BMR { &post.from } else { &before };
        raw_prune(&tx, pid, kind, (from, &post.to), kept)?;
    }
    let days = days_between(&post.from, &post.to);
    nights_derive(&tx, pid, &days, tz)?;
    resting_derive(&tx, pid, &days)?;
    distance_derive(&tx, pid, &days)?;
    let nights: i64 = tx.query_row(
        "SELECT count(*) FROM device_day
         WHERE profile_id = ? AND day BETWEEN ? AND ? AND in_bed_min IS NOT NULL",
        window,
        |r| r.get(0),
    )?;
    health_readings_replace(&tx, pid, &post.from, &post.to, &post.body, now, tz)?;
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
        nights: u64::try_from(nights).unwrap_or(0),
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
        // The records outcome stays this sync's; the next page starts over.
        "INSERT INTO sync_state (profile_id, source, last_seen, last_result) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (profile_id, source) DO UPDATE SET last_seen = ?3, last_result = ?4,
             records_result = json_set(records_result, '$.closed', json('true'))",
        params![pid, HEALTH_CONNECT, now, json(&result)],
    )?;
    tx.commit()?;
    Ok(counts)
}

/// What shows of `pid`'s days in `[from, to]` (either end open), oldest
/// first: each value the device's, else the import's; the night the
/// device's when it has one, else the import's.
fn shown_days(
    conn: &Connection,
    pid: ProfileId,
    from: Option<&str>,
    to: Option<&str>,
) -> Result<Vec<DeviceDay>, Error> {
    Ok(conn
        .prepare_cached(&format!(
            "SELECT {} FROM (SELECT day FROM device_day WHERE {IN_RANGE}
                             UNION SELECT day FROM import_day WHERE {IN_RANGE}) d
             LEFT JOIN device_day a ON a.profile_id = ?1 AND a.day = d.day
             LEFT JOIN import_day i ON i.profile_id = ?1 AND i.day = d.day
             ORDER BY d.day",
            shown_cols()
        ))?
        .query_map(params![pid, from, to], day_row)?
        .collect::<rusqlite::Result<_>>()?)
}

/// Fill the profile's gaps from an export, in one transaction. Its days
/// are kept as the import's own (`import_day`, merged per column:
/// [`import_insert`]), and show wherever the device has nothing; a night
/// imported again replaces its spans; naps beyond [`NAPS_MAX`] a day are
/// skipped; workouts are added unless already there ([`import_workouts`]).
/// Running it again changes nothing. Days counts those whose shown values
/// changed, nights those that gained one.
pub fn device_fill(
    conn: &mut Connection,
    pid: ProfileId,
    days: &[DeviceDay],
    workouts: &[ImportedWorkout],
    naps: &[NapIn],
    stages: &[SleepStage],
    skipped: u64,
) -> Result<ImportCounts, Error> {
    let tx = write(conn)?;
    let from = days.iter().map(|d| d.day.as_str()).min();
    let to = days.iter().map(|d| d.day.as_str()).max();
    let before: BTreeMap<String, DeviceDay> = match from {
        Some(_) => shown_days(&tx, pid, from, to)?
            .into_iter()
            .map(|d| (d.day.clone(), d))
            .collect(),
        None => BTreeMap::new(),
    };
    import_insert(&tx, pid, days)?;
    let nights: BTreeSet<&str> = days
        .iter()
        .filter(|d| d.in_bed_min.is_some())
        .map(|d| d.day.as_str())
        .chain(stages.iter().map(|s| s.day.as_str()))
        .collect();
    for day in nights {
        tx.prepare_cached(
            "DELETE FROM sleep_stage WHERE profile_id = ? AND source = ? AND day = ?",
        )?
        .execute(params![pid, StageSource::Import, day])?;
    }
    stages_put(&tx, pid, stages)?;
    let mut per_day: BTreeMap<&str, usize> = BTreeMap::new();
    let (naps, over): (Vec<&NapIn>, Vec<&NapIn>) = naps.iter().partition(|n| {
        let seen = per_day.entry(n.day.as_str()).or_default();
        *seen += 1;
        *seen <= NAPS_MAX
    });
    let naps: Vec<NapIn> = naps.into_iter().cloned().collect();
    let naps = naps_insert(&tx, pid, NapSource::Import, &naps)?;
    let (mut changed, mut nights) = (0, 0);
    if from.is_some() {
        for d in shown_days(&tx, pid, from, to)? {
            let was = before.get(&d.day);
            changed += u64::from(was != Some(&d));
            nights +=
                u64::from(d.in_bed_min.is_some() && was.is_none_or(|w| w.in_bed_min.is_none()));
        }
    }
    let (activities, kept) = import_workouts(&tx, pid, workouts)?;
    tx.commit()?;
    Ok(ImportCounts {
        days: changed,
        nights,
        naps,
        activities,
        kept,
        records: 0,
        skipped: skipped + over.len() as u64,
    })
}

/// Store `days` as `pid`'s imported values, merged into the day's earlier
/// import: each value a later export has replaces the stored one, one it
/// lacks is kept (a Takeout in parts, the browser's batches); the night is
/// one group: the same night merges the same way, another one replaces it.
pub(super) fn import_insert(
    tx: &Connection,
    pid: ProfileId,
    days: &[DeviceDay],
) -> Result<(), Error> {
    let mut set: Vec<String> = DAY_VALUE_COLS
        .iter()
        .map(|c| format!("{c} = coalesce(excluded.{c}, {c})"))
        .collect();
    set.extend(NIGHT_COLS.iter().map(|c| {
        format!(
            "{c} = CASE WHEN excluded.in_bed_min IS NULL THEN {c}
                 WHEN excluded.in_bed_min IS in_bed_min AND excluded.bedtime IS bedtime
                      AND excluded.wake_time IS wake_time THEN coalesce(excluded.{c}, {c})
                 ELSE excluded.{c} END"
        )
    }));
    days_put(
        tx,
        &format!(
            "{} ON CONFLICT (profile_id, day) DO UPDATE SET {}",
            day_insert("import_day"),
            set.join(", ")
        ),
        pid,
        days,
    )
}

/// `pid`'s imported days, oldest first (exported as the import's own).
pub(super) fn import_list(conn: &Connection, pid: ProfileId) -> Result<Vec<DeviceDay>, Error> {
    Ok(conn
        .prepare_cached(&format!(
            "SELECT {} FROM import_day WHERE profile_id = ? ORDER BY day",
            day_cols()
        ))?
        .query_map([pid], day_row)?
        .collect::<rusqlite::Result<_>>()?)
}

/// A profile's device days in `[from, to]` (either end open), oldest
/// first: what is exported (the import's travel as its own).
pub(super) fn day_list(
    conn: &Connection,
    pid: ProfileId,
    from: Option<&str>,
    to: Option<&str>,
) -> Result<Vec<DeviceDay>, Error> {
    Ok(conn
        .prepare_cached(&format!(
            "SELECT {} FROM device_day
             WHERE {IN_RANGE}
             ORDER BY day",
            day_cols()
        ))?
        .query_map(params![pid, from, to], day_row)?
        .collect::<rusqlite::Result<_>>()?)
}

/// A profile's activity in `[from, to]` (either end open), oldest first:
/// each day as it shows ([`shown_days`]) with its sleep, the time asleep
/// of the naps that show added (a day of naps only among them).
pub fn device_day_list(
    conn: &Connection,
    pid: ProfileId,
    from: Option<&str>,
    to: Option<&str>,
) -> Result<DeviceDays, Error> {
    let range = params![pid, from, to];
    let shown = nap_list(conn, pid, from, to)?;
    // Each day's naps: (how many, minutes asleep of those known, minutes
    // in bed of those not).
    let mut naps: BTreeMap<String, (usize, Option<i64>, i64)> = BTreeMap::new();
    for n in &shown {
        let day = naps.entry(n.day.clone()).or_default();
        day.0 += 1;
        match n.asleep_min {
            Some(a) => day.1 = Some(day.1.unwrap_or(0) + a),
            None => day.2 += n.in_bed_min,
        }
    }
    let mut stages = shown_stages(conn, pid, from, to)?;
    let mut days: BTreeMap<String, DeviceDay> = shown_days(conn, pid, from, to)?
        .into_iter()
        .map(|mut d| {
            if let Some(spans) = stages.get_mut(&d.day) {
                awake_tail_cut(&mut d, spans);
            }
            (d.day.clone(), d)
        })
        .collect();
    for day in naps.keys() {
        days.entry(day.clone()).or_insert_with(|| DeviceDay {
            day: day.clone(),
            ..DeviceDay::default()
        });
    }
    // Resting energy is served apart (`resting`): alone it makes no day.
    let days = days
        .into_values()
        .filter(|d| d.has_value() || naps.contains_key(&d.day))
        .map(|d| DeviceDay {
            bmr_kcal: None,
            bmr_origin: None,
            ..d
        })
        .map(|d| {
            let (count, asleep, in_bed) = naps.get(&d.day).copied().unwrap_or_default();
            ShownDay {
                // Time asleep only: a nap's time in bed isn't sleep.
                total_asleep_min: match (d.asleep_min, asleep) {
                    (None, None) => None,
                    (a, b) => Some(a.unwrap_or(0) + b.unwrap_or(0)),
                },
                naps: count,
                nap_in_bed_min: in_bed,
                day: d,
            }
        })
        .collect();
    let sessions = conn
        .prepare_cached(&format!(
            "SELECT source_key, day, start_at, end_at, type, name, kcal, distance_m,
                    recording_method, avg_hr, max_hr, total_kcal
             FROM device_session
             WHERE {IN_RANGE}
             ORDER BY day, start_at"
        ))?
        .query_map(range, |r| {
            Ok(DeviceSession {
                key: r.get(0)?,
                day: r.get(1)?,
                start_at: r.get(2)?,
                end_at: r.get(3)?,
                kind: r.get(4)?,
                name: r.get(5)?,
                kcal: r.get(6)?,
                distance_m: r.get(7)?,
                recording_method: r.get(8)?,
                avg_hr: r.get(9)?,
                max_hr: r.get(10)?,
                total_kcal: r.get(11)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(DeviceDays {
        days,
        sessions,
        resting: resting_list(conn, pid, from, to)?,
        naps: shown,
    })
}

/// `pid`'s resting energy in effect on each day of `[from, to]` that has
/// one (`resting_on`), oldest first; an open end is the first day with
/// one, or the last one's carry.
pub fn resting_list(
    conn: &Connection,
    pid: ProfileId,
    from: Option<&str>,
    to: Option<&str>,
) -> Result<Vec<DayResting>, Error> {
    const SQL: &str = concat!(
        "WITH RECURSIVE bounds (lo, hi) AS (
             SELECT coalesce(?2, (SELECT min(day) FROM device_day
                                  WHERE profile_id = ?1 AND bmr_kcal IS NOT NULL)),
                    coalesce(?3, (SELECT date(max(day), '+6 days') FROM device_day
                                  WHERE profile_id = ?1 AND bmr_kcal IS NOT NULL))),
         cal (day) AS (SELECT lo FROM bounds WHERE lo <= hi
                       UNION ALL SELECT date(day, '+1 day') FROM cal, bounds WHERE day < hi)
         SELECT day, kcal, origin FROM (SELECT day, ",
        resting_on!("bmr_kcal", "?1", "cal.day"),
        " AS kcal, ",
        resting_on!("bmr_origin", "?1", "cal.day"),
        " AS origin FROM cal) WHERE kcal IS NOT NULL ORDER BY day"
    );
    Ok(conn
        .prepare_cached(SQL)?
        .query_map(params![pid, from, to], |r| {
            Ok(DayResting {
                day: r.get(0)?,
                resting: Resting {
                    kcal: r.get(1)?,
                    origin: r.get(2)?,
                },
            })
        })?
        .collect::<rusqlite::Result<_>>()?)
}

/// Forget everything synced from Health Connect, and its status: the
/// sessions and naps the sync added go, and its raw records (erasure);
/// hand logs keep what they took; tombstones, the mode, the openScale
/// connection and the import's values stay (and show again).
pub fn device_delete(
    conn: &mut Connection,
    pid: ProfileId,
    now: i64,
    tz: &TimeZone,
) -> Result<(), Error> {
    let tx = write(conn)?;
    tx.execute("DELETE FROM device_day WHERE profile_id = ?", [pid])?;
    tx.execute(
        "DELETE FROM health_record WHERE profile_id = ? AND source = ?",
        params![pid, HEALTH_CONNECT],
    )?;
    tx.execute("DELETE FROM device_session WHERE profile_id = ?", [pid])?;
    tx.execute(
        "DELETE FROM activity WHERE profile_id = ? AND source = ?",
        params![pid, ActivitySource::HealthConnect],
    )?;
    tx.execute(
        "DELETE FROM nap WHERE profile_id = ? AND source = ?",
        params![pid, NapSource::HealthConnect],
    )?;
    tx.execute(
        "DELETE FROM sleep_stage WHERE profile_id = ? AND source = ?",
        params![pid, StageSource::HealthConnect],
    )?;
    health_readings_delete(&tx, pid, now, tz)?;
    tx.execute(
        "DELETE FROM sync_state WHERE profile_id = ? AND source = ?",
        params![pid, HEALTH_CONNECT],
    )?;
    tx.commit()?;
    Ok(())
}

/// A day from [`DAY_COLUMNS`].
fn day_row(r: &Row) -> rusqlite::Result<DeviceDay> {
    Ok(DeviceDay {
        day: r.get(0)?,
        active_kcal: r.get(1)?,
        total_kcal: r.get(2)?,
        steps: r.get(3)?,
        resting_hr: r.get(4)?,
        hrv_ms: r.get(5)?,
        avg_hr: r.get(6)?,
        min_hr: r.get(7)?,
        max_hr: r.get(8)?,
        bmr_kcal: r.get(9)?,
        bmr_origin: r.get(10)?,
        distance_m: r.get(11)?,
        in_bed_min: r.get(12)?,
        asleep_min: r.get(13)?,
        bedtime: r.get(14)?,
        wake_time: r.get(15)?,
        deep_min: r.get(16)?,
        rem_min: r.get(17)?,
        light_min: r.get(18)?,
        sleep_avg_hr: r.get(19)?,
    })
}

/// Remove the profile's Google Health import, in one transaction: its
/// days, naps and stage spans, the workouts it added (no tombstones: an
/// import again brings them back) and its raw rows. The device's data and
/// hand logs stay; a hand log that claimed an imported workout lets go of
/// its key and the energy it took from it, and the key is tombstoned (an
/// import again leaves that hand log alone).
pub fn google_import_delete(conn: &mut Connection, pid: ProfileId) -> Result<(), Error> {
    let tx = write(conn)?;
    tx.execute("DELETE FROM import_day WHERE profile_id = ?", [pid])?;
    tx.execute(
        "DELETE FROM nap WHERE profile_id = ? AND source = ?",
        params![pid, NapSource::Import],
    )?;
    tx.execute(
        "DELETE FROM sleep_stage WHERE profile_id = ? AND source = ?",
        params![pid, StageSource::Import],
    )?;
    tx.execute(
        "DELETE FROM activity WHERE profile_id = ? AND source = ?",
        params![pid, ActivitySource::Import],
    )?;
    let claimed =
        format!("profile_id = ?1 AND source = ?2 AND source_key LIKE '{IMPORT_KEY_PREFIX}%'");
    tx.execute(
        &format!(
            "INSERT OR IGNORE INTO workout_tombstone (profile_id, source_key)
             SELECT profile_id, source_key FROM activity WHERE {claimed}"
        ),
        params![pid, ActivitySource::Hand],
    )?;
    tx.execute(
        &format!(
            "UPDATE activity SET source_key = NULL,
                 kcal = CASE WHEN kcal_source IS 'import' THEN NULL ELSE kcal END,
                 kcal_source = CASE WHEN kcal_source IS 'import' THEN NULL ELSE kcal_source END,
                 rev = rev + 1
             WHERE {claimed}"
        ),
        params![pid, ActivitySource::Hand],
    )?;
    tx.execute(
        "DELETE FROM health_record WHERE profile_id = ? AND source = ?",
        params![pid, GOOGLE_HEALTH],
    )?;
    tx.commit()?;
    Ok(())
}
