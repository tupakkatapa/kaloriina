//! `SQLite` schema and queries. All functions are synchronous and expect the
//! caller to hold the connection lock.
//!
//! Functions are named `<resource>_<verb>`:
//! - `get` / `search` / `list` / `recent` read;
//! - `insert` creates and `update` changes an existing row by id. Only
//!   foods and profiles split the two, as their create and edit differ (an
//!   importer's food vs your edit; a new profile's starting targets). A
//!   planned workout is only ever inserted and deleted;
//! - `save` creates (`id = None`) or replaces (`Some(id)`) a whole entity
//!   with what it holds (recipes, exercises, workouts, activities, habits);
//! - `upsert_<source>` adds or updates rows keyed by an outside id;
//! - `replace` swaps a whole set (targets, imported days);
//! - `set` writes one keyed value, the same every time (a favourite, a
//!   day's weight);
//! - `put` writes rows by key over what the key held, in the caller's
//!   transaction (sleep stages, health records, imported days);
//! - `delete` removes by id;
//! - `log` writes diary entries.
//!
//! Helpers private to `db` may be verb-first (`insert_food`, `write_items`).
//!
//! Reads keyed by something other than id are `<resource>_by_<key>` or
//! `<resource>_list_for_<key>`; `group_totals` aggregates a date range
//! (`group_rows`, then `group_sums`).
//!
//! Transactions: functions taking `&mut Connection` open their own;
//! functions taking `&Connection` run inside whatever the caller holds.
//!
//! Writes return the stored entity, read back in the same transaction.
//! Updates of whole entities (foods, recipes, exercises, workouts,
//! profiles, activities) name the `rev` they were made from; see [`bump_rev`].

/// What the resource modules share: each starts with `use super::prelude::*`.
mod prelude {
    pub(super) use std::collections::{BTreeMap, BTreeSet};
    pub(super) use std::path::Path;
    pub(super) use std::time::Duration;

    pub(super) use rusqlite::types::{FromSql, FromSqlError, FromSqlResult, ToSqlOutput, ValueRef};
    pub(super) use rusqlite::{
        Connection, OptionalExtension, Params, Row, ToSql, Transaction, TransactionBehavior, params,
    };

    pub(super) use jiff::tz::TimeZone;
    pub(super) use serde::Serialize;

    pub(super) use crate::error::{Conflict, Error};
    pub(super) use crate::model::{
        Activity, ActivityInput, ActivitySet, ActivitySource, ActivityType, Basis, Body, DayTotal,
        Entry, Exercise, ExerciseInput, ExerciseSource, ExerciseTraits, Food, FoodInput,
        ImportedEntry, Item, Measure, Measured, Profile, ProfileId, ProfileInput, Recipe,
        RecipeInput, Serving, Sex, Side, Sort, Source, Step, SyncedWorkouts, Target, WHOLE_RECIPE,
        Weight, WeightSource, Workout, WorkoutInput, exercise_steps, gram_amount, step_fits,
    };
    pub(super) use crate::model::{
        FoodKind, FoodScope, ItemInput, Macros, MergeInput, PORTION, SERVINGS_MAX, Usage,
        serving_amount,
    };
    pub(super) use crate::nutrients::Nutrients;

    pub(super) use super::{
        IN_RANGE, bump_rev, exercise_get, food_get, from_json, json, write, written,
    };
}

/// A profile's rows on days in `[from, to]`, either end open when NULL:
/// `?1` the profile, `?2` from, `?3` to. An open end is a bound past every
/// day, so the day index serves both ends (`?2 IS NULL OR …`
/// can't, and a one-day read scanned the profile's whole history).
pub(crate) const IN_RANGE: &str =
    "profile_id = ?1 AND day >= coalesce(?2, '') AND day <= coalesce(?3, '9999-12-31')";

use prelude::*;

/// The resting energy in effect on `$day` of profile `$pid` (SQL
/// expressions), its column `$col` (`bmr_kcal` or `bmr_origin`): the day's
/// own Health Connect basal metabolic rate, else the latest of the 6 days
/// before it (day + 6 carries, day + 7 doesn't); NULL without one.
/// The one rule every reader of it shares.
macro_rules! resting_on {
    ($col:literal, $pid:literal, $day:literal) => {
        concat!(
            "(SELECT r.",
            $col,
            " FROM device_day r WHERE r.profile_id = ",
            $pid,
            " AND r.bmr_kcal IS NOT NULL AND r.day <= ",
            $day,
            " AND r.day >= date(",
            $day,
            ", '-6 days') ORDER BY r.day DESC LIMIT 1)"
        )
    };
}

impl ToSql for ProfileId {
    fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
        self.0.to_sql()
    }
}

impl FromSql for ProfileId {
    fn column_result(value: ValueRef<'_>) -> FromSqlResult<Self> {
        i64::column_result(value).map(Self)
    }
}

use crate::model::{
    FeedbackKind, FeedbackStatus, GoalDir, InsightState, KcalSource, NapSource, PhotoMime,
    SleepStageKind, StageSource,
};

