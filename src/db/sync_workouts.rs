//! Device sessions (any type) as activities. `device_session` is the device's
//! raw copy; a **candidate** is a raw row no session holds, not tombstoned
//! (by key, or by type and a start within a minute), at least a minute
//! long, and not a second copy of a session that already holds a key. Each
//! candidate, oldest first, is claimed by a matching hand log, or promoted
//! into a `health_connect` session (auto mode, not auto-recorded), or waits
//! as pending.

use std::collections::btree_map;

use jiff::Timestamp;

use super::prelude::*;
use super::{ACTIVITY_COLS, activity_get, activity_row};
use crate::model::{
    AUTO_RECORDED, ActivitySource, ActivityType, DeviceSession, ExportedTombstone,
    IMPORT_KEY_PREFIX, ImportedWorkout, KcalSource, PendingActivity, Span, SyncedWorkouts,
    activity_minutes, hc_type, matches,
};

/// A tombstone's start may differ this much from a re-id'd copy's.
const REID_SECONDS: i64 = 60;
/// Raw workouts shorter than this are never sessions.
const SHORTEST_SECONDS: i64 = 60;

/// A raw device workout with its times read.
struct Raw {
    a: DeviceSession,
    kind: ActivityType,
    start: Timestamp,
    end: Timestamp,
}

impl Raw {
    fn span(&self) -> Span<'_> {
        Span {
            day: &self.a.day,
            kind: self.kind,
            any_type: false,
            start: Some(self.start),
            end: Some(self.end),
        }
    }

    fn seconds(&self) -> i64 {
        self.end.as_second() - self.start.as_second()
    }

    fn minutes(&self) -> u32 {
        activity_minutes(self.seconds())
    }

    /// Its energy: the device's active, else its total over the span (a
    /// device that writes total energy only), as [`Self::kcal_source`] says.
    fn kcal(&self) -> Option<u32> {
        self.a
            .kcal
            .or(self.a.total_kcal)
            .and_then(|k| u32::try_from(k).ok())
    }

    /// Whose energy [`Self::kcal`] is; `None` without any.
    fn kcal_source(&self) -> Option<KcalSource> {
        self.kcal().map(|_| {
            if self.a.kcal.is_some() {
                KcalSource::HealthConnect
            } else {
                KcalSource::HealthConnectTotal
            }
        })
    }

    /// Its distance, when its type takes one.
    fn distance(&self) -> Option<u32> {
        self.a
            .distance_m
            .and_then(|d| u32::try_from(d).ok())
            .filter(|_| self.kind.distance())
    }

    fn measured(&self) -> Taken<'_> {
        let bpm = |b: Option<i64>| b.and_then(|b| u32::try_from(b).ok());
        Taken {
            key: &self.a.key,
            kind: self.kind,
            start_at: Some(&self.a.start_at),
            kcal: self.kcal(),
            distance: self.distance(),
            avg_hr: bpm(self.a.avg_hr),
            max_hr: bpm(self.a.max_hr),
            source: self.kcal_source().unwrap_or(KcalSource::HealthConnect),
        }
    }
}

/// What a claim may take from a device or imported workout.
struct Taken<'a> {
    key: &'a str,
    kind: ActivityType,
    start_at: Option<&'a str>,
    kcal: Option<u32>,
    distance: Option<u32>,
    avg_hr: Option<u32>,
    max_hr: Option<u32>,
    /// Whose energy `kcal` is.
    source: KcalSource,
}

impl ImportedWorkout {
    fn measured(&self) -> Taken<'_> {
        Taken {
            key: &self.key,
            kind: self.kind,
            start_at: Some(&self.start_at),
            kcal: self.kcal,
            distance: self.distance_m,
            avg_hr: None,
            max_hr: None,
            source: KcalSource::Import,
        }
    }
}

/// An imported session's measurements (what a hand log claiming it takes).
fn imported(s: &Activity) -> Taken<'_> {
    Taken {
        key: s.source_key.as_deref().unwrap_or_default(),
        kind: s.kind,
        start_at: s.start_at.as_deref(),
        kcal: s.kcal,
        distance: s.distance_m,
        avg_hr: s.avg_hr,
        max_hr: s.max_hr,
        source: s.kcal_source.unwrap_or(KcalSource::Import),
    }
}

/// Whether `s` holds an imported workout's key: the import's own session,
/// or a hand log that claimed one.
fn is_imported(s: &Activity) -> bool {
    s.source_key
        .as_deref()
        .is_some_and(|k| k.starts_with(IMPORT_KEY_PREFIX))
}

const RAW_COLS: &str = "r.source_key, r.day, r.start_at, r.end_at, r.type, r.name, r.kcal, \
                        r.distance_m, r.recording_method, r.avg_hr, r.max_hr, r.total_kcal";

