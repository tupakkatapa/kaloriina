//! Diary entries, day notes and body measurements, and the totals behind
//! days and summaries.

use super::meal_get;
use super::prelude::*;
use crate::model::{BodyPart, CheckIn, CheckInInput, DayNote, EntryPatch, Measurement};

pub(super) const ENTRY_COLS: &str = "id, day, grp, food_id, name, grams, amount, nutrients, imported, \
     created_at, uid, (SELECT source FROM food WHERE food.id = entry.food_id), serving, quantity, \
     time";

/// A text column holding one of a text enum's names.
fn named<T>(r: &Row, i: usize, parse: fn(&str) -> Option<T>) -> rusqlite::Result<T> {
    let text: String = r.get(i)?;
    parse(&text).ok_or_else(|| {
        rusqlite::Error::FromSqlConversionFailure(
            i,
            rusqlite::types::Type::Text,
            format!("unknown value {text:?}").into(),
        )
    })
}

pub(super) fn entry_row(r: &Row) -> rusqlite::Result<Entry> {
    Ok(Entry {
        id: r.get(0)?,
        day: r.get(1)?,
        group: r.get(2)?,
        food_id: r.get(3)?,
        name: r.get(4)?,
        grams: r.get(5)?,
        amount: r.get(6)?,
        nutrients: r
            .get::<_, Option<String>>(7)?
            .as_deref()
            .map(from_json)
            .transpose()?,
        imported: r.get(8)?,
        created_at: r.get(9)?,
        uid: r.get(10)?,
        source: r.get(11)?,
        serving: r.get(12)?,
        quantity: r.get(13)?,
        time: r.get(14)?,
    })
}

/// The entries an earlier write with `uid` logged (a food: one; a meal or
/// copies: one per item, `uid:1`, `uid:2`, …), oldest first.
fn logged_as(conn: &Connection, profile: ProfileId, uid: &str) -> Result<Vec<Entry>, Error> {
    let mut stmt = conn.prepare_cached(&format!(
        "SELECT {ENTRY_COLS} FROM entry
         WHERE profile_id = ?1
           AND (uid = ?2 OR substr(uid, 1, length(?2) + 1) = ?2 || ':')
         ORDER BY id"
    ))?;
    Ok(stmt
        .query_map(params![profile, uid], entry_row)?
        .collect::<rusqlite::Result<_>>()?)
}

/// Where a log writes: a profile's day and group, with the client's `uid`
/// for the write and the time of day it gives every entry.
#[derive(Debug, Clone, Copy)]
pub struct Slot<'a> {
    pub profile: ProfileId,
    pub day: &'a str,
    pub group: &'a str,
    pub uid: Option<&'a str>,
    pub time: Option<&'a str>,
}

impl Slot<'_> {
    /// What a write with this `uid` logged before, if one did: a retried
    /// request answers with that and logs nothing more.
    fn logged_before(&self, conn: &Connection) -> Result<Option<Vec<Entry>>, Error> {
        let Some(uid) = self.uid else {
            return Ok(None);
        };
        let earlier = logged_as(conn, self.profile, uid)?;
        Ok((!earlier.is_empty()).then_some(earlier))
    }

    /// Item `i` (from 0) of a write logging several: `uid:1`, `uid:2`, ….
    fn item_uid(&self, i: usize) -> Option<String> {
        self.uid.map(|u| format!("{u}:{}", i + 1))
    }
}

/// One entry's own columns, as written.
struct NewEntry<'a> {
    food_id: Option<i64>,
    name: &'a str,
    grams: Option<f64>,
    amount: &'a str,
    nutrients: Option<&'a Nutrients>,
    serving: Option<&'a str>,
    quantity: Option<f64>,
}

