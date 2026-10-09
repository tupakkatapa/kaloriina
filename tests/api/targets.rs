//! Goals as targets: one `metric` per row from the nutrient registry and
//! `meta.metrics`; registry defaults apply without a row; the profile's
//! `rev` guards a write.

use super::*;

async fn targets(app: &Router, pid: i64) -> Value {
    let (status, list) = call(app, "GET", &format!("/api/profiles/{pid}/targets"), None).await;
    assert_eq!(status, StatusCode::OK, "{list}");
    list
}

fn find<'a>(list: &'a Value, metric: &str) -> Option<&'a Value> {
    list.as_array()
        .unwrap()
        .iter()
        .find(|t| t["metric"] == metric)
}

/// PUT `[{metric, value}]` at profile `pid`'s current rev.
async fn put(app: &Router, pid: i64, list: Value) -> (StatusCode, Value) {
    put_targets(app, pid, list).await
}

#[tokio::test]
async fn targets_round_trip_by_metric() {
    let app = app();
    let (status, saved) = put(
        &app,
        1,
        json!([
            { "metric": "energy", "value": 2000 },
            { "metric": "sodium", "value": 2000 },
            { "metric": "workouts_per_week", "value": 3 },
            { "metric": "goal_weight", "value": 70.5 },
            { "metric": "sleep_min", "value": 450 },
        ]),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    assert_eq!(saved, targets(&app, 1).await);
    let energy = find(&saved, "energy").unwrap();
    assert_eq!(
        (&energy["value"], &energy["min"], &energy["max"]),
        (&json!(2000.0), &json!(2000.0), &json!(2200.0))
    );
    let sodium = find(&saved, "sodium").unwrap();
    assert_eq!(
        (&sodium["min"], &sodium["max"]),
        (&Value::Null, &json!(2000.0))
    );
    let weekly = find(&saved, "workouts_per_week").unwrap();
    assert_eq!(
        (&weekly["value"], &weekly["min"]),
        (&json!(3.0), &json!(3.0))
    );
    let goal = find(&saved, "goal_weight").unwrap();
    assert_eq!(
        (&goal["value"], &goal["min"], &goal["max"]),
        (&json!(70.5), &Value::Null, &Value::Null),
        "a point to reach, not a window"
    );
    let sleep = find(&saved, "sleep_min").unwrap();
    assert_eq!(sleep["value"], 450.0);
    assert_eq!(sleep.get("default"), None, "set, not a default");
}

#[tokio::test]
async fn unknown_or_out_of_range_metrics_are_400() {
    let app = app();
    for (list, word) in [
        (json!([{ "metric": "bogus", "value": 1 }]), "bogus"),
        (
            json!([{ "metric": "category:nope", "value": 1 }]),
            "category:nope",
        ),
        (json!([{ "metric": "steps", "value": -1 }]), "Steps"),
        (
            json!([{ "metric": "workouts_per_week", "value": 15 }]),
            "Workouts",
        ),
        (
            json!([{ "metric": "goal_weight", "value": 10 }]),
            "Goal weight",
        ),
        (
            json!([{ "metric": "steps", "value": 1 }, { "metric": "steps", "value": 2 }]),
            "twice",
        ),
    ] {
        let (status, err) = put(&app, 1, list.clone()).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{list}: {err}");
        assert!(err["error"].as_str().unwrap().contains(word), "{err}");
    }
}

#[tokio::test]
async fn defaults_apply_without_a_row() {
    // Steps and sleep are recommended for everyone, without seeding, so
    // profiles made later get them too.
    let app = app();
    let (status, anna) = call(
        &app,
        "POST",
        "/api/profiles",
        Some(
            json!({ "name": "Anna", "sex": null, "birth_date": null, "height_cm": null,
                     "activity": null, "goal_kg_per_week": 0 }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{anna}");
    for pid in [1, anna["id"].as_i64().unwrap()] {
        let list = targets(&app, pid).await;
        let steps = find(&list, "steps").unwrap();
        assert_eq!(
            (&steps["value"], &steps["min"], &steps["default"]),
            (&json!(10000.0), &json!(10000.0), &json!(true)),
            "{pid}: {list}"
        );
        assert_eq!(find(&list, "sleep_min").unwrap()["value"], 420.0);
        assert_eq!(find(&list, "workouts_per_week"), None, "no default");
    }
}

#[tokio::test]
async fn a_set_value_overrides_the_default() {
    let app = app();
    let (status, saved) = put(&app, 1, json!([{ "metric": "steps", "value": 8000 }])).await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    let steps = find(&saved, "steps").unwrap();
    assert_eq!(
        (&steps["value"], steps.get("default")),
        (&json!(8000.0), None)
    );
    // Left out again, the default is back: a default can be changed, not removed.
    let (_, saved) = put(&app, 1, json!([])).await;
    assert_eq!(find(&saved, "steps").unwrap()["default"], true);
}

#[tokio::test]
async fn a_stale_rev_is_409() {
    let app = app();
    let (_, me) = call(&app, "GET", "/api/profiles/1", None).await;
    let body = json!({ "rev": me["rev"], "targets": [{ "metric": "steps", "value": 9000 }] });
    let (status, _) = call(&app, "PUT", "/api/profiles/1/targets", Some(body.clone())).await;
    assert_eq!(status, StatusCode::OK);
    let (status, err) = call(&app, "PUT", "/api/profiles/1/targets", Some(body)).await;
    assert_eq!(status, StatusCode::CONFLICT, "{err}");
    assert_eq!(err["code"], "stale");
}

#[tokio::test]
async fn steps_and_sleep_are_recommended() {
    let app = app();
    let mut anna = json!({ "name": "Anna", "sex": "female", "birth_date": "1990-05-01",
                           "height_cm": 170, "activity": 1.6, "goal_kg_per_week": 0 });
    let (_, p) = call(&app, "POST", "/api/profiles", Some(anna.clone())).await;
    let pid = p["id"].as_i64().unwrap();
    let rec = format!("/api/profiles/{pid}/recommended");
    let (status, err) = call(&app, "GET", &rec, None).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "no weigh-in yet: {err}");
    call(
        &app,
        "PUT",
        &format!("/api/profiles/{pid}/weights/{DAY}"),
        Some(json!({ "kg": 60 })),
    )
    .await;
    let (status, list) = call(&app, "GET", &rec, None).await;
    assert_eq!(status, StatusCode::OK, "{list}");
    assert_eq!(find(&list, "steps").unwrap()["value"], 10000.0);
    assert_eq!(find(&list, "sleep_min").unwrap()["value"], 420.0);
    anna["name"] = json!("Bea");
    let (_, bea) = call(&app, "POST", "/api/profiles", Some(anna)).await;
    assert_eq!(bea["latest_weight_kg"], Value::Null);
}

#[tokio::test]
async fn goal_weight_is_bounded_and_nullable() {
    let app = app();
    // The body weight's range, inclusive.
    for ok in [30.0, 300.0, 72.5] {
        let (status, p) =
            put_targets(&app, 1, json!([{ "metric": "goal_weight", "value": ok }])).await;
        assert_eq!(status, StatusCode::OK, "{ok}: {p}");
    }
    assert_eq!(goal_weight(&app, &json!(1)).await, 72.5);
    for bad in [29.9, 300.1] {
        let (status, e) =
            put_targets(&app, 1, json!([{ "metric": "goal_weight", "value": bad }])).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{bad}: {e}");
    }
    // Left out of the list, it is cleared.
    let (status, _) = put_targets(&app, 1, json!([])).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(goal_weight(&app, &json!(1)).await, Value::Null);
}
