//! Diary entries, day notes and body measurements, and the totals behind
//! days and summaries.

use super::prelude::*;
use crate::model::{
    BORNE, BodyPart, BodyValue, Borne, BuiltinValue, CheckIn, CheckInInput, Composition,
    DAILY_ITEMS_MAX, DRY, DailyDays, DayNote, DayView, EntryKey, EntryKind, EntryPatch, Facts,
    GROUPS, Group, HabitValue, InsightPref, Known, Measurement, Nullable, PLANNED, Ratings, Repeat,
    RepeatInput, Source, borne_weight, dry_of, eaten, known_from, macro_dry, share,
};
use crate::nutrients::KNOWN;
use std::collections::btree_map;

pub(super) const ENTRY_COLS: &str = "id, day, grp, food_id, name, grams, amount, nutrients, \
     created_at, uid, (SELECT source FROM food WHERE food.id = entry.food_id), serving, quantity, \
     CASE WHEN grp = 'Planned' THEN NULL ELSE time END, \
     coalesce((SELECT basis_estimated FROM food WHERE food.id = entry.food_id), 0), \
     daily_item_id, src_grp, (SELECT start FROM daily_item d WHERE d.id = entry.daily_item_id), \
     coalesce((SELECT drink AND kind = 'food' AND source <> 'fineli' FROM food \
         WHERE food.id = entry.food_id), 0)";

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
    let id: i64 = r.get(0)?;
    let src_group: Option<String> = r.get(16)?;
    Ok(Entry {
        kind: if src_group.is_some() {
            EntryKind::Imported
        } else {
            EntryKind::Own
        },
        id: Some(id),
        key: id.to_string(),
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
        created_at: r.get(8)?,
        uid: r.get(9)?,
        source: r.get(10)?,
        serving: r.get(11)?,
        quantity: r.get(12)?,
        time: r.get(13)?,
        weight_estimated: r.get(14)?,
        repeat: match (r.get(15)?, r.get(17)?) {
            (Some(id), Some(start)) => Some(Repeat { id, start }),
            _ => None,
        },
        src_group,
        by_volume: r.get(18)?,
    })
}

/// The entries an earlier write with `uid` logged (a food: one; copies:
/// one per item, `uid:1`, `uid:2`, …), oldest first.
fn logged_as(conn: &Connection, pid: ProfileId, uid: &str) -> Result<Vec<Entry>, Error> {
    let mut stmt = conn.prepare_cached(&format!(
        "SELECT {ENTRY_COLS} FROM entry
         WHERE profile_id = ?1
           AND (uid = ?2 OR substr(uid, 1, length(?2) + 1) = ?2 || ':')
         ORDER BY id"
    ))?;
    Ok(stmt
        .query_map(params![pid, uid], entry_row)?
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
    daily_item_id: Option<i64>,
}

/// An entry's time is when it was eaten: in Planned it has none, however
/// it got there (a move, a log, a replayed offline write). Rows from before
/// read untimed there too (`ENTRY_COLS`), so a move back never revives one.
fn untimed_if_planned<T>(group: &str, time: Option<T>) -> Option<T> {
    time.filter(|_| group != PLANNED)
}

fn insert_entry(
    conn: &Connection,
    at: &Slot,
    e: &NewEntry,
    uid: Option<&str>,
) -> Result<Entry, Error> {
    conn.execute(
        "INSERT INTO entry (profile_id, day, grp, food_id, name, grams, amount, nutrients,
             serving, quantity, uid, time, daily_item_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
            untimed_if_planned(at.group, at.time),
            e.daily_item_id
        ],
    )?;
    Ok(written(entry_get(
        conn,
        at.profile,
        conn.last_insert_rowid(),
    )?))
}

/// An amount of `food`, its nutrients stored (they follow the food,
/// [`super::foods::entries_follow`]); a daily item's tick
/// when `daily_item_id` is given.
fn food_entry(
    conn: &Connection,
    at: &Slot,
    food: &Food,
    m: &Measured,
    uid: Option<&str>,
    daily_item_id: Option<i64>,
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
            daily_item_id,
        },
        uid,
    )
}

/// Log an amount of `food`, storing its nutrients; with `repeat`, it
/// starts a series as [`entry_update`] does. A `uid` logged before answers
/// with that entry instead (a retried request logs once).
///
/// # Errors
/// 400 at [`DAILY_ITEMS_MAX`].
pub fn entry_log(
    conn: &mut Connection,
    at: &Slot,
    food: &Food,
    m: &Measured,
    repeat: Option<&RepeatInput>,
) -> Result<Entry, Error> {
    let tx = write(conn)?;
    if let Some(earlier) = at.logged_before(&tx)? {
        return Ok(written(earlier.into_iter().next()));
    }
    let mut entry = food_entry(&tx, at, food, m, at.uid, None)?;
    if let Some(RepeatInput { start }) = repeat {
        let id = tx.last_insert_rowid();
        repeat_start(&tx, at.profile, &entry, start.as_deref().unwrap_or(at.day))?;
        entry = written(entry_get(&tx, at.profile, id)?);
    }
    tx.commit()?;
    Ok(entry)
}

/// Log a text entry: `name`, with its kcal and macros as far as known, no
/// food behind it. Like [`entry_log`], a `uid` logged before answers with
/// that entry.
pub fn entry_text(
    conn: &mut Connection,
    at: &Slot,
    name: &str,
    nutrients: Option<&Nutrients>,
) -> Result<Entry, Error> {
    let tx = write(conn)?;
    if let Some(earlier) = at.logged_before(&tx)? {
        return Ok(written(earlier.into_iter().next()));
    }
    let entry = insert_entry(
        &tx,
        at,
        &NewEntry {
            food_id: None,
            name,
            grams: None,
            amount: "",
            nutrients,
            serving: None,
            quantity: None,
            daily_item_id: None,
        },
        at.uid,
    )?;
    tx.commit()?;
    Ok(entry)
}

/// Log copies of entries of the profile, in the order given: each one's
/// snapshot (food, name, amount and nutrients), not its time. Like
/// [`entry_log`], a `uid` logged before answers with those entries.
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
        if from.imported() {
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
            // A copy is a dose of its own (ADR 0023).
            daily_item_id: None,
        };
        entries.push(insert_entry(&tx, at, &copy, at.item_uid(i).as_deref())?);
    }
    tx.commit()?;
    Ok(entries)
}

/// An entry of `pid`; another profile's entry reads as missing.
pub fn entry_get(conn: &Connection, pid: ProfileId, id: i64) -> Result<Option<Entry>, Error> {
    Ok(conn
        .query_row(
            &format!("SELECT {ENTRY_COLS} FROM entry WHERE id = ? AND profile_id = ?"),
            params![id, pid],
            entry_row,
        )
        .optional()?)
}

/// Imported rows have no food or nutrients of their own (see
/// `group_totals`), so they can only move.
fn read_only() -> Error {
    Error::conflict(
        Conflict::ImportedReadOnly,
        "imported entries can only move between groups",
    )
}

