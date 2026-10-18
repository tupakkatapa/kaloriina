//! Export and import of a whole profile.

use super::*;
use axum::body::Body;
use axum::http::{Request, header};
use common::raw;
use http_body_util::BodyExt;
use std::collections::BTreeSet;
use tower::ServiceExt;

const HISTORY_DAY: &str = "2026-06-02";

/// GET the export: its `Content-Disposition` and the file.
async fn export(app: &Router, pid: i64) -> (String, Value) {
    let req = Request::builder()
        .uri(format!("/api/profiles/{pid}/export"))
        .body(Body::empty())
        .unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let disposition = res.headers()[header::CONTENT_DISPOSITION]
        .to_str()
        .unwrap()
        .to_owned();
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    (disposition, serde_json::from_slice(&bytes).unwrap())
}

async fn import(app: &Router, file: &Value) -> (StatusCode, Value) {
    call(app, "POST", "/api/profiles/import", Some(file.clone())).await
}

async fn ok(app: &Router, method: &str, uri: &str, body: Value) -> Value {
    let (status, res) = call(app, method, uri, Some(body)).await;
    assert!(status.is_success(), "{method} {uri}: {status} {res}");
    res
}

async fn get_ok(app: &Router, uri: &str) -> Value {
    let (status, res) = call(app, "GET", uri, None).await;
    assert_eq!(status, StatusCode::OK, "{uri}: {res}");
    res
}

async fn exercise_id(app: &Router, name: &str) -> i64 {
    let list = get_ok(app, "/api/exercises").await;
    list.as_array()
        .unwrap()
        .iter()
        .find(|e| e["name"] == name)
        .unwrap_or_else(|| panic!("no exercise {name}"))["id"]
        .as_i64()
        .unwrap()
}

/// The Fineli fixture ("Maito, rasvaton", Fineli id 11) plus imported
/// history on [`HISTORY_DAY`] for profile 1.
fn source_app() -> Router {
    let mut conn = open(FsPath::new(":memory:")).unwrap();
    let dir = FsPath::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fineli");
    kaloriina::fineli::store(&mut conn, &kaloriina::fineli::read(&dir).unwrap(), &[]).unwrap();
    let servings = "Day,Group,Food Name,Amount\n2026-06-02,Lunch,Rye,1 slice\n";
    common::import_servings(&mut conn, common::ME, servings.as_bytes()).unwrap();
    let summary = "Date,Group,Energy (kcal),Completed\n2026-06-02,Lunch,500,true\n";
    common::import_summary(&mut conn, common::ME, summary.as_bytes()).unwrap();
    app_from(conn, NO_OFF)
}

/// Profile 1 with one of everything an export carries.
async fn populate(app: &Router) {
    let milk = get_ok(app, "/api/profiles/1/foods?q=maito").await[0]["id"].clone();
    let oats = ok(
        app,
        "POST",
        "/api/foods",
        json!({ "name": "Oats", "brand": "Mill", "barcode": "6410000000017",
                "per100": { "energy": 370.0, "protein": 13.0, "net_carbs": 58.0, "fat": 7.0 },
                "servings": [{ "label": "Cup", "grams": 80.0 }] }),
    )
    .await;
    let berries = create_food(app, "Berries", json!({ "energy": 40.0, "net_carbs": 8.0 })).await;
    // Nested: Porridge holds Oats and Milk; Breakfast holds Porridge.
    let porridge = ok(
        app,
        "POST",
        "/api/recipes",
        json!({ "name": "Porridge", "cooked_g": null, "makes": 2,
                "notes": "Simmer 5 min.\n\nStir in the milk.",
                "items": [{ "food_id": oats["id"], "grams": 80.0 }, { "food_id": milk, "grams": 300.0 }] }),
    )
    .await;
    let breakfast = ok(
        app,
        "POST",
        "/api/recipes",
        json!({ "name": "Breakfast", "cooked_g": null,
                "items": [{ "food_id": porridge["id"], "grams": 200.0 }, { "food_id": berries, "grams": 50.0 }] }),
    )
    .await;
    let meal = ok(
        app,
        "POST",
        "/api/meals",
        json!({ "name": "Snack", "items": [{ "food_id": oats["id"], "grams": 30.0 }, { "food_id": berries, "grams": 70.0 }] }),
    )
    .await;
    let entries = "/api/profiles/1/entries";
    let consumed = |extra: Value| {
        let mut body = json!({ "day": DAY, "group": "Eaten" });
        body.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        body
    };
    ok(
        app,
        "POST",
        entries,
        consumed(json!({ "food_id": breakfast["id"], "grams": 250.0, "time": "08:15" })),
    )
    .await;
    ok(
        app,
        "POST",
        entries,
        consumed(json!({ "food_id": oats["id"], "serving": "Cup", "quantity": 1.5 })),
    )
    .await;
    ok(
        app,
        "POST",
        entries,
        consumed(json!({ "meal_id": meal["id"], "uid": "meal-write-0001" })),
    )
    .await;
    ok(
        app,
        "POST",
        entries,
        json!({ "day": "2026-10-07", "group": "Planned", "food_id": milk, "grams": 200.0 }),
    )
    .await;
    ok(
        app,
        "POST",
        "/api/profiles/1/foods/favorites",
        json!({ "food_id": berries }),
    )
    .await;
    ok(
        app,
        "POST",
        "/api/profiles/1/foods/favorites",
        json!({ "food_id": milk }),
    )
    .await;
    populate_body(app).await;
}

/// Profile 1's weights, note, measurements, targets and a session.
async fn populate_body(app: &Router) {
    // A weigh-in from openScale: a reading and the weight it sets.
    let hook = "/api/profiles/1/sync/openscale";
    ok(app, "POST", hook, json!({ "event": "clear", "userId": 1 })).await;
    ok(app, "PUT", hook, json!({ "user_id": 1 })).await;
    ok(
        app,
        "POST",
        hook,
        json!({ "event": "insert", "id": 4, "userId": 1, "username": "Alex",
                "date": "2026-09-15T05:00:00.000Z", "weight": 72.4, "body_fat": 21.5,
                "water": 0.0, "muscle": 0.0 }),
    )
    .await;
    ok(
        app,
        "PUT",
        &format!("/api/profiles/1/weights/{DAY}"),
        json!({ "kg": 71.5 }),
    )
    .await;
    ok(
        app,
        "PUT",
        "/api/profiles/1/weights/2026-09-01",
        json!({ "kg": 73.0 }),
    )
    .await;
    ok(
        app,
        "PUT",
        &format!("/api/profiles/1/notes/{DAY}"),
        json!({ "text": "Slept badly" }),
    )
    .await;
    ok(
        app,
        "PUT",
        &format!("/api/profiles/1/measurements/{DAY}/waist"),
        json!({ "value": 82.5 }),
    )
    .await;
    ok(
        app,
        "PUT",
        &format!("/api/profiles/1/measurements/{DAY}/hips"),
        json!({ "value": 95.0 }),
    )
    .await;
    let (status, _) = put_targets(
        app,
        1,
        json!([{ "metric": "energy", "value": 2100.0 }, { "metric": "protein", "value": 120.0 }]),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let pull = exercise_id(app, "Pull-up").await;
    let ankle = exercise_id(app, "Ankle rocks").await;
    let towel = ok(
        app,
        "POST",
        "/api/exercises",
        json!({ "name": "Towel hang", "measure": "time", "variant_of": pull }),
    )
    .await;
    ok(
        app,
        "POST",
        "/api/profiles/1/activities",
        json!({ "day": DAY, "name": "Pulls", "minutes": 25, "kcal": 120, "uid": "session-0001",
                "sets": [{ "exercise_id": pull, "reps": 8, "kg": 10.0 },
                         { "exercise_id": ankle, "reps": 12, "side": "left" },
                         { "exercise_id": towel["id"], "seconds": 30 }] }),
    )
    .await;
}

/// What a profile reads as through the API, ids left out: each day's
/// groups and their totals, sessions, weights, notes, measurements,
/// targets and favourites.
async fn snapshot(app: &Router, pid: i64) -> Value {
    let p = format!("/api/profiles/{pid}");
    let mut days = serde_json::Map::new();
    for day in [HISTORY_DAY, DAY, "2026-10-07"] {
        let d = get_ok(app, &format!("{p}/day/{day}")).await;
        let groups: Vec<Value> = d["groups"]
            .as_array()
            .unwrap()
            .iter()
            .map(|g| {
                let entries: Vec<Value> = g["entries"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|e| {
                        json!([
                            e["uid"],
                            e["name"],
                            e["amount"],
                            e["nutrients"],
                            e["time"],
                            e["src_group"],
                            e["created_at"]
                        ])
                    })
                    .collect();
                json!({ "name": g["name"], "totals": g["totals"], "entries": entries })
            })
            .collect();
        let sessions: Vec<Value> = d["activities"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| {
                let sets: Vec<Value> = s["sets"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|set| {
                        json!([
                            set["name"],
                            set["reps"],
                            set["seconds"],
                            set["kg"],
                            set["side"]
                        ])
                    })
                    .collect();
                json!([s["uid"], s["name"], s["minutes"], s["kcal"], sets])
            })
            .collect();
        days.insert(
            day.to_owned(),
            json!({ "groups": groups, "total": d["total"], "sessions": sessions,
                    "note": d["note"], "measurements": d["measurements"], "weight": d["weight"] }),
        );
    }
    let favorites: Vec<Value> = get_ok(app, &format!("{p}/foods/favorites"))
        .await
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["name"].clone())
        .collect();
    json!({
        "days": days,
        "weights": get_ok(app, &format!("{p}/weights")).await,
        "notes": get_ok(app, &format!("{p}/notes")).await,
        "measurements": get_ok(app, &format!("{p}/measurements")).await,
        "targets": get_ok(app, &format!("{p}/targets")).await,
        "favorites": favorites,
    })
}

/// The file without what differs between two exports of the same data,
/// nor what only a restore keeps (the id and the scale binding).
fn comparable(mut file: Value) -> Value {
    let o = file.as_object_mut().unwrap();
    o.remove("exported_at");
    o.remove("openscale");
    let profile = o["profile"].as_object_mut().unwrap();
    profile.remove("name");
    profile.remove("id");
    file
}

