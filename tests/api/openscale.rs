//! openScale sync's webhook, the connection and the weight log it feeds. The
//! fixtures are what `WebhookSync.kt` sends: its keys, its date format
//! (`yyyy-MM-dd'T'HH:mm:ss.SSS'Z'`, UTC), `0` for a missing value, `values[]`
//! and the batch envelope whose items carry no event.

use super::*;
use common::raw;
use jiff::Timestamp;
use jiff::tz::TimeZone;
use kaloriina::{AppState, router};

const HOOK: &str = "/api/profiles/1/sync/openscale";

fn helsinki() -> TimeZone {
    TimeZone::get("Europe/Helsinki").unwrap()
}

/// An app whose days follow Europe/Helsinki.
fn app_tz() -> Router {
    let mut state = AppState::new(open(FsPath::new(":memory:")).unwrap(), NO_OFF.to_owned());
    state.tz = helsinki();
    router(state)
}

fn fixture(name: &str) -> Value {
    let text = match name {
        "insert" => include_str!("../fixtures/openscale/insert.json"),
        "batch" => include_str!("../fixtures/openscale/batch.json"),
        "delete" => include_str!("../fixtures/openscale/delete.json"),
        "clear" => include_str!("../fixtures/openscale/clear.json"),
        _ => include_str!("../fixtures/openscale/test.json"),
    };
    serde_json::from_str(text).unwrap()
}

