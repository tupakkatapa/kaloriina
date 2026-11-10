//! Logging from memory: a food's last amount, and the suggestions the
//! finder opens on.

use super::*;

async fn last(app: &Router, pid: i64, food: i64) -> (StatusCode, Value) {
    let uri = format!("/api/profiles/{pid}/foods/{food}/last");
    call(app, "GET", &uri, None).await
}

async fn post_entry(app: &Router, body: Value) -> Value {
    let (status, res) = call(app, "POST", "/api/profiles/1/entries", Some(body)).await;
    assert_eq!(status, StatusCode::CREATED, "{res}");
    res["entries"][0].clone()
}

#[tokio::test]
async fn a_foods_last_amount_is_the_profiles_own_latest_log() {
    let app = app();
    let (_, bread) = call(
        &app,
        "POST",
        "/api/foods",
        Some(json!({ "name": "Rye", "per100": { "energy": 250 },
                     "servings": [{ "label": "Slice", "grams": 40 }] })),
    )
    .await;
    let bread = bread["id"].as_i64().unwrap();
    assert_eq!(last(&app, 1, bread).await, (StatusCode::OK, Value::Null));

    log_entry(&app, "Eaten", bread, 50.0).await;
    post_entry(
        &app,
        json!({ "day": DAY, "group": "Planned", "food_id": bread,
                "serving": "Slice", "quantity": 2 }),
    )
    .await;
    let (_, two) = last(&app, 1, bread).await;
    assert_eq!(
        two,
        json!({ "grams": 80.0, "serving": "Slice", "quantity": 2.0 })
    );
    // The newest log, not the latest day.
    log_entry_on(&app, "2026-10-01", "Eaten", bread, 30.0).await;
    let thirty = json!({ "grams": 30.0, "serving": null, "quantity": null });
    assert_eq!(last(&app, 1, bread).await.1, thirty);

    // Imported history, matched to the food after: not an amount of yours.
    let csv = format!("Day,Group,Food Name,Amount\n{DAY},Consumed,Rye bread,300.00 g\n");
    let (status, res) = call(
        &app,
        "POST",
        "/api/profiles/1/import/cronometer",
        Some(json!({ "servings": csv })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{res}");
    let (status, res) = call(
        &app,
        "POST",
        "/api/profiles/1/imported/match",
        Some(json!({ "name": "Rye bread", "food_id": bread })),
    )
    .await;
    assert_eq!(res["matched"], 1, "{status} {res}");
    assert_eq!(last(&app, 1, bread).await.1, thirty);

    let (_, anna) = call(&app, "POST", "/api/profiles", Some(adult())).await;
    let anna = anna["id"].as_i64().unwrap();
    assert_eq!(last(&app, anna, bread).await, (StatusCode::OK, Value::Null));
    assert_eq!(last(&app, 99, bread).await.0, StatusCode::NOT_FOUND);
    assert_eq!(last(&app, 1, 9999).await.0, StatusCode::NOT_FOUND);
}

fn adult() -> Value {
    json!({ "name": "Anna", "sex": "female", "birth_date": "1990-05-01", "height_cm": 170.0,
            "activity": 1.6, "goal_kg_per_week": 0.0 })
}

async fn suggested(app: &Router, pid: i64, query: &str) -> (StatusCode, Value) {
    let uri = format!("/api/profiles/{pid}/foods/suggestions?{query}");
    call(app, "GET", &uri, None).await
}

fn suggested_names(list: &Value) -> Vec<&str> {
    list.as_array()
        .unwrap_or_else(|| panic!("{list}"))
        .iter()
        .map(|s| s["food"]["name"].as_str().unwrap())
        .collect()
}

#[tokio::test]
async fn suggestions_rank_what_the_profile_eats_and_leave_out_the_rest() {
    let app = app();
    let porridge = create_food(&app, "Porridge", json!({ "energy": 70 })).await;
    for d in 1..=5 {
        post_entry(
            &app,
            json!({ "day": format!("2026-10-0{d}"), "group": "Eaten", "food_id": porridge,
                    "grams": 300, "time": "07:30" }),
        )
        .await;
    }
    // Planned isn't eaten; an archived food, the water food and a food a
    // daily series logs aren't suggested.
    let planned = create_food(&app, "Planned only", json!({})).await;
    log_entry_on(&app, "2026-10-05", "Planned", planned, 100.0).await;
    let (_, cake) = call(
        &app,
        "POST",
        "/api/foods",
        Some(json!({ "name": "Old cake", "per100": {}, "archived": true })),
    )
    .await;
    log_entry_on(
        &app,
        "2026-10-05",
        "Eaten",
        cake["id"].as_i64().unwrap(),
        100.0,
    )
    .await;
    let (_, water) = call(&app, "GET", "/api/profiles/1/water-food", None).await;
    log_entry_on(
        &app,
        "2026-10-05",
        "Eaten",
        water["food"]["id"].as_i64().unwrap(),
        250.0,
    )
    .await;
    let shake = create_food(&app, "Shake", json!({})).await;
    let entry = log_entry_on(&app, "2026-10-04", "Eaten", shake, 30.0).await;
    let (status, res) = call(
        &app,
        "PATCH",
        &format!("/api/profiles/1/entries/{}", entry["key"].as_str().unwrap()),
        Some(json!({ "repeat": { "start": "2026-10-04" } })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{res}");
    // Once each, a while back: more than fit.
    for i in 0..12 {
        let f = create_food(&app, &format!("Snack {i:02}"), json!({})).await;
        log_entry_on(&app, "2026-09-20", "Eaten", f, 50.0).await;
    }

    let (status, list) = suggested(&app, 1, &format!("day={DAY}&time=07:40")).await;
    assert_eq!(status, StatusCode::OK, "{list}");
    let names = suggested_names(&list);
    assert_eq!(names.len(), 10, "{names:?}");
    assert_eq!(names[0], "Porridge");
    assert_eq!(
        names[1..4],
        ["Snack 00", "Snack 01", "Snack 02"],
        "ties by id"
    );
    for gone in ["Planned only", "Old cake", "Water", "Shake"] {
        assert!(!names.contains(&gone), "{gone}: {names:?}");
    }
    let top = &list[0];
    assert_eq!(
        top["reasons"],
        json!([
            "You had it yesterday",
            "Usually around 07:30",
            "Often your first food",
            "On 5 of the last 30 days"
        ])
    );
    assert_eq!(
        top["last"],
        json!({ "grams": 300.0, "serving": null, "quantity": null })
    );
    assert!(top["score"].as_f64().unwrap() > list[1]["score"].as_f64().unwrap());

    // The day's usual count logged: done for the day.
    log_entry(&app, "Eaten", porridge, 300.0).await;
    let (_, list) = suggested(&app, 1, &format!("day={DAY}")).await;
    assert!(!suggested_names(&list).contains(&"Porridge"), "{list}");

    let (_, anna) = call(&app, "POST", "/api/profiles", Some(adult())).await;
    let (status, hers) = suggested(&app, anna["id"].as_i64().unwrap(), &format!("day={DAY}")).await;
    assert_eq!((status, hers), (StatusCode::OK, json!([])));
    let (status, _) = suggested(&app, 99, &format!("day={DAY}")).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    for (query, field) in [
        (String::new(), "day"),
        ("day=2026-02-30".to_owned(), "day"),
        (format!("day={DAY}&time=24:00"), "time"),
        (format!("day={DAY}&time=8:00"), "time"),
    ] {
        let (status, res) = suggested(&app, 1, &query).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{query}: {res}");
        assert_eq!(res["field"], field, "{query}: {res}");
    }
}

#[tokio::test]
async fn a_food_or_recipe_with_alcohol_is_never_suggested() {
    let app = app();
    let beer = create_food(&app, "Lager", json!({ "energy": 42, "alcohol": 3.6 })).await;
    let juice = create_food(&app, "Orange juice", json!({ "energy": 45 })).await;
    let (status, punch) = call(
        &app,
        "POST",
        "/api/recipes",
        Some(json!({ "name": "Punch", "items": [
            { "food_id": beer, "grams": 100 }, { "food_id": juice, "grams": 100 }] })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{punch}");
    let punch = punch["id"].as_i64().unwrap();
    for d in 1..=5 {
        let day = format!("2026-10-0{d}");
        for food in [beer, juice, punch] {
            log_entry_on(&app, &day, "Eaten", food, 330.0).await;
        }
    }
    let (status, list) = suggested(&app, 1, &format!("day={DAY}&time=18:00")).await;
    assert_eq!(status, StatusCode::OK, "{list}");
    assert_eq!(suggested_names(&list), ["Orange juice"]);
}

#[tokio::test]
async fn suggestions_name_the_food_they_go_with_and_leave_out_a_higher_recipes_items() {
    let app = app();
    let coffee = create_food(&app, "Coffee", json!({ "energy": 2 })).await;
    let bun = create_food(&app, "Bun", json!({ "energy": 300 })).await;
    let oats = create_food(&app, "Oats", json!({ "energy": 370 })).await;
    let (status, porridge) = call(
        &app,
        "POST",
        "/api/recipes",
        Some(json!({ "name": "Porridge", "items": [{ "food_id": oats, "grams": 60 }] })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{porridge}");
    let porridge = porridge["id"].as_i64().unwrap();
    for d in 1..=5 {
        let day = format!("2026-10-0{d}");
        for (food, time) in [(coffee, "07:00"), (bun, "07:20"), (porridge, "12:00")] {
            post_entry(
                &app,
                json!({ "day": day, "group": "Eaten", "food_id": food, "grams": 100,
                        "time": time }),
            )
            .await;
        }
    }
    log_entry_on(&app, "2026-10-04", "Eaten", oats, 60.0).await;
    // A hidden recipe holds nothing back.
    let uri = format!("/api/profiles/1/suggestions/hidden/{porridge}");
    call(&app, "PUT", &uri, Some(json!({ "until": DAY }))).await;
    let (_, list) = suggested(&app, 1, &format!("day={DAY}")).await;
    assert_eq!(suggested_names(&list), ["Coffee", "Bun", "Oats"]);
    call(&app, "DELETE", &uri, None).await;

    post_entry(
        &app,
        json!({ "day": DAY, "group": "Eaten", "food_id": coffee, "grams": 200, "time": "06:50" }),
    )
    .await;
    let (status, list) = suggested(&app, 1, &format!("day={DAY}")).await;
    assert_eq!(status, StatusCode::OK, "{list}");
    assert_eq!(suggested_names(&list), ["Bun", "Porridge"]);
    assert!(
        list[0]["reasons"]
            .as_array()
            .unwrap()
            .contains(&json!("Usually with Coffee")),
        "{list}"
    );
}

async fn hide(app: &Router, pid: i64, food: i64, body: Value) -> (StatusCode, Value) {
    let uri = format!("/api/profiles/{pid}/suggestions/hidden/{food}");
    call(app, "PUT", &uri, Some(body)).await
}

#[tokio::test]
async fn a_hidden_food_is_not_suggested_through_its_day_or_until_shown_again() {
    let app = app();
    let porridge = create_food(&app, "Porridge", json!({ "energy": 70 })).await;
    let bread = create_food(&app, "Bread", json!({ "energy": 250 })).await;
    for d in 1..=5 {
        for food in [porridge, bread] {
            log_entry_on(&app, &format!("2026-10-0{d}"), "Eaten", food, 100.0).await;
        }
    }
    let names = async |day: &str| {
        let (status, list) = suggested(&app, 1, &format!("day={day}")).await;
        assert_eq!(status, StatusCode::OK, "{list}");
        suggested_names(&list)
            .into_iter()
            .map(str::to_owned)
            .collect::<Vec<_>>()
    };
    let hidden = async || call(&app, "GET", "/api/profiles/1/suggestions/hidden", None).await;

    assert_eq!(
        hide(&app, 1, porridge, json!({ "until": DAY })).await.0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(names(DAY).await, ["Bread"]);
    assert_eq!(names("2026-10-07").await, ["Porridge", "Bread"]);
    assert_eq!(hidden().await, (StatusCode::OK, json!([])), "never only");

    for _ in 0..2 {
        assert_eq!(
            hide(&app, 1, porridge, json!({})).await.0,
            StatusCode::NO_CONTENT
        );
    }
    assert_eq!(names("2026-10-07").await, ["Bread"]);
    let (status, list) = hidden().await;
    assert_eq!(status, StatusCode::OK, "{list}");
    assert_eq!(suggested_names(&json!([{ "food": list[0] }])), ["Porridge"]);
    assert_eq!(list.as_array().unwrap().len(), 1, "{list}");

    let uri = format!("/api/profiles/1/suggestions/hidden/{porridge}");
    for _ in 0..2 {
        assert_eq!(
            call(&app, "DELETE", &uri, None).await.0,
            StatusCode::NO_CONTENT
        );
    }
    assert_eq!(names(DAY).await, ["Porridge", "Bread"]);

    let (_, anna) = call(&app, "POST", "/api/profiles", Some(adult())).await;
    let anna = anna["id"].as_i64().unwrap();
    hide(&app, anna, bread, json!({})).await;
    assert_eq!(names(DAY).await, ["Porridge", "Bread"], "hers alone");

    for (food, body, field) in [
        (9999, json!({}), "food_id"),
        (porridge, json!({ "until": "2026-02-30" }), "until"),
        (porridge, json!({ "until": "tomorrow" }), "until"),
    ] {
        let (status, res) = hide(&app, 1, food, body.clone()).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}: {res}");
        assert_eq!(res["field"], field, "{body}: {res}");
    }
    assert_eq!(
        hide(&app, 99, porridge, json!({})).await.0,
        StatusCode::NOT_FOUND
    );
}