/// Text enums are stored as their names.
macro_rules! sql_text {
    ($($t:ty),+) => {$(
        impl ToSql for $t {
            fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
                Ok(self.as_str().into())
            }
        }

        impl FromSql for $t {
            fn column_result(value: ValueRef<'_>) -> FromSqlResult<Self> {
                let text = value.as_str()?;
                Self::parse(text).ok_or_else(|| {
                    FromSqlError::Other(
                        format!("unknown {} {text:?}", stringify!($t)).into(),
                    )
                })
            }
        }
    )+};
}
sql_text!(
    Source,
    FoodKind,
    Measure,
    ExerciseSource,
    Sex,
    Side,
    WeightSource,
    ActivityType,
    ActivitySource,
    SyncedWorkouts,
    GoalDir,
    KcalSource,
    NapSource,
    PhotoMime,
    FeedbackKind,
    FeedbackStatus,
    SleepStageKind,
    StageSource,
    InsightState
);

/// Migrations after which recipes are recomputed from their ingredients
/// (4: values; 20: the "Whole recipe" serving; 58: copied total carbs;
/// 63: a cooked weight's change is water; 71: meals made recipes).
const RECOMPUTE_RECIPES_AFTER: [u32; 5] = [4, 20, 58, 63, 71];

/// The migration after which drinks are derived again ([`rederive_drinks`]).
const REDERIVE_DRINKS_AFTER: u32 = 65;

/// Open (or create) the database and bring the schema up to date; the data
/// derived from it follows its rules after ([`derived_current`]).
///
/// Migrating an existing file is bracketed: a snapshot first
/// (see [`snapshot_before_migrating`]), then a marker `<db>.migrating-v<N>`
/// that only a successful migration removes, then the snapshots pruned to
/// the newest two.
pub fn open(path: &Path) -> Result<Connection, Error> {
    if path == Path::new(":memory:") {
        return open_memory(true);
    }
    let mut conn = Connection::open(path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    // A concurrent `kaloriina import` may hold the write lock briefly.
    conn.busy_timeout(Duration::from_secs(5))?;
    match snapshot_before_migrating(&conn, path)? {
        Some((version, snapshot)) => {
            let marker = beside(path, &format!(".migrating-v{version}"));
            std::fs::write(&marker, b"")
                .map_err(|e| Error::Internal(format!("writing {}: {e}", marker.display())))?;
            migrate(&mut conn)?;
            // Gone, the next start can't mistake the snapshot for this file.
            let _ = std::fs::remove_file(&marker);
            prune_snapshots(path, &snapshot);
        }
        None => migrate(&mut conn)?,
    }
    seed_exercises(&mut conn)?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    register_functions(&conn)?;
    Ok(conn)
}

/// A new in-memory database at the head schema (`seeded`: with the base
/// exercises, as [`open`] makes one), copied from one built once in this
/// process: tests open hundreds, and migrating each takes a fifth of a
/// second.
fn open_memory(seeded: bool) -> Result<Connection, Error> {
    static TEMPLATES: std::sync::Mutex<[Option<Connection>; 2]> =
        std::sync::Mutex::new([None, None]);
    let mut templates = TEMPLATES
        .lock()
        .map_err(|_| Error::Internal("an in-memory template failed to build".into()))?;
    let slot = &mut templates[usize::from(seeded)];
    if slot.is_none() {
        let mut built = Connection::open_in_memory()?;
        migrate(&mut built)?;
        if seeded {
            seed_exercises(&mut built)?;
        }
        *slot = Some(built);
    }
    let template = slot
        .as_ref()
        .ok_or_else(|| Error::Internal("no in-memory template".into()))?;
    let mut conn = Connection::open_in_memory()?;
    // Every page in one step: nothing else writes either database.
    let copied = rusqlite::backup::Backup::new(template, &mut conn)?.step(-1)?;
    if !matches!(copied, rusqlite::backup::StepResult::Done) {
        return Err(Error::Internal("an in-memory copy stopped short".into()));
    }
    conn.pragma_update(None, "foreign_keys", "ON")?;
    register_functions(&conn)?;
    Ok(conn)
}

/// Open the database read-only, for a command that only reads: never
/// migrated, so refused unless its schema is this binary's.
///
/// # Errors
/// It can't be opened, or its schema is older or newer.
pub fn open_read_only(path: &Path) -> Result<Connection, Error> {
    let conn = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let found: u32 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
    let supported = MIGRATIONS.len();
    match (found as usize).cmp(&supported) {
        std::cmp::Ordering::Less => Err(Error::SchemaTooOld { found, supported }),
        std::cmp::Ordering::Greater => Err(Error::SchemaTooNew { found, supported }),
        std::cmp::Ordering::Equal => Ok(conn),
    }
}

/// Rewrite the file when a quarter or more of it is free pages (a rebuilt
/// table, a source's data removed): it shrinks, and on a copy-on-write disk
/// its pages lie together again. For the server's start: it needs the file
/// to itself, and can take minutes on a large one.
///
/// # Errors
/// Another connection kept writing past the busy timeout, or a database
/// error; nothing changed then.
pub fn vacuum_when_free(conn: &Connection) -> Result<(), Error> {
    let count: i64 = conn.pragma_query_value(None, "page_count", |r| r.get(0))?;
    let free: i64 = conn.pragma_query_value(None, "freelist_count", |r| r.get(0))?;
    if free > 0 && free * 4 >= count {
        tracing::info!(pages = count, free, "vacuuming the database");
        // The rewrite passes through the WAL: empty it after, or it stays
        // the file's size on disk until the server stops.
        conn.execute_batch("VACUUM; PRAGMA wal_checkpoint(TRUNCATE);")?;
    }
    Ok(())
}

/// `path` with `suffix` added to its file name.
fn beside(path: &Path, suffix: &str) -> std::path::PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(suffix);
    std::path::PathBuf::from(name)
}

