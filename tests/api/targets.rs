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
        (&json!(2000.0), &json!(1900.0), &json!(2100.0))
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
            "Activities",
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
    // Left out again, the default is back: a default can be changed, not
    // removed.
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

/// ADR 0020: the energy target is the client's model's. `/recommended`
/// never gives one; the client passes it, and the targets that are a share
/// of energy scale with it.
#[tokio::test]
async fn recommended_scales_with_the_clients_energy() {
    let app = app();
    let anna = json!({ "name": "Anna", "sex": "female", "birth_date": "1990-05-01",
                       "height_cm": 170, "activity": 1.6, "goal_kg_per_week": 0 });
    let (_, p) = call(&app, "POST", "/api/profiles", Some(anna)).await;
    let pid = p["id"].as_i64().unwrap();
    call(
        &app,
        "PUT",
        &format!("/api/profiles/{pid}/weights/{DAY}"),
        Some(json!({ "kg": 60 })),
    )
    .await;
    let rec = |q: &str| format!("/api/profiles/{pid}/recommended{q}");
    let (status, bare) = call(&app, "GET", &rec(""), None).await;
    assert_eq!(status, StatusCode::OK, "{bare}");
    assert!(find(&bare, "energy").is_none(), "{bare}");
    assert!(find(&bare, "fat").is_none(), "a share of energy: {bare}");
    assert_eq!(find(&bare, "iron").unwrap()["value"], 16.0);
    let (status, list) = call(&app, "GET", &rec("?energy=1800"), None).await;
    assert_eq!(status, StatusCode::OK, "{list}");
    assert!(find(&list, "energy").is_none(), "{list}");
    // Fat 30 % of 1,800 kcal at 9 kcal a gram.
    assert_eq!(find(&list, "fat").unwrap()["value"], 60.0);
    for bad in ["0", "-5", "NaN"] {
        let (status, err) = call(&app, "GET", &rec(&format!("?energy={bad}")), None).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{bad}: {err}");
    }
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

#[tokio::test]
async fn energy_body_and_schedule_goals_are_metrics() {
    let app = app();
    let (_, meta) = call(&app, "GET", "/api/meta", None).await;
    let metric = |key: &str| {
        meta["metrics"]
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["key"] == key)
            .unwrap_or_else(|| panic!("no {key} in meta"))
            .clone()
    };
    let active = metric("active_kcal");
    assert_eq!(
        (
            &active["label"],
            &active["goal"],
            &active["per"],
            &active["section"]
        ),
        (
            &json!("Active energy"),
            &json!("at_least"),
            &json!("day"),
            &json!("activity")
        )
    );
    let fat = metric("goal_body_fat");
    assert_eq!((&fat["unit"], &fat["per"]), (&json!("%"), &json!("once")));
    for key in ["bedtime", "wake_time"] {
        let m = metric(key);
        assert_eq!(
            (&m["goal"], &m["per"], &m["display"]["input"], &m["range"]),
            (
                &json!("about"),
                &json!("day"),
                &json!("time"),
                &json!([0.0, 1439.0])
            ),
            "{key}"
        );
    }
    assert_eq!(metric("steps")["display"]["input"], "number");

    for (key, bad) in [
        ("bedtime", 1440.0),
        ("wake_time", -1.0),
        ("goal_body_fat", 2.0),
        ("goal_body_fat", 61.0),
        ("active_kcal", -1.0),
    ] {
        let (status, e) = put(&app, 1, json!([{ "metric": key, "value": bad }])).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{key} {bad}: {e}");
    }
    let (status, saved) = put(
        &app,
        1,
        json!([
            { "metric": "active_kcal", "value": 500 },
            { "metric": "goal_body_fat", "value": 18 },
            { "metric": "bedtime", "value": 1430 },
            { "metric": "wake_time", "value": 420 },
        ]),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    let bounds = |key: &str| {
        let t = find(&saved, key).unwrap();
        (t["min"].clone(), t["max"].clone())
    };
    assert_eq!(bounds("active_kcal"), (json!(500.0), Value::Null));
    assert_eq!(bounds("goal_body_fat"), (Value::Null, Value::Null));
    // A clock time's window is ±30 min, mod 1440: across midnight min > max.
    assert_eq!(bounds("bedtime"), (json!(1400.0), json!(20.0)));
    assert_eq!(bounds("wake_time"), (json!(390.0), json!(450.0)));
}

/// A goal date set while it was ahead stays savable once it has passed:
/// only a changed goal date must be after today.
#[tokio::test]
async fn a_passed_goal_date_saves_unchanged_and_clears() {
    let app = app();
    let (_, me) = call(&app, "GET", "/api/profiles/1", None).await;
    // Set on 2026-01-01 (the client's day), due 2026-02-01: now passed.
    let mut body = me.clone();
    body["goal_date"] = json!("2026-02-01");
    body["day"] = json!("2026-01-01");
    let (status, p) = call(&app, "PUT", "/api/profiles/1", Some(body)).await;
    assert_eq!(status, StatusCode::OK, "{p}");
    // Any other edit echoes it back.
    let mut b = p.clone();
    b["name"] = json!("Renamed");
    let (status, saved) = call(&app, "PUT", "/api/profiles/1", Some(b)).await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    assert_eq!(saved["goal_date"], "2026-02-01");
    // Moving it to another passed day is refused, clearing it is not.
    let mut b = saved.clone();
    b["goal_date"] = json!("2026-03-01");
    let (status, e) = call(&app, "PUT", "/api/profiles/1", Some(b)).await;
    assert_eq!(
        (status, &e["field"]),
        (StatusCode::BAD_REQUEST, &json!("goal_date"))
    );
    let mut b = saved.clone();
    b["goal_date"] = Value::Null;
    let (status, cleared) = call(&app, "PUT", "/api/profiles/1", Some(b)).await;
    assert_eq!(
        (status, &cleared["goal_date"]),
        (StatusCode::OK, &Value::Null)
    );
}

#[tokio::test]
async fn a_goal_date_is_a_date_or_null() {
    let app = app();
    let (_, me) = call(&app, "GET", "/api/profiles/1", None).await;
    assert_eq!(me["goal_date"], Value::Null);
    let mut body = me.clone();
    body["goal_date"] = json!("2027-03-01");
    let (status, p) = call(&app, "PUT", "/api/profiles/1", Some(body.clone())).await;
    assert_eq!(status, StatusCode::OK, "{p}");
    assert_eq!(p["goal_date"], "2027-03-01");
    for bad in [json!("2027-02-30"), json!("soon"), json!(3)] {
        let mut b = p.clone();
        b["goal_date"] = bad.clone();
        let (status, e) = call(&app, "PUT", "/api/profiles/1", Some(b)).await;
        assert!(status.is_client_error(), "{bad}: {e}");
    }
    // PUT replaces the whole profile: leaving it out is no way to clear it.
    let mut b = p.clone();
    b.as_object_mut().unwrap().remove("goal_date");
    let (status, e) = call(&app, "PUT", "/api/profiles/1", Some(b)).await;
    assert_eq!(
        (status, &e["field"]),
        (StatusCode::BAD_REQUEST, &json!("goal_date"))
    );
}

/// Set profile 1's sex and height.
async fn body_of(app: &Router, sex: Value, height_cm: Value) {
    let (_, mut me) = call(app, "GET", "/api/profiles/1", None).await;
    me["sex"] = sex;
    me["height_cm"] = height_cm;
    let (status, p) = call(app, "PUT", "/api/profiles/1", Some(me)).await;
    assert_eq!(status, StatusCode::OK, "{p}");
}

/// Each list's verdict: `None` saved, else the field it was refused for.
async fn verdicts(app: &Router, cases: &[Value]) -> Vec<Option<String>> {
    let mut out = Vec::new();
    for list in cases {
        let (status, res) = put(app, 1, list.clone()).await;
        out.push(match status {
            StatusCode::OK => None,
            StatusCode::BAD_REQUEST => Some(res["field"].as_str().unwrap_or_default().to_owned()),
            other => panic!("{list}: {other} {res}"),
        });
    }
    out
}

fn one(metric: &str, value: f64) -> Value {
    json!([{ "metric": metric, "value": value }])
}

/// The plain ranges, at their edges: steps to 60,000, sleep 4–14 h,
/// energy 800–6,000 kcal.
#[tokio::test]
async fn target_ranges_hold_at_their_edges() {
    let app = app();
    let cases = [
        one("steps", 60_000.0),
        one("steps", 60_001.0),
        one("sleep_min", 240.0),
        one("sleep_min", 239.0),
        one("sleep_min", 840.0),
        one("sleep_min", 841.0),
        one("energy", 800.0),
        one("energy", 799.0),
        one("energy", 6_000.0),
        one("energy", 6_001.0),
    ];
    let field = |f: &str| Some(f.to_owned());
    assert_eq!(
        verdicts(&app, &cases).await,
        [
            None,
            field("steps"),
            None,
            field("sleep_min"),
            None,
            field("sleep_min"),
            None,
            field("energy"),
            None,
            field("energy"),
        ]
    );
}

/// Body goals a body can reach: body fat above essential fat (5 % for
/// men or anyone, 12 % for women), muscle within the lean mass, a goal
/// weight within BMI 15–40 for the height.
#[tokio::test]
async fn body_goals_are_reachable() {
    let app = app();
    let field = |f: &str| Some(f.to_owned());
    // No sex given: the lower floor.
    assert_eq!(
        verdicts(
            &app,
            &[one("goal_body_fat", 4.9), one("goal_body_fat", 5.0)]
        )
        .await,
        [field("goal_body_fat"), None]
    );
    body_of(&app, json!("female"), json!(180.0)).await;
    assert_eq!(
        verdicts(
            &app,
            &[one("goal_body_fat", 11.9), one("goal_body_fat", 12.0)]
        )
        .await,
        [field("goal_body_fat"), None]
    );
    let (_, e) = put(&app, 1, one("goal_body_fat", 11.9)).await;
    assert!(
        e["error"]
            .as_str()
            .unwrap()
            .contains("essential fat for women"),
        "{e}"
    );
    body_of(&app, json!("male"), json!(180.0)).await;
    assert_eq!(verdicts(&app, &[one("goal_body_fat", 5.0)]).await, [None]);
    // 40 % fat: muscle at most 62 % of the lean 60 % = 37.2 %.
    let both = |muscle: f64| {
        json!([{ "metric": "goal_body_fat", "value": 40.0 },
               { "metric": "goal_muscle", "value": muscle }])
    };
    // 180 cm: BMI 15–40 is 48.6–129.6 kg.
    assert_eq!(
        verdicts(
            &app,
            &[
                both(37.2),
                both(37.3),
                one("goal_weight", 48.5),
                one("goal_weight", 48.6),
                one("goal_weight", 129.6),
                one("goal_weight", 129.7),
            ]
        )
        .await,
        [
            None,
            field("goal_muscle"),
            field("goal_weight"),
            None,
            None,
            field("goal_weight"),
        ]
    );
}