/// Whether `patch` fits `entry`: imported rows only move; a text
/// entry's name and kcal, its food found once, only on one (elsewhere
/// ignored). A text entry's patch, checked.
fn patch_fits(entry: &Entry, patch: &EntryPatch) -> Result<Option<EntryPatch>, Error> {
    if entry.imported() {
        return if patch.time == Nullable::Keep && patch.repeat == Nullable::Keep {
            Ok(None)
        } else {
            Err(read_only())
        };
    }
    if entry.food_id.is_some() {
        return Ok(None);
    }
    if patch.food_id.is_none() {
        if matches!(patch.repeat, Nullable::Set(_)) {
            return Err(Error::invalid_field("repeat", "only a food repeats daily"));
        }
        if patch.re_measures() {
            return Err(Error::invalid_field(
                "grams",
                "a text entry has no amount: find its food to give one",
            ));
        }
    }
    patch.clone().retexted().map(Some)
}

/// Change a logged entry (a checked patch): move it to another group,
/// re-measure it, set or clear its time, repeat it daily or stop its
/// series. A new amount rescales its values (the food's, which
/// [`super::foods::entries_follow`] keeps them at; its servings measure it).
/// A text entry is renamed or its kcal changed, or with `food_id` and an
/// amount becomes that food's entry, the same row; a food's entry keeps
/// its food, name and values (`food_id`, `name` and `energy` on it are
/// ignored). Imported rows can only move.
///
/// # Errors
/// 404, 409 `imported_read_only`, 409 `already_daily`, 400 at
/// [`DAILY_ITEMS_MAX`], a bad amount or food, or a text entry's bad name
/// or energy, or amount or repeat without its food.
pub fn entry_update(
    conn: &mut Connection,
    pid: ProfileId,
    id: i64,
    patch: &EntryPatch,
) -> Result<Entry, Error> {
    let tx = write(conn)?;
    let entry = entry_get(&tx, pid, id)?.ok_or_else(|| Error::not_found("entry", id))?;
    let retexted = patch_fits(&entry, patch)?;
    let text = retexted.is_some();
    let patch = retexted.as_ref().unwrap_or(patch);
    let found =
        match patch.food_id {
            Some(food_id) if text => Some(food_get(&tx, food_id)?.ok_or_else(|| {
                Error::invalid_field("food_id", format!("unknown food {food_id}"))
            })?),
            _ => None,
        };
    let (measured, nutrients) = match (
        &found,
        patch.re_measures(),
        entry.food_id,
        entry.grams,
        &entry.nutrients,
    ) {
        (Some(food), ..) => {
            let m = patch.amount.of(food)?;
            let n = food.per100.scale(m.grams / 100.0);
            (Some(m), Some(n))
        }
        (None, false, ..) if text => {
            let mut n = entry.nutrients.clone().unwrap_or_default();
            for (key, v) in patch.text_values() {
                match v {
                    Nullable::Keep => {}
                    Nullable::Clear => n = n.without(key),
                    Nullable::Set(v) => n.insert(key, *v),
                }
            }
            (None, (!n.is_empty()).then_some(n))
        }
        (None, false, ..) => (None, entry.nutrients.clone()),
        (None, true, Some(food_id), Some(old), Some(n)) => {
            let m = patch.amount.of(&written(food_get(&tx, food_id)?))?;
            let n = n.scale(m.grams / old);
            (Some(m), Some(n))
        }
        (None, true, ..) => return Err(read_only()),
    };
    let group = patch.group.as_deref().unwrap_or(&entry.group);
    let name = match (&found, &patch.name) {
        (Some(food), _) => &food.name,
        (None, Some(name)) if text => name,
        _ => &entry.name,
    };
    tx.execute(
        "UPDATE entry SET grp = ?, grams = ?, amount = ?, nutrients = ?, serving = ?,
             quantity = ?, time = ?, food_id = ?, name = ?
         WHERE id = ?",
        params![
            group,
            measured.as_ref().map_or(entry.grams, |m| Some(m.grams)),
            measured.as_ref().map_or(&entry.amount, |m| &m.amount),
            nutrients.as_ref().map(json),
            measured
                .as_ref()
                .map_or(entry.serving.as_ref(), |m| m.serving.as_ref()),
            measured.as_ref().map_or(entry.quantity, |m| m.quantity),
            untimed_if_planned(group, patch.time.clone().applied(entry.time)),
            found.as_ref().map_or(entry.food_id, |f| Some(f.id)),
            name,
            id
        ],
    )?;
    let entry = written(entry_get(&tx, pid, id)?);
    match (&patch.repeat, &entry.repeat) {
        (Nullable::Set(RepeatInput { start }), None) => {
            repeat_start(&tx, pid, &entry, start.as_deref().unwrap_or(&entry.day))?;
        }
        (Nullable::Set(_), Some(_)) => {
            return Err(Error::conflict(
                Conflict::AlreadyDaily,
                format!("{} already repeats daily", entry.name),
            ));
        }
        (Nullable::Clear, Some(r)) => series_delete(&tx, r.id)?,
        _ => {}
    }
    let entry = written(entry_get(&tx, pid, id)?);
    tx.commit()?;
    Ok(entry)
}

pub fn entry_delete(conn: &Connection, pid: ProfileId, id: i64) -> Result<(), Error> {
    let entry = entry_get(conn, pid, id)?.ok_or_else(|| Error::not_found("entry", id))?;
    // An imported row's nutrients live in its group's day total; deleting it
    // would leave that total behind. History goes a group at a time
    // ([`imported_group_delete`]).
    if entry.imported() {
        return Err(Error::conflict(
            Conflict::ImportedReadOnly,
            "imported entries can't be deleted",
        ));
    }
    conn.execute("DELETE FROM entry WHERE id = ?", [id])?;
    Ok(())
}

/// Remove a day's imported history of one import group: its rows and its
/// total together, so the day's totals stay honest. Repeating it, or naming
/// a group with none, changes nothing.
pub fn imported_group_delete(
    conn: &mut Connection,
    pid: ProfileId,
    day: &str,
    group: &str,
) -> Result<(), Error> {
    let tx = write(conn)?;
    tx.execute(
        "DELETE FROM entry WHERE profile_id = ? AND day = ? AND src_grp = ?",
        params![pid, day, group],
    )?;
    tx.execute(
        "DELETE FROM day_total WHERE profile_id = ? AND day = ? AND grp = ?",
        params![pid, day, group],
    )?;
    tx.commit()?;
    Ok(())
}

/// A day's entries: eaten ones by the time eaten (the day runs to 03:00,
/// so 00:00–02:59 read as 24:00–26:59; untimed last), then as added;
/// Planned's as added.
pub fn entry_list_for_day(
    conn: &Connection,
    pid: ProfileId,
    day: &str,
) -> Result<Vec<Entry>, Error> {
    let mut stmt = conn.prepare_cached(&format!(
        "SELECT {ENTRY_COLS} FROM entry WHERE profile_id = ? AND day = ?
         ORDER BY CASE WHEN grp = '{PLANNED}' THEN ''
                       WHEN time < '03:00' THEN (substr(time, 1, 2) + 24) || substr(time, 3)
                       ELSE coalesce(time, '99:99') END, id"
    ))?;
    Ok(stmt
        .query_map(params![pid, day], entry_row)?
        .collect::<rusqlite::Result<_>>()?)
}

/// One stored total: day, group and its nutrients as JSON, unparsed.
pub type GroupRow = (String, String, String);

/// The group an imported total (`day_total d`) belongs to: the one all
/// its imported rows are in now; while they are split (or there are none),
/// the one it was imported to.
macro_rules! imported_group {
    () => {
        "coalesce((SELECT CASE WHEN count(DISTINCT e.grp) = 1 THEN min(e.grp) END
                   FROM entry e
                   WHERE e.profile_id = d.profile_id AND e.day = d.day
                       AND e.src_grp = d.grp), d.grp)"
    };
}