/// A raw row from [`RAW_COLS`] at column `at` on; one whose times don't read is
/// never a candidate (the sync checked them).
fn raw_at(r: &Row, at: usize) -> rusqlite::Result<Option<Raw>> {
    let a = DeviceSession {
        key: r.get(at)?,
        day: r.get(at + 1)?,
        start_at: r.get(at + 2)?,
        end_at: r.get(at + 3)?,
        kind: r.get(at + 4)?,
        name: r.get(at + 5)?,
        kcal: r.get(at + 6)?,
        distance_m: r.get(at + 7)?,
        recording_method: r.get(at + 8)?,
        avg_hr: r.get(at + 9)?,
        max_hr: r.get(at + 10)?,
        total_kcal: r.get(at + 11)?,
    };
    let (Ok(start), Ok(end)) = (a.start_at.parse(), a.end_at.parse()) else {
        return Ok(None);
    };
    Ok(Some(Raw {
        kind: hc_type(a.kind),
        a,
        start,
        end,
    }))
}

/// Raw rows of `pid` (on `day`, or all) whose key no session holds and no
/// tombstone names, oldest first.
fn unheld(conn: &Connection, pid: ProfileId, day: Option<&str>) -> Result<Vec<Raw>, Error> {
    let rows = conn
        .prepare_cached(&format!(
            "SELECT {RAW_COLS} FROM device_session r
             WHERE r.profile_id = ?1
               AND r.day >= coalesce(?2, '') AND r.day <= coalesce(?2, '9999-12-31')
               AND NOT EXISTS (SELECT 1 FROM activity s
                               WHERE s.profile_id = ?1 AND s.source_key = r.source_key)
               AND NOT EXISTS (SELECT 1 FROM workout_tombstone t
                               WHERE t.profile_id = ?1 AND t.source_key = r.source_key)
             ORDER BY r.start_at, r.source_key"
        ))?
        .query_map(params![pid, day], |r| raw_at(r, 0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows.into_iter().flatten().collect())
}

/// The profile's tombstones that have a type and start: a re-id'd copy of
/// one of them stays deleted.
struct Buried(Vec<(ActivityType, Timestamp)>);

impl Buried {
    fn load(conn: &Connection, pid: ProfileId) -> Result<Self, Error> {
        let rows = conn
            .prepare_cached(
                "SELECT type, start_at FROM workout_tombstone
                 WHERE profile_id = ? AND type IS NOT NULL AND start_at IS NOT NULL",
            )?
            .query_map([pid], |r| {
                Ok((r.get::<_, ActivityType>(0)?, r.get::<_, String>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(Self(
            rows.into_iter()
                .filter_map(|(k, at)| Some((k, at.parse().ok()?)))
                .collect(),
        ))
    }

    fn covers(&self, w: &Raw) -> bool {
        self.near(w.kind, w.start)
    }

    /// A tombstone of a type compatible with `kind` either way (an import's
    /// workout, the device's HIIT) starting within a minute of `start`.
    fn near(&self, kind: ActivityType, start: Timestamp) -> bool {
        self.0.iter().any(|(k, at)| {
            (ActivityType::compatible(*k, kind) || ActivityType::compatible(kind, *k))
                && (at.as_second() - start.as_second()).abs() <= REID_SECONDS
        })
    }
}

/// Whether device session `s` is the same workout as one of `kind` starting
/// at `start` for `minutes`, its clock slipped whole hours (a local time
/// written as UTC, as Health Connect copies of some Google Health walks
/// are): the same type and length, starting 1–14 h apart to the minute.
fn slipped(s: &Activity, kind: ActivityType, start: Timestamp, minutes: u32) -> bool {
    let Some(at) = s
        .start_at
        .as_deref()
        .and_then(|a| a.parse::<Timestamp>().ok())
    else {
        return false;
    };
    let apart = (at.as_second() - start.as_second()).abs();
    let off_hour = (apart + REID_SECONDS).rem_euclid(3600);
    s.source == ActivitySource::HealthConnect
        && s.kind == kind
        && s.minutes.abs_diff(minutes) <= 1
        && (3600 - REID_SECONDS..=14 * 3600 + REID_SECONDS).contains(&apart)
        && off_hour <= 2 * REID_SECONDS
}

/// Workouts from an export, oldest first, each added as an `import` session
/// holding its key, unless already there: its key held or tombstoned, a
/// tombstone of its type starting within a minute, or any session that day it
/// [`matches`] (whatever the type: one person, one workout at a time) or that
/// is its [`slipped`] copy. Added, kept.
pub(super) fn import_workouts(
    tx: &Connection,
    pid: ProfileId,
    workouts: &[ImportedWorkout],
) -> Result<(u64, u64), Error> {
    let buried = Buried::load(tx, pid)?;
    let (mut added, mut kept) = (0, 0);
    for w in workouts {
        let (Ok(start), Ok(end)) = (w.start_at.parse::<Timestamp>(), w.end_at.parse()) else {
            continue;
        };
        let span = Span {
            day: &w.day,
            kind: w.kind,
            any_type: true,
            start: Some(start),
            end: Some(end),
        };
        let that_day: Vec<Activity> = tx
            .prepare_cached(&format!(
                "SELECT {ACTIVITY_COLS} FROM activity WHERE profile_id = ? AND day = ?"
            ))?
            .query_map(params![pid, w.day], activity_row)?
            .collect::<rusqlite::Result<_>>()?;
        let minutes = activity_minutes(end.as_second() - start.as_second());
        if holder(tx, pid, &w.key)?.is_none()
            && !tombstoned(tx, pid, &w.key)?
            && let Some(log) = untimed_log(tx, pid, &w.day, w.kind)?
            && sole_candidate(tx, pid, &w.day, log.kind, &buried)?.is_none()
        {
            // The day's only workout of its kind, logged without a time.
            claim(tx, log.id, &w.measured())?;
            kept += 1;
            continue;
        }
        if holder(tx, pid, &w.key)?.is_some()
            || tombstoned(tx, pid, &w.key)?
            || buried.near(w.kind, start)
            || that_day
                .iter()
                .any(|s| matches(&span, &s.span()) || slipped(s, w.kind, start, minutes))
        {
            kept += 1;
            continue;
        }
        tx.execute(
            "INSERT INTO activity (profile_id, day, name, minutes, kcal, type,
                 distance_m, start_at, source, source_key, kcal_source)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                pid,
                w.day,
                w.name,
                minutes,
                w.kcal,
                w.kind,
                w.distance_m.filter(|_| w.kind.distance()),
                w.start_at,
                ActivitySource::Import,
                w.key,
                w.kcal.map(|_| KcalSource::Import)
            ],
        )?;
        added += 1;
    }
    Ok((added, kept))
}

/// Sessions holding a key, per day, read once per day: what a second
/// app's copy of the same workout would duplicate.
#[derive(Default)]
struct Held(BTreeMap<String, Vec<Activity>>);

impl Held {
    fn day(
        &mut self,
        conn: &Connection,
        pid: ProfileId,
        day: &str,
    ) -> Result<&mut Vec<Activity>, Error> {
        Ok(match self.0.entry(day.to_owned()) {
            btree_map::Entry::Occupied(e) => e.into_mut(),
            btree_map::Entry::Vacant(v) => v.insert(
                conn.prepare_cached(&format!(
                    "SELECT {ACTIVITY_COLS} FROM activity
                     WHERE profile_id = ? AND day = ? AND source_key IS NOT NULL"
                ))?
                .query_map(params![pid, day], activity_row)?
                .collect::<rusqlite::Result<_>>()?,
            ),
        })
    }

    /// The session holding a key that `w` is a copy of, if any
    /// ([`copies`]).
    fn covering(
        &mut self,
        conn: &Connection,
        pid: ProfileId,
        w: &Raw,
    ) -> Result<Option<Activity>, Error> {
        Ok(self
            .day(conn, pid, &w.a.day)?
            .iter()
            .find(|s| copies(&s.span(), &w.span()))
            .cloned())
    }

    fn add(&mut self, conn: &Connection, pid: ProfileId, id: i64) -> Result<(), Error> {
        let s = written(activity_get(conn, pid, id)?);
        self.day(conn, pid, &s.day.clone())?.push(s);
        Ok(())
    }
}

/// Whether two sessions are copies of one workout: [`matches`] either way
/// round (an `other` held and a `workout` copy are one, as are a `workout`
/// held and an `other` copy: two apps wrote it).
fn copies(a: &Span, b: &Span) -> bool {
    matches(a, b) || matches(b, a)
}

/// Remove sessions that are copies ([`copies`]) of another on their day,
/// of `pid` (every profile when `None`): stored before copies were compared
/// both ways. Only sessions a sync or an import made and nothing
/// typed changed (no sets, no workout, energy not the hand's) go; of each
/// set of copies the one saying most stays (a type other than `other`, then
/// more measurements, then the oldest). Their raw rows stay: a sync finds
/// the kept one covering them. How many went.
pub(crate) fn copies_collapse(tx: &Connection, pid: Option<ProfileId>) -> Result<usize, Error> {
    let pids: Vec<ProfileId> = tx
        .prepare("SELECT id FROM profile WHERE ?1 IS NULL OR id = ?1")?
        .query_map([pid], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    let mut gone = 0;
    for pid in pids {
        let all: Vec<Activity> = tx
            .prepare(&format!(
                "SELECT {ACTIVITY_COLS} FROM activity
                 WHERE profile_id = ? AND source != 'hand' AND source_key IS NOT NULL
                   AND workout_id IS NULL AND kcal_source IS NOT 'hand'
                   AND NOT EXISTS (SELECT 1 FROM activity_set WHERE activity_id = activity.id)
                 ORDER BY day, id"
            ))?
            .query_map([pid], activity_row)?
            .collect::<rusqlite::Result<_>>()?;
        let says = |s: &Activity| {
            (
                s.kind != ActivityType::Other,
                [s.kcal.is_some(), s.avg_hr.is_some(), s.max_hr.is_some()]
                    .iter()
                    .filter(|k| **k)
                    .count(),
                std::cmp::Reverse(s.id),
            )
        };
        let mut drop: BTreeSet<i64> = BTreeSet::new();
        for day in all.chunk_by(|a, b| a.day == b.day) {
            for (i, a) in day.iter().enumerate() {
                for b in &day[i + 1..] {
                    if drop.contains(&a.id) || drop.contains(&b.id) {
                        continue;
                    }
                    if copies(&a.span(), &b.span()) {
                        drop.insert(if says(a) >= says(b) { b.id } else { a.id });
                    }
                }
            }
        }
        for id in &drop {
            tx.execute("DELETE FROM activity WHERE id = ?", [id])?;
        }
        gone += drop.len();
    }
    Ok(gone)
}

/// Whether `w` may become a session: long enough, not a re-id'd deleted
/// one, not a copy of one held.
fn candidate(
    conn: &Connection,
    pid: ProfileId,
    w: &Raw,
    buried: &Buried,
    held: &mut Held,
) -> Result<bool, Error> {
    Ok(w.seconds() >= SHORTEST_SECONDS
        && !buried.covers(w)
        && held.covering(conn, pid, w)?.is_none())
}

/// The hand log `w` is (unkeyed, timed, matching; the best overlap wins).
fn hand_match(conn: &Connection, pid: ProfileId, w: &Raw) -> Result<Option<i64>, Error> {
    let logged: Vec<Activity> = conn
        .prepare_cached(&format!(
            "SELECT {ACTIVITY_COLS} FROM activity
             WHERE profile_id = ? AND day = ? AND source = 'hand'
               AND source_key IS NULL AND start_at IS NOT NULL"
        ))?
        .query_map(params![pid, w.a.day], activity_row)?
        .collect::<rusqlite::Result<_>>()?;
    Ok(logged
        .iter()
        .filter(|m| matches(&m.span(), &w.span()))
        .max_by_key(|m| (m.span().overlap(&w.span()), std::cmp::Reverse(m.id)))
        .map(|m| m.id))
}

/// Hand log `id` takes `w`'s key and fills only what it left empty (its
/// start; the typed minutes stay); a workout without sets takes the
/// device's type too, unless that says less ("other"). Only a type that
/// takes a distance takes one; energy filled is `w`'s.
fn claim(tx: &Connection, id: i64, w: &Taken) -> Result<(), Error> {
    let (kind, setless): (ActivityType, bool) = tx.query_row(
        "SELECT type, NOT EXISTS (SELECT 1 FROM activity_set WHERE activity_id = activity.id)
         FROM activity WHERE id = ?",
        [id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let kind = if kind == ActivityType::Workout && setless && w.kind != ActivityType::Other {
        w.kind
    } else {
        kind
    };
    tx.execute(
        "UPDATE activity SET source_key = ?1,
             start_at = coalesce(start_at, ?2),
             distance_m = CASE WHEN ?6 THEN coalesce(distance_m, ?3) END,
             kcal_source = CASE WHEN kcal IS NULL AND ?4 IS NOT NULL THEN ?8
                                ELSE kcal_source END,
             kcal = coalesce(kcal, ?4),
             avg_hr = coalesce(avg_hr, ?9),
             max_hr = coalesce(max_hr, ?10),
             type = ?5,
             rev = rev + 1
         WHERE id = ?7",
        params![
            w.key,
            w.start_at,
            w.distance,
            w.kcal,
            kind,
            kind.distance(),
            id,
            w.source,
            w.avg_hr,
            w.max_hr
        ],
    )?;
    Ok(())
}

/// Imported session `s` becomes the device's `w` (the device beats the
/// import): it takes `w`'s key, time and measurements; energy typed by hand
/// stays. It is the import's no more (removing the import keeps it), and
/// its import key is tombstoned: deleted, it stays deleted when the export
/// is imported again.
fn rekey(tx: &Connection, pid: ProfileId, s: &Activity, w: &Raw) -> Result<(), Error> {
    if let Some(key) = &s.source_key {
        tombstone(tx, pid, key, None, None)?;
    }
    let m = w.measured();
    tx.execute(
        "UPDATE activity SET source = 'hand', source_key = ?1, start_at = ?2,
             minutes = ?3,
             distance_m = CASE WHEN ?4 THEN coalesce(?5, distance_m) END,
             kcal = CASE WHEN kcal_source IS 'hand' THEN kcal ELSE coalesce(?6, kcal) END,
             kcal_source = CASE WHEN kcal_source IS 'hand' OR ?6 IS NULL THEN kcal_source
                                ELSE ?10 END,
             avg_hr = coalesce(?7, avg_hr),
             max_hr = coalesce(?8, max_hr),
             rev = rev + 1
         WHERE id = ?9",
        params![
            m.key,
            m.start_at,
            w.minutes(),
            s.kind.distance(),
            m.distance,
            m.kcal,
            m.avg_hr,
            m.max_hr,
            s.id,
            m.source
        ],
    )?;
    Ok(())
}

/// The day's one untimed hand log a workout of `kind` may be (unkeyed, no
/// start, a compatible type); `None` with none or several.
fn untimed_log(
    conn: &Connection,
    pid: ProfileId,
    day: &str,
    kind: ActivityType,
) -> Result<Option<Activity>, Error> {
    let logs: Vec<Activity> = conn
        .prepare_cached(&format!(
            "SELECT {ACTIVITY_COLS} FROM activity
             WHERE profile_id = ? AND day = ? AND source = 'hand'
               AND source_key IS NULL AND start_at IS NULL"
        ))?
        .query_map(params![pid, day], activity_row)?
        .filter(|s| {
            s.as_ref()
                .map_or(true, |s| ActivityType::compatible(s.kind, kind))
        })
        .collect::<rusqlite::Result<_>>()?;
    Ok(match <[Activity; 1]>::try_from(logs) {
        Ok([log]) => Some(log),
        Err(_) => None,
    })
}

/// A workout an untimed hand log may claim.
enum Candidate {
    /// A device workout, pending or held by its promoted session.
    Device { raw: Raw, holder: Option<i64> },
    /// An imported workout's session.
    Imported(Activity),
}

/// The day's one workout an untimed hand log of `kind` may be: the only device
/// workout (pending or promoted; a second app's copy counts once) or imported
/// session (one no hand log claimed) of a compatible type; `None` with none or
/// several.
fn sole_candidate(
    conn: &Connection,
    pid: ProfileId,
    day: &str,
    kind: ActivityType,
    buried: &Buried,
) -> Result<Option<Candidate>, Error> {
    let raws = conn
        .prepare_cached(&format!(
            "SELECT (SELECT h.id FROM activity h
                     WHERE h.profile_id = ?1 AND h.source_key = r.source_key), {RAW_COLS}
             FROM device_session r
             WHERE r.profile_id = ?1 AND r.day = ?2
               AND NOT EXISTS (SELECT 1 FROM workout_tombstone t
                               WHERE t.profile_id = ?1 AND t.source_key = r.source_key)
               AND NOT EXISTS (SELECT 1 FROM activity h WHERE h.profile_id = ?1
                               AND h.source_key = r.source_key AND h.source = 'hand')
             ORDER BY r.start_at, r.source_key"
        ))?
        .query_map(params![pid, day], |r| {
            Ok((r.get::<_, Option<i64>>(0)?, raw_at(r, 1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut found: Vec<Candidate> = Vec::new();
    let mut spans: Vec<Raw> = Vec::new();
    for (holder, raw) in raws {
        let Some(raw) = raw else { continue };
        if raw.seconds() < SHORTEST_SECONDS
            || buried.covers(&raw)
            || !ActivityType::compatible(kind, raw.kind)
            || spans.iter().any(|s| matches(&s.span(), &raw.span()))
        {
            continue;
        }
        spans.push(Raw {
            a: raw.a.clone(),
            ..raw
        });
        found.push(Candidate::Device { raw, holder });
    }
    let sessions: Vec<Activity> = conn
        .prepare_cached(&format!(
            "SELECT {ACTIVITY_COLS} FROM activity
             WHERE profile_id = ? AND day = ? AND source = 'import'"
        ))?
        .query_map(params![pid, day], activity_row)?
        .collect::<rusqlite::Result<_>>()?;
    for s in sessions {
        let span = Span {
            any_type: true,
            ..s.span()
        };
        if ActivityType::compatible(kind, s.kind)
            && !spans.iter().any(|w| matches(&span, &w.span()))
        {
            found.push(Candidate::Imported(s));
        }
    }
    Ok(match <[Candidate; 1]>::try_from(found) {
        Ok([c]) => Some(c),
        Err(_) => None,
    })
}

/// The untimed hand log device workout `w` is: the day's only one of its
/// kind, `w` its only workout.
fn untimed_match(
    conn: &Connection,
    pid: ProfileId,
    w: &Raw,
    buried: &Buried,
) -> Result<Option<i64>, Error> {
    let Some(log) = untimed_log(conn, pid, &w.a.day, w.kind)? else {
        return Ok(None);
    };
    Ok(
        match sole_candidate(conn, pid, &w.a.day, log.kind, buried)? {
            Some(Candidate::Device { raw, .. }) if raw.a.key == w.a.key => Some(log.id),
            _ => None,
        },
    )
}

/// `w` as a session of its own; its id.
fn insert(tx: &Connection, pid: ProfileId, w: &Raw) -> Result<i64, Error> {
    tx.execute(
        "INSERT INTO activity (profile_id, day, name, minutes, kcal, type,
             distance_m, start_at, source, source_key, kcal_source, avg_hr, max_hr)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        params![
            pid,
            w.a.day,
            w.a.name,
            w.minutes(),
            w.kcal(),
            w.kind,
            w.distance(),
            w.a.start_at,
            ActivitySource::HealthConnect,
            w.a.key,
            w.kcal_source(),
            w.a.avg_hr,
            w.a.max_hr
        ],
    )?;
    Ok(tx.last_insert_rowid())
}

/// Every candidate of the profile, oldest first: claimed by the hand log it
/// matches (timed, or the day's only untimed one of its kind; either mode:
/// that adds no workout), else in auto mode, unless the device detected it
/// by itself, promoted. A copy of an imported session re-keys it instead.
pub(super) fn promote(tx: &Connection, pid: ProfileId, mode: SyncedWorkouts) -> Result<(), Error> {
    let buried = Buried::load(tx, pid)?;
    let mut held = Held::default();
    for w in unheld(tx, pid, None)? {
        if w.seconds() < SHORTEST_SECONDS || buried.covers(&w) {
            continue;
        }
        if let Some(s) = held.covering(tx, pid, &w)? {
            if is_imported(&s) {
                rekey(tx, pid, &s, &w)?;
            }
            continue;
        }
        let id = if let Some(m) = hand_match(tx, pid, &w)? {
            claim(tx, m, &w.measured())?;
            m
        } else if let Some(m) = untimed_match(tx, pid, &w, &buried)? {
            claim(tx, m, &w.measured())?;
            m
        } else if mode == SyncedWorkouts::Auto && w.a.recording_method != AUTO_RECORDED {
            insert(tx, pid, &w)?
        } else {
            continue;
        };
        held.add(tx, pid, id)?;
    }
    copies_collapse(tx, Some(pid))?;
    Ok(())
}

/// The window's device sessions brought in line with the raw copy just
/// posted (`rev` moves when anything changed). With the same device as the
/// last POST, a key gone from the window goes too: its device session is
/// deleted, a hand log holding it lets it go (and can claim again). Rows
/// outside the window are never touched.
pub(super) fn refresh_synced(
    tx: &Connection,
    pid: ProfileId,
    from: &str,
    to: &str,
    same_device: bool,
) -> Result<(), Error> {
    let synced = tx
        .prepare_cached(&format!(
            "SELECT s.id, {RAW_COLS} FROM activity s
             JOIN device_session r ON r.profile_id = s.profile_id AND r.source_key = s.source_key
             WHERE s.profile_id = ?1 AND s.source = ?4 AND r.day BETWEEN ?2 AND ?3"
        ))?
        .query_map(params![pid, from, to, ActivitySource::HealthConnect], |r| {
            Ok((r.get::<_, i64>(0)?, raw_at(r, 1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut update = tx.prepare_cached(
        "UPDATE activity SET day = ?1, start_at = ?2, minutes = ?3, kcal = ?4,
             type = ?5, distance_m = ?6, avg_hr = ?8, max_hr = ?9,
             kcal_source = ?10, rev = rev + 1
         WHERE id = ?7 AND NOT (day IS ?1 AND start_at IS ?2 AND minutes IS ?3
             AND kcal IS ?4 AND type IS ?5 AND distance_m IS ?6 AND avg_hr IS ?8
             AND max_hr IS ?9 AND kcal_source IS ?10)",
    )?;
    for (id, w) in synced {
        let Some(w) = w else { continue };
        update.execute(params![
            w.a.day,
            w.a.start_at,
            w.minutes(),
            w.kcal(),
            w.kind,
            w.distance(),
            id,
            w.a.avg_hr,
            w.a.max_hr,
            w.kcal_source()
        ])?;
    }
    // A hand log holding a device workout: energy no hand typed and the
    // heart rate follow the device.
    let claimed = tx
        .prepare_cached(&format!(
            "SELECT s.id, {RAW_COLS} FROM activity s
             JOIN device_session r ON r.profile_id = s.profile_id AND r.source_key = s.source_key
             WHERE s.profile_id = ?1 AND s.source = 'hand' AND r.day BETWEEN ?2 AND ?3"
        ))?
        .query_map(params![pid, from, to], |r| {
            Ok((r.get::<_, i64>(0)?, raw_at(r, 1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut follow = tx.prepare_cached(
        "UPDATE activity SET
             kcal = CASE WHEN kcal_source IS 'hand' OR ?1 IS NULL THEN kcal ELSE ?1 END,
             kcal_source = CASE WHEN kcal_source IS 'hand' OR ?1 IS NULL THEN kcal_source
                                ELSE ?5 END,
             avg_hr = coalesce(?2, avg_hr), max_hr = coalesce(?3, max_hr), rev = rev + 1
         WHERE id = ?4 AND (
             (kcal_source IS NOT 'hand' AND ?1 IS NOT NULL
                 AND (kcal IS NOT ?1 OR kcal_source IS NOT ?5))
             OR (?2 IS NOT NULL AND avg_hr IS NOT ?2) OR (?3 IS NOT NULL AND max_hr IS NOT ?3))",
    )?;
    for (id, w) in claimed {
        let Some(w) = w else { continue };
        follow.execute(params![
            w.kcal(),
            w.a.avg_hr,
            w.a.max_hr,
            id,
            w.kcal_source()
        ])?;
    }
    if same_device {
        let gone = "NOT EXISTS (SELECT 1 FROM device_session r
                        WHERE r.profile_id = ?1 AND r.source_key = activity.source_key)";
        tx.execute(
            &format!(
                "DELETE FROM activity WHERE profile_id = ?1 AND source = ?4
                 AND day BETWEEN ?2 AND ?3 AND {gone}"
            ),
            params![pid, from, to, ActivitySource::HealthConnect],
        )?;
        // An imported workout's key was never the device's: it stays.
        tx.execute(
            &format!(
                "UPDATE activity SET source_key = NULL, rev = rev + 1
                 WHERE profile_id = ?1 AND source = 'hand' AND source_key IS NOT NULL
                   AND source_key NOT LIKE '{IMPORT_KEY_PREFIX}%'
                   AND day BETWEEN ?2 AND ?3 AND {gone}"
            ),
            params![pid, from, to],
        )?;
    }
    Ok(())
}

/// After a hand log `s` was saved: unkeyed and timed, it claims the device
/// workout it matches, pending or already promoted (that session goes);
/// tombstoned keys excepted. Whether it did.
pub(super) fn claim_for(tx: &Connection, pid: ProfileId, s: &Activity) -> Result<bool, Error> {
    if s.source != ActivitySource::Hand || s.source_key.is_some() {
        return Ok(false);
    }
    if s.start_at.is_none() {
        return claim_untimed(tx, pid, s);
    }
    let rows = tx
        .prepare_cached(&format!(
            "SELECT (SELECT h.id FROM activity h
                     WHERE h.profile_id = ?1 AND h.source_key = r.source_key), {RAW_COLS}
             FROM device_session r
             WHERE r.profile_id = ?1 AND r.day = ?2
               AND NOT EXISTS (SELECT 1 FROM workout_tombstone t
                               WHERE t.profile_id = ?1 AND t.source_key = r.source_key)
               AND NOT EXISTS (SELECT 1 FROM activity h WHERE h.profile_id = ?1
                               AND h.source_key = r.source_key AND h.source = 'hand')
             ORDER BY r.start_at, r.source_key"
        ))?
        .query_map(params![pid, s.day], |r| {
            Ok((r.get::<_, Option<i64>>(0)?, raw_at(r, 1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let buried = Buried::load(tx, pid)?;
    let span = s.span();
    let best = rows
        .into_iter()
        .filter_map(|(holder, w)| Some((holder, w?)))
        .filter(|(_, w)| !buried.covers(w) && matches(&span, &w.span()))
        .max_by_key(|(_, w)| span.overlap(&w.span()));
    let Some((holder, w)) = best else {
        return Ok(false);
    };
    if let Some(h) = holder {
        tx.execute("DELETE FROM activity WHERE id = ?", [h])?;
    }
    claim(tx, s.id, &w.measured())?;
    Ok(true)
}

/// Untimed hand log `s` claims the day's only workout of its kind (a
/// device's, pending or promoted, or an imported one; that session goes),
/// when it is that workout's only untimed hand log. Whether it did.
fn claim_untimed(tx: &Connection, pid: ProfileId, s: &Activity) -> Result<bool, Error> {
    let buried = Buried::load(tx, pid)?;
    let Some(c) = sole_candidate(tx, pid, &s.day, s.kind, &buried)? else {
        return Ok(false);
    };
    let kind = match &c {
        Candidate::Device { raw, .. } => raw.kind,
        Candidate::Imported(i) => i.kind,
    };
    if untimed_log(tx, pid, &s.day, kind)?.is_none_or(|log| log.id != s.id) {
        return Ok(false);
    }
    match c {
        Candidate::Device { raw, holder } => {
            if let Some(h) = holder {
                tx.execute("DELETE FROM activity WHERE id = ?", [h])?;
            }
            claim(tx, s.id, &raw.measured())?;
        }
        Candidate::Imported(i) => {
            tx.execute("DELETE FROM activity WHERE id = ?", [i.id])?;
            claim(tx, s.id, &imported(&i))?;
        }
    }
    Ok(true)
}

/// The id of the session holding `key`, if one does.
fn holder(conn: &Connection, pid: ProfileId, key: &str) -> Result<Option<i64>, Error> {
    Ok(conn
        .query_row(
            "SELECT id FROM activity WHERE profile_id = ? AND source_key = ?",
            params![pid, key],
            |r| r.get(0),
        )
        .optional()?)
}

fn tombstoned(conn: &Connection, pid: ProfileId, key: &str) -> Result<bool, Error> {
    Ok(conn
        .query_row(
            "SELECT 1 FROM workout_tombstone WHERE profile_id = ? AND source_key = ?",
            params![pid, key],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

fn raw_by_key(conn: &Connection, pid: ProfileId, key: &str) -> Result<Raw, Error> {
    conn.query_row(
        &format!(
            "SELECT {RAW_COLS} FROM device_session r WHERE r.profile_id = ? AND r.source_key = ?"
        ),
        params![pid, key],
        |r| raw_at(r, 0),
    )
    .optional()?
    .flatten()
    .ok_or_else(|| Error::not_found("device_workout", key))
}

/// Remember that the device workout `key` was deleted or dismissed (its
/// type and start catch a re-id'd copy); once is enough.
pub(super) fn tombstone(
    tx: &Connection,
    pid: ProfileId,
    key: &str,
    kind: Option<ActivityType>,
    start_at: Option<&str>,
) -> Result<(), Error> {
    tx.execute(
        "INSERT OR IGNORE INTO workout_tombstone (profile_id, source_key, type, start_at)
         VALUES (?, ?, ?, ?)",
        params![pid, key, kind, start_at],
    )?;
    Ok(())
}

/// "Add": the device workout `key` as a session, or the session already
/// holding it (a retry adds nothing).
///
/// # Errors
/// An unknown key (404); a dismissed or deleted one (409 `dismissed`).
pub fn synced_workout_add(
    conn: &mut Connection,
    pid: ProfileId,
    key: &str,
) -> Result<Activity, Error> {
    let tx = write(conn)?;
    let id = if let Some(id) = holder(&tx, pid, key)? {
        id
    } else {
        if tombstoned(&tx, pid, key)? {
            return Err(Error::conflict(
                Conflict::Dismissed,
                "this synced workout was dismissed or deleted; log it by hand",
            ));
        }
        let w = raw_by_key(&tx, pid, key)?;
        match hand_match(&tx, pid, &w)? {
            Some(m) => {
                claim(&tx, m, &w.measured())?;
                m
            }
            None => insert(&tx, pid, &w)?,
        }
    };
    let session = written(activity_get(&tx, pid, id)?);
    tx.commit()?;
    Ok(session)
}

/// "Dismiss": the device workout `key` is never added; again is a no-op.
///
/// # Errors
/// An unknown key (404); one an activity holds (409 `held_by_activity`:
/// delete the session instead).
pub fn synced_workout_dismiss(
    conn: &mut Connection,
    pid: ProfileId,
    key: &str,
) -> Result<(), Error> {
    let tx = write(conn)?;
    if holder(&tx, pid, key)?.is_some() {
        return Err(Error::conflict(
            Conflict::HeldByActivity,
            "an activity holds this synced workout; delete the activity instead",
        ));
    }
    if !tombstoned(&tx, pid, key)? {
        let w = raw_by_key(&tx, pid, key)?;
        tombstone(&tx, pid, key, Some(w.kind), Some(&w.a.start_at))?;
    }
    tx.commit()?;
    Ok(())
}

/// The device workouts waiting for Add or Dismiss, oldest first, on `day`
/// or on every day (`None`): every candidate in ask mode, the
/// auto-recorded ones in auto mode; a second copy of one listed isn't.
pub fn pending_activity_list(
    conn: &Connection,
    pid: ProfileId,
    day: Option<&str>,
) -> Result<Vec<PendingActivity>, Error> {
    let mode = synced_workout_list(conn, pid)?;
    let buried = Buried::load(conn, pid)?;
    let mut held = Held::default();
    let mut shown: Vec<Raw> = Vec::new();
    for w in unheld(conn, pid, day)? {
        if candidate(conn, pid, &w, &buried, &mut held)?
            && (mode == SyncedWorkouts::Ask || w.a.recording_method == AUTO_RECORDED)
            && !shown.iter().any(|s| matches(&s.span(), &w.span()))
        {
            shown.push(w);
        }
    }
    Ok(shown
        .into_iter()
        .map(|w| PendingActivity {
            minutes: w.minutes(),
            distance_m: w.distance().map(i64::from),
            kind: w.kind,
            key: w.a.key,
            day: w.a.day,
            start_at: w.a.start_at,
            end_at: w.a.end_at,
            name: w.a.name,
            kcal: w.a.kcal,
        })
        .collect())
}

pub fn synced_workout_list(conn: &Connection, pid: ProfileId) -> Result<SyncedWorkouts, Error> {
    Ok(conn
        .query_row(
            "SELECT synced_workouts FROM profile WHERE id = ?",
            [pid],
            |r| r.get(0),
        )
        .optional()?
        .unwrap_or_default())
}

/// Set the mode; switching to auto promotes what waits (but what the device
/// detected by itself).
pub fn synced_workouts_set(
    conn: &mut Connection,
    pid: ProfileId,
    mode: SyncedWorkouts,
) -> Result<(), Error> {
    let tx = write(conn)?;
    tx.execute(
        "UPDATE profile SET synced_workouts = ? WHERE id = ?",
        params![mode, pid],
    )?;
    promote(&tx, pid, mode)?;
    tx.commit()?;
    Ok(())
}

/// The tombstone of deleted session `s` holding `key`: the device's type
/// and start when its raw copy is there, else the session's.
pub(super) fn bury(tx: &Connection, pid: ProfileId, key: &str, s: &Activity) -> Result<(), Error> {
    match raw_by_key(tx, pid, key) {
        Ok(w) => tombstone(tx, pid, key, Some(w.kind), Some(&w.a.start_at)),
        Err(Error::NotFound { .. }) => tombstone(tx, pid, key, Some(s.kind), s.start_at.as_deref()),
        Err(e) => Err(e),
    }
}

/// The profile's tombstones, by key, as exported.
pub(super) fn tombstone_list(
    conn: &Connection,
    pid: ProfileId,
) -> Result<Vec<ExportedTombstone>, Error> {
    Ok(conn
        .prepare(
            "SELECT source_key, type, start_at FROM workout_tombstone
             WHERE profile_id = ? ORDER BY source_key",
        )?
        .query_map([pid], |r| {
            Ok(ExportedTombstone {
                key: r.get(0)?,
                kind: r.get(1)?,
                start_at: r.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?)
}
