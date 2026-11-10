//! What the server makes of the phone's raw records (ADR 0032), its
//! only author: Health Connect's nights, naps, stage spans and overnight
//! HRV from the sleep sessions and readings kept; each day's resting energy
//! from its basal metabolic rates, and its distance from its distance
//! records. Made where raw data lands (a window, a
//! records page) and once per rule version at start ([`super::DERIVED`]).

use super::device::{
    DAY_VALUE_COLS, NIGHT_COLS, device_insert, health_status, naps_insert, stages_put,
};
use super::device_sessions::{promote, refresh_synced};
use super::health_record::{
    BMR, DISTANCE, HRV, RawBmr, SLEEP_SESSION, bmr_list, distance_list, hrv_list, raw_days,
    raw_latest, raw_list, raw_profiles, raw_prune, record_put,
};
use super::prelude::*;
use super::scale::health_readings_replace;
use jiff::Timestamp;
use jiff::civil::Date;

use crate::model::{
    DeviceDay, HEALTH_CONNECT, HealthCounts, HealthPost, HealthResult, NapIn, NapSource, RawCounts,
    RecordsPost, RecordsResult, SleepStage, StageSource, checked_stage, health_connect_sleeps,
    mean_rounded,
};

/// Bumped when the night rule (`model::sleep`) changes, so stored Health
/// Connect nights are made again from the raw sleep sessions (2: an
/// early-night block joins its night; 3: the server makes them, their HRV
/// and heart rate with them, the phone no longer; 4: every early-night
/// block before a night joins it, not only the last).
pub(super) const NIGHT_RULE_VERSION: i64 = 4;

/// Bumped when how resting energy is derived changes (1: Health Connect's
/// basal metabolic rate, one origin a profile).
pub(super) const RESTING_RULE_VERSION: i64 = 1;

/// Bumped when how a day's distance is derived changes (1: Health
/// Connect's distance records, one origin a profile).
pub(super) const DISTANCE_RULE_VERSION: i64 = 1;

/// How far an origin's days count when choosing one: the 90 days up to the
/// profile's latest basal metabolic rate.
const ORIGIN_DAYS: i64 = 90;

/// `day` moved by `days`, `None` when it doesn't read.
pub(super) fn shift(day: &str, days: i64) -> Option<String> {
    let d: Date = day.parse().ok()?;
    Some(
        d.checked_add(jiff::Span::new().days(days))
            .ok()?
            .to_string(),
    )
}

/// Every day from `from` to `to`, both included.
pub(super) fn days_between(from: &str, to: &str) -> BTreeSet<String> {
    let (Ok(mut d), Ok(to)) = (from.parse::<Date>(), to.parse::<Date>()) else {
        return BTreeSet::new();
    };
    let mut out = BTreeSet::new();
    while d <= to {
        out.insert(d.to_string());
        let Ok(next) = d.tomorrow() else { break };
        d = next;
    }
    out
}