/// A snapshot's version and second from its name (`<db>.pre-v<N>` or
/// `<db>.pre-v<N>.<secs>`); `None` for anything else (a `.partial` too).
fn snapshot_order(db_name: &str, file_name: &str) -> Option<(u32, u64)> {
    let rest = file_name.strip_prefix(db_name)?.strip_prefix(".pre-v")?;
    let (version, secs) = rest.split_once('.').unwrap_or((rest, "0"));
    Some((version.parse().ok()?, secs.parse().ok()?))
}

/// Keep the newest two snapshots of `path` by version (then time), and
/// always `keep`, the one this start used; `.partial` files are another
/// process's. Best effort: a file that won't go stays, logged.
fn prune_snapshots(path: &Path, keep: &Path) {
    let dir = match path.parent() {
        Some(d) if !d.as_os_str().is_empty() => d,
        _ => Path::new("."),
    };
    let Some(db_name) = path.file_name().and_then(|n| n.to_str()) else {
        return;
    };
    let Ok(files) = std::fs::read_dir(dir) else {
        return;
    };
    let mut snapshots: Vec<((u32, u64), std::path::PathBuf)> = files
        .filter_map(Result::ok)
        .filter_map(|e| {
            let order = snapshot_order(db_name, e.file_name().to_str()?)?;
            Some((order, e.path()))
        })
        .collect();
    snapshots.sort_by_key(|s| std::cmp::Reverse(s.0));
    for (_, old) in snapshots.into_iter().skip(2) {
        if old.file_name() == keep.file_name() {
            continue;
        }
        match std::fs::remove_file(&old) {
            Ok(()) => tracing::info!(snapshot = %old.display(), "removed an old snapshot"),
            Err(e) => {
                tracing::warn!(snapshot = %old.display(), error = %e, "couldn't remove an old snapshot");
            }
        }
    }
}

/// - `fold(text)`: Unicode lowercase. `SQLite`'s own `lower` and `LIKE`
///   fold ASCII only, so "äyri" would miss "Äyriäiset".
/// - `plain(text)`: [`foods::plain`], what search compares.
/// - `near(text, word)`: [`foods::near`], search's typo match.
/// - `fit_score(energy, protein, net_carbs, fat, portion_g, left energy,
///   protein, net_carbs, fat)`: [`crate::model::fit_score`]; a missing
///   macro counts as 0, a missing energy gives `NULL`.
fn register_functions(conn: &Connection) -> rusqlite::Result<()> {
    use rusqlite::functions::FunctionFlags;
    let flags = FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC;
    conn.create_scalar_function("fold", 1, flags, |ctx| {
        Ok(ctx.get::<Option<String>>(0)?.map(|s| s.to_lowercase()))
    })?;
    conn.create_scalar_function("plain", 1, flags, |ctx| {
        Ok(ctx.get::<Option<String>>(0)?.map(|s| foods::plain(&s)))
    })?;
    conn.create_scalar_function("near", 2, flags, |ctx| {
        Ok(foods::near(&ctx.get::<String>(0)?, &ctx.get::<String>(1)?))
    })?;
    conn.create_scalar_function("fit_score", 9, flags, |ctx| {
        let at = |i| ctx.get::<Option<f64>>(i);
        // Energy, protein, net carbs and fat from argument `i` on.
        let macros = |i: usize| -> rusqlite::Result<Option<Macros>> {
            let Some(energy) = at(i)? else {
                return Ok(None);
            };
            Ok(Some(Macros {
                energy,
                protein: at(i + 1)?.unwrap_or(0.0),
                net_carbs: at(i + 2)?.unwrap_or(0.0),
                fat: at(i + 3)?.unwrap_or(0.0),
            }))
        };
        let (Some(food), Some(left)) = (macros(0)?, macros(5)?) else {
            return Ok(None);
        };
        Ok(crate::model::fit_score(
            &food,
            at(4)?.unwrap_or(100.0),
            &left,
        ))
    })
}

/// A write transaction holding the write lock from the start (IMMEDIATE):
/// a read-then-write in a deferred one fails at once with `SQLITE_BUSY` if
/// another process wrote meanwhile, skipping `busy_timeout`.
pub fn write(conn: &mut Connection) -> rusqlite::Result<Transaction<'_>> {
    conn.transaction_with_behavior(TransactionBehavior::Immediate)
}