/// openScale's date format.
fn date(ms: i64) -> String {
    Timestamp::from_millisecond(ms)
        .unwrap()
        .strftime("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string()
}

/// One measurement as `measurementToMap` builds it (no `values`, 0 for none).
fn m(id: i64, user: i64, at: &str, kg: f64) -> Value {
    json!({ "id": id, "userId": user, "username": if user == 1 { "Alex" } else { "Anna" },
            "date": at, "weight": kg, "body_fat": 0.0, "water": 0.0, "muscle": 0.0 })
}

fn event(name: &str, mut item: Value) -> Value {
    item["event"] = json!(name);
    item
}

fn batch(items: &[Value]) -> Value {
    json!({ "event": "insert", "measurements": items })
}

async fn post(app: &Router, body: Value) -> Value {
    let (status, res) = call(app, "POST", HOOK, Some(body)).await;
    assert_eq!(status, StatusCode::OK, "{res}");
    res
}

fn counts(applied: u64, skipped: u64, ignored: u64) -> Value {
    json!({ "applied": applied, "skipped": skipped, "ignored": ignored })
}

async fn bind(app: &Router, user: i64) -> Value {
    let (status, res) = call(app, "PUT", HOOK, Some(json!({ "user_id": user }))).await;
    assert_eq!(status, StatusCode::OK, "{res}");
    res
}

/// An app bound to openScale user 1 (Alex), with nothing stored yet.
async fn bound_app() -> Router {
    let app = app_tz();
    post(&app, fixture("clear")).await;
    bind(&app, 1).await;
    app
}

async fn weights(app: &Router) -> Value {
    call(app, "GET", "/api/profiles/1/weights", None).await.1
}

async fn day(app: &Router, d: &str) -> Value {
    call(app, "GET", &format!("/api/profiles/1/day/{d}"), None)
        .await
        .1
}

async fn readings(app: &Router) -> Value {
    call(app, "GET", "/api/profiles/1/scale", None).await.1
}

async fn rev(app: &Router) -> i64 {
    call(app, "GET", "/api/profiles/1", None).await.1["rev"]
        .as_i64()
        .unwrap()
}

fn local_day(ms: i64) -> String {
    Timestamp::from_millisecond(ms)
        .unwrap()
        .to_zoned(helsinki())
        .date()
        .to_string()
}

// ----------------------------------------- the envelope and its limits

#[tokio::test]
async fn only_a_wrong_envelope_is_refused() {
    let app = app_tz();
    for body in [
        "not json",
        "[1, 2]",
        "\"insert\"",
        r#"{"measurements": {}}"#,
    ] {
        let (status, res) = raw(&app, "POST", HOOK, "application/json", body).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}: {res}");
        assert_eq!(res["code"], "invalid");
    }
    let (status, _) = raw(&app, "POST", HOOK, "text/plain", r#"{"event":"test"}"#).await;
    assert_eq!(status, StatusCode::UNSUPPORTED_MEDIA_TYPE);

    // Unknown or missing events do nothing, with 200.
    assert_eq!(
        post(&app, json!({ "event": "rename" })).await,
        counts(0, 0, 0)
    );
    assert_eq!(post(&app, json!({})).await, counts(0, 0, 0));
    assert_eq!(post(&app, fixture("test")).await, counts(0, 0, 0));
    let (_, status) = call(&app, "GET", HOOK, None).await;
    assert_eq!(
        status["last_result"],
        json!({ "event": "test", "applied": 0, "skipped": 0, "ignored": 0 })
    );
    assert_eq!(status["seen_users"], json!([]));
}

#[tokio::test]
async fn a_bad_item_is_skipped_and_the_rest_applied() {
    let app = bound_app().await;
    let mut no_date = m(5, 1, "2026-10-02T05:00:00.000Z", 80.0);
    no_date.as_object_mut().unwrap().remove("date");
    let res = post(
        &app,
        batch(&[
            m(4, 1, "2026-10-01T05:00:00.000Z", 80.0),
            no_date,
            m(6, 1, "yesterday", 80.0),
            m(7, 1, "2026-10-03T05:00:00.000Z", 0.0),
            m(8, 1, "2026-10-03T05:00:00.000Z", 900.0),
            json!(42),
        ]),
    )
    .await;
    // Counts only: nothing of the data comes back.
    assert_eq!(res, counts(1, 5, 0));
    assert_eq!(readings(&app).await.as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn a_full_sync_of_thousands_fits_and_an_oversize_body_doesnt() {
    let app = bound_app().await;
    let start = 1_559_966_400_000_i64; // 2019-06-08T04:00Z: a morning and an evening a day, ending before today
    let items: Vec<Value> = (0..5_000_i32)
        .map(|i| {
            let i64i = i64::from(i);
            m(
                i64i,
                1,
                &date(start + i64i * 43_200_000),
                80.0 + f64::from(i % 20) / 10.0,
            )
        })
        .collect();
    assert_eq!(post(&app, batch(&items)).await, counts(5_000, 0, 0));
    assert_eq!(readings(&app).await.as_array().unwrap().len(), 5_000);
    assert_eq!(
        weights(&app).await.as_array().unwrap().len(),
        2_500,
        "one a day"
    );

    let huge = format!(
        r#"{{"event":"test","pad":"{}"}}"#,
        "x".repeat(kaloriina::model::SCALE_BYTES_MAX)
    );
    let (status, res) = raw(&app, "POST", HOOK, "application/json", &huge).await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE, "{res}");
}

// ------------------------------------------------------ the bound user

#[tokio::test]
async fn unbound_readings_only_name_their_users() {
    let app = app_tz();
    assert_eq!(post(&app, fixture("batch")).await, counts(0, 0, 3));
    assert_eq!(readings(&app).await, json!([]));
    assert_eq!(weights(&app).await, json!([]));
    let (_, status) = call(&app, "GET", HOOK, None).await;
    assert_eq!(status["bound_user"], Value::Null);
    assert_eq!(
        status["seen_users"],
        json!([{ "id": 1, "username": "Alex", "ignored": 2 },
               { "id": 2, "username": "Anna", "ignored": 1 }])
    );
    assert!(status["last_seen"].as_i64().is_some());

    // Only a user seen here can be bound.
    let (s, err) = call(&app, "PUT", HOOK, Some(json!({ "user_id": 9 }))).await;
    assert_eq!(
        (s, &err["field"]),
        (StatusCode::BAD_REQUEST, &json!("user_id"))
    );
    let bound = bind(&app, 1).await;
    assert_eq!(bound["bound_user"], json!({ "id": 1, "username": "Alex" }));
}

#[tokio::test]
async fn a_two_user_batch_stores_only_the_bound_users_readings() {
    let app = app_tz();
    post(&app, fixture("batch")).await;
    bind(&app, 1).await;
    assert_eq!(post(&app, fixture("batch")).await, counts(2, 0, 1));
    let stored = readings(&app).await;
    assert_eq!(
        stored
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["weight"].as_f64().unwrap())
            .collect::<Vec<_>>(),
        [81.0, 82.0]
    );
    let (_, status) = call(&app, "GET", HOOK, None).await;
    assert_eq!(
        status["seen_users"][1],
        json!({ "id": 2, "username": "Anna", "ignored": 1 }),
        "the ignored user is named with their count"
    );
    assert_eq!(status["last_result"]["ignored"], 1);

    // A clear from another user touches nothing.
    assert_eq!(
        post(&app, json!({ "event": "clear", "userId": 2 })).await,
        counts(0, 0, 1)
    );
    assert_eq!(readings(&app).await.as_array().unwrap().len(), 2);
}

#[tokio::test]
async fn clear_from_an_unbound_user_touches_nothing() {
    let app = app_tz();
    post(&app, fixture("batch")).await;
    assert_eq!(post(&app, fixture("clear")).await, counts(0, 0, 1));
    assert_eq!(weights(&app).await, json!([]));
}

#[tokio::test]
async fn rebind_retags_instead_of_deleting() {
    let app = app_tz();
    post(&app, fixture("batch")).await;
    bind(&app, 1).await;
    post(&app, fixture("batch")).await;
    assert_eq!(
        weights(&app).await,
        json!([{ "day": "2026-10-01", "kg": 81.0 }])
    );

    let kept = readings(&app).await;
    // A reinstall: the same person is user 3 now, and the new install
    // can't re-send the history.
    post(&app, json!({ "event": "test" })).await;
    post(
        &app,
        event("insert", m(1, 3, "2026-10-02T05:00:00.000Z", 80.0)),
    )
    .await;
    let status = bind(&app, 3).await;
    assert_eq!(status["bound_user"]["id"], 3);
    assert_eq!(
        readings(&app).await,
        kept,
        "user 1's readings are user 3's now"
    );
    assert_eq!(
        weights(&app).await,
        json!([{ "day": "2026-10-01", "kg": 81.0 }]),
        "with the weights they set"
    );
    // Now user 3's: a clear from user 3 removes them.
    post(&app, json!({ "event": "clear", "userId": 3 })).await;
    assert_eq!(readings(&app).await, json!([]));

    post(
        &app,
        event("insert", m(1, 3, "2026-10-02T05:00:00.000Z", 80.0)),
    )
    .await;
    let (s, _) = call(&app, "DELETE", HOOK, None).await;
    assert_eq!(s, StatusCode::NO_CONTENT);
    let (_, status) = call(&app, "GET", HOOK, None).await;
    assert_eq!(
        (&status["bound_user"], &status["seen_users"]),
        (&Value::Null, &json!([]))
    );
    assert_eq!(
        readings(&app).await.as_array().unwrap().len(),
        1,
        "readings stay"
    );
}

#[tokio::test]
async fn fresh_reinstall_ids_keep_old_history() {
    let app = bound_app().await;
    // A year ago: ids 1 and 2.
    post(
        &app,
        batch(&[
            m(1, 1, "2025-09-01T05:00:00.000Z", 84.0),
            m(2, 1, "2025-09-02T05:00:00.000Z", 83.9),
        ]),
    )
    .await;
    // A fresh install numbers from 1 again, a different weigh-in.
    post(
        &app,
        event("insert", m(1, 1, "2026-09-01T05:00:00.000Z", 80.0)),
    )
    .await;
    // The same id, the same weight, but over a week apart: not a move.
    post(
        &app,
        event("insert", m(2, 1, "2025-09-12T05:00:00.000Z", 83.9)),
    )
    .await;
    let stored = readings(&app).await;
    assert_eq!(
        stored
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["day"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["2025-09-01", "2025-09-02", "2025-09-12", "2026-09-01"],
        "{stored}"
    );
}

// ----------------------------------------- events and reading identity

#[tokio::test]
async fn events_follow_webhook_sync() {
    let app = bound_app().await;
    let insert = fixture("insert");
    assert_eq!(post(&app, insert.clone()).await, counts(1, 0, 0));
    assert_eq!(post(&app, insert.clone()).await, counts(1, 0, 0));
    assert_eq!(
        readings(&app).await,
        json!([{ "source": "openscale", "taken_at": 1_791_412_200_000_i64, "day": "2026-10-08",
                 "weight": 80.5, "body_fat": 18.2, "water": 55.1, "muscle": 41.3,
                 "bone_kg": null, "lbm_kg": null, "bmr_kcal": null, "chosen": true }]),
        "one reading, in the local day (00:30 with no night known: it stands)"
    );

    let mut update = insert.clone();
    update["event"] = json!("update");
    update["weight"] = json!(80.1);
    post(&app, update).await;
    assert_eq!(readings(&app).await[0]["weight"], 80.1);

    // An update for an id never seen inserts.
    post(
        &app,
        event("update", m(99, 1, "2026-10-06T05:00:00.000Z", 79.0)),
    )
    .await;
    assert_eq!(readings(&app).await.as_array().unwrap().len(), 2);

    assert_eq!(post(&app, fixture("delete")).await, counts(1, 0, 0));
    assert_eq!(readings(&app).await.as_array().unwrap().len(), 1);
    assert_eq!(post(&app, fixture("clear")).await, counts(1, 0, 0));
    assert_eq!(readings(&app).await, json!([]));
    assert_eq!(weights(&app).await, json!([]));
}

#[tokio::test]
async fn a_moved_reading_is_stored_once() {
    let app = bound_app().await;
    let (t1, t2) = ("2026-10-01T05:00:00.000Z", "2026-10-02T06:00:00.000Z");
    post(&app, event("insert", m(5, 1, t1, 80.0))).await;
    // A move as openScale sync sends it: delete at the old time, insert.
    post(&app, json!({ "event": "delete", "userId": 1, "date": t1 })).await;
    post(&app, event("insert", m(5, 1, t2, 80.0))).await;
    assert_eq!(readings(&app).await.as_array().unwrap().len(), 1);
    // A lost delete: only the insert at the new time arrives.
    post(&app, event("update", m(5, 1, t1, 80.0))).await;
    let stored = readings(&app).await;
    assert_eq!(stored.as_array().unwrap().len(), 1, "{stored}");
    assert_eq!(stored[0]["day"], "2026-10-01");
    assert_eq!(
        weights(&app).await,
        json!([{ "day": "2026-10-01", "kg": 80.0 }])
    );
}

#[tokio::test]
async fn ids_reused_after_a_reinstall_keep_both_readings() {
    let app = bound_app().await;
    let (t1, t2) = ("2026-09-01T05:00:00.000Z", "2026-09-02T05:00:00.000Z");
    post(&app, batch(&[m(1, 1, t1, 80.0), m(2, 1, t2, 81.0)])).await;
    // The new installation numbers the same history the other way round.
    post(&app, batch(&[m(1, 1, t2, 81.0), m(2, 1, t1, 80.0)])).await;
    let stored = readings(&app).await;
    assert_eq!(
        stored
            .as_array()
            .unwrap()
            .iter()
            .map(|r| (r["day"].as_str().unwrap(), r["weight"].as_f64().unwrap()))
            .collect::<Vec<_>>(),
        [("2026-09-01", 80.0), ("2026-09-02", 81.0)]
    );
}

#[tokio::test]
async fn zero_percentages_are_none_and_future_readings_skipped() {
    let app = bound_app().await;
    post(
        &app,
        event("insert", m(1, 1, "2026-10-01T05:00:00.000Z", 80.0)),
    )
    .await;
    let r = &readings(&app).await[0];
    assert_eq!(
        (&r["body_fat"], &r["water"], &r["muscle"]),
        (&Value::Null, &Value::Null, &Value::Null)
    );
    assert_eq!(day(&app, "2026-10-01").await["composition"], Value::Null);

    let ahead = Timestamp::now().as_millisecond() + 3 * 86_400_000;
    assert_eq!(
        post(&app, event("insert", m(2, 1, &date(ahead), 80.0))).await,
        counts(0, 1, 0)
    );
}

// ---------------------------------------------------- the day's weight

#[tokio::test]
async fn the_earliest_reading_is_the_days_weight() {
    let app = bound_app().await;
    let before = rev(&app).await;
    // Evening first, then the morning one: the morning wins.
    post(
        &app,
        event("insert", m(2, 1, "2026-10-01T17:45:00.000Z", 82.0)),
    )
    .await;
    post(
        &app,
        event("insert", m(1, 1, "2026-10-01T05:10:00.000Z", 81.0)),
    )
    .await;
    let d = day(&app, "2026-10-01").await;
    assert_eq!(
        (&d["weight"], &d["weight_source"]),
        (&json!(81.0), &json!("openscale"))
    );
    assert_eq!(
        rev(&app).await,
        before,
        "a weigh-in leaves the profile alone"
    );
}

#[tokio::test]
async fn helsinki_midnight_is_the_next_day() {
    let app = bound_app().await;
    post(&app, fixture("insert")).await;
    assert_eq!(readings(&app).await[0]["day"], "2026-10-08");
    // 00:30 with no night known: nothing says it was before sleep, so it
    // stands for the day.
    assert_eq!(
        weights(&app).await,
        json!([{ "day": "2026-10-08", "kg": 80.5 }])
    );
}

#[tokio::test]
async fn a_replay_or_late_reading_keeps_a_manual_weight() {
    let app = bound_app().await;
    let at = "2026-10-01T05:00:00.000Z";
    post(&app, event("insert", m(1, 1, at, 81.0))).await;
    let (s, _) = call(
        &app,
        "PUT",
        "/api/profiles/1/weights/2026-10-01",
        Some(json!({ "kg": 79.0 })),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    // The same reading again (a full sync) is older than the typed weight.
    post(&app, batch(&[m(1, 1, at, 81.0)])).await;
    let d = day(&app, "2026-10-01").await;
    assert_eq!(
        (&d["weight"], &d["weight_source"]),
        (&json!(79.0), &json!("hand"))
    );

    // A reading taken an hour ago arriving now: typed after it, still manual.
    let app = bound_app().await;
    let earlier = Timestamp::now().as_millisecond() - 3_600_000;
    let d = local_day(earlier);
    call(
        &app,
        "PUT",
        &format!("/api/profiles/1/weights/{d}"),
        Some(json!({ "kg": 79.0 })),
    )
    .await;
    post(&app, event("insert", m(1, 1, &date(earlier), 81.0))).await;
    assert_eq!(day(&app, &d).await["weight"], 79.0);
}

#[tokio::test]
async fn a_later_weigh_in_takes_a_manual_day_over() {
    let app = bound_app().await;
    let soon = Timestamp::now().as_millisecond() + 60_000;
    // From that day's 04:00: one before is the night before's.
    let dawn = Timestamp::from_millisecond(soon)
        .unwrap()
        .to_zoned(helsinki())
        .date()
        .at(4, 1, 0, 0)
        .to_zoned(helsinki())
        .unwrap()
        .timestamp()
        .as_millisecond();
    let later = soon.max(dawn);
    let d = local_day(later);
    call(
        &app,
        "PUT",
        &format!("/api/profiles/1/weights/{d}"),
        Some(json!({ "kg": 79.0 })),
    )
    .await;
    post(&app, event("insert", m(1, 1, &date(later), 81.0))).await;
    let v = day(&app, &d).await;
    assert_eq!(
        (&v["weight"], &v["weight_source"]),
        (&json!(81.0), &json!("openscale"))
    );
}

#[tokio::test]
async fn deleting_readings_and_weights() {
    let app = bound_app().await;
    let at = "2026-10-01T05:00:00.000Z";
    post(&app, event("insert", m(1, 1, at, 81.0))).await;

    // A scale weight goes only with its reading.
    let (s, err) = call(&app, "DELETE", "/api/profiles/1/weights/2026-10-01", None).await;
    assert_eq!(s, StatusCode::CONFLICT);
    assert_eq!(err["code"], "scale_weight");
    assert_eq!(
        err["error"],
        "This weight is from the scale: delete the reading in openScale"
    );
    post(&app, json!({ "event": "delete", "userId": 1, "date": at })).await;
    assert_eq!(weights(&app).await, json!([]));

    // A manual weight survives its readings going.
    post(&app, event("insert", m(1, 1, at, 81.0))).await;
    call(
        &app,
        "PUT",
        "/api/profiles/1/weights/2026-10-01",
        Some(json!({ "kg": 79.0 })),
    )
    .await;
    post(&app, fixture("clear")).await;
    assert_eq!(
        weights(&app).await,
        json!([{ "day": "2026-10-01", "kg": 79.0 }])
    );

    // Deleting a manual weight lets the day's reading show.
    post(&app, event("insert", m(1, 1, at, 81.0))).await;
    let (s, _) = call(&app, "DELETE", "/api/profiles/1/weights/2026-10-01", None).await;
    assert_eq!(s, StatusCode::NO_CONTENT);
    let d = day(&app, "2026-10-01").await;
    assert_eq!(
        (&d["weight"], &d["weight_source"]),
        (&json!(81.0), &json!("openscale"))
    );
}

// ----------------------------------- the day's composition and replays

#[tokio::test]
async fn the_day_shows_the_chosen_readings_composition() {
    let app = bound_app().await;
    post(&app, fixture("batch")).await;
    let d = day(&app, "2026-10-01").await;
    assert_eq!(
        d["composition"],
        json!({ "body_fat": 18.5, "water": 55.0, "muscle": 41.0 }),
        "the morning reading's"
    );
    let (s, list) = call(
        &app,
        "GET",
        "/api/profiles/1/scale?from=2026-10-01&to=2026-10-01",
        None,
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(list.as_array().unwrap().len(), 2);
    let (s, _) = call(
        &app,
        "GET",
        "/api/profiles/1/scale?from=2026-10-02&to=2026-10-01",
        None,
    )
    .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    let (s, err) = call(&app, "GET", "/api/profiles/9/sync/openscale", None).await;
    assert_eq!(
        (s, &err["resource"]),
        (StatusCode::NOT_FOUND, &json!("profile"))
    );
}

// ----------------------------------------------------- replayed writes

#[tokio::test]
async fn a_replayed_typed_weight_loses_to_a_later_reading() {
    // The reviewer's steps: a weigh-in an hour ago, then a weight typed two
    // hours ago arriving late (an outbox replay), then openScale re-sends.
    // Yesterday at 11:00 in Helsinki stands in for "now": a weigh-in at
    // 10:00 is a morning one at any hour the test runs (one before 04:00
    // would be the night before's).
    let app = bound_app().await;
    let now = Timestamp::now()
        .to_zoned(helsinki())
        .date()
        .yesterday()
        .unwrap()
        .at(11, 0, 0, 0)
        .to_zoned(helsinki())
        .unwrap()
        .timestamp()
        .as_millisecond();
    let reading = m(1, 1, &date(now - 3_600_000), 80.0);
    let today = local_day(now - 3_600_000);
    post(&app, event("insert", reading.clone())).await;
    let (status, res) = call(
        &app,
        "PUT",
        &format!("/api/profiles/1/weights/{today}"),
        Some(json!({ "kg": 82.0, "set_at": now - 7_200_000 })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{res}");
    post(&app, event("update", reading)).await;
    let d = day(&app, &today).await;
    assert_eq!(d["weight"], 80.0, "the reading came after the typing: {d}");
    assert_eq!(d["weight_source"], "openscale");
}

// ------------------------------------------------------ webhook limits

#[tokio::test]
async fn webhook_over_16_mib_is_413() {
    let app = bound_app().await;
    let max = kaloriina::model::SCALE_BYTES_MAX;
    let body = |size: usize| {
        let head = r#"{"event":"test","pad":""#;
        format!("{head}{}\"}}", "x".repeat(size - head.len() - 2))
    };
    let (status, res) = raw(&app, "POST", HOOK, "application/json", &body(max)).await;
    assert_eq!(status, StatusCode::OK, "{res}");
    let (status, res) = raw(&app, "POST", HOOK, "application/json", &body(max + 1)).await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE, "{res}");
    assert_eq!(res["code"], "too_large");
    let (status, res) = raw(&app, "POST", HOOK, "text/plain", "{}").await;
    assert_eq!(status, StatusCode::UNSUPPORTED_MEDIA_TYPE, "{res}");
}

#[tokio::test]
async fn a_bad_item_in_a_big_batch_is_still_skipped() {
    // A full batch read item by item: the bad one is counted, the rest
    // applied (here: ignored, nobody is bound).
    let app = app_tz();
    let start = 1_559_966_400_000_i64;
    let mut items: Vec<Value> = (0..kaloriina::model::SCALE_BATCH_MAX - 1)
        .map(|i| {
            let i = i64::try_from(i).unwrap();
            m(i, 2, &date(start + i * 60_000), 80.0)
        })
        .collect();
    items.insert(
        500,
        json!({ "userId": 2, "date": "not a date", "weight": 80.0 }),
    );
    let body = batch(&items).to_string();
    assert!(
        body.len() <= kaloriina::model::SCALE_BYTES_MAX,
        "{}",
        body.len()
    );
    let (status, res) = raw(&app, "POST", HOOK, "application/json", &body).await;
    assert_eq!(status, StatusCode::OK, "{res}");
    let n = u64::try_from(kaloriina::model::SCALE_BATCH_MAX).unwrap();
    assert_eq!(res, counts(0, 1, n - 1));
}

#[tokio::test]
async fn seen_users_are_capped() {
    let app = bound_app().await;
    let cap = kaloriina::model::SCALE_USERS_MAX;
    // One past the cap, the bound user (1) last among them.
    let items: Vec<Value> = (0..=cap)
        .map(|i| {
            let user = i64::try_from(cap + 1 - i).unwrap() + 1;
            let user = if i == cap { 1 } else { user };
            m(
                i64::try_from(i).unwrap(),
                user,
                "2026-01-01T06:00:00.000Z",
                80.0,
            )
        })
        .collect();
    let res = post(&app, batch(&items)).await;
    assert_eq!(res["applied"], 1, "{res}");
    let status = call(&app, "GET", HOOK, None).await.1;
    let seen = status["seen_users"].as_array().unwrap();
    assert_eq!(seen.len(), cap, "{status}");
    assert!(seen.iter().any(|u| u["id"] == 1), "the bound user stays");
    assert_eq!(status["bound_user"]["id"], 1);
}

// --------------------------------------- everything the scale measured

#[tokio::test]
async fn bone_and_lean_mass_are_kept() {
    let app = bound_app().await;
    let mut item = fixture("insert");
    let values = item["values"].as_array_mut().unwrap();
    for (key, value) in [
        ("bone", 3.1),
        ("lbm", 62.4),
        ("visceral_fat", 7.0),
        ("bmr", 1785.0),
    ] {
        values.push(
            json!({ "key": key, "name": key, "unit": "", "isDerived": false,
                            "value": value }),
        );
    }
    assert_eq!(post(&app, item).await, counts(1, 0, 0));
    let r = &readings(&app).await[0];
    assert_eq!(
        (&r["bone_kg"], &r["lbm_kg"], &r["bmr_kcal"]),
        (&json!(3.1), &json!(62.4), &json!(1785.0)),
        "{r}"
    );
    // Visceral fat is never shown: the raw record keeps it, the reading not.
    assert_eq!(r.get("visceral_fat"), None, "{r}");
    // Without them (and 0 for none, as openScale writes): null.
    post(
        &app,
        event("insert", m(13, 1, "2026-10-09T05:00:00.000Z", 80.0)),
    )
    .await;
    let r = &readings(&app).await[1];
    assert_eq!(
        (&r["bone_kg"], &r["lbm_kg"], &r["bmr_kcal"]),
        (&Value::Null, &Value::Null, &Value::Null),
        "{r}"
    );
}

/// A Health Connect sync of 2026-10-01..07 carrying `body` readings.
async fn sync_body(app: &Router, body: &[Value]) -> Value {
    let (status, res) = call(
        app,
        "POST",
        "/api/profiles/1/sync/health",
        Some(
            json!({ "from": "2026-10-01", "to": "2026-10-07", "device": "Pixel 9",
                     "days": [], "sessions": [], "body": body }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{res}");
    res
}

fn hc_weight(key: &str, at: &str, kg: f64, origin: &str) -> Value {
    json!({ "key": key, "day": &at[..10], "at": at, "kg": kg, "body_fat": 21.0,
            "lbm_kg": 60.0, "bone_kg": 3.0, "bmr_kcal": 1700, "origin": origin })
}

/// The phone re-sends a week on every sync; a reading of another
/// app's, taken after a weight was typed, never takes the typed one's day
/// (openScale's would: it is your scale).
#[tokio::test]
async fn hc_reading_after_typing_never_takes_the_day() {
    let app = app_tz();
    let today = Timestamp::now().to_zoned(helsinki()).date();
    let (s, res) = call(
        &app,
        "PUT",
        &format!("/api/profiles/1/weights/{today}"),
        Some(json!({ "kg": 79.0 })),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{res}");
    let after = Timestamp::now() + jiff::SignedDuration::from_secs(1);
    let reading = json!({ "key": "w-late", "day": today.to_string(), "at": after.to_string(),
                          "kg": 80.2, "origin": "com.withings.wiscale2" });
    let body = json!({ "from": today.saturating_sub(jiff::ToSpan::days(6)).to_string(),
                       "to": today.to_string(), "device": "Pixel 9",
                       "days": [], "sessions": [], "body": [reading] });
    // Twice: the second is the next sync's replay.
    for _ in 0..2 {
        let (s, res) = call(
            &app,
            "POST",
            "/api/profiles/1/sync/health",
            Some(body.clone()),
        )
        .await;
        assert_eq!(s, StatusCode::OK, "{res}");
    }
    let d = day(&app, &today.to_string()).await;
    assert_eq!(
        (&d["weight"], &d["weight_source"]),
        (&json!(79.0), &json!("hand"))
    );
}

#[tokio::test]
async fn health_connect_weights_fill_in_below_the_scale() {
    let app = bound_app().await;
    // openScale's own reading of 2026-10-01 05:10 (81.0 kg).
    post(&app, fixture("batch")).await;
    let res = sync_body(
        &app,
        &[
            // openScale wrote it to Health Connect too: by origin.
            hc_weight(
                "w-1",
                "2026-10-01T05:10:00Z",
                81.0,
                "com.health.openscale.sync",
            ),
            // Another app's copy of the same weigh-in, a minute off.
            hc_weight(
                "w-2",
                "2026-10-01T05:11:30Z",
                81.04,
                "com.withings.wiscale2",
            ),
            // A day the scale never saw.
            hc_weight("w-3", "2026-10-03T06:00:00Z", 80.2, "com.withings.wiscale2"),
        ],
    )
    .await;
    assert_eq!(res["skipped"], 0, "{res}");
    let list = readings(&app).await;
    let got: Vec<(&Value, &Value, &Value)> = list
        .as_array()
        .unwrap()
        .iter()
        .map(|r| (&r["day"], &r["source"], &r["weight"]))
        .collect();
    assert_eq!(
        got,
        [
            (&json!("2026-10-01"), &json!("openscale"), &json!(81.0)),
            (&json!("2026-10-01"), &json!("openscale"), &json!(82.0)),
            (&json!("2026-10-03"), &json!("health_connect"), &json!(80.2)),
        ]
    );
    assert_eq!(list[2]["bone_kg"], 3.0);
    let d = day(&app, "2026-10-03").await;
    assert_eq!(
        (&d["weight"], &d["weight_source"]),
        (&json!(80.2), &json!("health_connect"))
    );
    // openScale's wins over Health Connect's.
    post(
        &app,
        event("insert", m(30, 1, "2026-10-03T07:00:00.000Z", 79.9)),
    )
    .await;
    let d = day(&app, "2026-10-03").await;
    assert_eq!(
        (&d["weight"], &d["weight_source"]),
        (&json!(79.9), &json!("openscale"))
    );
    // Replaced per window: gone from Health Connect, gone here.
    sync_body(&app, &[]).await;
    let sources: Vec<Value> = readings(&app)
        .await
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["source"].clone())
        .collect();
    assert!(!sources.contains(&json!("health_connect")), "{sources:?}");
    // Its weight a typed one can't delete: it's Health Connect's.
    sync_body(
        &app,
        &[hc_weight(
            "w-4",
            "2026-10-05T06:00:00Z",
            80.0,
            "com.withings.wiscale2",
        )],
    )
    .await;
    let (status, err) = call(&app, "DELETE", "/api/profiles/1/weights/2026-10-05", None).await;
    assert_eq!(
        (status, &err["code"]),
        (StatusCode::CONFLICT, &json!("scale_weight")),
        "{err}"
    );
    sync_body(&app, &[]).await;
    assert_eq!(day(&app, "2026-10-05").await["weight"], Value::Null);
}
