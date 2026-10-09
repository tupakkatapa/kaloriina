//! Planned workouts and EMOM repeats.

use super::*;
use common::raw;

/// A built-in exercise's id.
async fn exercise(app: &Router, name: &str) -> i64 {
    let (_, list) = call(app, "GET", "/api/exercises", None).await;
    list.as_array()
        .unwrap()
        .iter()
        .find(|e| e["name"] == name)
        .unwrap()["id"]
        .as_i64()
        .unwrap()
}

/// A one-step workout named `name`; its id.
async fn workout(app: &Router, name: &str) -> i64 {
    let pull = exercise(app, "Pull-up").await;
    let (status, w) = call(
        app,
        "POST",
        "/api/workouts",
        Some(json!({ "name": name, "steps": [
            { "kind": "exercise", "exercise_id": pull, "reps": 5 }] })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{w}");
    w["id"].as_i64().unwrap()
}

async fn plan(app: &Router, day: &str, workout_id: i64) -> (StatusCode, Value) {
    call(
        app,
        "POST",
        "/api/profiles/1/plans",
        Some(json!({ "day": day, "workout_id": workout_id })),
    )
    .await
}

async fn plan_days(app: &Router) -> Vec<(String, i64)> {
    let (_, list) = call(app, "GET", "/api/profiles/1/plans", None).await;
    list.as_array()
        .unwrap()
        .iter()
        .map(|p| {
            (
                p["day"].as_str().unwrap().to_owned(),
                p["id"].as_i64().unwrap(),
            )
        })
        .collect()
}

#[tokio::test]
async fn plans_are_created_listed_shown_on_the_day_and_deleted() {
    let app = app();
    let wid = workout(&app, "Pulls").await;
    let body = json!({ "day": DAY, "workout_id": wid, "uid": "plan-0001" });
    let (status, made) = call(&app, "POST", "/api/profiles/1/plans", Some(body.clone())).await;
    assert_eq!(status, StatusCode::CREATED, "{made}");
    assert_eq!(made["name"], "Pulls");
    assert_eq!(made["uid"], "plan-0001");
    assert_eq!(made["workout_id"], wid);
    // A retried create saves once.
    let (status, again) = call(&app, "POST", "/api/profiles/1/plans", Some(body)).await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(again["id"], made["id"]);
    let (_, other_day) = plan(&app, "2026-10-20", wid).await;

    let (status, list) = call(
        &app,
        "GET",
        &format!("/api/profiles/1/plans?from={DAY}&to={DAY}"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(list, json!([made]));
    let (_, day) = call(&app, "GET", &format!("/api/profiles/1/day/{DAY}"), None).await;
    assert_eq!(day["plans"], json!([made]));
    let (status, _) = call(
        &app,
        "GET",
        "/api/profiles/1/plans?from=2026-10-09&to=2026-10-08",
        None,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let uri = format!("/api/profiles/1/plans/{}", made["id"]);
    let (status, _) = call(&app, "DELETE", &uri, None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, err) = call(&app, "DELETE", &uri, None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(err["resource"], "plan");
    assert_eq!(
        plan_days(&app).await,
        [("2026-10-20".to_owned(), other_day["id"].as_i64().unwrap())]
    );
}

#[tokio::test]
async fn plans_are_validated_and_kept_per_profile() {
    let app = app();
    let wid = workout(&app, "Pulls").await;
    let post = |body: Value| {
        let app = app.clone();
        async move { call(&app, "POST", "/api/profiles/1/plans", Some(body)).await }
    };
    for (body, field) in [
        (json!({ "day": DAY, "workout_id": 999 }), "workout_id"),
        (json!({ "day": "2026-13-01", "workout_id": wid }), "day"),
        (json!({ "day": "2999-01-01", "workout_id": wid }), "day"),
        (json!({ "day": DAY, "workout_id": wid, "uid": "x" }), "uid"),
        (json!({ "day": DAY }), "workout_id"),
    ] {
        let (status, err) = post(body.clone()).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        assert_eq!(err["code"], "invalid");
        assert_eq!(err["field"], field, "{body}: {err}");
    }
    // A year ahead is fine.
    let year: i32 = kaloriina::model::day_so_far().to_string()[..4]
        .parse()
        .unwrap();
    let (status, _) = plan(&app, &format!("{}-01-01", year + 1), wid).await;
    assert_eq!(status, StatusCode::CREATED);

    let (status, _) = raw(&app, "POST", "/api/profiles/1/plans", "text/plain", "{}").await;
    assert_eq!(status, StatusCode::UNSUPPORTED_MEDIA_TYPE);
    let (status, err) = call(
        &app,
        "POST",
        "/api/profiles/99/plans",
        Some(json!({ "day": DAY, "workout_id": wid })),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(err["resource"], "profile");

    // Another profile neither sees nor deletes profile 1's plans.
    let (_, mine) = plan(&app, DAY, wid).await;
    let (_, other) = call(
        &app,
        "POST",
        "/api/profiles",
        Some(json!({
            "name": "Other", "sex": "male", "birth_date": "1990-01-01",
            "height_cm": 180.0, "activity": 1.6,
            "goal_kg_per_week": 0.0 })),
    )
    .await;
    let pid = other["id"].as_i64().unwrap();
    let (_, theirs) = call(&app, "GET", &format!("/api/profiles/{pid}/plans"), None).await;
    assert_eq!(theirs, json!([]));
    let (status, _) = call(
        &app,
        "DELETE",
        &format!("/api/profiles/{pid}/plans/{}", mine["id"]),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn a_session_takes_its_plan_and_a_deleted_workout_its_plans() {
    let app = app();
    let pulls = workout(&app, "Pulls").await;
    let other = workout(&app, "Other").await;
    let (_, oldest) = plan(&app, DAY, pulls).await;
    let (_, second) = plan(&app, DAY, pulls).await;
    let (_, other_plan) = plan(&app, DAY, other).await;
    let (_, later) = plan(&app, "2026-10-07", pulls).await;
    let session = |wid: Option<i64>| json!({ "day": DAY, "workout_id": wid, "name": "Pulls", "minutes": 10, "sets": [] });
    // A session without a workout, or of another day's, leaves them be.
    let (status, _) = call(
        &app,
        "POST",
        "/api/profiles/1/sessions",
        Some(session(None)),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(plan_days(&app).await.len(), 4);

    let (status, done) = call(
        &app,
        "POST",
        "/api/profiles/1/sessions",
        Some(session(Some(pulls))),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{done}");
    let ids: Vec<i64> = plan_days(&app)
        .await
        .into_iter()
        .map(|(_, id)| id)
        .collect();
    assert_eq!(
        ids,
        [&second, &other_plan, &later].map(|p| p["id"].as_i64().unwrap()),
        "only the oldest matching plan goes ({oldest})"
    );
    // Editing a session never touches plans.
    let (status, _) = put_with_rev(
        &app,
        &format!("/api/profiles/1/sessions/{}", done["id"]),
        session(Some(pulls)),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(plan_days(&app).await.len(), 3);

    // Deleting the workout deletes its plans; the session stays.
    let (status, _) = call(&app, "DELETE", &format!("/api/workouts/{pulls}"), None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let ids: Vec<i64> = plan_days(&app)
        .await
        .into_iter()
        .map(|(_, id)| id)
        .collect();
    assert_eq!(ids, [other_plan["id"].as_i64().unwrap()]);
    let (_, sessions) = call(&app, "GET", "/api/profiles/1/sessions", None).await;
    assert_eq!(sessions.as_array().unwrap().len(), 2);
}

#[tokio::test]
async fn emom_repeats_validate_and_their_pads_count_toward_the_run_limit() {
    let app = app();
    let pull = exercise(&app, "Pull-up").await;
    let ex = json!({ "kind": "exercise", "exercise_id": pull, "reps": 5 });
    let emom = |every: Value| {
        json!({ "name": "EMOM", "steps": [
            { "kind": "repeat", "times": 10, "every": every, "steps": [ex] }] })
    };
    let (status, made) = call(&app, "POST", "/api/workouts", Some(emom(json!(60)))).await;
    assert_eq!(status, StatusCode::CREATED, "{made}");
    assert_eq!(made["steps"][0]["every"], 60);
    let (_, plain) = call(
        &app,
        "POST",
        "/api/workouts",
        Some(json!({ "name": "Plain", "steps": [
            { "kind": "repeat", "times": 2, "steps": [ex] }] })),
    )
    .await;
    assert!(plain["steps"][0].get("every").is_none(), "{plain}");
    for bad in [json!(0), json!(3601)] {
        let (status, err) = call(&app, "POST", "/api/workouts", Some(emom(bad))).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{err}");
        assert!(err["error"].as_str().unwrap().contains("every"), "{err}");
    }

    // 99 rounds of 101 steps fit 10,000; one pad a round makes 10,098.
    let rounds = |every: Option<u32>| {
        let mut repeat = json!({ "kind": "repeat", "times": 99, "steps": [
            { "kind": "repeat", "times": 99, "steps": [ex] }, ex, ex] });
        if let Some(e) = every {
            repeat["every"] = json!(e);
        }
        json!({ "name": "Long", "steps": [repeat] })
    };
    let (status, err) = call(&app, "POST", "/api/workouts", Some(rounds(None))).await;
    assert_eq!(status, StatusCode::CREATED, "{err}");
    let (status, err) = call(&app, "POST", "/api/workouts", Some(rounds(Some(60)))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{err}");
    assert!(err["error"].as_str().unwrap().contains("10000"), "{err}");
}