/// Copy an existing database to `<path>.pre-v<version>` before migrating it,
/// so an upgrade can be rolled back by restoring that file with the previous
/// binary: `(version, snapshot)`, `None` when nothing will migrate. The copy
/// is written under a temporary name and renamed when complete, so a crash
/// never leaves a truncated snapshot behind.
///
/// An existing `.pre-v<version>` is this file's copy, and reused, only when
/// neither the file nor its WAL changed since the copy, or since the marker
/// a failed migration left (a failing start restarted by systemd writes no
/// second copy). Otherwise (a rolled-back file used since) this one gets a
/// timestamped name beside it.
fn snapshot_before_migrating(
    conn: &Connection,
    path: &Path,
) -> Result<Option<(u32, std::path::PathBuf)>, Error> {
    let version: u32 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
    if version == 0 || version as usize >= MIGRATIONS.len() {
        return Ok(None);
    }
    let mut target = beside(path, &format!(".pre-v{version}"));
    if target.exists() {
        // A WAL holding no frames is one this open just made, not a write.
        let changed = |p: &Path| {
            std::fs::metadata(p)
                .ok()
                .filter(|m| m.len() > 0)
                .and_then(|m| m.modified().ok())
        };
        let unchanged_since = |since: &Path| {
            let since = std::fs::metadata(since).and_then(|m| m.modified()).ok();
            [path.to_owned(), beside(path, "-wal")]
                .iter()
                .all(|p| changed(p).is_none_or(|m| since.is_some_and(|s| s >= m)))
        };
        let marker = beside(path, &format!(".migrating-v{version}"));
        if unchanged_since(&target) || (marker.exists() && unchanged_since(&marker)) {
            tracing::info!(snapshot = %target.display(), "reusing the snapshot of this file");
            return Ok(Some((version, target)));
        }
        let secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_secs());
        tracing::warn!(existing = %target.display(), "an older snapshot for this version exists; keeping it");
        target = beside(path, &format!(".pre-v{version}.{secs}"));
    }
    // Its own name, so two processes upgrading at once never write one file.
    let partial = beside(
        path,
        &format!(".pre-v{version}.{}.partial", std::process::id()),
    );
    snapshot_to(conn, &partial, &target)?;
    tracing::info!(snapshot = %target.display(), "saved a copy before migrating");
    Ok(Some((version, target)))
}

/// Copy the database to `partial`, then name it `target`. A failed copy
/// leaves no partial file behind.
fn snapshot_to(conn: &Connection, partial: &Path, target: &Path) -> Result<(), Error> {
    // A partial file from a crashed attempt (a reused pid) is worthless.
    let _ = std::fs::remove_file(partial);
    let copied = conn
        .execute("VACUUM INTO ?", [partial.to_string_lossy()])
        .map_err(Error::from)
        .and_then(|_| {
            std::fs::rename(partial, target)
                .map_err(|e| Error::Internal(format!("saving {}: {e}", target.display())))
        });
    if copied.is_err() {
        let _ = std::fs::remove_file(partial);
    }
    copied
}

/// Run the migrations after `from` up to `to` on `tx`, each with its
/// Rust step, stamping the version after each.
fn migrate_to(tx: &Transaction, from: u32, to: usize) -> Result<(), Error> {
    for (v, sql) in (1..).zip(&MIGRATIONS[..to]).skip(from as usize) {
        tx.execute_batch(sql)
            .map_err(|e| Error::Migration(format!("migration {v}: {e}")))?;
        tx.pragma_update(None, "user_version", v)?;
        if RECOMPUTE_RECIPES_AFTER.contains(&v) {
            recompute_all_recipes(tx)?;
        }
        if v == REDERIVE_DRINKS_AFTER {
            rederive_drinks(tx)?;
        }
    }
    Ok(())
}

fn migrate(conn: &mut Connection) -> Result<(), Error> {
    // Migrations rebuild tables; with foreign keys on, dropping a parent table
    // would cascade into its children. The bundled SQLite enables them by
    // default, and the pragma is a no-op inside a transaction, so set it here.
    conn.pragma_update(None, "foreign_keys", "OFF")?;
    // A current file needs no lock: a start beside a long import goes on.
    let current: u32 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
    if current as usize == MIGRATIONS.len() {
        return Ok(());
    }
    // IMMEDIATE takes the write lock before reading the version again, so a
    // server and an import opening a fresh file at once can't both migrate it.
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let version: u32 = tx.pragma_query_value(None, "user_version", |r| r.get(0))?;
    if version as usize > MIGRATIONS.len() {
        return Err(Error::SchemaTooNew {
            found: version,
            supported: MIGRATIONS.len(),
        });
    }
    if version as usize == MIGRATIONS.len() {
        return Ok(());
    }
    migrate_to(&tx, version, MIGRATIONS.len())?;
    // A rebuild must not leave a row pointing at nothing; name a few so the
    // operator can find them. Nothing is committed then.
    let dangling: Vec<String> = tx
        .prepare("SELECT \"table\", rowid, parent FROM pragma_foreign_key_check LIMIT 5")?
        .query_map([], |r| {
            Ok(format!(
                "{} row {} (missing {})",
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, String>(2)?
            ))
        })?
        .collect::<rusqlite::Result<_>>()?;
    if !dangling.is_empty() {
        return Err(Error::Migration(format!(
            "migrating would leave rows pointing at missing ones: {}",
            dangling.join(", ")
        )));
    }
    // What a migration changed, entries follow: at the next `DERIVED`.
    tx.execute("DELETE FROM meta WHERE key = ?", [ENTRIES_KEY])?;
    tracing::info!(
        from = version,
        to = MIGRATIONS.len(),
        "migrated the database"
    );
    tx.commit()?;
    Ok(())
}