#[tokio::test]
async fn export_names_the_file_and_round_trips_on_the_same_instance() {
    let app = source_app();
    populate(&app).await;
    let (status, _) = put_with_rev(
        &app,
        "/api/profiles/1",
        json!({ "name": "Äiti Anna", "sex": null, "birth_date": null, "height_cm": null,
                "activity": null, "goal_kg_per_week": 0.0, "goal_date": "2027-03-01",
                "latitude": 60.2 }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let goals = json!([
        { "metric": "energy", "value": 2100.0 }, { "metric": "protein", "value": 120.0 },
        { "metric": "workouts_per_week", "value": 3 }, { "metric": "goal_weight", "value": 72.5 }
    ]);
    let (status, _) = put_targets(&app, 1, goals).await;
    assert_eq!(status, StatusCode::OK);
    let (disposition, file) = export(&app, 1).await;
    let date = &file["exported_at"].as_str().unwrap()[..10];
    assert_eq!(
        disposition,
        format!(
            "attachment; filename=\"kaloriina-iti-anna-{date}.json\"; \
             filename*=UTF-8''kaloriina-%C3%84iti%20Anna-{date}.json"
        )
    );
    assert_eq!(file["format"], "kaloriina-profile");
    assert_eq!(file["version"], 3);
    let uids: Vec<&str> = file["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["uid"].as_str().unwrap())
        .collect();
    assert!(uids.contains(&"meal-write-0001:1") && uids.contains(&"meal-write-0001:2"));
    assert_eq!(
        file["foods"].as_array().unwrap().len(),
        5,
        "recipe closure: {}",
        file["foods"]
    );

    // The same name is taken: 409, nothing written.
    let (status, res) = import(&app, &file).await;
    assert_eq!(status, StatusCode::CONFLICT, "{res}");
    assert_eq!(res["code"], "name_taken");

    let mut copy = file.clone();
    copy["profile"]["name"] = json!("Copy");
    let (status, profile) = import(&app, &copy).await;
    assert_eq!(status, StatusCode::CREATED, "{profile}");
    assert_eq!(profile["name"], "Copy");
    assert_eq!(profile["goal_date"], "2027-03-01");
    assert_eq!(profile["latitude"], 60.2);
    assert_eq!(
        profile["latest_weight_kg"], 71.5,
        "the latest logged weight"
    );
    let pid = profile["id"].as_i64().unwrap();
    let targets = get_ok(&app, &format!("/api/profiles/{pid}/targets")).await;
    for (metric, value) in [("workouts_per_week", 3.0), ("goal_weight", 72.5)] {
        assert!(
            targets
                .as_array()
                .unwrap()
                .iter()
                .any(|t| t["metric"] == metric && t["value"] == value),
            "{metric}: {targets}"
        );
    }
    // Every food and exercise matched: the copy's export is the original's.
    let (_, again) = export(&app, pid).await;
    assert_eq!(comparable(again), comparable(file));
    assert_eq!(snapshot(&app, pid).await, snapshot(&app, 1).await);
}

#[tokio::test]
async fn import_into_another_instance_reproduces_the_profile() {
    let source = source_app();
    populate(&source).await;
    let (_, file) = export(&source, 1).await;
    let expected = snapshot(&source, 1).await;

    // No Fineli here, and Oats' barcode already belongs to another food, of
    // the same values (entries follow the food they land on:
    // `imported_entries_follow_the_food_they_land_on`).
    let target = app();
    let taken = ok(
        &target,
        "POST",
        "/api/foods",
        json!({ "name": "Kaura", "barcode": "6410000000017",
                "per100": { "energy": 370.0, "protein": 13.0, "net_carbs": 58.0, "fat": 7.0 } }),
    )
    .await;
    let mut file = file;
    file["profile"]["name"] = json!("Moved");
    let (status, profile) = import(&target, &file).await;
    assert_eq!(status, StatusCode::CREATED, "{profile}");
    let pid = profile["id"].as_i64().unwrap();

    // Day totals, entries, sets, weights, notes, measurements, targets and
    // favourites read the same. (Favourites list by name; Oats is Kaura
    // here, matched by barcode, and isn't one.)
    assert_eq!(snapshot(&target, pid).await, expected);

    let (_, moved) = export(&target, pid).await;
    let food = |name: &str| {
        moved["foods"]
            .as_array()
            .unwrap()
            .iter()
            .find(|f| f["name"] == name)
            .unwrap_or_else(|| panic!("no food {name}: {}", moved["foods"]))
            .clone()
    };
    // Fineli's food came as your own, keeping its Fineli id: the Fineli
    // import takes it back.
    let milk = food("Maito, rasvaton");
    assert_eq!(milk["source"], "custom");
    assert!(milk["fineli_id"].is_i64(), "{milk}");
    // Matched by barcode: the food here is used as it is.
    assert_eq!(
        food("Kaura")["id"],
        Value::Null,
        "foods carry refs, not ids"
    );
    assert_eq!(
        food("Kaura")["ref"],
        json!(taken["id"].as_i64().unwrap().to_string())
    );
    // Recipes stay recipes, with Portion kept from `makes`.
    let porridge = food("Porridge");
    assert_eq!(
        (&porridge["kind"], &porridge["source"]),
        (&json!("recipe"), &json!("custom"))
    );
    assert_eq!(porridge["makes"], 2);
    assert_eq!(porridge["notes"], "Simmer 5 min.\n\nStir in the milk.");
    assert!(
        porridge["servings"]
            .as_array()
            .unwrap()
            .iter()
            .any(|s| s["label"] == "Portion")
    );
    assert_eq!(food("Breakfast")["items"].as_array().unwrap().len(), 2);

    // Base exercises matched by name; the custom one came as a variant.
    let exercises = get_ok(&target, "/api/exercises").await;
    let towel = exercises
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["name"] == "Towel hang")
        .unwrap();
    assert_eq!(towel["source"], "custom");
    assert_eq!(towel["variant_of"], exercise_id(&target, "Pull-up").await);
}

/// A valid file with nothing in it but a profile named `name`.
fn bare(name: &str) -> Value {
    json!({
        "format": "kaloriina-profile", "version": 3, "exported_at": "2026-10-08T10:00:00Z",
        "profile": { "name": name, "sex": null, "birth_date": null, "height_cm": null,
                     "activity": null, "goal_kg_per_week": 0.0 },
    })
}

/// An entry's values are its food's per 100 g times its grams,
/// on whichever instance it lands. A file whose food matches one here with
/// other values (re-run Fineli, a barcode) restores entries that follow
/// the food here, not the file's numbers.
#[tokio::test]
async fn imported_entries_follow_the_food_they_land_on() {
    let source = app();
    let oats = ok(
        &source,
        "POST",
        "/api/foods",
        json!({ "name": "Oats", "barcode": "6410000000017", "per100": { "energy": 200.0 } }),
    )
    .await;
    log_entry_on(&source, DAY, "Eaten", oats["id"].as_i64().unwrap(), 150.0).await;
    let (_, file) = export(&source, 1).await;
    assert_eq!(file["entries"][0]["nutrients"]["energy"], 300.0);

    let target = app();
    ok(
        &target,
        "POST",
        "/api/foods",
        json!({ "name": "Kaura", "barcode": "6410000000017", "per100": { "energy": 100.0 } }),
    )
    .await;
    let mut file = file;
    file["profile"]["name"] = json!("Moved");
    let (status, p) = import(&target, &file).await;
    assert_eq!(status, StatusCode::CREATED, "{p}");
    let day = get_ok(&target, &format!("/api/profiles/{}/day/{DAY}", p["id"])).await;
    let entry = &group(&day, "Eaten")["entries"][0];
    assert_eq!(entry["nutrients"]["energy"], 150.0, "{entry}");
    assert_eq!(day["eaten"]["energy"], 150.0);
}

/// Only this release's words are read. A file saying a recipe's
/// source is `recipe`, an entry's group `Consumed` or a target's
/// `nutrient` is refused, not translated.
#[tokio::test]
async fn old_words_in_a_file_are_refused() {
    let app = app();
    let oats = json!({ "ref": "o", "name": "Oats", "source": "custom",
                       "per100": { "energy": 380.0 } });
    let mut recipe = bare("Recipe");
    recipe["foods"] = json!([oats, { "ref": "p", "name": "Porridge", "source": "recipe",
                                     "items": [{ "food": "o", "grams": 100.0 }] }]);
    recipe["favorites"] = json!(["p"]);
    let mut consumed = bare("Consumed");
    consumed["foods"] = json!([oats]);
    consumed["entries"] = json!([{ "uid": "old-entry-0001", "day": DAY, "group": "Consumed",
        "food": "o", "name": "Oats", "grams": 100.0, "amount": "100 g",
        "created_at": "2026-10-06T10:00:00Z" }]);
    let mut nutrient = bare("Nutrient");
    nutrient["targets"] = json!([{ "nutrient": "energy", "value": 2000.0 }]);
    for (file, word) in [
        (recipe, "recipe"),
        (consumed, "Planned or Eaten"),
        (nutrient, "metric"),
    ] {
        let (status, res) = import(&app, &file).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{word}: {res}");
        assert!(res["error"].as_str().unwrap().contains(word), "{res}");
    }
}

/// A file's drink flag is yours only where it says so
/// (`drink_set`); an older file's derived flag is derived again here, so a
/// drink served "750ml" isn't frozen as no drink.
#[tokio::test]
async fn a_files_drink_is_kept_only_where_set_by_hand() {
    let app = app();
    let mut file = bare("Drinks");
    let food = |reference: &str, name: &str| {
        json!({ "ref": reference, "name": name, "source": "custom",
                "per100": { "energy": 2.0 }, "drink": false,
                "servings": [{ "label": "750ml", "grams": 750.0 }] })
    };
    let mut mine = food("m", "Mine");
    mine["drink_set"] = json!(true);
    file["foods"] = json!([food("o", "OSHEE Zero"), mine]);
    file["entries"] = json!(
        ["o", "m"]
            .iter()
            .enumerate()
            .map(|(i, f)| json!({
        "uid": format!("drink-entry-000{i}"), "day": DAY, "group": "Eaten", "kind": "food",
        "food": f, "name": f, "grams": 750.0, "amount": "750 g",
        "nutrients": { "energy": 15.0 }, "created_at": "2026-10-06T10:00:00Z" }))
            .collect::<Vec<_>>()
    );
    let (status, p) = import(&app, &file).await;
    assert_eq!(status, StatusCode::CREATED, "{p}");
    let (_, out) = export(&app, p["id"].as_i64().unwrap()).await;
    let flags = |name: &str| {
        let f = out["foods"]
            .as_array()
            .unwrap()
            .iter()
            .find(|f| f["name"] == name)
            .unwrap()
            .clone();
        (f["drink"].clone(), f.get("drink_set").cloned())
    };
    assert_eq!(flags("OSHEE Zero"), (json!(true), None));
    assert_eq!(flags("Mine"), (json!(false), Some(json!(true))));
}

/// A backup outlives its goal date: the file restores with it.
#[tokio::test]
async fn a_file_with_a_passed_goal_date_restores() {
    let app = app();
    let mut file = bare("Past goal");
    file["profile"]["goal_date"] = json!("2026-02-01");
    let (status, p) = import(&app, &file).await;
    assert_eq!(status, StatusCode::CREATED, "{p}");
    assert_eq!(p["goal_date"], "2026-02-01");
}

/// An imported day total says only energy, the macros and alcohol
/// truthfully (ADR 0030): its other keys, zeros too, are unknown, so its
/// day knows none of their energy and its nutrient built-ins aren't known.
#[tokio::test]
async fn an_imported_days_other_nutrients_are_unknown() {
    let app = app();
    let mut file = bare("Imported");
    file["day_totals"] = json!([{ "day": HISTORY_DAY, "group": "Dinner",
        "nutrients": { "energy": 2000.0, "protein": 80.0, "phosphorus": 0.0, "caffeine": 0.0,
                       "water": 1500.0 } }]);
    let (status, p) = import(&app, &file).await;
    assert_eq!(status, StatusCode::CREATED, "{p}");
    let pid = p["id"].as_i64().unwrap();
    let summary = get_ok(
        &app,
        &format!("/api/profiles/{pid}/summary?from={HISTORY_DAY}&to={HISTORY_DAY}"),
    )
    .await;
    // Its weight is its macronutrients' (it has no grams); caffeine and
    // creatine can't be vouched for.
    assert_eq!(
        summary["days"][0]["known"],
        json!({ "phosphorus": 0.0, "caffeine": 0.0, "creatine": 0.0, "dry": 80.0, "water": 0.0 }),
        "{summary}"
    );
    let day = get_ok(&app, &format!("/api/profiles/{pid}/day/{HISTORY_DAY}")).await;
    assert_eq!(day["known"], summary["days"][0]["known"], "{day}");
    let days = get_ok(
        &app,
        &format!("/api/profiles/{pid}/habits/days?from={HISTORY_DAY}&to={HISTORY_DAY}"),
    )
    .await;
    let caffeine = days
        .as_array()
        .unwrap()
        .iter()
        .find(|d| d["habit"] == "caffeine")
        .unwrap();
    assert_eq!(
        (&caffeine["amount"], &caffeine["known"]),
        (&json!(0.0), &json!(false)),
        "{days}"
    );
    // Its water counts toward hydration, as a floor.
    let water = days
        .as_array()
        .unwrap()
        .iter()
        .find(|d| d["habit"] == "water")
        .unwrap();
    assert_eq!(
        (&water["amount"], &water["known"]),
        (&json!(1500.0), &json!(false)),
        "{days}"
    );
}

/// An entry of imported history with `uid`.
fn history(uid: &str) -> Value {
    json!({ "uid": uid, "day": DAY, "group": "Eaten", "src_group": "Eaten",
            "name": "Snack", "amount": "1 bowl", "created_at": "2026-10-06T10:00:00Z" })
}

#[tokio::test]
async fn import_matches_foods_by_fineli_barcode_then_values_and_exercises_by_name() {
    let app = source_app();
    let milk = get_ok(&app, "/api/profiles/1/foods?q=maito").await[0]["id"].clone();
    let rye = ok(
        &app,
        "POST",
        "/api/foods",
        json!({ "name": "Rye", "barcode": "6410000000024", "per100": { "energy": 250.0 } }),
    )
    .await;
    let same = create_food(&app, "Butter", json!({ "energy": 720.0, "fat": 80.0 })).await;
    let exercises_before = get_ok(&app, "/api/exercises")
        .await
        .as_array()
        .unwrap()
        .len();
    let mut file = bare("Matcher");
    file["foods"] = json!([
        // Fineli id first, whatever the name.
        { "ref": "a", "name": "Skimmed milk", "source": "fineli", "fineli_id": 11, "per100": {} },
        // Barcode next.
        { "ref": "b", "name": "Ruis", "barcode": "6410000000024", "source": "off", "per100": { "energy": 1.0 } },
        // Then identical source, name, brand and values.
        { "ref": "c", "name": "Butter", "brand": null, "source": "custom", "per100": { "energy": 720.0, "fat": 80.0 } },
        // Unmatched: created as custom; a bad barcode is dropped.
        { "ref": "d", "name": "Butter", "source": "custom", "barcode": "12ab", "per100": { "energy": 700.0 } },
        // Unmatched with a free, valid barcode: kept.
        { "ref": "e", "name": "Jam", "source": "off", "barcode": "6410000000031", "per100": { "energy": 200.0 } },
    ]);
    file["favorites"] = json!(["a", "b", "c", "d", "e"]);
    file["exercises"] = json!([{ "ref": "x", "name": "PULL-UP", "measure": "reps" }]);
    file["activities"] = json!([{ "uid": "session-0002", "day": DAY, "name": "Pulls", "minutes": 5,
                                "sets": [{ "exercise": "x", "reps": 5 }] }]);
    let (status, profile) = import(&app, &file).await;
    assert_eq!(status, StatusCode::CREATED, "{profile}");
    let pid = profile["id"].as_i64().unwrap();

    let favorites = get_ok(&app, &format!("/api/profiles/{pid}/foods/favorites")).await;
    let ids: Vec<&Value> = favorites
        .as_array()
        .unwrap()
        .iter()
        .map(|f| &f["id"])
        .collect();
    assert!(ids.contains(&&milk) && ids.contains(&&rye["id"]) && ids.contains(&&json!(same)));
    let created: Vec<&Value> = favorites
        .as_array()
        .unwrap()
        .iter()
        .filter(|f| ![&milk, &rye["id"], &json!(same)].contains(&&f["id"]))
        .collect();
    assert_eq!(created.len(), 2, "{favorites}");
    for f in &created {
        assert_eq!(f["source"], "custom", "{f}");
    }
    let barcode =
        |name: &str| created.iter().find(|f| f["name"] == name).unwrap()["barcode"].clone();
    assert_eq!(barcode("Butter"), Value::Null);
    assert_eq!(barcode("Jam"), "6410000000031");

    assert_eq!(
        get_ok(&app, "/api/exercises")
            .await
            .as_array()
            .unwrap()
            .len(),
        exercises_before
    );
    let sessions = get_ok(&app, &format!("/api/profiles/{pid}/activities")).await;
    assert_eq!(
        sessions[0]["sets"][0]["exercise_id"],
        exercise_id(&app, "Pull-up").await
    );
    assert_eq!(sessions[0]["sets"][0]["name"], "Pull-up");
    assert_eq!(sessions[0]["workout_id"], Value::Null);
    // A file from before session types: its set-based session is a workout.
    assert_eq!(sessions[0]["type"], "workout");
}

#[tokio::test]
async fn import_refuses_bad_files_and_writes_nothing() {
    let app = app();
    let profiles = || async {
        get_ok(&app, "/api/profiles")
            .await
            .as_array()
            .unwrap()
            .len()
    };
    let before = profiles().await;
    let refused = |file: Value, status: StatusCode, field: &'static str| {
        let app = app.clone();
        async move {
            let (got, res) = import(&app, &file).await;
            assert_eq!(got, status, "{res}");
            if status == StatusCode::BAD_REQUEST {
                assert_eq!(res["field"], field, "{res}");
            } else {
                assert_eq!(res["code"], field, "{res}");
            }
        }
    };

    let mut newer = bare("New");
    newer["version"] = json!(4);
    newer["entries"] = json!("a shape v3 doesn't know");
    refused(newer, StatusCode::BAD_REQUEST, "version").await;
    let mut other = bare("New");
    other["format"] = json!("something-else");
    refused(other, StatusCode::BAD_REQUEST, "format").await;

    // Duplicate uids, and malformed ones, before anything is written.
    let mut dup = bare("New");
    dup["entries"] = json!([history("same-uid-0001"), history("same-uid-0001")]);
    refused(dup, StatusCode::BAD_REQUEST, "entries").await;
    for uid in [
        "short",
        "has space-0001",
        "good-uid-0001:x",
        "good-uid-0001:1:2",
    ] {
        let mut bad = bare("New");
        bad["entries"] = json!([history(uid)]);
        refused(bad, StatusCode::BAD_REQUEST, "entries").await;
    }
    // A meal item's suffix is fine.
    let mut items = bare("Items");
    items["entries"] = json!([history("meal-write-0001:1"), history("meal-write-0001:2")]);
    let (status, res) = import(&app, &items).await;
    assert_eq!(status, StatusCode::CREATED, "{res}");

    let mut unknown_food = bare("New");
    let mut entry = history("food-entry-0001");
    entry["src_group"] = Value::Null;
    entry["food"] = json!("nope");
    unknown_food["entries"] = json!([entry]);
    refused(unknown_food, StatusCode::BAD_REQUEST, "entries").await;
    let mut cycle = bare("New");
    cycle["foods"] = json!([
        { "ref": "a", "name": "A", "source": "custom", "kind": "recipe", "items": [{ "food": "b", "grams": 10.0 }] },
        { "ref": "b", "name": "B", "source": "custom", "kind": "recipe", "items": [{ "food": "a", "grams": 10.0 }] },
    ]);
    refused(cycle, StatusCode::BAD_REQUEST, "foods").await;
    let mut bad_weight = bare("New");
    bad_weight["weights"] = json!([{ "day": DAY, "kg": 5.0 }]);
    refused(bad_weight, StatusCode::BAD_REQUEST, "weights").await;
    let mut bad_reading = bare("New");
    bad_reading["scale_readings"] = json!([{ "source": "openscale", "source_user": 1,
        "taken_at": 1, "day": DAY, "weight": 70.0, "water": 120.0 }]);
    refused(bad_reading, StatusCode::BAD_REQUEST, "scale_readings").await;
    refused(bare("Items"), StatusCode::CONFLICT, "name_taken").await;

    // A failure found while writing (a side on a two-sided exercise) rolls
    // back the foods and exercises created before it.
    let mut late = bare("New");
    late["foods"] = json!([{ "ref": "z", "name": "Zzyzx bar", "source": "custom", "per100": { "energy": 400.0 } }]);
    late["exercises"] = json!([{ "ref": "x", "name": "Pull-up", "measure": "reps" },
                               { "ref": "y", "name": "Brand new move", "measure": "reps" }]);
    late["activities"] = json!([{ "uid": "session-0003", "day": DAY, "name": "Pulls", "minutes": 5,
                                "sets": [{ "exercise": "x", "reps": 5, "side": "left" }] }]);
    refused(late, StatusCode::BAD_REQUEST, "activities").await;
    assert_eq!(profiles().await, before + 1, "only Items was imported");
    let (_, found) = search(&app, "q=zzyzx").await;
    assert_eq!(found, json!([]));
    let names = get_ok(&app, "/api/exercises").await;
    assert!(
        !names
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["name"] == "Brand new move")
    );
}