/// [`group_rows`]' query, columns `day, grp, nutrients`, then what
/// [`eaten_rows`] reads: `recipe` (an entry's food, when a recipe),
/// `imported` (an imported total), the entry's grams and its food's
/// drink flag, source, Fineli class and name (coverage, ADR 0030), and
/// `text` (a text entry: no food): `?1` from, `?2` to, `?3` the profile.
pub const GROUP_ROWS: &str = concat!(
    "SELECT entry.day, entry.grp, entry.nutrients,
         CASE WHEN f.kind = 'recipe' THEN f.id END AS recipe,
         0 AS imported, coalesce(entry.grams, 0), coalesce(f.drink, 0),
         coalesce(f.source, 'custom'), f.fineli_class, coalesce(f.name, entry.name),
         entry.food_id IS NULL AS text
     FROM entry LEFT JOIN food f ON f.id = entry.food_id
     WHERE entry.profile_id = ?3 AND entry.day BETWEEN ?1 AND ?2
         AND entry.nutrients IS NOT NULL
     UNION ALL
     SELECT d.day, ",
    imported_group!(),
    ", d.nutrients, NULL, 1, 0, 0, 'custom', NULL, '', 0
     FROM day_total d
     WHERE d.profile_id = ?3 AND d.day BETWEEN ?1 AND ?2"
);