/// A family's refresh: every profile's data made again by the rule, in the
/// transaction given; how much it made (rows or days), for the log.
#[derive(Clone, Copy)]
pub enum Refresh {
    /// Needs no time zone.
    Plain(fn(&Transaction) -> Result<usize, Error>),
    /// Its days fall in the server's time zone (`serve --time-zone`), at
    /// `now`: a command without one leaves it to the next `serve`.
    Zoned(fn(&Transaction, &TimeZone, i64) -> Result<usize, Error>),
}

/// One family of derived data: stored values made from others by
/// a rule, kept current by [`derived_current`]. Its `meta` key holds the
/// rule's version it was made by; `after` names the family whose run makes
/// it run again (its input moved).
pub struct Derived {
    pub key: &'static str,
    pub version: i64,
    pub after: Option<&'static str>,
    pub refresh: Refresh,
}

/// The `meta` key of entries following their foods: a migration clears it.
const ENTRIES_KEY: &str = "entry_rule_version";

/// Every family of derived data, in dependency order: recipes → entries →
/// labels → nights → resting → distance → weights → copies. The one place a new
/// derived rule registers. `RECOMPUTE_RECIPES_AFTER` and
/// `REDERIVE_DRINKS_AFTER` aren't here: they are steps of migrations,
/// frozen with them; `recipes` is for rule changes after.
pub const DERIVED: &[Derived] = &[
    // Food families (`db/foods.rs`).
    Derived {
        key: "recipe_rule_version",
        version: 1,
        after: None,
        refresh: Refresh::Plain(|tx| Ok(foods::recipes_refresh(tx)?)),
    },
    Derived {
        key: ENTRIES_KEY,
        version: 1,
        after: Some("recipe_rule_version"),
        refresh: Refresh::Plain(|tx| Ok(foods::all_entries_follow(tx)?)),
    },
    Derived {
        key: "label_rules_version",
        version: crate::model::LABEL_RULES_VERSION,
        after: None,
        refresh: Refresh::Plain(foods::labels_refresh),
    },
    // Health Connect's (`db/derived.rs`), and the day weights its wake
    // times pick.
    Derived {
        key: "night_rule_version",
        version: derived::NIGHT_RULE_VERSION,
        after: None,
        refresh: Refresh::Zoned(|tx, tz, _| derived::nights_refresh(tx, tz)),
    },
    Derived {
        key: "resting_rule_version",
        version: derived::RESTING_RULE_VERSION,
        after: None,
        refresh: Refresh::Plain(derived::resting_refresh),
    },
    Derived {
        key: "distance_rule_version",
        version: derived::DISTANCE_RULE_VERSION,
        after: None,
        refresh: Refresh::Plain(derived::distance_refresh),
    },
    Derived {
        key: "weight_rule_version",
        version: scale::WEIGHT_RULE_VERSION,
        after: Some("night_rule_version"),
        refresh: Refresh::Zoned(|tx, tz, now| scale::weights_repick(tx, None, now, tz)),
    },
    Derived {
        key: "copy_rule_version",
        version: 1,
        after: None,
        refresh: Refresh::Plain(|tx| device_sessions::copies_collapse(tx, None)),
    },
];

/// The `meta` key of the zone the zoned families were made in.
const TIME_ZONE_KEY: &str = "time_zone";

/// The IANA zone the stored days were made in, once a `serve` named one.
///
/// # Errors
/// A read fails.
pub fn stored_time_zone(conn: &Connection) -> Result<Option<String>, Error> {
    Ok(conn
        .query_row(
            "SELECT value FROM meta WHERE key = ?",
            [TIME_ZONE_KEY],
            |r| r.get(0),
        )
        .optional()?)
}

/// Whether family `key` counts its days in a zone.
#[must_use]
pub fn is_zoned(key: &str) -> bool {
    DERIVED
        .iter()
        .any(|f| f.key == key && matches!(f.refresh, Refresh::Zoned(_)))
}

/// Bring the data derived from what is stored up to its rules
/// ([`DERIVED`]): a family whose stored version isn't its rule's, or whose
/// `after` made something this run, is made again and stamped, each in one
/// transaction. `serve` runs it after `open` with its zone, every other
/// command with `None` (the zoned families wait for the next `serve`); a
/// zone other than the one stored makes the zoned families again, and is
/// stored once they all ran. A family that fails is logged and left
/// unstamped (the next start tries again); the others still run: only a
/// failed migration stops a start. What ran, and how much each made.
pub fn derived_current(
    conn: &mut Connection,
    tz: Option<&TimeZone>,
    now: i64,
) -> BTreeMap<&'static str, usize> {
    derived_run(conn, DERIVED, tz, now)
}

