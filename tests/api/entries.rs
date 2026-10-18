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
        json!({ "day": DAY, "group": "Eaten", "food_id": oats, "grams": 50.0, "time": "08:15" }),
    )
    .await;
    let a = &first["entries"][0];
    assert_eq!(a["time"], "08:15");
    let lunch = create_food(&app, "Lunch", json!({ "energy": 650.0 })).await;
    let (_, second) = post_entries(
        &app,
        json!({ "day": DAY, "group": "Eaten", "food_id": lunch, "grams": 100.0 }),
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
    let mine = log_entry(&app, "Eaten", oats, 10.0).await;

    let pid = other_profile(&app).await;
    let (status, res) = call(
        &app,
        "POST",
        &format!("/api/profiles/{pid}/entries"),
        Some(json!({ "day": DAY, "group": "Eaten", "entry_ids": [mine["id"]] })),
    )
    .await;
    assert_invalid(status, &res, Some("entry_ids"));

    let (status, res) = post_entries(
        &app,
        json!({ "day": DAY, "group": "Eaten", "entry_ids": [mine["id"], 999_999] }),
    )
    .await;
    assert_invalid(status, &res, Some("entry_ids"));
    let (status, res) = post_entries(
        &app,
        json!({ "day": DAY, "group": "Eaten", "entry_ids": [] }),
    )
    .await;
    assert_invalid(status, &res, Some("entry_ids"));

    let (_, history) = call(&app, "GET", "/api/profiles/1/day/2026-06-02", None).await;
    let imported = &group(&history, "Planned")["entries"][0];
    let (status, res) = post_entries(
        &app,
        json!({ "day": DAY, "group": "Eaten", "entry_ids": [mine["id"], imported["id"]] }),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{res}");
    assert_eq!(res["code"], "imported_read_only");
    // All or nothing: the first copy wasn't kept.
    let day = day_of(&app, DAY).await;
    assert_eq!(group(&day, "Eaten")["entries"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn a_log_names_exactly_one_thing() {
    let app = app();
    let oats = create_food(&app, "Oats", json!({ "energy": 100.0 })).await;
    for body in [
        json!({ "day": DAY, "group": "Eaten" }),
        json!({ "day": DAY, "group": "Eaten", "food_id": oats, "grams": 1.0, "meal_id": 1 }),
        json!({ "day": DAY, "group": "Eaten", "entry_ids": [1], "meal_id": 1 }),
        json!({ "day": DAY, "group": "Eaten", "food_id": oats, "grams": 1.0, "repeat_of": 1 }),
        json!({ "day": DAY, "group": "Eaten", "entry_ids": [1], "repeat_of": 1 }),
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
        json!({ "day": DAY, "group": "Eaten", "name": "Lunch out",
                "nutrients": { "energy": 650.0 } }),
    )
    .await;
    assert_invalid(status, &res, None);
    assert_eq!(day_of(&app, DAY).await["eaten"]["energy"], Value::Null);
}

#[tokio::test]
async fn entry_time_round_trips_and_clears() {
    let app = history_app();
    let oats = create_food(&app, "Oats", json!({ "energy": 100.0 })).await;
    let e = log_entry(&app, "Eaten", oats, 100.0).await;
    assert_eq!(e["time"], Value::Null);
    assert_eq!(e["kind"], "own", "an entry says what it is");
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
            json!({ "day": DAY, "group": "Eaten", "food_id": oats, "grams": 1.0, "time": bad }),
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

/// Its time is when it was eaten: in Planned, however it gets there, it
/// has none, and back in Eaten the old one doesn't return.
#[tokio::test]
async fn planned_has_no_eaten_time() {
    let app = app();
    let oats = create_food(&app, "Oats", json!({ "energy": 100.0 })).await;
    let (_, logged) = post_entries(
        &app,
        json!({ "day": DAY, "group": "Eaten", "food_id": oats, "grams": 50.0, "time": "08:15" }),
    )
    .await;
    let uri = format!("{ENTRIES}/{}", logged["entries"][0]["id"]);

    let (status, moved) = call(&app, "PATCH", &uri, Some(json!({ "group": "Planned" }))).await;
    assert_eq!(status, StatusCode::OK, "{moved}");
    assert_eq!(moved["time"], Value::Null, "a move to Planned clears it");
    let (_, back) = call(&app, "PATCH", &uri, Some(json!({ "group": "Eaten" }))).await;
    assert_eq!(back["time"], Value::Null, "the old time doesn't return");

    // Sent along (the editor sends its field), it's dropped all the same.
    let body = json!({ "group": "Planned", "time": "09:00" });
    let (_, moved) = call(&app, "PATCH", &uri, Some(body)).await;
    assert_eq!(moved["time"], Value::Null);
    let (_, timed) = call(&app, "PATCH", &uri, Some(json!({ "time": "10:00" }))).await;
    assert_eq!(timed["time"], Value::Null, "a planned entry can't be timed");

    // Logged straight into Planned (an offline write replayed too).
    let (status, planned) = post_entries(
        &app,
        json!({ "day": DAY, "group": "Planned", "food_id": oats, "grams": 50.0,
                "time": "12:00", "uid": "planned-0001" }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{planned}");
    assert_eq!(planned["entries"][0]["time"], Value::Null);
    let day = day_of(&app, DAY).await;
    for e in group(&day, "Planned")["entries"].as_array().unwrap() {
        assert_eq!(e["time"], Value::Null, "{e}");
    }
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

/// Imported history on `DAY`: two Consumed rows totalling 650 kcal and one
/// Breakfast row of 250 kcal.
fn imported_day_app() -> Router {
    let mut conn = open(FsPath::new(":memory:")).unwrap();
    let servings = format!(
        "Day,Group,Food Name,Amount\n{DAY},Consumed,Soup,300.00 g\n\
         {DAY},Consumed,Bread,70.00 g\n{DAY},Breakfast,Oats,50.00 g\n"
    );
    let summary = format!("Date,Group,Energy (kcal)\n{DAY},Consumed,650\n{DAY},Breakfast,250\n");
    kaloriina::import::import(
        &mut conn,
        common::ME,
        Some(servings.as_bytes()),
        Some(summary.as_bytes()),
    )
    .unwrap();
    app_from(conn, NO_OFF)
}

fn names_in(day: &Value, name: &str) -> Vec<String> {
    group(day, name)["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["name"].as_str().unwrap().to_owned())
        .collect()
}

#[tokio::test]
async fn an_imported_group_is_removed_with_its_total() {
    let app = imported_day_app();
    let apple = create_food(&app, "Apple", json!({ "energy": 50.0 })).await;
    log_entry(&app, "Eaten", apple, 100.0).await;

    let before = day_of(&app, DAY).await;
    assert_eq!(before["eaten"]["energy"], 950.0, "{before}");
    // Each imported row names its import group; the group goes as a whole.
    let from_consumed: Vec<&Value> = group(&before, "Eaten")["entries"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|e| e["src_group"] == "Eaten")
        .collect();
    assert_eq!(from_consumed.len(), 2, "{before}");

    let uri = format!("/api/profiles/1/imported/{DAY}/Eaten");
    let (status, res) = call(&app, "DELETE", &uri, None).await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{res}");
    let after = day_of(&app, DAY).await;
    assert_eq!(names_in(&after, "Eaten"), ["Apple"], "own entries stay");
    assert_eq!(names_in(&after, "Breakfast"), ["Oats"], "other groups stay");
    assert_eq!(after["eaten"]["energy"], 300.0, "{after}");
    assert!(after.get("imported").is_none(), "{after}");
    let (_, summary) = call(
        &app,
        "GET",
        &format!("/api/profiles/1/summary?from={DAY}&to={DAY}"),
        None,
    )
    .await;
    assert_eq!(summary["days"][0]["total"]["energy"], 300.0, "{summary}");

    // Set-semantic: a repeat (an unknown group too) changes nothing.
    for uri in [uri, format!("/api/profiles/1/imported/{DAY}/Nothing")] {
        let (status, res) = call(&app, "DELETE", &uri, None).await;
        assert_eq!(status, StatusCode::NO_CONTENT, "{res}");
    }
    assert_eq!(day_of(&app, DAY).await, after);

    let (status, res) = call(
        &app,
        "DELETE",
        &format!("/api/profiles/99/imported/{DAY}/Breakfast"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{res}");
    assert_eq!(res["resource"], "profile");
    let (status, res) = call(
        &app,
        "DELETE",
        "/api/profiles/1/imported/someday/Breakfast",
        None,
    )
    .await;
    assert_invalid(status, &res, None);
    assert_eq!(names_in(&day_of(&app, DAY).await, "Breakfast"), ["Oats"]);
}

/// A food known only per item (its weight a guess) logs that item's
/// values exactly, whatever the guess. The guess is `weight_estimated`,
/// read live from the food; the stored amount is plain (clients add `≈`).
#[tokio::test]
async fn estimated_weight_logs_exact_per_item_nutrients() {
    let app = app();
    let (status, burger) = call(
        &app,
        "POST",
        "/api/foods",
        Some(json!({
            "name": "Burger", "per100": { "energy": 540.0 * 100.0 / 210.0 },
            "servings": [{ "label": "Burger", "grams": 210 }],
            "basis": { "serving": "Burger", "estimated": true },
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{burger}");
    let two = json!([{ "food_id": burger["id"], "serving": "Burger", "quantity": 2 }]);
    let (status, logged) = call(
        &app,
        "POST",
        "/api/profiles/1/entries",
        Some(
            json!({ "day": DAY, "group": "Eaten", "food_id": burger["id"],
                     "serving": "Burger", "quantity": 2 }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{logged}");
    let (status, meal) = call(
        &app,
        "POST",
        "/api/meals",
        Some(json!({ "name": "Drive-in", "items": two })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{meal}");
    let (status, by_meal) = call(
        &app,
        "POST",
        "/api/profiles/1/entries",
        Some(json!({ "day": DAY, "group": "Eaten", "meal_id": meal["id"] })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{by_meal}");
    for e in [&logged["entries"][0], &by_meal["entries"][0]] {
        let energy = e["nutrients"]["energy"].as_f64().unwrap();
        // Exact to 1e-9 relative: stored values keep nine decimals (Nutrients).
        assert!((energy / 1080.0 - 1.0).abs() < 1e-9, "{energy}");
        assert_eq!(
            (&e["grams"], &e["amount"], &e["weight_estimated"]),
            (&json!(420.0), &json!("2 × Burger (420 g)"), &json!(true)),
            "{e}"
        );
    }
    let (_, day) = call(&app, "GET", &format!("/api/profiles/1/day/{DAY}"), None).await;
    assert_eq!(group(&day, "Eaten")["entries"][0]["weight_estimated"], true);

    // Recipe and meal items carry it too.
    let (status, recipe) = call(
        &app,
        "POST",
        "/api/recipes",
        Some(json!({ "name": "Burger meal", "cooked_g": null, "items": two })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{recipe}");
    for uri in [
        format!("/api/recipes/{}", recipe["id"]),
        format!("/api/meals/{}", meal["id"]),
    ] {
        let (_, read) = call(&app, "GET", &uri, None).await;
        assert_eq!(read["items"][0]["weight_estimated"], true, "{uri}: {read}");
    }

    // An ordinary food's grams are its own: no ≈.
    let oats = create_food(&app, "Oats", json!({ "energy": 380 })).await;
    let e = log_entry(&app, "Eaten", oats, 50.0).await;
    assert_eq!(
        (&e["amount"], &e["weight_estimated"]),
        (&json!("50 g"), &json!(false))
    );
}

/// Each entry names the import group it came from (`null` for your own),
/// so the import group to remove is read off the entry.
#[tokio::test]
async fn entries_carry_src_group() {
    let app = history_app();
    let bread = create_food(&app, "Bread", json!({ "energy": 250.0 })).await;
    let mine = log_entry_on(&app, "2026-06-02", "Planned", bread, 40.0).await;
    assert_eq!(mine["src_group"], Value::Null, "{mine}");
    let day = day_of(&app, "2026-06-02").await;
    let entries = group(&day, "Planned")["entries"].as_array().unwrap();
    let srcs: Vec<(&Value, &Value)> = entries
        .iter()
        .map(|e| (&e["name"], &e["src_group"]))
        .collect();
    assert_eq!(
        srcs,
        [
            (&json!("Rye Bread"), &json!("Planned")),
            (&json!("Bread"), &Value::Null)
        ]
    );
    let imported = &entries[0];
    let (_, read) = call(&app, "GET", &format!("{ENTRIES}/{}", imported["id"]), None).await;
    assert_eq!(read["src_group"], "Planned", "{read}");
    assert!(day.get("imported").is_none(), "{day}");
}

/// "Imported" is `src_group` set: no entry carries an `imported` flag.
#[tokio::test]
async fn entries_carry_no_imported_flag() {
    let app = history_app();
    let bread = create_food(&app, "Bread", json!({ "energy": 250.0 })).await;
    let mine = log_entry_on(&app, "2026-06-02", "Planned", bread, 40.0).await;
    let day = day_of(&app, "2026-06-02").await;
    let entries = group(&day, "Planned")["entries"].as_array().unwrap();
    let (_, read) = call(
        &app,
        "GET",
        &format!("{ENTRIES}/{}", entries[0]["id"]),
        None,
    )
    .await;
    for e in entries.iter().chain([&mine, &read]) {
        assert!(e.get("imported").is_none(), "{e}");
    }
}

/// `Consumed`, the group's name before migration 53, is no
/// longer read: a write naming it is refused, not moved to `Eaten`.
#[tokio::test]
async fn consumed_is_refused() {
    let app = app();
    let oats = create_food(&app, "Oats", json!({ "energy": 380.0 })).await;
    let (status, res) = post_entries(
        &app,
        json!({ "day": DAY, "group": "Consumed", "food_id": oats, "grams": 50.0 }),
    )
    .await;
    assert_eq!(
        (status, &res["field"]),
        (StatusCode::BAD_REQUEST, &json!("group")),
        "{res}"
    );
}

/// Each entry says what it is: your own, a due day of a series, or
/// imported history.
#[tokio::test]
async fn an_entry_names_its_kind() {
    let mut conn = open(FsPath::new(":memory:")).unwrap();
    let csv = "Day,Group,Food Name,Amount\n2026-10-06,Consumed,Rye Bread,70.00 g\n";
    common::import_servings(&mut conn, common::ME, csv.as_bytes()).unwrap();
    let app = app_from(conn, NO_OFF);
    let oats = create_food(&app, "Oats", json!({ "energy": 380.0 })).await;
    let own = log_entry(&app, "Eaten", oats, 50.0).await;
    assert_eq!(own["kind"], "own");
    let key = own["key"].as_str().unwrap();
    let (status, ticked) = call(
        &app,
        "PATCH",
        &format!("{ENTRIES}/{key}"),
        Some(json!({ "repeat": { "start": DAY } })),
    )
    .await;
    assert_eq!((status, &ticked["kind"]), (StatusCode::OK, &json!("own")));
    let next = day_of(&app, "2026-10-07").await;
    assert_eq!(group(&next, "Planned")["entries"][0]["kind"], "due");
    let day = day_of(&app, DAY).await;
    let kinds: Vec<&str> = group(&day, "Eaten")["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["kind"].as_str().unwrap())
        .collect();
    assert_eq!(kinds, ["imported", "own"]);
}

/// An id is never handed out again: a tab still showing a deleted
/// entry deletes nothing else; its Delete is a 404.
#[tokio::test]
async fn a_stale_delete_never_hits_the_next_entry() {
    let app = app();
    let wrong = create_food(&app, "Wrong food", json!({ "energy": 100.0 })).await;
    let right = create_food(&app, "Right food", json!({ "energy": 200.0 })).await;
    let old = log_entry(&app, "Eaten", wrong, 100.0).await;
    let gone = format!("{ENTRIES}/{}", old["id"]);
    let (status, _) = call(&app, "DELETE", &gone, None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let new = log_entry(&app, "Eaten", right, 100.0).await;
    assert_ne!(new["id"], old["id"], "{new}");
    let (status, _) = call(&app, "DELETE", &gone, None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let day = day_of(&app, DAY).await;
    assert_eq!(group(&day, "Eaten")["entries"][0]["name"], "Right food");
}

/// A meal made after one deleted gets a new id, so a stale tab's rev'd save
/// of the old one is a 404, not an overwrite at the same `rev`.
#[tokio::test]
async fn a_stale_meal_save_never_overwrites_the_next_meal() {
    let app = app();
    let oats = create_food(&app, "Oats", json!({ "energy": 380.0 })).await;
    let items = json!([{ "food_id": oats, "grams": 50.0 }]);
    let make = |name: &str| {
        let body = json!({ "name": name, "items": items });
        let app = app.clone();
        async move {
            let (status, meal) = call(&app, "POST", "/api/meals", Some(body)).await;
            assert_eq!(status, StatusCode::CREATED, "{meal}");
            meal
        }
    };
    let a = make("Meal A").await;
    let uri = format!("/api/meals/{}", a["id"]);
    let (status, _) = call(&app, "DELETE", &uri, None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let b = make("Meal B").await;
    assert_ne!(b["id"], a["id"], "{b}");
    let stale = json!({ "rev": a["rev"], "name": "Meal A edited", "items": items });
    let (status, _) = call(&app, "PUT", &uri, Some(stale)).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (_, b_now) = call(&app, "GET", &format!("/api/meals/{}", b["id"]), None).await;
    assert_eq!(b_now["name"], "Meal B");
}
