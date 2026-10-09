//! Watch workouts as sessions. `activity_session` is the watch's
//! raw copy; a **candidate** is a raw row no session holds, not tombstoned
//! (by key, or by type and a start within a minute), at least a minute
//! long, and not a second copy of a session that already holds a key. Each
//! candidate, oldest first, is claimed by a matching hand log, or promoted
//! into a `health_connect` session (auto mode, not auto-recorded), or waits
//! as pending.

use std::collections::btree_map;

use jiff::Timestamp;

use super::prelude::*;
use super::{SESSION_COLS, session_get, session_row};
use crate::model::{
    AUTO_RECORDED, ActivitySession, ExportedTombstone, PendingSession, SessionSource, SessionType,
    Span, SyncedWorkouts, hc_type, matches, session_minutes,
};

/// A tombstone's start may differ this much from a re-id'd copy's.
const REID_SECONDS: i64 = 60;
/// Raw workouts shorter than this are never sessions.
const SHORTEST_SECONDS: i64 = 60;

/// A raw watch workout with its times read.
struct Raw {
    a: ActivitySession,
    kind: SessionType,
    start: Timestamp,
    end: Timestamp,
}

impl Raw {
    fn span(&self) -> Span<'_> {
        Span {
            day: &self.a.day,
            kind: Some(self.kind),
            start: Some(self.start),
            end: Some(self.end),
        }
    }

    fn seconds(&self) -> i64 {
        self.end.as_second() - self.start.as_second()
    }

    fn minutes(&self) -> u32 {
        session_minutes(self.seconds())
    }

    fn kcal(&self) -> Option<u32> {
        self.a.kcal.and_then(|k| u32::try_from(k).ok())
    }

    fn distance(&self) -> Option<u32> {
        self.a.distance_m.and_then(|d| u32::try_from(d).ok())
    }
}

const RAW_COLS: &str = "r.source_key, r.day, r.start_at, r.end_at, r.type, r.name, r.kcal, \
                        r.distance_m, r.recording_method";