/// The stored totals behind days and groups in `[from, to]`: entry
/// snapshots plus imported group totals. Kept as text so they can be parsed
/// ([`group_sums`]) after the connection is released.
pub fn group_rows(
    conn: &Connection,
    pid: ProfileId,
    from: &str,
    to: &str,
) -> Result<Vec<GroupRow>, Error> {
    let mut stmt = conn.prepare_cached(GROUP_ROWS)?;
    Ok(stmt
        .query_map(params![from, to, pid], |r| {
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

/// A day's eaten total and its [`Known`] (see [`eaten_days`]).
pub type EatenDay = (Nutrients, Known);

/// What an imported total's values can be trusted for: a diary export
/// writes 0 or a partial sum for a nutrient some of its foods lacked, and
/// can't say so; energy and the macros every food has.
const IMPORT_KNOWN: [&str; 6] = ["energy", "protein", "carbs", "net_carbs", "fat", "alcohol"];

/// How a stored total's keys are known (ADR 0030): an entry of a food, in
/// full for what it carries, with its drink flag and what a gram of it
/// weighs for each [`BORNE`] key where it doesn't carry it
/// ([`borne_weight`]); a recipe's, as far as
/// its own are (its [`Known`] shares, dry matter and [`Borne`] per
/// 100 g); imported, only for [`IMPORT_KNOWN`]; a text entry, only for its
/// energy, over the dry matter it stands for ([`text_dry`]).
#[derive(Debug, Clone)]
pub enum RowBasis {
    Food {
        drink: bool,
        borne: [f64; BORNE.len()],
    },
    Recipe(std::sync::Arc<Cover>),
    Imported,
    Text,
}

/// kcal a gram of dry matter, the mean of the macronutrients'.
/// ponytail: Atwater's mean overstates the dry matter of fatty food; a
/// typed dry weight on a text entry if it matters.
const KCAL_PER_DRY_G: f64 = 4.0;

/// The dry matter a text entry stands for: its macros', or its kcal's.
#[must_use]
pub fn text_dry(n: &Nutrients) -> f64 {
    if ["protein", "carbs", "fat"]
        .iter()
        .any(|k| n.get(k).is_some())
    {
        macro_dry(n)
    } else {
        n.get("energy").unwrap_or(0.0) / KCAL_PER_DRY_G
    }
}

/// A recipe's coverage as an entry of it reads it: its [`Known`] and
/// [`Borne`] per 100 g, and its hydration a gram.
#[derive(Debug, Clone)]
pub struct Cover {
    pub known: Known,
    pub borne: Borne,
    pub hydrates: super::Hydrates,
}

/// A stored total ([`GroupRow`]) with its grams and [`RowBasis`].
#[derive(Debug, Clone)]
pub struct EatenRow {
    pub day: String,
    pub group: String,
    pub text: String,
    pub grams: f64,
    pub basis: RowBasis,
}

/// The stored totals in `[from, to]` as [`group_rows`] reads them, each
/// with how far it is known: a recipe's coverage is read as it is now.
///
/// # Errors
/// A read fails.
pub fn eaten_rows(
    conn: &Connection,
    pid: ProfileId,
    from: &str,
    to: &str,
) -> Result<Vec<EatenRow>, Error> {
    /// A row of [`GROUP_ROWS`].
    struct Read {
        day: String,
        group: String,
        text: String,
        recipe: Option<i64>,
        imported: bool,
        grams: f64,
        drink: bool,
        source: Source,
        class: Option<String>,
        name: String,
        typed: bool,
    }
    let rows: Vec<Read> = conn
        .prepare_cached(GROUP_ROWS)?
        .query_map(params![from, to, pid], |r| {
            Ok(Read {
                day: r.get(0)?,
                group: r.get(1)?,
                text: r.get(2)?,
                recipe: r.get(3)?,
                imported: r.get(4)?,
                grams: r.get(5)?,
                drink: r.get(6)?,
                source: r.get(7)?,
                class: r.get(8)?,
                name: r.get(9)?,
                typed: r.get(10)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    let mut memo = BTreeMap::new();
    let mut covers: BTreeMap<i64, std::sync::Arc<Cover>> = BTreeMap::new();
    let mut out = Vec::with_capacity(rows.len());
    for Read {
        day,
        group,
        text,
        recipe,
        imported,
        grams,
        drink,
        source,
        class,
        name,
        typed,
    } in rows
    {
        let basis = match recipe {
            _ if imported => RowBasis::Imported,
            _ if typed => RowBasis::Text,
            // ponytail: the recipe's coverage as it is now, not as logged;
            // a `known` column on entry, set at log time, if that matters.
            Some(id) => RowBasis::Recipe(match covers.entry(id) {
                btree_map::Entry::Occupied(e) => e.get().clone(),
                btree_map::Entry::Vacant(e) => e
                    .insert(std::sync::Arc::new(
                        super::recipe_facts(conn, id, &mut memo)?.cover,
                    ))
                    .clone(),
            }),
            None => {
                // The values decide nothing here: what the entry carries is
                // read from its snapshot.
                let facts = Facts {
                    drink,
                    source,
                    class: class.as_deref(),
                    name: &name,
                };
                let none = Nutrients::default();
                RowBasis::Food {
                    drink,
                    borne: BORNE.map(|key| borne_weight(key, &none, &facts)),
                }
            }
        };
        out.push(EatenRow {
            day,
            group,
            text,
            grams,
            basis,
        });
    }
    Ok(out)
}

/// The days in `[from, to]` with an eaten entry of your own that carries
/// no energy: their eaten energy leaves it out, a lower bound (the Diary's
/// "≥"). Imported rows count in their group's total; Planned isn't eaten.
///
/// # Errors
/// A read fails.
pub fn energy_unknown_days(
    conn: &Connection,
    pid: ProfileId,
    from: &str,
    to: &str,
) -> Result<BTreeSet<String>, Error> {
    Ok(conn
        .prepare_cached(
            "SELECT DISTINCT day FROM entry
             WHERE profile_id = ?3 AND day BETWEEN ?1 AND ?2 AND src_grp IS NULL
                 AND grp != ?4
                 AND json_extract(coalesce(nutrients, '{}'), '$.energy') IS NULL",
        )?
        .query_map(params![from, to, pid, PLANNED], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?)
}

/// Each day's eaten energy in `[from, to]` by verdict ([`Ratings`]), as
/// [`GROUP_ROWS`] reads it; a day without energy has none.
///
/// # Errors
/// A read fails.
pub fn day_ratings(
    conn: &Connection,
    pid: ProfileId,
    from: &str,
    to: &str,
) -> Result<BTreeMap<String, Ratings>, Error> {
    let rows: Vec<(String, Option<String>, f64)> = conn
        .prepare_cached(concat!(
            "SELECT e.day, (SELECT l.label FROM food_label l WHERE l.food_id = e.food_id
                     AND l.label IN ('healthy', 'ok', 'unhealthy')),
                 sum(coalesce(json_extract(e.nutrients, '$.energy'), 0))
             FROM entry e
             WHERE e.profile_id = ?3 AND e.day BETWEEN ?1 AND ?2
                 AND e.nutrients IS NOT NULL AND e.grp != ?4
             GROUP BY 1, 2
             UNION ALL
             SELECT d.day, NULL, sum(coalesce(json_extract(d.nutrients, '$.energy'), 0))
             FROM day_total d
             WHERE d.profile_id = ?3 AND d.day BETWEEN ?1 AND ?2 AND ",
            imported_group!(),
            " != ?4
             GROUP BY 1"
        ))?
        .query_map(params![from, to, pid, PLANNED], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })?
        .collect::<rusqlite::Result<_>>()?;
    let mut out: BTreeMap<String, Ratings> = BTreeMap::new();
    for (day, verdict, kcal) in rows.into_iter().filter(|r| r.2 > 0.0) {
        let r = out.entry(day).or_default();
        match verdict.as_deref() {
            Some("healthy") => r.healthy += kcal,
            Some("ok") => r.ok += kcal,
            Some("unhealthy") => r.unhealthy += kcal,
            _ => r.unrated += kcal,
        }
    }
    Ok(out)
}

/// One total being added up: its values, the dry matter behind each key
/// and in all, and each [`BORNE`] key's (with, of) weights.
#[derive(Default)]
struct Sum {
    total: Nutrients,
    behind: Nutrients,
    dry: f64,
    borne: [(f64, f64); BORNE.len()],
}

/// Eaten totals by day, built a stored total at a time ([`eaten_days`]):
/// each day's total and how far it is known.
#[derive(Default)]
pub struct Eaten(BTreeMap<String, Sum>);

impl Eaten {
    /// Count `n`, a stored total of `grams` on `day`, known as `basis` says.
    pub fn add(&mut self, day: &str, n: &Nutrients, grams: f64, basis: &RowBasis) {
        let dry = match basis {
            RowBasis::Food { drink, .. } => dry_of(n, grams, *drink),
            RowBasis::Recipe(cover) => cover.known.get(DRY).copied().unwrap_or(0.0) * grams / 100.0,
            RowBasis::Imported => macro_dry(n),
            RowBasis::Text => text_dry(n),
        };
        let sum = match self.0.get_mut(day) {
            Some(d) => d,
            None => self.0.entry(day.to_owned()).or_default(),
        };
        sum.behind.add_behind(n, |key| {
            dry * match basis {
                RowBasis::Food { .. } | RowBasis::Text => 1.0,
                RowBasis::Recipe(cover) => cover.known.get(key).copied().unwrap_or(1.0),
                RowBasis::Imported => f64::from(u8::from(IMPORT_KNOWN.contains(&key))),
            }
        });
        for (i, key) in BORNE.iter().enumerate() {
            let carries = n.get(key).is_some();
            let (with, of) = match basis {
                // What carries it weighs its grams.
                RowBasis::Food { .. } if carries => (grams, grams),
                RowBasis::Food { borne, .. } => (0.0, borne[i] * grams),
                RowBasis::Recipe(cover) => {
                    let w = cover.borne.get(*key).copied().unwrap_or(0.0) * grams / 100.0;
                    let share =
                        cover
                            .known
                            .get(*key)
                            .copied()
                            .unwrap_or(if carries { 1.0 } else { 0.0 });
                    (w * share, w)
                }
                // An export or a text can't vouch for it: the day isn't
                // known.
                RowBasis::Imported if !IMPORT_KNOWN.contains(key) => (0.0, f64::INFINITY),
                RowBasis::Text => (0.0, f64::INFINITY),
                RowBasis::Imported => (0.0, 0.0),
            };
            sum.borne[i].0 += with;
            sum.borne[i].1 += of;
        }
        sum.total.add(n);
        sum.dry += dry;
    }

    /// Each day's total and [`Known`].
    #[must_use]
    pub fn days(self) -> BTreeMap<String, EatenDay> {
        self.0
            .into_iter()
            .map(|(day, sum)| {
                let behind = sum
                    .behind
                    .keys()
                    .filter_map(|key| Some((key, sum.behind.get(key)?)))
                    .collect::<Vec<_>>();
                let borne = BORNE
                    .iter()
                    .zip(sum.borne)
                    .map(|(&key, w)| (key, w))
                    .collect();
                let known = known_from(sum.dry, behind.into_iter(), &borne);
                (day, (sum.total, known))
            })
            .collect()
    }
}

/// The share (0 to 1) of a day's food behind its total of `key`
/// ([`crate::model::share`]).
#[must_use]
pub fn known_share((total, known): &EatenDay, key: &str) -> f64 {
    share(known, total, key)
}

/// Whether a day's total of `key` is known: [`KNOWN`] of its food behind it.
#[must_use]
pub fn is_known(day: &EatenDay, key: &str) -> bool {
    known_share(day, key) >= KNOWN
}

/// What was eaten each day of `rows` (every group but Planned): its total
/// and its [`Known`].
///
/// # Errors
/// A stored total isn't valid JSON.
pub fn eaten_days(rows: &[EatenRow]) -> Result<BTreeMap<String, EatenDay>, Error> {
    let mut days = Eaten::default();
    for r in rows {
        if eaten(&r.group) {
            days.add(&r.day, &from_json(&r.text)?, r.grams, &r.basis);
        }
    }
    Ok(days.days())
}

/// One day's `rows` ([`eaten_rows`]): each group's [`Known`], found as a
/// day's is (a Diary group's "≥" by the day's rule).
///
/// # Errors
/// A stored total isn't valid JSON.
fn group_known(rows: &[EatenRow]) -> Result<BTreeMap<String, Known>, Error> {
    let mut groups = Eaten::default();
    for r in rows {
        groups.add(&r.group, &from_json(&r.text)?, r.grams, &r.basis);
    }
    Ok(groups
        .days()
        .into_iter()
        .map(|(group, (_, known))| (group, known))
        .collect())
}

/// Totals per (day, group) in `[from, to]`.
pub fn group_totals(
    conn: &Connection,
    pid: ProfileId,
    from: &str,
    to: &str,
) -> Result<BTreeMap<(String, String), Nutrients>, Error> {
    group_sums(group_rows(conn, pid, from, to)?)
}

/// How far a day's `eaten` (of its `rows`) is known, and whether it is
/// [`unsized_days`]' (then [`unvouched`]).
fn day_known(
    conn: &Connection,
    pid: ProfileId,
    day: &str,
    rows: &[EatenRow],
    eaten: &Nutrients,
) -> Result<(Known, bool), Error> {
    let mut known = eaten_days(rows)?
        .remove(day)
        .map(|(_, known)| known)
        .unwrap_or_default();
    let sizeless = !unsized_days(conn, pid, day, day)?.is_empty();
    if sizeless {
        unvouched(&mut known, eaten);
    }
    Ok((known, sizeless))
}

/// A day as the diary shows it ([`DayView`]): [`GROUPS`] first, then
/// imported history's other groups by name. Series due that day lead
/// Planned's entries and count in its totals (ADR 0023), never in what was
/// eaten.
///
/// # Errors
/// A read fails.
pub fn day_view(
    conn: &Connection,
    pid: ProfileId,
    day: &str,
    tz: &TimeZone,
) -> Result<DayView, Error> {
    let entries = entry_list_for_day(conn, pid, day)?;
    let mut totals = group_totals(conn, pid, day, day)?;
    let mut names: Vec<String> = GROUPS.iter().map(|&g| g.to_owned()).collect();
    for g in entries
        .iter()
        .map(|e| e.group.as_str())
        .chain(totals.keys().map(|(_, g)| g.as_str()))
    {
        if !names.iter().any(|n| n == g) {
            names.push(g.to_owned());
        }
    }
    names[GROUPS.len()..].sort();
    let mut due = daily_due(conn, pid, day)?;
    let rows = eaten_rows(conn, pid, day, day)?;
    let mut known_by_group = group_known(&rows)?;
    let groups: Vec<Group> = names
        .into_iter()
        .map(|name| {
            let mut sum = totals
                .remove(&(day.to_owned(), name.clone()))
                .unwrap_or_default();
            let mut listed = if name == PLANNED {
                std::mem::take(&mut due)
            } else {
                Vec::new()
            };
            for n in listed.iter().filter_map(|e| e.nutrients.as_ref()) {
                sum.add(n);
            }
            listed.extend(entries.iter().filter(|e| e.group == name).cloned());
            Group {
                entries: listed,
                totals: sum,
                known: known_by_group.remove(&name).unwrap_or_default(),
                name,
            }
        })
        .collect();
    let total = Nutrients::sum(groups.iter().map(|g| &g.totals));
    let eaten_sum = Nutrients::sum(groups.iter().filter(|g| eaten(&g.name)).map(|g| &g.totals));
    let (known, sizeless) = day_known(conn, pid, day, &rows, &eaten_sum)?;
    let d = Some(day);
    let mut device_day = super::device_day_list(conn, pid, d, d)?;
    Ok(DayView {
        day: day.to_owned(),
        groups,
        total,
        eaten: eaten_sum,
        known,
        incomplete: sizeless,
        targets: super::target_list(conn, pid)?,
        activities: super::activity_list(conn, pid, d, d, None)?,
        plans: super::plan_list(conn, pid, d, d)?,
        weight: super::weight_list(conn, pid, d, d)?.first().map(|w| w.kg),
        weight_source: super::weight_source(conn, pid, day)?,
        composition: super::scale_chosen(conn, pid, day, tz)?
            .filter(|r| r.body_fat.is_some() || r.water.is_some() || r.muscle.is_some())
            .map(|r| Composition {
                body_fat: r.body_fat,
                water: r.water,
                muscle: r.muscle,
            }),
        note: note_list(conn, pid, d, d)?.pop().map(|n| n.text),
        check_in: check_in_list(conn, pid, d, d)?.pop(),
        measurements: measurement_list(conn, pid, d, d)?
            .into_iter()
            .map(|m| BodyValue {
                kind: m.kind,
                value: m.value,
            })
            .collect(),
        builtins: super::builtin_days(conn, pid, d, d)?
            .into_iter()
            .filter(|b| b.amount > 0.0)
            .map(|b| BuiltinValue {
                habit: b.habit,
                amount: b.amount,
                known: b.known,
            })
            .collect(),
        habits: super::habit_days(conn, pid, d, d)?
            .into_iter()
            .map(|h| HabitValue {
                habit_id: h.habit_id,
                amount: h.amount,
            })
            .collect(),
        device_day: device_day.days.pop(),
        resting: device_day.resting.pop().map(|r| r.resting),
        // The naps the device-day read counted in its sleep: read once.
        naps: device_day.naps,
        stages: super::day_stages(conn, pid, day)?,
        photos: super::photo_list(conn, pid, day)?,
        pending_activities: super::pending_activity_list(conn, pid, Some(day))?,
        water_food_id: super::water_food_get(conn, pid)?.map(|f| f.id),
    })
}

// -------------------------------------------------------- daily series

/// A daily series as stored (ADR 0023): `daily_item`.
struct Series {
    id: i64,
    food_id: i64,
    grams: f64,
    serving: Option<String>,
    quantity: Option<f64>,
    start: String,
    created_at: String,
}

impl Series {
    /// Its amount, as a tick logs it.
    fn measured(&self) -> Measured {
        Measured {
            grams: self.grams,
            serving: self.serving.clone(),
            quantity: self.quantity,
            amount: match (&self.serving, self.quantity) {
                (Some(label), Some(q)) => serving_amount(q, label, self.grams),
                _ => gram_amount(self.grams),
            },
        }
    }
}

/// The profile's series matching `sql` (over `daily_item d`; `?1` the
/// profile), by id.
fn series_where(
    conn: &Connection,
    sql: &str,
    args: impl rusqlite::Params,
) -> Result<Vec<Series>, Error> {
    let mut stmt = conn.prepare_cached(&format!(
        "SELECT id, food_id, grams, serving, quantity, start, created_at
         FROM daily_item d WHERE profile_id = ?1 AND {sql} ORDER BY id"
    ))?;
    Ok(stmt
        .query_map(args, |r| {
            Ok(Series {
                id: r.get(0)?,
                food_id: r.get(1)?,
                grams: r.get(2)?,
                serving: r.get(3)?,
                quantity: r.get(4)?,
                start: r.get(5)?,
                created_at: r.get(6)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?)
}

/// A series of `pid`; another profile's reads as missing (404 at
/// `key`).
fn series_get(conn: &Connection, pid: ProfileId, id: i64, key: &str) -> Result<Series, Error> {
    series_where(conn, "id = ?2", params![pid, id])?
        .pop()
        .ok_or_else(|| Error::not_found("entry", key))
}

/// `s`'s day `day` as an entry: Planned, no id, its key for an address and
/// a uid; its food's name, values and source read now.
fn due_entry(conn: &Connection, s: Series, day: &str) -> Result<Entry, Error> {
    // `food_id` is a foreign key, and foods are never deleted but by a
    // merge, which repoints the series.
    let food = written(food_get(conn, s.food_id)?);
    let key = EntryKey::due(s.id, day);
    let m = s.measured();
    Ok(Entry {
        id: None,
        uid: key.clone(),
        key,
        day: day.to_owned(),
        group: PLANNED.to_owned(),
        food_id: Some(s.food_id),
        name: food.name,
        grams: Some(m.grams),
        amount: m.amount,
        serving: m.serving,
        quantity: m.quantity,
        nutrients: Some(food.per100.scale(s.grams / 100.0)),
        created_at: s.created_at,
        source: Some(food.source),
        time: None,
        weight_estimated: food.basis.is_some_and(|b| b.estimated),
        repeat: Some(Repeat {
            id: s.id,
            start: s.start,
        }),
        src_group: None,
        kind: EntryKind::Due,
        by_volume: food.drink && food.kind == FoodKind::Food && food.source != Source::Fineli,
    })
}

/// Whether `s` is due on `day`: started, not skipped, no tick that day.
const DUE: &str = "start <= ?2
     AND NOT EXISTS (SELECT 1 FROM daily_skip s WHERE s.daily_item_id = d.id AND s.day = ?2)
     AND NOT EXISTS (SELECT 1 FROM entry e WHERE e.daily_item_id = d.id AND e.day = ?2)";

/// `pid`'s daily items, by id, with the days in `[from, to]` each was
/// skipped and ticked on.
pub fn daily_days(
    conn: &Connection,
    pid: ProfileId,
    from: &str,
    to: &str,
) -> Result<Vec<DailyDays>, Error> {
    let mut items: Vec<DailyDays> = conn
        .prepare_cached(
            "SELECT d.id, d.food_id, f.name, d.start FROM daily_item d
             JOIN food f ON f.id = d.food_id
             WHERE d.profile_id = ?1 ORDER BY d.id",
        )?
        .query_map(params![pid], |r| {
            Ok(DailyDays {
                id: r.get(0)?,
                food_id: r.get(1)?,
                name: r.get(2)?,
                start: day_at(r, 3)?,
                skipped: BTreeSet::new(),
                ticked: BTreeSet::new(),
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    let mut stmt = conn.prepare_cached(
        "SELECT s.daily_item_id, s.day, 0 FROM daily_skip s
         JOIN daily_item d ON d.id = s.daily_item_id
         WHERE d.profile_id = ?1 AND s.day BETWEEN ?2 AND ?3
         UNION ALL
         SELECT daily_item_id, day, 1 FROM entry
         WHERE profile_id = ?1 AND daily_item_id IS NOT NULL AND day BETWEEN ?2 AND ?3",
    )?;
    let days = stmt.query_map(params![pid, from, to], |r| {
        Ok((r.get::<_, i64>(0)?, day_at(r, 1)?, r.get::<_, bool>(2)?))
    })?;
    for row in days {
        let (id, day, ticked) = row?;
        if let Some(item) = items.iter_mut().find(|i| i.id == id) {
            if ticked {
                item.ticked.insert(day);
            } else {
                item.skipped.insert(day);
            }
        }
    }
    Ok(items)
}

/// A text column holding a day, `YYYY-MM-DD`.
fn day_at(r: &Row, i: usize) -> rusqlite::Result<jiff::civil::Date> {
    let text: String = r.get(i)?;
    text.parse().map_err(|e: jiff::Error| {
        rusqlite::Error::FromSqlConversionFailure(i, rusqlite::types::Type::Text, Box::new(e))
    })
}

/// The series due on `day` as Planned entries, by series id (ADR 0023).
pub fn daily_due(conn: &Connection, pid: ProfileId, day: &str) -> Result<Vec<Entry>, Error> {
    series_where(conn, DUE, params![pid, day])?
        .into_iter()
        .map(|s| due_entry(conn, s, day))
        .collect()
}

/// What `key` addresses: an entry by id; a series' day, its tick when
/// ticked, else the day while due. `None`: no such entry, or a day
/// skipped, not started or of no series.
pub fn entry_at(conn: &Connection, pid: ProfileId, key: &EntryKey) -> Result<Option<Entry>, Error> {
    let (item, day) = match key {
        EntryKey::Id(id) => return entry_get(conn, pid, *id),
        EntryKey::Due { item, day } => (*item, day.as_str()),
    };
    let tick: Option<i64> = conn
        .query_row(
            "SELECT e.id FROM entry e WHERE e.profile_id = ? AND e.daily_item_id = ? AND e.day = ?",
            params![pid, item, day],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(id) = tick {
        return entry_get(conn, pid, id);
    }
    series_where(conn, &format!("id = ?3 AND {DUE}"), params![pid, day, item])?
        .pop()
        .map(|s| due_entry(conn, s, day))
        .transpose()
}

/// Repeat own `entry` daily from `start`: the series takes its food and
/// amount, and the entry becomes its tick on its own day.
///
/// # Errors
/// 400 at [`DAILY_ITEMS_MAX`].
fn repeat_start(tx: &Connection, pid: ProfileId, entry: &Entry, start: &str) -> Result<(), Error> {
    let full: bool = tx.query_row(
        "SELECT count(*) >= ?2 FROM daily_item WHERE profile_id = ?1",
        params![pid, DAILY_ITEMS_MAX],
        |r| r.get(0),
    )?;
    if full {
        return Err(Error::invalid(format!(
            "a profile has at most {DAILY_ITEMS_MAX} daily items; stop one first"
        )));
    }
    tx.execute(
        "INSERT INTO daily_item (profile_id, food_id, grams, serving, quantity, start)
         VALUES (?, ?, ?, ?, ?, ?)",
        params![
            pid,
            entry.food_id,
            entry.grams,
            entry.serving,
            entry.quantity,
            start
        ],
    )?;
    tx.execute(
        "UPDATE entry SET daily_item_id = ? WHERE id = ?",
        params![tx.last_insert_rowid(), entry.id],
    )?;
    Ok(())
}

/// Stop a series: its skips go, its ticks stay as entries, unlinked.
fn series_delete(conn: &Connection, id: i64) -> Result<(), Error> {
    conn.execute("DELETE FROM daily_item WHERE id = ?", [id])?;
    Ok(())
}

/// Change a series from one of its days (a checked patch): a new amount
/// for every un-ticked day (ticks keep their snapshots), or stop it. The
/// day stays in Planned and has no time: a tick moves and times it.
///
/// # Errors
/// 404 (no such series), 400 `group` or `time`, or a bad amount.
pub fn due_update(
    conn: &mut Connection,
    pid: ProfileId,
    item: i64,
    day: &str,
    patch: &EntryPatch,
) -> Result<Entry, Error> {
    if patch.group.as_deref().is_some_and(|g| g != PLANNED) {
        return Err(Error::invalid_field(
            "group",
            "a due day stays in Planned: log it with repeat_of to move it",
        ));
    }
    if patch.time != Nullable::Keep {
        return Err(Error::invalid_field(
            "time",
            "a due day has no time: log it with repeat_of to time it",
        ));
    }
    let key = EntryKey::due(item, day);
    let tx = write(conn)?;
    let s = series_get(&tx, pid, item, &key)?;
    if patch.re_measures() {
        let m = patch.amount.of(&written(food_get(&tx, s.food_id)?))?;
        tx.execute(
            "UPDATE daily_item SET grams = ?, serving = ?, quantity = ? WHERE id = ?",
            params![m.grams, m.serving, m.quantity, item],
        )?;
    }
    let mut entry = due_entry(&tx, series_get(&tx, pid, item, &key)?, day)?;
    if patch.repeat == Nullable::Clear {
        series_delete(&tx, item)?;
        entry.repeat = None;
    }
    tx.commit()?;
    Ok(entry)
}

/// Skip `day` of a series (it isn't due then), or with `skipped` false
/// undo that. Repeating either changes nothing.
///
/// # Errors
/// 404: no such series.
pub fn daily_skip(
    conn: &Connection,
    pid: ProfileId,
    item: i64,
    day: &str,
    skipped: bool,
) -> Result<(), Error> {
    series_get(conn, pid, item, &EntryKey::due(item, day))?;
    let sql = if skipped {
        "INSERT OR IGNORE INTO daily_skip (daily_item_id, day) VALUES (?, ?)"
    } else {
        "DELETE FROM daily_skip WHERE daily_item_id = ? AND day = ?"
    };
    conn.execute(sql, params![item, day])?;
    Ok(())
}

/// Tick a series on the slot's day: its food and amount as they are now,
/// linked, under uid `daily-{item}-{day}` unless the slot names one. Once
/// per series and day: a second tick (another device's, another uid)
/// answers with the first, as a `uid` logged before does.
///
/// # Errors
/// 400 `repeat_of`: not the profile's series.
pub fn entry_log_daily(conn: &mut Connection, at: &Slot, item: i64) -> Result<Entry, Error> {
    let key = EntryKey::due(item, at.day);
    let at = &Slot {
        uid: Some(at.uid.unwrap_or(&key)),
        ..*at
    };
    let tx = write(conn)?;
    if let Some(earlier) = at.logged_before(&tx)? {
        return Ok(written(earlier.into_iter().next()));
    }
    if let Some(tick) = entry_at(
        &tx,
        at.profile,
        &EntryKey::Due {
            item,
            day: at.day.to_owned(),
        },
    )?
    .filter(|e| e.id.is_some())
    {
        return Ok(tick);
    }
    let s = series_where(&tx, "id = ?2", params![at.profile, item])?
        .pop()
        .ok_or_else(|| Error::invalid_field("repeat_of", format!("unknown daily item {item}")))?;
    let food = written(food_get(&tx, s.food_id)?);
    let entry = food_entry(&tx, at, &food, &s.measured(), at.uid, Some(item))?;
    tx.commit()?;
    Ok(entry)
}

// ---------------------------------------------- notes and measurements

/// A profile's day notes in `[from, to]` (either end open), oldest first.
pub fn note_list(
    conn: &Connection,
    pid: ProfileId,
    from: Option<&str>,
    to: Option<&str>,
) -> Result<Vec<DayNote>, Error> {
    let mut stmt = conn.prepare_cached(&format!(
        "SELECT day, text FROM day_note
         WHERE {IN_RANGE}
         ORDER BY day"
    ))?;
    Ok(stmt
        .query_map(params![pid, from, to], |r| {
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
    pid: ProfileId,
    day: &str,
    text: &str,
) -> Result<DayNote, Error> {
    conn.execute(
        "INSERT INTO day_note (profile_id, day, text) VALUES (?1, ?2, ?3)
         ON CONFLICT (profile_id, day) DO UPDATE SET text = ?3",
        params![pid, day, text],
    )?;
    Ok(DayNote {
        day: day.to_owned(),
        text: text.to_owned(),
    })
}

pub fn note_delete(conn: &Connection, pid: ProfileId, day: &str) -> Result<(), Error> {
    let n = conn.execute(
        "DELETE FROM day_note WHERE profile_id = ? AND day = ?",
        params![pid, day],
    )?;
    if n == 0 {
        return Err(Error::not_found("note", day));
    }
    Ok(())
}

// ------------------------------------------------ days not fully logged

/// The days in `[from, to]` with an eaten text entry without energy: what
/// it stands for has no size, so nothing of the day's food is vouched for.
///
/// # Errors
/// A read fails.
pub fn unsized_days(
    conn: &Connection,
    pid: ProfileId,
    from: &str,
    to: &str,
) -> Result<BTreeSet<String>, Error> {
    Ok(conn
        .prepare_cached(
            "SELECT DISTINCT day FROM entry
             WHERE profile_id = ?3 AND day BETWEEN ?1 AND ?2 AND src_grp IS NULL
                 AND food_id IS NULL AND grp != ?4
                 AND json_extract(coalesce(nutrients, '{}'), '$.energy') IS NULL",
        )?
        .query_map(params![from, to, pid, PLANNED], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?)
}

/// An unsized day's [`Known`]: every key of its `total`, and each [`BORNE`]
/// one, vouched for by none of its food.
pub fn unvouched(known: &mut Known, total: &Nutrients) {
    for key in total.keys().chain(BORNE) {
        known.insert(key.to_owned(), 0.0);
    }
}

// ------------------------------------------------- insight preferences

/// A profile's insight preferences, by id; hidden ones past their day too
/// (the client compares `until` with its own day).
pub fn insight_pref_list(conn: &Connection, pid: ProfileId) -> Result<Vec<InsightPref>, Error> {
    let mut stmt = conn.prepare_cached(
        "SELECT insight_id, state, until FROM insight_pref WHERE profile_id = ? ORDER BY insight_id",
    )?;
    Ok(stmt
        .query_map([pid], |r| {
            Ok(InsightPref {
                id: r.get(0)?,
                state: r.get(1)?,
                until: r.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?)
}

/// Set an insight's preference, replacing any earlier one. Writing the
/// same twice is the same as once.
pub fn insight_pref_set(
    conn: &Connection,
    pid: ProfileId,
    pref: &InsightPref,
) -> Result<InsightPref, Error> {
    conn.execute(
        "INSERT INTO insight_pref (profile_id, insight_id, state, until) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (profile_id, insight_id) DO UPDATE SET state = ?3, until = ?4",
        params![pid, pref.id, pref.state, pref.until],
    )?;
    Ok(pref.clone())
}

pub fn insight_pref_delete(conn: &Connection, pid: ProfileId, id: &str) -> Result<(), Error> {
    let n = conn.execute(
        "DELETE FROM insight_pref WHERE profile_id = ? AND insight_id = ?",
        params![pid, id],
    )?;
    if n == 0 {
        return Err(Error::not_found("insight", id));
    }
    Ok(())
}

// ----------------------------------------------------------- check-ins

/// A profile's check-ins in `[from, to]` (either end open), oldest first.
pub fn check_in_list(
    conn: &Connection,
    pid: ProfileId,
    from: Option<&str>,
    to: Option<&str>,
) -> Result<Vec<CheckIn>, Error> {
    let mut stmt = conn.prepare_cached(&format!(
        "SELECT day, mood, energy, stress, tags FROM check_in
         WHERE {IN_RANGE}
         ORDER BY day"
    ))?;
    Ok(stmt
        .query_map(params![pid, from, to], |r| {
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
    pid: ProfileId,
    day: &str,
    c: &CheckInInput,
) -> Result<CheckIn, Error> {
    conn.execute(
        "INSERT INTO check_in (profile_id, day, mood, energy, stress, tags)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT (profile_id, day) DO UPDATE
             SET mood = ?3, energy = ?4, stress = ?5, tags = ?6",
        params![pid, day, c.mood, c.energy, c.stress, json(&c.tags)],
    )?;
    Ok(CheckIn {
        day: day.to_owned(),
        mood: c.mood,
        energy: c.energy,
        stress: c.stress,
        tags: c.tags.clone(),
    })
}

pub fn check_in_delete(conn: &Connection, pid: ProfileId, day: &str) -> Result<(), Error> {
    let n = conn.execute(
        "DELETE FROM check_in WHERE profile_id = ? AND day = ?",
        params![pid, day],
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
    pid: ProfileId,
    from: Option<&str>,
    to: Option<&str>,
) -> Result<Vec<Measurement>, Error> {
    let mut stmt = conn.prepare_cached(&format!(
        "SELECT day, kind, value FROM measurement
         WHERE {IN_RANGE}
         ORDER BY day"
    ))?;
    let mut list: Vec<Measurement> = stmt
        .query_map(params![pid, from, to], |r| {
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
    pid: ProfileId,
    day: &str,
    kind: BodyPart,
    value: f64,
) -> Result<Measurement, Error> {
    conn.execute(
        "INSERT INTO measurement (profile_id, day, kind, value) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (profile_id, day, kind) DO UPDATE SET value = ?4",
        params![pid, day, kind.as_str(), value],
    )?;
    Ok(Measurement {
        day: day.to_owned(),
        kind,
        value,
    })
}

pub fn measurement_delete(
    conn: &Connection,
    pid: ProfileId,
    day: &str,
    kind: BodyPart,
) -> Result<(), Error> {
    let n = conn.execute(
        "DELETE FROM measurement WHERE profile_id = ? AND day = ? AND kind = ?",
        params![pid, day, kind.as_str()],
    )?;
    if n == 0 {
        return Err(Error::not_found(
            "measurement",
            format!("{day} {}", kind.as_str()),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use crate::db::{FoodInput, food_insert, nap_insert, open};
    use crate::model::{Measured, NapInput, PLANNED, Source};

    use super::*;

    const ME: ProfileId = ProfileId(1);
    const DAY: &str = "2026-10-06";

    fn row(text: &str, grams: f64, basis: RowBasis) -> EatenRow {
        EatenRow {
            day: DAY.to_owned(),
            group: "Eaten".to_owned(),
            text: text.to_owned(),
            grams,
            basis,
        }
    }

    fn food(drink: bool, borne: [f64; BORNE.len()]) -> RowBasis {
        RowBasis::Food { drink, borne }
    }

    /// An imported total is known only for energy, the
    /// macros and alcohol; its iron (Cronometer's partial sum) isn't. Its
    /// weight is its macronutrients' grams (it has no grams).
    #[test]
    fn an_imported_total_knows_only_energy_and_macros() {
        let days = eaten_days(&[
            row(
                r#"{"energy": 2000, "protein": 100, "carbs": 200, "fat": 100, "iron": 0.5}"#,
                0.0,
                RowBasis::Imported,
            ),
            row(
                r#"{"energy": 500, "iron": 3}"#,
                100.0,
                food(false, [0.0; 3]),
            ),
        ])
        .unwrap();
        let day = &days[DAY];
        // Dry: the import's 400 g, the food's 100 g (no water value).
        assert!((day.1[DRY] - 500.0).abs() < 1e-9);
        assert!((known_share(day, "iron") - 0.2).abs() < 1e-9);
        assert!((known_share(day, "protein") - 0.8).abs() < 1e-9);
        assert!(!day.1.contains_key("energy"));
        assert!(!is_known(day, "iron") && is_known(day, "energy"));
        // Caffeine: the export can't vouch for it.
        assert!(!is_known(day, "caffeine"));
        // Cronometer's vitamin A is RAE, the app's RE: only ever a floor.
        assert!(!IMPORT_KNOWN.contains(&"vitamin_a"));
    }

    /// A vitamin tablet's vitamin C is known by
    /// its dry matter, not its (missing) energy; caffeine and alcohol by
    /// what could hold them; creatine from its supplement.
    #[test]
    fn a_day_is_known_by_dry_matter_and_what_could_hold_it() {
        let days = eaten_days(&[
            // Pizza: 300 g, 150 g water, no caffeine, alcohol or vitamin C.
            row(
                r#"{"energy": 750, "water": 150, "protein": 30}"#,
                300.0,
                food(false, [0.0; 3]),
            ),
            // A vitamin tablet: 4 g, vitamin C, no energy.
            row(r#"{"vitamin_c": 60}"#, 4.0, food(false, [0.0; 3])),
            // Diet cola with its caffeine: no dry matter, all the caffeine.
            row(
                r#"{"energy": 2, "carbs": 0, "protein": 0, "caffeine": 60}"#,
                500.0,
                food(true, [1.0, 0.0, 0.0]),
            ),
            // Creatine monohydrate.
            row(
                r#"{"energy": 0, "creatine": 3}"#,
                3.0,
                food(false, [0.0, 0.0, 100.0]),
            ),
        ])
        .unwrap();
        let day = &days[DAY];
        // Dry: pizza 150 g, tablet 4 g, cola 0, creatine 3 g.
        assert!((day.1[DRY] - 157.0).abs() < 1e-9, "{:?}", day.1);
        // Vitamin C: the tablet's 4 g of 157: a floor, shown, not judged.
        assert!((known_share(day, "vitamin_c") - 4.0 / 157.0).abs() < 1e-9);
        // Energy: all but the tablet (D3: 153 of 157, no longer "of 0 %").
        assert!((known_share(day, "energy") - 153.0 / 157.0).abs() < 1e-9);
        // Caffeine, alcohol and creatine known: nothing that could hold them
        // lacks them; the pizza holds none.
        for key in BORNE {
            assert!(is_known(day, key), "{key}");
        }
        // A second cola without its caffeine leaves half of it unknown.
        let days = eaten_days(&[
            row(r#"{"caffeine": 60}"#, 500.0, food(true, [1.0, 0.0, 0.0])),
            row(r#"{"carbs": 0}"#, 500.0, food(true, [1.0, 0.0, 0.0])),
        ])
        .unwrap();
        assert!((known_share(&days[DAY], "caffeine") - 0.5).abs() < 1e-9);
    }

    #[test]
    fn day_view_counts_due_items_in_planned_by_name() {
        let mut conn = open(Path::new(":memory:")).unwrap();
        let shake = FoodInput {
            name: "Shake".into(),
            per100: Nutrients::of(&[("energy", 400.0)]),
            ..FoodInput::default()
        };
        let shake = food_insert(&mut conn, &shake, Source::Custom).unwrap();
        let at = Slot {
            profile: ME,
            day: DAY,
            group: "Eaten",
            uid: None,
            time: None,
        };
        let m = Measured {
            grams: 30.0,
            serving: None,
            quantity: None,
            amount: gram_amount(30.0),
        };
        let entry = entry_log(&mut conn, &at, &shake, &m, None).unwrap();
        let repeat = EntryPatch {
            repeat: Nullable::Set(RepeatInput::default()),
            ..EntryPatch::default()
        };
        entry_update(&mut conn, ME, entry.id.unwrap(), &repeat).unwrap();

        let next = day_view(&conn, ME, "2026-10-07", &TimeZone::UTC).unwrap();
        let planned = next.groups.iter().find(|g| g.name == PLANNED).unwrap();
        assert_eq!(planned.entries.len(), 1);
        assert_eq!(planned.entries[0].id, None);
        assert_close!(planned.totals.get("energy").unwrap(), 120.0);
        assert_close!(next.total.get("energy").unwrap(), 120.0);
        assert!(next.eaten.is_empty(), "due isn't eaten");
        for g in next.groups.iter().filter(|g| g.name != PLANNED) {
            assert!(g.totals.is_empty(), "{} counts the due item", g.name);
        }
    }

    #[test]
    fn day_view_reads_naps_once() {
        let mut conn = open(Path::new(":memory:")).unwrap();
        let nap = NapInput {
            uid: None,
            day: DAY.into(),
            start_at: format!("{DAY}T12:00:00Z"),
            end_at: format!("{DAY}T12:30:00Z"),
        };
        nap_insert(&mut conn, ME, &nap).unwrap();
        let day = day_view(&conn, ME, DAY, &TimeZone::UTC).unwrap();
        // The day's naps come from the device-day read that counts them in
        // its sleep: one read, one answer.
        assert_eq!(day.naps.len(), 1);
        assert_eq!(day.naps[0].in_bed_min, 30);
        assert_eq!(day.device_day.unwrap().total_asleep_min, Some(30));
    }
}
