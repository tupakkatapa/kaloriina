//! Health Connect sync from the Android companion: the window replace, the
//! envelope, the status and where the activity shows; sleep, heart and watch
//! workouts as sessions. Days are in September 2026, before any server's
//! today.

use super::*;
use common::raw;

const SYNC: &str = "/api/profiles/1/sync/health";

/// A day as stored and shown: every value, `null` when absent.
fn full_day(values: &Value) -> Value {
    let mut d = json!({ "active_kcal": null, "steps": null, "resting_hr": null,
        "hrv_ms": null, "asleep_min": null, "in_bed_min": null, "bedtime": null,
        "wake_time": null, "deep_min": null, "rem_min": null, "light_min": null });
    for (k, v) in values.as_object().unwrap() {
        d[k] = v.clone();
    }
    d
}

fn day(d: &str, active_kcal: i64, steps: i64) -> Value {
    full_day(&json!({ "day": d, "active_kcal": active_kcal, "steps": steps }))
}

fn session(key: &str, d: &str) -> Value {
    json!({ "key": key, "day": d, "start_at": format!("{d}T14:02:00Z"),
            "end_at": format!("{d}T14:48:00Z"), "type": 33, "name": "Running", "kcal": 410,
            "distance_m": 8200, "recording_method": 1 })
}

fn body(from: &str, to: &str, days: &[Value], sessions: &[Value]) -> Value {
    json!({ "from": from, "to": to, "device": "Pixel 9", "days": days, "sessions": sessions })
}

async fn sync(app: &Router, body: Value) -> Value {
    let (status, res) = call(app, "POST", SYNC, Some(body)).await;
    assert_eq!(status, StatusCode::OK, "{res}");
    res
}

async fn activity(app: &Router) -> Value {
    let (status, res) = call(app, "GET", "/api/profiles/1/activity", None).await;
    assert_eq!(status, StatusCode::OK, "{res}");
    res
}

fn counts(days: u64, sessions: u64, skipped: u64) -> Value {
    json!({ "days": days, "sessions": sessions, "nights": 0, "skipped": skipped })
}

/// A week, 2026-09-01..07, with two days and a workout on each.
fn week() -> Value {
    body(
        "2026-09-01",
        "2026-09-07",
        &[day("2026-09-02", 400, 8000), day("2026-09-05", 512, 9120)],
        &[session("a-2", "2026-09-02"), session("a-5", "2026-09-05")],
    )
}

#[tokio::test]
async fn the_same_post_twice_leaves_the_same_state() {
    let app = app();
    assert_eq!(sync(&app, week()).await, counts(2, 2, 0));
    let once = activity(&app).await;
    assert_eq!(sync(&app, week()).await, counts(2, 2, 0));
    assert_eq!(activity(&app).await, once);
    assert_eq!(once["days"][1], day("2026-09-05", 512, 9120));
    assert_eq!(once["sessions"][1], session("a-5", "2026-09-05"));
}