fn insert_entry(
    conn: &Connection,
    at: &Slot,
    e: &NewEntry,
    uid: Option<&str>,
) -> Result<Entry, Error> {
    conn.execute(
        "INSERT INTO entry (profile_id, day, grp, food_id, name, grams, amount, nutrients,
             serving, quantity, uid, time)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        params![
            at.profile,
            at.day,
            at.group,
            e.food_id,
            e.name,
            e.grams,
            e.amount,
            e.nutrients.map(json),
            e.serving,
            e.quantity,
            uid,
            at.time
        ],
    )?;
    Ok(written(entry_get(
        conn,
        at.profile,
        conn.last_insert_rowid(),
    )?))
}

/// An amount of `food`, its nutrients snapshotted.
fn food_entry(
    conn: &Connection,
    at: &Slot,
    food: &Food,
    m: &Measured,
    uid: Option<&str>,
) -> Result<Entry, Error> {
    let nutrients = food.per100.scale(m.grams / 100.0);
    insert_entry(
        conn,
        at,
        &NewEntry {
            food_id: Some(food.id),
            name: &food.name,
            grams: Some(m.grams),
            amount: &m.amount,
            nutrients: Some(&nutrients),
            serving: m.serving.as_deref(),
            quantity: m.quantity,
        },
        uid,
    )
}

/// Log an amount of `food`, snapshotting its nutrients. A `uid` logged
/// before answers with that entry instead (a retried request logs once).
pub fn entry_log(
    conn: &mut Connection,
    at: &Slot,
    food: &Food,
    m: &Measured,
) -> Result<Entry, Error> {
    let tx = write(conn)?;
    if let Some(earlier) = at.logged_before(&tx)? {
        return Ok(written(earlier.into_iter().next()));
    }
    let entry = food_entry(&tx, at, food, m, at.uid)?;
    tx.commit()?;
    Ok(entry)
}

/// Log every item of a meal, times `portions`, as entries of their own.
/// Like [`entry_log`], a `uid` logged before answers with those entries.
pub fn entry_log_meal(
    conn: &mut Connection,
    at: &Slot,
    meal_id: i64,
    portions: f64,
) -> Result<Vec<Entry>, Error> {
    let tx = write(conn)?;
    if let Some(earlier) = at.logged_before(&tx)? {
        return Ok(earlier);
    }
    let meal = meal_get(&tx, meal_id)?
        .ok_or_else(|| Error::invalid_field("meal_id", format!("unknown meal {meal_id}")))?;
    let mut entries = Vec::new();
    for (i, item) in meal.items.iter().enumerate() {
        // Meal items reference foods by foreign key, so the food exists.
        let food = written(food_get(&tx, item.food_id)?);
        let grams = crate::model::grams(item.grams * portions)?;
        let m = Measured {
            grams,
            serving: None,
            quantity: None,
            amount: gram_amount(grams),
        };
        entries.push(food_entry(&tx, at, &food, &m, at.item_uid(i).as_deref())?);
    }
    tx.commit()?;
    Ok(entries)
}

/// Log copies of entries of the profile, in the order given: each one's
/// snapshot (food, name, amount and nutrients), not its time. Like
/// [`entry_log_meal`], a `uid` logged before answers with those entries.
///
/// # Errors
/// An id that isn't the profile's entry (400 `entry_ids`); imported history,
/// which has no nutrients of its own (409).
pub fn entry_copy(conn: &mut Connection, at: &Slot, ids: &[i64]) -> Result<Vec<Entry>, Error> {
    let tx = write(conn)?;
    if let Some(earlier) = at.logged_before(&tx)? {
        return Ok(earlier);
    }
    let mut entries = Vec::new();
    for (i, &id) in ids.iter().enumerate() {
        let from = entry_get(&tx, at.profile, id)?
            .ok_or_else(|| Error::invalid_field("entry_ids", format!("unknown entry {id}")))?;
        if from.imported {
            return Err(Error::conflict(
                Conflict::ImportedReadOnly,
                "imported entries can't be copied",
            ));
        }
        let copy = NewEntry {
            food_id: from.food_id,
            name: &from.name,
            grams: from.grams,
            amount: &from.amount,
            nutrients: from.nutrients.as_ref(),
            serving: from.serving.as_deref(),
            quantity: from.quantity,
        };
        entries.push(insert_entry(&tx, at, &copy, at.item_uid(i).as_deref())?);
    }
    tx.commit()?;
    Ok(entries)
}

