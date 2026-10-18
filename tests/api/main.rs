//! The API tests, one crate: a module per area, sharing the helpers below.

#[path = "../common/mod.rs"]
mod common;

mod activities;
mod backups;
mod check_ins;
mod contract;
mod cronometer;
mod daily;
mod device;
mod entries;
mod feedback;
mod google_health;
mod habits;
mod hooks;
mod labels;
mod library;
mod openscale;
mod photos;
mod plans;
mod reports;
mod security;
mod stats;
mod targets;
mod transfer;
mod water;

use std::path::Path as FsPath;

use axum::Router;
use axum::http::StatusCode;
use common::{app_from, call};
use kaloriina::open;
use serde_json::{Value, json};

const DAY: &str = "2026-10-06";

fn app_with_off(off_url: &str) -> Router {
    app_from(open(FsPath::new(":memory:")).unwrap(), off_url)
}

/// Nothing listens on port 9, so Open Food Facts lookups fail fast.
const NO_OFF: &str = "http://127.0.0.1:9";

fn app() -> Router {
    app_with_off(NO_OFF)
}

/// An app whose Open Food Facts calls go to `stub`.
async fn app_with_stub(stub: Router) -> Router {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, stub).await.unwrap() });
    app_with_off(&format!("http://{addr}"))
}

/// Health Connect's raw sleep session `id` from `start` to `end` (UTC), with
/// `stages` (start, end, Health Connect's type), as the phone keeps it raw:
/// what the server makes nights and naps of.
fn hc_sleep(id: &str, start: &str, end: &str, stages: &[(&str, &str, i64)]) -> Value {
    let stages: Vec<Value> = stages
        .iter()
        .map(|(a, b, t)| json!({ "start_time": a, "end_time": b, "type": t }))
        .collect();
    json!({ "kind": "SleepSession", "id": id, "start": start, "end": end,
            "data": { "start_time": start, "start_zone_offset": "Z", "end_time": end,
                      "end_zone_offset": "Z", "stages": stages } })
}

/// Post `records` to profile `pid` as the phone's records page.
async fn hc_records(app: &Router, pid: i64, records: Value) -> Value {
    let (status, res) = common::call(
        app,
        "POST",
        &format!("/api/profiles/{pid}/sync/health/records"),
        Some(json!({ "device": "Pixel 9", "records": records })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{res}");
    res
}

/// Log `grams` of `food_id` today and return the created entry.
async fn log_entry(app: &Router, group: &str, food_id: i64, grams: f64) -> Value {
    log_entry_on(app, DAY, group, food_id, grams).await
}

/// Log `grams` of a food for profile 1 on `day`; the new entry.
async fn log_entry_on(app: &Router, day: &str, group: &str, food_id: i64, grams: f64) -> Value {
    let (status, res) = call(
        app,
        "POST",
        "/api/profiles/1/entries",
        Some(json!({ "day": day, "group": group, "food_id": food_id, "grams": grams })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{res}");
    res["entries"][0].clone()
}

async fn create_food(app: &Router, name: &str, per100: Value) -> i64 {
    let (status, food) = call(
        app,
        "POST",
        "/api/foods",
        Some(json!({ "name": name, "per100": per100 })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{food}");
    food["id"].as_i64().unwrap()
}

/// Search profile 1's foods with `query` (`q=milk&sort=name`).
async fn search(app: &Router, query: &str) -> (StatusCode, Value) {
    call(app, "GET", &format!("/api/profiles/1/foods?{query}"), None).await
}

/// The foods a fresh instance has: the plain Water migration 25 seeds
/// (there is no Fineli water to default to) and 36's Creatine monohydrate.
async fn assert_only_seeded_foods(app: &Router) {
    let (_, foods) = search(app, "").await;
    let names: Vec<&str> = foods
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["Creatine monohydrate", "Water"], "{foods}");
}

/// What `uri` reads now. A habit has no GET of its own: the list's.
async fn read_one(app: &Router, uri: &str) -> Value {
    let (status, one) = call(app, "GET", uri, None).await;
    if status == StatusCode::OK {
        return one;
    }
    let (list, id) = uri.rsplit_once('/').unwrap();
    let id: i64 = id.parse().unwrap();
    let (_, all) = call(app, "GET", list, None).await;
    all.as_array()
        .unwrap()
        .iter()
        .find(|x| x["id"] == id)
        .unwrap()
        .clone()
}

/// PUT `body`'s fields over what `uri` reads now, at its `rev`: the
/// whole entity with edits on top, as a client saving what it just loaded
/// does (a PUT replaces).
async fn put_with_rev(app: &Router, uri: &str, body: Value) -> (StatusCode, Value) {
    let mut current = read_one(app, uri).await;
    let rev = current["rev"].clone();
    current
        .as_object_mut()
        .unwrap()
        .extend(body.as_object().unwrap().clone());
    current["rev"] = rev;
    call(app, "PUT", uri, Some(current)).await
}

/// Replace profile `pid`'s targets (`[{metric, value}]`) at its current rev.
async fn put_targets(app: &Router, pid: i64, targets: Value) -> (StatusCode, Value) {
    let (_, profile) = call(app, "GET", &format!("/api/profiles/{pid}"), None).await;
    let body = json!({ "rev": profile["rev"], "targets": targets });
    call(
        app,
        "PUT",
        &format!("/api/profiles/{pid}/targets"),
        Some(body),
    )
    .await
}

/// A "Porridge" recipe (60 g of new "Oats") with `notes`: the answer.
async fn porridge(app: &Router, notes: Value) -> (StatusCode, Value) {
    let oats = create_food(app, "Oats", json!({ "energy": 380.0 })).await;
    call(
        app,
        "POST",
        "/api/recipes",
        Some(
            json!({ "name": "Porridge", "cooked_g": null, "notes": notes,
                     "items": [{ "food_id": oats, "grams": 60.0 }] }),
        ),
    )
    .await
}

/// Profile `pid`'s goal weight target, if set.
async fn goal_weight(app: &Router, pid: &Value) -> Value {
    let (_, list) = call(app, "GET", &format!("/api/profiles/{pid}/targets"), None).await;
    list.as_array()
        .unwrap()
        .iter()
        .find(|t| t["metric"] == "goal_weight")
        .map_or(Value::Null, |t| t["value"].clone())
}

fn group<'a>(day: &'a Value, name: &str) -> &'a Value {
    day["groups"]
        .as_array()
        .unwrap()
        .iter()
        .find(|g| g["name"] == name)
        .unwrap()
}
