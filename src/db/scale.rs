//! Scale readings, the profile's sync connection, and the weight log they
//! feed.

use super::health_record::record_put;
use super::prelude::*;
use super::profiles::day_weight_refresh;
use crate::model::{
    BodyReading, BoundUser, HEALTH_CONNECT, HealthRecord, LastResult, OPENSCALE, SCALE_USERS_MAX,
    ScaleCounts, ScaleOp, ScalePost, ScaleReading, SeenUser, ShownReading, SyncStatus, day_reading,
    woke_at,
};

/// The stored connection; a profile without one reads as unbound.
fn state(conn: &Connection, pid: ProfileId) -> Result<SyncStatus, Error> {
    let row = conn
        .query_row(
            "SELECT bound_user, bound_username, seen_users, last_seen, last_result
             FROM sync_state WHERE profile_id = ? AND source = ?",
            params![pid, OPENSCALE],
            |r| {
                let bound: Option<i64> = r.get(0)?;
                let last: Option<String> = r.get(4)?;
                Ok(SyncStatus {
                    bound_user: bound
                        .map(|id| -> rusqlite::Result<_> {
                            Ok(BoundUser {
                                id,
                                username: r.get::<_, Option<String>>(1)?.unwrap_or_default(),
                            })
                        })
                        .transpose()?,
                    seen_users: from_json(&r.get::<_, String>(2)?)?,
                    last_seen: r.get(3)?,
                    last_result: last.as_deref().map(from_json).transpose()?,
                })
            },
        )
        .optional()?;
    Ok(row.unwrap_or(SyncStatus {
        bound_user: None,
        seen_users: Vec::new(),
        last_seen: None,
        last_result: None,
    }))
}

fn save_state(tx: &Connection, pid: ProfileId, s: &SyncStatus) -> Result<(), Error> {
    tx.execute(
        "INSERT INTO sync_state (profile_id, source, bound_user, bound_username, seen_users,
             last_seen, last_result)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT (profile_id, source) DO UPDATE SET bound_user = ?3, bound_username = ?4,
             seen_users = ?5, last_seen = ?6, last_result = ?7",
        params![
            pid,
            OPENSCALE,
            s.bound_user.as_ref().map(|b| b.id),
            s.bound_user.as_ref().map(|b| &b.username),
            json(&s.seen_users),
            s.last_seen,
            s.last_result.as_ref().map(json),
        ],
    )?;
    Ok(())
}

pub fn sync_status(conn: &Connection, pid: ProfileId) -> Result<SyncStatus, Error> {
    state(conn, pid)
}

/// Days of `pid`'s readings a `DELETE … RETURNING day` removed.
fn removed_days(
    tx: &Connection,
    sql: &str,
    args: impl Params,
    days: &mut BTreeSet<String>,
) -> Result<u64, Error> {
    let mut stmt = tx.prepare_cached(sql)?;
    let mut n = 0;
    for day in stmt.query_map(args, |r| r.get::<_, String>(0))? {
        days.insert(day?);
        n += 1;
    }
    Ok(n)
}

/// Apply one webhook POST in one transaction: the bound user's readings
/// are stored or removed, everyone else's counted as ignored; each touched
/// day's weight is derived again once.
pub fn scale_apply(
    conn: &mut Connection,
    pid: ProfileId,
    post: &ScalePost,
    now: i64,
    tz: &TimeZone,
) -> Result<ScaleCounts, Error> {
    let tx = write(conn)?;
    let mut s = state(&tx, pid)?;
    let bound = s.bound_user.as_ref().map(|b| b.id);
    let mut counts = ScaleCounts {
        skipped: post.skipped,
        ..ScaleCounts::default()
    };
    let mut days = BTreeSet::new();
    // Users this POST names: their name, and their items ignored in it.
    let mut named: BTreeMap<i64, (Option<&str>, u64)> = BTreeMap::new();
    for op in &post.ops {
        let user = op.user();
        let seen = named.entry(user).or_default();
        if let ScaleOp::Upsert(i) = op
            && i.username.is_some()
        {
            seen.0 = i.username.as_deref();
        }
        if bound == Some(user) {
            counts.applied += apply_op(&tx, pid, op, &mut days, now)?;
        } else {
            seen.1 += 1;
            counts.ignored += 1;
        }
    }
    for day in &days {
        day_weight_refresh(&tx, pid, day, now, tz)?;
    }
    note_users(&mut s, named);
    s.last_seen = Some(now);
    s.last_result = Some(LastResult {
        event: post.event.to_owned(),
        counts,
    });
    save_state(&tx, pid, &s)?;
    tx.commit()?;
    Ok(counts)
}