/// An entry of `profile`; another profile's entry reads as missing.
pub fn entry_get(conn: &Connection, profile: ProfileId, id: i64) -> Result<Option<Entry>, Error> {
    Ok(conn
        .query_row(
            &format!("SELECT {ENTRY_COLS} FROM entry WHERE id = ? AND profile_id = ?"),
            params![id, profile],
            entry_row,
        )
        .optional()?)
}

/// Change a logged entry (a checked patch): move it to another group,
/// re-measure it, set or clear its time. A new amount rescales the snapshot, so history never
/// picks up later edits to the food (whose servings measure it). Imported
/// rows can only move.
pub fn entry_update(
    conn: &mut Connection,
    profile: ProfileId,
    id: i64,
    patch: &EntryPatch,
) -> Result<Entry, Error> {
    let tx = write(conn)?;
    let entry = entry_get(&tx, profile, id)?.ok_or_else(|| Error::not_found("entry", id))?;
    let re_measured = patch.re_measures();
    // Imported rows have no nutrients of their own (see `group_totals`), so
    // they can only move.
    if entry.imported && (re_measured || patch.time != crate::model::Nullable::Keep) {
        return Err(Error::conflict(
            Conflict::ImportedReadOnly,
            "imported entries can only move between groups",
        ));
    }
    // Past the check above, an entry is your own: since migration 31 it
    // always has a food, grams (> 0) and nutrients.
    let measured = if re_measured {
        let food_id = entry.food_id.expect("an own entry has a food");
        Some(patch.amount.of(&written(food_get(&tx, food_id)?))?)
    } else {
        None
    };
    let nutrients = match &measured {
        Some(m) => {
            let old = entry.grams.expect("an own entry has grams");
            let n = entry
                .nutrients
                .as_ref()
                .expect("an own entry has nutrients");
            Some(n.scale(m.grams / old))
        }
        None => entry.nutrients.clone(),
    };
    tx.execute(
        "UPDATE entry SET grp = ?, grams = ?, amount = ?, nutrients = ?, serving = ?,
             quantity = ?, time = ?
         WHERE id = ?",
        params![
            patch.group.as_deref().unwrap_or(&entry.group),
            measured.as_ref().map_or(entry.grams, |m| Some(m.grams)),
            measured.as_ref().map_or(&entry.amount, |m| &m.amount),
            nutrients.as_ref().map(json),
            measured
                .as_ref()
                .map_or(entry.serving.as_ref(), |m| m.serving.as_ref()),
            measured.as_ref().map_or(entry.quantity, |m| m.quantity),
            patch.time.clone().applied(entry.time),
            id
        ],
    )?;
    let entry = written(entry_get(&tx, profile, id)?);
    tx.commit()?;
    Ok(entry)
}
pub fn entry_delete(conn: &Connection, profile: ProfileId, id: i64) -> Result<(), Error> {
    let entry = entry_get(conn, profile, id)?.ok_or_else(|| Error::not_found("entry", id))?;
    // An imported row's nutrients live in its group's day total; deleting it
    // would leave that total behind.
    if entry.imported {
        return Err(Error::conflict(
            Conflict::ImportedReadOnly,
            "imported entries can't be deleted",
        ));
    }
    conn.execute("DELETE FROM entry WHERE id = ?", [id])?;
    Ok(())
}

pub fn entry_list_for_day(
    conn: &Connection,
    profile: ProfileId,
    day: &str,
) -> Result<Vec<Entry>, Error> {
    let mut stmt = conn.prepare_cached(&format!(
        "SELECT {ENTRY_COLS} FROM entry WHERE profile_id = ? AND day = ? ORDER BY id"
    ))?;
    Ok(stmt
        .query_map(params![profile, day], entry_row)?
        .collect::<rusqlite::Result<_>>()?)
}

