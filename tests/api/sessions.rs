//! Sessions read with the weight in effect on their day: the estimate of a
//! past session never follows today's weigh-in.

use super::*;

async fn session(app: &Router, day: &str) -> Value {
    let (status, s) = call(
        app,
        "POST",
        "/api/profiles/1/sessions",
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
    let (_, list) = call(&app, "GET", "/api/profiles/1/sessions", None).await;
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
        &format!("/api/profiles/1/sessions/{}", first["id"]),
        None,
    )
    .await;
    assert_eq!(one["weight_kg"], 70.0);
}