#[tokio::test]
async fn import_takes_files_up_to_its_own_limit() {
    let app = app();
    // Above axum's 2 MB default: the route's own cap applies.
    let mut big = bare("Big");
    big["padding"] = json!("x".repeat(3 * 1024 * 1024));
    let (status, res) = import(&app, &big).await;
    assert_eq!(status, StatusCode::CREATED, "{res}");
    let huge = "x".repeat(kaloriina::model::IMPORT_BYTES_MAX + 1);
    let (status, res) = raw(
        &app,
        "POST",
        "/api/profiles/import",
        "application/json",
        &huge,
    )
    .await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE, "{res}");
    assert_eq!(res["code"], "too_large");
}

#[tokio::test]
async fn a_set_of_a_deleted_exercise_travels_by_its_name() {
    let source = app();
    let gone = ok(
        &source,
        "POST",
        "/api/exercises",
        json!({ "name": "Gone move", "measure": "time" }),
    )
    .await;
    ok(
        &source,
        "POST",
        "/api/profiles/1/activities",
        json!({ "day": DAY, "name": "Odd", "minutes": 5, "sets": [{ "exercise_id": gone["id"], "seconds": 40 }] }),
    )
    .await;
    let (status, _) = call(
        &source,
        "DELETE",
        &format!("/api/exercises/{}", gone["id"]),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    // Version 2: the set names no exercise, only its name.
    let (_, mut file) = export(&source, 1).await;
    assert_eq!(file["exercises"], json!([]));
    assert_eq!(
        file["activities"][0]["sets"][0],
        json!({ "exercise": null, "name": "Gone move", "seconds": 40 })
    );

    let target = app();
    file["profile"]["name"] = json!("Moved");
    let (status, profile) = import(&target, &file).await;
    assert_eq!(status, StatusCode::CREATED, "{profile}");
    let uri = format!("/api/profiles/{}/activities", profile["id"]);
    let activities = get_ok(&target, &uri).await;
    assert_eq!(
        activities[0]["sets"][0],
        json!({ "exercise_id": null, "name": "Gone move", "seconds": 40 })
    );
}

#[tokio::test]
async fn habits_travel_with_their_days() {
    let source = app();
    let snus = ok(
        &source,
        "POST",
        "/api/profiles/1/habits",
        json!({ "name": "Snus", "unit": "pouches", "goal_value": 6 }),
    )
    .await;
    let old = ok(
        &source,
        "POST",
        "/api/profiles/1/habits",
        json!({ "name": "Cigarettes", "unit": "cigarettes", "archived": true }),
    )
    .await;
    for (h, day, amount) in [
        (&snus, DAY, 4.0),
        (&snus, "2026-10-05", 2.5),
        (&old, "2026-01-02", 10.0),
    ] {
        ok(
            &source,
            "PUT",
            &format!("/api/profiles/1/habits/{}/days/{day}", h["id"]),
            json!({ "amount": amount }),
        )
        .await;
    }
    let (_, mut file) = export(&source, 1).await;
    let mut shown = file["habits"].clone();
    for h in shown.as_array_mut().unwrap() {
        let at = h.as_object_mut().unwrap().remove("created_at").unwrap();
        assert_eq!(at.as_str().unwrap().len(), 20, "{at}");
    }
    assert_eq!(
        shown,
        json!([
            { "name": "Snus", "unit": "pouches", "goal_value": 6.0, "goal_dir": "at_most",
              "archived": false,
              "days": [{ "day": "2026-10-05", "amount": 2.5 }, { "day": DAY, "amount": 4.0 }] },
            { "name": "Cigarettes", "unit": "cigarettes", "goal_value": null,
              "goal_dir": "at_most", "archived": true,
              "days": [{ "day": "2026-01-02", "amount": 10.0 }] },
        ])
    );

    // Into another instance, as new trackers of the new profile.
    let target = app();
    ok(
        &target,
        "POST",
        "/api/profiles/1/habits",
        json!({ "name": "Snus", "unit": "pouches" }),
    )
    .await;
    file["profile"]["name"] = json!("Moved");
    let (status, profile) = import(&target, &file).await;
    assert_eq!(status, StatusCode::CREATED, "{profile}");
    let (_, again) = export(&target, profile["id"].as_i64().unwrap()).await;
    assert_eq!(again["habits"], file["habits"]);

    // A file from before habits imports without any.
    let (status, profile) = import(&target, &bare("Older")).await;
    assert_eq!(status, StatusCode::CREATED, "{profile}");
    let list = get_ok(&target, &format!("/api/profiles/{}/habits", profile["id"])).await;
    assert_eq!(list, json!([]));

    // Bad trackers are refused, blamed on `habits`, and nothing is written.
    let tracker = |name: &str, days: Value| json!({ "name": name, "unit": "x", "days": days });
    for habits in [
        json!([tracker("A", json!([])), tracker("a", json!([]))]),
        json!([tracker("A", json!([{ "day": DAY, "amount": 0 }]))]),
        json!([tracker("A", json!([{ "day": "2999-01-01", "amount": 1 }]))]),
        json!([tracker(
            "A",
            json!([{ "day": DAY, "amount": 1 }, { "day": DAY, "amount": 2 }])
        )]),
        json!([{ "name": "A", "unit": "", "days": [] }]),
        json!(
            (0..21)
                .map(|n| tracker(&format!("H{n}"), json!([])))
                .collect::<Vec<_>>()
        ),
    ] {
        let mut bad = bare("Bad");
        bad["habits"] = habits.clone();
        let (status, res) = import(&target, &bad).await;
        assert_eq!(
            (status, &res["field"]),
            (StatusCode::BAD_REQUEST, &json!("habits")),
            "{habits}: {res}"
        );
    }
}

#[tokio::test]
async fn scale_readings_and_weight_sources_travel_and_a_copy_isnt_connected() {
    let app = source_app();
    populate(&app).await;
    let (_, file) = export(&app, 1).await;
    assert_eq!(
        file["scale_readings"],
        json!([{ "source": "openscale", "source_user": 1, "source_id": 4,
                 "taken_at": 1_789_448_400_000_i64, "day": "2026-09-15", "weight": 72.4,
                 "body_fat": 21.5, "water": null, "muscle": null, "bone_kg": null,
                 "lbm_kg": null, "bmr_kcal": null }])
    );
    let sources: Vec<(&str, &str)> = file["weights"]
        .as_array()
        .unwrap()
        .iter()
        .map(|w| (w["day"].as_str().unwrap(), w["source"].as_str().unwrap()))
        .collect();
    assert!(
        sources.contains(&("2026-09-15", "openscale")),
        "{sources:?}"
    );
    assert!(sources.contains(&("2026-09-01", "hand")), "{sources:?}");
    assert_eq!(
        file["openscale"],
        json!({ "bound_user": 1, "bound_username": "Alex" }),
        "the binding travels, for a restore"
    );

    let mut copy = file.clone();
    copy["profile"]["name"] = json!("Copy");
    // An older file's visceral fat is ignored.
    copy["scale_readings"][0]["visceral_fat"] = json!(7.0);
    let (status, p) = import(&app, &copy).await;
    assert_eq!(status, StatusCode::CREATED, "{p}");
    let pid = &p["id"];
    let day = get_ok(&app, &format!("/api/profiles/{pid}/day/2026-09-15")).await;
    assert_eq!(
        (&day["weight_source"], &day["composition"]["body_fat"]),
        (&json!("openscale"), &json!(21.5))
    );
    let status = get_ok(&app, &format!("/api/profiles/{pid}/sync/openscale")).await;
    assert_eq!(
        status["bound_user"],
        Value::Null,
        "the copy isn't connected"
    );
}

/// Each session's synced fields as compact JSON, sorted.
fn session_shapes(list: &Value) -> Vec<String> {
    let mut out: Vec<String> = list
        .as_array()
        .unwrap()
        .iter()
        .map(|s| {
            let fields = [
                "name",
                "type",
                "distance_m",
                "start_at",
                "source",
                "source_key",
                "minutes",
                "kcal",
            ];
            Value::Array(fields.iter().map(|k| s[*k].clone()).collect()).to_string()
        })
        .collect();
    out.sort();
    out
}

/// The night of 2026-09-02 as the phone keeps it raw, for the server to
/// make: 23:10–07:05, awake 35 min, deep 70, REM 90, light 200, at 55 bpm;
/// one HRV reading of 48 ms in it.
fn night_of_the_2nd() -> Value {
    let mut night = hc_sleep(
        "s-1",
        "2026-09-01T23:10:00Z",
        "2026-09-02T07:05:00Z",
        &[
            ("2026-09-01T23:10:00Z", "2026-09-01T23:45:00Z", 1),
            ("2026-09-01T23:45:00Z", "2026-09-02T00:55:00Z", 5),
            ("2026-09-02T00:55:00Z", "2026-09-02T02:25:00Z", 6),
            ("2026-09-02T02:25:00Z", "2026-09-02T05:45:00Z", 4),
        ],
    );
    night["data"]["avg_bpm"] = json!(55);
    let hrv = json!({ "kind": "HeartRateVariabilityRmssd", "id": "hrv-1",
        "start": "2026-09-02T03:00:00Z", "data": { "time": "2026-09-02T03:00:00Z", "ms": 48.0 } });
    json!([night, hrv])
}

#[tokio::test]
async fn health_connect_activity_travels_but_its_status_doesnt() {
    let app = app();
    let sessions = json!([
        { "key": "hc-1", "day": "2026-09-02", "start_at": "2026-09-02T14:02:00Z",
          "end_at": "2026-09-02T14:48:00Z", "type": 33, "name": "Running", "kcal": 410, "kcal_total": null,
          "distance_m": 8200, "recording_method": 1, "avg_hr": 151, "max_hr": 178 },
        { "key": "hc-2", "day": "2026-09-03", "start_at": "2026-09-03T08:00:00Z",
          "end_at": "2026-09-03T08:30:00Z", "type": 53, "name": "Walking", "kcal": 90, "kcal_total": null,
          "distance_m": 3000, "recording_method": 2, "avg_hr": null, "max_hr": null }]);
    let days = json!([
        { "day": "2026-09-02", "active_kcal": 512, "steps": 9120, "resting_hr": 54,
          "hrv_ms": 48, "asleep_min": 440, "in_bed_min": 475, "bedtime": "23:10",
          "wake_time": "07:05", "deep_min": 70, "rem_min": 90, "light_min": 200,
          "total_kcal": 2450, "avg_hr": 68, "min_hr": 48, "max_hr": 141, "sleep_avg_hr": 55 },
        { "day": "2026-09-03", "active_kcal": null, "steps": 100, "resting_hr": null,
          "hrv_ms": null, "asleep_min": null, "in_bed_min": null, "bedtime": null,
          "wake_time": null, "deep_min": null, "rem_min": null, "light_min": null,
          "total_kcal": null, "avg_hr": null, "min_hr": null, "max_hr": null,
          "sleep_avg_hr": null }]);
    hc_records(&app, 1, night_of_the_2nd()).await;
    ok(
        &app,
        "POST",
        "/api/profiles/1/sync/health",
        json!({ "from": "2026-09-01", "to": "2026-09-07", "device": "Pixel 9",
                "days": days, "sessions": sessions }),
    )
    .await;
    // Stored, a day has its resting energy and distance (none sent here)
    // and a session's wire `kcal_total` is `total_kcal`.
    let days: Value = days
        .as_array()
        .unwrap()
        .iter()
        .map(|d| {
            let mut d = d.clone();
            (d["bmr_kcal"], d["bmr_origin"]) = (Value::Null, Value::Null);
            d["distance_m"] = Value::Null;
            d
        })
        .collect();
    let sessions: Value = sessions
        .as_array()
        .unwrap()
        .iter()
        .map(|s| {
            let mut s = s.clone();
            s["total_kcal"] = s.as_object_mut().unwrap().remove("kcal_total").unwrap();
            s
        })
        .collect();
    // The walk the device found by itself waits; dismissed, it's a tombstone.
    let walk = "/api/profiles/1/sync/health/workouts/hc-2";
    let (status, _) = call(&app, "DELETE", walk, None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    ok(
        &app,
        "POST",
        "/api/profiles/1/activities",
        json!({ "day": "2026-09-04", "name": "Swim", "minutes": 30, "type": "swim",
                "distance_m": 1000, "start_at": "2026-09-04T09:00:00+03:00",
                "uid": "swim-0001" }),
    )
    .await;
    let (_, file) = export(&app, 1).await;
    assert_eq!(
        (&file["device_days"], &file["device_sessions"]),
        (&days, &sessions)
    );
    let tombstones = json!([{ "key": "hc-2", "type": "walk", "start_at": "2026-09-03T08:00:00Z" }]);
    assert_eq!(file["workout_tombstones"], tombstones);
    assert!(!file.to_string().contains("Pixel 9"), "no sync status");
    let synced = r#"["Running","run",8200,"2026-09-02T14:02:00Z","health_connect","hc-1",46,410]"#;
    let logged = r#"["Swim","swim",1000,"2026-09-04T06:00:00Z","hand",null,30,null]"#;
    assert_eq!(session_shapes(&file["activities"]), [synced, logged]);

    let mut copy = file.clone();
    copy["profile"]["name"] = json!("Copy");
    let (status, p) = import(&app, &copy).await;
    assert_eq!(status, StatusCode::CREATED, "{p}");
    let pid = &p["id"];
    let activity = get_ok(&app, &format!("/api/profiles/{pid}/device-days")).await;
    let shown: Vec<Value> = days
        .as_array()
        .unwrap()
        .iter()
        .map(|d| {
            let mut d = d.clone();
            d["total_asleep_min"] = d["asleep_min"].clone();
            d["naps"] = json!(0);
            d["nap_in_bed_min"] = json!(0);
            d
        })
        .collect();
    assert_eq!(
        activity,
        json!({ "days": shown, "sessions": sessions, "resting": [] })
    );
    let health = get_ok(&app, &format!("/api/profiles/{pid}/sync/health")).await;
    assert_eq!(health["last_seen"], Value::Null, "the copy never synced");
    assert_eq!(health["workouts"], "auto", "the mode stays behind");
    let back = get_ok(&app, &format!("/api/profiles/{pid}/activities")).await;
    assert_eq!(session_shapes(&back), [synced, logged]);
    let (_, again) = export(&app, pid.as_i64().unwrap()).await;
    assert_eq!(again["workout_tombstones"], tombstones);
}

#[tokio::test]
async fn a_file_without_device_activity_imports() {
    let app = app();
    let (status, p) = import(&app, &bare("Older")).await;
    assert_eq!(status, StatusCode::CREATED, "{p}");
    let activity = get_ok(&app, &format!("/api/profiles/{}/device-days", p["id"])).await;
    assert_eq!(
        activity,
        json!({ "days": [], "sessions": [], "resting": [] })
    );
}

#[tokio::test]
async fn health_connect_values_in_a_file_are_checked() {
    let app = app();
    let day = json!({ "day": "2026-09-02", "active_kcal": 512, "steps": 9120 });
    let workout = json!({ "key": "hc-1", "day": "2026-09-02", "start_at": "2026-09-02T14:02:00Z",
        "end_at": "2026-09-02T14:48:00Z", "type": 33, "name": "Running", "kcal": 410 });
    // Values out of bounds, or a day, key, source key or tombstone twice,
    // are refused.
    let session = |uid: &str, key: Value, source: &str| {
        json!({ "uid": uid, "day": "2026-09-02", "name": "Run", "minutes": 30,
                "source": source, "source_key": key })
    };
    let many: Vec<Value> = (0..=kaloriina::model::TOMBSTONES_MAX)
        .map(|i| json!({ "key": format!("k-{i}") }))
        .collect();
    for (field, list) in [
        ("device_days", json!([{ "day": "2026-09-02", "steps": -1 }])),
        ("device_days", json!([{ "day": "2026-09-02" }])),
        ("device_days", json!([day, day])),
        (
            "device_days",
            json!([{ "day": "2026-09-02", "hrv_ms": 48, "rem_min": 30 }]),
        ),
        // Resting energy comes with its app, in bounds.
        (
            "device_days",
            json!([{ "day": "2026-09-02", "bmr_kcal": 1650.0 }]),
        ),
        (
            "device_days",
            json!([{ "day": "2026-09-02", "bmr_kcal": 5001.0, "bmr_origin": "com.fitbit" }]),
        ),
        ("device_sessions", json!([workout, workout])),
        ("device_sessions", {
            let mut s = workout.clone();
            s["kcal"] = json!(5001);
            json!([s])
        }),
        (
            "workout_tombstones",
            json!([{ "key": "k" }, { "key": "k" }]),
        ),
        ("workout_tombstones", json!([{ "key": "a/b" }])),
        ("workout_tombstones", Value::Array(many)),
        (
            "activities",
            json!([
                session("uid-0001", json!("k"), "hand"),
                session("uid-0002", json!("k"), "health_connect")
            ]),
        ),
        (
            "activities",
            json!([session("uid-0001", Value::Null, "health_connect")]),
        ),
    ] {
        let mut bad = bare("Bad");
        bad[field] = list;
        let (status, res) = import(&app, &bad).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{field}: {res}");
        assert_eq!(res["field"], field, "{res}");
    }
    // A day with resting energy only is a stored day: it restores.
    let mut resting = bare("Resting");
    resting["device_days"] =
        json!([{ "day": "2026-09-02", "bmr_kcal": 1650.0, "bmr_origin": "com.fitbit" }]);
    let (status, p) = import(&app, &resting).await;
    assert_eq!(status, StatusCode::CREATED, "{p}");
    let (_, file) = export(&app, p["id"].as_i64().unwrap()).await;
    assert_eq!(
        (
            &file["device_days"][0]["bmr_kcal"],
            &file["device_days"][0]["bmr_origin"]
        ),
        (&json!(1650.0), &json!("com.fitbit"))
    );
}

/// `file` with `check_ins`, imported into a fresh app: the status and body.
async fn import_check_ins(check_ins: Value) -> (StatusCode, Value) {
    let mut file = bare("Checked");
    file["check_ins"] = check_ins;
    import(&app(), &file).await
}

#[tokio::test]
async fn export_round_trips_check_ins() {
    let source = app();
    ok(
        &source,
        "PUT",
        &format!("/api/profiles/1/check-ins/{DAY}"),
        json!({ "mood": 4, "energy": 3, "stress": 2, "tags": ["travel"] }),
    )
    .await;
    ok(
        &source,
        "PUT",
        "/api/profiles/1/check-ins/2026-10-01",
        json!({ "tags": ["sick", "poor sleep"] }),
    )
    .await;
    let (_, mut file) = export(&source, 1).await;
    assert_eq!(
        file["check_ins"],
        json!([
            { "day": "2026-10-01", "mood": null, "energy": null, "stress": null,
              "tags": ["sick", "poor sleep"] },
            { "day": DAY, "mood": 4, "energy": 3, "stress": 2, "tags": ["travel"] },
        ])
    );
    let target = app();
    file["profile"]["name"] = json!("Moved");
    let (status, profile) = import(&target, &file).await;
    assert_eq!(status, StatusCode::CREATED, "{profile}");
    let pid = profile["id"].as_i64().unwrap();
    assert_eq!(
        get_ok(&target, &format!("/api/profiles/{pid}/check-ins")).await,
        file["check_ins"]
    );
    assert_eq!(
        get_ok(&target, &format!("/api/profiles/{pid}/day/{DAY}")).await["check_in"]["mood"],
        4
    );
}

#[tokio::test]
async fn import_without_check_ins_still_works() {
    let app = app();
    let (status, profile) = import(&app, &bare("Older")).await;
    assert_eq!(status, StatusCode::CREATED, "{profile}");
    let list = get_ok(&app, &format!("/api/profiles/{}/check-ins", profile["id"])).await;
    assert_eq!(list, json!([]));
}

#[tokio::test]
async fn import_rejects_a_check_in_day_twice() {
    let (status, res) = import_check_ins(json!([
        { "day": DAY, "mood": 3 },
        { "day": DAY, "stress": 2 },
    ]))
    .await;
    assert_eq!(
        (status, &res["field"]),
        (StatusCode::BAD_REQUEST, &json!("check_ins")),
        "{res}"
    );
}

#[tokio::test]
async fn import_rejects_an_empty_check_in() {
    for c in [
        json!({ "day": DAY }),
        json!({ "day": DAY, "tags": [] }),
        json!({ "day": DAY, "mood": 6 }),
        json!({ "day": "2999-01-01", "mood": 3 }),
        json!({ "day": DAY, "tags": ["x".repeat(31)] }),
    ] {
        let (status, res) = import_check_ins(json!([c])).await;
        assert_eq!(
            (status, &res["field"]),
            (StatusCode::BAD_REQUEST, &json!("check_ins")),
            "{c}: {res}"
        );
    }
}

#[tokio::test]
async fn import_normalises_check_in_tags() {
    let app = app();
    let mut file = bare("Tagged");
    file["check_ins"] = json!([{ "day": DAY, "tags": [" Travel ", "travel", "Poor  Sleep"] }]);
    let (status, profile) = import(&app, &file).await;
    assert_eq!(status, StatusCode::CREATED, "{profile}");
    let list = get_ok(&app, &format!("/api/profiles/{}/check-ins", profile["id"])).await;
    assert_eq!(list[0]["tags"], json!(["travel", "poor sleep"]));
}

#[tokio::test]
async fn a_2500_kcal_day_imports() {
    // The per-100 caps guard new foods, never history a file carries:
    // entries and day totals far over them import as they are.
    let app = app();
    let mut file = bare("History");
    file["day_totals"] = json!([{ "day": HISTORY_DAY, "group": "Dinner",
                                  "nutrients": { "energy": 2500.0, "protein": 150.0 } }]);
    file["foods"] = json!([{ "ref": "f", "name": "Lard", "source": "custom",
                             "per100": { "energy": 900.0, "fat": 100.0 } }]);
    file["entries"] = json!([{ "uid": "entry-big-0001", "day": DAY, "group": "Eaten", "kind": "food",
        "food": "f", "name": "Lard", "grams": 300.0, "amount": "300 g",
        "nutrients": { "energy": 2700.0, "fat": 300.0 }, "created_at": "2026-10-06T10:00:00Z" }]);
    let (status, p) = import(&app, &file).await;
    assert_eq!(status, StatusCode::CREATED, "{p}");
    let pid = p["id"].as_i64().unwrap();
    let day = get_ok(&app, &format!("/api/profiles/{pid}/day/{DAY}")).await;
    assert_eq!(day["eaten"]["energy"], 2700.0);
    let old = get_ok(&app, &format!("/api/profiles/{pid}/day/{HISTORY_DAY}")).await;
    assert_eq!(old["eaten"]["energy"], 2500.0);
}

// ------------------------------------------------------------- restore

async fn import_restore(app: &Router, file: &Value) -> (StatusCode, Value) {
    call(
        app,
        "POST",
        "/api/profiles/import?restore=true",
        Some(file.clone()),
    )
    .await
}

/// Profile 1's rest beyond [`populate`]: a workout it planned and did, a
/// water food, a tracker with a goal, a categorised food, the "ask" mode,
/// a check-in and Health Connect activity with a dismissed workout.
async fn populate_rest(app: &Router) {
    let water = create_food(app, "Water", json!({ "water": 100.0 })).await;
    ok(
        app,
        "PUT",
        "/api/profiles/1/water-food",
        json!({ "food_id": water }),
    )
    .await;
    let fruit = ok(
        app,
        "POST",
        "/api/foods",
        json!({ "name": "Apple", "category": "fruit_veg", "per100": { "energy": 52.0 } }),
    )
    .await;
    ok(
        app,
        "POST",
        "/api/profiles/1/foods/favorites",
        json!({ "food_id": fruit["id"] }),
    )
    .await;
    let pull = exercise_id(app, "Pull-up").await;
    let plank = exercise_id(app, "Plank").await;
    let workout = ok(
        app,
        "POST",
        "/api/workouts",
        json!({ "name": "Upper", "kcal": 150, "notes": "Warm up first.\nShoulders down.",
            "steps": [
            { "kind": "exercise", "exercise_id": pull, "reps": 5, "kg": 5.0 },
            { "kind": "rest", "seconds": 60 },
            { "kind": "repeat", "name": "Core", "times": 2, "every": 90, "steps": [
                { "kind": "note", "name": "Cue", "text": "Hips level." },
                { "kind": "exercise", "exercise_id": plank, "seconds": 45 },
                { "kind": "note", "name": "Breathe out" }] }] }),
    )
    .await;
    ok(
        app,
        "POST",
        "/api/profiles/1/plans",
        json!({ "day": "2026-10-08", "workout_id": workout["id"], "uid": "plan-0001" }),
    )
    .await;
    ok(
        app,
        "POST",
        "/api/profiles/1/activities",
        json!({ "day": "2026-10-05", "workout_id": workout["id"], "name": "Upper",
                "minutes": 20, "uid": "session-0002",
                "sets": [{ "exercise_id": pull, "reps": 5, "kg": 5.0 }] }),
    )
    .await;
    ok(
        app,
        "POST",
        "/api/profiles/1/habits",
        json!({ "name": "Stretching", "unit": "minutes", "goal_value": 10, "goal_dir": "at_least" }),
    )
    .await;
    populate_health(app).await;
    ok(
        app,
        "PUT",
        &format!("/api/profiles/1/check-ins/{DAY}"),
        json!({ "mood": 4, "tags": ["travel"] }),
    )
    .await;
    for (id, pref) in [
        (
            "low-fibre",
            json!({ "state": "hidden", "until": "2026-11-01" }),
        ),
        ("protein-streak", json!({ "state": "pinned" })),
    ] {
        ok(
            app,
            "PUT",
            &format!("/api/profiles/1/insights/prefs/{id}"),
            pref,
        )
        .await;
    }
}

/// Profile 1's Health Connect activity in "ask" mode with a dismissed
/// workout, and an imported day.
async fn populate_health(app: &Router) {
    let hc = "/api/profiles/1/sync/health";
    ok(
        app,
        "PUT",
        &format!("{hc}/workouts"),
        json!({ "mode": "ask" }),
    )
    .await;
    // A night with a deep span and a nap, kept raw: the server makes them.
    hc_records(
        app,
        1,
        json!([
            hc_sleep(
                "s-1",
                "2026-09-01T21:00:00Z",
                "2026-09-02T05:00:00Z",
                &[("2026-09-01T21:00:00Z", "2026-09-01T22:30:00Z", 5)]
            ),
            hc_sleep("nap-1", "2026-09-02T12:00:00Z", "2026-09-02T12:40:00Z", &[]),
        ]),
    )
    .await;
    ok(
        app,
        "POST",
        hc,
        json!({ "from": "2026-09-01", "to": "2026-09-07", "device": "Pixel 9",
                "days": [{ "day": "2026-09-02", "steps": 9120, "avg_hr": 68 }],
                "sessions": [{ "key": "hc-2", "day": "2026-09-03",
                    "start_at": "2026-09-03T08:00:00Z", "end_at": "2026-09-03T08:30:00Z",
                    "type": 53, "name": "Walking", "kcal": 90, "avg_hr": 101, "max_hr": 122 }],
                "body": [{ "key": "w-1", "day": "2026-09-04", "at": "2026-09-04T06:00:00Z",
                    "kg": 72.1, "body_fat": 21.0, "lbm_kg": 57.0, "bone_kg": 2.9, "bmr_kcal": 1500 }] }),
    )
    .await;
    let (status, _) = call(app, "DELETE", &format!("{hc}/workouts/hc-2"), None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    ok(
        app,
        "POST",
        "/api/profiles/1/import/google-health",
        json!({ "files": [{ "name": "daily_resting_heart_rate.csv",
            "text": "timestamp,beats per minute\n2026-09-04T00:00:00Z,55\n" }] }),
    )
    .await;
}

/// Profile 1's daily item, with a skip.
async fn populate_daily(app: &Router) {
    let shake = create_food(app, "Shake", json!({ "energy": 400.0 })).await;
    let made = log_entry(app, "Eaten", shake, 30.0).await;
    let made = ok(
        app,
        "PATCH",
        &format!("/api/profiles/1/entries/{}", made["id"]),
        json!({ "repeat": { "start": DAY } }),
    )
    .await;
    let skip = format!(
        "/api/profiles/1/entries/daily-{}-2026-10-07",
        made["repeat"]["id"]
    );
    let (status, _) = call(app, "DELETE", &skip, None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
}

/// A source with one of everything on profile 1, and a second profile so
/// 1 can be deleted.
async fn everything() -> Router {
    let app = source_app();
    populate(&app).await;
    populate_rest(&app).await;
    populate_daily(&app).await;
    ok(
        &app,
        "POST",
        "/api/profiles",
        json!({ "name": "Other", "sex": null, "birth_date": null, "height_cm": null,
                "activity": null, "goal_kg_per_week": 0.0 }),
    )
    .await;
    app
}

async fn delete_profile(app: &Router, pid: i64) {
    let (status, res) = call(app, "DELETE", &format!("/api/profiles/{pid}"), None).await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{res}");
}

#[tokio::test]
async fn round_trip_is_lossless_for_every_exported_column() {
    let app = everything().await;
    let (_, file) = export(&app, 1).await;
    // Every list and value the file has is filled here, so the comparison
    // below covers each (a new one fails until `populate_rest` fills it).
    for (key, value) in file.as_object().unwrap() {
        let empty = value.is_null() || value.as_array().is_some_and(Vec::is_empty);
        assert!(!empty, "{key} is empty: fill it in populate_rest");
    }
    // A workout's notes and note blocks travel with it.
    let upper = file["workouts"][0].clone();
    assert_eq!(upper["notes"], "Warm up first.\nShoulders down.", "{upper}");
    assert_eq!(
        upper["steps"][2]["steps"][0],
        json!({ "kind": "note", "name": "Cue", "text": "Hips level." })
    );
    // A name alone is a note, text-less in the file too.
    assert_eq!(
        upper["steps"][2]["steps"][2],
        json!({ "kind": "note", "name": "Breathe out" })
    );
    let before = snapshot(&app, 1).await;
    delete_profile(&app, 1).await;
    let (status, profile) = import_restore(&app, &file).await;
    assert_eq!(status, StatusCode::CREATED, "{profile}");
    assert_eq!(profile["id"], 1);
    let (_, again) = export(&app, 1).await;
    let without_time = |mut f: Value| {
        f.as_object_mut().unwrap().remove("exported_at");
        f
    };
    assert_eq!(without_time(again), without_time(file.clone()));
    assert_eq!(snapshot(&app, 1).await, before);

    // An instance without the workout makes it, notes and all.
    let target = super::app();
    let mut moved = file;
    moved["profile"]["name"] = json!("Moved");
    let (status, moved) = import(&target, &moved).await;
    assert_eq!(status, StatusCode::CREATED, "{moved}");
    let workouts = get_ok(&target, "/api/workouts").await;
    let made = workouts
        .as_array()
        .unwrap()
        .iter()
        .find(|w| w["name"] == "Upper")
        .unwrap();
    assert_eq!(made["notes"], upper["notes"], "{made}");
    assert_eq!(made["steps"][2]["steps"][0]["kind"], "note", "{made}");
    assert_eq!(
        made["steps"][2]["steps"][2], upper["steps"][2]["steps"][2],
        "{made}"
    );
}

#[tokio::test]
async fn restore_keeps_the_id_binding_and_water_food() {
    let app = everything().await;
    let (_, file) = export(&app, 1).await;
    let water = get_ok(&app, "/api/profiles/1/water-food").await;
    delete_profile(&app, 1).await;
    let (status, profile) = import_restore(&app, &file).await;
    assert_eq!(status, StatusCode::CREATED, "{profile}");
    assert_eq!(profile["id"], 1, "the webhook and phone URLs still work");
    let scale = get_ok(&app, "/api/profiles/1/sync/openscale").await;
    assert_eq!(scale["bound_user"], json!({ "id": 1, "username": "Alex" }));
    assert_eq!(get_ok(&app, "/api/profiles/1/water-food").await, water);
    assert_eq!(water["chosen"], true, "{water}");
    let health = get_ok(&app, "/api/profiles/1/sync/health").await;
    assert_eq!(health["workouts"], "ask");
    let plans = get_ok(&app, "/api/profiles/1/plans").await;
    assert_eq!(plans[0]["name"], "Upper", "{plans}");

    // The id taken again (another restore of the same file under a new
    // name): a new id, still bound.
    let mut again = file.clone();
    again["profile"]["name"] = json!("Restored twice");
    let (status, second) = import_restore(&app, &again).await;
    assert_eq!(status, StatusCode::CREATED, "{second}");
    assert_ne!(second["id"], 1);
}

#[tokio::test]
async fn ui_import_never_reuses_an_id() {
    let app = everything().await;
    let (_, file) = export(&app, 1).await;
    delete_profile(&app, 1).await;
    let (status, profile) = import(&app, &file).await;
    assert_eq!(status, StatusCode::CREATED, "{profile}");
    assert_ne!(profile["id"], 1);
    let scale = get_ok(
        &app,
        &format!("/api/profiles/{}/sync/openscale", profile["id"]),
    )
    .await;
    assert_eq!(
        scale["bound_user"],
        Value::Null,
        "not a restore: no binding"
    );
    // Everything else came along: the export reads the same.
    let (_, copy) = export(&app, profile["id"].as_i64().unwrap()).await;
    assert_eq!(comparable(copy), comparable(file));
}

#[tokio::test]
async fn import_rejects_a_newer_version_before_reading_the_rest() {
    let app = app();
    // The rest is no shape at all: only the header is read before the
    // version refuses it.
    let body = r#"{"format":"kaloriina-profile","version":4,"profile":7,"entries":{"x":[1,2]}}"#;
    let (status, res) = raw(
        &app,
        "POST",
        "/api/profiles/import",
        "application/json",
        body,
    )
    .await;
    assert_eq!(
        (status, &res["field"]),
        (StatusCode::BAD_REQUEST, &json!("version")),
        "{res}"
    );
    let (status, res) = raw(
        &app,
        "POST",
        "/api/profiles/import",
        "application/json",
        "[1",
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{res}");
    assert_eq!(res["code"], "invalid");
    let (status, res) = raw(&app, "POST", "/api/profiles/import", "text/plain", "{}").await;
    assert_eq!(status, StatusCode::UNSUPPORTED_MEDIA_TYPE, "{res}");
}

#[tokio::test]
async fn bad_refs_in_plans_workouts_and_water_food_are_refused() {
    let app = app();
    let step = json!({ "kind": "exercise", "exercise": "x", "reps": 5 });
    let ex = json!([{ "ref": "x", "name": "Pull-up", "measure": "reps" }]);
    let workout = json!({ "ref": "w", "name": "W", "steps": [step] });
    for (field, patch) in [
        ("water_food", json!({ "water_food": "nope" })),
        ("workouts", json!({ "workouts": [workout] })),
        (
            "workouts",
            json!({ "exercises": ex, "workouts": [workout, workout] }),
        ),
        (
            "workouts",
            json!({ "exercises": ex, "workouts": [{ "ref": "w", "name": "W", "steps": [] }] }),
        ),
        (
            "plans",
            json!({ "plans": [{ "day": DAY, "workout": "w" }] }),
        ),
        (
            "plans",
            json!({ "exercises": ex, "workouts": [workout],
                    "plans": [{ "day": DAY, "workout": "w", "uid": "plan-0001" },
                              { "day": DAY, "workout": "w", "uid": "plan-0001" }] }),
        ),
        (
            "activities",
            json!({ "activities": [{ "uid": "session-0009", "day": DAY, "name": "S",
                                   "minutes": 5, "workout": "w" }] }),
        ),
        (
            "weights",
            json!({ "weights": [{ "day": DAY, "kg": 70.0, "set_at": -1 }] }),
        ),
        (
            "foods",
            json!({ "foods": [{ "ref": "f", "name": "F", "source": "custom",
                                "category": "candy" }] }),
        ),
    ] {
        let mut bad = bare("Bad");
        bad.as_object_mut()
            .unwrap()
            .extend(patch.as_object().unwrap().clone());
        let (status, res) = import(&app, &bad).await;
        assert_eq!(
            (status, &res["field"]),
            (StatusCode::BAD_REQUEST, &json!(field)),
            "{patch}: {res}"
        );
    }
}

#[tokio::test]
async fn export_carries_goal_and_notes_only_where_they_belong() {
    let app = app();
    let (status, _) =
        put_targets(&app, 1, json!([{ "metric": "goal_weight", "value": 64.5 }])).await;
    assert_eq!(status, StatusCode::OK);
    let (_, r) = porridge(&app, json!("Boil.\nEat.")).await;
    // A recipe the profile favours travels with the export.
    let (status, _) = call(
        &app,
        "POST",
        "/api/profiles/1/foods/favorites",
        Some(json!({ "food_id": r["id"] })),
    )
    .await;
    assert!(status.is_success());
    let (status, file) = call(&app, "GET", "/api/profiles/1/export", None).await;
    assert_eq!(status, StatusCode::OK, "{file}");
    assert_eq!(
        file["targets"],
        json!([{ "metric": "goal_weight", "value": 64.5 }]),
        "a target"
    );
    assert!(file["profile"].get("goal_weight_kg").is_none());
    let foods = file["foods"].as_array().unwrap();
    let porridge = foods.iter().find(|f| f["name"] == "Porridge").unwrap();
    assert_eq!(porridge["notes"], "Boil.\nEat.");
    let oats = foods.iter().find(|f| f["name"] == "Oats").unwrap();
    assert!(oats.get("notes").is_none(), "left out when none");

    // A copy imports with both.
    let mut copy = file.clone();
    copy["profile"]["name"] = json!("Copy");
    let (status, p) = call(&app, "POST", "/api/profiles/import", Some(copy.clone())).await;
    assert_eq!(status, StatusCode::CREATED, "{p}");
    assert_eq!(goal_weight(&app, &p["id"]).await, 64.5);

    // Only a recipe has notes.
    let mut bad = copy.clone();
    bad["profile"]["name"] = json!("Bad");
    for f in bad["foods"].as_array_mut().unwrap() {
        if f["name"] == "Oats" {
            f["notes"] = json!("Pour.");
        }
    }
    let (status, e) = call(&app, "POST", "/api/profiles/import", Some(bad)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{e}");
    assert_eq!(e["field"], "foods");
}

#[tokio::test]
async fn creatine_travels_and_matches_the_seeded_food() {
    let seeded = |foods: &Value| -> Vec<i64> {
        foods
            .as_array()
            .unwrap()
            .iter()
            .filter(|f| f["name"] == "Creatine monohydrate")
            .map(|f| f["id"].as_i64().unwrap())
            .collect()
    };
    let source = app();
    let tub = seeded(&get_ok(&source, "/api/profiles/1/foods?q=creatine").await)[0];
    log_entry_on(&source, DAY, "Eaten", tub, 3.0).await;
    let (_, mut file) = export(&source, 1).await;
    file["profile"]["name"] = json!("Moved");

    let target = app();
    let (status, profile) = import(&target, &file).await;
    assert_eq!(status, StatusCode::CREATED, "{profile}");
    let pid = profile["id"].as_i64().unwrap();

    let there = seeded(&get_ok(&target, &format!("/api/profiles/{pid}/foods?q=creatine")).await);
    assert_eq!(there.len(), 1, "no duplicate: {there:?}");
    let day = get_ok(&target, &format!("/api/profiles/{pid}/day/{DAY}")).await;
    let entry = &group(&day, "Eaten")["entries"][0];
    assert_eq!(entry["food_id"], there[0], "{entry}");
    assert_eq!(entry["nutrients"]["creatine"], 3.0, "{entry}");
}

#[tokio::test]
async fn a_recipe_items_serving_travels_and_old_files_still_import() {
    let source = app();
    let tablet = ok(
        &source,
        "POST",
        "/api/foods",
        json!({ "name": "Monivitamiini", "per100": { "energy": 20.0 },
                "servings": [{ "label": "poretabletti", "grams": 4.3 }] }),
    )
    .await;
    let drink = ok(
        &source,
        "POST",
        "/api/recipes",
        json!({ "name": "Drink", "cooked_g": null,
                "items": [{ "food_id": tablet["id"], "serving": "poretabletti", "quantity": 2 }] }),
    )
    .await;
    log_entry_on(&source, DAY, "Eaten", drink["id"].as_i64().unwrap(), 8.6).await;
    let (_, mut file) = export(&source, 1).await;
    let exported = file["foods"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["name"] == "Drink")
        .unwrap()["items"][0]
        .clone();
    assert_eq!(
        (
            &exported["grams"],
            &exported["serving"],
            &exported["quantity"]
        ),
        (&json!(8.6), &json!("poretabletti"), &json!(2.0)),
        "{exported}"
    );
    file["profile"]["name"] = json!("Moved");

    // The new fields travel; a file without them still imports, as grams.
    let mut old = file.clone();
    for f in old["foods"].as_array_mut().unwrap() {
        for i in f["items"].as_array_mut().unwrap() {
            let i = i.as_object_mut().unwrap();
            i.remove("serving");
            i.remove("quantity");
        }
    }
    for (file, serving) in [(&file, json!("poretabletti")), (&old, Value::Null)] {
        let target = app();
        let (status, profile) = import(&target, file).await;
        assert_eq!(status, StatusCode::CREATED, "{profile}");
        let pid = profile["id"].as_i64().unwrap();
        let day = get_ok(&target, &format!("/api/profiles/{pid}/day/{DAY}")).await;
        let id = group(&day, "Eaten")["entries"][0]["food_id"].clone();
        let recipe = get_ok(&target, &format!("/api/recipes/{id}")).await;
        let i = &recipe["items"][0];
        assert_eq!((&i["grams"], &i["serving"]), (&json!(8.6), &serving), "{i}");
    }
}

#[tokio::test]
async fn food_basis_exports_and_imports() {
    let source = app();
    let burger = ok(
        &source,
        "POST",
        "/api/foods",
        json!({ "name": "Burger", "per100": { "energy": 540.0 * 100.0 / 210.0 },
                "servings": [{ "label": "Burger", "grams": 210 }],
                "basis": { "serving": "Burger", "estimated": true } }),
    )
    .await;
    let oats = create_food(&source, "Oats", json!({ "energy": 380 })).await;
    log_entry_on(&source, DAY, "Eaten", burger["id"].as_i64().unwrap(), 210.0).await;
    log_entry_on(&source, DAY, "Eaten", oats, 50.0).await;
    let (_, mut file) = export(&source, 1).await;
    let food = |file: &Value, name: &str| {
        file["foods"]
            .as_array()
            .unwrap()
            .iter()
            .find(|f| f["name"] == name)
            .unwrap()
            .clone()
    };
    assert_eq!(
        food(&file, "Burger")["basis"],
        json!({ "serving": "Burger", "estimated": true })
    );
    assert!(food(&file, "Oats").get("basis").is_none(), "only when set");
    file["profile"]["name"] = json!("Moved");

    let mut old = file.clone();
    for f in old["foods"].as_array_mut().unwrap() {
        f.as_object_mut().unwrap().remove("basis");
    }
    for (file, basis) in [
        (&file, json!({ "serving": "Burger", "estimated": true })),
        (&old, Value::Null),
    ] {
        let target = app();
        let (status, profile) = import(&target, file).await;
        assert_eq!(status, StatusCode::CREATED, "{profile}");
        let pid = profile["id"].as_i64().unwrap();
        let day = get_ok(&target, &format!("/api/profiles/{pid}/day/{DAY}")).await;
        let id = group(&day, "Eaten")["entries"][0]["food_id"].clone();
        let read = get_ok(&target, &format!("/api/foods/{id}")).await;
        assert_eq!((&read["name"], &read["basis"]), (&json!("Burger"), &basis));
    }

    // A basis naming no serving of its food is refused.
    let mut dangling = file;
    for f in dangling["foods"].as_array_mut().unwrap() {
        if f["name"] == "Burger" {
            f["basis"]["serving"] = json!("Slice");
        }
    }
    let target = app();
    let (status, err) = import(&target, &dangling).await;
    assert_eq!(
        (status, &err["field"]),
        (StatusCode::BAD_REQUEST, &json!("foods")),
        "{err}"
    );
}

#[tokio::test]
async fn daily_items_travel_with_skips_and_links() {
    let source = app();
    let shake = create_food(&source, "Shake", json!({ "energy": 400.0 })).await;
    let made = log_entry(&source, "Eaten", shake, 30.0).await;
    let made = ok(
        &source,
        "PATCH",
        &format!("/api/profiles/1/entries/{}", made["id"]),
        json!({ "repeat": { "start": DAY } }),
    )
    .await;
    let item = made["repeat"]["id"].clone();
    let skip = format!("/api/profiles/1/entries/daily-{item}-2026-10-08");
    let (status, _) = call(&source, "DELETE", &skip, None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    ok(
        &source,
        "POST",
        "/api/profiles/1/entries",
        json!({ "uid": format!("daily-{item}-2026-10-07"), "day": "2026-10-07",
                "group": "Eaten", "repeat_of": item }),
    )
    .await;
    let due = get_ok(&source, "/api/profiles/1/day/2026-10-09").await;
    let created_at = group(&due, "Planned")["entries"][0]["created_at"].clone();
    let (_, file) = export(&source, 1).await;
    // File-local refs by position, so a restore exports the same file.
    assert_eq!(
        file["daily_items"],
        json!([{ "ref": "1", "food": shake.to_string(), "grams": 30.0, "serving": null,
                 "quantity": null, "start": DAY, "created_at": created_at,
                 "skips": ["2026-10-08"] }])
    );
    let linked: Vec<&Value> = file["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| &e["repeat"])
        .collect();
    assert_eq!(linked, [&json!("1"), &json!("1")]);
    assert!(
        file["entries"]
            .as_array()
            .unwrap()
            .iter()
            .all(|e| e.get("imported").is_none() && e.get("daily_item").is_none()),
        "{file}"
    );

    let target = app();
    let mut file = file;
    file["profile"]["name"] = json!("Moved");
    let (status, profile) = import(&target, &file).await;
    assert_eq!(status, StatusCode::CREATED, "{profile}");
    let p = format!("/api/profiles/{}", profile["id"]);
    let due = |d: Value| group(&d, "Planned")["entries"].as_array().unwrap().len();
    let ticked = get_ok(&target, &format!("{p}/day/2026-10-07")).await;
    let id = group(&ticked, "Eaten")["entries"][0]["repeat"]["id"].clone();
    assert!(id.is_i64(), "{ticked}");
    assert_eq!(due(ticked), 0);
    assert_eq!(
        due(get_ok(&target, &format!("{p}/day/2026-10-08")).await),
        0
    );
    let later = get_ok(&target, &format!("{p}/day/2026-10-09")).await;
    assert_eq!(group(&later, "Planned")["entries"][0]["repeat"]["id"], id);

    // A file without daily items imports as before.
    let mut old = file.clone();
    old.as_object_mut().unwrap().remove("daily_items");
    for e in old["entries"].as_array_mut().unwrap() {
        e.as_object_mut().unwrap().remove("repeat");
    }
    old["profile"]["name"] = json!("Old");
    let (status, res) = import(&target, &old).await;
    assert_eq!(status, StatusCode::CREATED, "{res}");
    // A ref to no item is refused.
    let mut dangling = file;
    dangling["profile"]["name"] = json!("Dangling");
    dangling["entries"][0]["repeat"] = json!("7");
    let (status, err) = import(&target, &dangling).await;
    assert_eq!(
        (status, &err["field"]),
        (StatusCode::BAD_REQUEST, &json!("entries")),
        "{err}"
    );
}

/// The workouts here named `name`.
async fn workouts_named(app: &Router, name: &str) -> Vec<Value> {
    get_ok(app, "/api/workouts")
        .await
        .as_array()
        .unwrap()
        .iter()
        .filter(|w| w["name"] == name)
        .cloned()
        .collect()
}

#[tokio::test]
async fn a_workout_differing_only_in_notes_is_its_own() {
    let app = everything().await;
    let (_, file) = export(&app, 1).await;
    // The same file again binds to the workout here: nothing new.
    let mut same = file.clone();
    same["profile"]["name"] = json!("Same");
    let (status, res) = import(&app, &same).await;
    assert_eq!(status, StatusCode::CREATED, "{res}");
    assert_eq!(workouts_named(&app, "Upper").await.len(), 1);

    // Its notes differ: the file's workout comes in as its own, notes kept,
    // and the copy's plan names it; the one here keeps its notes.
    let mut edited = file;
    edited["profile"]["name"] = json!("Edited");
    edited["workouts"][0]["notes"] = json!("Other notes.");
    let (status, copy) = import(&app, &edited).await;
    assert_eq!(status, StatusCode::CREATED, "{copy}");
    let uppers = workouts_named(&app, "Upper").await;
    let notes: BTreeSet<&str> = uppers
        .iter()
        .map(|w| w["notes"].as_str().unwrap())
        .collect();
    assert_eq!(
        notes,
        BTreeSet::from(["Warm up first.\nShoulders down.", "Other notes."]),
        "{uppers:?}"
    );
    let theirs = uppers
        .iter()
        .find(|w| w["notes"] == "Other notes.")
        .unwrap();
    let plans = get_ok(&app, &format!("/api/profiles/{}/plans", copy["id"])).await;
    assert_eq!(plans[0]["workout_id"], theirs["id"], "{plans}");
}

#[tokio::test]
async fn an_active_file_workout_never_binds_an_archived_one() {
    let app = everything().await;
    let (_, mut file) = export(&app, 1).await;
    let mut upper = workouts_named(&app, "Upper").await.remove(0);
    upper["archived"] = json!(true);
    let id = upper["id"].clone();
    ok(&app, "PUT", &format!("/api/workouts/{id}"), upper).await;
    file["profile"]["name"] = json!("Copy");
    let (status, copy) = import(&app, &file).await;
    assert_eq!(status, StatusCode::CREATED, "{copy}");
    let uppers = workouts_named(&app, "Upper").await;
    assert_eq!(uppers.len(), 2, "{uppers:?}");
    let active = uppers.iter().find(|w| w["archived"] == false).unwrap();
    assert_ne!(active["id"], id);
    let plans = get_ok(&app, &format!("/api/profiles/{}/plans", copy["id"])).await;
    assert_eq!(plans[0]["workout_id"], active["id"], "{plans}");
}

#[tokio::test]
async fn two_ticks_for_one_item_day_are_400() {
    let app = app();
    let mut file = bare("Twice");
    file["foods"] = json!([{ "ref": "1", "name": "Shake", "source": "custom",
                            "per100": { "energy": 400.0 } }]);
    file["daily_items"] = json!([{ "ref": "1", "food": "1", "grams": 30.0, "start": DAY }]);
    let tick = |uid: &str| {
        json!({ "uid": uid, "day": DAY, "group": "Eaten", "food": "1", "name": "Shake",
                "grams": 30.0, "amount": "30 g", "nutrients": { "energy": 120.0 },
                "created_at": "2026-10-06T10:00:00Z", "repeat": "1" })
    };
    file["entries"] = json!([tick("tick-0000001"), tick("tick-0000002")]);
    let (status, err) = import(&app, &file).await;
    assert_eq!(
        (status, &err["field"]),
        (StatusCode::BAD_REQUEST, &json!("entries")),
        "{err}"
    );
}

#[tokio::test]
async fn imported_without_group_is_400() {
    let app = app();
    let history = |extra: Value| {
        let mut e = json!({ "uid": "entry-hist-0001", "day": HISTORY_DAY, "group": "Eaten",
                            "name": "Pizza", "amount": "1 slice",
                            "created_at": "2026-10-06T10:00:00Z" });
        e.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        e
    };
    let mut file = bare("Gap");
    file["entries"] = json!([history(json!({ "imported": true }))]);
    let (status, err) = import(&app, &file).await;
    assert_eq!(
        (status, &err["field"]),
        (StatusCode::BAD_REQUEST, &json!("entries")),
        "{err}"
    );
    // With its group it's history; the flag itself is no longer read.
    for (name, extra) in [
        ("Flagged", json!({ "imported": true, "src_group": "Eaten" })),
        ("Grouped", json!({ "src_group": "Eaten" })),
    ] {
        let mut file = bare(name);
        file["entries"] = json!([history(extra)]);
        let (status, p) = import(&app, &file).await;
        assert_eq!(status, StatusCode::CREATED, "{name}: {p}");
        let (_, out) = export(&app, p["id"].as_i64().unwrap()).await;
        assert_eq!(out["entries"][0]["src_group"], "Eaten", "{name}");
        assert!(out["entries"][0].get("imported").is_none(), "{name}");
    }
}

#[tokio::test]
async fn a_v2_file_is_refused() {
    // v3 renamed keys a v2 file has (`activity_imports`, `kcal_total`): read
    // as v3, its import days would go missing without a word.
    let mut v2 = bare("Old");
    v2["version"] = json!(2);
    v2["activity_imports"] = json!([{ "day": "2026-09-02", "steps": 100 }]);
    let (status, res) = import(&app(), &v2).await;
    assert_eq!(
        (status, &res["field"]),
        (StatusCode::BAD_REQUEST, &json!("version")),
        "{res}"
    );
    assert!(
        res["error"]
            .as_str()
            .unwrap()
            .contains("export the profile again"),
        "{res}"
    );
}

/// The file format, pinned: `tests/fixtures/export-v3.json` has
/// every section filled. Imported and exported again it is the same file,
/// so a field the writer adds, drops or renames fails here.
/// `KALORIINA_BLESS=1` writes it from [`everything`] instead, for a change
/// meant to move the format (with the version bumped when old files would
/// read wrong).
#[tokio::test]
async fn the_golden_file_round_trips() {
    let path = FsPath::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/export-v3.json");
    let normalised = |mut f: Value| {
        f["exported_at"] = json!("2026-10-17T00:00:00Z");
        f
    };
    if std::env::var_os("KALORIINA_BLESS").is_some() {
        let (_, mut file) = export(&everything().await, 1).await;
        // Written as a fresh instance exports it, so its refs are that
        // instance's ids.
        file["profile"]["name"] = json!("Golden");
        // Values no API writes yet, so the file pins them too.
        file["device_days"][0]["bmr_kcal"] = json!(1650.5);
        file["device_days"][0]["bmr_origin"] = json!("com.sec.android.app.shealth");
        file["device_days"][0]["distance_m"] = json!(6100);
        file["device_sessions"][0]["total_kcal"] = json!(140);
        let fresh = super::app();
        let (status, made) = import_restore(&fresh, &file).await;
        assert_eq!(status, StatusCode::CREATED, "{made}");
        let (_, file) = export(&fresh, made["id"].as_i64().unwrap()).await;
        let text = serde_json::to_string_pretty(&normalised(file)).unwrap() + "\n";
        std::fs::write(&path, text).unwrap();
    }
    let golden: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    for (key, value) in golden.as_object().unwrap() {
        let empty = value.is_null() || value.as_array().is_some_and(Vec::is_empty);
        assert!(!empty, "{key} is empty in the golden file");
    }
    let app = super::app();
    let (status, made) = import_restore(&app, &golden).await;
    assert_eq!(status, StatusCode::CREATED, "{made}");
    let (_, file) = export(&app, made["id"].as_i64().unwrap()).await;
    let file = normalised(file);
    for (key, value) in golden.as_object().unwrap() {
        assert_eq!(&file[key], value, "{key}");
    }
    assert_eq!(file, golden);
}

/// An import retried after its answer was lost (`?uid=`) makes
/// one profile: the same uid again answers the first, unread.
#[tokio::test]
async fn an_import_uid_makes_one_profile() {
    let app = app();
    let uri = "/api/profiles/import?uid=import-uid-0001";
    let (status, first) = call(&app, "POST", uri, Some(bare("Once"))).await;
    assert_eq!(status, StatusCode::CREATED, "{first}");
    let (status, again) = call(&app, "POST", uri, Some(bare("Once"))).await;
    assert_eq!(status, StatusCode::CREATED, "{again}");
    assert_eq!(again["id"], first["id"]);
    let names: Vec<Value> = get_ok(&app, "/api/profiles")
        .await
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["name"].clone())
        .collect();
    assert_eq!(
        names.iter().filter(|n| **n == "Once").count(),
        1,
        "{names:?}"
    );
    let (status, err) = call(
        &app,
        "POST",
        "/api/profiles/import?uid=not%20a%20uid",
        Some(bare("Bad")),
    )
    .await;
    assert_eq!(
        (status, &err["field"]),
        (StatusCode::BAD_REQUEST, &json!("uid"))
    );
}

/// Uids are local transport keys, never in the file, so a file
/// restores into the instance it came from beside what made it.
#[tokio::test]
async fn a_file_restores_into_the_instance_it_came_from() {
    let app = app();
    let food = ok(
        &app,
        "POST",
        "/api/foods",
        json!({ "name": "Oats", "per100": { "energy": 380.0 }, "uid": "food-uid-0001" }),
    )
    .await;
    ok(
        &app,
        "POST",
        "/api/profiles/1/habits",
        json!({ "name": "Snus", "unit": "pouches", "uid": "habit-uid-0001" }),
    )
    .await;
    log_entry(&app, "Eaten", food["id"].as_i64().unwrap(), 50.0).await;
    let (_, mut file) = export(&app, 1).await;
    file["profile"]["name"] = json!("Again");
    let (status, p) = import(&app, &file).await;
    assert_eq!(status, StatusCode::CREATED, "{p}");
    let (_, found) = search(&app, "q=oats").await;
    assert_eq!(found.as_array().unwrap().len(), 1, "matched, not copied");
}