/// One stored total: day, group and its nutrients as JSON, unparsed.
pub type GroupRow = (String, String, String);

/// The stored totals behind days and groups in `[from, to]`: entry
/// snapshots plus imported group totals. Kept as text so they can be parsed
/// ([`group_sums`]) after the connection is released.
pub fn group_rows(
    conn: &Connection,
    profile: ProfileId,
    from: &str,
    to: &str,
) -> Result<Vec<GroupRow>, Error> {
    let mut stmt = conn.prepare_cached(
        "SELECT day, grp, nutrients FROM entry
         WHERE profile_id = ?3 AND day BETWEEN ?1 AND ?2 AND nutrients IS NOT NULL
         UNION ALL
         -- An imported total belongs to the group all its imported rows are
         -- in now; while they are split (or there are none) it stays where
         -- it was imported.
         SELECT d.day,
             coalesce((SELECT CASE WHEN count(DISTINCT e.grp) = 1 THEN min(e.grp) END
                       FROM entry e
                       WHERE e.profile_id = d.profile_id AND e.day = d.day
                           AND e.imported AND e.src_grp = d.grp), d.grp),
             d.nutrients
         FROM day_total d
         WHERE d.profile_id = ?3 AND d.day BETWEEN ?1 AND ?2",
    )?;
    Ok(stmt
        .query_map(params![from, to, profile], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })?
        .collect::<rusqlite::Result<_>>()?)
}

/// Totals per (day, group).
///
/// # Errors
/// A stored total isn't valid JSON.
pub fn group_sums(rows: Vec<GroupRow>) -> Result<BTreeMap<(String, String), Nutrients>, Error> {
    let mut out: BTreeMap<(String, String), Nutrients> = BTreeMap::new();
    for (day, group, text) in rows {
        let n: Nutrients = from_json(&text)?;
        out.entry((day, group)).or_default().add(&n);
    }
    Ok(out)
}

/// Totals per (day, group) in `[from, to]`.
pub fn group_totals(
    conn: &Connection,
    profile: ProfileId,
    from: &str,
    to: &str,
) -> Result<BTreeMap<(String, String), Nutrients>, Error> {
    group_sums(group_rows(conn, profile, from, to)?)
}

// ------------------------------------------------- notes and measurements

