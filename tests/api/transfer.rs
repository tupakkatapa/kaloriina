//! Export and import of a whole profile.

use super::*;
use axum::body::Body;
use axum::http::{Request, header};
use common::raw;
use http_body_util::BodyExt;
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
    kaloriina::fineli::store(&mut conn, &kaloriina::fineli::read(&dir).unwrap()).unwrap();
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
                "instructions": "Simmer 5 min.\n\nStir in the milk.",
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
        let mut body = json!({ "day": DAY, "group": "Consumed" });
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
        "/api/profiles/1/sessions",
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
                            e["imported"],
                            e["created_at"]
                        ])
                    })
                    .collect();
                json!({ "name": g["name"], "totals": g["totals"], "entries": entries })
            })
            .collect();
        let sessions: Vec<Value> = d["sessions"]
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
                "activity": null, "goal_kg_per_week": 0.0 }),
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
    assert_eq!(file["version"], 1);
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

    // No Fineli here, and Oats' barcode already belongs to another food.
    let target = app();
    let taken = ok(
        &target,
        "POST",
        "/api/foods",
        json!({ "name": "Kaura", "barcode": "6410000000017", "per100": { "energy": 360.0 } }),
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
    // Fineli's food came as your own, without its Fineli id.
    let milk = food("Maito, rasvaton");
    assert_eq!(milk["source"], "custom");
    assert_eq!(milk["fineli_id"], Value::Null);
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
    assert_eq!(porridge["source"], "recipe");
    assert_eq!(porridge["makes"], 2);
    assert_eq!(
        porridge["instructions"],
        "Simmer 5 min.\n\nStir in the milk."
    );
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
        "format": "kaloriina-profile", "version": 1, "exported_at": "2026-10-08T10:00:00Z",
        "profile": { "name": name, "sex": null, "birth_date": null, "height_cm": null,
                     "activity": null, "goal_kg_per_week": 0.0 },
    })
}

