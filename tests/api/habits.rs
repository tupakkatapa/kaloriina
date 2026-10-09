//! Habit trackers and their day counts, and the built-ins read
//! from food.

use super::*;

const HABITS: &str = "/api/profiles/1/habits";

async fn tracker(app: &Router, pid: i64, name: &str) -> Value {
    let (status, h) = call(
        app,
        "POST",
        &format!("/api/profiles/{pid}/habits"),
        Some(json!({ "name": name, "unit": "pouches" })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{h}");
    h
}

async fn other_profile(app: &Router) -> i64 {
    let (status, p) = call(
        app,
        "POST",
        "/api/profiles",
        Some(
            json!({ "name": "Anna", "sex": null, "birth_date": null, "height_cm": null,
                     "activity": null, "goal_kg_per_week": 0.0 }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{p}");
    p["id"].as_i64().unwrap()
}

#[tokio::test]
async fn trackers_follow_the_contract() {
    let app = app();
    let snus = tracker(&app, 1, "Snus").await;
    assert_eq!(
        snus,
        json!({ "id": snus["id"], "name": "Snus", "unit": "pouches", "goal_value": null,
                "goal_dir": "at_most",
                "archived": false, "rev": 1 })
    );
    let uri = format!("{HABITS}/{}", snus["id"]);

    // An edit names its rev: missing is 400 `rev`, old is 409 `stale`.
    let edit = json!({ "name": "Snus", "unit": "pouch", "goal_value": 10, "archived": true });
    let (status, res) = call(&app, "PUT", &uri, Some(edit.clone())).await;
    assert_eq!(
        (status, &res["field"]),
        (StatusCode::BAD_REQUEST, &json!("rev"))
    );
    let mut at = edit.clone();
    at["rev"] = json!(1);
    let (status, edited) = call(&app, "PUT", &uri, Some(at.clone())).await;
    assert_eq!(status, StatusCode::OK, "{edited}");
    assert_eq!(
        (
            &edited["unit"],
            &edited["goal_value"],
            &edited["archived"],
            &edited["rev"]
        ),
        (&json!("pouch"), &json!(10.0), &json!(true), &json!(2))
    );
    let (status, res) = call(&app, "PUT", &uri, Some(at)).await;
    assert_eq!(
        (status, &res["code"]),
        (StatusCode::CONFLICT, &json!("stale"))
    );

    // Names are unique per profile, ignoring case.
    let (status, res) = call(
        &app,
        "POST",
        HABITS,
        Some(json!({ "name": "SNUS", "unit": "x" })),
    )
    .await;
    assert_eq!(
        (status, &res["code"], &res["field"]),
        (StatusCode::CONFLICT, &json!("name_taken"), &json!("name"))
    );
    let coffee = tracker(&app, 1, "Coffee").await;
    let (status, res) = put_with_rev(
        &app,
        &format!("{HABITS}/{}", coffee["id"]),
        json!({ "name": "snus", "unit": "cups" }),
    )
    .await;
    assert_eq!(
        (status, &res["code"]),
        (StatusCode::CONFLICT, &json!("name_taken"))
    );
    let anna = other_profile(&app).await;
    tracker(&app, anna, "Snus").await;

    let (_, list) = call(&app, "GET", HABITS, None).await;
    let names: Vec<&str> = list
        .as_array()
        .unwrap()
        .iter()
        .map(|h| h["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["Snus", "Coffee"]);

    // Another profile's tracker isn't there.
    for (method, path, body) in [
        (
            "PUT",
            format!("/api/profiles/{anna}/habits/{}", snus["id"]),
            Some(json!({ "name": "X", "unit": "x", "rev": 2 })),
        ),
        (
            "DELETE",
            format!("/api/profiles/{anna}/habits/{}", snus["id"]),
            None,
        ),
        (
            "PUT",
            format!("/api/profiles/{anna}/habits/{}/days/{DAY}", snus["id"]),
            Some(json!({ "amount": 1 })),
        ),
        (
            "DELETE",
            format!("/api/profiles/{anna}/habits/{}/days/{DAY}", snus["id"]),
            None,
        ),
    ] {
        let (status, res) = call(&app, method, &path, body).await;
        assert_eq!(
            (status, &res["resource"]),
            (StatusCode::NOT_FOUND, &json!("habit")),
            "{method} {path}"
        );
    }
    let (status, res) = call(&app, "GET", "/api/profiles/99/habits", None).await;
    assert_eq!(
        (status, &res["resource"]),
        (StatusCode::NOT_FOUND, &json!("profile"))
    );
}

#[tokio::test]
async fn tracker_limits_come_from_meta() {
    let app = app();
    let (_, meta) = call(&app, "GET", "/api/meta", None).await;
    let limits = &meta["limits"];
    assert_eq!(
        (
            &limits["label"],
            &limits["unit"],
            &limits["habit_amount"],
            &limits["habits"]
        ),
        (&json!(50), &json!(20), &json!(999.0), &json!(20))
    );
    for (body, field) in [
        (json!({ "name": " ", "unit": "x" }), "name"),
        (json!({ "name": "n".repeat(51), "unit": "x" }), "name"),
        (json!({ "name": "Snus", "unit": "u".repeat(21) }), "unit"),
        (
            json!({ "name": "Snus", "unit": "x", "goal_value": -1 }),
            "goal_value",
        ),
        (
            json!({ "name": "Snus", "unit": "x", "goal_value": 1000 }),
            "goal_value",
        ),
        (json!({ "name": "Snus" }), "unit"),
    ] {
        let (status, res) = call(&app, "POST", HABITS, Some(body.clone())).await;
        assert_eq!(
            (status, &res["field"]),
            (StatusCode::BAD_REQUEST, &json!(field)),
            "{body}: {res}"
        );
    }
    for n in 0..20 {
        tracker(&app, 1, &format!("Habit {n}")).await;
    }
    let (status, res) = call(
        &app,
        "POST",
        HABITS,
        Some(json!({ "name": "One more", "unit": "x" })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{res}");
}

#[tokio::test]
async fn day_counts_are_idempotent_totals() {
    let app = app();
    let snus = tracker(&app, 1, "Snus").await;
    let coffee = tracker(&app, 1, "Coffee").await;
    let day_uri = |h: &Value, day: &str| format!("{HABITS}/{}/days/{day}", h["id"]);

    // PUT sets the day's total; repeating it changes nothing.
    for _ in 0..2 {
        let (status, res) = call(
            &app,
            "PUT",
            &day_uri(&snus, DAY),
            Some(json!({ "amount": 4 })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{res}");
        assert_eq!(
            res,
            json!({ "habit_id": snus["id"], "day": DAY, "amount": 4.0 })
        );
    }
    call(
        &app,
        "PUT",
        &day_uri(&snus, "2026-10-05"),
        Some(json!({ "amount": 2.5 })),
    )
    .await;
    call(
        &app,
        "PUT",
        &day_uri(&coffee, DAY),
        Some(json!({ "amount": 999 })),
    )
    .await;

    // Out of range amounts and days are refused.
    for (day, body, field) in [
        (DAY, json!({ "amount": 0 }), json!("amount")),
        (DAY, json!({ "amount": 999.5 }), json!("amount")),
        (DAY, json!({}), json!("amount")),
        ("2999-01-01", json!({ "amount": 1 }), Value::Null),
        ("2026-02-30", json!({ "amount": 1 }), Value::Null),
    ] {
        let (status, res) = call(&app, "PUT", &day_uri(&snus, day), Some(body.clone())).await;
        assert_eq!(
            (status, &res["field"]),
            (StatusCode::BAD_REQUEST, &field),
            "{day} {body}: {res}"
        );
    }

    let (_, days) = call(
        &app,
        "GET",
        &format!("{HABITS}/days?from=2026-10-01&to={DAY}"),
        None,
    )
    .await;
    assert_eq!(
        days,
        json!([
            { "habit": snus["id"].to_string(), "day": "2026-10-05", "amount": 2.5 },
            { "habit": snus["id"].to_string(), "day": DAY, "amount": 4.0 },
            { "habit": coffee["id"].to_string(), "day": DAY, "amount": 999.0 },
        ])
    );
    let (_, days) = call(
        &app,
        "GET",
        &format!("{HABITS}/days?from={DAY}&to={DAY}"),
        None,
    )
    .await;
    assert_eq!(days.as_array().unwrap().len(), 2);
    let (status, _) = call(
        &app,
        "GET",
        &format!("{HABITS}/days?from={DAY}&to=2026-10-01"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // The Day view carries the day's totals.
    let (_, day) = call(&app, "GET", &format!("/api/profiles/1/day/{DAY}"), None).await;
    assert_eq!(
        day["habits"],
        json!([
            { "habit_id": snus["id"], "amount": 4.0 },
            { "habit_id": coffee["id"], "amount": 999.0 },
        ])
    );
}

#[tokio::test]
async fn deleting_days_and_trackers() {
    let app = app();
    let snus = tracker(&app, 1, "Snus").await;
    let coffee = tracker(&app, 1, "Coffee").await;
    let day_uri = |h: &Value, day: &str| format!("{HABITS}/{}/days/{day}", h["id"]);
    for (h, amount) in [(&snus, 4), (&coffee, 999)] {
        let (status, res) = call(
            &app,
            "PUT",
            &day_uri(h, DAY),
            Some(json!({ "amount": amount })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{res}");
    }

    // DELETE removes it; a second is 404 `habit_day`.
    let (status, _) = call(&app, "DELETE", &day_uri(&snus, DAY), None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, res) = call(&app, "DELETE", &day_uri(&snus, DAY), None).await;
    assert_eq!(
        (status, &res["resource"]),
        (StatusCode::NOT_FOUND, &json!("habit_day"))
    );

    // Deleting a tracker takes its days with it.
    let (status, _) = call(&app, "DELETE", &format!("{HABITS}/{}", snus["id"]), None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (_, days) = call(&app, "GET", &format!("{HABITS}/days"), None).await;
    assert_eq!(
        days,
        json!([{ "habit": coffee["id"].to_string(), "day": DAY, "amount": 999.0 }])
    );
    let (status, res) = call(&app, "DELETE", &format!("{HABITS}/{}", snus["id"]), None).await;
    assert_eq!(
        (status, &res["resource"]),
        (StatusCode::NOT_FOUND, &json!("habit"))
    );
}

#[tokio::test]
async fn a_habit_goal_has_a_direction() {
    // "Reading 20 pages" is a goal to reach; a limit is a goal at most.
    let app = app();
    let (status, read) = call(
        &app,
        "POST",
        HABITS,
        Some(
            json!({ "name": "Reading", "unit": "pages", "goal_value": 20,
                     "goal_dir": "at_least" }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{read}");
    assert_eq!(
        (&read["goal_value"], &read["goal_dir"]),
        (&json!(20.0), &json!("at_least"))
    );
    // Without a direction a goal is a limit, as day limits were.
    let (_, snus) = call(
        &app,
        "POST",
        HABITS,
        Some(json!({ "name": "Snus", "unit": "pouches", "goal_value": 5 })),
    )
    .await;
    assert_eq!(snus["goal_dir"], "at_most");
    for (body, field) in [
        (
            json!({ "name": "X", "unit": "x", "goal_value": 1, "goal_dir": "about" }),
            "goal_dir",
        ),
        (
            json!({ "name": "X", "unit": "x", "goal_value": -1 }),
            "goal_value",
        ),
    ] {
        let (status, err) = call(&app, "POST", HABITS, Some(body.clone())).await;
        assert_eq!(
            (status, &err["field"]),
            (StatusCode::BAD_REQUEST, &json!(field)),
            "{body}: {err}"
        );
    }
}

/// A food of `category` (or none) with `per100`; its id.
async fn food_of(app: &Router, name: &str, category: Value, per100: Value) -> i64 {
    let body = json!({ "name": name, "category": category, "per100": per100 });
    let (status, food) = call(app, "POST", "/api/foods", Some(body)).await;
    assert_eq!(status, StatusCode::CREATED, "{food}");
    food["id"].as_i64().unwrap()
}

async fn recipe_of(app: &Router, name: &str, extra: Value, items: &[(i64, f64)]) -> i64 {
    let mut body = json!({
        "name": name,
        "items": items.iter().map(|(id, g)| json!({ "food_id": id, "grams": g })).collect::<Vec<_>>(),
    });
    body.as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    let (status, recipe) = call(app, "POST", "/api/recipes", Some(body)).await;
    assert_eq!(status, StatusCode::CREATED, "{recipe}");
    recipe["id"].as_i64().unwrap()
}

/// Profile 1's `DAY`: an apple, two recipes rolling up to it, a pie of its
/// own category, beer and cola eaten; cola and (the day before) apple
/// planned.
async fn eat_a_mixed_day(app: &Router) {
    let apple = food_of(app, "Apple", json!("fruit_veg"), json!({ "water": 85 })).await;
    let sugar = food_of(app, "Sugar", Value::Null, json!({ "added_sugars": 100 })).await;
    let beer = food_of(
        app,
        "Beer",
        Value::Null,
        json!({ "alcohol": 4, "sodium": 5 }),
    )
    .await;
    let cola = food_of(app, "Cola", json!("sugary_drinks"), json!({})).await;
    // 300 g apple + 100 g sugar cooked down to 200 g: 1.5 g apple a gram.
    let compote = recipe_of(
        app,
        "Compote",
        json!({ "cooked_g": 200 }),
        &[(apple, 300.0), (sugar, 100.0)],
    )
    .await;
    // Half compote, half sugar, no cooked weight: down two levels.
    let bowl = recipe_of(app, "Bowl", json!({}), &[(compote, 100.0), (sugar, 100.0)]).await;
    // Its own category: counted whole, its apple isn't fruit here.
    let pie = recipe_of(
        app,
        "Pie",
        json!({ "category": "sweets_snacks" }),
        &[(apple, 100.0)],
    )
    .await;

    log_entry_on(app, DAY, "Consumed", apple, 200.0).await;
    log_entry_on(app, DAY, "Consumed", compote, 100.0).await;
    log_entry_on(app, DAY, "Consumed", bowl, 200.0).await;
    log_entry_on(app, DAY, "Consumed", pie, 80.0).await;
    log_entry_on(app, DAY, "Consumed", beer, 600.0).await;
    log_entry_on(app, DAY, "Consumed", cola, 330.0).await;
    // Planned isn't eaten.
    log_entry_on(app, DAY, "Planned", cola, 500.0).await;
    log_entry_on(app, "2026-10-05", "Planned", apple, 500.0).await;
}

#[tokio::test]
async fn builtin_days_from_nutrients_and_categories() {
    // The server computes every built-in; a recipe without a category
    // counts its ingredients' share, one with a category counts whole.
    let app = app();
    eat_a_mixed_day(&app).await;
    let snus = tracker(&app, 1, "Snus").await;
    call(
        &app,
        "PUT",
        &format!("{HABITS}/{}/days/2026-10-04", snus["id"]),
        Some(json!({ "amount": 2 })),
    )
    .await;

    let (status, days) = call(
        &app,
        "GET",
        &format!("{HABITS}/days?from=2026-10-01&to={DAY}"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{days}");
    let row = |habit: &str, day: &str| {
        days.as_array()
            .unwrap()
            .iter()
            .find(|r| r["habit"] == habit && r["day"] == day)
            .map(|r| r["amount"].as_f64().unwrap())
    };
    let near = |habit: &str, want: f64| {
        let got = row(habit, DAY).unwrap_or_else(|| panic!("{habit}: no row in {days}"));
        assert!((got - want).abs() < 1e-9, "{habit}: {got} ≠ {want}");
    };
    // Apple 200 + compote 100 × 1.5 + bowl 200 → compote 100 → apple 150.
    near("fruit_veg", 200.0 + 150.0 + 150.0);
    near("sweets_snacks", 80.0);
    near("sugary_drinks", 330.0);
    // Nutrients: from the entries' values, stored units.
    near("alcohol", 24.0);
    near("caffeine", 0.0);
    near("salt", 30.0);
    assert_eq!(
        row("processed_meat", DAY),
        None,
        "categories only when eaten"
    );
    // Planned only: no food eaten that day, so no built-in rows.
    assert_eq!(row("water", "2026-10-05"), None);
    assert_eq!(row("fruit_veg", "2026-10-05"), None);
    // Trackers are habits too: their id as a string, after the built-ins.
    assert_eq!(row(&snus["id"].to_string(), "2026-10-04"), Some(2.0));
    let order: Vec<&str> = days
        .as_array()
        .unwrap()
        .iter()
        .filter(|r| r["day"] == DAY)
        .map(|r| r["habit"].as_str().unwrap())
        .collect();
    assert_eq!(
        order,
        [
            "water",
            "alcohol",
            "caffeine",
            "added_sugars",
            "salt",
            "sweets_snacks",
            "sugary_drinks",
            "fruit_veg"
        ]
    );

    // The day carries the built-ins it held, none at 0.
    let (_, day) = call(&app, "GET", &format!("/api/profiles/1/day/{DAY}"), None).await;
    let held: Vec<&str> = day["builtins"]
        .as_array()
        .unwrap()
        .iter()
        .map(|b| b["habit"].as_str().unwrap())
        .collect();
    assert_eq!(
        held,
        [
            "water",
            "alcohol",
            "added_sugars",
            "salt",
            "sweets_snacks",
            "sugary_drinks",
            "fruit_veg"
        ]
    );
}

#[tokio::test]
async fn a_users_category_moves_the_days_amounts_and_meta_describes_the_builtins() {
    let app = app();
    let cola = food_of(&app, "Cola", json!("sugary_drinks"), json!({})).await;
    log_entry_on(&app, DAY, "Consumed", cola, 330.0).await;
    let has_drinks = |days: &Value| {
        days.as_array()
            .unwrap()
            .iter()
            .any(|r| r["habit"] == "sugary_drinks")
    };
    let uri = format!("{HABITS}/days?from={DAY}&to={DAY}");
    let (_, days) = call(&app, "GET", &uri, None).await;
    assert!(has_drinks(&days), "{days}");
    let (_, food) = call(&app, "GET", &format!("/api/foods/{cola}"), None).await;
    let mut edit = food.clone();
    edit["category"] = Value::Null;
    let (status, res) = call(&app, "PUT", &format!("/api/foods/{cola}"), Some(edit)).await;
    assert_eq!(status, StatusCode::OK, "{res}");
    let (_, days) = call(&app, "GET", &uri, None).await;
    assert!(!has_drinks(&days), "{days}");

    // Every built-in is described in /api/meta, with its target metric.
    let (_, meta) = call(&app, "GET", "/api/meta", None).await;
    let fruit = meta["habits"]
        .as_array()
        .unwrap()
        .iter()
        .find(|h| h["key"] == "fruit_veg")
        .unwrap();
    assert_eq!(fruit["metric"], "category:fruit_veg");
    assert_eq!(fruit["goal_dir"], "at_least");
    assert_eq!(fruit["source"], json!({ "category": "fruit_veg" }));
    assert_eq!(
        meta["food_categories"][3],
        json!({ "key": "fruit_veg", "label": "Fruit and vegetables" })
    );
}