fn derived_run(
    conn: &mut Connection,
    families: &[Derived],
    tz: Option<&TimeZone>,
    now: i64,
) -> BTreeMap<&'static str, usize> {
    let mut ran = BTreeMap::new();
    let zone = tz.and_then(TimeZone::iana_name);
    let stored = stored_time_zone(conn).unwrap_or_else(|e| {
        tracing::error!(error = %e, "the stored time zone can't be read");
        None
    });
    let rezone = zone.is_some() && stored.is_some() && stored.as_deref() != zone;
    let mut zoned_failed = false;
    for f in families {
        let zoned = matches!(f.refresh, Refresh::Zoned(_));
        let moved =
            (rezone && zoned) || f.after.is_some_and(|a| ran.get(a).is_some_and(|&n| n > 0));
        match derived_one(conn, f, tz, now, moved) {
            Ok(Some(made)) => {
                tracing::info!(
                    key = f.key,
                    version = f.version,
                    made,
                    "derived data follows its rule"
                );
                ran.insert(f.key, made);
            }
            Ok(None) => {}
            Err(e) => {
                zoned_failed |= zoned;
                tracing::error!(
                    key = f.key,
                    error = %e,
                    "derived data not made again; the next start tries again"
                );
            }
        }
    }
    if let Some(zone) = zone
        && !zoned_failed
    {
        time_zone_store(conn, stored.as_deref(), zone);
    }
    ran
}

/// Store `zone` as the one the zoned families were made in, when it isn't
/// already; a failure is logged (the next start tries again).
fn time_zone_store(conn: &Connection, stored: Option<&str>, zone: &str) {
    if stored == Some(zone) {
        return;
    }
    if let Some(from) = stored {
        tracing::warn!(from, to = zone, "stored days made again in a new time zone");
    }
    if let Err(e) = conn.execute(
        "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
        params![TIME_ZONE_KEY, zone],
    ) {
        tracing::error!(error = %e, "the time zone isn't stored; the next start tries again");
    }
}

/// One family: made again and stamped when due; `None` when not (or when
/// it needs a zone and has none).
fn derived_one(
    conn: &mut Connection,
    f: &Derived,
    tz: Option<&TimeZone>,
    now: i64,
    moved: bool,
) -> Result<Option<usize>, Error> {
    let stamp = |c: &Connection| -> Result<Option<i64>, Error> {
        Ok(
            c.query_row("SELECT value FROM meta WHERE key = ?", [f.key], |r| {
                r.get(0)
            })
            .optional()?,
        )
    };
    // Read first: the write lock only when due.
    if stamp(conn)? == Some(f.version) && !moved {
        return Ok(None);
    }
    let tx = write(conn)?;
    if stamp(&tx)? == Some(f.version) && !moved {
        return Ok(None);
    }
    let made = match (f.refresh, tz) {
        (Refresh::Plain(refresh), _) => refresh(&tx)?,
        (Refresh::Zoned(refresh), Some(tz)) => refresh(&tx, tz, now)?,
        (Refresh::Zoned(_), None) => return Ok(None),
    };
    tx.execute(
        "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
        params![f.key, f.version],
    )?;
    tx.commit()?;
    Ok(Some(made))
}

/// An update of row `id` in `table` (a fixed name, never request text) is
/// made from revision `rev`: 404 when the row is gone, 409 `stale` when
/// someone else changed it since; else its revision moves on.
fn bump_rev(
    conn: &Connection,
    table: &str,
    resource: &'static str,
    id: i64,
    rev: Option<i64>,
) -> Result<(), Error> {
    let rev = rev.ok_or_else(|| Error::invalid_field("rev", "rev is required to update"))?;
    let current: Option<i64> = conn
        .query_row(
            &format!("SELECT rev FROM {table} WHERE id = ?"),
            [id],
            |r| r.get(0),
        )
        .optional()?;
    match current {
        None => Err(Error::not_found(resource, id)),
        Some(c) if c != rev => Err(Error::conflict(
            Conflict::Stale,
            format!("this {resource} was changed elsewhere; reload to see the change"),
        )),
        Some(_) => {
            conn.execute(
                &format!("UPDATE {table} SET rev = rev + 1 WHERE id = ?"),
                [id],
            )?;
            Ok(())
        }
    }
}

/// A row this transaction just wrote is always readable back.
fn written<T>(row: Option<T>) -> T {
    row.expect("row written in this transaction")
}

/// Plain data (finite floats, strings, unit enums) as JSON; that can't fail.
fn json(value: &impl Serialize) -> String {
    serde_json::to_string(value).expect("plain data always serialises")
}

fn from_json<T: serde::de::DeserializeOwned>(s: &str) -> rusqlite::Result<T> {
    serde_json::from_str(s).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, e.into())
    })
}

mod activities;
mod cronometer;
mod derived;
mod device;
mod device_sessions;
mod diary;
mod exercises;
mod feedback;
mod foods;
mod habits;
mod health_record;
mod hooks;
mod migrations;
mod photos;
mod profiles;
mod reports;
mod scale;
mod targets;
#[cfg(test)]
mod tests;

#[cfg(test)]
mod snapshot {
    use super::*;

