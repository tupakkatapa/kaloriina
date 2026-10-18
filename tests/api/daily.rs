//! Repeating daily: an entry's `repeat` attribute. A series is due in
//! Planned every day from its start, as an entry-shaped row (`id: null`,
//! `key: "daily-{item}-{day}"`), until ticked (an entry logged with
//! `repeat_of`) or skipped (`DELETE /entries/daily-…`) (ADR 0023).

use super::*;

const ENTRIES: &str = "/api/profiles/1/entries";
const NEXT: &str = "2026-10-07";
const LATER: &str = "2026-10-09";

async fn day_view(app: &Router, day: &str) -> Value {
    let (status, d) = call(app, "GET", &format!("/api/profiles/1/day/{day}"), None).await;
    assert_eq!(status, StatusCode::OK, "{d}");
    d
}

/// The keys of the due rows (no id) in Planned on `day`.
async fn due(app: &Router, day: &str) -> Vec<String> {
    group(&day_view(app, day).await, "Planned")["entries"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|e| e["id"].is_null())
        .map(|e| e["key"].as_str().unwrap().to_owned())
        .collect()
}

/// `entry` repeated daily from `start`: the answer.
async fn repeat(app: &Router, entry: &Value, start: &str) -> (StatusCode, Value) {
    call(
        app,
        "PATCH",
        &format!("{ENTRIES}/{}", entry["key"].as_str().unwrap()),
        Some(json!({ "repeat": { "start": start } })),
    )
    .await
}

/// A "Shake" (400 kcal/100 g) logged as 30 g on DAY and repeated daily
/// from DAY: the entry, now the first day's tick.
async fn shake(app: &Router) -> Value {
    let food = create_food(app, "Shake", json!({ "energy": 400.0 })).await;
    let entry = log_entry(app, "Eaten", food, 30.0).await;
    let (status, ticked) = repeat(app, &entry, DAY).await;
    assert_eq!(status, StatusCode::OK, "{ticked}");
    ticked
}

/// The series' id.
fn series(entry: &Value) -> i64 {
    entry["repeat"]["id"].as_i64().unwrap()
}

/// The address of `entry`'s series on `day`.
fn key(entry: &Value, day: &str) -> String {
    format!("daily-{}-{day}", series(entry))
}

/// Tick `entry`'s series on `day` into Eaten with `uid`: the answer.
async fn tick(app: &Router, entry: &Value, day: &str, uid: &str) -> (StatusCode, Value) {
    call(
        app,
        "POST",
        ENTRIES,
        Some(json!({ "uid": uid, "day": day, "group": "Eaten", "repeat_of": series(entry) })),
    )
    .await
}

#[tokio::test]
async fn a_due_day_is_a_planned_entry() {
    let app = app();
    let first = shake(&app).await;
    let item = series(&first);
    assert_eq!(first["repeat"], json!({ "id": item, "start": DAY }));
    assert_eq!(first["key"], json!(first["id"].to_string()));
    // Before its start: nothing. On it: the entry it was made from is the
    // day's tick.
    assert_eq!(due(&app, "2026-10-05").await, Vec::<String>::new());
    let start = day_view(&app, DAY).await;
    assert_eq!(group(&start, "Planned")["entries"], json!([]));
    assert_eq!(group(&start, "Eaten")["entries"][0]["repeat"]["id"], item);
    assert!(start.get("daily_items").is_none(), "{start}");
    // Later: an entry-shaped row in Planned, counted in Planned's totals and
    // the day's total, never in what was eaten.
    let next = day_view(&app, NEXT).await;
    let row = &group(&next, "Planned")["entries"][0];
    let key = format!("daily-{item}-{NEXT}");
    assert_eq!(
        row,
        &json!({ "id": null, "key": key, "day": NEXT, "group": "Planned",
                 "food_id": first["food_id"], "name": "Shake", "grams": 30.0,
                 "serving": null, "quantity": null, "amount": "30 g",
                 "nutrients": { "energy": 120.0 }, "created_at": row["created_at"],
                 "by_volume": false,
                 "uid": key, "source": "custom", "time": null,
                 "weight_estimated": false, "repeat": { "id": item, "start": DAY },
                 "src_group": null, "kind": "due" })
    );
    assert_eq!(group(&next, "Planned")["totals"]["energy"], 120.0);
    assert_eq!(next["total"]["energy"], 120.0);
    assert_eq!(next["eaten"].get("energy"), None);
    assert_eq!(
        due(&app, "2027-01-01").await,
        [format!("daily-{item}-2027-01-01")]
    );
    // Its address reads it.
    let (status, read) = call(&app, "GET", &format!("{ENTRIES}/{key}"), None).await;
    assert_eq!((status, &read), (StatusCode::OK, row));
}

