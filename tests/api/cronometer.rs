//! Cronometer history imported in the app: the CLI importer behind a route.

use super::*;
use common::raw;

const SERVINGS: &str = include_str!("../fixtures/servings.csv");
const SUMMARY: &str = include_str!("../fixtures/dailysummary.csv");

async fn import(app: &Router, pid: i64, body: Value) -> (StatusCode, Value) {
    let uri = format!("/api/profiles/{pid}/import/cronometer");
    call(app, "POST", &uri, Some(body)).await
}

/// Names of profile `pid`'s entries on `day`, imported or not.
async fn names(app: &Router, pid: i64, day: &str) -> Vec<String> {
    let (status, res) = call(app, "GET", &format!("/api/profiles/{pid}/day/{day}"), None).await;
    assert_eq!(status, StatusCode::OK, "{res}");
    res["groups"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|g| g["entries"].as_array().unwrap().clone())
        .map(|e| e["name"].as_str().unwrap().to_owned())
        .collect()
}

#[tokio::test]
async fn both_files_import_and_a_rerun_replaces_them() {
    let app = app();
    for _ in 0..2 {
        let (status, res) =
            import(&app, 1, json!({ "servings": SERVINGS, "summary": SUMMARY })).await;
        assert_eq!(status, StatusCode::OK, "{res}");
        assert_eq!(
            res,
            json!({
                "entries": 5,
                "days": 3,
                "summary": { "days": 3, "groups": 3, "mismatched_days": ["2026-06-03"] },
            })
        );
    }
    assert_eq!(names(&app, 1, "2026-06-02").await.len(), 4, "not doubled");
    let (_, day) = call(&app, "GET", "/api/profiles/1/day/2026-06-02", None).await;
    assert_eq!(day["total"]["energy"], 1800.5);

    // A newer export of one day replaces it; own entries stay.
    let food = create_food(&app, "Apple", json!({ "energy": 52 })).await;
    log_entry_on(&app, "2026-06-02", "Eaten", food, 100.0).await;
    let newer = "Day,Group,Food Name,Amount\n2026-06-02,Consumed,Rye Bread,1.00 g\n";
    let (status, res) = import(&app, 1, json!({ "servings": newer })).await;
    assert_eq!(status, StatusCode::OK, "{res}");
    assert_eq!(res, json!({ "entries": 1, "days": 1, "summary": null }));
    let mut got = names(&app, 1, "2026-06-02").await;
    got.sort();
    assert_eq!(got, ["Apple", "Rye Bread"]);
    assert_eq!(names(&app, 1, "2026-06-03").await, ["Sparkling Water"]);
}

