mod common;

use std::fs::File;
use std::path::Path;

use axum::http::StatusCode;
use common::{ME, app_from, call, import_servings, import_summary};
use kaloriina::{AppState, import, open, router};
use serde_json::{Value, json};

fn fixture(name: &str) -> File {
    File::open(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures")
            .join(name),
    )
    .unwrap()
}

fn day_entries(day: &Value) -> Vec<(String, String, Value)> {
    day["groups"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|g| g["entries"].as_array().unwrap().clone())
        .map(|e| {
            (
                e["group"].as_str().unwrap().to_owned(),
                e["name"].as_str().unwrap().to_owned(),
                e["grams"].clone(),
            )
        })
        .collect()
}

#[tokio::test]
async fn import_is_idempotent_and_matches_totals() {
    let mut conn = open(Path::new(":memory:")).unwrap();
    for _ in 0..2 {
        assert_eq!(
            import_servings(&mut conn, ME, fixture("servings.csv")).unwrap(),
            5
        );
        let r = import_summary(&mut conn, ME, fixture("dailysummary.csv")).unwrap();
        assert_eq!((r.days, r.groups), (3, 3));
        assert_eq!(r.mismatched_days, vec!["2026-06-03".to_owned()]);
    }
    let app = app_from(conn, "");

    let (status, day) = call(&app, "GET", "/api/profiles/1/day/2026-06-02", None).await;
    assert_eq!(status, StatusCode::OK);
    let entries = day_entries(&day);
    assert_eq!(
        entries.len(),
        4,
        "re-import must not duplicate; true duplicates kept"
    );
    assert!(entries.contains(&("Planned".into(), "Rye Bread, Sliced".into(), Value::Null)));
    assert!(entries.contains(&("Eaten".into(), "Coffee (Oat Milk)".into(), Value::Null)));
    assert_eq!(day["total"]["energy"], 1800.5);
    assert_eq!(day["total"]["protein"], 120.0);

    let (_, day) = call(&app, "GET", "/api/profiles/1/day/2026-06-03", None).await;
    let names: Vec<_> = day["groups"]
        .as_array()
        .unwrap()
        .iter()
        .map(|g| g["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["Planned", "Eaten", "Other"]);

    let (_, sum) = call(
        &app,
        "GET",
        "/api/profiles/1/summary?from=2026-06-01&to=2026-06-30",
        None,
    )
    .await;
    assert_eq!(
        sum["days"].as_array().unwrap().len(),
        2,
        "empty filler day excluded"
    );
}

#[tokio::test]
async fn newer_export_replaces_changed_day_but_keeps_manual_entries() {
    let mut conn = open(Path::new(":memory:")).unwrap();
    import_servings(&mut conn, ME, fixture("servings.csv")).unwrap();
    let state = AppState::new(conn, String::new());
    let app = router(state.clone());
    let (_, food) = call(&app, "POST", "/api/foods", Some(json!({ "name": "Apple" }))).await;
    let (status, _) = call(
        &app,
        "POST",
        "/api/profiles/1/entries",
        Some(json!({
            "day": "2026-06-02",
            "group": "Eaten",
            "food_id": food["id"],
            "grams": 100.0,
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);

    // Same day re-exported after the bread moved Remaining -> Consumed.
    let newer = "Day,Group,Food Name,Amount,Category\n\
                 2026-06-02,\"Consumed\",\"Rye Bread, Sliced\",\"2.00 x 35.0 g\",\"\"\n";
    import_servings(&mut state.db.lock().unwrap(), ME, newer.as_bytes()).unwrap();

    let (_, day) = call(&app, "GET", "/api/profiles/1/day/2026-06-02", None).await;
    let entries: Vec<(String, bool)> = day["groups"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|g| g["entries"].as_array().unwrap().clone())
        .map(|e| {
            (
                e["name"].as_str().unwrap().to_owned(),
                !e["src_group"].is_null(),
            )
        })
        .collect();
    assert_eq!(
        entries,
        vec![("Apple".into(), false), ("Rye Bread, Sliced".into(), true)],
        "imported rows replaced, manual entry kept"
    );
    let (_, other) = call(&app, "GET", "/api/profiles/1/day/2026-06-03", None).await;
    assert_eq!(
        day_entries(&other).len(),
        1,
        "days absent from the newer file untouched"
    );
}

#[tokio::test]
async fn a_summary_without_groups_is_each_days_total() {
    // Cronometer leaves `Group` out when the diary isn't split by meal.
    let mut conn = open(Path::new(":memory:")).unwrap();
    let r = import_summary(&mut conn, ME, fixture("dailysummary-nogroup.csv")).unwrap();
    assert_eq!((r.days, r.groups), (3, 2));
    assert!(r.mismatched_days.is_empty());
    let app = app_from(conn, "");
    let (_, day) = call(&app, "GET", "/api/profiles/1/day/2026-06-04", None).await;
    assert_eq!(day["total"]["energy"], 1650.25);
    assert_eq!(day["total"]["protein"], 95.0);
    let (_, sum) = call(
        &app,
        "GET",
        "/api/profiles/1/summary?from=2026-06-01&to=2026-06-30",
        None,
    )
    .await;
    assert_eq!(
        sum["days"].as_array().unwrap().len(),
        2,
        "the blank day isn't logged"
    );
}

#[test]
fn rejects_unknown_columns_and_bad_rows() {
    let mut conn = open(Path::new(":memory:")).unwrap();
    let unknown = "Date,Group,Energy (kcal),Mystery (g),Completed\n2026-06-02,Total,1,2,true\n";
    let err = import_summary(&mut conn, ME, unknown.as_bytes()).unwrap_err();
    assert!(err.to_string().contains("Mystery (g)"), "{err}");

    let bad_date = "Day,Group,Food Name,Amount\n06/02/2026,Consumed,X,1 g\n";
    assert!(import_servings(&mut conn, ME, bad_date.as_bytes()).is_err());

    let missing = "Day,Group,Amount\n2026-06-02,Consumed,1 g\n";
    assert!(import_servings(&mut conn, ME, missing.as_bytes()).is_err());
}

#[test]
fn failed_import_writes_nothing() {
    let mut conn = open(Path::new(":memory:")).unwrap();
    import_servings(&mut conn, ME, fixture("servings.csv")).unwrap();
    let broken = "Day,Group,Food Name,Amount\n\
                  2026-06-02,Consumed,Replacement,1 g\n\
                  06/03/2026,Consumed,Bad date,1 g\n";
    assert!(import_servings(&mut conn, ME, broken.as_bytes()).is_err());
    let names: Vec<String> = conn
        .prepare("SELECT name FROM entry WHERE day = '2026-06-02' ORDER BY id")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(names.len(), 4, "original day intact: {names:?}");
    assert!(!names.contains(&"Replacement".to_owned()));

    let wrong_file = fixture("dailysummary.csv");
    let err = import_servings(&mut conn, ME, wrong_file).unwrap_err();
    assert!(err.to_string().contains("servings.csv"), "{err}");
}

#[test]
fn a_bad_summary_leaves_the_database_untouched() {
    let mut conn = open(Path::new(":memory:")).unwrap();
    let summary = "Date,Group,Energy (kcal),Completed\n2026-06-02,Consumed,lots,true\n";
    let err = import::import(
        &mut conn,
        ME,
        Some(fixture("servings.csv")),
        Some(summary.as_bytes()),
    )
    .unwrap_err();
    assert!(err.to_string().contains("lots"), "{err}");
    let entries: i64 = conn
        .query_row("SELECT count(*) FROM entry", [], |r| r.get(0))
        .unwrap();
    assert_eq!(entries, 0, "servings weren't written either");
}

/// A Loop Habit Tracker backup at `path`, made of `sql`.
fn loop_backup(path: &Path, sql: &str) {
    let _ = std::fs::remove_file(path);
    let conn = kaloriina::Connection::open(path).unwrap();
    conn.execute_batch(sql).unwrap();
}

/// `Habits` and `Repetitions` as Loop writes them.
const LOOP_SCHEMA: &str = "
    CREATE TABLE Habits (id INTEGER PRIMARY KEY AUTOINCREMENT, archived INTEGER,
        color INTEGER, description TEXT, freq_den INTEGER, freq_num INTEGER,
        highlight INTEGER, name TEXT, position INTEGER, reminder_hour INTEGER,
        reminder_min INTEGER, reminder_days INTEGER NOT NULL DEFAULT 127,
        type INTEGER NOT NULL DEFAULT 0, target_type INTEGER NOT NULL DEFAULT 0,
        target_value REAL NOT NULL DEFAULT 0, unit TEXT NOT NULL DEFAULT '',
        question TEXT, uuid TEXT);
    CREATE TABLE Repetitions (id INTEGER PRIMARY KEY AUTOINCREMENT,
        habit INTEGER NOT NULL REFERENCES Habits(id), timestamp INTEGER NOT NULL,
        value INTEGER NOT NULL, notes TEXT);";

/// Loop's timestamp of `day`: midnight UTC, in milliseconds.
fn loop_day(day: &str) -> i64 {
    format!("{day}T00:00:00Z")
        .parse::<jiff::Timestamp>()
        .unwrap()
        .as_millisecond()
}

fn temp_dir(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("kaloriina-{name}-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

type HabitRow = (String, String, Option<f64>, String, bool, Option<String>);

fn habits(conn: &kaloriina::Connection) -> Vec<HabitRow> {
    conn.prepare("SELECT name, unit, goal_value, goal_dir, archived, uid FROM habit ORDER BY id")
        .unwrap()
        .query_map([], |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
            ))
        })
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
}

fn habit_days(conn: &kaloriina::Connection) -> Vec<(String, String, f64)> {
    conn.prepare(
        "SELECT h.name, d.day, d.amount FROM habit_day d JOIN habit h ON h.id = d.habit_id
         ORDER BY h.id, d.day",
    )
    .unwrap()
    .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
    .unwrap()
    .collect::<Result<_, _>>()
    .unwrap()
}

#[test]
fn a_loop_backup_becomes_trackers_once_and_the_users_days_win() {
    let dir = temp_dir("loop");
    let backup = dir.join("Loop.db");
    let reps = [
        // Meditate: yes (by hand, automatic), no, skipped, unknown.
        (1, "2026-09-01", 2),
        (1, "2026-09-02", 1),
        (1, "2026-09-03", 0),
        (1, "2026-09-04", 3),
        (1, "2026-09-05", -1),
        // Run (km, ×1000): 5.5, nothing, past the bound.
        (2, "2026-09-01", 5500),
        (2, "2026-09-02", 0),
        (2, "2026-09-03", 2_000_000),
        // snus: the user's own day stays.
        (3, "2026-09-02", 8000),
        (3, "2026-09-03", 3000),
        (4, "2026-09-01", 2000),
        (5, "2026-09-01", 2),
    ];
    let reps: Vec<String> = reps
        .iter()
        .map(|(h, d, v)| format!("({h}, {}, {v})", loop_day(d)))
        .collect();
    loop_backup(
        &backup,
        &format!(
            "{LOOP_SCHEMA}
             INSERT INTO Habits (id, archived, freq_den, freq_num, name, position, type,
                 target_type, target_value, unit, uuid) VALUES
                 (1, 0, 1, 1, 'Meditate', 0, 0, 0, 0, '', '0f6c0a5e7d2b4c1a9e3f5b7d9c1e3a5b'),
                 (2, 0, 1, 1, 'Run', 1, 1, 0, 5, 'km', '1f6c0a5e7d2b4c1a9e3f5b7d9c1e3a5b'),
                 (3, 0, 7, 1, 'snus', 2, 1, 1, 10, 'pouches', '2f6c0a5e7d2b4c1a9e3f5b7d9c1e3a5b'),
                 (4, 0, 1, 1, 'Coffee', 3, 1, 1, 3, 'cups', '3f6c0a5e7d2b4c1a9e3f5b7d9c1e3a5b'),
                 (5, 1, 1, 1, 'Old', 4, 0, 0, 0, '', '4f6c0a5e7d2b4c1a9e3f5b7d9c1e3a5b');
             INSERT INTO Repetitions (habit, timestamp, value) VALUES {};",
            reps.join(", ")
        ),
    );
    let mut conn = open(Path::new(":memory:")).unwrap();
    conn.execute_batch(
        "INSERT INTO habit (profile_id, name, unit) VALUES (1, 'Snus', 'pouches'), (1, 'Coffee', 'mugs');
         INSERT INTO habit_day (habit_id, day, amount)
             SELECT id, '2026-09-02', 5 FROM habit WHERE name = 'Snus';",
    )
    .unwrap();

    let r = kaloriina::loop_habits::import(&mut conn, ME, &backup).unwrap();
    assert_eq!((r.added, r.reused, r.days, r.kept), (3, 1, 6, 1), "{r:?}");
    assert_eq!(r.skipped.len(), 1, "{r:?}");
    assert_eq!(r.skipped[0].0, "Coffee");
    assert!(r.skipped[0].1.contains("mugs"), "{r:?}");
    let uid = |n: char| Some(format!("loop-{n}f6c0a5e7d2b4c1a9e3f5b7d9c1e3a5b"));
    let row = |name: &str, unit: &str, goal, dir: &str, archived, uid| -> HabitRow {
        (name.into(), unit.into(), goal, dir.into(), archived, uid)
    };
    assert_eq!(
        habits(&conn),
        [
            row("Snus", "pouches", None, "at_most", false, None),
            row("Coffee", "mugs", None, "at_most", false, None),
            row("Meditate", "times", None, "at_least", false, uid('0')),
            row("Run", "km", Some(5.0), "at_least", false, uid('1')),
            row("Old", "times", None, "at_least", true, uid('4')),
        ]
    );
    let days = [
        ("Snus", "2026-09-02", 5.0),
        ("Snus", "2026-09-03", 3.0),
        ("Meditate", "2026-09-01", 1.0),
        ("Meditate", "2026-09-02", 1.0),
        ("Run", "2026-09-01", 5.5),
        ("Run", "2026-09-03", 999.0),
        ("Old", "2026-09-01", 1.0),
    ]
    .map(|(h, d, a)| (h.to_owned(), d.to_owned(), a));
    assert_eq!(habit_days(&conn), days);

    // Again: nothing new, nothing changed.
    let r = kaloriina::loop_habits::import(&mut conn, ME, &backup).unwrap();
    assert_eq!((r.added, r.reused, r.days, r.kept), (0, 4, 0, 7), "{r:?}");
    assert_eq!(habit_days(&conn), days);
    assert_eq!(habits(&conn).len(), 5);
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn an_old_loop_backup_and_the_tracker_cap() {
    // Before `uuid`, `type`, `unit` and the targets: yes/no trackers keyed
    // by their id.
    let dir = temp_dir("loop-old");
    let backup = dir.join("Loop.db");
    loop_backup(
        &backup,
        &format!(
            "CREATE TABLE Habits (id INTEGER PRIMARY KEY, archived INTEGER, freq_den INTEGER,
                 freq_num INTEGER, name TEXT, position INTEGER);
             CREATE TABLE Repetitions (id INTEGER PRIMARY KEY, habit INTEGER,
                 timestamp INTEGER, value INTEGER);
             INSERT INTO Habits VALUES (1, 0, 1, 1, 'Floss', 0), (2, 0, 1, 1, 'Read', 1);
             INSERT INTO Repetitions (habit, timestamp, value) VALUES (1, {0}, 2), (2, {0}, 2);",
            loop_day("2026-09-01")
        ),
    );
    let mut conn = open(Path::new(":memory:")).unwrap();
    for n in 0..19 {
        conn.execute(
            "INSERT INTO habit (profile_id, name, unit) VALUES (1, ?, 'x')",
            [format!("H{n}")],
        )
        .unwrap();
    }
    let r = kaloriina::loop_habits::import(&mut conn, ME, &backup).unwrap();
    assert_eq!((r.added, r.days), (1, 1), "{r:?}");
    assert_eq!(r.skipped.len(), 1, "{r:?}");
    assert_eq!(r.skipped[0].0, "Read");
    assert!(r.skipped[0].1.contains("20"), "{r:?}");
    let floss = habits(&conn).pop().unwrap();
    assert_eq!(
        (floss.0.as_str(), floss.1.as_str(), floss.5.as_deref()),
        ("Floss", "times", Some("loop-id-1"))
    );
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn a_bad_loop_backup_writes_nothing() {
    let dir = temp_dir("loop-bad");
    let mut conn = open(Path::new(":memory:")).unwrap();
    let text = dir.join("notes.db");
    std::fs::write(&text, "not a database at all, just some words in a file").unwrap();
    let other = dir.join("other.db");
    loop_backup(
        &other,
        "CREATE TABLE Habits (id INTEGER PRIMARY KEY, name TEXT);
         INSERT INTO Habits VALUES (1, 'Floss');",
    );
    let missing = dir.join("missing.db");
    for path in [&text, &other, &missing] {
        assert!(
            kaloriina::loop_habits::import(&mut conn, ME, path).is_err(),
            "{}",
            path.display()
        );
    }
    assert!(!missing.exists(), "no file made");
    assert!(habits(&conn).is_empty());
    std::fs::remove_dir_all(&dir).unwrap();
}
