//! Profiles and their weight log.

use super::prelude::*;
use super::{scale_chosen, write_targets};
use crate::model::{Provenance, WeightSource, day_so_far};

/// `latest_weight_kg` is the latest weigh-in up to `?1` (the latest day a
/// client may call today): `NULL` without one.
const PROFILE_COLS: &str = "id, name, sex, birth_date, height_cm, activity, goal_kg_per_week, rev, \
     (SELECT kg FROM weight WHERE profile_id = profile.id AND day <= ?1 \
         ORDER BY day DESC LIMIT 1), goal_date, latitude";

fn profile_row(r: &Row) -> rusqlite::Result<Profile> {
    Ok(Profile {
        id: r.get(0)?,
        name: r.get(1)?,
        body: Body {
            sex: r.get(2)?,
            birth_date: r.get(3)?,
            height_cm: r.get(4)?,
            activity: r.get(5)?,
            goal_kg_per_week: r.get(6)?,
            goal_date: r.get(9)?,
            latitude: r.get(10)?,
        },
        rev: r.get(7)?,
        latest_weight_kg: r.get(8)?,
    })
}

/// The bound of `latest_weight_kg` in [`PROFILE_COLS`].
fn so_far() -> String {
    day_so_far().to_string()
}

pub fn profile_list(conn: &Connection) -> Result<Vec<Profile>, Error> {
    let mut stmt =
        conn.prepare_cached(&format!("SELECT {PROFILE_COLS} FROM profile ORDER BY id"))?;
    Ok(stmt
        .query_map([so_far()], profile_row)?
        .collect::<rusqlite::Result<_>>()?)
}

pub fn profile_get(conn: &Connection, id: ProfileId) -> Result<Option<Profile>, Error> {
    Ok(conn
        .prepare_cached(&format!("SELECT {PROFILE_COLS} FROM profile WHERE id = ?2"))?
        .query_row(params![so_far(), id], profile_row)
        .optional()?)
}

pub fn profile_by_name(conn: &Connection, name: &str) -> Result<Option<Profile>, Error> {
    Ok(conn
        .prepare_cached(&format!(
            "SELECT {PROFILE_COLS} FROM profile WHERE name = ?2"
        ))?
        .query_row(params![so_far(), name], profile_row)
        .optional()?)
}

pub(super) fn name_free(conn: &Connection, name: &str, id: Option<ProfileId>) -> Result<(), Error> {
    let taken: bool = conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM profile WHERE name = ?1 AND id IS NOT ?2)",
        params![name, id],
        |r| r.get(0),
    )?;
    if taken {
        Err(Error::conflict(
            Conflict::NameTaken,
            format!("a profile named “{name}” already exists"),
        ))
    } else {
        Ok(())
    }
}

/// Create a profile with `targets` as its starting targets.
pub fn profile_insert(
    conn: &mut Connection,
    input: &ProfileInput,
    targets: &[Target],
) -> Result<Profile, Error> {
    let tx = write(conn)?;
    if let Some(earlier) = super::foods::created_before(&tx, "profile", input.uid.as_deref())? {
        return Ok(written(profile_get(&tx, ProfileId(earlier))?));
    }
    name_free(&tx, &input.name, None)?;
    let b = &input.body;
    tx.execute(
        "INSERT INTO profile
             (name, sex, birth_date, height_cm, activity, goal_kg_per_week, goal_date,
              latitude, uid)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        params![
            input.name,
            b.sex,
            b.birth_date,
            b.height_cm,
            b.activity,
            b.goal_kg_per_week,
            b.goal_date,
            b.latitude,
            input.uid
        ],
    )?;
    let id = ProfileId(tx.last_insert_rowid());
    write_targets(&tx, id, targets)?;
    let profile = written(profile_get(&tx, id)?);
    tx.commit()?;
    Ok(profile)
}

/// Replace a profile's body and name. The weight is the log's: saving a
/// profile never writes it.
pub fn profile_update(
    conn: &mut Connection,
    id: ProfileId,
    input: &ProfileInput,
) -> Result<Profile, Error> {
    let tx = write(conn)?;
    name_free(&tx, &input.name, Some(id))?;
    bump_rev(&tx, "profile", "profile", id.0, input.rev)?;
    let b = &input.body;
    tx.execute(
        "UPDATE profile SET name = ?2, sex = ?3, birth_date = ?4, height_cm = ?5,
             activity = ?6, goal_kg_per_week = ?7, goal_date = ?8, latitude = ?9
         WHERE id = ?1",
        params![
            id,
            input.name,
            b.sex,
            b.birth_date,
            b.height_cm,
            b.activity,
            b.goal_kg_per_week,
            b.goal_date,
            b.latitude
        ],
    )?;
    let profile = written(profile_get(&tx, id)?);
    tx.commit()?;
    Ok(profile)
}