#[tokio::test]
async fn a_post_replaces_its_window_only() {
    let app = app();
    sync(&app, week()).await;
    // Outside the next window: kept.
    sync(
        &app,
        body(
            "2026-08-30",
            "2026-08-30",
            &[day("2026-08-30", 1, 1)],
            &[session("a-0", "2026-08-30")],
        ),
    )
    .await;
    // The same week without 2026-09-02: that day and its workout go.
    sync(
        &app,
        body(
            "2026-09-01",
            "2026-09-07",
            &[day("2026-09-05", 512, 9120)],
            &[session("a-5", "2026-09-05")],
        ),
    )
    .await;
    let a = activity(&app).await;
    let days: Vec<&str> = a["days"]
        .as_array()
        .unwrap()
        .iter()
        .map(|d| d["day"].as_str().unwrap())
        .collect();
    assert_eq!(days, ["2026-08-30", "2026-09-05"]);
    let keys: Vec<&str> = a["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["key"].as_str().unwrap())
        .collect();
    assert_eq!(keys, ["a-0", "a-5"]);
}

#[tokio::test]
async fn a_workout_moved_into_the_window_is_stored_once() {
    let app = app();
    sync(
        &app,
        body(
            "2026-08-31",
            "2026-08-31",
            &[],
            &[session("a-1", "2026-08-31")],
        ),
    )
    .await;
    // The phone's zone changed: the same record now starts on 2026-09-01.
    assert_eq!(
        sync(
            &app,
            body(
                "2026-09-01",
                "2026-09-07",
                &[],
                &[session("a-1", "2026-09-01")]
            ),
        )
        .await,
        counts(0, 1, 0)
    );
    let sessions = &activity(&app).await["sessions"];
    assert_eq!(sessions.as_array().unwrap().len(), 1, "{sessions}");
    assert_eq!(sessions[0]["day"], "2026-09-01");
}

#[tokio::test]
async fn bad_items_are_skipped_and_counted() {
    let app = app();
    let mut backwards = session("a-4", "2026-09-04");
    backwards["end_at"] = json!("2026-09-04T14:02:00Z");
    let res = sync(
        &app,
        body(
            "2026-09-01",
            "2026-09-07",
            &[
                day("2026-09-02", 400, 8000),
                day("2026-08-31", 1, 1),
                day("2026-09-03", -1, 1),
                day("2026-09-04", 20_001, 1),
            ],
            &[
                session("a-2", "2026-09-02"),
                session("a-2", "2026-09-02"),
                backwards,
            ],
        ),
    )
    .await;
    // Counts only: nothing of the data comes back. A bad energy is dropped
    // (counted) and the day kept with its steps.
    assert_eq!(res, counts(3, 1, 5));
    let a = activity(&app).await;
    assert_eq!(a["days"].as_array().unwrap().len(), 3);
    assert_eq!(
        a["days"][1],
        full_day(&json!({ "day": "2026-09-03", "steps": 1 }))
    );
    assert_eq!(a["sessions"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn a_broken_envelope_is_refused() {
    let app = app();
    let today = jiff::Timestamp::now()
        .to_zoned(jiff::tz::TimeZone::UTC)
        .date();
    let ahead = today.saturating_add(jiff::ToSpan::days(2)).to_string();
    let tomorrow = today.saturating_add(jiff::ToSpan::days(1)).to_string();
    let week_ago = today.saturating_sub(jiff::ToSpan::days(6)).to_string();
    let many = |n: usize, item: Value| Value::Array(vec![item; n]);
    for (bad, field) in [
        (json!([1]), None),
        (json!({ "to": "2026-09-07" }), Some("from")),
        (json!({ "from": "2026-09-01" }), Some("to")),
        (
            json!({ "from": "2026-9-1", "to": "2026-09-07" }),
            Some("from"),
        ),
        (
            json!({ "from": "2026-09-08", "to": "2026-09-07" }),
            Some("from"),
        ),
        (
            json!({ "from": "2026-06-07", "to": "2026-09-07" }),
            Some("to"),
        ),
        (json!({ "from": week_ago, "to": ahead }), Some("to")),
        (
            json!({ "from": "2026-09-01", "to": "2026-09-07", "days": {} }),
            Some("days"),
        ),
        (
            json!({ "from": "2026-06-08", "to": "2026-09-07",
                    "days": many(93, day("2026-09-01", 1, 1)) }),
            Some("days"),
        ),
        (
            json!({ "from": "2026-09-01", "to": "2026-09-07",
                    "sessions": many(2001, session("a-1", "2026-09-01")) }),
            Some("sessions"),
        ),
    ] {
        let (status, res) = call(&app, "POST", SYNC, Some(bad.clone())).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{bad}: {res}");
        assert_eq!(res["code"], "invalid");
        assert_eq!(res["field"].as_str(), field, "{bad}: {res}");
    }
    // 92 days is the most, and tomorrow (in any zone) the latest.
    sync(&app, json!({ "from": "2026-06-08", "to": "2026-09-07" })).await;
    sync(&app, json!({ "from": week_ago, "to": tomorrow })).await;

    let (status, _) = raw(&app, "POST", SYNC, "text/plain", &week().to_string()).await;
    assert_eq!(status, StatusCode::UNSUPPORTED_MEDIA_TYPE);
    let huge = format!(
        r#"{{"from":"2026-09-01","to":"2026-09-07","pad":"{}"}}"#,
        "x".repeat(kaloriina::model::HEALTH_BYTES_MAX)
    );
    let (status, res) = raw(&app, "POST", SYNC, "application/json", &huge).await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE, "{res}");
}

#[tokio::test]
async fn an_unknown_or_deleted_profile_is_404() {
    let app = app();
    let (status, res) = call(&app, "POST", "/api/profiles/99/sync/health", Some(week())).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{res}");
    let (_, anna) = call(
        &app,
        "POST",
        "/api/profiles",
        Some(
            json!({ "name": "Anna", "sex": "female", "birth_date": "1990-01-01",
            "height_cm": 165, "activity": 1.6, "goal_kg_per_week": 0 }),
        ),
    )
    .await;
    assert!(anna["id"].is_i64(), "{anna}");
    let hook = format!("/api/profiles/{}/sync/health", anna["id"]);
    let (status, _) = call(&app, "POST", &hook, Some(week())).await;
    assert_eq!(status, StatusCode::OK);
    call(
        &app,
        "DELETE",
        &format!("/api/profiles/{}", anna["id"]),
        None,
    )
    .await;
    let (status, res) = call(&app, "POST", &hook, Some(week())).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{res}");
    assert_eq!(res["code"], "not_found");
    // The rows went with the profile.
    let (status, _) = call(&app, "GET", &hook, None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn the_status_names_the_last_sync_and_both_devices() {
    let app = app();
    let (_, none) = call(&app, "GET", SYNC, None).await;
    assert_eq!(
        none,
        json!({ "last_seen": null, "last_result": null, "workouts": "auto" })
    );
    sync(&app, week()).await;
    let mut other = week();
    other["device"] = json!("Pixel 7");
    sync(&app, other).await;
    let (_, status) = call(&app, "GET", SYNC, None).await;
    assert!(status["last_seen"].as_i64().unwrap() > 0, "{status}");
    assert_eq!(
        status["last_result"],
        json!({ "days": 2, "sessions": 2, "nights": 0, "skipped": 0, "from": "2026-09-01",
                "to": "2026-09-07", "device": "Pixel 7", "previous_device": "Pixel 9" })
    );
}

#[tokio::test]
async fn delete_removes_the_activity_and_its_status_only() {
    let app = app();
    sync(&app, week()).await;
    // openScale's connection on the same profile.
    call(
        &app,
        "POST",
        "/api/profiles/1/sync/openscale",
        Some(json!({ "event": "test" })),
    )
    .await;
    let (status, _) = call(&app, "DELETE", SYNC, None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(activity(&app).await, json!({ "days": [], "sessions": [] }));
    let (_, health) = call(&app, "GET", SYNC, None).await;
    assert_eq!(health["last_seen"], Value::Null);
    let (_, scale) = call(&app, "GET", "/api/profiles/1/sync/openscale", None).await;
    assert!(scale["last_seen"].is_i64(), "{scale}");
}

#[tokio::test]
async fn the_day_and_a_range_show_the_activity() {
    let app = app();
    sync(&app, week()).await;
    let (_, d) = call(&app, "GET", "/api/profiles/1/day/2026-09-05", None).await;
    assert_eq!(d["activity"], day("2026-09-05", 512, 9120));
    // The watch's workout is a session of the day; nothing waits.
    assert_eq!(d["pending_sessions"], json!([]));
    let s = &d["sessions"][0];
    assert_eq!(
        (&s["name"], &s["type"], &s["source"], &s["source_key"]),
        (
            &json!("Running"),
            &json!("run"),
            &json!("health_connect"),
            &json!("a-5")
        ),
        "{s}"
    );
    let (_, empty) = call(&app, "GET", "/api/profiles/1/day/2026-09-04", None).await;
    assert_eq!(
        (&empty["activity"], &empty["pending_sessions"]),
        (&Value::Null, &json!([]))
    );
    let (status, range) = call(
        &app,
        "GET",
        "/api/profiles/1/activity?from=2026-09-03&to=2026-09-07",
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(range["days"], json!([day("2026-09-05", 512, 9120)]));
    assert_eq!(range["sessions"].as_array().unwrap().len(), 1);
    let (status, _) = call(
        &app,
        "GET",
        "/api/profiles/1/activity?from=2026-09-07&to=2026-09-03",
        None,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn meta_serves_the_sync_limits() {
    let (_, meta) = call(&app(), "GET", "/api/meta", None).await;
    assert_eq!(meta["limits"]["activity_window"], 92);
    assert_eq!(meta["limits"]["activity_sessions"], 2000);
}

// ------------------------------------------------- Health Connect 2

/// A watch run on `d`, `start`–`end` (UTC "HH:MM:SS").
fn run(key: &str, d: &str, start: &str, end: &str) -> Value {
    json!({ "key": key, "day": d, "start_at": format!("{d}T{start}Z"),
            "end_at": format!("{d}T{end}Z"), "type": 33, "name": "Running", "kcal": 410,
            "distance_m": 8200, "recording_method": 1 })
}

/// Sync `sessions` over 2026-09-01..07 from the Pixel 9.
async fn sync_runs(app: &Router, sessions: &[Value]) -> Value {
    sync(app, body("2026-09-01", "2026-09-07", &[], sessions)).await
}

async fn sessions(app: &Router) -> Vec<Value> {
    let (status, res) = call(app, "GET", "/api/profiles/1/sessions", None).await;
    assert_eq!(status, StatusCode::OK, "{res}");
    res.as_array().unwrap().clone()
}

async fn day_view(app: &Router, d: &str) -> Value {
    let (status, res) = call(app, "GET", &format!("/api/profiles/1/day/{d}"), None).await;
    assert_eq!(status, StatusCode::OK, "{res}");
    res
}

async fn log(app: &Router, body: Value) -> Value {
    let (status, res) = call(app, "POST", "/api/profiles/1/sessions", Some(body)).await;
    assert_eq!(status, StatusCode::CREATED, "{res}");
    res
}

/// A session as its PUT takes it, from what GET gave.
fn as_input(s: &Value) -> Value {
    json!({ "day": s["day"], "name": s["name"], "minutes": s["minutes"], "kcal": s["kcal"],
            "sets": s["sets"], "type": s["type"], "distance_m": s["distance_m"],
            "start_at": s["start_at"], "rev": s["rev"] })
}

fn keys(list: &[Value]) -> Vec<String> {
    list.iter()
        .map(|s| s["source_key"].as_str().unwrap_or("-").to_owned())
        .collect()
}

const WORKOUTS: &str = "/api/profiles/1/sync/health/workouts";

#[tokio::test]
async fn sleep_round_trip() {
    let app = app();
    let night = json!({ "day": "2026-09-05", "steps": 9120, "resting_hr": 54, "hrv_ms": 48,
        "asleep_min": 440, "in_bed_min": 475, "bedtime": "23:10", "wake_time": "07:05",
        "deep_min": 70, "rem_min": 90, "light_min": 200 });
    let res = sync(
        &app,
        body(
            "2026-09-01",
            "2026-09-07",
            std::slice::from_ref(&night),
            &[],
        ),
    )
    .await;
    assert_eq!(
        res,
        json!({ "days": 1, "sessions": 0, "nights": 1, "skipped": 0 })
    );
    assert_eq!(
        day_view(&app, "2026-09-05").await["activity"],
        full_day(&night)
    );
    // A bad HRV goes alone; the night and the rest stay.
    let mut bad = night.clone();
    bad["hrv_ms"] = json!(600);
    let res = sync(&app, body("2026-09-01", "2026-09-07", &[bad], &[])).await;
    assert_eq!(res["skipped"], 1);
    let mut kept = night;
    kept["hrv_ms"] = Value::Null;
    assert_eq!(
        day_view(&app, "2026-09-05").await["activity"],
        full_day(&kept)
    );
}

#[tokio::test]
async fn promote_auto() {
    let app = app();
    let short = |key: &str, d: &str, end: &str| run(key, d, "10:00:00", end);
    sync_runs(
        &app,
        &[
            run("r-1", "2026-09-02", "14:02:00", "14:48:00"),
            short("r-2", "2026-09-03", "10:00:30"),
            short("r-3", "2026-09-04", "10:01:29"),
            short("r-4", "2026-09-05", "10:01:30"),
        ],
    )
    .await;
    let list = sessions(&app).await;
    // 30 s is no workout; 89 s is 1 minute, 90 s is 2.
    assert_eq!(keys(&list), ["r-1", "r-3", "r-4"]);
    let s = &list[0];
    assert_eq!(
        (
            &s["type"],
            &s["distance_m"],
            &s["start_at"],
            &s["source"],
            &s["minutes"],
            &s["kcal"],
            &s["sets"]
        ),
        (
            &json!("run"),
            &json!(8200),
            &json!("2026-09-02T14:02:00Z"),
            &json!("health_connect"),
            &json!(46),
            &json!(410),
            &json!([])
        ),
        "{s}"
    );
    assert_eq!(
        (&list[1]["minutes"], &list[2]["minutes"]),
        (&json!(1), &json!(2))
    );
    // Counted where hand-logged workouts count: the range lists it too.
    let (_, range) = call(
        &app,
        "GET",
        "/api/profiles/1/sessions?from=2026-09-02&to=2026-09-02",
        None,
    )
    .await;
    assert_eq!(range.as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn replay_is_stable() {
    let app = app();
    let runs = [run("r-1", "2026-09-02", "14:02:00", "14:48:00")];
    sync_runs(&app, &runs).await;
    let once = sessions(&app).await;
    sync_runs(&app, &runs).await;
    assert_eq!(sessions(&app).await, once);
    assert_eq!(once.len(), 1);
}

#[tokio::test]
async fn watch_edit_refreshes() {
    let app = app();
    sync_runs(&app, &[run("r-1", "2026-09-02", "14:02:00", "14:48:00")]).await;
    let before = sessions(&app).await[0].clone();
    sync_runs(&app, &[run("r-1", "2026-09-02", "14:02:00", "15:02:00")]).await;
    let after = sessions(&app).await[0].clone();
    assert_eq!(
        (&after["id"], &after["minutes"]),
        (&before["id"], &json!(60))
    );
    assert_eq!(after["rev"], before["rev"].as_i64().unwrap() + 1);
}

#[tokio::test]
async fn watch_delete_removes() {
    let app = app();
    sync_runs(
        &app,
        &[
            run("r-2", "2026-09-02", "14:02:00", "14:48:00"),
            run("r-5", "2026-09-05", "14:02:00", "14:48:00"),
        ],
    )
    .await;
    // The next window starts on 09-04 and lacks r-5: it goes; r-2, outside
    // the window, stays.
    sync(&app, body("2026-09-04", "2026-09-07", &[], &[])).await;
    assert_eq!(keys(&sessions(&app).await), ["r-2"]);
    // Another phone's POST deletes nothing...
    let mut other = body("2026-09-01", "2026-09-07", &[], &[]);
    other["device"] = json!("Pixel 7");
    sync(&app, other.clone()).await;
    assert_eq!(keys(&sessions(&app).await), ["r-2"]);
    // ... until it is the one syncing.
    sync(&app, other).await;
    assert_eq!(keys(&sessions(&app).await), Vec::<String>::new());
}

#[tokio::test]
async fn two_apps_one_workout() {
    let app = app();
    let mut copy = run("r-b", "2026-09-02", "14:03:00", "14:49:00");
    copy["name"] = json!("Run (other app)");
    sync_runs(
        &app,
        &[run("r-a", "2026-09-02", "14:02:00", "14:48:00"), copy],
    )
    .await;
    assert_eq!(keys(&sessions(&app).await), ["r-a"]);
    assert_eq!(
        day_view(&app, "2026-09-02").await["pending_sessions"],
        json!([])
    );
}

#[tokio::test]
async fn tombstone() {
    let app = app();
    let runs = [run("r-1", "2026-09-02", "14:02:00", "14:48:00")];
    sync_runs(&app, &runs).await;
    let id = &sessions(&app).await[0]["id"];
    let (status, _) = call(
        &app,
        "DELETE",
        &format!("/api/profiles/1/sessions/{id}"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    sync_runs(&app, &runs).await;
    assert!(sessions(&app).await.is_empty());
    assert_eq!(activity(&app).await["sessions"][0]["key"], "r-1");
    // The vendor re-ids it (a new key, 30 s later): still gone.
    sync_runs(&app, &[run("r-9", "2026-09-02", "14:02:30", "14:48:00")]).await;
    assert!(sessions(&app).await.is_empty());
    // A different workout that day is not.
    sync_runs(&app, &[run("r-8", "2026-09-02", "18:00:00", "18:30:00")]).await;
    assert_eq!(keys(&sessions(&app).await), ["r-8"]);
}

#[tokio::test]
async fn dedupe_overlap_keeps_manual() {
    let app = app();
    let mine = log(
        &app,
        json!({ "day": "2026-09-02", "name": "Evening run", "minutes": 45,
                "start_at": "2026-09-02T17:00:00Z", "uid": "mine-0001" }),
    )
    .await;
    sync_runs(&app, &[run("r-1", "2026-09-02", "17:05:00", "17:50:00")]).await;
    let list = sessions(&app).await;
    assert_eq!(list.len(), 1);
    let s = &list[0];
    assert_eq!(
        (
            &s["id"],
            &s["name"],
            &s["minutes"],
            &s["distance_m"],
            &s["kcal"],
            &s["type"],
            &s["source"],
            &s["source_key"]
        ),
        (
            &mine["id"],
            &json!("Evening run"),
            &json!(45),
            &json!(8200),
            &json!(410),
            &json!("run"),
            &json!("manual"),
            &json!("r-1")
        ),
        "{s}"
    );
    assert_eq!(s["rev"], mine["rev"].as_i64().unwrap() + 1);
}

#[tokio::test]
async fn dedupe_after() {
    let app = app();
    sync_runs(&app, &[run("r-1", "2026-09-02", "17:05:00", "17:50:00")]).await;
    let mine = log(
        &app,
        json!({ "day": "2026-09-02", "name": "Evening run", "minutes": 45, "kcal": 380,
                "start_at": "2026-09-02T17:00:00Z" }),
    )
    .await;
    // The answer is the claimed row: the watch's session went.
    assert_eq!(
        (&mine["source_key"], &mine["kcal"]),
        (&json!("r-1"), &json!(380))
    );
    assert_eq!(keys(&sessions(&app).await), ["r-1"]);
    assert_eq!(sessions(&app).await[0]["id"], mine["id"]);

    // An update that adds the start claims too.
    sync_runs(
        &app,
        &[
            run("r-1", "2026-09-02", "17:05:00", "17:50:00"),
            run("r-2", "2026-09-03", "07:00:00", "07:30:00"),
        ],
    )
    .await;
    let later = log(
        &app,
        json!({ "day": "2026-09-03", "name": "Morning", "minutes": 30 }),
    )
    .await;
    assert_eq!(sessions(&app).await.len(), 3, "no time, no merge yet");
    let mut input = as_input(&later);
    input["start_at"] = json!("2026-09-03T07:00:00Z");
    let (status, put) = call(
        &app,
        "PUT",
        &format!("/api/profiles/1/sessions/{}", later["id"]),
        Some(input),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{put}");
    assert_eq!(put["source_key"], "r-2");
    assert_eq!(keys(&sessions(&app).await), ["r-1", "r-2"]);
}

#[tokio::test]
async fn no_time_no_merge() {
    let app = app();
    log(
        &app,
        json!({ "day": "2026-09-02", "name": "Run", "minutes": 45, "type": "run" }),
    )
    .await;
    sync_runs(&app, &[run("r-1", "2026-09-02", "17:05:00", "17:50:00")]).await;
    assert_eq!(keys(&sessions(&app).await), ["-", "r-1"]);
}

#[tokio::test]
async fn claim_released() {
    let app = app();
    let mine = log(
        &app,
        json!({ "day": "2026-09-02", "name": "Evening run", "minutes": 45,
                "start_at": "2026-09-02T17:00:00Z" }),
    )
    .await;
    sync_runs(&app, &[run("r-1", "2026-09-02", "17:05:00", "17:50:00")]).await;
    // Gone from the watch: the hand log lets the key go, keeps the rest.
    sync_runs(&app, &[]).await;
    let s = sessions(&app).await[0].clone();
    assert_eq!(
        (&s["id"], &s["source_key"], &s["distance_m"], &s["type"]),
        (&mine["id"], &Value::Null, &json!(8200), &json!("run"))
    );
    // And can claim again.
    sync_runs(&app, &[run("r-2", "2026-09-02", "17:05:00", "17:50:00")]).await;
    assert_eq!(keys(&sessions(&app).await), ["r-2"]);
}

#[tokio::test]
async fn ask_mode() {
    let app = app();
    let (status, st) = call(&app, "PUT", WORKOUTS, Some(json!({ "mode": "ask" }))).await;
    assert_eq!(
        (status, &st["workouts"]),
        (StatusCode::OK, &json!("ask")),
        "{st}"
    );
    let (status, _) = call(&app, "PUT", WORKOUTS, Some(json!({ "mode": "never" }))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    sync_runs(
        &app,
        &[
            run("r-1", "2026-09-02", "07:00:00", "07:30:00"),
            run("r-2", "2026-09-02", "12:00:00", "12:30:00"),
            run("r-3", "2026-09-02", "17:00:00", "17:30:00"),
            run("r-4", "2026-09-02", "20:00:00", "20:30:00"),
        ],
    )
    .await;
    assert!(sessions(&app).await.is_empty());
    let pending = &day_view(&app, "2026-09-02").await["pending_sessions"];
    assert_eq!(
        pending[0],
        json!({ "key": "r-1", "day": "2026-09-02", "start_at": "2026-09-02T07:00:00Z",
                "end_at": "2026-09-02T07:30:00Z", "type": "run", "name": "Running",
                "minutes": 30, "kcal": 410, "distance_m": 8200 })
    );
    assert_eq!(pending.as_array().unwrap().len(), 4);

    // Add: a session; again: the same one.
    let (status, added) = call(&app, "POST", &format!("{WORKOUTS}/r-1"), None).await;
    assert_eq!(status, StatusCode::CREATED, "{added}");
    let (_, again) = call(&app, "POST", &format!("{WORKOUTS}/r-1"), None).await;
    assert_eq!(
        (&added["source_key"], &again["id"]),
        (&json!("r-1"), &added["id"])
    );
    // Dismiss: a tombstone; again: nothing more.
    for _ in 0..2 {
        let (status, _) = call(&app, "DELETE", &format!("{WORKOUTS}/r-2"), None).await;
        assert_eq!(status, StatusCode::NO_CONTENT);
    }
    let (status, res) = call(&app, "DELETE", &format!("{WORKOUTS}/r-1"), None).await;
    assert_eq!(
        (status, &res["code"]),
        (StatusCode::CONFLICT, &json!("held_by_session"))
    );
    let (status, res) = call(&app, "POST", &format!("{WORKOUTS}/r-2"), None).await;
    assert_eq!(
        (status, &res["code"]),
        (StatusCode::CONFLICT, &json!("dismissed"))
    );
    for bad in ["nope", "a.b"] {
        let (status, _) = call(&app, "POST", &format!("{WORKOUTS}/{bad}"), None).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{bad}");
    }
    // Logging it by hand claims it: no longer pending.
    log(
        &app,
        json!({ "day": "2026-09-02", "name": "Lunch run", "minutes": 30,
                "start_at": "2026-09-02T17:00:00Z" }),
    )
    .await;
    let pending = &day_view(&app, "2026-09-02").await["pending_sessions"];
    assert_eq!(pending.as_array().unwrap().len(), 1, "{pending}");
    assert_eq!(pending[0]["key"], "r-4");
    // Auto adds what waits.
    call(&app, "PUT", WORKOUTS, Some(json!({ "mode": "auto" }))).await;
    assert_eq!(keys(&sessions(&app).await), ["r-1", "r-3", "r-4"]);
    assert_eq!(
        day_view(&app, "2026-09-02").await["pending_sessions"],
        json!([])
    );
}

#[tokio::test]
async fn auto_recorded_waits() {
    let app = app();
    let mut walk = run("w-1", "2026-09-02", "08:00:00", "08:40:00");
    walk["type"] = json!(53);
    walk["recording_method"] = json!(2);
    sync_runs(&app, &[walk]).await;
    assert!(sessions(&app).await.is_empty());
    let pending = &day_view(&app, "2026-09-02").await["pending_sessions"];
    assert_eq!(
        (&pending[0]["key"], &pending[0]["type"]),
        (&json!("w-1"), &json!("walk"))
    );
    let (status, _) = call(&app, "POST", &format!("{WORKOUTS}/w-1"), None).await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(keys(&sessions(&app).await), ["w-1"]);
}

#[tokio::test]
async fn read_only_fields() {
    let app = app();
    sync_runs(&app, &[run("r-1", "2026-09-02", "14:02:00", "14:48:00")]).await;
    let s = sessions(&app).await[0].clone();
    let uri = format!("/api/profiles/1/sessions/{}", s["id"]);
    for (field, value) in [
        ("minutes", json!(50)),
        ("day", json!("2026-09-03")),
        ("kcal", json!(1)),
        ("type", json!("walk")),
        ("distance_m", json!(1)),
        ("start_at", json!("2026-09-02T14:00:00Z")),
    ] {
        let mut input = as_input(&s);
        input[field] = value;
        let (status, res) = call(&app, "PUT", &uri, Some(input)).await;
        assert_eq!(status, StatusCode::CONFLICT, "{field}: {res}");
        assert_eq!(res["code"], "watch_read_only");
    }
    let mut input = as_input(&s);
    input["name"] = json!("Tempo run");
    let (status, res) = call(&app, "PUT", &uri, Some(input)).await;
    assert_eq!(
        (status, &res["name"]),
        (StatusCode::OK, &json!("Tempo run")),
        "{res}"
    );
    // The next sync keeps the name: only the watch's fields are refreshed.
    sync_runs(&app, &[run("r-1", "2026-09-02", "14:02:00", "14:48:00")]).await;
    assert_eq!(sessions(&app).await[0]["name"], "Tempo run");
}

#[tokio::test]
async fn remove_keeps_manual() {
    let app = app();
    log(
        &app,
        json!({ "day": "2026-09-02", "name": "Evening run", "minutes": 45,
                "start_at": "2026-09-02T17:00:00Z" }),
    )
    .await;
    let runs = [
        run("r-1", "2026-09-02", "17:05:00", "17:50:00"),
        run("r-2", "2026-09-03", "17:05:00", "17:50:00"),
        run("r-3", "2026-09-04", "17:05:00", "17:50:00"),
    ];
    sync_runs(&app, &runs).await;
    let gone = sessions(&app).await[2]["id"].clone();
    call(
        &app,
        "DELETE",
        &format!("/api/profiles/1/sessions/{gone}"),
        None,
    )
    .await;
    let (status, _) = call(&app, "DELETE", SYNC, None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let left = sessions(&app).await;
    assert_eq!(keys(&left), ["r-1"]);
    assert_eq!(left[0]["distance_m"], 8200);
    // The tombstone and the hand log's claim outlive the removal.
    sync_runs(&app, &runs).await;
    assert_eq!(keys(&sessions(&app).await), ["r-1", "r-2"]);
}

#[tokio::test]
async fn session_minutes_limit() {
    let app = app();
    let body = |minutes: u32| json!({ "day": "2026-09-02", "name": "Hike", "minutes": minutes });
    let (status, _) = call(&app, "POST", "/api/profiles/1/sessions", Some(body(1440))).await;
    assert_eq!(status, StatusCode::CREATED);
    let (status, res) = call(&app, "POST", "/api/profiles/1/sessions", Some(body(1441))).await;
    assert_eq!(
        (status, &res["field"]),
        (StatusCode::BAD_REQUEST, &json!("minutes"))
    );
    let (_, meta) = call(&app, "GET", "/api/meta", None).await;
    assert_eq!(
        (
            &meta["limits"]["session_minutes"],
            &meta["limits"]["minutes"]
        ),
        (&json!(1440), &json!(600))
    );
    assert_eq!(
        meta["session_types"][0],
        json!({ "key": "run", "label": "Run", "distance": true })
    );
    assert_eq!(meta["session_types"].as_array().unwrap().len(), 6);
}

#[tokio::test]
async fn the_phone_payload_is_accepted() {
    // The body the Android app builds (`PayloadTest` pins the same
    // file), posted as is: a shape drift on either side fails one of them.
    let app = app();
    let body = include_str!("../fixtures/health/payload.json");
    let (status, res) = raw(&app, "POST", SYNC, "application/json", body).await;
    assert_eq!(status, StatusCode::OK, "{res}");
    assert_eq!(
        res,
        json!({ "days": 1, "sessions": 4, "nights": 1, "skipped": 0 })
    );
    let stored = activity(&app).await;
    assert_eq!(stored["sessions"].as_array().unwrap().len(), 4, "{stored}");
}

#[tokio::test]
async fn pending_workouts_list_across_days() {
    let app = app();
    call(&app, "PUT", WORKOUTS, Some(json!({ "mode": "ask" }))).await;
    sync_runs(
        &app,
        &[
            run("r-5", "2026-09-05", "07:00:00", "07:30:00"),
            run("r-2", "2026-09-02", "12:00:00", "12:30:00"),
            run("r-3", "2026-09-03", "17:00:00", "17:30:00"),
        ],
    )
    .await;
    call(&app, "DELETE", &format!("{WORKOUTS}/r-3"), None).await;
    let (status, list) = call(&app, "GET", WORKOUTS, None).await;
    assert_eq!(status, StatusCode::OK, "{list}");
    let list = list.as_array().unwrap();
    let days: Vec<_> = list.iter().map(|p| (&p["key"], &p["day"])).collect();
    assert_eq!(
        days,
        [
            (&json!("r-2"), &json!("2026-09-02")),
            (&json!("r-5"), &json!("2026-09-05"))
        ]
    );
    assert_eq!(
        list[0],
        day_view(&app, "2026-09-02").await["pending_sessions"][0]
    );
    let (status, _) = call(&app, "GET", "/api/profiles/99/sync/health/workouts", None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn a_claimed_set_session_takes_no_distance() {
    let app = app();
    let (_, list) = call(&app, "GET", "/api/exercises", None).await;
    let ex = list
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["measure"] == "reps")
        .unwrap()["id"]
        .clone();
    let mine = log(
        &app,
        json!({ "day": "2026-09-02", "name": "Gym", "minutes": 45,
                "start_at": "2026-09-02T17:00:00Z", "sets": [{ "exercise_id": ex, "reps": 10 }] }),
    )
    .await;
    sync_runs(&app, &[run("r-1", "2026-09-02", "17:05:00", "17:50:00")]).await;
    let s = sessions(&app).await.remove(0);
    assert_eq!((&s["id"], &s["source_key"]), (&mine["id"], &json!("r-1")));
    let (status, res) = call(
        &app,
        "PUT",
        &format!("/api/profiles/1/sessions/{}", s["id"]),
        Some(as_input(&s)),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{res}");
    assert_eq!(s["distance_m"], Value::Null, "{s}");
}