/// `pid`'s Health Connect nights, naps, stage spans, overnight HRV and night
/// heart rate on `days`, made again from the raw sleep sessions and HRV
/// readings kept, by the night rule (the server is their only
/// author). A night's HRV is the mean of the readings inside it; its heart
/// rate the sessions' (the phone measures each), else the one stored (an
/// older phone sent it with the day). A day of `days` without a night has
/// none. How many nights.
pub(super) fn nights_derive(
    tx: &Connection,
    pid: ProfileId,
    days: &BTreeSet<String>,
    tz: &TimeZone,
) -> Result<usize, Error> {
    let (Some(first), Some(last)) = (days.first(), days.last()) else {
        return Ok(0);
    };
    // Sessions a block may take in from the days around.
    let (from, to) = (shift(first, -2), shift(last, 1));
    let sessions = raw_list(tx, pid, SLEEP_SESSION, from.as_deref(), to.as_deref())?;
    let made = health_connect_sleeps(&sessions, tz);
    let readings: Vec<(Timestamp, i64)> = hrv_list(tx, pid, from.as_deref(), to.as_deref())?
        .into_iter()
        .filter_map(|(at, ms)| Some((at.parse().ok()?, ms)))
        .collect();
    let clear = NIGHT_COLS
        .iter()
        .chain(&["hrv_ms"])
        .map(|c| format!("{c} = NULL"))
        .collect::<Vec<_>>()
        .join(", ");
    let mut stored_hr: BTreeMap<&str, i64> = BTreeMap::new();
    for day in days {
        let at = params![pid, day];
        let hr: Option<i64> = tx
            .prepare_cached("SELECT sleep_avg_hr FROM device_day WHERE profile_id = ? AND day = ?")?
            .query_row(at, |r| r.get(0))
            .optional()?
            .flatten();
        stored_hr.extend(hr.map(|hr| (day.as_str(), hr)));
        tx.prepare_cached(&format!(
            "UPDATE device_day SET {clear} WHERE profile_id = ? AND day = ?"
        ))?
        .execute(at)?;
        tx.prepare_cached("DELETE FROM nap WHERE profile_id = ? AND day = ? AND source = ?")?
            .execute(params![pid, day, NapSource::HealthConnect])?;
        tx.prepare_cached(
            "DELETE FROM sleep_stage WHERE profile_id = ? AND day = ? AND source = ?",
        )?
        .execute(params![pid, day, StageSource::HealthConnect])?;
    }
    let mut put = tx.prepare_cached(
        "INSERT INTO device_day (profile_id, day, in_bed_min, asleep_min, bedtime, wake_time,
             deep_min, rem_min, light_min, sleep_avg_hr, hrv_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
         ON CONFLICT (profile_id, day) DO UPDATE SET in_bed_min = ?3, asleep_min = ?4,
             bedtime = ?5, wake_time = ?6, deep_min = ?7, rem_min = ?8, light_min = ?9,
             sleep_avg_hr = ?10, hrv_ms = ?11",
    )?;
    let mut nights = 0;
    for (night, (start, end)) in made.nights {
        if !days.contains(&night.day) {
            continue;
        }
        // Thousandths of a millisecond, then the mean in whole ones.
        let (sum, n) = readings
            .iter()
            .filter(|(at, _)| (start..=end).contains(at))
            .fold((0, 0), |(sum, n), r| (sum + r.1, n + 1));
        let hrv = mean_rounded(sum, n).map(|ms| mean_rounded(ms, 1000).unwrap_or(0));
        let hr = night
            .sleep_avg_hr
            .or_else(|| stored_hr.get(night.day.as_str()).copied());
        let (d, _) = DeviceDay {
            hrv_ms: hrv,
            sleep_avg_hr: hr,
            ..night
        }
        .trimmed();
        if d.in_bed_min.is_none() {
            continue;
        }
        put.execute(params![
            pid,
            d.day,
            d.in_bed_min,
            d.asleep_min,
            d.bedtime,
            d.wake_time,
            d.deep_min,
            d.rem_min,
            d.light_min,
            d.sleep_avg_hr,
            d.hrv_ms
        ])?;
        nights += 1;
    }
    empty_days_delete(tx, pid, days)?;
    let naps: Vec<NapIn> = made
        .naps
        .into_iter()
        .filter(|n| days.contains(&n.day))
        .collect();
    naps_insert(tx, pid, NapSource::HealthConnect, &naps)?;
    let stages: Vec<SleepStage> = made
        .stages
        .into_iter()
        .filter(|s| days.contains(&s.day))
        .filter_map(checked_stage)
        .collect();
    stages_put(tx, pid, &stages)?;
    Ok(nights)
}

/// Remove `pid`'s device day rows on `days` left with nothing in them.
fn empty_days_delete(
    tx: &Connection,
    pid: ProfileId,
    days: &BTreeSet<String>,
) -> Result<(), Error> {
    let empty = DAY_VALUE_COLS
        .iter()
        .chain(NIGHT_COLS)
        .map(|c| format!("{c} IS NULL"))
        .collect::<Vec<_>>()
        .join(" AND ");
    let mut delete = tx.prepare_cached(&format!(
        "DELETE FROM device_day WHERE profile_id = ? AND day = ? AND {empty}"
    ))?;
    for day in days {
        delete.execute(params![pid, day])?;
    }
    Ok(())
}