/// A profile's day notes in `[from, to]` (either end open), oldest first.
pub fn note_list(
    conn: &Connection,
    profile: ProfileId,
    from: Option<&str>,
    to: Option<&str>,
) -> Result<Vec<DayNote>, Error> {
    let mut stmt = conn.prepare_cached(
        "SELECT day, text FROM day_note
         WHERE profile_id = ?1 AND (?2 IS NULL OR day >= ?2) AND (?3 IS NULL OR day <= ?3)
         ORDER BY day",
    )?;
    Ok(stmt
        .query_map(params![profile, from, to], |r| {
            Ok(DayNote {
                day: r.get(0)?,
                text: r.get(1)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?)
}

/// Write `day`'s note, replacing the one it had. Writing the same twice is
/// the same as once.
pub fn note_set(
    conn: &Connection,
    profile: ProfileId,
    day: &str,
    text: &str,
) -> Result<DayNote, Error> {
    conn.execute(
        "INSERT INTO day_note (profile_id, day, text) VALUES (?1, ?2, ?3)
         ON CONFLICT (profile_id, day) DO UPDATE SET text = ?3",
        params![profile, day, text],
    )?;
    Ok(DayNote {
        day: day.to_owned(),
        text: text.to_owned(),
    })
}

pub fn note_delete(conn: &Connection, profile: ProfileId, day: &str) -> Result<(), Error> {
    let n = conn.execute(
        "DELETE FROM day_note WHERE profile_id = ? AND day = ?",
        params![profile, day],
    )?;
    if n == 0 {
        return Err(Error::not_found("note", day));
    }
    Ok(())
}

// ----------------------------------------------------------- check-ins

/// A profile's check-ins in `[from, to]` (either end open), oldest first.
pub fn check_in_list(
    conn: &Connection,
    profile: ProfileId,
    from: Option<&str>,
    to: Option<&str>,
) -> Result<Vec<CheckIn>, Error> {
    let mut stmt = conn.prepare_cached(
        "SELECT day, mood, energy, stress, tags FROM check_in
         WHERE profile_id = ?1 AND (?2 IS NULL OR day >= ?2) AND (?3 IS NULL OR day <= ?3)
         ORDER BY day",
    )?;
    Ok(stmt
        .query_map(params![profile, from, to], |r| {
            Ok(CheckIn {
                day: r.get(0)?,
                mood: r.get(1)?,
                energy: r.get(2)?,
                stress: r.get(3)?,
                tags: from_json(&r.get::<_, String>(4)?)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?)
}

/// Write `day`'s check-in whole, replacing the one it had: a checked
/// input, so the same twice is the same as once.
pub fn check_in_set(
    conn: &Connection,
    profile: ProfileId,
    day: &str,
    c: &CheckInInput,
) -> Result<CheckIn, Error> {
    conn.execute(
        "INSERT INTO check_in (profile_id, day, mood, energy, stress, tags)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT (profile_id, day) DO UPDATE
             SET mood = ?3, energy = ?4, stress = ?5, tags = ?6",
        params![profile, day, c.mood, c.energy, c.stress, json(&c.tags)],
    )?;
    Ok(CheckIn {
        day: day.to_owned(),
        mood: c.mood,
        energy: c.energy,
        stress: c.stress,
        tags: c.tags.clone(),
    })
}

pub fn check_in_delete(conn: &Connection, profile: ProfileId, day: &str) -> Result<(), Error> {
    let n = conn.execute(
        "DELETE FROM check_in WHERE profile_id = ? AND day = ?",
        params![profile, day],
    )?;
    if n == 0 {
        return Err(Error::not_found("check_in", day));
    }
    Ok(())
}

/// A profile's measurements in `[from, to]` (either end open), by day, then
/// in [`BodyPart`] order.
pub fn measurement_list(
    conn: &Connection,
    profile: ProfileId,
    from: Option<&str>,
    to: Option<&str>,
) -> Result<Vec<Measurement>, Error> {
    let mut stmt = conn.prepare_cached(
        "SELECT day, kind, value FROM measurement
         WHERE profile_id = ?1 AND (?2 IS NULL OR day >= ?2) AND (?3 IS NULL OR day <= ?3)
         ORDER BY day",
    )?;
    let mut list: Vec<Measurement> = stmt
        .query_map(params![profile, from, to], |r| {
            Ok(Measurement {
                day: r.get(0)?,
                kind: named(r, 1, BodyPart::parse)?,
                value: r.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    list.sort_by(|a, b| (&a.day, a.kind).cmp(&(&b.day, b.kind)));
    Ok(list)
}

/// Write `day`'s measurement of `kind`, replacing the one it had.
pub fn measurement_set(
    conn: &Connection,
    profile: ProfileId,
    day: &str,
    kind: BodyPart,
    value: f64,
) -> Result<Measurement, Error> {
    conn.execute(
        "INSERT INTO measurement (profile_id, day, kind, value) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (profile_id, day, kind) DO UPDATE SET value = ?4",
        params![profile, day, kind.as_str(), value],
    )?;
    Ok(Measurement {
        day: day.to_owned(),
        kind,
        value,
    })
}

pub fn measurement_delete(
    conn: &Connection,
    profile: ProfileId,
    day: &str,
    kind: BodyPart,
) -> Result<(), Error> {
    let n = conn.execute(
        "DELETE FROM measurement WHERE profile_id = ? AND day = ? AND kind = ?",
        params![profile, day, kind.as_str()],
    )?;
    if n == 0 {
        return Err(Error::not_found(
            "measurement",
            format!("{day} {}", kind.as_str()),
        ));
    }
    Ok(())
}
