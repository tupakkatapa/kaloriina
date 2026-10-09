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
//!   with what it holds (recipes, meals, exercises, workouts, sessions);
//! - `upsert_<source>` adds or updates rows keyed by an outside id;
//! - `replace` swaps a whole set (targets, imported days);
//! - `set` writes one keyed value, the same every time (a favourite, a
//!   day's weight);
//! - `delete` removes by id;
//! - `log` writes diary entries.
//!
//! Reads keyed by something other than id are `<resource>_by_<key>` or
//! `<resource>_list_for_<key>`; `group_totals` aggregates a date range
//! (`group_rows`, then `group_sums`) and `recipe_per100` is pure arithmetic.
//!
//! Transactions: functions taking `&mut Connection` open their own;
//! functions taking `&Connection` run inside whatever the caller holds.
//!
//! Writes return the stored entity, read back in the same transaction.
//! Updates of whole entities (foods, recipes, meals, exercises, workouts,
//! profiles, sessions) name the `rev` they were made from; see [`bump_rev`].

/// What the resource modules share: each starts with `use super::prelude::*`.
mod prelude {
    pub(super) use std::collections::{BTreeMap, BTreeSet};
    pub(super) use std::path::Path;
    pub(super) use std::time::Duration;

    pub(super) use rusqlite::types::{FromSql, FromSqlError, FromSqlResult, ToSqlOutput, ValueRef};
    pub(super) use rusqlite::{
        Connection, OptionalExtension, Params, Row, ToSql, Transaction, TransactionBehavior, params,
    };

    pub(super) use serde::Serialize;

    pub(super) use crate::error::{Conflict, Error};
    pub(super) use crate::model::{
        Body, DayTotal, Entry, Exercise, ExerciseInput, ExerciseSource, ExerciseTraits, Food,
        FoodInput, ImportedEntry, Item, Meal, MealInput, Measure, Measured, Profile, ProfileId,
        ProfileInput, Recipe, RecipeInput, Serving, Session, SessionInput, SessionSet,
        SessionSource, SessionType, Sex, Side, Sort, Source, Step, SyncedWorkouts, Target,
        WHOLE_RECIPE, Weight, WeightSource, Workout, WorkoutInput, exercise_steps, gram_amount,
        step_fits,
    };
    pub(super) use crate::model::{Macros, MergeInput, PORTION, SERVINGS_MAX, Usage};
    pub(super) use crate::nutrients::Nutrients;

    pub(super) use super::{bump_rev, exercise_get, food_get, from_json, json, write, written};
}

use prelude::*;

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

use crate::model::GoalDir;

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
    Measure,
    ExerciseSource,
    Sex,
    Side,
    WeightSource,
    SessionType,
    SessionSource,
    SyncedWorkouts,
    GoalDir
);

/// Migrations after which recipes are recomputed from their ingredients
/// (4: values; 20: the "Whole recipe" serving).
const RECOMPUTE_RECIPES_AFTER: [u32; 2] = [4, 20];

/// Open (or create) the database and bring the schema up to date.
///
/// Migrating an existing file is bracketed: a snapshot first
/// (see [`snapshot_before_migrating`]), then a marker `<db>.migrating-v<N>`
/// that only a successful migration removes, then the snapshots pruned to
/// the newest two.
pub fn open(path: &Path) -> Result<Connection, Error> {
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
/// - `fit_score(energy, protein, net_carbs, fat, portion_g, left energy,
///   protein, net_carbs, fat)`: [`crate::model::fit_score`]; a missing
///   macro counts as 0, a missing energy gives `NULL`.
fn register_functions(conn: &Connection) -> rusqlite::Result<()> {
    use rusqlite::functions::FunctionFlags;
    let flags = FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC;
    conn.create_scalar_function("fold", 1, flags, |ctx| {
        Ok(ctx.get::<Option<String>>(0)?.map(|s| s.to_lowercase()))
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
/// a failed migration left its marker or the copy is no older than the
/// file and its WAL (a failing start restarted by systemd writes no second
/// copy). Otherwise (a rolled-back file used since) this one gets a
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
        let marked = beside(path, &format!(".migrating-v{version}")).exists();
        let modified = |p: &Path| std::fs::metadata(p).and_then(|m| m.modified()).ok();
        let copied = modified(&target);
        let fresh = [path.to_owned(), beside(path, "-wal")]
            .iter()
            .all(|p| modified(p).is_none_or(|m| copied.is_some_and(|c| c >= m)));
        if marked || fresh {
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
    // A partial file from a crashed attempt (a reused pid) is worthless.
    let _ = std::fs::remove_file(&partial);
    conn.execute("VACUUM INTO ?", [partial.to_string_lossy()])?;
    std::fs::rename(&partial, &target)
        .map_err(|e| Error::Internal(format!("saving {}: {e}", target.display())))?;
    tracing::info!(snapshot = %target.display(), "saved a copy before migrating");
    Ok(Some((version, target)))
}

fn migrate(conn: &mut Connection) -> Result<(), Error> {
    // Migrations rebuild tables; with foreign keys on, dropping a parent table
    // would cascade into its children. The bundled SQLite enables them by
    // default, and the pragma is a no-op inside a transaction, so set it here.
    conn.pragma_update(None, "foreign_keys", "OFF")?;
    // IMMEDIATE takes the write lock before reading the version, so a server
    // and an import opening a fresh file at once can't both migrate it.
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
    for (v, sql) in (1..).zip(MIGRATIONS).skip(version as usize) {
        tx.execute_batch(sql)
            .map_err(|e| Error::Migration(format!("migration {v}: {e}")))?;
        tx.pragma_update(None, "user_version", v)?;
        if RECOMPUTE_RECIPES_AFTER.contains(&v) {
            recompute_all_recipes(&tx)?;
        }
    }
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
    tracing::info!(
        from = version,
        to = MIGRATIONS.len(),
        "migrated the database"
    );
    tx.commit()?;
    Ok(())
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

mod activity;
mod diary;
mod exercises;
mod foods;
mod habits;
mod import;
mod migrations;
mod profiles;
mod reports;
mod scale;
mod sessions;
mod sync_workouts;
mod targets;
#[cfg(test)]
mod tests;
mod transfer;
mod workouts;

pub use activity::*;
pub use diary::*;
pub use exercises::*;
pub use foods::*;
pub use habits::*;
pub use import::*;
use migrations::MIGRATIONS;
pub use profiles::*;
pub use reports::*;
pub use scale::*;
pub use sessions::*;
pub use sync_workouts::*;
pub use targets::*;
pub use transfer::*;
pub use workouts::*;
