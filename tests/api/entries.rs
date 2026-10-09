//! Diary entries beyond logging a food: copies ("Log again"), entry times,
//! day notes and body measurements.

use super::*;

const ENTRIES: &str = "/api/profiles/1/entries";

async fn post_entries(app: &Router, body: Value) -> (StatusCode, Value) {
    call(app, "POST", ENTRIES, Some(body)).await
}

async fn day_of(app: &Router, day: &str) -> Value {
    let (status, d) = call(app, "GET", &format!("/api/profiles/1/day/{day}"), None).await;
    assert_eq!(status, StatusCode::OK, "{d}");
    d
}

async fn other_profile(app: &Router) -> i64 {
    let (status, p) = call(
        app,
        "POST",
        "/api/profiles",
        Some(json!({
            "name": "Other", "sex": null, "birth_date": null, "height_cm": null,
            "activity": null, "goal_kg_per_week": 0.0
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{p}");
    p["id"].as_i64().unwrap()
}

/// An app with one imported row: Rye Bread, Planned on 2026-06-02.
fn history_app() -> Router {
    let mut conn = open(FsPath::new(":memory:")).unwrap();
    let csv = "Day,Group,Food Name,Amount\n2026-06-02,Planned,Rye Bread,70.00 g\n";
    common::import_servings(&mut conn, common::ME, csv.as_bytes()).unwrap();
    app_from(conn, NO_OFF)
}

fn assert_invalid(status: StatusCode, res: &Value, field: Option<&str>) {
    assert_eq!(status, StatusCode::BAD_REQUEST, "{res}");
    assert_eq!(res["code"], "invalid", "{res}");
    assert_eq!(res.get("field").and_then(Value::as_str), field, "{res}");
}

#[tokio::test]
async fn log_again_copies_snapshots_once() {
    let app = app();
    let oats = create_food(&app, "Oats", json!({ "energy": 380.0, "protein": 13.0 })).await;
    let (_, first) = post_entries(
        &app,
        json!({ "day": DAY, "group": "Consumed", "food_id": oats, "grams": 50.0, "time": "08:15" }),
    )
    .await;
    let a = &first["entries"][0];
    assert_eq!(a["time"], "08:15");
    let lunch = create_food(&app, "Lunch", json!({ "energy": 650.0 })).await;
    let (_, second) = post_entries(
        &app,
        json!({ "day": DAY, "group": "Consumed", "food_id": lunch, "grams": 100.0 }),
    )
    .await;
    let b = &second["entries"][0];

    let body = json!({ "day": "2026-10-07", "group": "Planned", "uid": "copy-0001",
                       "entry_ids": [a["id"], b["id"]] });
    let (status, copied) = post_entries(&app, body.clone()).await;
    assert_eq!(status, StatusCode::CREATED, "{copied}");
    let list = copied["entries"].as_array().unwrap();
    assert_eq!(list.len(), 2);
    for (copy, from) in list.iter().zip([a, b]) {
        assert_eq!(copy["day"], "2026-10-07");
        assert_eq!(copy["group"], "Planned");
        for key in ["food_id", "name", "grams", "amount", "nutrients", "source"] {
            assert_eq!(copy[key], from[key], "{key}");
        }
        assert_eq!(copy["time"], Value::Null, "time isn't copied");
        assert_ne!(copy["id"], from["id"]);
    }
    assert_eq!(list[0]["uid"], "copy-0001:1");
    assert_eq!(list[1]["uid"], "copy-0001:2");

    // A retry stores nothing more and answers with the same entries.
    let (status, again) = post_entries(&app, body).await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(again, copied);
    let day = day_of(&app, "2026-10-07").await;
    assert_eq!(
        group(&day, "Planned")["entries"].as_array().unwrap().len(),
        2
    );
    assert_eq!(day["total"]["energy"], 840.0);
}

#[tokio::test]
async fn log_again_refuses_others_unknown_and_imported() {
    let app = history_app();
    let oats = create_food(&app, "Oats", json!({ "energy": 100.0 })).await;
    let mine = log_entry(&app, "Consumed", oats, 10.0).await;

    let pid = other_profile(&app).await;
    let (status, res) = call(
        &app,
        "POST",
        &format!("/api/profiles/{pid}/entries"),
        Some(json!({ "day": DAY, "group": "Consumed", "entry_ids": [mine["id"]] })),
    )
    .await;
    assert_invalid(status, &res, Some("entry_ids"));

    let (status, res) = post_entries(
        &app,
        json!({ "day": DAY, "group": "Consumed", "entry_ids": [mine["id"], 999_999] }),
    )
    .await;
    assert_invalid(status, &res, Some("entry_ids"));
    let (status, res) = post_entries(
        &app,
        json!({ "day": DAY, "group": "Consumed", "entry_ids": [] }),
    )
    .await;
    assert_invalid(status, &res, Some("entry_ids"));

    let (_, history) = call(&app, "GET", "/api/profiles/1/day/2026-06-02", None).await;
    let imported = &group(&history, "Planned")["entries"][0];
    let (status, res) = post_entries(
        &app,
        json!({ "day": DAY, "group": "Consumed", "entry_ids": [mine["id"], imported["id"]] }),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{res}");
    assert_eq!(res["code"], "imported_read_only");
    // All or nothing: the first copy wasn't kept.
    let day = day_of(&app, DAY).await;
    assert_eq!(
        group(&day, "Consumed")["entries"].as_array().unwrap().len(),
        1
    );
}

#[tokio::test]
async fn a_log_names_exactly_one_thing() {
    let app = app();
    let oats = create_food(&app, "Oats", json!({ "energy": 100.0 })).await;
    for body in [
        json!({ "day": DAY, "group": "Consumed" }),
        json!({ "day": DAY, "group": "Consumed", "food_id": oats, "grams": 1.0, "meal_id": 1 }),
        json!({ "day": DAY, "group": "Consumed", "entry_ids": [1], "meal_id": 1 }),
    ] {
        let (status, res) = post_entries(&app, body).await;
        assert_invalid(status, &res, None);
    }
}

#[tokio::test]
async fn quick_adds_are_gone() {
    let app = app();
    let (status, res) = post_entries(
        &app,
        json!({ "day": DAY, "group": "Consumed", "name": "Lunch out",
                "nutrients": { "energy": 650.0 } }),
    )
    .await;
    assert_invalid(status, &res, None);
    assert_eq!(day_of(&app, DAY).await["consumed"]["energy"], Value::Null);
}

#[tokio::test]
async fn entry_time_round_trips_and_clears() {
    let app = history_app();
    let oats = create_food(&app, "Oats", json!({ "energy": 100.0 })).await;
    let e = log_entry(&app, "Consumed", oats, 100.0).await;
    assert_eq!(e["time"], Value::Null);
    assert!(e.get("kind").is_none(), "every entry is a food: no kind");
    let uri = format!("{ENTRIES}/{}", e["id"]);

    let (status, timed) = call(&app, "PATCH", &uri, Some(json!({ "time": "23:59" }))).await;
    assert_eq!(status, StatusCode::OK, "{timed}");
    assert_eq!(timed["time"], "23:59");
    // Left out: kept.
    let (_, moved) = call(&app, "PATCH", &uri, Some(json!({ "grams": 50.0 }))).await;
    assert_eq!(moved["time"], "23:59");
    assert_eq!(moved["nutrients"]["energy"], 50.0);
    // null: cleared.
    let (_, cleared) = call(&app, "PATCH", &uri, Some(json!({ "time": null }))).await;
    assert_eq!(cleared["time"], Value::Null);

    for bad in ["24:00", "7:15", "12:60", "12-30", "noon"] {
        let (status, res) = call(&app, "PATCH", &uri, Some(json!({ "time": bad }))).await;
        assert_invalid(status, &res, Some("time"));
        let (status, res) = post_entries(
            &app,
            json!({ "day": DAY, "group": "Consumed", "food_id": oats, "grams": 1.0, "time": bad }),
        )
        .await;
        assert_invalid(status, &res, Some("time"));
    }

    // Imported history can only move.
    let (_, history) = call(&app, "GET", "/api/profiles/1/day/2026-06-02", None).await;
    let imported = &group(&history, "Planned")["entries"][0];
    let (status, res) = call(
        &app,
        "PATCH",
        &format!("{ENTRIES}/{}", imported["id"]),
        Some(json!({ "time": "08:00" })),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{res}");
}

#[tokio::test]
async fn day_notes() {
    let app = app();
    let uri = format!("/api/profiles/1/notes/{DAY}");
    let (status, note) = call(&app, "PUT", &uri, Some(json!({ "text": "  Slept badly " }))).await;
    assert_eq!(status, StatusCode::OK, "{note}");
    assert_eq!(note, json!({ "day": DAY, "text": "Slept badly" }));
    let (_, note) = call(&app, "PUT", &uri, Some(json!({ "text": "Rest day" }))).await;
    assert_eq!(note["text"], "Rest day");
    assert_eq!(day_of(&app, DAY).await["note"], "Rest day");
    assert_eq!(day_of(&app, "2026-10-05").await["note"], Value::Null);

    let (_, list) = call(
        &app,
        "GET",
        "/api/profiles/1/notes?from=2026-10-01&to=2026-10-31",
        None,
    )
    .await;
    assert_eq!(list, json!([{ "day": DAY, "text": "Rest day" }]));
    let (_, earlier) = call(&app, "GET", "/api/profiles/1/notes?to=2026-10-05", None).await;
    assert_eq!(earlier, json!([]));

    for text in [json!(""), json!("x".repeat(501)), json!("a\u{202e}b")] {
        let (status, res) = call(&app, "PUT", &uri, Some(json!({ "text": text }))).await;
        assert_invalid(status, &res, Some("text"));
    }
    let after = "2999-01-01";
    let (status, res) = call(
        &app,
        "PUT",
        &format!("/api/profiles/1/notes/{after}"),
        Some(json!({ "text": "x" })),
    )
    .await;
    assert_invalid(status, &res, None);
    let (status, res) = call(
        &app,
        "PUT",
        "/api/profiles/1/notes/2026-13-01",
        Some(json!({ "text": "x" })),
    )
    .await;
    assert_invalid(status, &res, None);
    let (status, _) = call(
        &app,
        "PUT",
        "/api/profiles/99/notes/2026-10-01",
        Some(json!({ "text": "x" })),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    assert_eq!(
        call(&app, "DELETE", &uri, None).await.0,
        StatusCode::NO_CONTENT
    );
    let (status, res) = call(&app, "DELETE", &uri, None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(res["resource"], "note");

    // Notes are per profile.
    let pid = other_profile(&app).await;
    call(&app, "PUT", &uri, Some(json!({ "text": "Mine" }))).await;
    let (_, theirs) = call(&app, "GET", &format!("/api/profiles/{pid}/day/{DAY}"), None).await;
    assert_eq!(theirs["note"], Value::Null);
}

#[tokio::test]
async fn body_measurements() {
    let app = app();
    let (_, meta) = call(&app, "GET", "/api/meta", None).await;
    assert_eq!(
        meta["measurements"],
        json!([
            { "key": "waist", "label": "Waist", "unit": "cm" },
            { "key": "hips", "label": "Hips", "unit": "cm" },
            { "key": "chest", "label": "Chest", "unit": "cm" },
        ])
    );
    assert_eq!(meta["limits"]["measure_cm"], json!([20.0, 300.0]));

    let at = |kind: &str| format!("/api/profiles/1/measurements/{DAY}/{kind}");
    for (kind, value) in [("chest", 95.0), ("waist", 80.5), ("hips", 99.0)] {
        let (status, m) = call(&app, "PUT", &at(kind), Some(json!({ "value": value }))).await;
        assert_eq!(status, StatusCode::OK, "{m}");
        assert_eq!(m, json!({ "day": DAY, "kind": kind, "value": value }));
    }
    let (_, m) = call(&app, "PUT", &at("waist"), Some(json!({ "value": 80.0 }))).await;
    assert_eq!(m["value"], 80.0, "replaced");
    assert_eq!(
        day_of(&app, DAY).await["measurements"],
        json!([
            { "kind": "waist", "value": 80.0 },
            { "kind": "hips", "value": 99.0 },
            { "kind": "chest", "value": 95.0 },
        ])
    );
    let (_, list) = call(
        &app,
        "GET",
        &format!("/api/profiles/1/measurements?from={DAY}"),
        None,
    )
    .await;
    assert_eq!(list.as_array().unwrap().len(), 3);
    assert_eq!(
        list[0],
        json!({ "day": DAY, "kind": "waist", "value": 80.0 })
    );

    for value in [json!(19.9), json!(300.1), json!("80")] {
        let (status, res) = call(&app, "PUT", &at("hips"), Some(json!({ "value": value }))).await;
        assert_invalid(status, &res, Some("value"));
    }
    let (status, res) = call(&app, "PUT", &at("neck"), Some(json!({ "value": 40.0 }))).await;
    assert_invalid(status, &res, None);
    let (status, res) = call(&app, "DELETE", &at("neck"), None).await;
    assert_invalid(status, &res, None);
    let after = "2999-01-01";
    let (status, res) = call(
        &app,
        "PUT",
        &format!("/api/profiles/1/measurements/{after}/waist"),
        Some(json!({ "value": 80.0 })),
    )
    .await;
    assert_invalid(status, &res, None);
    let today = kaloriina::model::day_so_far().yesterday().unwrap();
    let (status, _) = call(
        &app,
        "PUT",
        &format!("/api/profiles/1/measurements/{today}/waist"),
        Some(json!({ "value": 80.0 })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "today (UTC)");

    assert_eq!(
        call(&app, "DELETE", &at("hips"), None).await.0,
        StatusCode::NO_CONTENT
    );
    let (status, res) = call(&app, "DELETE", &at("hips"), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(res["resource"], "measurement");
    let (status, _) = call(
        &app,
        "PUT",
        &format!("/api/profiles/99/measurements/{DAY}/waist"),
        Some(json!({ "value": 80.0 })),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = common::raw(&app, "PUT", &at("waist"), "text/plain", "{\"value\":80}").await;
    assert_eq!(status, StatusCode::UNSUPPORTED_MEDIA_TYPE);
}