/// A basal metabolic rate that may stand for a day's resting energy: in
/// bounds, from a named app ([`DeviceDay::trimmed`]'s check).
fn plausible(b: &RawBmr) -> bool {
    let day = DeviceDay {
        bmr_kcal: Some(b.kcal),
        bmr_origin: Some(b.origin.clone()),
        ..DeviceDay::default()
    };
    !day.trimmed().1
}

/// The days deriving `days` of `kind` reads, from: their first, or the
/// [`ORIGIN_DAYS`] up to `pid`'s latest record that [`origin_of`] weighs
/// when earlier. `list` reads every day instead when the latest record
/// isn't one it keeps (the origin's days then start earlier still).
fn reached<T>(
    tx: &Connection,
    pid: ProfileId,
    kind: &str,
    days: &BTreeSet<String>,
    list: impl Fn(Option<&str>) -> Result<Vec<T>, Error>,
    day: impl Fn(&T) -> &str,
) -> Result<Vec<T>, Error> {
    let latest = raw_latest(tx, pid, kind)?;
    let since = latest.as_deref().and_then(|l| shift(l, 1 - ORIGIN_DAYS));
    let (Some(first), Some(latest), Some(since)) = (days.first(), latest, since) else {
        return list(None);
    };
    let some = list(Some(first.min(&since)))?;
    if some.iter().map(&day).max() == Some(latest.as_str()) {
        Ok(some)
    } else {
        list(None)
    }
}

/// The one app a profile's values of a kind come from, of its `(day,
/// origin)` records: the one with the most days of one in the
/// [`ORIGIN_DAYS`] up to the latest, the latest to write one on a tie.
fn origin_of<'a>(all: &[(&'a str, &'a str)]) -> Option<&'a str> {
    let latest = all.iter().map(|b| b.0).max()?;
    let since = shift(latest, 1 - ORIGIN_DAYS)?;
    // Per origin: its days, and its latest.
    let mut origins: BTreeMap<&str, (BTreeSet<&str>, &str)> = BTreeMap::new();
    for &(day, origin) in all.iter().filter(|b| b.0 >= since.as_str()) {
        let o = origins.entry(origin).or_default();
        o.0.insert(day);
        o.1 = o.1.max(day);
    }
    origins
        .into_iter()
        .max_by_key(|(_, (days, last))| (days.len(), *last))
        .map(|(origin, _)| origin)
}

/// Each of `days`' resting energy: the basal metabolic rate Health Connect had
/// that day from `pid`'s one origin ([`origin_of`]; another app's never shows,
/// so a day never switches vendor), the day's latest. A day of `days` without
/// one has none. How many days have one.
pub(super) fn resting_derive(
    tx: &Connection,
    pid: ProfileId,
    days: &BTreeSet<String>,
) -> Result<usize, Error> {
    if days.is_empty() {
        return Ok(0);
    }
    let usable = |from: Option<&str>| -> Result<Vec<RawBmr>, Error> {
        Ok(bmr_list(tx, pid, from)?
            .into_iter()
            .filter(plausible)
            .collect())
    };
    let all = reached(tx, pid, BMR, days, usable, |b| &b.day)?;
    let pairs: Vec<(&str, &str)> = all
        .iter()
        .map(|b| (b.day.as_str(), b.origin.as_str()))
        .collect();
    let origin = origin_of(&pairs);
    // By day and time: the day's latest is the last.
    let own: BTreeMap<&str, (f64, &str)> = all
        .iter()
        .filter(|b| Some(b.origin.as_str()) == origin && days.contains(&b.day))
        .map(|b| (b.day.as_str(), (b.kcal, b.origin.as_str())))
        .collect();
    let mut clear = tx.prepare_cached(
        "UPDATE device_day SET bmr_kcal = NULL, bmr_origin = NULL
         WHERE profile_id = ? AND day = ?",
    )?;
    for day in days {
        clear.execute(params![pid, day])?;
    }
    let mut put = tx.prepare_cached(
        "INSERT INTO device_day (profile_id, day, bmr_kcal, bmr_origin) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (profile_id, day) DO UPDATE SET bmr_kcal = ?3, bmr_origin = ?4",
    )?;
    for (day, (kcal, origin)) in &own {
        put.execute(params![pid, day, kcal, origin])?;
    }
    empty_days_delete(tx, pid, days)?;
    Ok(own.len())
}