#[tokio::test]
async fn two_device_ticks_make_one_entry() {
    let app = app();
    let first = shake(&app).await;
    let uid = key(&first, NEXT);
    let (status, ticked) = tick(&app, &first, NEXT, &uid).await;
    assert_eq!(status, StatusCode::CREATED, "{ticked}");
    let entry = &ticked["entries"][0];
    assert_eq!(
        (
            &entry["repeat"]["id"],
            &entry["grams"],
            &entry["group"],
            &entry["nutrients"]["energy"],
            &entry["uid"]
        ),
        (
            &first["repeat"]["id"],
            &json!(30.0),
            &json!("Eaten"),
            &json!(120.0),
            &json!(uid)
        )
    );
    assert_eq!(due(&app, NEXT).await, Vec::<String>::new());
    // A second device ticks the same day: the same deterministic uid answers
    // with the first; another uid too (the backstop).
    for again_uid in [uid.as_str(), "tick-device-b"] {
        let (status, again) = tick(&app, &first, NEXT, again_uid).await;
        assert!(status.is_success(), "{again}");
        assert_eq!(again["entries"][0]["id"], entry["id"], "{again_uid}");
    }
    let next = day_view(&app, NEXT).await;
    assert_eq!(
        group(&next, "Eaten")["entries"].as_array().unwrap().len(),
        1
    );
    // Ticked, the day's address reads the tick.
    let (status, read) = call(&app, "GET", &format!("{ENTRIES}/{uid}"), None).await;
    assert_eq!((status, &read["id"]), (StatusCode::OK, &entry["id"]));
    // An unknown or another profile's series is the field's fault; the old
    // field is refused by name.
    for (body, field) in [
        (
            json!({ "day": NEXT, "group": "Eaten", "repeat_of": 999 }),
            "repeat_of",
        ),
        (
            json!({ "day": NEXT, "group": "Eaten", "daily_item_id": series(&first) }),
            "daily_item_id",
        ),
    ] {
        let (status, res) = call(&app, "POST", ENTRIES, Some(body)).await;
        assert_eq!(
            (status, &res["field"]),
            (StatusCode::BAD_REQUEST, &json!(field)),
            "{res}"
        );
    }
}