#[tokio::test]
async fn a_bad_file_is_named_with_its_line_and_nothing_is_written() {
    let app = app();
    let bad_servings =
        "Day,Group,Food Name,Amount\n2026-06-02,Consumed,X,1 g\n06/03/2026,Consumed,Y,1 g\n";
    let (status, res) = import(
        &app,
        1,
        json!({ "servings": bad_servings, "summary": SUMMARY }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{res}");
    assert_eq!(res["code"], "invalid");
    assert_eq!(res["field"], "servings");
    assert!(
        res["error"]
            .as_str()
            .unwrap()
            .contains("Line 3 of servings.csv"),
        "{res}"
    );
    assert!(names(&app, 1, "2026-06-02").await.is_empty());
    let (_, day) = call(&app, "GET", "/api/profiles/1/day/2026-06-02", None).await;
    assert!(
        day["total"]["energy"].is_null(),
        "summary not written: {day}"
    );

    let bad_summary = "Date,Group,Energy (kcal)\n2026-06-02,Consumed,1\n2026-06-03,Consumed,lots\n";
    let (status, res) = import(&app, 1, json!({ "summary": bad_summary })).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{res}");
    assert_eq!(res["field"], "summary");
    let error = res["error"].as_str().unwrap();
    assert!(
        error.contains("Line 3 of dailysummary.csv") && error.contains("lots"),
        "{res}"
    );

    // A ragged row is the CSV reader's error: still 400, naming the file.
    let ragged = "Day,Group,Food Name,Amount\n2026-06-02,Consumed\n";
    let (status, res) = import(&app, 1, json!({ "servings": ragged })).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{res}");
    assert_eq!(res["field"], "servings");
    assert!(
        res["error"].as_str().unwrap().contains("servings.csv"),
        "{res}"
    );

    // The files swapped: the missing column says which file it wanted.
    let (status, res) = import(&app, 1, json!({ "servings": SUMMARY })).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{res}");
    assert_eq!(res["field"], "servings");
    assert!(
        res["error"].as_str().unwrap().contains("servings.csv"),
        "{res}"
    );
    let (status, res) = import(&app, 1, json!({ "summary": SERVINGS })).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{res}");
    assert_eq!(res["field"], "summary");
    let error = res["error"].as_str().unwrap();
    assert!(
        error.contains("\"Date\"") && error.contains("dailysummary.csv"),
        "{res}"
    );
}

#[tokio::test]
async fn a_summary_without_groups_imports_as_day_totals() {
    let app = app();
    let summary = include_str!("../fixtures/dailysummary-nogroup.csv");
    let (status, res) = import(&app, 1, json!({ "summary": summary })).await;
    assert_eq!(status, StatusCode::OK, "{res}");
    assert_eq!(
        res,
        json!({
            "entries": 0,
            "days": 3,
            "summary": { "days": 3, "groups": 2, "mismatched_days": [] },
        })
    );
    let (_, day) = call(&app, "GET", "/api/profiles/1/day/2026-06-06", None).await;
    assert_eq!(day["total"]["energy"], 2100.0);
    assert_eq!(day["total"]["protein"], 110.5);
}

#[tokio::test]
async fn neither_file_is_refused() {
    let app = app();
    for body in [json!({}), json!({ "servings": null, "summary": null })] {
        let (status, res) = import(&app, 1, body).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{res}");
        assert_eq!(res["code"], "invalid");
    }
}

#[tokio::test]
async fn imports_stay_with_their_profile() {
    let app = app();
    let (status, other) = call(
        &app,
        "POST",
        "/api/profiles",
        Some(json!({
            "name": "Other", "sex": null, "birth_date": null, "height_cm": null,
            "activity": null, "goal_kg_per_week": 0.0
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{other}");
    let other = other["id"].as_i64().unwrap();
    import(&app, 1, json!({ "servings": SERVINGS })).await;
    let (status, res) = import(
        &app,
        other,
        json!({ "servings": "Day,Group,Food Name,Amount\n2026-06-02,Consumed,Tea,1 g\n" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{res}");
    assert_eq!(names(&app, 1, "2026-06-02").await.len(), 4, "untouched");
    assert_eq!(names(&app, other, "2026-06-02").await, ["Tea"]);

    let (status, res) = import(&app, 999, json!({ "servings": SERVINGS })).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{res}");
    assert_eq!(res["resource"], "profile");
}

#[tokio::test]
async fn takes_years_of_history_up_to_the_import_cap() {
    let app = app();
    // Past the 2 MB default: the import cap applies.
    let mut big = String::from("Day,Group,Food Name,Amount\n");
    while big.len() < 3 * 1024 * 1024 {
        big.push_str("2026-06-02,Consumed,Porridge with a long name,300.00 g\n");
    }
    let (status, res) = import(&app, 1, json!({ "servings": big })).await;
    assert_eq!(status, StatusCode::OK, "{res}");

    let huge = "x".repeat(kaloriina::model::IMPORT_BYTES_MAX + 1);
    let (status, res) = raw(
        &app,
        "POST",
        "/api/profiles/1/import/cronometer",
        "application/json",
        &huge,
    )
    .await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE, "{res}");
    assert_eq!(res["code"], "too_large");
}

/// The files are read off the database lock (only the write takes it): a
/// read sent while a big upload is parsed answers at once. The upload's
/// last line is bad, so it's all parse and no write.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_read_answers_while_an_upload_is_parsed() {
    use std::fmt::Write;
    let app = app();
    let mut servings = String::from("Day,Group,Food Name,Amount\n");
    // ~38 MB: over 300 ms to parse even in a release build (the package's
    // check), still under the upload cap.
    for i in 0..1_000_000 {
        writeln!(servings, "2026-06-02,Consumed,Food {i},100.00 g").unwrap();
    }
    servings.push_str("not a date,Consumed,Bad,1 g\n");
    let upload = {
        let app = app.clone();
        tokio::spawn(async move {
            let started = std::time::Instant::now();
            let (status, _) = import(&app, 1, json!({ "servings": servings })).await;
            assert_eq!(status, StatusCode::BAD_REQUEST);
            started.elapsed()
        })
    };
    let mut slowest = std::time::Duration::ZERO;
    while !upload.is_finished() {
        let started = std::time::Instant::now();
        let (status, _) = call(&app, "GET", "/api/profiles", None).await;
        assert_eq!(status, StatusCode::OK);
        slowest = slowest.max(started.elapsed());
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    let took = upload.await.unwrap();
    assert!(
        took > std::time::Duration::from_millis(300),
        "too small to tell: {took:?}"
    );
    assert!(
        slowest * 4 < took,
        "a read waited {slowest:?} of the upload's {took:?}"
    );
}

async fn match_rows(app: &Router, pid: i64, name: &str, food_id: i64) -> (StatusCode, Value) {
    let uri = format!("/api/profiles/{pid}/imported/match");
    call(
        app,
        "POST",
        &uri,
        Some(json!({ "name": name, "food_id": food_id })),
    )
    .await
}

async fn day(app: &Router, day: &str) -> Value {
    let (status, res) = call(app, "GET", &format!("/api/profiles/1/day/{day}"), None).await;
    assert_eq!(status, StatusCode::OK, "{res}");
    res
}

const MATCH_SERVINGS: &str = "Day,Group,Food Name,Amount
2026-06-02,Consumed,Oat Porridge,300.00 g
2026-06-02,Consumed,Creatine,5.00 g
2026-06-02,Consumed,Coffee,1.00 Serving
2026-06-03,Consumed,Creatine,1.00 Scoop
2026-06-04,Consumed,Creatine,1.00 x 5.0 g
2026-06-05,Consumed,Creatine,1.00 x 5.0 ml
";
const MATCH_SUMMARY: &str = "Date,Group,Energy (kcal),Protein (g)
2026-06-02,Consumed,1500,60
";

/// Rows matched to a food count as it, out of their group's total: a
/// creatine is a floor beside what the export still holds, energy stays the
/// export's, and a re-import keeps the match without counting it twice.
#[tokio::test]
async fn a_matched_row_counts_as_its_food_and_a_reimport_keeps_it() {
    let app = app();
    let (status, creatine) = call(
        &app,
        "POST",
        "/api/foods",
        Some(
            json!({ "name": "Creatine", "per100": { "creatine": 100, "energy": 0 },
                     "servings": [{ "label": "scoop", "grams": 5 }] }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{creatine}");
    let creatine = creatine["id"].as_i64().unwrap();
    let oats = create_food(&app, "Oats", json!({ "energy": 400, "protein": 10 })).await;
    let both = json!({ "servings": MATCH_SERVINGS, "summary": MATCH_SUMMARY });
    let (status, res) = import(&app, 1, both.clone()).await;
    assert_eq!(status, StatusCode::OK, "{res}");

    let (status, res) = match_rows(&app, 1, " creatine ", creatine).await;
    assert_eq!(status, StatusCode::OK, "{res}");
    let ml = json!([{ "reason": "amount not in grams", "count": 1 }]);
    assert_eq!(res, json!({ "matched": 3, "skipped": ml }));
    let (status, res) = match_rows(&app, 1, "Oat Porridge", oats).await;
    assert_eq!(status, StatusCode::OK, "{res}");
    assert_eq!(res, json!({ "matched": 1, "skipped": [] }));

    let check = |d: Value| {
        assert_eq!(d["eaten"]["creatine"], 5.0, "{d}");
        let share = d["known"]["creatine"].as_f64().expect("a floor");
        assert!(share < 1.0, "{d}");
        assert!(
            (d["eaten"]["energy"].as_f64().unwrap() - 1500.0).abs() < 0.5,
            "{d}"
        );
        assert!(
            (d["eaten"]["protein"].as_f64().unwrap() - 60.0).abs() < 0.5,
            "{d}"
        );
    };
    check(day(&app, "2026-06-02").await);
    for d in ["2026-06-03", "2026-06-04"] {
        assert_eq!(day(&app, d).await["eaten"]["creatine"], 5.0, "{d}");
    }
    assert!(day(&app, "2026-06-05").await["eaten"]["creatine"].is_null());
    let d = day(&app, "2026-06-02").await;
    let row = d["groups"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|g| g["entries"].as_array().unwrap())
        .find(|e| e["name"] == "Creatine")
        .unwrap()
        .clone();
    assert_eq!(row["kind"], "imported");
    assert_eq!(row["food_id"], creatine);
    assert_eq!(row["grams"], 5.0);
    let uri = format!("/api/profiles/1/entries/{}", row["id"]);
    let (status, res) = call(&app, "DELETE", &uri, None).await;
    assert_eq!(status, StatusCode::CONFLICT, "still read-only: {res}");

    let (status, res) = match_rows(&app, 1, "Creatine", creatine).await;
    assert_eq!(status, StatusCode::OK, "{res}");
    assert_eq!(res, json!({ "matched": 0, "skipped": ml }), "again: no-op");
    check(day(&app, "2026-06-02").await);

    // Both files, either one alone: the match stays, counted once.
    let servings = json!({ "servings": MATCH_SERVINGS });
    let summary = json!({ "summary": MATCH_SUMMARY });
    for files in [both, servings, summary] {
        let (status, res) = import(&app, 1, files).await;
        assert_eq!(status, StatusCode::OK, "{res}");
        check(day(&app, "2026-06-02").await);
        assert_eq!(names(&app, 1, "2026-06-02").await.len(), 3);
    }

    // The group goes with its rows, matched or not.
    let uri = "/api/profiles/1/imported/2026-06-02/Eaten";
    let (status, res) = call(&app, "DELETE", uri, None).await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{res}");
    let d = day(&app, "2026-06-02").await;
    assert!(d["eaten"]["creatine"].is_null(), "{d}");
    assert!(d["eaten"]["energy"].is_null(), "{d}");
}

#[tokio::test]
async fn a_match_is_checked() {
    let app = app();
    import(&app, 1, json!({ "servings": MATCH_SERVINGS })).await;
    let oats = create_food(&app, "Oats", json!({ "energy": 400 })).await;
    let (status, res) = match_rows(&app, 1, "Oat Porridge", 999_999).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{res}");
    assert_eq!(res["field"], "food_id");
    let (status, res) = match_rows(&app, 1, " ", oats).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{res}");
    assert_eq!(res["field"], "name");
    let (status, res) = match_rows(&app, 999, "Oat Porridge", oats).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{res}");
    assert_eq!(res["resource"], "profile");
    assert!(day(&app, "2026-06-02").await["eaten"]["energy"].is_null());
}

/// A profile's export carries its matched rows: a copy reads the same.
#[tokio::test]
async fn matched_rows_travel_in_an_export() {
    let app = app();
    let oats = create_food(&app, "Oats", json!({ "energy": 400, "protein": 10 })).await;
    let both = json!({ "servings": MATCH_SERVINGS, "summary": MATCH_SUMMARY });
    import(&app, 1, both).await;
    match_rows(&app, 1, "Oat Porridge", oats).await;
    let (status, mut file) = call(&app, "GET", "/api/profiles/1/export", None).await;
    assert_eq!(status, StatusCode::OK, "{file}");
    file["profile"]["name"] = json!("Copy");
    let (status, copy) = call(&app, "POST", "/api/profiles/import", Some(file)).await;
    assert_eq!(status, StatusCode::CREATED, "{copy}");
    let uri = format!("/api/profiles/{}/day/2026-06-02", copy["id"]);
    let (_, copied) = call(&app, "GET", &uri, None).await;
    let mine = day(&app, "2026-06-02").await;
    assert_eq!(mine["eaten"]["energy"], 1500.0);
    assert_eq!(copied["eaten"], mine["eaten"]);
    assert_eq!(copied["known"], mine["known"]);
}