/// Each of `days`' distance: the sum of the distance records Health Connect
/// had that day from `pid`'s one origin ([`origin_of`]: two apps
/// both writing never add up), in whole metres. A day of `days` without
/// one has none. How many days have one. A record deleted on the phone
/// stays counted: the window lists the ids of `DERIVED_FROM` kinds only.
pub(super) fn distance_derive(
    tx: &Connection,
    pid: ProfileId,
    days: &BTreeSet<String>,
) -> Result<usize, Error> {
    if days.is_empty() {
        return Ok(0);
    }
    let all = reached(
        tx,
        pid,
        DISTANCE,
        days,
        |from| distance_list(tx, pid, from),
        |(day, _, _)| day,
    )?;
    let pairs: Vec<(&str, &str)> = all
        .iter()
        .map(|(day, origin, _)| (day.as_str(), origin.as_str()))
        .collect();
    let origin = origin_of(&pairs);
    let mut clear = tx.prepare_cached(
        "UPDATE device_day SET distance_m = NULL WHERE profile_id = ? AND day = ?",
    )?;
    for day in days {
        clear.execute(params![pid, day])?;
    }
    let mut put = tx.prepare_cached(
        "INSERT INTO device_day (profile_id, day, distance_m) VALUES (?1, ?2, ?3)
         ON CONFLICT (profile_id, day) DO UPDATE SET distance_m = ?3",
    )?;
    let mut made = 0;
    let own = all
        .iter()
        .filter(|(day, o, _)| Some(o.as_str()) == origin && days.contains(day));
    for (day, _, meters) in own {
        let (d, _) = DeviceDay {
            distance_m: Some(*meters),
            ..DeviceDay::default()
        }
        .trimmed();
        if let Some(m) = d.distance_m {
            put.execute(params![pid, day, m])?;
            made += 1;
        }
    }
    empty_days_delete(tx, pid, days)?;
    Ok(made)
}

/// `DERIVED`'s nights: every profile's, on each day a raw sleep session
/// woke on (nights kept before a rule change keep the old split
/// otherwise); a day without raw sessions is left as it is. How many
/// nights.
pub(super) fn nights_refresh(tx: &Transaction, tz: &TimeZone) -> Result<usize, Error> {
    let mut nights = 0;
    for pid in raw_profiles(tx, SLEEP_SESSION)? {
        let sessions = raw_list(tx, pid, SLEEP_SESSION, None, None)?;
        let days = health_connect_sleeps(&sessions, tz).days;
        nights += nights_derive(tx, pid, &days, tz)?;
    }
    Ok(nights)
}

/// `DERIVED`'s resting energy: every profile's, on each day a basal
/// metabolic rate was kept (raw history synced before the server derived
/// it). How many days have one.
pub(super) fn resting_refresh(tx: &Transaction) -> Result<usize, Error> {
    let mut days = 0;
    for pid in raw_profiles(tx, BMR)? {
        days += resting_derive(tx, pid, &raw_days(tx, pid, BMR)?)?;
    }
    Ok(days)
}

/// `DERIVED`'s distance: every profile's, on each day a distance record was
/// kept (raw history synced before the server derived it). How many days
/// have one.
pub(super) fn distance_refresh(tx: &Transaction) -> Result<usize, Error> {
    let mut days = 0;
    for pid in raw_profiles(tx, DISTANCE)? {
        days += distance_derive(tx, pid, &raw_days(tx, pid, DISTANCE)?)?;
    }
    Ok(days)
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

/// Keep a page of the phone's records, in one transaction. What the server
/// makes of its new or changed ones follows in it: the nights of the days
/// its sleep sessions woke on and the day before each, and of the nights
/// its HRV readings may fall in; the resting energy of the days its basal
/// metabolic rates name (an older phone posts its window before its
/// pages). Its outcome adds to the sync's records outcome
/// (`sync_state.records_result`: its pages, the first after a window
/// starting it over), and is logged.
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