#[tokio::test]
async fn skip_is_idempotent_and_restores() {
    let app = app();
    let first = shake(&app).await;
    let skip = format!("{ENTRIES}/{}", key(&first, LATER));
    for _ in 0..2 {
        let (status, res) = call(&app, "DELETE", &skip, None).await;
        assert_eq!(status, StatusCode::NO_CONTENT, "{res}");
        assert_eq!(due(&app, LATER).await, Vec::<String>::new());
    }
    assert_eq!(due(&app, NEXT).await.len(), 1, "only that day");
    let (status, _) = call(&app, "GET", &skip, None).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "skipped: not due");
    for _ in 0..2 {
        let (status, res) = call(&app, "PUT", &skip, None).await;
        assert_eq!(status, StatusCode::NO_CONTENT, "{res}");
        assert_eq!(due(&app, LATER).await.len(), 1);
    }
    // Any date (skip ahead), but a date; an unknown series is 404.
    let ahead = format!("{ENTRIES}/{}", key(&first, "2030-01-01"));
    let (status, _) = call(&app, "DELETE", &ahead, None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    for (uri, want) in [
        (
            format!("{ENTRIES}/daily-{}-tomorrow", series(&first)),
            StatusCode::BAD_REQUEST,
        ),
        (
            format!("{ENTRIES}/daily-999-{LATER}"),
            StatusCode::NOT_FOUND,
        ),
    ] {
        let (status, res) = call(&app, "DELETE", &uri, None).await;
        assert_eq!(status, want, "{uri}: {res}");
    }
    // PUT restores a due day only.
    let (status, _) = call(&app, "PUT", &format!("{ENTRIES}/{}", first["id"]), None).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn deleting_a_tick_makes_the_day_due_again() {
    let app = app();
    let first = shake(&app).await;
    let (_, ticked) = tick(&app, &first, NEXT, &key(&first, NEXT)).await;
    let (status, _) = call(
        &app,
        "DELETE",
        &format!("{ENTRIES}/{}", ticked["entries"][0]["id"]),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(due(&app, NEXT).await, [key(&first, NEXT)]);
    // And the same tick again logs it again.
    let (status, again) = tick(&app, &first, NEXT, &key(&first, NEXT)).await;
    assert_eq!(status, StatusCode::CREATED, "{again}");
}

#[tokio::test]
async fn stop_keeps_ticks() {
    let app = app();
    let first = shake(&app).await;
    let (_, ticked) = tick(&app, &first, NEXT, &key(&first, NEXT)).await;
    let tick_uri = format!("{ENTRIES}/{}", ticked["entries"][0]["id"]);
    // Stopped from a due day's address: the series goes.
    let (status, stopped) = call(
        &app,
        "PATCH",
        &format!("{ENTRIES}/{}", key(&first, LATER)),
        Some(json!({ "repeat": null })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{stopped}");
    assert_eq!(stopped["repeat"], Value::Null);
    assert_eq!(due(&app, LATER).await, Vec::<String>::new());
    // Its ticks stay, unlinked.
    let (status, kept) = call(&app, "GET", &tick_uri, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        (&kept["repeat"], &kept["grams"]),
        (&Value::Null, &json!(30.0))
    );
    let (status, _) = call(
        &app,
        "GET",
        &format!("{ENTRIES}/{}", key(&first, LATER)),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    // Stopping what doesn't repeat changes nothing.
    let (status, again) = call(&app, "PATCH", &tick_uri, Some(json!({ "repeat": null }))).await;
    assert_eq!((status, &again["repeat"]), (StatusCode::OK, &Value::Null));
    // Repeated again, then stopped from a tick's own address.
    let (status, restarted) = repeat(&app, &kept, NEXT).await;
    assert_eq!(status, StatusCode::OK, "{restarted}");
    assert_eq!(due(&app, LATER).await.len(), 1);
    let (status, _) = call(&app, "PATCH", &tick_uri, Some(json!({ "repeat": null }))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(due(&app, LATER).await, Vec::<String>::new());
}

#[tokio::test]
async fn series_edit_reaches_future_unticked_days() {
    let app = app();
    let food = create_food(&app, "Shake", json!({ "energy": 400.0 })).await;
    let (status, _) = put_with_rev(
        &app,
        &format!("/api/foods/{food}"),
        json!({ "servings": [{ "label": "Scoop", "grams": 25.0 }] }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let entry = log_entry(&app, "Eaten", food, 30.0).await;
    let (_, first) = repeat(&app, &entry, DAY).await;
    let (_, ticked) = tick(&app, &first, NEXT, &key(&first, NEXT)).await;
    let uri = format!("{ENTRIES}/{}", key(&first, "2026-10-08"));
    let (status, edited) = call(
        &app,
        "PATCH",
        &uri,
        Some(json!({ "group": "Planned", "serving": "Scoop", "quantity": 2 })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{edited}");
    assert_eq!(
        (&edited["grams"], &edited["amount"], &edited["id"]),
        (&json!(50.0), &json!("2 × Scoop (50 g)"), &Value::Null)
    );
    // Past and future un-ticked days show the new amount; the tick keeps
    // its snapshot.
    for day in ["2026-10-08", "2030-01-01"] {
        let d = day_view(&app, day).await;
        assert_eq!(
            group(&d, "Planned")["entries"][0]["nutrients"]["energy"],
            200.0,
            "{day}"
        );
    }
    let next = day_view(&app, NEXT).await;
    assert_eq!(
        group(&next, "Eaten")["entries"][0]["grams"],
        ticked["entries"][0]["grams"]
    );
    let (status, edited) = call(&app, "PATCH", &uri, Some(json!({ "grams": 60 }))).await;
    assert_eq!((status, &edited["serving"]), (StatusCode::OK, &Value::Null));
    // A due day stays in Planned (a tick moves it); its time is a tick's.
    for (body, field) in [
        (json!({ "serving": "Cup", "quantity": 1 }), json!("serving")),
        (json!({ "grams": 0 }), Value::Null),
        (json!({ "group": "Eaten" }), json!("group")),
        (json!({ "time": "08:00" }), json!("time")),
    ] {
        let (status, res) = call(&app, "PATCH", &uri, Some(body)).await;
        assert_eq!(
            (status, &res["field"]),
            (StatusCode::BAD_REQUEST, &field),
            "{res}"
        );
    }
}

#[tokio::test]
async fn due_days_count_nowhere_until_ticked() {
    let app = app();
    let food = create_food(
        &app,
        "Creatine",
        json!({ "creatine": 100.0, "energy": 0.0 }),
    )
    .await;
    let entry = log_entry(&app, "Eaten", food, 5.0).await;
    let (_, first) = repeat(&app, &entry, DAY).await;
    let counted = |app: Router| async move {
        let range = format!("from={NEXT}&to={NEXT}");
        let (_, summary) = call(
            &app,
            "GET",
            &format!("/api/profiles/1/summary?{range}"),
            None,
        )
        .await;
        let (_, habits) = call(
            &app,
            "GET",
            &format!("/api/profiles/1/habits/days?{range}"),
            None,
        )
        .await;
        let (_, sources) = call(
            &app,
            "GET",
            &format!("/api/profiles/1/summary/foods?{range}&nutrient=creatine"),
            None,
        )
        .await;
        let d = day_view(&app, NEXT).await;
        let creatine = |list: &Value| {
            list.as_array()
                .unwrap()
                .iter()
                .any(|b| b["habit"] == "creatine")
        };
        (
            summary["days"].as_array().unwrap().len(),
            creatine(&habits),
            creatine(&d["builtins"]),
            sources["foods"].as_array().unwrap().len(),
        )
    };
    assert_eq!(counted(app.clone()).await, (0, false, false, 0));
    tick(&app, &first, NEXT, &key(&first, NEXT)).await;
    assert_eq!(counted(app.clone()).await, (1, true, true, 1));
}

#[tokio::test]
async fn repeat_daily_from_an_entry() {
    let mut conn = open(FsPath::new(":memory:")).unwrap();
    let csv = "Day,Group,Food Name,Amount\n2026-06-02,Consumed,Rye Bread,70.00 g\n";
    common::import_servings(&mut conn, common::ME, csv.as_bytes()).unwrap();
    let app = app_from(conn, NO_OFF);
    let history = group(&day_view(&app, "2026-06-02").await, "Eaten")["entries"][0].clone();
    let (status, res) = repeat(&app, &history, DAY).await;
    assert_eq!(
        (status, &res["code"]),
        (StatusCode::CONFLICT, &json!("imported_read_only"))
    );

    let food = create_food(&app, "Shake", json!({ "energy": 400.0 })).await;
    let entry = log_entry(&app, "Eaten", food, 30.0).await;
    let (status, res) = repeat(&app, &entry, "06.10.2026").await;
    assert_eq!(
        (status, &res["field"]),
        (StatusCode::BAD_REQUEST, &json!("repeat")),
        "{res}"
    );
    // No start: the entry's day.
    let (status, first) = call(
        &app,
        "PATCH",
        &format!("{ENTRIES}/{}", entry["id"]),
        Some(json!({ "repeat": {} })),
    )
    .await;
    assert_eq!(
        (status, &first["repeat"]["start"]),
        (StatusCode::OK, &json!(DAY)),
        "{first}"
    );
    let (status, res) = repeat(&app, &entry, DAY).await;
    assert_eq!(
        (status, &res["code"]),
        (StatusCode::CONFLICT, &json!("already_daily")),
        "an entry repeats once"
    );

    // At most DAILY_ITEMS_MAX (served in meta), the first included.
    let (_, meta) = call(&app, "GET", "/api/meta", None).await;
    let max = meta["limits"]["daily_items"].as_u64().unwrap();
    for i in 1..max {
        let e = log_entry_on(&app, &format!("2026-09-{i:02}"), "Eaten", food, 10.0).await;
        let (status, res) = repeat(&app, &e, DAY).await;
        assert_eq!(status, StatusCode::OK, "{i}: {res}");
    }
    let e = log_entry_on(&app, "2026-08-01", "Eaten", food, 10.0).await;
    let (status, res) = repeat(&app, &e, DAY).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{res}");
}

#[tokio::test]
async fn daily_items_routes_are_gone() {
    let app = app();
    let first = shake(&app).await;
    let item = series(&first);
    for (method, uri) in [
        ("POST", "/api/profiles/1/daily-items".to_owned()),
        ("GET", format!("/api/profiles/1/daily-items/{item}")),
        ("PATCH", format!("/api/profiles/1/daily-items/{item}")),
        ("DELETE", format!("/api/profiles/1/daily-items/{item}")),
        (
            "PUT",
            format!("/api/profiles/1/daily-items/{item}/days/{NEXT}"),
        ),
        (
            "DELETE",
            format!("/api/profiles/1/daily-items/{item}/days/{NEXT}"),
        ),
    ] {
        let (status, _) = call(&app, method, &uri, Some(json!({}))).await;
        assert!(
            status == StatusCode::NOT_FOUND || status == StatusCode::METHOD_NOT_ALLOWED,
            "{method} {uri}: {status}"
        );
    }
    // An address that is neither an id nor a due day's.
    let (status, _) = call(&app, "GET", &format!("{ENTRIES}/daily-x"), None).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

/// The log screen's "Repeat daily": a food logged with `repeat` starts its
/// series in the same write (one request, so it queues offline as one).
/// Only a food repeats; a bad start is refused.
#[tokio::test]
async fn logging_a_food_can_start_its_series() {
    let app = app();
    let food = create_food(&app, "Shake", json!({ "energy": 400.0 })).await;
    let (status, made) = call(
        &app,
        "POST",
        ENTRIES,
        Some(
            json!({ "day": DAY, "group": "Eaten", "food_id": food, "grams": 30.0,
                     "repeat": { "start": DAY } }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{made}");
    let entry = &made["entries"][0];
    assert_eq!(entry["repeat"]["start"], DAY, "{entry}");
    assert_eq!(due(&app, NEXT).await, [key(entry, NEXT)]);
    for (body, field) in [
        (
            json!({ "food_id": food, "grams": 30.0, "repeat": { "start": "x" } }),
            "repeat",
        ),
        (
            json!({ "entry_ids": [entry["id"]], "repeat": {} }),
            "repeat",
        ),
    ] {
        let mut body = body;
        body["day"] = json!(DAY);
        body["group"] = json!("Eaten");
        let (status, err) = call(&app, "POST", ENTRIES, Some(body)).await;
        assert_eq!(
            (status, &err["field"]),
            (StatusCode::BAD_REQUEST, &json!(field)),
            "{err}"
        );
    }
}