/// A raw row from [`RAW_COLS`] at column `at` on; one whose times don't read is never a
/// candidate (the sync checked them).
fn raw_at(r: &Row, at: usize) -> rusqlite::Result<Option<Raw>> {
    let a = ActivitySession {
        key: r.get(at)?,
        day: r.get(at + 1)?,
        start_at: r.get(at + 2)?,
        end_at: r.get(at + 3)?,
        kind: r.get(at + 4)?,
        name: r.get(at + 5)?,
        kcal: r.get(at + 6)?,
        distance_m: r.get(at + 7)?,
        recording_method: r.get(at + 8)?,
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
            "SELECT {RAW_COLS} FROM activity_session r
             WHERE r.profile_id = ?1 AND (?2 IS NULL OR r.day = ?2)
               AND NOT EXISTS (SELECT 1 FROM workout_session s
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
struct Buried(Vec<(SessionType, Timestamp)>);

impl Buried {
    fn load(conn: &Connection, pid: ProfileId) -> Result<Self, Error> {
        let rows = conn
            .prepare_cached(
                "SELECT type, start_at FROM workout_tombstone
                 WHERE profile_id = ? AND type IS NOT NULL AND start_at IS NOT NULL",
            )?
            .query_map([pid], |r| {
                Ok((r.get::<_, SessionType>(0)?, r.get::<_, String>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(Self(
            rows.into_iter()
                .filter_map(|(k, at)| Some((k, at.parse().ok()?)))
                .collect(),
        ))
    }

    fn covers(&self, w: &Raw) -> bool {
        self.0.iter().any(|(kind, at)| {
            *kind == w.kind && (at.as_second() - w.start.as_second()).abs() <= REID_SECONDS
        })
    }
}

/// Sessions holding a key, per day, read once per day: what a second
/// app's copy of the same workout would duplicate.
#[derive(Default)]
struct Held(BTreeMap<String, Vec<Session>>);

impl Held {
    fn day(
        &mut self,
        conn: &Connection,
        pid: ProfileId,
        day: &str,
    ) -> Result<&mut Vec<Session>, Error> {
        Ok(match self.0.entry(day.to_owned()) {
            btree_map::Entry::Occupied(e) => e.into_mut(),
            btree_map::Entry::Vacant(v) => v.insert(
                conn.prepare_cached(&format!(
                    "SELECT {SESSION_COLS} FROM workout_session
                     WHERE profile_id = ? AND day = ? AND source_key IS NOT NULL"
                ))?
                .query_map(params![pid, day], session_row)?
                .collect::<rusqlite::Result<_>>()?,
            ),
        })
    }

    fn covers(&mut self, conn: &Connection, pid: ProfileId, w: &Raw) -> Result<bool, Error> {
        Ok(self
            .day(conn, pid, &w.a.day)?
            .iter()
            .any(|s| matches(&s.span(), &w.span())))
    }

    fn add(&mut self, conn: &Connection, pid: ProfileId, id: i64) -> Result<(), Error> {
        let s = written(session_get(conn, pid, id)?);
        self.day(conn, pid, &s.day.clone())?.push(s);
        Ok(())
    }
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
    Ok(w.seconds() >= SHORTEST_SECONDS && !buried.covers(w) && !held.covers(conn, pid, w)?)
}

/// The hand log `w` is (unkeyed, timed, matching; the best overlap wins).
fn manual_match(conn: &Connection, pid: ProfileId, w: &Raw) -> Result<Option<i64>, Error> {
    let logged: Vec<Session> = conn
        .prepare_cached(&format!(
            "SELECT {SESSION_COLS} FROM workout_session
             WHERE profile_id = ? AND day = ? AND source = 'manual'
               AND source_key IS NULL AND start_at IS NOT NULL"
        ))?
        .query_map(params![pid, w.a.day], session_row)?
        .collect::<rusqlite::Result<_>>()?;
    Ok(logged
        .iter()
        .filter(|m| matches(&m.span(), &w.span()))
        .max_by_key(|m| (m.span().overlap(&w.span()), std::cmp::Reverse(m.id)))
        .map(|m| m.id))
}

/// Hand log `id` takes `w`'s key and fills only what it left empty; an
/// untyped one without sets takes the type too. Only a typed (whole)
/// session takes a distance.
fn claim(tx: &Connection, id: i64, w: &Raw) -> Result<(), Error> {
    tx.execute(
        "UPDATE workout_session SET source_key = ?1,
             start_at = coalesce(start_at, ?2),
             distance_m = CASE WHEN coalesce(type, CASE WHEN sets = '[]' THEN ?5 END) IS NOT NULL
                 THEN coalesce(distance_m, ?3) END,
             kcal = coalesce(kcal, ?4),
             type = CASE WHEN type IS NULL AND sets = '[]' THEN ?5 ELSE type END,
             rev = rev + 1
         WHERE id = ?6",
        params![w.a.key, w.a.start_at, w.distance(), w.kcal(), w.kind, id],
    )?;
    Ok(())
}

/// `w` as a session of its own; its id.
fn insert(tx: &Connection, pid: ProfileId, w: &Raw) -> Result<i64, Error> {
    tx.execute(
        "INSERT INTO workout_session (profile_id, day, name, minutes, kcal, sets, type,
             distance_m, start_at, source, source_key)
         VALUES (?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?)",
        params![
            pid,
            w.a.day,
            w.a.name,
            w.minutes(),
            w.kcal(),
            w.kind,
            w.distance(),
            w.a.start_at,
            SessionSource::HealthConnect,
            w.a.key
        ],
    )?;
    Ok(tx.last_insert_rowid())
}

/// Every candidate of the profile, oldest first: claimed by the hand log it
/// matches (either mode: that adds no workout), else in auto mode, unless
/// the watch detected it by itself, promoted.
pub(super) fn promote(tx: &Connection, pid: ProfileId, mode: SyncedWorkouts) -> Result<(), Error> {
    let buried = Buried::load(tx, pid)?;
    let mut held = Held::default();
    for w in unheld(tx, pid, None)? {
        if !candidate(tx, pid, &w, &buried, &mut held)? {
            continue;
        }
        let id = if let Some(m) = manual_match(tx, pid, &w)? {
            claim(tx, m, &w)?;
            m
        } else if mode == SyncedWorkouts::Auto && w.a.recording_method != AUTO_RECORDED {
            insert(tx, pid, &w)?
        } else {
            continue;
        };
        held.add(tx, pid, id)?;
    }
    Ok(())
}

/// The window's watch sessions brought in line with the raw copy just
/// posted (`rev` moves when anything changed). With the same device as the
/// last POST, a key gone from the window goes too: its watch session is
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
            "SELECT s.id, {RAW_COLS} FROM workout_session s
             JOIN activity_session r ON r.profile_id = s.profile_id AND r.source_key = s.source_key
             WHERE s.profile_id = ?1 AND s.source = ?4 AND r.day BETWEEN ?2 AND ?3"
        ))?
        .query_map(params![pid, from, to, SessionSource::HealthConnect], |r| {
            Ok((r.get::<_, i64>(0)?, raw_at(r, 1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut update = tx.prepare_cached(
        "UPDATE workout_session SET day = ?1, start_at = ?2, minutes = ?3, kcal = ?4,
             type = ?5, distance_m = ?6, rev = rev + 1
         WHERE id = ?7 AND NOT (day IS ?1 AND start_at IS ?2 AND minutes IS ?3
             AND kcal IS ?4 AND type IS ?5 AND distance_m IS ?6)",
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
            id
        ])?;
    }
    if same_device {
        let gone = "NOT EXISTS (SELECT 1 FROM activity_session r
                        WHERE r.profile_id = ?1 AND r.source_key = workout_session.source_key)";
        tx.execute(
            &format!(
                "DELETE FROM workout_session WHERE profile_id = ?1 AND source = ?4
                 AND day BETWEEN ?2 AND ?3 AND {gone}"
            ),
            params![pid, from, to, SessionSource::HealthConnect],
        )?;
        tx.execute(
            &format!(
                "UPDATE workout_session SET source_key = NULL, rev = rev + 1
                 WHERE profile_id = ?1 AND source = 'manual' AND source_key IS NOT NULL
                   AND day BETWEEN ?2 AND ?3 AND {gone}"
            ),
            params![pid, from, to],
        )?;
    }
    Ok(())
}

/// After a hand log `s` was saved: unkeyed and timed, it claims the watch
/// workout it matches, pending or already promoted (that session goes);
/// tombstoned keys excepted. Whether it did.
pub(super) fn claim_for(tx: &Connection, pid: ProfileId, s: &Session) -> Result<bool, Error> {
    if s.source != SessionSource::Manual || s.source_key.is_some() || s.start_at.is_none() {
        return Ok(false);
    }
    let rows = tx
        .prepare_cached(&format!(
            "SELECT (SELECT h.id FROM workout_session h
                     WHERE h.profile_id = ?1 AND h.source_key = r.source_key), {RAW_COLS}
             FROM activity_session r
             WHERE r.profile_id = ?1 AND r.day = ?2
               AND NOT EXISTS (SELECT 1 FROM workout_tombstone t
                               WHERE t.profile_id = ?1 AND t.source_key = r.source_key)
               AND NOT EXISTS (SELECT 1 FROM workout_session h WHERE h.profile_id = ?1
                               AND h.source_key = r.source_key AND h.source = 'manual')
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
        tx.execute("DELETE FROM workout_session WHERE id = ?", [h])?;
    }
    claim(tx, s.id, &w)?;
    Ok(true)
}

/// The id of the session holding `key`, if one does.
fn holder(conn: &Connection, pid: ProfileId, key: &str) -> Result<Option<i64>, Error> {
    Ok(conn
        .query_row(
            "SELECT id FROM workout_session WHERE profile_id = ? AND source_key = ?",
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
            "SELECT {RAW_COLS} FROM activity_session r WHERE r.profile_id = ? AND r.source_key = ?"
        ),
        params![pid, key],
        |r| raw_at(r, 0),
    )
    .optional()?
    .flatten()
    .ok_or_else(|| Error::not_found("watch_workout", key))
}

/// Remember that the watch workout `key` was deleted or dismissed (its
/// type and start catch a re-id'd copy); once is enough.
pub(super) fn tombstone(
    tx: &Connection,
    pid: ProfileId,
    key: &str,
    kind: Option<SessionType>,
    start_at: Option<&str>,
) -> Result<(), Error> {
    tx.execute(
        "INSERT OR IGNORE INTO workout_tombstone (profile_id, source_key, type, start_at)
         VALUES (?, ?, ?, ?)",
        params![pid, key, kind, start_at],
    )?;
    Ok(())
}

/// "Add": the watch workout `key` as a session, or the session already
/// holding it (a retry adds nothing).
///
/// # Errors
/// An unknown key (404); a dismissed or deleted one (409 `dismissed`).
pub fn synced_workout_add(
    conn: &mut Connection,
    pid: ProfileId,
    key: &str,
) -> Result<Session, Error> {
    let tx = write(conn)?;
    let id = if let Some(id) = holder(&tx, pid, key)? {
        id
    } else {
        if tombstoned(&tx, pid, key)? {
            return Err(Error::conflict(
                Conflict::Dismissed,
                "this watch workout was dismissed or deleted; log it by hand",
            ));
        }
        let w = raw_by_key(&tx, pid, key)?;
        match manual_match(&tx, pid, &w)? {
            Some(m) => {
                claim(&tx, m, &w)?;
                m
            }
            None => insert(&tx, pid, &w)?,
        }
    };
    let session = written(session_get(&tx, pid, id)?);
    tx.commit()?;
    Ok(session)
}

/// "Dismiss": the watch workout `key` is never added; again is a no-op.
///
/// # Errors
/// An unknown key (404); one a session holds (409 `held_by_session`:
/// delete the session instead).
pub fn synced_workout_dismiss(
    conn: &mut Connection,
    pid: ProfileId,
    key: &str,
) -> Result<(), Error> {
    let tx = write(conn)?;
    if holder(&tx, pid, key)?.is_some() {
        return Err(Error::conflict(
            Conflict::HeldBySession,
            "a session holds this watch workout; delete the session instead",
        ));
    }
    if !tombstoned(&tx, pid, key)? {
        let w = raw_by_key(&tx, pid, key)?;
        tombstone(&tx, pid, key, Some(w.kind), Some(&w.a.start_at))?;
    }
    tx.commit()?;
    Ok(())
}

/// The watch workouts waiting for Add or Dismiss, oldest first, on `day`
/// or on every day (`None`): every candidate in ask mode, the
/// auto-recorded ones in auto mode; a second copy of one listed isn't.
pub fn pending_session_list(
    conn: &Connection,
    pid: ProfileId,
    day: Option<&str>,
) -> Result<Vec<PendingSession>, Error> {
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
        .map(|w| PendingSession {
            minutes: w.minutes(),
            kind: w.kind,
            key: w.a.key,
            day: w.a.day,
            start_at: w.a.start_at,
            end_at: w.a.end_at,
            name: w.a.name,
            kcal: w.a.kcal,
            distance_m: w.a.distance_m,
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

/// Set the mode; switching to auto promotes what waits (but what the watch
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

/// The tombstone of deleted session `s` holding `key`: the watch's type
/// and start when its raw copy is there, else the session's.
pub(super) fn bury(tx: &Connection, pid: ProfileId, key: &str, s: &Session) -> Result<(), Error> {
    match raw_by_key(tx, pid, key) {
        Ok(w) => tombstone(tx, pid, key, Some(w.kind), Some(&w.a.start_at)),
        Err(Error::NotFound { .. }) => tombstone(tx, pid, key, s.kind, s.start_at.as_deref()),
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
