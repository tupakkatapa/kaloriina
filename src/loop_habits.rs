//! Loop Habit Tracker's backup (Settings → Export full backup, a `SQLite`
//! file) into a profile's habits, in one transaction; a file that can't be
//! read writes nothing.
//!
//! - **Habits:** a tracker each, keyed `loop-<uuid>` (`loop-id-<id>` in
//!   backups from before uuids). One the profile has by that key, or by
//!   name ignoring case, is counted into if it counts the same unit; else
//!   the habit is skipped. A yes/no habit counts "times"; a numerical one's
//!   target is its goal when it is per day; archived stays archived. Past
//!   [`HABITS_MAX`](crate::model::HABITS_MAX) trackers the rest are skipped.
//! - **Repetitions:** on their UTC date (Loop stores a day as its midnight
//!   in UTC). A yes, by hand (2) or automatic (1), is 1; no (0), skipped (3)
//!   and unknown (−1) are none. A numerical value is in thousandths: 0 is
//!   none, and it is at most [`HABIT_AMOUNT_MAX`]. A day the tracker
//!   already has stays as it is: the user's count wins, and again adds
//!   nothing.

use std::collections::HashMap;
use std::path::Path;

use anyhow::Context;
use jiff::Timestamp;
use jiff::tz::TimeZone;
use rusqlite::config::DbConfig;
use rusqlite::{Connection, OpenFlags};

use crate::db;
use crate::model::sleep::plausible;
use crate::model::{
    GoalDir, Gone, HABIT_AMOUNT_MAX, HabitInput, LABEL_MAX, ProfileId, UNIT_MAX, checked_uid,
    day_so_far,
};

/// What an import did.
#[derive(Debug, Default)]
pub struct Report {
    /// Trackers made.
    pub added: u32,
    /// Habits counted into a tracker the profile had.
    pub reused: u32,
    /// Days written.
    pub days: u64,
    /// Days the tracker already had, left as they were.
    pub kept: u64,
    /// Repetitions on a day that can't be stored (before year 1000, after
    /// tomorrow).
    pub bad: u64,
    /// Habits left out: name, why.
    pub skipped: Vec<(String, String)>,
}

/// A row of `Habits`.
struct Habit {
    id: i64,
    name: String,
    archived: bool,
    numerical: bool,
    /// Its target, when numerical and per day.
    goal: Option<f64>,
    goal_dir: GoalDir,
    unit: String,
    uuid: Option<String>,
}

/// The columns `table` of `src` has.
fn columns(src: &Connection, table: &str) -> rusqlite::Result<Vec<String>> {
    src.prepare("SELECT name FROM pragma_table_info(?)")?
        .query_map([table], |r| r.get(0))?
        .collect()
}

/// The backup's habits, in Loop's order; a column older backups lack reads
/// as its default.
fn habits(src: &Connection, have: &[String]) -> rusqlite::Result<Vec<Habit>> {
    let col = |c: &str, default: &str| {
        if have.iter().any(|h| h == c) {
            format!("coalesce({c}, {default})")
        } else {
            default.to_owned()
        }
    };
    let sql = format!(
        "SELECT id, coalesce(name, ''), {}, {}, {}, {}, {}, {}, {} FROM Habits ORDER BY {}, id",
        col("archived", "0"),
        col("type", "0"),
        col("target_type", "0"),
        col("target_value", "0"),
        col("unit", "''"),
        col("uuid", "NULL"),
        col("freq_den", "1"),
        col("position", "NULL"),
    );
    src.prepare(&sql)?
        .query_map([], |r| {
            let numerical = r.get::<_, i64>(3)? == 1;
            let target: f64 = r.get(5)?;
            let per_day = r.get::<_, i64>(8)? == 1;
            Ok(Habit {
                id: r.get(0)?,
                name: r.get(1)?,
                archived: r.get::<_, i64>(2)? != 0,
                numerical,
                goal: (numerical && per_day && target.is_finite() && target >= 0.0)
                    .then(|| target.min(HABIT_AMOUNT_MAX)),
                goal_dir: if r.get::<_, i64>(4)? == 1 {
                    GoalDir::AtMost
                } else {
                    GoalDir::AtLeast
                },
                unit: r.get(6)?,
                uuid: r.get(7)?,
            })
        })?
        .collect()
}

/// Each habit's repetitions: timestamp, value, value in thousandths.
type Repetitions = HashMap<i64, Vec<(i64, i64, f64)>>;