fn quick(uid: &str) -> Value {
    json!({ "uid": uid, "day": DAY, "group": "Consumed", "kind": "quick", "food": null,
            "name": "Snack", "amount": "Quick add", "nutrients": { "energy": 100.0 },
            "created_at": "2026-10-06T10:00:00Z" })
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
    file["sessions"] = json!([{ "uid": "session-0002", "day": DAY, "name": "Pulls", "minutes": 5,
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
    let sessions = get_ok(&app, &format!("/api/profiles/{pid}/sessions")).await;
    assert_eq!(
        sessions[0]["sets"][0]["exercise_id"],
        exercise_id(&app, "Pull-up").await
    );
    assert_eq!(sessions[0]["sets"][0]["name"], "Pull-up");
    assert_eq!(sessions[0]["workout_id"], Value::Null);
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

    let mut v2 = bare("New");
    v2["version"] = json!(2);
    v2["entries"] = json!("a shape v1 doesn't know");
    refused(v2, StatusCode::BAD_REQUEST, "version").await;
    let mut other = bare("New");
    other["format"] = json!("something-else");
    refused(other, StatusCode::BAD_REQUEST, "format").await;

    // Duplicate uids, and malformed ones, before anything is written.
    let mut dup = bare("New");
    dup["entries"] = json!([quick("same-uid-0001"), quick("same-uid-0001")]);
    refused(dup, StatusCode::BAD_REQUEST, "entries").await;
    for uid in [
        "short",
        "has space-0001",
        "good-uid-0001:x",
        "good-uid-0001:1:2",
    ] {
        let mut bad = bare("New");
        bad["entries"] = json!([quick(uid)]);
        refused(bad, StatusCode::BAD_REQUEST, "entries").await;
    }
    // A meal item's suffix is fine. Quick adds logged before their removal
    // (`kind: quick`) still import: databases may hold them.
    let mut items = bare("Items");
    items["entries"] = json!([quick("meal-write-0001:1"), quick("meal-write-0001:2")]);
    let (status, res) = import(&app, &items).await;
    assert_eq!(status, StatusCode::CREATED, "{res}");

    let mut unknown_food = bare("New");
    let mut entry = quick("food-entry-0001");
    entry["kind"] = json!("food");
    entry["food"] = json!("nope");
    unknown_food["entries"] = json!([entry]);
    refused(unknown_food, StatusCode::BAD_REQUEST, "entries").await;
    let mut cycle = bare("New");
    cycle["foods"] = json!([
        { "ref": "a", "name": "A", "source": "recipe", "items": [{ "food": "b", "grams": 10.0 }] },
        { "ref": "b", "name": "B", "source": "recipe", "items": [{ "food": "a", "grams": 10.0 }] },
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
    late["sessions"] = json!([{ "uid": "session-0003", "day": DAY, "name": "Pulls", "minutes": 5,
                                "sets": [{ "exercise": "x", "reps": 5, "side": "left" }] }]);
    refused(late, StatusCode::BAD_REQUEST, "sessions").await;
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
        "/api/profiles/1/sessions",
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
    let (_, mut file) = export(&source, 1).await;
    assert_eq!(file["exercises"][0]["name"], "Gone move");
    assert_eq!(file["exercises"][0]["measure"], "time");

    let target = app();
    file["profile"]["name"] = json!("Moved");
    let (status, profile) = import(&target, &file).await;
    assert_eq!(status, StatusCode::CREATED, "{profile}");
    let sessions = get_ok(
        &target,
        &format!("/api/profiles/{}/sessions", profile["id"]),
    )
    .await;
    assert_eq!(sessions[0]["sets"][0]["name"], "Gone move");
    assert_eq!(
        sessions[0]["sets"][0]["exercise_id"],
        exercise_id(&target, "Gone move").await
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
                 "body_fat": 21.5, "water": null, "muscle": null }])
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
    assert!(sources.contains(&("2026-09-01", "manual")), "{sources:?}");
    assert_eq!(
        file["openscale"],
        json!({ "bound_user": 1, "bound_username": "Alex" }),
        "the binding travels, for a restore"
    );

    let mut copy = file.clone();
    copy["profile"]["name"] = json!("Copy");
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

#[tokio::test]
async fn health_connect_activity_travels_but_its_status_doesnt() {
    let app = app();
    let sessions = json!([
        { "key": "hc-1", "day": "2026-09-02", "start_at": "2026-09-02T14:02:00Z",
          "end_at": "2026-09-02T14:48:00Z", "type": 33, "name": "Running", "kcal": 410,
          "distance_m": 8200, "recording_method": 1 },
        { "key": "hc-2", "day": "2026-09-03", "start_at": "2026-09-03T08:00:00Z",
          "end_at": "2026-09-03T08:30:00Z", "type": 53, "name": "Walking", "kcal": 90,
          "distance_m": 3000, "recording_method": 2 }]);
    let days = json!([
        { "day": "2026-09-02", "active_kcal": 512, "steps": 9120, "resting_hr": 54,
          "hrv_ms": 48, "asleep_min": 440, "in_bed_min": 475, "bedtime": "23:10",
          "wake_time": "07:05", "deep_min": 70, "rem_min": 90, "light_min": 200 },
        { "day": "2026-09-03", "active_kcal": null, "steps": 100, "resting_hr": null,
          "hrv_ms": null, "asleep_min": null, "in_bed_min": null, "bedtime": null,
          "wake_time": null, "deep_min": null, "rem_min": null, "light_min": null }]);
    ok(
        &app,
        "POST",
        "/api/profiles/1/sync/health",
        json!({ "from": "2026-09-01", "to": "2026-09-07", "device": "Pixel 9",
                "days": days, "sessions": sessions }),
    )
    .await;
    // The walk the watch found by itself waits; dismissed, it's a tombstone.
    let (status, _) = call(
        &app,
        "DELETE",
        "/api/profiles/1/sync/health/workouts/hc-2",
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    ok(
        &app,
        "POST",
        "/api/profiles/1/sessions",
        json!({ "day": "2026-09-04", "name": "Swim", "minutes": 30, "type": "swim",
                "distance_m": 1000, "start_at": "2026-09-04T09:00:00+03:00",
                "uid": "swim-0001" }),
    )
    .await;
    let (_, file) = export(&app, 1).await;
    assert_eq!(
        (&file["activity_days"], &file["activity_sessions"]),
        (&days, &sessions)
    );
    let tombstones = json!([{ "key": "hc-2", "type": "walk", "start_at": "2026-09-03T08:00:00Z" }]);
    assert_eq!(file["workout_tombstones"], tombstones);
    assert!(!file.to_string().contains("Pixel 9"), "no sync status");
    let synced = r#"["Running","run",8200,"2026-09-02T14:02:00Z","health_connect","hc-1",46,410]"#;
    let logged = r#"["Swim","swim",1000,"2026-09-04T06:00:00Z","manual",null,30,null]"#;
    assert_eq!(session_shapes(&file["sessions"]), [synced, logged]);

    let mut copy = file.clone();
    copy["profile"]["name"] = json!("Copy");
    let (status, p) = import(&app, &copy).await;
    assert_eq!(status, StatusCode::CREATED, "{p}");
    let pid = &p["id"];
    let activity = get_ok(&app, &format!("/api/profiles/{pid}/activity")).await;
    assert_eq!(activity, json!({ "days": days, "sessions": sessions }));
    let health = get_ok(&app, &format!("/api/profiles/{pid}/sync/health")).await;
    assert_eq!(health["last_seen"], Value::Null, "the copy never synced");
    assert_eq!(health["workouts"], "auto", "the mode stays behind");
    let back = get_ok(&app, &format!("/api/profiles/{pid}/sessions")).await;
    assert_eq!(session_shapes(&back), [synced, logged]);
    let (_, again) = export(&app, pid.as_i64().unwrap()).await;
    assert_eq!(again["workout_tombstones"], tombstones);

    // A file from before has none, and imports.
    let (status, p) = import(&app, &bare("Older")).await;
    assert_eq!(status, StatusCode::CREATED, "{p}");
    let activity = get_ok(&app, &format!("/api/profiles/{}/activity", p["id"])).await;
    assert_eq!(activity, json!({ "days": [], "sessions": [] }));
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
        (
            "activity_days",
            json!([{ "day": "2026-09-02", "steps": -1 }]),
        ),
        ("activity_days", json!([{ "day": "2026-09-02" }])),
        ("activity_days", json!([day, day])),
        (
            "activity_days",
            json!([{ "day": "2026-09-02", "hrv_ms": 48, "rem_min": 30 }]),
        ),
        ("activity_sessions", json!([workout, workout])),
        ("activity_sessions", {
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
            "sessions",
            json!([
                session("uid-0001", json!("k"), "manual"),
                session("uid-0002", json!("k"), "health_connect")
            ]),
        ),
        (
            "sessions",
            json!([session("uid-0001", Value::Null, "health_connect")]),
        ),
    ] {
        let mut bad = bare("Bad");
        bad[field] = list;
        let (status, res) = import(&app, &bad).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{field}: {res}");
        assert_eq!(res["field"], field, "{res}");
    }
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
async fn a_v1_file_with_scale_weights_imports() {
    // Files from before the vocabulary change say `"scale"`.
    let app = app();
    let mut file = bare("Old");
    file["weights"] = json!([
        { "day": "2026-09-01", "kg": 72.0, "source": "manual" },
        { "day": "2026-09-02", "kg": 71.5, "source": "scale" },
    ]);
    let (status, p) = import(&app, &file).await;
    assert_eq!(status, StatusCode::CREATED, "{p}");
    let day = get_ok(&app, &format!("/api/profiles/{}/day/2026-09-02", p["id"])).await;
    assert_eq!(
        (&day["weight"], &day["weight_source"]),
        (&json!(71.5), &json!("openscale"))
    );
    let (_, again) = export(&app, p["id"].as_i64().unwrap()).await;
    assert_eq!(again["weights"][1]["source"], "openscale");
}

#[tokio::test]
async fn a_v1_files_profile_weight_is_a_weigh_in_unless_it_has_weights() {
    // Files from before the weight log kept the weight on the profile: it
    // lands as a typed weigh-in on the import day (the server's today).
    let app = app();
    let mut file = bare("Weighed");
    file["profile"]["weight_kg"] = json!(72.5);
    let (status, p) = import(&app, &file).await;
    assert_eq!(status, StatusCode::CREATED, "{p}");
    let today = kaloriina::model::today_in(&jiff::tz::TimeZone::UTC).to_string();
    let (_, again) = export(&app, p["id"].as_i64().unwrap()).await;
    assert_eq!(
        again["weights"],
        json!([{ "day": today, "kg": 72.5, "source": "manual", "set_at": null }])
    );

    // A file with weights of its own keeps only those.
    let mut file = bare("Logged");
    file["profile"]["weight_kg"] = json!(72.5);
    file["weights"] = json!([{ "day": "2026-09-01", "kg": 71.0 }]);
    let (status, p) = import(&app, &file).await;
    assert_eq!(status, StatusCode::CREATED, "{p}");
    let (_, again) = export(&app, p["id"].as_i64().unwrap()).await;
    assert_eq!(again["weights"].as_array().unwrap().len(), 1);
    assert_eq!(again["weights"][0]["day"], "2026-09-01");

    // Checked as any weight is.
    let mut file = bare("Heavy");
    file["profile"]["weight_kg"] = json!(9999.0);
    let (status, e) = import(&app, &file).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{e}");
    assert_eq!(e["field"], "weights");
}

#[tokio::test]
async fn a_v1_file_with_quick_adds_imports_as_foods() {
    // Quick adds are gone; a file holding them imports them as
    // archived foods of their own, the day's totals unchanged.
    let app = app();
    let mut file = bare("Quick");
    let mut big = quick("quick-entry-0003");
    big["nutrients"] = json!({ "energy": 2500.0, "fat": 150.0 });
    big["name"] = json!("Feast");
    file["entries"] = json!([quick("quick-entry-0001"), quick("quick-entry-0002"), big]);
    let (status, p) = import(&app, &file).await;
    assert_eq!(status, StatusCode::CREATED, "{p}");
    let pid = p["id"].as_i64().unwrap();
    let day = get_ok(&app, &format!("/api/profiles/{pid}/day/{DAY}")).await;
    assert_eq!(day["consumed"]["energy"], 2700.0);
    let entries = group(&day, "Consumed")["entries"]
        .as_array()
        .unwrap()
        .clone();
    assert_eq!(entries.len(), 3);
    let snack = entries[0]["food_id"].clone();
    assert!(snack.is_i64(), "{entries:?}");
    assert_eq!(entries[1]["food_id"], snack, "one food per name and values");
    assert_eq!(entries[0]["amount"], "Quick add", "the amount text is kept");
    for e in &entries {
        let food = get_ok(&app, &format!("/api/foods/{}", e["food_id"])).await;
        assert_eq!(food["archived"], true, "{food}");
        assert!(
            food["per100"]["energy"].as_f64().unwrap() <= 900.0,
            "{food}"
        );
    }
    let (_, out) = export(&app, pid).await;
    assert!(
        out["entries"]
            .as_array()
            .unwrap()
            .iter()
            .all(|e| e.get("kind").is_none())
    );
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
    file["entries"] = json!([{ "uid": "entry-big-0001", "day": DAY, "group": "Consumed", "kind": "food",
        "food": "f", "name": "Lard", "grams": 300.0, "amount": "300 g",
        "nutrients": { "energy": 2700.0, "fat": 300.0 }, "created_at": "2026-10-06T10:00:00Z" }]);
    let (status, p) = import(&app, &file).await;
    assert_eq!(status, StatusCode::CREATED, "{p}");
    let pid = p["id"].as_i64().unwrap();
    let day = get_ok(&app, &format!("/api/profiles/{pid}/day/{DAY}")).await;
    assert_eq!(day["consumed"]["energy"], 2700.0);
    let old = get_ok(&app, &format!("/api/profiles/{pid}/day/{HISTORY_DAY}")).await;
    assert_eq!(old["consumed"]["energy"], 2500.0);
}

// ---------------------------------------------------------- restore

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
        json!({ "name": "Upper", "kcal": 150, "steps": [
            { "kind": "exercise", "exercise_id": pull, "reps": 5, "kg": 5.0 },
            { "kind": "rest", "seconds": 60 },
            { "kind": "repeat", "name": "Core", "times": 2, "every": 90, "steps": [
                { "kind": "exercise", "exercise_id": plank, "seconds": 45 }] }] }),
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
        "/api/profiles/1/sessions",
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
    let hc = "/api/profiles/1/sync/health";
    ok(
        app,
        "PUT",
        &format!("{hc}/workouts"),
        json!({ "mode": "ask" }),
    )
    .await;
    ok(
        app,
        "POST",
        hc,
        json!({ "from": "2026-09-01", "to": "2026-09-07", "device": "Pixel 9",
                "days": [{ "day": "2026-09-02", "steps": 9120, "asleep_min": 440 }],
                "sessions": [{ "key": "hc-2", "day": "2026-09-03",
                    "start_at": "2026-09-03T08:00:00Z", "end_at": "2026-09-03T08:30:00Z",
                    "type": 53, "name": "Walking", "kcal": 90 }] }),
    )
    .await;
    let (status, _) = call(app, "DELETE", &format!("{hc}/workouts/hc-2"), None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    ok(
        app,
        "PUT",
        &format!("/api/profiles/1/check-ins/{DAY}"),
        json!({ "mood": 4, "tags": ["travel"] }),
    )
    .await;
}

/// A source with one of everything on profile 1, and a second profile so
/// 1 can be deleted.
async fn everything() -> Router {
    let app = source_app();
    populate(&app).await;
    populate_rest(&app).await;
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
    assert_eq!(without_time(again), without_time(file));
    assert_eq!(snapshot(&app, 1).await, before);
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
    // The rest is no v1 shape at all: only the header is read before the
    // version refuses it.
    let body = r#"{"format":"kaloriina-profile","version":2,"profile":7,"entries":{"x":[1,2]}}"#;
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
            "sessions",
            json!({ "sessions": [{ "uid": "session-0009", "day": DAY, "name": "S",
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
async fn export_carries_goal_and_instructions_only_where_they_belong() {
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
    assert_eq!(porridge["instructions"], "Boil.\nEat.");
    let oats = foods.iter().find(|f| f["name"] == "Oats").unwrap();
    assert!(oats.get("instructions").is_none(), "left out when none");

    // A copy imports with both.
    let mut copy = file.clone();
    copy["profile"]["name"] = json!("Copy");
    let (status, p) = call(&app, "POST", "/api/profiles/import", Some(copy.clone())).await;
    assert_eq!(status, StatusCode::CREATED, "{p}");
    assert_eq!(goal_weight(&app, &p["id"]).await, 64.5);

    // Only a recipe has instructions.
    let mut bad = copy.clone();
    bad["profile"]["name"] = json!("Bad");
    for f in bad["foods"].as_array_mut().unwrap() {
        if f["name"] == "Oats" {
            f["instructions"] = json!("Pour.");
        }
    }
    let (status, e) = call(&app, "POST", "/api/profiles/import", Some(bad)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{e}");
    assert_eq!(e["field"], "foods");

    // An older file, without instructions and with the goal on the
    // profile, imports with the goal as a target.
    let mut old = copy;
    old["profile"]["name"] = json!("Old");
    old["profile"]["goal_weight_kg"] = json!(70.0);
    old["targets"] = json!([]);
    for f in old["foods"].as_array_mut().unwrap() {
        f.as_object_mut().unwrap().remove("instructions");
    }
    let (status, p) = call(&app, "POST", "/api/profiles/import", Some(old)).await;
    assert_eq!(status, StatusCode::CREATED, "{p}");
    assert_eq!(goal_weight(&app, &p["id"]).await, 70.0);
}
