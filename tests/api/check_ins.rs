//! Daily check-ins.

use super::*;

const AT: &str = "/api/profiles/1/check-ins";

fn assert_invalid(status: StatusCode, res: &Value, field: Option<&str>) {
    assert_eq!(status, StatusCode::BAD_REQUEST, "{res}");
    assert_eq!(res["code"], "invalid", "{res}");
    assert_eq!(res.get("field").and_then(Value::as_str), field, "{res}");
}

async fn put(app: &Router, pid: i64, day: &str, body: Value) -> (StatusCode, Value) {
    call(
        app,
        "PUT",
        &format!("/api/profiles/{pid}/check-ins/{day}"),
        Some(body),
    )
    .await
}

async fn day_check_in(app: &Router, day: &str) -> Value {
    let (status, d) = call(app, "GET", &format!("/api/profiles/1/day/{day}"), None).await;
    assert_eq!(status, StatusCode::OK, "{d}");
    d["check_in"].clone()
}

#[tokio::test]
async fn check_ins_follow_the_contract() {
    let app = app();
    let full = json!({ "mood": 4, "energy": 3, "stress": 2, "tags": [" Travel ", "travel"] });
    let (status, c) = put(&app, 1, DAY, full.clone()).await;
    assert_eq!(status, StatusCode::OK, "{c}");
    let want = json!({ "day": DAY, "mood": 4, "energy": 3, "stress": 2, "tags": ["travel"] });
    assert_eq!(c, want);
    // Repeating it changes nothing: the same answer, still one row.
    assert_eq!(put(&app, 1, DAY, full).await.1, want);
    let (_, list) = call(&app, "GET", AT, None).await;
    assert_eq!(list, json!([want]));

    // A PUT is the whole check-in: what it leaves out is unset.
    let (_, c) = put(&app, 1, DAY, json!({ "mood": 4 })).await;
    assert_eq!(
        c,
        json!({ "day": DAY, "mood": 4, "energy": null, "stress": null, "tags": [] })
    );

    // Ranges come back oldest first, either end open.
    put(&app, 1, "2026-10-01", json!({ "tags": ["sick"] })).await;
    put(&app, 1, "2026-10-03", json!({ "stress": 5 })).await;
    let days = |v: &Value| -> Vec<String> {
        v.as_array()
            .unwrap()
            .iter()
            .map(|c| c["day"].as_str().unwrap().to_owned())
            .collect()
    };
    let (_, all) = call(&app, "GET", &format!("{AT}?from=2026-10-01&to={DAY}"), None).await;
    assert_eq!(days(&all), ["2026-10-01", "2026-10-03", DAY]);
    let (_, from) = call(&app, "GET", &format!("{AT}?from=2026-10-02"), None).await;
    assert_eq!(days(&from), ["2026-10-03", DAY]);
    let (_, to) = call(&app, "GET", &format!("{AT}?to=2026-10-03"), None).await;
    assert_eq!(days(&to), ["2026-10-01", "2026-10-03"]);

    // The Day view carries it, null without one.
    assert_eq!(day_check_in(&app, DAY).await["mood"], 4);
    assert_eq!(day_check_in(&app, "2026-10-02").await, Value::Null);

    let uri = format!("{AT}/{DAY}");
    assert_eq!(
        call(&app, "DELETE", &uri, None).await.0,
        StatusCode::NO_CONTENT
    );
    let (status, res) = call(&app, "DELETE", &uri, None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(res["resource"], "check_in");
    assert_eq!(day_check_in(&app, DAY).await, Value::Null);

    // Per profile: an unknown one is 404, another sees none of these, and
    // deleting a profile takes its check-ins along.
    let (status, res) = put(&app, 99, DAY, json!({ "mood": 3 })).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(res["resource"], "profile");
    let (status, res) = call(&app, "GET", "/api/profiles/99/check-ins", None).await;
    assert_eq!(
        (status, &res["resource"]),
        (StatusCode::NOT_FOUND, &json!("profile"))
    );
    let (status, anna) = call(
        &app,
        "POST",
        "/api/profiles",
        Some(
            json!({ "name": "Anna", "sex": null, "birth_date": null, "height_cm": null,
                     "activity": null, "goal_kg_per_week": 0.0 }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{anna}");
    let anna = anna["id"].as_i64().unwrap();
    let theirs = format!("/api/profiles/{anna}/check-ins");
    assert_eq!(call(&app, "GET", &theirs, None).await.1, json!([]));
    assert_eq!(
        put(&app, anna, DAY, json!({ "mood": 2 })).await.0,
        StatusCode::OK
    );
    assert_eq!(
        call(&app, "DELETE", &format!("/api/profiles/{anna}"), None)
            .await
            .0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        call(&app, "GET", &theirs, None).await.0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        days(&call(&app, "GET", AT, None).await.1),
        ["2026-10-01", "2026-10-03"]
    );
}

#[tokio::test]
async fn check_in_inputs_are_checked() {
    let app = app();
    // The address is to blame for a day after tomorrow, not a field.
    let (status, res) = put(&app, 1, "2999-01-01", json!({ "mood": 3 })).await;
    assert_invalid(status, &res, None);
    let (status, res) = put(&app, 1, "2026-13-01", json!({ "mood": 3 })).await;
    assert_invalid(status, &res, None);

    let (status, res) = put(&app, 1, DAY, json!({ "mood": 6 })).await;
    assert_invalid(status, &res, Some("mood"));
    let (status, res) = put(&app, 1, DAY, json!({ "stress": 0 })).await;
    assert_invalid(status, &res, Some("stress"));
    let (status, res) = put(&app, 1, DAY, json!({})).await;
    assert_invalid(status, &res, None);
    let (status, res) = put(&app, 1, DAY, json!({ "tags": [] })).await;
    assert_invalid(status, &res, None);
    let nine: Vec<String> = (1..=9).map(|i| format!("tag {i}")).collect();
    let (status, res) = put(&app, 1, DAY, json!({ "tags": nine })).await;
    assert_invalid(status, &res, Some("tags"));
    let (status, res) = put(&app, 1, DAY, json!({ "tags": ["x".repeat(31)] })).await;
    assert_invalid(status, &res, Some("tags"));
    let (status, res) = put(&app, 1, DAY, json!({ "tags": ["a\u{202e}b"] })).await;
    assert_invalid(status, &res, Some("tags"));
    assert_eq!(call(&app, "GET", AT, None).await.1, json!([]));

    let (_, meta) = call(&app, "GET", "/api/meta", None).await;
    assert_eq!(
        meta["check_in_tags"],
        json!(["sick", "poor sleep", "sore", "travel", "social", "period"])
    );
    assert_eq!(meta["limits"]["check_in_scale"], json!([1, 5]));
    assert_eq!(meta["limits"]["check_in_tag"], 30);
    assert_eq!(meta["limits"]["check_in_tags_max"], 8);
}
