//! The diary's clock (`/api/now`) and its trends (`/trends`).

use jiff::Timestamp;
use jiff::tz::TimeZone;
use kaloriina::AppState;

use super::*;

/// An app whose server days follow `tz`.
fn app_in(tz: &str) -> Router {
    let mut state = AppState::new(open(FsPath::new(":memory:")).unwrap(), NO_OFF.to_owned());
    state.tz = TimeZone::get(tz).unwrap();
    kaloriina::router(state)
}

#[tokio::test]
async fn now_names_the_diary_day_in_the_servers_zone() {
    let app = app_in("Europe/Helsinki");
    let tz = TimeZone::get("Europe/Helsinki").unwrap();
    let day = || kaloriina::model::diary_day_at(&Timestamp::now().to_zoned(tz.clone())).to_string();
    let before = day();
    let (status, now) = call(&app, "GET", "/api/now", None).await;
    let after = day();
    assert_eq!(status, StatusCode::OK, "{now}");
    assert!(now["day"] == before || now["day"] == after, "{now}");
    assert_eq!(now["day_start"], "03:00");
    assert_eq!(now["time_zone"], "Europe/Helsinki");
    let time = now["time"].as_str().unwrap();
    assert!(kaloriina::model::day_minute(time).is_some(), "{now}");
}

/// Profile 1's trends for `query`.
async fn trends(app: &Router, query: &str) -> (StatusCode, Value) {
    call(app, "GET", &format!("/api/profiles/1/trends?{query}"), None).await
}

