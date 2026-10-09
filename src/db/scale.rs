//! Scale readings, the profile's sync connection, and the weight log they
//! feed.

use super::prelude::*;
use super::profiles::day_weight_refresh;
use crate::model::{
    BoundUser, LastResult, OPENSCALE, SCALE_USERS_MAX, ScaleCounts, ScaleOp, ScalePost,
    ScaleReading, SeenUser, SyncStatus,
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
            counts.applied += apply_op(&tx, pid, op, &mut days)?;
        } else {
            seen.1 += 1;
            counts.ignored += 1;
        }
    }
    for day in &days {
        day_weight_refresh(&tx, pid, day, now)?;
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
) -> Result<u64, Error> {
    match op {
        ScaleOp::Upsert(i) => {
            let r = &i.reading;
            // The same reading at another time: a move whose delete was lost.
            if let Some(id) = i.source_id {
                removed_days(
                    tx,
                    "DELETE FROM scale_reading WHERE profile_id = ?1 AND source = ?2
                         AND source_user = ?3 AND source_id = ?4 AND taken_at <> ?5
                     RETURNING day",
                    params![pid, r.source, i.user, id, r.taken_at],
                    days,
                )?;
            }
            tx.prepare_cached(
                "INSERT INTO scale_reading (profile_id, source, source_user, taken_at,
                     source_id, day, weight, body_fat, water, muscle)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                 ON CONFLICT (profile_id, source, source_user, taken_at) DO UPDATE SET
                     source_id = ?5, day = ?6, weight = ?7, body_fat = ?8, water = ?9,
                     muscle = ?10",
            )?
            .execute(params![
                pid,
                r.source,
                i.user,
                r.taken_at,
                i.source_id,
                r.day,
                r.weight,
                r.body_fat,
                r.water,
                r.muscle
            ])?;
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

/// Bind openScale user `user` (one seen here) to the profile. Readings of
/// any other user go, and their days are derived again.
pub fn sync_bind(
    conn: &mut Connection,
    pid: ProfileId,
    user: i64,
    now: i64,
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
    let mut days = BTreeSet::new();
    removed_days(
        &tx,
        "DELETE FROM scale_reading WHERE profile_id = ?1 AND source = ?2 AND source_user <> ?3
         RETURNING day",
        params![pid, OPENSCALE, user],
        &mut days,
    )?;
    for day in &days {
        day_weight_refresh(&tx, pid, day, now)?;
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

fn reading_row(r: &Row) -> rusqlite::Result<ScaleReading> {
    Ok(ScaleReading {
        source: r.get(0)?,
        taken_at: r.get(1)?,
        day: r.get(2)?,
        weight: r.get(3)?,
        body_fat: r.get(4)?,
        water: r.get(5)?,
        muscle: r.get(6)?,
    })
}

/// A profile's readings in `[from, to]` (either end open), oldest first.
pub fn scale_list(
    conn: &Connection,
    pid: ProfileId,
    from: Option<&str>,
    to: Option<&str>,
) -> Result<Vec<ScaleReading>, Error> {
    let mut stmt = conn.prepare_cached(
        "SELECT source, taken_at, day, weight, body_fat, water, muscle FROM scale_reading
         WHERE profile_id = ?1 AND (?2 IS NULL OR day >= ?2) AND (?3 IS NULL OR day <= ?3)
         ORDER BY day, taken_at",
    )?;
    Ok(stmt
        .query_map(params![pid, from, to], reading_row)?
        .collect::<rusqlite::Result<_>>()?)
}

/// The reading that stands for `day`: its earliest (the morning weight).
pub fn scale_chosen(
    conn: &Connection,
    pid: ProfileId,
    day: &str,
) -> Result<Option<ScaleReading>, Error> {
    Ok(conn
        .prepare_cached(
            "SELECT source, taken_at, day, weight, body_fat, water, muscle FROM scale_reading
             WHERE profile_id = ? AND day = ? ORDER BY taken_at LIMIT 1",
        )?
        .query_row(params![pid, day], reading_row)
        .optional()?)
}