/// Store or remove the bound user's readings for `op`; how many, with the
/// days touched added to `days`.
fn apply_op(
    tx: &Connection,
    pid: ProfileId,
    op: &ScaleOp,
    days: &mut BTreeSet<String>,
    now: i64,
) -> Result<u64, Error> {
    match op {
        ScaleOp::Upsert(i) => {
            let r = &i.reading;
            // The same measurement under its id at another time: a move
            // whose delete was lost. An id is per installation (a fresh one
            // numbers from 1 again), so another weight or week is another
            // reading.
            if let Some(id) = i.source_id {
                removed_days(
                    tx,
                    "DELETE FROM scale_reading WHERE profile_id = ?1 AND source = ?2
                         AND source_user = ?3 AND source_id = ?4 AND taken_at <> ?5
                         AND abs(weight - ?6) <= ?7 AND abs(taken_at - ?5) <= ?8
                     RETURNING day",
                    params![
                        pid,
                        r.source,
                        i.user,
                        id,
                        r.taken_at,
                        r.weight,
                        SAME_READING_KG + 1e-9,
                        MOVED_READING_MS
                    ],
                    days,
                )?;
            }
            reading_put(tx, pid, i.user, i.source_id, r)?;
            // Everything openScale sent, kept as sent.
            let raw = HealthRecord {
                kind: "measurement".to_owned(),
                id: format!("{}-{}", i.user, r.taken_at),
                start_at: jiff::Timestamp::from_millisecond(r.taken_at)
                    .map(|t| t.to_string())
                    .ok(),
                end_at: None,
                day: Some(r.day.clone()),
                data: i.raw.clone(),
                truncated: false,
            };
            record_put(tx, pid, OPENSCALE, &raw, now)?;
            days.insert(r.day.clone());
            Ok(1)
        }
        ScaleOp::Delete { user, taken_at } => removed_days(
            tx,
            "DELETE FROM scale_reading WHERE profile_id = ?1 AND source = ?2
                 AND source_user = ?3 AND taken_at = ?4 RETURNING day",
            params![pid, OPENSCALE, user, taken_at],
            days,
        ),
        ScaleOp::Clear { user } => removed_days(
            tx,
            "DELETE FROM scale_reading WHERE profile_id = ?1 AND source = ?2
                 AND source_user = ?3 RETURNING day",
            params![pid, OPENSCALE, user],
            days,
        ),
    }
}

/// Store reading `r` of `user` (its source's id `source_id`), replacing one
/// taken at the same time.
fn reading_put(
    tx: &Connection,
    pid: ProfileId,
    user: i64,
    source_id: Option<i64>,
    r: &ScaleReading,
) -> Result<(), Error> {
    tx.prepare_cached(
        "INSERT INTO scale_reading (profile_id, source, source_user, taken_at,
             source_id, day, weight, body_fat, water, muscle, bone_kg, lbm_kg, bmr_kcal)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
         ON CONFLICT (profile_id, source, source_user, taken_at) DO UPDATE SET
             source_id = ?5, day = ?6, weight = ?7, body_fat = ?8, water = ?9,
             muscle = ?10, bone_kg = ?11, lbm_kg = ?12, bmr_kcal = ?13",
    )?
    .execute(params![
        pid, r.source, user, r.taken_at, source_id, r.day, r.weight, r.body_fat, r.water, r.muscle,
        r.bone_kg, r.lbm_kg, r.bmr_kcal
    ])?;
    Ok(())
}

/// A Health Connect weigh-in this close to a stored reading of another
/// source (time, weight) is that reading's copy; openScale's reading under
/// a stored id this close in weight, moved at most [`MOVED_READING_MS`], is
/// that one.
const SAME_READING_MS: i64 = 120_000;
const SAME_READING_KG: f64 = 0.05;
const MOVED_READING_MS: i64 = 7 * 86_400_000;