/// "Creatine" logged on `start` and repeated daily from it: the series id.
async fn daily_from(app: &Router, start: &str) -> i64 {
    let creatine = create_food(app, "Creatine", json!({ "energy": 0.0 })).await;
    let entry = log_entry_on(app, start, "Eaten", creatine, 5.0).await;
    let (status, e) = call(
        app,
        "PATCH",
        &format!("/api/profiles/1/entries/{}", entry["key"].as_str().unwrap()),
        Some(json!({ "repeat": { "start": start } })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{e}");
    e["repeat"]["id"].as_i64().unwrap()
}

#[tokio::test]
async fn trends_mean_the_counted_days_trend_the_weight_and_count_the_daily_items() {
    let app = app();
    let oats = create_food(&app, "Oats", json!({ "energy": 400.0, "protein": 10.0 })).await;
    let beer = create_food(&app, "Beer", json!({ "energy": 43.0, "alcohol": 4.0 })).await;
    log_entry_on(&app, "2026-10-05", "Eaten", oats, 500.0).await;
    log_entry_on(&app, "2026-10-06", "Eaten", oats, 500.0).await;
    log_entry_on(&app, "2026-10-06", "Eaten", beer, 500.0).await;
    // A day with a kcal-less text entry: not all of it is known.
    log_entry_on(&app, "2026-10-07", "Eaten", oats, 500.0).await;
    let (status, e) = call(
        &app,
        "POST",
        "/api/profiles/1/entries",
        Some(json!({ "day": "2026-10-07", "group": "Eaten", "name": "Cake", "energy": null })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{e}");
    for (day, kg) in [("2026-09-29", 80.0), ("2026-10-03", 81.0)] {
        let uri = format!("/api/profiles/1/weights/{day}");
        let (status, w) = call(&app, "PUT", &uri, Some(json!({ "kg": kg }))).await;
        assert_eq!(status, StatusCode::OK, "{w}");
    }
    let item = daily_from(&app, "2026-10-05").await;
    let skip = format!("/api/profiles/1/entries/daily-{item}-2026-10-08");
    let (status, _) = call(&app, "DELETE", &skip, None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, e) = call(
        &app,
        "POST",
        "/api/profiles/1/entries",
        Some(json!({ "day": "2026-10-09", "group": "Eaten", "repeat_of": item })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{e}");

    let (status, t) = trends(&app, "from=2026-10-01&to=2026-10-20").await;
    assert_eq!(status, StatusCode::OK, "{t}");
    assert_eq!(
        (&t["from"], &t["to"], &t["by"]),
        (&json!("2026-10-01"), &json!("2026-10-20"), &json!("week"))
    );
    let spans: Vec<_> = t["buckets"]
        .as_array()
        .unwrap()
        .iter()
        .map(|b| (b["start"].as_str().unwrap(), b["end"].as_str().unwrap()))
        .collect();
    assert_eq!(
        spans,
        [
            ("2026-10-01", "2026-10-04"),
            ("2026-10-05", "2026-10-11"),
            ("2026-10-12", "2026-10-18"),
            ("2026-10-19", "2026-10-20"),
        ]
    );
    let first = &t["buckets"][0];
    assert_eq!(
        (&first["days"], &first["energy"], &first["weight_kg"]),
        (&json!(0), &Value::Null, &json!(80.5)),
        "the weight before the range feeds the trend: {first}"
    );
    assert_eq!(first["weighed_days"], 1);
    let week = &t["buckets"][1];
    assert_eq!(week["days"], 2, "not the day with the cake: {week}");
    assert_eq!(week["energy"], 2107.5);
    assert_eq!(week["protein"], 50.0);
    assert_eq!(week["alcohol"], 10.0, "0 g on the day without");
    assert_eq!(week["weight_kg"], Value::Null);
    assert_eq!(week["daily"], json!({ "ticked": 2, "due": 6 }), "{week}");
    assert_eq!(
        t["daily_items"],
        json!([{ "id": item, "food_id": t["daily_items"][0]["food_id"],
                 "name": "Creatine", "ticked": 2, "due": 15 }])
    );

    let (status, t) = trends(&app, "from=2026-10-01&to=2026-10-20&by=month").await;
    assert_eq!(status, StatusCode::OK, "{t}");
    let month = &t["buckets"][0];
    assert_eq!(t["buckets"].as_array().unwrap().len(), 1, "{t}");
    assert_eq!(
        (&month["days"], &month["energy"]),
        (&json!(2), &json!(2107.5))
    );
}

#[tokio::test]
async fn trends_leave_the_diary_today_out() {
    let app = app();
    let today = kaloriina::model::diary_day_at(&Timestamp::now().to_zoned(TimeZone::UTC));
    let yesterday = today.yesterday().unwrap().to_string();
    let today = today.to_string();
    let oats = create_food(&app, "Oats", json!({ "energy": 400.0 })).await;
    log_entry_on(&app, &yesterday, "Eaten", oats, 100.0).await;
    log_entry_on(&app, &today, "Eaten", oats, 900.0).await;
    daily_from(&app, &yesterday).await;
    let (status, t) = trends(&app, &format!("from={yesterday}&to={today}&by=month")).await;
    assert_eq!(status, StatusCode::OK, "{t}");
    let buckets = t["buckets"].as_array().unwrap();
    let sum = |key: &str| {
        buckets
            .iter()
            .map(|b| b[key].as_i64().unwrap_or(0))
            .sum::<i64>()
    };
    assert_eq!(sum("days"), 1, "{t}");
    let energy: Vec<_> = buckets.iter().map(|b| b["energy"].clone()).collect();
    assert!(energy.contains(&json!(400.0)), "{t}");
    assert_eq!(t["daily_items"][0]["due"], 1, "{t}");
}

#[tokio::test]
async fn trends_refuse_a_wrong_range_or_bucket() {
    let app = app();
    for (query, field) in [
        ("from=2026-10-01&to=2026-10-20&by=year", json!("by")),
        ("from=2026-10-20&to=2026-10-01", json!("from")),
        ("from=2026-10-01", Value::Null),
    ] {
        let (status, e) = trends(&app, query).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{query}: {e}");
        assert_eq!(
            (&e["code"], &e["field"]),
            (&json!("invalid"), &field),
            "{query}"
        );
    }
    let (status, e) = trends(&app, "from=2026-10-01&to=2026-10-20&by=year").await;
    assert_eq!(
        (status, &e["error"]),
        (StatusCode::BAD_REQUEST, &json!("By must be week or month"))
    );
    let (status, _) = call(
        &app,
        "GET",
        "/api/profiles/9/trends?from=2026-10-01&to=2026-10-02",
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn trends_refuse_a_range_of_too_many_buckets() {
    let app = app_in("UTC");
    for (query, ok) in [
        ("from=2016-01-01&to=2026-11-15&by=week", true),
        ("from=1900-01-01&to=2026-11-15&by=week", false),
        ("from=1980-01-01&to=2026-11-15&by=month", true),
        ("from=0001-01-01&to=9999-12-31&by=month", false),
    ] {
        let uri = format!("/api/profiles/1/trends?{query}");
        let (status, body) = call(&app, "GET", &uri, None).await;
        if ok {
            assert_eq!(status, StatusCode::OK, "{query}: {body}");
        } else {
            assert_eq!(status, StatusCode::BAD_REQUEST, "{query}: {body}");
            assert_eq!(body["field"], "from", "{query}: {body}");
        }
    }
}