fn repetitions(src: &Connection) -> rusqlite::Result<Repetitions> {
    let mut out = Repetitions::new();
    let mut q = src.prepare(
        "SELECT habit, timestamp, value, value / 1000.0 FROM Repetitions
         WHERE habit IS NOT NULL AND timestamp IS NOT NULL AND value IS NOT NULL",
    )?;
    let mut rows = q.query([])?;
    while let Some(r) = rows.next()? {
        out.entry(r.get(0)?)
            .or_default()
            .push((r.get(1)?, r.get(2)?, r.get(3)?));
    }
    Ok(out)
}

/// The backup at `path`, read whole.
///
/// # Errors
/// Missing, or no Loop backup.
fn read(path: &Path) -> anyhow::Result<(Vec<Habit>, Repetitions)> {
    let src = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .with_context(|| format!("opening {}", path.display()))?;
    // A file from elsewhere: its schema runs no functions, and nothing can
    // write through it.
    src.set_db_config(DbConfig::SQLITE_DBCONFIG_TRUSTED_SCHEMA, false)?;
    src.set_db_config(DbConfig::SQLITE_DBCONFIG_DEFENSIVE, true)?;
    let not_loop = || format!("{} is no Loop Habit Tracker backup", path.display());
    let has = |table: &str, wanted: &[&str]| -> anyhow::Result<Vec<String>> {
        let have = columns(&src, table).with_context(not_loop)?;
        anyhow::ensure!(
            wanted.iter().all(|w| have.iter().any(|h| h == w)),
            "{}: no {table} ({})",
            not_loop(),
            wanted.join(", ")
        );
        Ok(have)
    };
    let have = has("Habits", &["id", "name"])?;
    has("Repetitions", &["habit", "timestamp", "value"])?;
    Ok((
        habits(&src, &have).with_context(not_loop)?,
        repetitions(&src).with_context(not_loop)?,
    ))
}

/// `s` trimmed, at most `max` characters.
fn clipped(s: &str, max: usize) -> String {
    s.trim()
        .chars()
        .take(max)
        .collect::<String>()
        .trim_end()
        .to_owned()
}

/// The tracker `h` is counted into: the profile's by its key or name, or a
/// new one; `Err` the reason it is skipped.
fn tracker(
    tx: &Connection,
    pid: ProfileId,
    h: &Habit,
    report: &mut Report,
) -> anyhow::Result<Result<i64, String>> {
    let uid = h
        .uuid
        .as_deref()
        .map(|u| format!("loop-{u}"))
        .filter(|u| checked_uid(u).is_ok())
        .unwrap_or_else(|| format!("loop-id-{}", h.id));
    let unit = match clipped(&h.unit, UNIT_MAX) {
        u if h.numerical && !u.is_empty() => u,
        _ => "times".to_owned(),
    };
    let input = HabitInput {
        name: clipped(&h.name, LABEL_MAX),
        unit,
        goal_value: h.goal,
        goal_dir: Some(h.goal_dir.as_str().to_owned()),
        day_limit: Gone::default(),
        archived: h.archived,
        rev: None,
        uid: Some(uid),
    };
    let input = match input.checked() {
        Ok(i) => i,
        Err(e) => return Ok(Err(e.to_string())),
    };
    Ok(db::habit_adopt(tx, pid, &input)?.map(|(id, new)| {
        if new {
            report.added += 1;
        } else {
            report.reused += 1;
        }
        id
    }))
}

/// Add the Loop backup at `path` to `pid`'s habits.
///
/// # Errors
/// The backup missing or unreadable, or a database error; nothing is
/// written then.
pub fn import(conn: &mut Connection, pid: ProfileId, path: &Path) -> anyhow::Result<Report> {
    let (habits, mut reps) = read(path)?;
    let latest = day_so_far();
    let mut report = Report::default();
    let tx = db::write(conn)?;
    for h in &habits {
        let id = match tracker(&tx, pid, h, &mut report)? {
            Ok(id) => id,
            Err(why) => {
                report.skipped.push((h.name.clone(), why));
                continue;
            }
        };
        for (at, value, thousandths) in reps.remove(&h.id).unwrap_or_default() {
            let amount = if h.numerical {
                thousandths.min(HABIT_AMOUNT_MAX)
            } else if matches!(value, 1 | 2) {
                1.0
            } else {
                continue;
            };
            if amount <= 0.0 {
                continue;
            }
            let day = Timestamp::from_millisecond(at)
                .ok()
                .map(|t| t.to_zoned(TimeZone::UTC).date())
                .filter(|&d| plausible(d, latest));
            let Some(day) = day else {
                report.bad += 1;
                continue;
            };
            if db::habit_day_add_missing(&tx, id, &day.to_string(), amount)? {
                report.days += 1;
            } else {
                report.kept += 1;
            }
        }
    }
    tx.commit()?;
    Ok(report)
}