/// Replace `pid`'s Health Connect readings in `[from, to]` with `body`
/// (user 0), each left out when another source's reading is its copy;
/// the weight of every day in the window with a reading, or one removed, is
/// derived again (the window's nights came with them).
pub(super) fn health_readings_replace(
    tx: &Connection,
    pid: ProfileId,
    from: &str,
    to: &str,
    body: &[BodyReading],
    now: i64,
    tz: &TimeZone,
) -> Result<(), Error> {
    let mut days = BTreeSet::new();
    removed_days(
        tx,
        "DELETE FROM scale_reading WHERE profile_id = ?1 AND source = ?2
             AND day BETWEEN ?3 AND ?4 RETURNING day",
        params![pid, HEALTH_CONNECT, from, to],
        &mut days,
    )?;
    let mut copy = tx.prepare_cached(
        "SELECT 1 FROM scale_reading WHERE profile_id = ?1 AND source <> ?2
           AND abs(taken_at - ?3) <= ?4 AND abs(weight - ?5) <= ?6",
    )?;
    for b in body {
        let copied = copy
            .query_row(
                params![
                    pid,
                    HEALTH_CONNECT,
                    b.taken_at,
                    SAME_READING_MS,
                    b.weight,
                    SAME_READING_KG + 1e-9
                ],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
        if copied {
            continue;
        }
        let r = ScaleReading {
            source: WeightSource::HealthConnect,
            taken_at: b.taken_at,
            day: b.day.clone(),
            weight: b.weight,
            body_fat: b.body_fat,
            water: None,
            muscle: None,
            bone_kg: b.bone_kg,
            lbm_kg: b.lbm_kg,
            bmr_kcal: b.bmr_kcal,
        };
        reading_put(tx, pid, 0, None, &r)?;
    }
    // The window's nights came with these: any day's morning may have moved.
    days.extend(
        tx.prepare_cached(
            "SELECT DISTINCT day FROM scale_reading
             WHERE profile_id = ?1 AND day BETWEEN ?2 AND ?3",
        )?
        .query_map(params![pid, from, to], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?,
    );
    for day in &days {
        day_weight_refresh(tx, pid, day, now, tz)?;
    }
    Ok(())
}

/// Forget `pid`'s Health Connect readings; their days' weights follow.
pub(super) fn health_readings_delete(
    tx: &Connection,
    pid: ProfileId,
    now: i64,
    tz: &TimeZone,
) -> Result<(), Error> {
    let mut days = BTreeSet::new();
    removed_days(
        tx,
        "DELETE FROM scale_reading WHERE profile_id = ?1 AND source = ?2 RETURNING day",
        params![pid, HEALTH_CONNECT],
        &mut days,
    )?;
    for day in &days {
        day_weight_refresh(tx, pid, day, now, tz)?;
    }
    Ok(())
}

/// Fold the users a POST named into those seen: their latest name, and how
/// many of their items it ignored. At most [`SCALE_USERS_MAX`] stay: the
/// bound one, then the lowest ids (openScale numbers its users from 1).
fn note_users(s: &mut SyncStatus, named: BTreeMap<i64, (Option<&str>, u64)>) {
    let mut seen: BTreeMap<i64, SeenUser> = std::mem::take(&mut s.seen_users)
        .into_iter()
        .map(|u| (u.id, u))
        .collect();
    for (id, (username, ignored)) in named {
        let u = seen.entry(id).or_insert_with(|| SeenUser {
            id,
            username: String::new(),
            ignored: 0,
        });
        u.ignored = ignored;
        if let Some(name) = username {
            name.clone_into(&mut u.username);
        }
    }
    if let Some(b) = &mut s.bound_user
        && let Some(u) = seen.remove(&b.id)
    {
        b.username.clone_from(&u.username);
        s.seen_users.push(u);
    }
    let room = SCALE_USERS_MAX.saturating_sub(s.seen_users.len());
    s.seen_users.extend(seen.into_values().take(room));
    s.seen_users.sort_by_key(|u| u.id);
}

/// Bind openScale user `user` (one seen here) to the profile. The readings
/// stored are the profile's (only a bound user's ever are): they become
/// `user`'s (a reinstall renumbers users and can't send them again); one at
/// a time `user` already has a reading goes, and its day is derived again.
pub fn sync_bind(
    conn: &mut Connection,
    pid: ProfileId,
    user: i64,
    now: i64,
    tz: &TimeZone,
) -> Result<SyncStatus, Error> {
    let tx = write(conn)?;
    let mut s = state(&tx, pid)?;
    let seen = s.seen_users.iter().find(|u| u.id == user).ok_or_else(|| {
        Error::invalid_field(
            "user_id",
            "user_id must be an openScale user seen here; sync from openScale first",
        )
    })?;
    s.bound_user = Some(BoundUser {
        id: user,
        username: seen.username.clone(),
    });
    tx.execute(
        "UPDATE OR IGNORE scale_reading SET source_user = ?3
         WHERE profile_id = ?1 AND source = ?2 AND source_user <> ?3",
        params![pid, OPENSCALE, user],
    )?;
    let mut days = BTreeSet::new();
    removed_days(
        &tx,
        "DELETE FROM scale_reading WHERE profile_id = ?1 AND source = ?2 AND source_user <> ?3
         RETURNING day",
        params![pid, OPENSCALE, user],
        &mut days,
    )?;
    for day in &days {
        day_weight_refresh(&tx, pid, day, now, tz)?;
    }
    save_state(&tx, pid, &s)?;
    tx.commit()?;
    Ok(s)
}

/// Forget the connection: binding, users seen, last result. Readings and
/// the weights they set stay.
pub fn sync_disconnect(conn: &Connection, pid: ProfileId) -> Result<(), Error> {
    conn.execute(
        "DELETE FROM sync_state WHERE profile_id = ? AND source = ?",
        params![pid, OPENSCALE],
    )?;
    Ok(())
}

const READING_COLS: &str =
    "source, taken_at, day, weight, body_fat, water, muscle, bone_kg, lbm_kg, bmr_kcal";

fn reading_row(r: &Row) -> rusqlite::Result<ScaleReading> {
    Ok(ScaleReading {
        source: r.get(0)?,
        taken_at: r.get(1)?,
        day: r.get(2)?,
        weight: r.get(3)?,
        body_fat: r.get(4)?,
        water: r.get(5)?,
        muscle: r.get(6)?,
        bone_kg: r.get(7)?,
        lbm_kg: r.get(8)?,
        bmr_kcal: r.get(9)?,
    })
}

/// A profile's readings in `[from, to]` (either end open), oldest first.
pub fn scale_list(
    conn: &Connection,
    pid: ProfileId,
    from: Option<&str>,
    to: Option<&str>,
) -> Result<Vec<ScaleReading>, Error> {
    let mut stmt = conn.prepare_cached(&format!(
        "SELECT {READING_COLS} FROM scale_reading
         WHERE {IN_RANGE}
         ORDER BY day, taken_at"
    ))?;
    Ok(stmt
        .query_map(params![pid, from, to], reading_row)?
        .collect::<rusqlite::Result<_>>()?)
}

/// The reading that stands for `day` ([`day_reading`]: the first after its
/// night's wake time in `tz`, the morning weight).
pub fn scale_chosen(
    conn: &Connection,
    pid: ProfileId,
    day: &str,
    tz: &TimeZone,
) -> Result<Option<ScaleReading>, Error> {
    let readings = scale_list(conn, pid, Some(day), Some(day))?;
    let wake = wakes(conn, pid, Some(day), Some(day))?.remove(day);
    Ok(day_reading(&readings, woke_at(day, wake.as_deref(), tz), wake.is_some()).cloned())
}

/// A profile's readings in `[from, to]` (either end open), oldest first,
/// each day's chosen one ([`scale_chosen`]) marked.
pub fn scale_shown(
    conn: &Connection,
    pid: ProfileId,
    from: Option<&str>,
    to: Option<&str>,
    tz: &TimeZone,
) -> Result<Vec<ShownReading>, Error> {
    let all = scale_list(conn, pid, from, to)?;
    let wakes = wakes(conn, pid, from, to)?;
    let mut out = Vec::with_capacity(all.len());
    for day in all.chunk_by(|a, b| a.day == b.day) {
        let wake_time = wakes.get(&day[0].day).map(String::as_str);
        let from = woke_at(&day[0].day, wake_time, tz);
        let chosen = day_reading(day, from, wake_time.is_some()).map(|r| (r.taken_at, r.source));
        out.extend(day.iter().map(|r| ShownReading {
            chosen: chosen == Some((r.taken_at, r.source)),
            reading: r.clone(),
        }));
    }
    Ok(out)
}

/// Each day's wake time in `[from, to]` as it shows (its awake tail cut).
fn wakes(
    conn: &Connection,
    pid: ProfileId,
    from: Option<&str>,
    to: Option<&str>,
) -> Result<BTreeMap<String, String>, Error> {
    Ok(super::device_day_list(conn, pid, from, to)?
        .days
        .into_iter()
        .filter_map(|d| Some((d.day.day, d.day.wake_time?)))
        .collect())
}

/// Bumped when [`day_reading`]'s rule changes, so stored day weights are
/// picked again (2: a reading before that night's sleep is no morning
/// weight).
pub(super) const WEIGHT_RULE_VERSION: i64 = 2;

/// Pick the weight of every day of `pid` (all profiles when `None`) with
/// readings again, at `now`, in `tz` ([`day_weight_refresh`]). A synced
/// weight without readings (an old file's) stays: nothing to pick from.
/// How many days.
pub(super) fn weights_repick(
    tx: &Connection,
    pid: Option<ProfileId>,
    now: i64,
    tz: &TimeZone,
) -> Result<usize, Error> {
    let days: Vec<(ProfileId, String)> = tx
        .prepare(
            "SELECT DISTINCT profile_id, day FROM scale_reading
             WHERE ?1 IS NULL OR profile_id = ?1",
        )?
        .query_map([pid], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    for (pid, day) in &days {
        day_weight_refresh(tx, *pid, day, now, tz)?;
    }
    Ok(days.len())
}
