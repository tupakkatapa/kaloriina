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
    assert!(entries.contains(&("Consumed".into(), "Coffee (Oat Milk)".into(), Value::Null)));
    assert_eq!(day["total"]["energy"], 1800.5);
    assert_eq!(day["total"]["protein"], 120.0);

    let (_, day) = call(&app, "GET", "/api/profiles/1/day/2026-06-03", None).await;
    let names: Vec<_> = day["groups"]
        .as_array()
        .unwrap()
        .iter()
        .map(|g| g["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["Planned", "Consumed", "Other"]);

    let (_, sum) = call(
        &app,
        "GET",
        "/api/profiles/1/summary?from=2026-06-01&to=2026-06-30",
        None,
    )
    .await;
    assert_eq!(sum["days_logged"], 2, "empty filler day excluded");
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
            "group": "Consumed",
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
                e["imported"].as_bool().unwrap(),
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
