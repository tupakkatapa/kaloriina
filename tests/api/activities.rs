//! Activities: read with the weight in effect on their day (the estimate
//! of a past one never follows today's weigh-in); the renamed routes;
//! workouts' last done, an exercise's history and the records, by SQL
//! over the sets.

use std::collections::BTreeMap;

use super::*;

async fn session(app: &Router, day: &str) -> Value {
    let (status, s) = call(
        app,
        "POST",
        "/api/profiles/1/activities",
        Some(json!({ "day": day, "name": "Run", "minutes": 30, "type": "run" })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{s}");
    s
}

#[tokio::test]
async fn a_session_estimates_with_its_days_weight() {
    let app = app();
    let first = session(&app, "2026-09-30").await;
    assert_eq!(first["weight_kg"], Value::Null, "no weigh-in at all");
    for (day, kg) in [("2026-10-01", 70.0), ("2026-10-05", 80.0)] {
        call(
            &app,
            "PUT",
            &format!("/api/profiles/1/weights/{day}"),
            Some(json!({ "kg": kg })),
        )
        .await;
    }
    session(&app, "2026-10-03").await;
    session(&app, "2026-10-05").await;
    let (_, list) = call(&app, "GET", "/api/profiles/1/activities", None).await;
    let weights: Vec<(&str, &Value)> = list
        .as_array()
        .unwrap()
        .iter()
        .map(|s| (s["day"].as_str().unwrap(), &s["weight_kg"]))
        .collect();
    assert_eq!(
        weights,
        [
            ("2026-09-30", &json!(70.0)),
            ("2026-10-03", &json!(70.0)),
            ("2026-10-05", &json!(80.0)),
        ],
        "the latest on or before its day, else the earliest after"
    );
    let (_, one) = call(
        &app,
        "GET",
        &format!("/api/profiles/1/activities/{}", first["id"]),
        None,
    )
    .await;
    assert_eq!(one["weight_kg"], 70.0);
}

/// A built-in exercise's id.
async fn exercise_id(app: &Router, name: &str) -> i64 {
    let (_, list) = call(app, "GET", "/api/exercises", None).await;
    list.as_array()
        .unwrap()
        .iter()
        .find(|e| e["name"] == name)
        .unwrap()["id"]
        .as_i64()
        .unwrap()
}

/// Log `body` (day, name and minutes filled in) for profile `pid`.
async fn log(app: &Router, pid: i64, day: &str, body: Value) -> Value {
    let mut b = json!({ "day": day, "name": "Gym", "minutes": 30 });
    b.as_object_mut()
        .unwrap()
        .extend(body.as_object().unwrap().clone());
    let (status, a) = call(
        app,
        "POST",
        &format!("/api/profiles/{pid}/activities"),
        Some(b),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{a}");
    a
}

/// `/sessions` is `/activities` and `/activity` is `/device-days`;
/// the old routes are gone. Android's `/sync/health` is unchanged.
#[tokio::test]
async fn renamed_routes_answer_and_old_ones_are_gone() {
    let app = app();
    let a = log(&app, 1, "2026-10-01", json!({ "type": "walk" })).await;
    for uri in [
        "/api/profiles/1/activities".to_owned(),
        format!("/api/profiles/1/activities/{}", a["id"]),
        "/api/profiles/1/device-days".to_owned(),
        "/api/profiles/1/sync/health".to_owned(),
    ] {
        assert_eq!(
            call(&app, "GET", &uri, None).await.0,
            StatusCode::OK,
            "{uri}"
        );
    }
    for uri in [
        "/api/profiles/1/sessions".to_owned(),
        format!("/api/profiles/1/sessions/{}", a["id"]),
        "/api/profiles/1/activity".to_owned(),
    ] {
        assert_eq!(
            call(&app, "GET", &uri, None).await.0,
            StatusCode::NOT_FOUND,
            "{uri}"
        );
    }
    let (_, meta) = call(&app, "GET", "/api/meta", None).await;
    assert!(meta.get("session_types").is_none());
}

/// Each activity type's MET is the server's, and each primary
/// muscle names its group in the traits.
#[tokio::test]
async fn meta_serves_mets_and_muscle_groups() {
    let app = app();
    let (_, meta) = call(&app, "GET", "/api/meta", None).await;
    let types = meta["activity_types"].as_array().unwrap();
    let met = |key: &str| {
        types.iter().find(|t| t["key"] == key).unwrap()["met"]
            .as_f64()
            .unwrap()
    };
    assert_eq!((met("workout"), met("walk"), met("other")), (5.0, 3.5, 4.0));
    assert!(types.iter().all(|t| t["met"].as_f64().unwrap() > 1.0));
    let primary = meta["exercise_traits"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["key"] == "primary")
        .unwrap();
    let groups: BTreeMap<&str, &str> = primary["groups"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| (p[0].as_str().unwrap(), p[1].as_str().unwrap()))
        .collect();
    assert_eq!(groups["pectorals"], "chest");
    assert_eq!(groups["glutes"], "glutes");
    assert_eq!(groups["obliques"], "core");
    // Every muscle has one.
    assert_eq!(groups.len(), primary["values"].as_array().unwrap().len());
}

/// `/activities?from=&to=` reads a range; no range reads all.
#[tokio::test]
async fn activities_read_a_range_or_all() {
    let app = app();
    for day in ["2026-09-01", "2026-09-15", "2026-10-01"] {
        log(&app, 1, day, json!({ "type": "walk" })).await;
    }
    let days = |list: Value| -> Vec<String> {
        list.as_array()
            .unwrap()
            .iter()
            .map(|a| a["day"].as_str().unwrap().to_owned())
            .collect()
    };
    let (_, all) = call(&app, "GET", "/api/profiles/1/activities", None).await;
    assert_eq!(days(all).len(), 3);
    let (_, some) = call(
        &app,
        "GET",
        "/api/profiles/1/activities?from=2026-09-10&to=2026-10-01",
        None,
    )
    .await;
    assert_eq!(days(some), ["2026-09-15", "2026-10-01"]);
}

/// `GET /profiles/{pid}/workouts`: the workouts with the day each was last
/// done by that profile (`null`: never).
#[tokio::test]
async fn workouts_carry_their_last_done_day() {
    let app = app();
    let pull = exercise_id(&app, "Pull-up").await;
    let mut ids = Vec::new();
    for name in ["Pulls", "Never"] {
        let (_, w) = call(
            &app,
            "POST",
            "/api/workouts",
            Some(json!({ "name": name, "steps": [
                { "kind": "exercise", "exercise_id": pull, "reps": 5 }] })),
        )
        .await;
        ids.push(w["id"].clone());
    }
    for day in ["2026-10-03", "2026-10-01"] {
        log(&app, 1, day, json!({ "workout_id": ids[0] })).await;
    }
    let anna = json!({ "name": "Anna", "sex": "female", "birth_date": "1990-05-01",
                       "height_cm": 170, "activity": 1.6, "goal_kg_per_week": 0 });
    let (_, other) = call(&app, "POST", "/api/profiles", Some(anna)).await;
    let anna = other["id"].as_i64().unwrap();
    log(&app, anna, "2026-10-05", json!({ "workout_id": ids[1] })).await;
    let last = |list: &Value| -> Vec<(String, Value)> {
        list.as_array()
            .unwrap()
            .iter()
            .map(|w| {
                (
                    w["name"].as_str().unwrap().to_owned(),
                    w["last_done"].clone(),
                )
            })
            .collect()
    };
    let (status, mine) = call(&app, "GET", "/api/profiles/1/workouts", None).await;
    assert_eq!(status, StatusCode::OK, "{mine}");
    assert_eq!(
        last(&mine),
        [
            ("Never".to_owned(), Value::Null),
            ("Pulls".to_owned(), json!("2026-10-03"))
        ]
    );
    assert_eq!(
        mine[0]["steps"].as_array().unwrap().len(),
        1,
        "the whole workout"
    );
    let (_, hers) = call(&app, "GET", &format!("/api/profiles/{anna}/workouts"), None).await;
    assert_eq!(
        last(&hers),
        [
            ("Never".to_owned(), json!("2026-10-05")),
            ("Pulls".to_owned(), Value::Null)
        ]
    );
}

/// Item 5: a workout's History reads its latest activities, oldest first
/// among them; another workout's and another profile's aren't there.
#[tokio::test]
async fn a_workouts_latest_activities() {
    let app = app();
    let pull = exercise_id(&app, "Pull-up").await;
    let mut ids = Vec::new();
    for name in ["Pulls", "Other"] {
        let (_, w) = call(
            &app,
            "POST",
            "/api/workouts",
            Some(json!({ "name": name, "steps": [
                { "kind": "exercise", "exercise_id": pull, "reps": 5 }] })),
        )
        .await;
        ids.push(w["id"].as_i64().unwrap());
    }
    for day in ["2026-10-01", "2026-10-05", "2026-10-03", "2026-10-07"] {
        log(&app, 1, day, json!({ "workout_id": ids[0] })).await;
    }
    log(&app, 1, "2026-10-08", json!({ "workout_id": ids[1] })).await;
    log(&app, 1, "2026-10-09", json!({})).await;
    let days = |uri: String| {
        let app = app.clone();
        async move {
            let (status, list) = call(&app, "GET", &uri, None).await;
            assert_eq!(status, StatusCode::OK, "{list}");
            list.as_array()
                .unwrap()
                .iter()
                .map(|a| a["day"].as_str().unwrap().to_owned())
                .collect::<Vec<_>>()
        }
    };
    let of = |q: &str| format!("/api/profiles/1/activities?workout_id={}{q}", ids[0]);
    assert_eq!(
        days(of("&limit=3")).await,
        ["2026-10-03", "2026-10-05", "2026-10-07"]
    );
    assert_eq!(days(of("")).await.len(), 4);
    assert_eq!(
        days("/api/profiles/1/activities?limit=2".to_owned()).await,
        ["2026-10-08", "2026-10-09"]
    );
    let (status, err) = call(&app, "GET", &of("&limit=0"), None).await;
    assert_eq!(
        (status, &err["field"]),
        (StatusCode::BAD_REQUEST, &json!("limit"))
    );
}

/// `GET /profiles/{pid}/exercises/{id}/history`: the exercise's sets by
/// activity, newest first, and its bests (most reps, longest, heaviest:
/// the latest wins a tie), each with its day and activity.
#[tokio::test]
async fn an_exercises_history_and_bests() {
    let app = app();
    let pull = exercise_id(&app, "Pull-up").await;
    let plank = exercise_id(&app, "Plank").await;
    let set = |reps: u32, kg: Option<f64>| json!({ "exercise_id": pull, "reps": reps, "kg": kg });
    let first = log(
        &app,
        1,
        "2026-10-01",
        json!({ "sets": [set(8, None), set(10, None), { "exercise_id": plank, "seconds": 60 }] }),
    )
    .await;
    let second = log(
        &app,
        1,
        "2026-10-03",
        json!({ "sets": [set(10, Some(5.0)), set(6, Some(10.0))] }),
    )
    .await;
    log(&app, 1, "2026-10-04", json!({ "type": "walk" })).await;
    let (status, h) = call(
        &app,
        "GET",
        &format!("/api/profiles/1/exercises/{pull}/history"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{h}");
    let days: Vec<(&str, &Value, usize)> = h["days"]
        .as_array()
        .unwrap()
        .iter()
        .map(|d| {
            (
                d["day"].as_str().unwrap(),
                &d["activity_id"],
                d["sets"].as_array().unwrap().len(),
            )
        })
        .collect();
    assert_eq!(
        days,
        [
            ("2026-10-03", &second["id"], 2),
            ("2026-10-01", &first["id"], 2)
        ]
    );
    assert_eq!(h["days"][1]["sets"][1]["reps"], 10, "in order");
    assert_eq!(
        (
            &h["bests"]["reps"]["day"],
            &h["bests"]["reps"]["set"]["reps"]
        ),
        (&json!("2026-10-03"), &json!(10)),
        "a tie: the latest"
    );
    assert_eq!(h["bests"]["kg"]["set"]["kg"], 10.0);
    assert_eq!(h["bests"]["kg"]["activity_id"], second["id"]);
    assert_eq!(h["bests"]["seconds"], Value::Null);
    let (_, none) = call(
        &app,
        "GET",
        "/api/profiles/1/exercises/999999/history",
        None,
    )
    .await;
    assert_eq!(none["code"], "not_found", "{none}");
}

/// `GET /profiles/{pid}/records`: each exercise's bests (as its history
/// has them) and each activity type's: longest distance and time, fastest
/// pace (1 km or more); the latest wins a tie.
#[tokio::test]
async fn records_are_the_bests_by_exercise_and_type() {
    let app = app();
    let pull = exercise_id(&app, "Pull-up").await;
    log(
        &app,
        1,
        "2026-10-01",
        json!({ "sets": [{ "exercise_id": pull, "reps": 12 }] }),
    )
    .await;
    let run = |minutes: u32, m: u32, kcal: Option<u32>| json!({ "type": "run", "name": "Run", "minutes": minutes, "distance_m": m, "kcal": kcal });
    let long = log(&app, 1, "2026-10-02", run(60, 10_000, Some(500))).await;
    let fast = log(&app, 1, "2026-10-03", run(20, 5000, None)).await;
    let same = log(&app, 1, "2026-10-04", run(60, 800, Some(500))).await;
    let (status, r) = call(&app, "GET", "/api/profiles/1/records", None).await;
    assert_eq!(status, StatusCode::OK, "{r}");
    let ex = &r["exercises"][0];
    assert_eq!(
        (&ex["exercise_id"], &ex["name"], &ex["reps"]["set"]["reps"]),
        (&json!(pull), &json!("Pull-up"), &json!(12))
    );
    let runs = &r["types"]["run"];
    assert_eq!(runs["distance"]["id"], long["id"]);
    assert_eq!(runs["minutes"]["id"], same["id"], "a tie: the later day");
    assert_eq!(
        runs["pace"]["id"], fast["id"],
        "800 m is too short to count"
    );
    // No "most energy": the client never shows one (a session's energy is
    // a device's measure, a typed total or an estimate).
    assert!(runs.get("kcal").is_none(), "{r}");
    let gym = &r["types"]["workout"];
    assert_eq!(
        (&gym["distance"], &gym["minutes"]["day"]),
        (&Value::Null, &json!("2026-10-01")),
        "only what it has"
    );
}

/// A set of an exercise deleted since keeps its name with no exercise;
/// an edit sends it back as read and keeps it, but can't make one up.
#[tokio::test]
async fn a_set_outlives_its_exercise() {
    let app = app();
    let (_, towel) = call(
        &app,
        "POST",
        "/api/exercises",
        Some(json!({ "name": "Towel hang", "measure": "time" })),
    )
    .await;
    let a = log(
        &app,
        1,
        "2026-10-01",
        json!({ "sets": [{ "exercise_id": towel["id"], "seconds": 30 }] }),
    )
    .await;
    let uri = format!("/api/profiles/1/activities/{}", a["id"]);
    let ex = format!("/api/exercises/{}", towel["id"]);
    assert_eq!(
        call(&app, "DELETE", &ex, None).await.0,
        StatusCode::NO_CONTENT
    );
    let (_, read) = call(&app, "GET", &uri, None).await;
    assert_eq!(
        read["sets"],
        json!([{ "exercise_id": null, "name": "Towel hang", "seconds": 30 }])
    );
    let (status, kept) = put_with_rev(&app, &uri, json!({ "minutes": 20 })).await;
    assert_eq!(
        (status, &kept["sets"]),
        (StatusCode::OK, &read["sets"]),
        "{kept}"
    );
    let (status, made_up) = put_with_rev(
        &app,
        &uri,
        json!({ "sets": [{ "exercise_id": null, "name": "Moon walk", "seconds": 30 }] }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{made_up}");
}