    #[test]
    fn failed_snapshot_leaves_no_partial() {
        let dir = std::env::temp_dir().join(format!("kaloriina-snap-{}", std::process::id()));
        // The name is taken by a directory with something in it: the rename
        // fails.
        let target = dir.join("db.pre-v1");
        std::fs::create_dir_all(target.join("taken")).unwrap();
        let partial = dir.join("db.pre-v1.1.partial");
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE t (x); INSERT INTO t VALUES (1);")
            .unwrap();
        let failed = snapshot_to(&conn, &partial, &target);
        let left = partial.exists();
        std::fs::remove_dir_all(&dir).unwrap();
        assert!(failed.is_err());
        assert!(!left, "the partial copy is removed");
    }
}
mod transfer;
mod workouts;

#[cfg(test)]
mod derived_tests {
    use super::*;

    fn memory() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        migrate(&mut conn).unwrap();
        conn
    }

    fn stamped(conn: &Connection, key: &str) -> Option<i64> {
        conn.query_row("SELECT value FROM meta WHERE key = ?", [key], |r| r.get(0))
            .optional()
            .unwrap()
    }

    /// Each family runs once per rule version, stamped.
    #[test]
    fn derived_runs_once_per_version() {
        let mut conn = memory();
        let ran = derived_current(&mut conn, Some(&TimeZone::UTC), 0);
        let keys: Vec<&str> = DERIVED.iter().map(|f| f.key).collect();
        assert_eq!(
            ran.keys().copied().collect::<BTreeSet<_>>(),
            keys.iter().copied().collect()
        );
        for f in DERIVED {
            assert_eq!(stamped(&conn, f.key), Some(f.version), "{}", f.key);
        }
        assert!(derived_current(&mut conn, Some(&TimeZone::UTC), 0).is_empty());
    }

    /// The zone the server's days were made in is stored; another zone
    /// makes the zoned families again, a command without one keeps it.
    #[test]
    fn a_new_time_zone_remakes_the_zoned_families() {
        let mut conn = memory();
        let helsinki = TimeZone::get("Europe/Helsinki").unwrap();
        let zoned: BTreeSet<&str> = ["night_rule_version", "weight_rule_version"].into();
        derived_current(&mut conn, Some(&TimeZone::UTC), 0);
        assert!(derived_current(&mut conn, Some(&TimeZone::UTC), 0).is_empty());
        assert!(derived_current(&mut conn, None, 0).is_empty());
        let ran = derived_current(&mut conn, Some(&helsinki), 0);
        assert_eq!(ran.into_keys().collect::<BTreeSet<_>>(), zoned);
        assert_eq!(
            stored_time_zone(&conn).unwrap().as_deref(),
            Some("Europe/Helsinki")
        );
        assert!(derived_current(&mut conn, Some(&helsinki), 0).is_empty());
    }

    /// A family stamped by an older rule runs again; one that made
    /// something takes the family after it along (nights move wake times,
    /// which pick weights).
    #[test]
    fn a_bumped_rule_reruns() {
        let mut conn = memory();
        derived_current(&mut conn, Some(&TimeZone::UTC), 0);
        conn.execute(
            "UPDATE meta SET value = value - 1 WHERE key = 'resting_rule_version'",
            [],
        )
        .unwrap();
        let ran = derived_current(&mut conn, Some(&TimeZone::UTC), 0);
        assert_eq!(
            ran.into_keys().collect::<Vec<_>>(),
            ["resting_rule_version"]
        );
        let families = [
            Derived {
                key: "first",
                version: 1,
                after: None,
                refresh: Refresh::Plain(|_| Ok(1)),
            },
            Derived {
                key: "second",
                version: 1,
                after: Some("first"),
                refresh: Refresh::Plain(|_| Ok(0)),
            },
        ];
        derived_run(&mut conn, &families, None, 0);
        conn.execute("DELETE FROM meta WHERE key = 'first'", [])
            .unwrap();
        let ran = derived_run(&mut conn, &families, None, 0);
        assert_eq!(ran.into_keys().collect::<Vec<_>>(), ["first", "second"]);
    }

    /// A family that fails is logged and left unstamped (the
    /// next start tries again); the others still run.
    #[test]
    fn a_failed_refresh_leaves_its_version_unstamped() {
        let mut conn = memory();
        let families = [
            Derived {
                key: "broken",
                version: 1,
                after: None,
                refresh: Refresh::Plain(|tx| {
                    tx.execute("INSERT INTO meta (key, value) VALUES ('half', 1)", [])?;
                    Err(Error::Internal("a bad record".into()))
                }),
            },
            Derived {
                key: "fine",
                version: 1,
                after: None,
                refresh: Refresh::Plain(|_| Ok(0)),
            },
        ];
        let ran = derived_run(&mut conn, &families, None, 0);
        assert_eq!(ran.into_keys().collect::<Vec<_>>(), ["fine"]);
        assert_eq!(stamped(&conn, "broken"), None);
        assert_eq!(stamped(&conn, "half"), None, "rolled back");
        assert_eq!(stamped(&conn, "fine"), Some(1));
    }

    /// A command without the server's zone runs the zone-free
    /// families; nights and weights wait for `serve`.
    #[test]
    fn without_a_zone_nights_and_weights_wait() {
        let mut conn = memory();
        let ran = derived_current(&mut conn, None, 0);
        for zoned in ["night_rule_version", "weight_rule_version"] {
            assert!(!ran.contains_key(zoned), "{zoned}");
            assert_eq!(stamped(&conn, zoned), None, "{zoned}");
        }
        assert_eq!(stamped(&conn, "resting_rule_version"), Some(1));
        let ran = derived_current(&mut conn, Some(&TimeZone::UTC), 0);
        assert_eq!(
            ran.into_keys().collect::<Vec<_>>(),
            ["night_rule_version", "weight_rule_version"]
        );
    }

    /// Item 4's backfill: resting energy made once from the raw history
    /// kept before the server derived it.
    #[test]
    fn resting_is_made_once_from_kept_history() {
        let mut conn = memory();
        conn.execute_batch(
            "INSERT INTO health_record (profile_id, source, kind, record_id, start_at, day,
                 data, received_at)
             VALUES (1, 'health_connect', 'BasalMetabolicRate', 'b-1',
                     '2025-03-01T06:00:00Z', '2025-03-01',
                     '{\"kcal_per_day\":1650,\"metadata\":{\"data_origin\":\"com.fitbit.FitbitMobile\"}}', 0);",
        )
        .unwrap();
        let ran = derived_current(&mut conn, None, 0);
        assert_eq!(ran.get("resting_rule_version"), Some(&1));
        let kept: (f64, String) = conn
            .query_row(
                "SELECT bmr_kcal, bmr_origin FROM device_day WHERE day = '2025-03-01'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(kept, (1650.0, "com.fitbit.FitbitMobile".to_owned()));
        assert!(!derived_current(&mut conn, None, 0).contains_key("resting_rule_version"));
    }

    /// A day's distance made once from the raw history kept before the
    /// server derived it: the records' sum, in whole metres.
    #[test]
    fn distance_is_made_once_from_kept_history() {
        let mut conn = memory();
        conn.execute_batch(
            "INSERT INTO health_record (profile_id, source, kind, record_id, start_at, day,
                 data, received_at)
             VALUES (1, 'health_connect', 'Distance', 'd-1', '2025-03-01T06:00:00Z',
                     '2025-03-01',
                     '{\"meters\":1200.6,\"metadata\":{\"data_origin\":\"com.fitbit.FitbitMobile\"}}', 0),
                    (1, 'health_connect', 'Distance', 'd-2', '2025-03-01T16:00:00Z',
                     '2025-03-01',
                     '{\"meters\":4900,\"metadata\":{\"data_origin\":\"com.fitbit.FitbitMobile\"}}', 0);",
        )
        .unwrap();
        let ran = derived_current(&mut conn, None, 0);
        assert_eq!(ran.get("distance_rule_version"), Some(&1));
        let kept: i64 = conn
            .query_row(
                "SELECT distance_m FROM device_day WHERE day = '2025-03-01'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(kept, 6101);
        assert!(!derived_current(&mut conn, None, 0).contains_key("distance_rule_version"));
    }
}

