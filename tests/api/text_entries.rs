//! Text entries: a name, a time and an optional kcal estimate, no food
//! behind them, until "Find the food" makes one a food's entry in place.

use super::*;

const ENTRIES: &str = "/api/profiles/1/entries";

async fn post(app: &Router, body: Value) -> (StatusCode, Value) {
    call(app, "POST", ENTRIES, Some(body)).await
}

/// A text entry logged in Eaten on `DAY`: the entry.
async fn text(app: &Router, name: &str, energy: Value) -> Value {
    let (status, res) = post(
        app,
        json!({ "day": DAY, "group": "Eaten", "name": name, "energy": energy }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{res}");
    res["entries"][0].clone()
}

async fn patch(app: &Router, id: &Value, body: Value) -> (StatusCode, Value) {
    call(app, "PATCH", &format!("{ENTRIES}/{id}"), Some(body)).await
}

async fn day_of(app: &Router) -> Value {
    let (status, d) = call(app, "GET", &format!("/api/profiles/1/day/{DAY}"), None).await;
    assert_eq!(status, StatusCode::OK, "{d}");
    d
}

async fn summary_day(app: &Router) -> Value {
    let (status, s) = call(
        app,
        "GET",
        &format!("/api/profiles/1/summary?from={DAY}&to={DAY}"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{s}");
    s["days"][0].clone()
}

fn assert_invalid(status: StatusCode, res: &Value, field: Option<&str>) {
    assert_eq!(status, StatusCode::BAD_REQUEST, "{res}");
    assert_eq!(res["code"], "invalid", "{res}");
    assert_eq!(res.get("field").and_then(Value::as_str), field, "{res}");
}

#[tokio::test]
async fn a_text_entry_has_a_name_a_time_and_maybe_kcal() {
    let app = app();
    let body = json!({ "day": DAY, "group": "Eaten", "name": "  Lunch out ",
                       "energy": 650.0, "time": "12:30", "uid": "text-uid-0001" });
    let (status, res) = post(&app, body.clone()).await;
    assert_eq!(status, StatusCode::CREATED, "{res}");
    let e = &res["entries"][0];
    assert_eq!(
        (&e["name"], &e["food_id"], &e["kind"], &e["nutrients"]),
        (
            &json!("Lunch out"),
            &Value::Null,
            &json!("own"),
            &json!({ "energy": 650.0 })
        )
    );
    assert_eq!(
        (&e["grams"], &e["amount"], &e["time"]),
        (&Value::Null, &json!(""), &json!("12:30"))
    );
    // A retry logs nothing more.
    let (_, again) = post(&app, body).await;
    assert_eq!(again["entries"][0]["id"], e["id"]);
    let without = text(&app, "Snack", Value::Null).await;
    assert_eq!(without["nutrients"], Value::Null);
    let d = day_of(&app).await;
    assert_eq!(d["eaten"]["energy"], 650.0);
    // Its kcal is an estimate, bounded as /api/meta says.
    let (_, meta) = call(&app, "GET", "/api/meta", None).await;
    assert_eq!(meta["limits"]["entry_energy"], 10_000.0);

    let base = json!({ "day": DAY, "group": "Eaten" });
    let with = |extra: Value| {
        let mut b = base.clone();
        b.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        b
    };
    for (extra, field) in [
        (json!({ "name": " " }), Some("name")),
        (json!({ "name": "x".repeat(201) }), Some("name")),
        (json!({ "name": "Cake", "energy": -1.0 }), Some("energy")),
        (
            json!({ "name": "Cake", "energy": 10_001.0 }),
            Some("energy"),
        ),
        (json!({ "name": "Cake", "grams": 10.0 }), None),
        (json!({ "name": "Cake", "repeat": {} }), Some("repeat")),
        (json!({ "energy": 5.0 }), None),
        (
            json!({ "name": "Cake", "nutrients": { "energy": 5.0 } }),
            Some("nutrients"),
        ),
    ] {
        let (status, res) = post(&app, with(extra.clone())).await;
        assert_invalid(status, &res, field);
    }
}

/// A text entry with kcal counts in energy; the dry matter it stands for
/// (kcal / 4 g) carries nothing else, so the day's other keys read as
/// floors. Without kcal the day's energy is a floor, and nothing of it is
/// vouched for: the day isn't counted.
#[tokio::test]
async fn a_text_entrys_day_is_known_as_far_as_it_can_be() {
    let app = app();
    let oats = create_food(
        &app,
        "Oats",
        json!({ "energy": 380.0, "protein": 13.0, "water": 0.0 }),
    )
    .await;
    log_entry(&app, "Eaten", oats, 100.0).await;
    text(&app, "Lunch out", json!(600.0)).await;
    let d = day_of(&app).await;
    assert_eq!(d["eaten"]["energy"], 980.0);
    // 100 g of oats beside 150 g the text stands for.
    assert_eq!(d["known"]["protein"], 0.4, "{d}");
    assert!(d["known"].get("energy").is_none(), "{d}");
    // Whatever it was might have held caffeine.
    assert_eq!(d["known"]["caffeine"], 0.0, "{d}");
    assert_eq!(d["incomplete"], false);
    let s = summary_day(&app).await;
    assert_eq!(s["known"]["protein"], 0.4, "{s}");
    assert!(s.get("incomplete").is_none(), "{s}");

    let unknown = text(&app, "Cake at work", Value::Null).await;
    let d = day_of(&app).await;
    assert_eq!(d["incomplete"], true);
    assert!(d.get("not_fully_logged").is_none(), "{d}");
    assert_eq!(
        (&d["known"]["protein"], &d["known"]["energy"]),
        (&json!(0.0), &json!(0.0))
    );
    let s = summary_day(&app).await;
    assert_eq!(
        (
            &s["incomplete"],
            &s["energy_unknown"],
            &s["known"]["energy"]
        ),
        (&json!(true), &json!(true), &json!(0.0)),
        "{s}"
    );
    // Planned isn't eaten.
    patch(&app, &unknown["id"], json!({ "group": "Planned" })).await;
    assert_eq!(day_of(&app).await["incomplete"], false);
}

#[tokio::test]
async fn a_text_entry_is_edited_copied_and_deleted() {
    let app = app();
    let e = text(&app, "Lunch out", json!(600.0)).await;
    let (status, edited) = patch(
        &app,
        &e["id"],
        json!({ "name": "Pizza", "energy": 900.0, "time": "13:00" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{edited}");
    assert_eq!(
        (&edited["name"], &edited["nutrients"], &edited["time"]),
        (
            &json!("Pizza"),
            &json!({ "energy": 900.0 }),
            &json!("13:00")
        )
    );
    let (_, cleared) = patch(&app, &e["id"], json!({ "energy": null })).await;
    assert_eq!(cleared["nutrients"], Value::Null);
    let (_, moved) = patch(
        &app,
        &e["id"],
        json!({ "group": "Planned", "energy": 500.0 }),
    )
    .await;
    assert_eq!(
        (&moved["group"], &moved["time"]),
        (&json!("Planned"), &Value::Null)
    );

    for (body, field) in [
        (json!({ "name": "" }), Some("name")),
        (json!({ "energy": 10_001.0 }), Some("energy")),
        (json!({ "grams": 100.0 }), Some("grams")),
        (json!({ "repeat": {} }), Some("repeat")),
    ] {
        let (status, res) = patch(&app, &e["id"], body.clone()).await;
        assert_invalid(status, &res, field);
    }

    // Log again keeps it a text entry.
    let (status, copied) = post(
        &app,
        json!({ "day": "2026-10-07", "group": "Eaten", "entry_ids": [e["id"]] }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{copied}");
    let c = &copied["entries"][0];
    assert_eq!(
        (&c["food_id"], &c["name"], &c["nutrients"], &c["amount"]),
        (
            &Value::Null,
            &json!("Pizza"),
            &json!({ "energy": 500.0 }),
            &json!("")
        )
    );
    let uri = format!("{ENTRIES}/{}", e["id"]);
    assert_eq!(
        call(&app, "DELETE", &uri, None).await.0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(call(&app, "GET", &uri, None).await.0, StatusCode::NOT_FOUND);
}

/// A one-off item's protein, carbs and fat: optional grams, bounded as
/// /api/meta says, set and cleared one at a time.
#[tokio::test]
async fn a_one_off_item_takes_its_macros() {
    let app = app();
    let (status, res) = post(
        &app,
        json!({ "day": DAY, "group": "Eaten", "name": "Burrito", "energy": 600.0,
                "protein": 30.0, "carbs": 60.0 }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{res}");
    let e = &res["entries"][0];
    assert_eq!(
        e["nutrients"],
        json!({ "energy": 600.0, "protein": 30.0, "carbs": 60.0 })
    );
    let (status, edited) = patch(&app, &e["id"], json!({ "fat": 20.0, "carbs": null })).await;
    assert_eq!(status, StatusCode::OK, "{edited}");
    assert_eq!(
        edited["nutrients"],
        json!({ "energy": 600.0, "protein": 30.0, "fat": 20.0 })
    );
    let (_, kcal) = patch(&app, &e["id"], json!({ "energy": 650.0 })).await;
    assert_eq!(
        kcal["nutrients"],
        json!({ "energy": 650.0, "protein": 30.0, "fat": 20.0 })
    );
    let (_, meta) = call(&app, "GET", "/api/meta", None).await;
    assert_eq!(meta["limits"]["entry_macro"], 1_000.0);

    for key in ["protein", "carbs", "fat"] {
        for bad in [json!(-1.0), json!(1_000.5)] {
            let (status, res) = post(
                &app,
                json!({ "day": DAY, "group": "Eaten", "name": "Cake", key: bad }),
            )
            .await;
            assert_invalid(status, &res, Some(key));
            let (status, res) = patch(&app, &e["id"], json!({ key: bad })).await;
            assert_invalid(status, &res, Some(key));
        }
    }

    // A food's entry ignores them, as it does name and energy.
    let oats = create_food(&app, "Oats", json!({ "energy": 380.0 })).await;
    let (_, food) = post(
        &app,
        json!({ "day": DAY, "group": "Eaten", "food_id": oats, "grams": 100.0, "protein": 5.0 }),
    )
    .await;
    let food = &food["entries"][0];
    assert_eq!(food["nutrients"], json!({ "energy": 380.0 }));
    let (status, same) = patch(&app, &food["id"], json!({ "fat": 9.0 })).await;
    assert_eq!(status, StatusCode::OK, "{same}");
    assert_eq!(same["nutrients"], json!({ "energy": 380.0 }));
}

/// With macros, a one-off item's dry matter is theirs, and they are
/// known; its micronutrients stay floors.
#[tokio::test]
async fn a_one_off_items_macros_are_known() {
    let app = app();
    let oats = create_food(
        &app,
        "Oats",
        json!({ "energy": 380.0, "protein": 13.0, "fiber": 10.0, "water": 0.0 }),
    )
    .await;
    log_entry(&app, "Eaten", oats, 100.0).await;
    let (status, res) = post(
        &app,
        json!({ "day": DAY, "group": "Eaten", "name": "Burrito", "energy": 600.0,
                "protein": 30.0, "carbs": 60.0, "fat": 10.0 }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{res}");
    let d = day_of(&app).await;
    assert_eq!(d["eaten"]["protein"], 43.0);
    assert!(d["known"].get("protein").is_none(), "{d}");
    // 100 g of oats beside the 100 g of macros.
    assert_eq!(d["known"]["fiber"], 0.5, "{d}");
    let s = summary_day(&app).await;
    assert_eq!(s["known"]["fiber"], 0.5, "{s}");
}

/// "Find the food": the same entry becomes the food's, its values the
/// food's at that amount; its food doesn't change after.
#[tokio::test]
async fn a_text_entry_becomes_the_food_found_for_it() {
    let app = app();
    let (status, res) = post(
        &app,
        json!({ "day": DAY, "group": "Eaten", "name": "Porridge?", "energy": 300.0,
                "time": "08:00", "uid": "text-uid-0002" }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{res}");
    let e = res["entries"][0].clone();
    let oats = create_food(&app, "Oats", json!({ "energy": 380.0, "protein": 13.0 })).await;
    let (status, found) = patch(&app, &e["id"], json!({ "food_id": oats, "grams": 50.0 })).await;
    assert_eq!(status, StatusCode::OK, "{found}");
    for key in ["id", "uid", "day", "group", "time"] {
        assert_eq!(found[key], e[key], "{key}");
    }
    assert_eq!(
        (
            &found["food_id"],
            &found["name"],
            &found["amount"],
            &found["nutrients"]
        ),
        (
            &json!(oats),
            &json!("Oats"),
            &json!("50 g"),
            &json!({ "energy": 190.0, "protein": 6.5 })
        )
    );
    // A food again re-measures it (a retry); its food stays.
    let rye = create_food(&app, "Rye", json!({ "energy": 250.0 })).await;
    for food in [oats, rye] {
        let (status, again) =
            patch(&app, &e["id"], json!({ "food_id": food, "grams": 100.0 })).await;
        assert_eq!(status, StatusCode::OK, "{again}");
        assert_eq!(
            (&again["food_id"], &again["nutrients"]["energy"]),
            (&json!(oats), &json!(380.0))
        );
    }
    // A food and a name together say two things.
    let other = text(&app, "Soup", Value::Null).await;
    let (status, res) = patch(
        &app,
        &other["id"],
        json!({ "food_id": oats, "grams": 10.0, "name": "Oats" }),
    )
    .await;
    assert_invalid(status, &res, None);
    let (status, res) = patch(
        &app,
        &other["id"],
        json!({ "food_id": 9999, "grams": 10.0 }),
    )
    .await;
    assert_invalid(status, &res, Some("food_id"));
    // Found, it can repeat daily in the same write.
    let (status, daily) = patch(
        &app,
        &other["id"],
        json!({ "food_id": oats, "grams": 10.0, "repeat": {} }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{daily}");
    assert_eq!(daily["food_id"], json!(oats));
    assert!(daily["repeat"].is_object(), "{daily}");
}

/// What a text entry adds that older releases ignored stays ignored
/// where it takes no effect: on a food's log or entry, on imported
/// history and on a due day.
#[tokio::test]
async fn text_entry_keys_are_ignored_where_they_take_no_effect() {
    let app = app();
    let oats = create_food(&app, "Oats", json!({ "energy": 380.0 })).await;
    let rye = create_food(&app, "Rye", json!({ "energy": 250.0 })).await;
    let food = log_entry(&app, "Eaten", oats, 100.0).await;
    for extra in [
        json!({ "food_id": oats, "name": "Cake", "energy": 5.0 }),
        json!({ "food_id": oats, "energy": 5.0 }),
        json!({ "food_id": oats, "nutrients": { "energy": 5.0 } }),
        json!({ "entry_ids": [food["id"]], "name": "Cake", "nutrients": {} }),
    ] {
        let mut body = json!({ "day": DAY, "group": "Eaten", "grams": 100.0 });
        body.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        let (status, res) = post(&app, body).await;
        assert_eq!(status, StatusCode::CREATED, "{res}");
        let e = &res["entries"][0];
        assert_eq!(
            (&e["food_id"], &e["name"], &e["nutrients"]),
            (&json!(oats), &json!("Oats"), &json!({ "energy": 380.0 })),
            "{extra}"
        );
    }
    for body in [
        json!({ "name": "", "energy": 5.0, "grams": 50.0 }),
        json!({ "energy": null, "grams": 50.0 }),
        json!({ "food_id": rye, "grams": 50.0 }),
    ] {
        let (status, e) = patch(&app, &food["id"], body.clone()).await;
        assert_eq!(status, StatusCode::OK, "{e}");
        assert_eq!(
            (&e["food_id"], &e["name"], &e["nutrients"]),
            (&json!(oats), &json!("Oats"), &json!({ "energy": 190.0 })),
            "{body}"
        );
    }
}

/// Imported history is read-only but for its group: a name, kcal or food
/// is ignored.
#[tokio::test]
async fn imported_history_ignores_a_name_kcal_or_food() {
    let mut conn = open(FsPath::new(":memory:")).unwrap();
    let csv = format!("Day,Group,Food Name,Amount\n{DAY},Eaten,Rye Bread,70.00 g\n");
    common::import_servings(&mut conn, common::ME, csv.as_bytes()).unwrap();
    let app = app_from(conn, NO_OFF);
    let d = day_of(&app).await;
    let row = d["groups"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|g| g["entries"].as_array().unwrap())
        .find(|e| e["kind"] == "imported")
        .unwrap()
        .clone();
    let oats = create_food(&app, "Oats", json!({ "energy": 380.0 })).await;
    for body in [
        json!({ "name": "Rye" }),
        json!({ "energy": 5.0 }),
        json!({ "food_id": oats, "group": "Planned" }),
    ] {
        let (status, res) = patch(&app, &row["id"], body).await;
        assert_eq!(status, StatusCode::OK, "{res}");
        assert_eq!(
            (&res["name"], &res["food_id"], &res["nutrients"]),
            (&row["name"], &row["food_id"], &row["nutrients"])
        );
    }
}

/// What remembers foods (suggestions, a food's last amount) never sees a
/// text entry.
#[tokio::test]
async fn suggestions_leave_text_entries_out() {
    let app = app();
    let porridge = create_food(&app, "Porridge", json!({ "energy": 70.0 })).await;
    log_entry_on(&app, "2026-10-05", "Eaten", porridge, 300.0).await;
    for d in ["2026-10-04", "2026-10-05"] {
        let (status, res) = post(
            &app,
            json!({ "day": d, "group": "Eaten", "name": "Oats", "energy": 300.0 }),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "{res}");
    }
    let (status, list) = call(
        &app,
        "GET",
        &format!("/api/profiles/1/foods/suggestions?day={DAY}&time=08:00"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{list}");
    let names: Vec<&str> = list
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["food"]["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["Porridge"], "{list}");
}

/// A day with a text entry: what it held of a category or of water isn't
/// known.
#[tokio::test]
async fn a_text_entrys_day_leaves_categories_and_hydration_unknown() {
    let app = app();
    let (_, apple) = call(
        &app,
        "POST",
        "/api/foods",
        Some(json!({ "name": "Apple", "category": "fruit_veg",
                      "per100": { "energy": 52.0, "water": 85.0 } })),
    )
    .await;
    log_entry(&app, "Eaten", apple["id"].as_i64().unwrap(), 300.0).await;
    let read = |app: Router| async move {
        let (_, days) = call(
            &app,
            "GET",
            &format!("/api/profiles/1/habits/days?from={DAY}&to={DAY}"),
            None,
        )
        .await;
        let known = |habit: &str| {
            days.as_array()
                .unwrap()
                .iter()
                .find(|r| r["habit"] == habit)
                .unwrap_or_else(|| panic!("{habit}: {days}"))["known"]
                .clone()
        };
        (known("fruit_veg"), known("water"))
    };
    assert_eq!(read(app.clone()).await, (json!(true), json!(true)));
    text(&app, "Lunch out", json!(800.0)).await;
    assert_eq!(read(app.clone()).await, (json!(false), json!(false)));
}
