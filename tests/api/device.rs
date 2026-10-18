//! Health Connect sync from the Android companion: the window replace, the
//! envelope, the status and where the activity shows; sleep, heart and device
//! workouts as sessions. Days are in September 2026, before any server's
//! today.

use super::*;
use common::raw;

const SYNC: &str = "/api/profiles/1/sync/health";

/// A day as stored and shown: every value, `null` when absent; its sleep
/// is the night's, without naps.
fn full_day(values: &Value) -> Value {
    let mut d = json!({ "total_kcal": null, "active_kcal": null, "steps": null, "resting_hr": null,
        "hrv_ms": null, "asleep_min": null, "in_bed_min": null, "bedtime": null,
        "wake_time": null, "deep_min": null, "rem_min": null, "light_min": null,
        "avg_hr": null, "min_hr": null, "max_hr": null, "sleep_avg_hr": null,
        "bmr_kcal": null, "bmr_origin": null, "distance_m": null });
    for (k, v) in values.as_object().unwrap() {
        d[k] = v.clone();
    }
    d["total_asleep_min"] = d["asleep_min"].clone();
    d["naps"] = json!(0);
    d["nap_in_bed_min"] = json!(0);
    d
}

fn day(d: &str, active_kcal: i64, steps: i64) -> Value {
    full_day(&json!({ "day": d, "active_kcal": active_kcal, "steps": steps }))
}

fn session(key: &str, d: &str) -> Value {
    json!({ "key": key, "day": d, "start_at": format!("{d}T14:02:00Z"),
            "end_at": format!("{d}T14:48:00Z"), "type": 33, "name": "Running", "kcal": 410,
            "kcal_total": null, "distance_m": 8200, "recording_method": 1, "avg_hr": null,
            "max_hr": null })
}

/// A sync of `days` (as shown: a shown day's `naps` count and
/// `nap_in_bed_min` aren't sent) and `sessions`.
fn body(from: &str, to: &str, days: &[Value], sessions: &[Value]) -> Value {
    let days: Vec<Value> = days
        .iter()
        .cloned()
        .map(|mut d| {
            if d["naps"].is_number() {
                let d = d.as_object_mut().unwrap();
                d.remove("naps");
                d.remove("nap_in_bed_min");
            }
            d
        })
        .collect();
    json!({ "from": from, "to": to, "device": "Pixel 9", "days": days, "sessions": sessions })
}

async fn sync(app: &Router, body: Value) -> Value {
    let (status, res) = call(app, "POST", SYNC, Some(body)).await;
    assert_eq!(status, StatusCode::OK, "{res}");
    res
}