#[cfg(test)]
mod layering {
    /// `db` stores and reads; the importers call it, never the other way
    /// (the night rule and the Cronometer types live in `model`).
    #[test]
    fn db_calls_no_importer() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/db");
        let mut edges = Vec::new();
        for e in std::fs::read_dir(dir).unwrap() {
            let p = e.unwrap().path();
            let text = std::fs::read_to_string(&p).unwrap();
            for (i, line) in text.lines().enumerate() {
                let code = line.trim_start();
                if !code.starts_with("//")
                    && ["google_health", "import"]
                        .iter()
                        .any(|m| code.contains(&format!("crate::{m}")))
                {
                    edges.push(format!("{}:{}", p.display(), i + 1));
                }
            }
        }
        assert_eq!(edges, Vec::<String>::new());
    }

    /// A sync keeps an activity's energy only when its source
    /// outranks the device's ([`crate::model::Provenance`]); the words its
    /// SQL names are exactly those.
    #[test]
    fn the_syncs_kcal_sql_follows_provenance() {
        use crate::model::{KcalSource, Provenance};
        use std::collections::BTreeSet;
        let text = include_str!("device_sessions.rs");
        let mut named = BTreeSet::new();
        for (at, _) in text.match_indices("kcal_source IS ") {
            let rest = text[at + "kcal_source IS ".len()..].trim_start_matches("NOT ");
            if let Some(word) = rest.strip_prefix('\'') {
                named.insert(&word[..word.find('\'').unwrap()]);
            }
        }
        let outranks: BTreeSet<&str> = KcalSource::ALL
            .iter()
            .filter(|&&k| Provenance::from(k) < Provenance::HealthConnect)
            .map(|k| k.as_str())
            .collect();
        assert!(!named.is_empty());
        assert_eq!(named, outranks);
    }
}

pub use activities::*;
pub use cronometer::*;
pub use derived::{device_replace, records_put};
pub use device::*;
pub use device_sessions::*;
pub use diary::*;
pub use exercises::*;
pub use feedback::*;
pub use foods::*;
pub use habits::*;
pub use health_record::*;
pub use hooks::*;
use migrations::MIGRATIONS;
pub use photos::*;
pub use profiles::*;
pub use reports::*;
pub use scale::*;
pub use targets::*;
pub use transfer::*;
pub use workouts::*;