/// Delete a profile with its diary, weights, sessions, imported totals and
/// targets. The last profile stays: every diary needs an owner.
pub fn profile_delete(conn: &mut Connection, id: ProfileId) -> Result<(), Error> {
    let tx = write(conn)?;
    profile_get(&tx, id)?.ok_or_else(|| Error::not_found("profile", id.0))?;
    let count: i64 = tx.query_row("SELECT count(*) FROM profile", [], |r| r.get(0))?;
    if count <= 1 {
        return Err(Error::conflict(
            Conflict::LastProfile,
            "the last profile can't be deleted",
        ));
    }
    tx.execute("DELETE FROM profile WHERE id = ?", [id])?;
    tx.commit()?;
    Ok(())
}

// ------------------------------------------------------------- weights

/// A profile's weights in `[from, to]` (either end open), oldest first.
pub fn weight_list(
    conn: &Connection,
    profile: ProfileId,
    from: Option<&str>,
    to: Option<&str>,
) -> Result<Vec<Weight>, Error> {
    let mut stmt = conn.prepare_cached(&format!(
        "SELECT day, kg FROM weight
         WHERE {IN_RANGE}
         ORDER BY day"
    ))?;
    Ok(stmt
        .query_map(params![profile, from, to], |r| {
            Ok(Weight {
                day: r.get(0)?,
                kg: r.get(1)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?)
}

/// Where `day`'s weight came from, if it has one.
pub fn weight_source(
    conn: &Connection,
    pid: ProfileId,
    day: &str,
) -> Result<Option<WeightSource>, Error> {
    Ok(conn
        .prepare_cached("SELECT source FROM weight WHERE profile_id = ? AND day = ?")?
        .query_row(params![pid, day], |r| r.get(0))
        .optional()?)
}

/// Write `day`'s weight as from `source`, set at `set_at` (epoch ms): for
/// a typed weight, when it was typed. The same weight from the same source
/// again keeps its time.
fn weight_put(
    tx: &Connection,
    pid: ProfileId,
    day: &str,
    kg: f64,
    source: WeightSource,
    set_at: i64,
) -> Result<(), Error> {
    tx.prepare_cached(
        "INSERT INTO weight (profile_id, day, kg, source, set_at) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT (profile_id, day) DO UPDATE SET kg = ?3, source = ?4, set_at = ?5
         WHERE kg IS NOT ?3 OR source IS NOT ?4 OR source = 'hand'",
    )?
    .execute(params![pid, day, kg, source, set_at])?;
    Ok(())
}

/// Derive `day`'s weight again from its readings and what is stored, at
/// `now`, by [`Provenance`]:
/// - the chosen reading ([`scale_chosen`]: the first after the night's wake
///   time in `tz`, the better source first) sets a day without a weight,
///   or a synced one;
/// - a typed weight outranks every reading, but typed later wins: a
///   reading from your own scale ([`TAKES_OVER_TYPED`]) taken after the
///   weight was typed takes the day (one typed before typing times were
///   kept never); one from further down (Health Connect's) never does;
/// - no reading left removes a synced weight, never a typed one.
pub(super) fn day_weight_refresh(
    tx: &Connection,
    pid: ProfileId,
    day: &str,
    now: i64,
    tz: &TimeZone,
) -> Result<(), Error> {
    let chosen = scale_chosen(tx, pid, day, tz)?;
    let row: Option<(WeightSource, Option<i64>)> = tx
        .prepare_cached("SELECT source, set_at FROM weight WHERE profile_id = ? AND day = ?")?
        .query_row(params![pid, day], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()?;
    let typed = |s: WeightSource| Provenance::from(s) == Provenance::Hand;
    match (chosen, row) {
        (Some(r), None) => weight_put(tx, pid, day, r.weight, r.source, now)?,
        (Some(r), Some((stored, _))) if !typed(stored) => {
            weight_put(tx, pid, day, r.weight, r.source, now)?;
        }
        (Some(r), Some((_, Some(set_at))))
            if r.taken_at > set_at && Provenance::from(r.source) <= TAKES_OVER_TYPED =>
        {
            weight_put(tx, pid, day, r.weight, r.source, now)?;
        }
        (None, Some((stored, _))) if !typed(stored) => {
            tx.prepare_cached("DELETE FROM weight WHERE profile_id = ? AND day = ?")?
                .execute(params![pid, day])?;
        }
        _ => {}
    }
    Ok(())
}

/// The lowest-ranked source whose later reading takes a typed weight's day:
/// a scale you stood on after typing. A phone's copy of another app's
/// weigh-in never does.
const TAKES_OVER_TYPED: Provenance = Provenance::OpenScale;

/// A weight typed by hand at `set_at`: only a weigh-in taken after that
/// takes the day over, at once if one is stored already.
fn weight_write(
    tx: &Connection,
    profile: ProfileId,
    day: &str,
    kg: f64,
    set_at: i64,
    tz: &TimeZone,
) -> Result<(), Error> {
    weight_put(tx, profile, day, kg, WeightSource::Hand, set_at)?;
    day_weight_refresh(tx, profile, day, set_at, tz)
}

/// Log `kg` for `day` (replacing that day's), typed at `set_at`; answers
/// with the day's weight as it stands then. Writing the same twice is the
/// same as once.
pub fn weight_set(
    conn: &mut Connection,
    profile: ProfileId,
    day: &str,
    kg: f64,
    set_at: i64,
    tz: &TimeZone,
) -> Result<Weight, Error> {
    let tx = write(conn)?;
    weight_write(&tx, profile, day, kg, set_at, tz)?;
    let weight = written(weight_list(&tx, profile, Some(day), Some(day))?.pop());
    tx.commit()?;
    Ok(weight)
}

/// Remove a typed weight; the day's readings, if any, set it again. An
/// openScale weight goes only with its reading (409 `scale_weight`).
pub fn weight_delete(
    conn: &mut Connection,
    profile: ProfileId,
    day: &str,
    now: i64,
    tz: &TimeZone,
) -> Result<(), Error> {
    let tx = write(conn)?;
    match weight_source(&tx, profile, day)? {
        None => return Err(Error::not_found("weight", day)),
        Some(WeightSource::OpenScale) => {
            return Err(Error::conflict(
                Conflict::ScaleWeight,
                "this weight is from the scale: delete the reading in openScale",
            ));
        }
        Some(WeightSource::HealthConnect) => {
            return Err(Error::conflict(
                Conflict::ScaleWeight,
                "this weight is from Health Connect: delete it there",
            ));
        }
        Some(WeightSource::Hand) => {}
    }
    tx.execute(
        "DELETE FROM weight WHERE profile_id = ? AND day = ?",
        params![profile, day],
    )?;
    day_weight_refresh(&tx, profile, day, now, tz)?;
    tx.commit()?;
    Ok(())
}

// ---------------------------------------------------------- water food

/// The food a profile's "+ Water" logs: its own pick while not archived,
/// else Fineli water (`Vesi`, `Vesi, …`, `Vesijohtovesi`; the shortest
/// name), else a food of your own named "Water". `None` without any.
pub fn water_food_get(conn: &Connection, profile: ProfileId) -> Result<Option<Food>, Error> {
    let id: Option<i64> = conn.query_row(
        "SELECT coalesce(
             (SELECT f.id FROM profile p JOIN food f ON f.id = p.water_food_id
                 WHERE p.id = ?1 AND NOT f.archived),
             (SELECT id FROM food WHERE source = 'fineli' AND NOT archived
                 AND (lower(name) IN ('vesi', 'vesijohtovesi') OR lower(name) LIKE 'vesi, %')
                 AND coalesce(json_extract(per100, '$.water'), 0) >= 99
                 ORDER BY length(name), id LIMIT 1),
             (SELECT id FROM food WHERE source = 'custom' AND NOT archived
                 AND name = 'Water' COLLATE NOCASE ORDER BY id LIMIT 1))",
        [profile],
        |r| r.get(0),
    )?;
    Ok(id.map(|id| food_get(conn, id)).transpose()?.flatten())
}

/// Pick the food "+ Water" logs; `None` goes back to the default. An
/// unknown or archived food is refused (400 `food_id`).
pub fn water_food_set(
    conn: &mut Connection,
    profile: ProfileId,
    food_id: Option<i64>,
) -> Result<Option<Food>, Error> {
    let tx = write(conn)?;
    if let Some(id) = food_id {
        match food_get(&tx, id)? {
            None => {
                return Err(Error::invalid_field(
                    "food_id",
                    format!("unknown food {id}"),
                ));
            }
            Some(f) if f.archived => {
                return Err(Error::invalid_field(
                    "food_id",
                    format!("{} is archived", f.name),
                ));
            }
            Some(_) => {}
        }
    }
    tx.execute(
        "UPDATE profile SET water_food_id = ?2 WHERE id = ?1",
        params![profile, food_id],
    )?;
    // The water food is a drink, unless you said otherwise.
    if let Some(id) = food_id {
        tx.execute(
            "UPDATE food SET drink = 1 WHERE id = ? AND NOT drink_set",
            [id],
        )?;
        super::foods::derive(&tx, id)?;
    }
    let food = water_food_get(&tx, profile)?;
    tx.commit()?;
    Ok(food)
}

/// The water food the profile picked, if any (archived or not).
pub fn water_food_choice(conn: &Connection, profile: ProfileId) -> Result<Option<i64>, Error> {
    Ok(conn.query_row(
        "SELECT water_food_id FROM profile WHERE id = ?",
        [profile],
        |r| r.get(0),
    )?)
}