async fn activity(app: &Router) -> Value {
    let (status, res) = call(app, "GET", "/api/profiles/1/device-days", None).await;
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
    // Stored, the wire's `kcal_total` is `total_kcal`.
    let mut stored = session("a-5", "2026-09-05");
    stored["total_kcal"] = stored
        .as_object_mut()
        .unwrap()
        .remove("kcal_total")
        .unwrap();
    assert_eq!(once["sessions"][1], stored);
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
    // Past the server's latest day (tomorrow) even if midnight passes
    // between this read and its own.
    let ahead = today.saturating_add(jiff::ToSpan::days(3)).to_string();
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
        json!({ "last_seen": null, "last_result": null, "records_result": null,
                "workouts": "auto" })
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
    assert_eq!(
        activity(&app).await,
        json!({ "days": [], "sessions": [], "resting": [] })
    );
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
    assert_eq!(d["device_day"], day("2026-09-05", 512, 9120));
    // The device's workout is an activity of the day; nothing waits.
    assert_eq!(d["pending_activities"], json!([]));
    let s = &d["activities"][0];
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
        (&empty["device_day"], &empty["pending_activities"]),
        (&Value::Null, &json!([]))
    );
    let (status, range) = call(
        &app,
        "GET",
        "/api/profiles/1/device-days?from=2026-09-03&to=2026-09-07",
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(range["days"], json!([day("2026-09-05", 512, 9120)]));
    assert_eq!(range["sessions"].as_array().unwrap().len(), 1);
    let (status, _) = call(
        &app,
        "GET",
        "/api/profiles/1/device-days?from=2026-09-07&to=2026-09-03",
        None,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn meta_serves_the_sync_limits() {
    let (_, meta) = call(&app(), "GET", "/api/meta", None).await;
    assert_eq!(meta["limits"]["activity_window"], 92);
    assert_eq!(meta["limits"]["device_workouts"], 2000);
}

// ---------------------------------------------------- Health Connect 2

/// A device run on `d`, `start`–`end` (UTC "HH:MM:SS").
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
    let (status, res) = call(app, "GET", "/api/profiles/1/activities", None).await;
    assert_eq!(status, StatusCode::OK, "{res}");
    res.as_array().unwrap().clone()
}

async fn day_view(app: &Router, d: &str) -> Value {
    let (status, res) = call(app, "GET", &format!("/api/profiles/1/day/{d}"), None).await;
    assert_eq!(status, StatusCode::OK, "{res}");
    res
}

async fn log(app: &Router, body: Value) -> Value {
    let (status, res) = call(app, "POST", "/api/profiles/1/activities", Some(body)).await;
    assert_eq!(status, StatusCode::CREATED, "{res}");
    res
}

/// A session as its PUT takes it, from what GET gave.
fn as_input(s: &Value) -> Value {
    json!({ "day": s["day"], "name": s["name"], "minutes": s["minutes"], "kcal": s["kcal"],
            "sets": s["sets"], "type": s["type"], "distance_m": s["distance_m"],
            "start_at": s["start_at"], "workout_id": s["workout_id"], "rev": s["rev"] })
}

fn keys(list: &[Value]) -> Vec<String> {
    list.iter()
        .map(|s| s["source_key"].as_str().unwrap_or("-").to_owned())
        .collect()
}

const WORKOUTS: &str = "/api/profiles/1/sync/health/workouts";

/// The night of 2026-09-05 as the phone keeps it raw: 23:10–07:05, awake
/// 35 min, deep 70, REM 90, light 200, at 55 bpm; its HRV readings.
fn night_records(hrv: &[(&str, f64)]) -> Value {
    let mut night = hc_sleep(
        "s-5",
        "2026-09-04T23:10:00Z",
        "2026-09-05T07:05:00Z",
        &[
            ("2026-09-04T23:10:00Z", "2026-09-04T23:45:00Z", 1),
            ("2026-09-04T23:45:00Z", "2026-09-05T00:55:00Z", 5),
            ("2026-09-05T00:55:00Z", "2026-09-05T02:25:00Z", 6),
            ("2026-09-05T02:25:00Z", "2026-09-05T05:45:00Z", 4),
        ],
    );
    night["data"]["avg_bpm"] = json!(55);
    let mut all = vec![night];
    all.extend(hrv.iter().enumerate().map(|(i, (at, ms))| {
        json!({ "kind": "HeartRateVariabilityRmssd", "id": format!("hrv-{i}"), "start": at,
                "data": { "time": at, "ms": ms } })
    }));
    Value::Array(all)
}

/// The night shown, made by the server.
fn the_night() -> Value {
    full_day(
        &json!({ "day": "2026-09-05", "steps": 9120, "resting_hr": 54, "hrv_ms": 48,
        "asleep_min": 440, "in_bed_min": 475, "bedtime": "23:10", "wake_time": "07:05",
        "deep_min": 70, "rem_min": 90, "light_min": 200, "sleep_avg_hr": 55 }),
    )
}

/// The server makes the night, its HRV (the readings inside it;
/// one outside, in the afternoon, isn't) and heart rate from the raw
/// records; the phone's window carries its day values only.
#[tokio::test]
async fn sleep_round_trip() {
    let app = app();
    hc_records(
        &app,
        1,
        night_records(&[
            ("2026-09-05T01:00:00Z", 46.0),
            ("2026-09-05T03:00:00Z", 50.0),
            ("2026-09-05T15:00:00Z", 90.0),
        ]),
    )
    .await;
    let values = json!({ "day": "2026-09-05", "steps": 9120, "resting_hr": 54 });
    let res = sync(&app, body("2026-09-01", "2026-09-07", &[values], &[])).await;
    assert_eq!(
        res,
        json!({ "days": 1, "sessions": 0, "nights": 1, "skipped": 0 })
    );
    assert_eq!(
        day_view(&app, "2026-09-05").await["device_day"],
        the_night()
    );
    // An HRV out of bounds goes alone; the night and the rest stay.
    hc_records(
        &app,
        1,
        night_records(&[
            ("2026-09-05T01:00:00Z", 900.0),
            ("2026-09-05T03:00:00Z", 900.0),
        ]),
    )
    .await;
    let mut kept = the_night();
    kept["hrv_ms"] = Value::Null;
    assert_eq!(day_view(&app, "2026-09-05").await["device_day"], kept);
}

/// The window, then the page with last night's session (an
/// older phone's order): the night shows after the page.
#[tokio::test]
async fn a_night_shows_after_its_page_when_the_window_came_first() {
    let app = app();
    let values = json!({ "day": "2026-09-05", "steps": 9120, "resting_hr": 54 });
    sync(&app, body("2026-09-01", "2026-09-07", &[values], &[])).await;
    assert_eq!(
        day_view(&app, "2026-09-05").await["device_day"]["in_bed_min"],
        Value::Null
    );
    hc_records(&app, 1, night_records(&[("2026-09-05T03:00:00Z", 48.0)])).await;
    assert_eq!(
        day_view(&app, "2026-09-05").await["device_day"],
        the_night()
    );
}

/// The page first, then the window (this phone's order): the window's
/// replace keeps the night it makes again from the raw records.
#[tokio::test]
async fn a_night_shows_after_the_window_when_its_page_came_first() {
    let app = app();
    hc_records(&app, 1, night_records(&[("2026-09-05T03:00:00Z", 48.0)])).await;
    let values = json!({ "day": "2026-09-05", "steps": 9120, "resting_hr": 54 });
    let res = sync(&app, body("2026-09-01", "2026-09-07", &[values], &[])).await;
    assert_eq!(res["nights"], 1, "{res}");
    assert_eq!(
        day_view(&app, "2026-09-05").await["device_day"],
        the_night()
    );
}

/// A session re-posted with other stages (edited, or staged late on the
/// phone) changes its night.
#[tokio::test]
async fn a_reposted_session_with_new_stages_changes_the_night() {
    let app = app();
    hc_records(&app, 1, night_records(&[])).await;
    let mut edited = hc_sleep(
        "s-5",
        "2026-09-04T23:10:00Z",
        "2026-09-05T07:05:00Z",
        &[("2026-09-04T23:10:00Z", "2026-09-05T01:10:00Z", 5)],
    );
    edited["data"]["avg_bpm"] = json!(55);
    hc_records(&app, 1, json!([edited])).await;
    let d = day_view(&app, "2026-09-05").await;
    assert_eq!(
        (
            &d["device_day"]["deep_min"],
            &d["device_day"]["rem_min"],
            &d["device_day"]["asleep_min"]
        ),
        (&json!(120), &json!(0), &json!(475)),
        "{d}"
    );
    assert_eq!(d["stages"].as_array().unwrap().len(), 1, "{d}");
}

/// A session Health Connect deleted: the next window lists what it read,
/// and the night it made goes.
#[tokio::test]
async fn a_session_deleted_on_the_phone_takes_its_night() {
    let app = app();
    hc_records(&app, 1, night_records(&[])).await;
    sync(&app, body("2026-09-01", "2026-09-07", &[], &[])).await;
    assert_eq!(
        day_view(&app, "2026-09-05").await["device_day"]["in_bed_min"],
        475
    );
    let mut empty = body("2026-09-01", "2026-09-07", &[], &[]);
    empty["read"] = json!({ "SleepSession": [] });
    let res = sync(&app, empty).await;
    assert_eq!(res["nights"], 0, "{res}");
    assert_eq!(
        day_view(&app, "2026-09-05").await["device_day"],
        Value::Null
    );
}

/// An older phone sends its own night, naps and spans: left out (the
/// server makes them), not counted as skipped; a nap far from its day
/// among them is never stored.
#[tokio::test]
async fn an_old_apks_night_fields_are_ignored() {
    let app = app();
    let old = json!({ "day": "2026-09-05", "steps": 9120, "asleep_min": 440,
        "in_bed_min": 475, "bedtime": "23:10", "wake_time": "07:05", "hrv_ms": 48,
        "stages": [{ "start": "2026-09-04T23:45:00Z", "end": "2026-09-05T00:55:00Z",
                     "stage": "deep" }],
        "naps": [{ "key": "nap-far", "start_at": "2020-01-01T12:00:00Z",
                   "end_at": "2020-01-01T12:40:00Z" }] });
    let res = sync(&app, body("2026-09-01", "2026-09-07", &[old], &[])).await;
    assert_eq!(
        res,
        json!({ "days": 1, "sessions": 0, "nights": 0, "skipped": 0 })
    );
    let d = day_view(&app, "2026-09-05").await;
    assert_eq!(
        d["device_day"],
        full_day(&json!({ "day": "2026-09-05", "steps": 9120 }))
    );
    assert_eq!((&d["naps"], &d["stages"]), (&json!([]), &json!([])));
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
        "/api/profiles/1/activities?from=2026-09-02&to=2026-09-02",
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
async fn device_edit_refreshes() {
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
async fn device_delete_removes() {
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
        day_view(&app, "2026-09-02").await["pending_activities"],
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
        &format!("/api/profiles/1/activities/{id}"),
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
async fn dedupe_overlap_keeps_hand() {
    let app = app();
    let mine = log(
        &app,
        json!({ "day": "2026-09-02", "name": "Evening run", "minutes": 45, "type": "run",
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
            &json!("hand"),
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
                "type": "run", "start_at": "2026-09-02T17:00:00Z" }),
    )
    .await;
    // The answer is the claimed row: the device's session went.
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
            run("r-3", "2026-09-03", "12:00:00", "12:30:00"),
        ],
    )
    .await;
    let later = log(
        &app,
        json!({ "day": "2026-09-03", "name": "Morning", "minutes": 30, "type": "run" }),
    )
    .await;
    assert_eq!(
        sessions(&app).await.len(),
        4,
        "two runs that day: no merge yet"
    );
    let mut input = as_input(&later);
    input["start_at"] = json!("2026-09-03T07:00:00Z");
    let (status, put) = call(
        &app,
        "PUT",
        &format!("/api/profiles/1/activities/{}", later["id"]),
        Some(input),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{put}");
    assert_eq!(put["source_key"], "r-2");
    assert_eq!(keys(&sessions(&app).await), ["r-1", "r-3", "r-2"]);
}

#[tokio::test]
async fn claim_released() {
    let app = app();
    let mine = log(
        &app,
        json!({ "day": "2026-09-02", "name": "Evening run", "minutes": 45, "type": "run",
                "start_at": "2026-09-02T17:00:00Z" }),
    )
    .await;
    sync_runs(&app, &[run("r-1", "2026-09-02", "17:05:00", "17:50:00")]).await;
    // Gone from the device: the hand log lets the key go, keeps the rest.
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
    let pending = &day_view(&app, "2026-09-02").await["pending_activities"];
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
        (StatusCode::CONFLICT, &json!("held_by_activity"))
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
        json!({ "day": "2026-09-02", "name": "Lunch run", "minutes": 30, "type": "run",
                "start_at": "2026-09-02T17:00:00Z" }),
    )
    .await;
    let pending = &day_view(&app, "2026-09-02").await["pending_activities"];
    assert_eq!(pending.as_array().unwrap().len(), 1, "{pending}");
    assert_eq!(pending[0]["key"], "r-4");
    // Auto adds what waits.
    call(&app, "PUT", WORKOUTS, Some(json!({ "mode": "auto" }))).await;
    assert_eq!(keys(&sessions(&app).await), ["r-1", "r-3", "r-4"]);
    assert_eq!(
        day_view(&app, "2026-09-02").await["pending_activities"],
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
    let pending = &day_view(&app, "2026-09-02").await["pending_activities"];
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
    let uri = format!("/api/profiles/1/activities/{}", s["id"]);
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
        assert_eq!(res["code"], "device_read_only");
    }
    let mut input = as_input(&s);
    input["name"] = json!("Tempo run");
    let (status, res) = call(&app, "PUT", &uri, Some(input)).await;
    assert_eq!(
        (status, &res["name"]),
        (StatusCode::OK, &json!("Tempo run")),
        "{res}"
    );
    // The next sync keeps the name: only the device's fields are refreshed.
    sync_runs(&app, &[run("r-1", "2026-09-02", "14:02:00", "14:48:00")]).await;
    assert_eq!(sessions(&app).await[0]["name"], "Tempo run");
}

#[tokio::test]
async fn remove_keeps_hand() {
    let app = app();
    log(
        &app,
        json!({ "day": "2026-09-02", "name": "Evening run", "minutes": 45, "type": "run",
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
        &format!("/api/profiles/1/activities/{gone}"),
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
    let (status, _) = call(&app, "POST", "/api/profiles/1/activities", Some(body(1440))).await;
    assert_eq!(status, StatusCode::CREATED);
    let (status, res) = call(&app, "POST", "/api/profiles/1/activities", Some(body(1441))).await;
    assert_eq!(
        (status, &res["field"]),
        (StatusCode::BAD_REQUEST, &json!("minutes"))
    );
    let (_, meta) = call(&app, "GET", "/api/meta", None).await;
    assert_eq!(
        (
            &meta["limits"]["activity_minutes"],
            &meta["limits"]["minutes"]
        ),
        (&json!(1440), &json!(600))
    );
    let types: Vec<(&str, bool)> = meta["activity_types"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| (t["key"].as_str().unwrap(), t["distance"] == true))
        .collect();
    assert_eq!(
        types,
        [
            ("workout", false),
            ("run", true),
            ("walk", true),
            ("hike", true),
            ("cycling", true),
            ("swim", true),
            ("rowing", true),
            ("elliptical", false),
            ("hiit", false),
            ("yoga", false),
            ("sports", false),
            ("ski", true),
            ("climb", false),
            ("dance", false),
            ("other", true),
        ]
    );
    assert_eq!(
        meta["activity_types"][0],
        json!({ "key": "workout", "label": "Workout", "distance": false, "pace": null,
                "met": 5.0 })
    );
    // How a pace reads is the server's rule too.
    let paces: Vec<(&str, &str)> = meta["activity_types"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|t| Some((t["key"].as_str()?, t["pace"].as_str()?)))
        .collect();
    assert_eq!(
        paces,
        [
            ("run", "per_km"),
            ("walk", "per_km"),
            ("hike", "per_km"),
            ("cycling", "speed"),
            ("swim", "per_100m"),
        ]
    );
}

/// A device workout of Health Connect type `kind` on `d`, `start`–`end`.
fn device(key: &str, d: &str, kind: i64, start: &str, end: &str) -> Value {
    json!({ "key": key, "day": d, "start_at": format!("{d}T{start}Z"),
            "end_at": format!("{d}T{end}Z"), "type": kind, "name": "Workout", "kcal": 300,
            "recording_method": 1 })
}

/// A device that writes total energy only: the session's energy is its
/// span's total, kept as such (`health_connect_total`, gross of resting).
fn total_only(key: &str, d: &str, start: &str, end: &str) -> Value {
    let mut w = device(key, d, 58, start, end);
    w["kcal"] = Value::Null;
    w["kcal_total"] = json!(520);
    w
}

/// The phone's wire key stays `kcal_total`: an APK from
/// before the rename keeps its workouts' total energy, stored and shown as
/// `total_kcal`.
#[tokio::test]
async fn an_old_apk_body_with_kcal_total_keeps_the_total() {
    let app = app();
    sync_runs(
        &app,
        &[total_only("t-1", "2026-09-02", "17:36:00", "18:23:00")],
    )
    .await;
    let raw = &activity(&app).await["sessions"][0];
    assert_eq!(
        (&raw["total_kcal"], raw.get("kcal_total")),
        (&json!(520), None),
        "{raw}"
    );
    assert_eq!(sessions(&app).await[0]["kcal"], 520);
}

#[tokio::test]
async fn a_total_only_device_gives_the_session_its_total() {
    let app = app();
    // The owner's case: a run screen's workout, saved before the sync,
    // claimed by a first sync without energy, filled by the next (a
    // Resync) with the span's total.
    let mine = log(
        &app,
        json!({ "day": "2026-09-02", "name": "Gym", "minutes": 47,
                "start_at": "2026-09-02T17:36:00Z" }),
    )
    .await;
    let mut bare = total_only("t-1", "2026-09-02", "17:36:00", "18:23:00");
    bare["kcal_total"] = Value::Null;
    sync_runs(&app, &[bare]).await;
    let s = &sessions(&app).await[0];
    assert_eq!((&s["id"], &s["kcal"]), (&mine["id"], &Value::Null), "{s}");
    let both = [
        total_only("t-1", "2026-09-02", "17:36:00", "18:23:00"),
        total_only("t-2", "2026-09-03", "17:00:00", "17:45:00"),
    ];
    sync_runs(&app, &both).await;
    let all = sessions(&app).await;
    let got: Vec<_> = all
        .iter()
        .map(|s| {
            (
                &s["source"],
                &s["source_key"],
                &s["kcal"],
                &s["kcal_source"],
            )
        })
        .collect();
    let total = json!("health_connect_total");
    assert_eq!(
        got,
        [
            (&json!("hand"), &json!("t-1"), &json!(520), &total),
            (&json!("health_connect"), &json!("t-2"), &json!(520), &total)
        ],
        "{all:?}"
    );
    // The raw copy keeps which energy it was.
    let raw = &activity(&app).await["sessions"][0];
    assert_eq!(
        (&raw["kcal"], &raw["total_kcal"]),
        (&Value::Null, &json!(520)),
        "{raw}"
    );
    // Active energy, when the device writes it, wins.
    let mut active = total_only("t-2", "2026-09-03", "17:00:00", "17:45:00");
    active["kcal"] = json!(300);
    sync_runs(&app, &[both[0].clone(), active]).await;
    let s = &sessions(&app).await[1];
    assert_eq!(
        (&s["kcal"], &s["kcal_source"]),
        (&json!(300), &json!("health_connect")),
        "{s}"
    );
}

#[tokio::test]
async fn timed_hand_workout_still_claims_device_other() {
    // A set-based workout logged by hand is the device's workout, HIIT or
    // unmapped ("other") session at that time; never its run.
    let app = app();
    let gym = log(
        &app,
        json!({ "day": "2026-09-02", "name": "Gym", "minutes": 45,
                "start_at": "2026-09-02T17:00:00Z" }),
    )
    .await;
    assert_eq!(gym["type"], "workout");
    let hiit = log(
        &app,
        json!({ "day": "2026-09-03", "name": "Circuit", "minutes": 30, "type": "workout",
                "start_at": "2026-09-03T07:00:00Z" }),
    )
    .await;
    let legs = log(
        &app,
        json!({ "day": "2026-09-04", "name": "Legs", "minutes": 40,
                "start_at": "2026-09-04T07:00:00Z" }),
    )
    .await;
    let jog = log(
        &app,
        json!({ "day": "2026-09-05", "name": "Gym?", "minutes": 30,
                "start_at": "2026-09-05T07:00:00Z" }),
    )
    .await;
    sync_runs(
        &app,
        &[
            device("o-1", "2026-09-02", 0, "17:05:00", "17:50:00"),
            device("h-1", "2026-09-03", 20, "07:00:00", "07:30:00"),
            device("s-1", "2026-09-04", 45, "07:00:00", "07:40:00"),
            run("r-1", "2026-09-05", "07:00:00", "07:30:00"),
        ],
    )
    .await;
    let by_id = |all: &[Value], id: &Value| all.iter().find(|s| &s["id"] == id).unwrap().clone();
    let all = sessions(&app).await;
    for (mine, key, kind) in [
        (&gym, "o-1", "workout"),
        (&hiit, "h-1", "hiit"),
        (&legs, "s-1", "workout"),
    ] {
        let s = by_id(&all, &mine["id"]);
        assert_eq!(
            (&s["source_key"], &s["type"]),
            (&json!(key), &json!(kind)),
            "{s}"
        );
    }
    // The run stays its own session beside the hand-logged workout.
    assert_eq!(by_id(&all, &jog["id"])["source_key"], Value::Null);
    assert_eq!(all.len(), 5, "{all:?}");
}

#[tokio::test]
async fn the_phone_payload_is_accepted() {
    // The body the Android app builds (`BatchTest` pins the same file), posted
    // as is after the page with the night it read (the phone's order): a shape
    // drift on either side fails one of them.
    let app = app();
    hc_records(
        &app,
        1,
        json!([hc_sleep(
            "s-1",
            "2026-10-07T20:10:00Z",
            "2026-10-08T04:05:00Z",
            &[]
        )]),
    )
    .await;
    let body = include_str!("../fixtures/health/payload.json");
    let (status, res) = raw(&app, "POST", SYNC, "application/json", body).await;
    assert_eq!(status, StatusCode::OK, "{res}");
    assert_eq!(
        res,
        json!({ "days": 1, "sessions": 4, "nights": 1, "skipped": 0 })
    );
    let stored = activity(&app).await;
    assert_eq!(stored["sessions"].as_array().unwrap().len(), 4, "{stored}");
    // Its heart rate and weigh-in landed too.
    let walk = &stored["sessions"].as_array().unwrap()[2];
    assert_eq!(
        (&walk["key"], &walk["avg_hr"]),
        (&json!("a-5"), &json!(112))
    );
    // A total-only device's energy (no active) is kept as its total.
    let other = &stored["sessions"][1];
    assert_eq!(
        (&other["key"], &other["kcal"], &other["total_kcal"]),
        (&json!("a-4"), &Value::Null, &json!(310))
    );
    let d = day_view(&app, "2026-10-08").await;
    assert_eq!(
        (
            &d["device_day"]["total_kcal"],
            &d["device_day"]["avg_hr"],
            &d["device_day"]["in_bed_min"]
        ),
        (&json!(2480), &json!(68), &json!(475)),
        "{d}"
    );
    let (_, scale) = call(&app, "GET", "/api/profiles/1/scale", None).await;
    assert_eq!(
        (&scale[0]["source"], &scale[0]["weight"]),
        (&json!("health_connect"), &json!(72.45))
    );
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
        day_view(&app, "2026-09-02").await["pending_activities"][0]
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
    // A device strength session with a distance (it shouldn't have one).
    let mut strength = device("s-1", "2026-09-02", 45, "17:05:00", "17:50:00");
    strength["distance_m"] = json!(500);
    sync_runs(&app, &[strength]).await;
    let s = sessions(&app).await.remove(0);
    assert_eq!((&s["id"], &s["source_key"]), (&mine["id"], &json!("s-1")));
    let (status, res) = call(
        &app,
        "PUT",
        &format!("/api/profiles/1/activities/{}", s["id"]),
        Some(as_input(&s)),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{res}");
    assert_eq!(s["distance_m"], Value::Null, "{s}");
}

// ----------------------------------------- Connections keep everything

const RECORDS: &str = "/api/profiles/1/sync/health/records";

fn record(kind: &str, id: &str, data: &Value) -> Value {
    json!({ "kind": kind, "id": id, "start": "2026-09-02T14:00:00Z",
            "end": "2026-09-02T14:30:00Z", "data": data })
}

async fn records(app: &Router, list: &[Value]) -> Value {
    let (status, res) = call(
        app,
        "POST",
        RECORDS,
        Some(json!({ "device": "Pixel 9", "records": list })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{res}");
    res
}

#[tokio::test]
async fn records_are_upserted_and_never_touch_the_window() {
    let app = app();
    sync(&app, week()).await;
    let (_, before) = call(&app, "GET", SYNC, None).await;
    let shown = activity(&app).await;
    let hr = record(
        "HeartRate",
        "hr-1",
        &json!({ "samples": [{ "time": "2026-09-02T14:00:00Z", "bpm": 120 }] }),
    );
    let list = [hr.clone(), record("Weight", "w-1", &json!({ "kg": 80.5 }))];
    let res = records(&app, &list).await;
    assert_eq!(
        res,
        json!({ "records": 2, "truncated": 0, "skipped": 0, "failed": 0 })
    );
    // Again: the same two, upserted.
    assert_eq!(records(&app, &list).await, res);
    // Bad items are counted, the rest kept: no kind, a bad id, no start,
    // data not an object.
    let res = records(
        &app,
        &[
            json!({ "id": "x-1", "start": "2026-09-02T14:00:00Z", "data": {} }),
            record("HeartRate", "a/b", &json!({})),
            json!({ "kind": "Steps", "id": "s-1", "data": {} }),
            json!({ "kind": "Steps", "id": "s-2", "start": "2026-09-02T14:00:00Z", "data": 7 }),
            hr,
        ],
    )
    .await;
    assert_eq!(
        res,
        json!({ "records": 1, "truncated": 0, "skipped": 4, "failed": 0 })
    );
    // The window, its last sync and what shows are as the sync left them.
    let (_, after) = call(&app, "GET", SYNC, None).await;
    assert_eq!(
        (&after["last_seen"], &after["last_result"]),
        (&before["last_seen"], &before["last_result"])
    );
    assert_eq!(activity(&app).await, shown);
}

#[tokio::test]
async fn an_oversized_record_is_kept_as_a_flag() {
    let app = app();
    let samples: Vec<Value> = (0..20_000)
        .map(|i| json!({ "time": "2026-09-02T14:00:00Z", "bpm": 60 + i % 100 }))
        .collect();
    let big = record(
        "HeartRate",
        "hr-big",
        &json!({ "id": "hr-big", "origin": "com.fitbit", "samples": samples }),
    );
    let res = records(&app, &[big]).await;
    assert_eq!(
        res,
        json!({ "records": 1, "truncated": 1, "skipped": 0, "failed": 0 })
    );
    // Over the route's 1 MiB: refused whole.
    let huge = "x".repeat(kaloriina::model::HEALTH_BYTES_MAX);
    let (status, res) = call(
        &app,
        "POST",
        RECORDS,
        Some(json!({ "device": "Pixel 9",
            "records": [record("Note", "n-1", &json!({ "text": huge }))] })),
    )
    .await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE, "{res}");
    let (status, _) = call(
        &app,
        "POST",
        "/api/profiles/99/sync/health/records",
        Some(json!({ "records": [] })),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn naps_add_to_the_days_sleep_and_follow_the_window() {
    let app = app();
    // The night of the 5th, a staged nap that noon (asleep 40 min), and a
    // nap of the 6th without stages (its time asleep isn't known).
    let mut records = night_records(&[]);
    let records_list = records.as_array_mut().unwrap();
    records_list.push(hc_sleep(
        "n-1",
        "2026-09-05T12:00:00Z",
        "2026-09-05T12:40:00Z",
        &[("2026-09-05T12:00:00Z", "2026-09-05T12:40:00Z", 4)],
    ));
    records_list.push(hc_sleep(
        "n-2",
        "2026-09-06T13:00:00Z",
        "2026-09-06T13:30:00Z",
        &[],
    ));
    hc_records(&app, 1, records).await;
    let res = sync(&app, body("2026-09-01", "2026-09-07", &[], &[])).await;
    assert_eq!(res["skipped"], 0, "{res}");
    let d = day_view(&app, "2026-09-05").await;
    assert_eq!(d["device_day"]["total_asleep_min"], 480, "{d}");
    let naps = d["naps"].as_array().unwrap();
    assert_eq!(naps.len(), 1, "{d}");
    assert_eq!(
        (
            &naps[0]["start_at"],
            &naps[0]["end_at"],
            &naps[0]["source"],
            &naps[0]["in_bed_min"]
        ),
        (
            &json!("2026-09-05T12:00:00Z"),
            &json!("2026-09-05T12:40:00Z"),
            &json!("health_connect"),
            &json!(40)
        )
    );
    assert_eq!(naps[0]["uid"].as_str().unwrap().len(), 32);
    let a = activity(&app).await;
    let sleep: Vec<(&Value, &Value, &Value)> = a["days"]
        .as_array()
        .unwrap()
        .iter()
        .map(|d| (&d["day"], &d["total_asleep_min"], &d["nap_in_bed_min"]))
        .collect();
    // A nap without its time asleep counts in bed, never asleep.
    assert_eq!(
        sleep,
        [
            (&json!("2026-09-05"), &json!(480), &json!(0)),
            (&json!("2026-09-06"), &Value::Null, &json!(30))
        ]
    );
    // The same window again, the nap of the 6th deleted on the phone: it
    // goes; the 5th's stays.
    let mut again = body("2026-09-01", "2026-09-07", &[], &[]);
    again["read"] = json!({ "SleepSession": ["s-5", "n-1"] });
    sync(&app, again).await;
    assert_eq!(day_view(&app, "2026-09-06").await["naps"], json!([]));
    assert_eq!(
        day_view(&app, "2026-09-05").await["naps"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

/// The Log card and Summary say the same of a night: each day carries the count
/// of the naps its sleep adds, beside the minutes (in `total_asleep_min`).
#[tokio::test]
async fn a_day_counts_the_naps_it_adds() {
    let app = app();
    // The 5th: a night 23:30–06:40 (30 min awake), a staged nap (15 of 20
    // min asleep) and one without stages; the 6th: a night alone.
    hc_records(
        &app,
        1,
        json!([
            hc_sleep(
                "s-5",
                "2026-09-04T23:30:00Z",
                "2026-09-05T06:40:00Z",
                &[("2026-09-04T23:30:00Z", "2026-09-05T00:00:00Z", 1)]
            ),
            hc_sleep(
                "n-1",
                "2026-09-05T12:00:00Z",
                "2026-09-05T12:20:00Z",
                &[
                    ("2026-09-05T12:00:00Z", "2026-09-05T12:05:00Z", 1),
                    ("2026-09-05T12:05:00Z", "2026-09-05T12:20:00Z", 4)
                ]
            ),
            hc_sleep("n-2", "2026-09-05T15:00:00Z", "2026-09-05T15:20:00Z", &[]),
            hc_sleep(
                "s-6",
                "2026-09-05T23:00:00Z",
                "2026-09-06T06:30:00Z",
                &[("2026-09-05T23:00:00Z", "2026-09-05T23:30:00Z", 1)]
            ),
        ]),
    )
    .await;
    sync(&app, body("2026-09-01", "2026-09-07", &[], &[])).await;
    let a = activity(&app).await;
    let days: Vec<(&Value, &Value, &Value, &Value)> = a["days"]
        .as_array()
        .unwrap()
        .iter()
        .map(|d| {
            (
                &d["day"],
                &d["total_asleep_min"],
                &d["naps"],
                &d["nap_in_bed_min"],
            )
        })
        .collect();
    assert_eq!(
        days,
        [
            (&json!("2026-09-05"), &json!(415), &json!(2), &json!(20)),
            (&json!("2026-09-06"), &json!(420), &json!(0), &json!(0))
        ]
    );
    let d = day_view(&app, "2026-09-05").await;
    assert_eq!(d["device_day"]["naps"], 2, "{d}");
}

#[tokio::test]
async fn device_heart_rate_reaches_the_session() {
    let app = app();
    let mut hard = run("r-1", "2026-09-02", "17:05:00", "17:50:00");
    hard["avg_hr"] = json!(142);
    hard["max_hr"] = json!(171);
    let mut wild = run("r-2", "2026-09-03", "17:05:00", "17:50:00");
    wild["avg_hr"] = json!(300);
    wild["max_hr"] = json!(171.5);
    let res = sync_runs(&app, &[hard, wild]).await;
    assert_eq!(res["skipped"], 1, "{res}");
    let raw = activity(&app).await;
    assert_eq!(
        (&raw["sessions"][0]["avg_hr"], &raw["sessions"][0]["max_hr"]),
        (&json!(142), &json!(171))
    );
    let list = sessions(&app).await;
    assert_eq!(
        list.iter()
            .map(|s| (s["avg_hr"].clone(), s["max_hr"].clone()))
            .collect::<Vec<_>>(),
        [(json!(142), json!(171)), (Value::Null, Value::Null)]
    );
    // A timed hand log claiming it takes the heart rate too.
    let app = super::app();
    let mine = log(
        &app,
        json!({ "day": "2026-09-02", "name": "Run", "minutes": 45, "type": "run",
                "start_at": "2026-09-02T17:00:00Z" }),
    )
    .await;
    let mut hard = run("r-1", "2026-09-02", "17:05:00", "17:50:00");
    hard["avg_hr"] = json!(142);
    hard["max_hr"] = json!(171);
    sync_runs(&app, &[hard]).await;
    let s = sessions(&app).await.remove(0);
    assert_eq!(
        (&s["id"], &s["avg_hr"], &s["max_hr"]),
        (&mine["id"], &json!(142), &json!(171))
    );
}

#[tokio::test]
async fn untimed_hand_log_claims_the_days_only_device_workout() {
    let app = app();
    let mine = log(
        &app,
        json!({ "day": "2026-09-02", "name": "Run", "minutes": 30, "type": "run" }),
    )
    .await;
    sync_runs(&app, &[run("r-1", "2026-09-02", "17:05:00", "17:50:00")]).await;
    let list = sessions(&app).await;
    assert_eq!(list.len(), 1, "{list:?}");
    let s = &list[0];
    // Empty fields filled: the start; the typed minutes stay.
    assert_eq!(
        (
            &s["id"],
            &s["source_key"],
            &s["start_at"],
            &s["minutes"],
            &s["distance_m"],
            &s["kcal"],
            &s["kcal_source"],
            &s["name"]
        ),
        (
            &mine["id"],
            &json!("r-1"),
            &json!("2026-09-02T17:05:00Z"),
            &json!(30),
            &json!(8200),
            &json!(410),
            &json!("health_connect"),
            &json!("Run")
        )
    );
    // Re-sync: nothing moves.
    sync_runs(&app, &[run("r-1", "2026-09-02", "17:05:00", "17:50:00")]).await;
    assert_eq!(sessions(&app).await, list);
    // Saved after the sync, it claims the promoted one (which goes).
    let later = log(
        &app,
        json!({ "day": "2026-09-03", "name": "Ride", "minutes": 60, "type": "cycling" }),
    )
    .await;
    assert_eq!(later["source_key"], Value::Null);
    let ride = device("c-1", "2026-09-04", 4, "07:00:00", "08:00:00");
    sync_runs(
        &app,
        &[run("r-1", "2026-09-02", "17:05:00", "17:50:00"), ride],
    )
    .await;
    let ridden = log(
        &app,
        json!({ "day": "2026-09-04", "name": "Ride", "minutes": 50, "type": "cycling" }),
    )
    .await;
    assert_eq!(
        (&ridden["source_key"], &ridden["minutes"]),
        (&json!("c-1"), &json!(50))
    );
    assert_eq!(keys(&sessions(&app).await), ["r-1", "-", "c-1"]);
}

#[tokio::test]
async fn untimed_hand_log_with_two_candidates_claims_none() {
    let app = app();
    log(
        &app,
        json!({ "day": "2026-09-02", "name": "Run", "minutes": 30, "type": "run" }),
    )
    .await;
    sync_runs(
        &app,
        &[
            run("r-1", "2026-09-02", "07:00:00", "07:30:00"),
            run("r-2", "2026-09-02", "17:05:00", "17:50:00"),
        ],
    )
    .await;
    assert_eq!(keys(&sessions(&app).await), ["-", "r-1", "r-2"]);
    // Two untimed runs that day and one device run: whose? Neither.
    let app = super::app();
    for name in ["Run", "Jog"] {
        log(
            &app,
            json!({ "day": "2026-09-02", "name": name, "minutes": 30, "type": "run" }),
        )
        .await;
    }
    sync_runs(&app, &[run("r-1", "2026-09-02", "17:05:00", "17:50:00")]).await;
    assert_eq!(keys(&sessions(&app).await), ["-", "-", "r-1"]);
}

#[tokio::test]
async fn a_claim_survives_the_device_and_its_deletion_is_remembered() {
    let app = app();
    let mine = log(
        &app,
        json!({ "day": "2026-09-02", "name": "Run", "minutes": 30, "type": "run" }),
    )
    .await;
    sync_runs(&app, &[run("r-1", "2026-09-02", "17:05:00", "17:50:00")]).await;
    // Gone from the device: the hand log keeps what it took.
    sync_runs(&app, &[]).await;
    let s = sessions(&app).await.remove(0);
    assert_eq!(
        (&s["id"], &s["source_key"], &s["start_at"], &s["distance_m"]),
        (
            &mine["id"],
            &Value::Null,
            &json!("2026-09-02T17:05:00Z"),
            &json!(8200)
        )
    );
    // Back, claimed again; the hand log deleted leaves a tombstone.
    sync_runs(&app, &[run("r-1", "2026-09-02", "17:05:00", "17:50:00")]).await;
    let s = sessions(&app).await.remove(0);
    assert_eq!(s["source_key"], "r-1");
    let (status, _) = call(
        &app,
        "DELETE",
        &format!("/api/profiles/1/activities/{}", s["id"]),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    sync_runs(&app, &[run("r-1", "2026-09-02", "17:05:00", "17:50:00")]).await;
    assert_eq!(sessions(&app).await, Vec::<Value>::new());
}

#[tokio::test]
async fn hand_energy_survives_a_refresh() {
    let app = app();
    let typed = log(
        &app,
        json!({ "day": "2026-09-02", "name": "Run", "minutes": 30, "type": "run", "kcal": 380 }),
    )
    .await;
    assert_eq!(typed["kcal_source"], "hand");
    log(
        &app,
        json!({ "day": "2026-09-03", "name": "Run", "minutes": 30, "type": "run" }),
    )
    .await;
    let resync = |kcal: i64| {
        let mut a = run("r-1", "2026-09-02", "17:05:00", "17:50:00");
        let mut b = run("r-2", "2026-09-03", "17:05:00", "17:50:00");
        a["kcal"] = json!(kcal);
        b["kcal"] = json!(kcal);
        [a, b]
    };
    sync_runs(&app, &resync(410)).await;
    let energy = |list: &[Value]| {
        list.iter()
            .map(|s| (s["kcal"].clone(), s["kcal_source"].clone()))
            .collect::<Vec<_>>()
    };
    assert_eq!(
        energy(&sessions(&app).await),
        [
            (json!(380), json!("hand")),
            (json!(410), json!("health_connect"))
        ]
    );
    // The device revises its energy: only the device's follows.
    sync_runs(&app, &resync(450)).await;
    assert_eq!(
        energy(&sessions(&app).await),
        [
            (json!(380), json!("hand")),
            (json!(450), json!("health_connect"))
        ]
    );
}

fn gh_exercise(rows: &[&str]) -> Value {
    json!({ "files": [{
        "name": "Takeout/Google Health/UserExercises_2026-05-31.csv",
        "text": format!("exercise_id,exercise_start,exercise_end,utc_offset,activity_name,\
            deletion_reason,manually_logged_total_calories,tracker_total_calories,\
            manually_logged_total_distance_mm,tracker_total_distance_mm\n{}\n", rows.join("\n")) }] })
}

async fn gh_import(app: &Router, body: Value) -> Value {
    let (status, res) = call(
        app,
        "POST",
        "/api/profiles/1/import/google-health",
        Some(body),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{res}");
    res
}

#[tokio::test]
async fn a_repeated_import_claims_once() {
    let app = app();
    let mine = log(
        &app,
        json!({ "day": "2026-09-02", "name": "Walk", "minutes": 30, "type": "walk" }),
    )
    .await;
    let walk = gh_exercise(&[
        "11,2026-09-02T07:00:00Z,2026-09-02T07:40:00Z,+00:00,Outdoor Walk,,,120,,2400000",
    ]);
    let res = gh_import(&app, walk.clone()).await;
    assert_eq!(
        (&res["activities"], &res["kept"]),
        (&json!(0), &json!(1)),
        "{res}"
    );
    let s = sessions(&app).await;
    assert_eq!(s.len(), 1);
    assert_eq!(
        (
            &s[0]["id"],
            &s[0]["source_key"],
            &s[0]["start_at"],
            &s[0]["minutes"],
            &s[0]["kcal"],
            &s[0]["kcal_source"],
            &s[0]["distance_m"]
        ),
        (
            &mine["id"],
            &json!("gh-11"),
            &json!("2026-09-02T07:00:00Z"),
            &json!(30),
            &json!(120),
            &json!("import"),
            &json!(2400)
        )
    );
    let res = gh_import(&app, walk).await;
    assert_eq!(
        (&res["activities"], &res["kept"]),
        (&json!(0), &json!(1)),
        "{res}"
    );
    assert_eq!(sessions(&app).await, s, "nothing moved");
}

#[tokio::test]
async fn hand_device_and_import_make_one_session() {
    let app = app();
    let mine = log(
        &app,
        json!({ "day": "2026-09-02", "name": "Evening run", "minutes": 30, "type": "run" }),
    )
    .await;
    let gh = gh_exercise(&[
        "21,2026-09-02T17:00:00Z,2026-09-02T17:45:00Z,+00:00,Outdoor Run,,,300,,8000000",
    ]);
    gh_import(&app, gh.clone()).await;
    // The device's copy beats the import's: re-keyed, its values in.
    let mut r = run("r-1", "2026-09-02", "17:05:00", "17:50:00");
    r["avg_hr"] = json!(150);
    sync_runs(&app, &[r]).await;
    gh_import(&app, gh).await;
    let list = sessions(&app).await;
    assert_eq!(list.len(), 1, "{list:?}");
    let s = &list[0];
    assert_eq!(
        (
            &s["id"],
            &s["name"],
            &s["source_key"],
            &s["start_at"],
            &s["minutes"],
            &s["kcal"],
            &s["kcal_source"],
            &s["distance_m"],
            &s["avg_hr"]
        ),
        (
            &mine["id"],
            &json!("Evening run"),
            &json!("r-1"),
            &json!("2026-09-02T17:05:00Z"),
            &json!(45),
            &json!(410),
            &json!("health_connect"),
            &json!(8200),
            &json!(150)
        )
    );
}

#[tokio::test]
async fn a_days_total_energy_is_kept_in_bounds() {
    // Health Connect's TotalCaloriesBurned, the first source of what a day
    // burned (ADR 0020); out of bounds it's dropped like any value.
    let app = app();
    let total = |d: &str, kcal: i64| full_day(&json!({ "day": d, "total_kcal": kcal, "steps": 1 }));
    let res = sync(
        &app,
        body(
            "2026-09-01",
            "2026-09-02",
            &[total("2026-09-01", 2450), total("2026-09-02", 40_000)],
            &[],
        ),
    )
    .await;
    assert_eq!(res["skipped"], 1, "{res}");
    let a = activity(&app).await;
    assert_eq!(a["days"][0], total("2026-09-01", 2450));
    let (_, d) = call(&app, "GET", "/api/profiles/1/day/2026-09-01", None).await;
    assert_eq!(d["device_day"]["total_kcal"], 2450, "{d}");
}

#[tokio::test]
async fn naps_logged_by_hand_are_kept_once_and_survive_a_sync() {
    let app = app();
    let naps = "/api/profiles/1/naps";
    let nap = json!({ "uid": "nap-hand-0001", "day": "2026-09-06",
        "start_at": "2026-09-06T13:00:00+03:00", "end_at": "2026-09-06T13:25:00+03:00" });
    let (status, made) = call(&app, "POST", naps, Some(nap.clone())).await;
    assert_eq!(status, StatusCode::CREATED, "{made}");
    assert_eq!(
        (&made["source"], &made["in_bed_min"], &made["start_at"]),
        (&json!("hand"), &json!(25), &json!("2026-09-06T10:00:00Z"))
    );
    // A retry saves nothing more.
    let (status, again) = call(&app, "POST", naps, Some(nap.clone())).await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(again, made);
    let d = day_view(&app, "2026-09-06").await;
    assert_eq!(d["naps"].as_array().unwrap().len(), 1, "{d}");
    assert_eq!(d["device_day"]["total_asleep_min"], 25, "{d}");

    // Too long, backwards or a bad uid: 400 naming the field.
    for (patch, field) in [
        (json!({ "end_at": "2026-09-06T16:00:00+03:00" }), "end_at"),
        (json!({ "end_at": "2026-09-06T12:00:00+03:00" }), "end_at"),
        (json!({ "uid": "x" }), "uid"),
        (json!({ "day": "6.9.2026" }), "day"),
    ] {
        let mut bad = nap.clone();
        bad["uid"] = json!("nap-hand-0002");
        for (k, v) in patch.as_object().unwrap() {
            bad[k] = v.clone();
        }
        let (status, err) = call(&app, "POST", naps, Some(bad)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{err}");
        assert_eq!(err["field"], field, "{err}");
    }

    // A sync replacing the window keeps it.
    sync(&app, body("2026-09-01", "2026-09-07", &[], &[])).await;
    assert_eq!(
        day_view(&app, "2026-09-06").await["naps"][0]["uid"],
        "nap-hand-0001"
    );

    // A synced nap goes with its sync; a hand one by its uid.
    hc_records(
        &app,
        1,
        json!([hc_sleep(
            "n-9",
            "2026-09-05T12:00:00Z",
            "2026-09-05T12:30:00Z",
            &[]
        )]),
    )
    .await;
    let synced = day_view(&app, "2026-09-05").await["naps"][0]["uid"].clone();
    let (status, err) = call(
        &app,
        "DELETE",
        &format!("{naps}/{}", synced.as_str().unwrap()),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{err}");
    assert_eq!(err["code"], "device_read_only");
    let (status, _) = call(&app, "DELETE", &format!("{naps}/nap-hand-0001"), None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(day_view(&app, "2026-09-06").await["naps"], json!([]));
    let (status, _) = call(&app, "DELETE", &format!("{naps}/nap-hand-0001"), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = call(&app, "POST", "/api/profiles/9/naps", Some(nap)).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn stages_follow_the_window_and_export() {
    let app = app();
    // A night 23:10–07:05 (UTC) with its spans out of order; one of an
    // unknown type (0) is no span.
    hc_records(
        &app,
        1,
        json!([hc_sleep(
            "s-5",
            "2026-09-04T20:10:00Z",
            "2026-09-05T04:05:00Z",
            &[
                ("2026-09-05T00:10:00Z", "2026-09-05T00:40:00Z", 5),
                ("2026-09-04T20:10:00Z", "2026-09-04T20:40:00Z", 4),
                ("2026-09-04T20:40:00Z", "2026-09-04T20:42:00Z", 1),
                ("2026-09-04T20:42:00Z", "2026-09-05T00:10:00Z", 6),
                ("2026-09-05T01:00:00Z", "2026-09-05T01:30:00Z", 0),
            ]
        )]),
    )
    .await;
    let res = sync(&app, body("2026-09-01", "2026-09-07", &[], &[])).await;
    assert_eq!(res["skipped"], 0, "{res}");
    let d = day_view(&app, "2026-09-05").await;
    let shown: Vec<(&str, &str)> = d["stages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| {
            (
                s["start_at"].as_str().unwrap(),
                s["stage"].as_str().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        shown,
        [
            ("2026-09-04T20:10:00Z", "light"),
            ("2026-09-04T20:40:00Z", "awake"),
            ("2026-09-04T20:42:00Z", "rem"),
            ("2026-09-05T00:10:00Z", "deep"),
        ],
        "{d}"
    );
    assert_eq!(d["stages"][0]["end_at"], "2026-09-04T20:40:00Z");

    // One row per span in the file; a copy imports them.
    let (_, file) = call(&app, "GET", "/api/profiles/1/export", None).await;
    assert_eq!(
        file["sleep_stages"][0],
        json!({ "day": "2026-09-05", "start_at": "2026-09-04T20:10:00Z",
                "end_at": "2026-09-04T20:40:00Z", "stage": "light", "source": "health_connect" })
    );
    let mut copy = file.clone();
    copy["profile"]["name"] = json!("Copy");
    let (status, p) = call(&app, "POST", "/api/profiles/import", Some(copy.clone())).await;
    assert_eq!(status, StatusCode::CREATED, "{p}");
    let uri = format!("/api/profiles/{}/day/2026-09-05", p["id"]);
    let (_, copied) = call(&app, "GET", &uri, None).await;
    assert_eq!(copied["stages"], d["stages"]);
    // A span the vocabulary lacks: the file is refused, naming the field.
    copy["profile"]["name"] = json!("Bad");
    copy["sleep_stages"][0]["stage"] = json!("dozing");
    let (status, e) = call(&app, "POST", "/api/profiles/import", Some(copy)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{e}");

    // The session deleted on the phone: its spans go with the window.
    let mut gone = body("2026-09-01", "2026-09-07", &[], &[]);
    gone["read"] = json!({ "SleepSession": [] });
    sync(&app, gone).await;
    assert_eq!(day_view(&app, "2026-09-05").await["stages"], json!([]));
}

#[tokio::test]
async fn day_heart_rate_is_kept_in_bounds() {
    // The all-day average, low and high: each dropped alone when out of
    // bounds, the day kept. (A night's heart rate goes with its night.)
    let app = app();
    let heart = json!({ "day": "2026-09-01", "avg_hr": 68, "min_hr": 48, "max_hr": 141 });
    let bad = json!({ "day": "2026-09-02", "steps": 10, "avg_hr": 300, "min_hr": 19,
        "max_hr": 120.5 });
    let res = sync(
        &app,
        body("2026-09-01", "2026-09-02", &[heart.clone(), bad], &[]),
    )
    .await;
    assert_eq!(
        (&res["days"], &res["skipped"]),
        (&json!(2), &json!(1)),
        "{res}"
    );
    let a = activity(&app).await;
    assert_eq!(a["days"][0], full_day(&heart));
    assert_eq!(
        a["days"][1],
        full_day(&json!({ "day": "2026-09-02", "steps": 10 }))
    );
    let (_, file) = call(&app, "GET", "/api/profiles/1/export", None).await;
    assert_eq!(file["device_days"][0]["max_hr"], 141, "{file}");
}

// ---------------------------------------------------- the health store

#[tokio::test]
async fn records_outcome_is_kept_in_sync_state() {
    // The phone posts a sync's pages, then its window.
    let app = app();
    let (status, res) = call(
        &app,
        "POST",
        RECORDS,
        Some(json!({ "device": "Pixel 9", "skipped": 2, "failed": 1,
            "records": [record("Weight", "w-1", &json!({ "kg": 80.5 }))] })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{res}");
    assert_eq!(
        res,
        json!({ "records": 1, "truncated": 0, "skipped": 2, "failed": 1 })
    );
    // A second page of the same sync adds to it; its window keeps it.
    let page = |id: &str, failed: u64| json!({ "failed": failed, "records": [record("Weight", id, &json!({}))] });
    let (status, _) = call(&app, "POST", RECORDS, Some(page("w-2", 2))).await;
    assert_eq!(status, StatusCode::OK);
    sync(&app, week()).await;
    let (_, st) = call(&app, "GET", SYNC, None).await;
    let r = &st["records_result"];
    assert_eq!(
        (&r["records"], &r["truncated"], &r["skipped"], &r["failed"]),
        (&json!(2), &json!(0), &json!(2), &json!(3)),
        "{st}"
    );
    assert!(r["at"].as_i64().is_some(), "{st}");
    // The next sync's first page starts a new outcome.
    call(&app, "POST", RECORDS, Some(page("w-3", 0))).await;
    let (_, st) = call(&app, "GET", SYNC, None).await;
    assert_eq!(
        (
            &st["records_result"]["records"],
            &st["records_result"]["failed"]
        ),
        (&json!(1), &json!(0)),
        "{st}"
    );
}

#[tokio::test]
async fn untimed_claim_keeps_typed_minutes() {
    let app = app();
    let mine = log(
        &app,
        json!({ "day": "2026-09-02", "name": "Gym", "minutes": 55, "type": "run" }),
    )
    .await;
    sync_runs(&app, &[run("r-1", "2026-09-02", "17:05:00", "17:45:00")]).await;
    let s = sessions(&app).await.remove(0);
    assert_eq!(
        (&s["id"], &s["source_key"], &s["start_at"], &s["minutes"]),
        (
            &mine["id"],
            &json!("r-1"),
            &json!("2026-09-02T17:05:00Z"),
            &json!(55)
        ),
        "the start fills, the typed minutes stay"
    );
}

#[tokio::test]
async fn distance_is_dropped_on_non_distance_types() {
    let app = app();
    let mut hiit = device("h-1", "2026-09-02", 20, "17:00:00", "17:30:00");
    hiit["distance_m"] = json!(500);
    let mut ride = device("c-1", "2026-09-03", 4, "07:00:00", "08:00:00");
    ride["distance_m"] = json!(20_000);
    sync_runs(&app, &[hiit.clone(), ride.clone()]).await;
    let list = sessions(&app).await;
    assert_eq!(
        list.iter()
            .map(|s| (s["type"].clone(), s["distance_m"].clone()))
            .collect::<Vec<_>>(),
        [
            (json!("hiit"), Value::Null),
            (json!("cycling"), json!(20_000))
        ]
    );
    // A refresh keeps it off, and the session can be renamed.
    sync_runs(&app, &[hiit, ride]).await;
    let s = sessions(&app).await.remove(0);
    assert_eq!(s["distance_m"], Value::Null);
    let mut input = as_input(&s);
    input["name"] = json!("Intervals");
    let (status, res) = call(
        &app,
        "PUT",
        &format!("/api/profiles/1/activities/{}", s["id"]),
        Some(input),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{res}");
    assert_eq!(res["name"], "Intervals");
}

#[tokio::test]
async fn nap_day_must_match_its_times() {
    let app = app();
    let nap = |day: &str| {
        json!({ "day": day, "start_at": "2026-09-06T13:00:00+03:00",
                "end_at": "2026-09-06T13:25:00+03:00" })
    };
    for day in ["2025-09-06", "2026-09-08", "2026-09-04"] {
        let (status, err) = call(&app, "POST", "/api/profiles/1/naps", Some(nap(day))).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{day}: {err}");
        assert_eq!(err["field"], "day", "{err}");
    }
    // Its wake day, or a day either side (a zone apart).
    for day in ["2026-09-05", "2026-09-06", "2026-09-07"] {
        let (status, err) = call(&app, "POST", "/api/profiles/1/naps", Some(nap(day))).await;
        assert_eq!(status, StatusCode::CREATED, "{day}: {err}");
    }
}

/// A phone's nap, asleep `asleep_min` of it.
/// The phone's nap `key` on 2026-09-06, staged asleep throughout, kept raw;
/// then a window over the day.
async fn hc_nap(app: &Router, key: &str, from: &str, to: &str) {
    let (start, end) = (format!("2026-09-06T{from}Z"), format!("2026-09-06T{to}Z"));
    hc_records(
        app,
        1,
        json!([hc_sleep(key, &start, &end, &[(&start, &end, 4)])]),
    )
    .await;
    sync(app, body("2026-09-06", "2026-09-06", &[], &[])).await;
}

#[tokio::test]
async fn hand_nap_hides_the_device_copy() {
    let app = app();
    let (status, mine) = call(
        &app,
        "POST",
        "/api/profiles/1/naps",
        Some(
            json!({ "day": "2026-09-06", "start_at": "2026-09-06T12:00:00Z",
                     "end_at": "2026-09-06T12:40:00Z" }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{mine}");
    hc_nap(&app, "n-1", "12:01:00", "12:39:00").await;
    let d = day_view(&app, "2026-09-06").await;
    assert_eq!(d["device_day"]["total_asleep_min"], 40, "counted once: {d}");
    assert_eq!(
        d["naps"]
            .as_array()
            .unwrap()
            .iter()
            .map(|n| n["source"].clone())
            .collect::<Vec<_>>(),
        [json!("hand")],
        "{d}"
    );
    // The hand nap deleted: the device's shows again.
    let (status, _) = call(
        &app,
        "DELETE",
        &format!("/api/profiles/1/naps/{}", mine["uid"].as_str().unwrap()),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let d = day_view(&app, "2026-09-06").await;
    assert_eq!(d["device_day"]["total_asleep_min"], 38, "{d}");
    assert_eq!(d["naps"][0]["source"], "health_connect", "{d}");
}

fn gh_sleep(rows: &[&str]) -> Value {
    json!({ "files": [{
        "name": "Takeout/Google Health/UserSleeps_2026-06-30.csv",
        "text": format!("sleep_id,sleep_type,sleep_start,sleep_end,start_utc_offset,\
            end_utc_offset,data_source,algorithm_version\n{}\n", rows.join("\n")) }] })
}

#[tokio::test]
async fn device_nap_hides_import_nap_without_deleting() {
    let app = app();
    let res = gh_import(
        &app,
        gh_sleep(&[
            "7,CLASSIC,2026-09-06T12:00:00Z,2026-09-06T12:45:00Z,+00:00,+00:00,DERIVED,sleep_session_v1",
        ]),
    )
    .await;
    assert_eq!(res["naps"], 1, "{res}");
    hc_nap(&app, "n-1", "12:05:00", "12:35:00").await;
    let d = day_view(&app, "2026-09-06").await;
    assert_eq!(d["device_day"]["total_asleep_min"], 30, "{d}");
    assert_eq!(d["naps"][0]["source"], "health_connect", "{d}");
    assert_eq!(d["naps"].as_array().unwrap().len(), 1, "{d}");
    // Remove synced data: the import's nap is still there.
    let (status, _) = call(&app, "DELETE", SYNC, None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    // The import's nap has no stages: in bed, not asleep.
    let d = day_view(&app, "2026-09-06").await;
    assert_eq!(
        (
            &d["device_day"]["total_asleep_min"],
            &d["device_day"]["nap_in_bed_min"]
        ),
        (&Value::Null, &json!(45)),
        "{d}"
    );
    assert_eq!(d["naps"][0]["source"], "import", "{d}");
}

#[tokio::test]
async fn deleted_rekeyed_import_stays_deleted() {
    let app = app();
    let gh = gh_exercise(&[
        "1,2026-09-02T17:00:00Z,2026-09-02T17:45:00Z,+00:00,Strength training,,,300,,",
    ]);
    assert_eq!(gh_import(&app, gh.clone()).await["activities"], 1);
    // The device's HIIT copy re-keys it.
    sync_runs(
        &app,
        &[device("hc-1", "2026-09-02", 20, "17:00:30", "17:45:00")],
    )
    .await;
    let list = sessions(&app).await;
    assert_eq!(keys(&list), ["hc-1"], "{list:?}");
    let (status, _) = call(
        &app,
        "DELETE",
        &format!("/api/profiles/1/activities/{}", list[0]["id"]),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let res = gh_import(&app, gh).await;
    assert_eq!(
        (&res["activities"], &res["kept"]),
        (&json!(0), &json!(1)),
        "{res}"
    );
    assert_eq!(sessions(&app).await, Vec::<Value>::new());
}

#[tokio::test]
async fn removing_the_import_keeps_a_claimed_hand_log() {
    let app = app();
    // A hand log the import claims, an import a later hand log claims, and
    // an import nobody claims.
    let walk = log(
        &app,
        json!({ "day": "2026-09-02", "name": "Walk", "minutes": 30, "type": "walk" }),
    )
    .await;
    let gh = gh_exercise(&[
        "11,2026-09-02T07:00:00Z,2026-09-02T07:40:00Z,+00:00,Outdoor Walk,,,120,,2400000",
        "12,2026-09-03T17:00:00Z,2026-09-03T17:45:00Z,+00:00,Outdoor Run,,,300,,8000000",
        "13,2026-09-04T17:00:00Z,2026-09-04T17:30:00Z,+00:00,Biking,,,200,,",
    ]);
    gh_import(&app, gh.clone()).await;
    let run = log(
        &app,
        json!({ "day": "2026-09-03", "name": "Run", "minutes": 40, "kcal": 333, "type": "run" }),
    )
    .await;
    let list = sessions(&app).await;
    assert_eq!(keys(&list), ["gh-11", "gh-12", "gh-13"], "{list:?}");
    let source = |s: &Value| s["source"].as_str().unwrap().to_owned();
    assert_eq!(
        list.iter().map(source).collect::<Vec<_>>(),
        ["hand", "hand", "import"]
    );
    // A second untimed hand log that day claims nothing a hand logged.
    let again = log(
        &app,
        json!({ "day": "2026-09-02", "name": "Stroll", "minutes": 10, "type": "walk" }),
    )
    .await;
    assert_eq!(again["source_key"], Value::Null, "{again}");
    let (status, res) = call(&app, "DELETE", "/api/profiles/1/import/google-health", None).await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{res}");
    // The hand logs stay, without the import's key or energy; the import's
    // own session goes.
    let list = sessions(&app).await;
    let kept: Vec<_> = list
        .iter()
        .map(|s| {
            (
                s["id"].clone(),
                s["source_key"].clone(),
                s["kcal"].clone(),
                s["kcal_source"].clone(),
            )
        })
        .collect();
    assert_eq!(
        kept,
        [
            (walk["id"].clone(), Value::Null, Value::Null, Value::Null),
            (again["id"].clone(), Value::Null, Value::Null, Value::Null),
            (run["id"].clone(), Value::Null, json!(333), json!("hand")),
        ],
        "{list:?}"
    );
    // Importing again brings the unclaimed one back and touches no hand log.
    let res = gh_import(&app, gh).await;
    assert_eq!(
        (&res["activities"], &res["kept"]),
        (&json!(1), &json!(2)),
        "{res}"
    );
    let after = sessions(&app).await;
    assert_eq!(keys(&after), ["-", "-", "-", "gh-13"], "{after:?}");
    assert_eq!(after[..3], list[..], "hand logs untouched");
}

// ---------------------------------- resting energy from Health Connect

const SAMSUNG: &str = "com.sec.android.app.shealth";
const WITHINGS: &str = "com.withings.wiscale2";

/// A basal metabolic rate the phone keeps raw: `kcal` a day on `day` at
/// `time`, from `origin`.
fn bmr(id: &str, day: &str, time: &str, kcal: i64, origin: &str) -> Value {
    let at = format!("{day}T{time}Z");
    json!({ "kind": "BasalMetabolicRate", "id": id, "start": at,
            "data": { "time": at, "zone_offset": "Z", "kcal_per_day": kcal,
                      "metadata": { "data_origin": origin } } })
}

async fn device_days(app: &Router, from: &str, to: &str) -> Value {
    let uri = format!("/api/profiles/1/device-days?from={from}&to={to}");
    let (status, res) = call(app, "GET", &uri, None).await;
    assert_eq!(status, StatusCode::OK, "{res}");
    res
}

/// The days resting energy is in effect, and how much.
fn resting(days: &Value) -> Vec<(String, Value)> {
    days["resting"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| (r["day"].as_str().unwrap().to_owned(), r["kcal"].clone()))
        .collect()
}

/// Resting energy through the window (the page first, this phone's order):
/// the day's latest of the day. A day with resting energy alone is no
/// device day.
#[tokio::test]
async fn resting_via_the_window() {
    let app = app();
    hc_records(
        &app,
        1,
        json!([
            bmr("b-1", "2026-09-03", "06:00:00", 1700, SAMSUNG),
            bmr("b-2", "2026-09-03", "18:00:00", 1720, SAMSUNG),
        ]),
    )
    .await;
    sync(&app, body("2026-09-01", "2026-09-07", &[], &[])).await;
    let d = day_view(&app, "2026-09-03").await;
    assert_eq!(
        d["resting"],
        json!({ "kcal": 1720.0, "origin": SAMSUNG }),
        "{d}"
    );
    assert_eq!(d["device_day"], Value::Null, "{d}");
    let days = device_days(&app, "2026-09-03", "2026-09-03").await;
    assert_eq!(days["days"], json!([]), "{days}");
    assert_eq!(resting(&days), [("2026-09-03".to_owned(), json!(1720.0))]);
}

/// The window first, its page after (an older phone's order).
#[tokio::test]
async fn resting_via_a_later_records_page() {
    let app = app();
    sync(&app, body("2026-09-01", "2026-09-07", &[], &[])).await;
    hc_records(
        &app,
        1,
        json!([bmr("b-1", "2026-09-03", "06:00:00", 1720, SAMSUNG)]),
    )
    .await;
    assert_eq!(
        day_view(&app, "2026-09-03").await["resting"]["kcal"],
        1720.0
    );
}

/// Day + 6 carries the latest; day + 7 is none (Mifflin on the client), on
/// days with no device row too. An activity takes the one in
/// effect on its day.
#[tokio::test]
async fn day_plus_6_carries_day_plus_7_doesnt() {
    let app = app();
    hc_records(
        &app,
        1,
        json!([bmr("b-1", "2026-09-03", "06:00:00", 1720, SAMSUNG)]),
    )
    .await;
    let days = device_days(&app, "2026-09-01", "2026-09-12").await;
    let carried: Vec<String> = resting(&days).into_iter().map(|r| r.0).collect();
    assert_eq!(
        carried,
        [
            "2026-09-03",
            "2026-09-04",
            "2026-09-05",
            "2026-09-06",
            "2026-09-07",
            "2026-09-08",
            "2026-09-09"
        ]
    );
    assert_eq!(
        day_view(&app, "2026-09-09").await["resting"]["kcal"],
        1720.0
    );
    assert_eq!(day_view(&app, "2026-09-10").await["resting"], Value::Null);
    let run = log(
        &app,
        json!({ "day": "2026-09-09", "name": "Run", "minutes": 30, "type": "run" }),
    )
    .await;
    assert_eq!(run["bmr_kcal"], 1720.0, "{run}");
    let late = log(
        &app,
        json!({ "day": "2026-09-10", "name": "Run", "minutes": 30, "type": "run" }),
    )
    .await;
    assert_eq!(late["bmr_kcal"], Value::Null, "{late}");
}

/// One origin a profile: the app with the most days of one in
/// the 90 days up to the latest. Another app's never shows, so a day never
/// switches vendor.
#[tokio::test]
async fn one_origin_of_two() {
    let app = app();
    hc_records(
        &app,
        1,
        json!([
            bmr("s-1", "2026-09-01", "06:00:00", 1700, SAMSUNG),
            bmr("s-2", "2026-09-02", "06:00:00", 1710, SAMSUNG),
            bmr("w-1", "2026-09-02", "07:00:00", 1900, WITHINGS),
            bmr("w-2", "2026-09-03", "07:00:00", 1910, WITHINGS),
            bmr("s-3", "2026-09-04", "06:00:00", 1720, SAMSUNG),
        ]),
    )
    .await;
    let days = device_days(&app, "2026-09-01", "2026-09-04").await;
    assert_eq!(
        resting(&days),
        [
            ("2026-09-01".to_owned(), json!(1700.0)),
            ("2026-09-02".to_owned(), json!(1710.0)),
            // Withings' own day: Samsung Health's carried.
            ("2026-09-03".to_owned(), json!(1710.0)),
            ("2026-09-04".to_owned(), json!(1720.0)),
        ]
    );
    assert!(
        days["resting"]
            .as_array()
            .unwrap()
            .iter()
            .all(|r| r["origin"] == SAMSUNG),
        "{days}"
    );
}

/// The export keeps each day's own value, as stored; the carry is served,
/// never stored.
#[tokio::test]
async fn the_export_keeps_the_stored_resting_not_the_carried() {
    let app = app();
    hc_records(
        &app,
        1,
        json!([bmr("b-1", "2026-09-03", "06:00:00", 1720, SAMSUNG)]),
    )
    .await;
    sync(
        &app,
        body(
            "2026-09-01",
            "2026-09-07",
            &[day("2026-09-05", 300, 5000)],
            &[],
        ),
    )
    .await;
    let (_, file) = call(&app, "GET", "/api/profiles/1/export", None).await;
    let stored: Vec<(&Value, &Value, &Value)> = file["device_days"]
        .as_array()
        .unwrap()
        .iter()
        .map(|d| (&d["day"], &d["bmr_kcal"], &d["bmr_origin"]))
        .collect();
    assert_eq!(
        stored,
        [
            (&json!("2026-09-03"), &json!(1720.0), &json!(SAMSUNG)),
            (&json!("2026-09-05"), &Value::Null, &Value::Null)
        ]
    );
    // Served: the 5th carries it.
    assert_eq!(
        day_view(&app, "2026-09-05").await["resting"]["kcal"],
        1720.0
    );
}

// ---------------------------------- a day's distance from Health Connect

const FIT: &str = "com.google.android.apps.fitness";
const GARMIN: &str = "com.garmin.android.apps.connectmobile";

/// A distance the phone keeps raw: `meters` from `time` on `day`, from
/// `origin`.
fn distance(id: &str, day: &str, time: &str, meters: f64, origin: &str) -> Value {
    let at = format!("{day}T{time}Z");
    json!({ "kind": "Distance", "id": id, "start": at, "end": at,
            "data": { "start_time": at, "start_zone_offset": "Z", "end_time": at,
                      "end_zone_offset": "Z", "meters": meters,
                      "metadata": { "data_origin": origin } } })
}

/// The days' stored distance, as the device days serve it.
async fn distances(app: &Router, from: &str, to: &str) -> Vec<(String, Value)> {
    device_days(app, from, to).await["days"]
        .as_array()
        .unwrap()
        .iter()
        .map(|d| {
            (
                d["day"].as_str().unwrap().to_owned(),
                d["distance_m"].clone(),
            )
        })
        .collect()
}

/// A day's distance is its records' sum in whole metres, from one origin
/// (the app with the most days of one: two apps never add up), whichever
/// comes first, the window or its page; the window keeps it.
#[tokio::test]
async fn a_days_distance_from_one_origin_survives_the_window() {
    let app = app();
    sync(
        &app,
        body(
            "2026-09-01",
            "2026-09-07",
            &[day("2026-09-02", 300, 5000)],
            &[],
        ),
    )
    .await;
    hc_records(
        &app,
        1,
        json!([
            distance("f-1", "2026-09-02", "08:00:00", 1200.4, FIT),
            distance("f-2", "2026-09-02", "17:00:00", 2900.3, FIT),
            distance("g-1", "2026-09-02", "17:00:00", 2950.0, GARMIN),
            distance("f-3", "2026-09-03", "09:00:00", 800.0, FIT),
        ]),
    )
    .await;
    let want = [
        ("2026-09-02".to_owned(), json!(4101)),
        ("2026-09-03".to_owned(), json!(800)),
    ];
    assert_eq!(distances(&app, "2026-09-01", "2026-09-07").await, want);
    // The next window: the days are made again, the distance with them.
    sync(
        &app,
        body(
            "2026-09-01",
            "2026-09-07",
            &[day("2026-09-02", 310, 5100)],
            &[],
        ),
    )
    .await;
    assert_eq!(distances(&app, "2026-09-01", "2026-09-07").await, want);
    // The export keeps it.
    let (_, file) = call(&app, "GET", "/api/profiles/1/export", None).await;
    assert_eq!(file["device_days"][0]["distance_m"], 4101, "{file}");
}
