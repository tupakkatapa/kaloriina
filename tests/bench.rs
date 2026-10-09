//! Performance budgets at a realistic volume.
//! Seeds five years of one person's diary through the API (a year of it
//! imported history, a nested recipe planned each day, an energy target,
//! habit trackers counted every day, a check-in every day),
//! then times the hot reads in process. Not part of the normal run:
//! `cargo test --release --test bench -- --ignored --nocapture`.

use std::fmt::Write;
use std::time::{Duration, Instant};

use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use http_body_util::BodyExt;
use kaloriina::{AppState, router};
use serde_json::{Value, json};
use tower::ServiceExt;

const FOODS: usize = 5_000;
const DAYS: usize = 5 * 365;
const ENTRIES_PER_DAY: usize = 10;
const SESSIONS: usize = 1_000;
/// Nested recipes, one of them planned each day.
const RECIPES: usize = 30;
/// Habit trackers, each counted every day.
const HABITS: usize = 5;
const RUNS: usize = 200;

/// Send JSON (or nothing) and parse the JSON reply. (Not tests/common: a
/// bench needs only this, and the rest would sit unused here.)
async fn call(app: &Router, method: &str, uri: &str, body: Option<Value>) -> (StatusCode, Value) {
    let req = Request::builder()
        .method(method)
        .uri(uri)
        .header(header::CONTENT_TYPE, "application/json")
        .body(body.map_or_else(Body::empty, |b| Body::from(b.to_string())))
        .unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    let status = res.status();
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

/// Every nutrient the registry knows (`/api/meta`): a Fineli food carries
/// about 55, and with a label's 8 Summary reads ~5× faster than it is.
async fn nutrient_keys(app: &Router) -> Vec<String> {
    let (_, meta) = call(app, "GET", "/api/meta", None).await;
    meta["nutrients"]
        .as_array()
        .unwrap_or_else(|| panic!("{meta}"))
        .iter()
        .map(|n| n["key"].as_str().unwrap().to_owned())
        .collect()
}

/// A food's values per 100 g, one for every key: under 50 each, so total
/// carbohydrate (net + fibre) stays within the per-100 caps.
fn per100(i: usize, keys: &[String]) -> Value {
    keys.iter()
        .enumerate()
        .map(|(k, key)| (key.clone(), json!(1 + (i + k) % 45)))
        .collect::<serde_json::Map<_, _>>()
        .into()
}

/// Day `i` from 2020-01-01 on a calendar of 12 × 28-day months: enough
/// distinct, valid dates for a bench.
fn day(i: usize) -> String {
    format!(
        "{:04}-{:02}-{:02}",
        2020 + i / 336,
        1 + (i % 336) / 28,
        1 + i % 28
    )
}

/// The first year as imported history: one Consumed total a day, as
/// `kaloriina import --summary` stores it (64 columns: date, group, 61
/// nutrients, completed).
fn import_history(conn: &mut kaloriina::Connection) {
    let header = include_str!("fixtures/dailysummary.csv")
        .lines()
        .next()
        .unwrap();
    let mut csv = format!("{header}\n");
    for d in 0..365 {
        writeln!(csv, "{},Consumed,1800{}true", day(d), ",".repeat(61)).unwrap();
    }
    kaloriina::import::import(
        conn,
        kaloriina::ProfileId(1),
        None::<&[u8]>,
        Some(csv.as_bytes()),
    )
    .unwrap();
}

/// Recipes nested 2 and 3 deep (each level holds the one below plus a
/// food), one of them planned every day, and an energy target.
async fn plan_and_target(app: &Router, foods: &[i64]) {
    let mut recipes = Vec::new();
    for r in 0..RECIPES {
        let mut inner = foods[r];
        for depth in 1..=(2 + r % 2) {
            let (_, recipe) = call(
                app,
                "POST",
                "/api/recipes",
                Some(json!({
                    "name": format!("Recipe {r}.{depth}"),
                    "items": [{ "food_id": inner, "grams": 200 },
                              { "food_id": foods[r * 3 + depth], "grams": 50 }],
                })),
            )
            .await;
            inner = recipe["id"].as_i64().unwrap_or_else(|| panic!("{recipe}"));
        }
        recipes.push(inner);
    }
    for d in 0..DAYS {
        let (status, planned) = call(
            app,
            "POST",
            "/api/profiles/1/entries",
            Some(json!({ "day": day(d), "group": "Planned",
                         "food_id": recipes[d % RECIPES], "grams": 300 })),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "{planned}");
    }
    let (_, me) = call(app, "GET", "/api/profiles/1", None).await;
    let (status, targets) = call(
        app,
        "PUT",
        "/api/profiles/1/targets",
        Some(json!({ "rev": me["rev"], "targets": [{ "metric": "energy", "value": 2200 }] })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{targets}");
}

/// [`HABITS`] trackers, each counted every day.
async fn habits(app: &Router) {
    for h in 0..HABITS {
        let (status, habit) = call(
            app,
            "POST",
            "/api/profiles/1/habits",
            Some(json!({ "name": format!("Habit {h}"), "unit": "pcs" })),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "{habit}");
        for d in 0..DAYS {
            let uri = format!("/api/profiles/1/habits/{}/days/{}", habit["id"], day(d));
            let (status, res) = call(app, "PUT", &uri, Some(json!({ "amount": 1 + d % 9 }))).await;
            assert_eq!(status, StatusCode::OK, "{res}");
        }
    }
}

/// A check-in every day: three scales and two tags.
async fn check_ins(app: &Router) {
    for d in 0..DAYS {
        let uri = format!("/api/profiles/1/check-ins/{}", day(d));
        let body = json!({ "mood": 1 + d % 5, "energy": 1 + d % 3, "stress": 1 + d % 4,
                           "tags": ["travel", format!("tag {}", d % 20)] });
        let (status, res) = call(app, "PUT", &uri, Some(body)).await;
        assert_eq!(status, StatusCode::OK, "{res}");
    }
}

/// openScale readings, a weigh-in each morning and evening from 2012-04-01
/// on, as one sync batch (`WebhookSync.postBatch`).
const READINGS: i64 = 10_000;

fn scale_batch() -> String {
    let start = 1_333_256_400_000_i64; // 2012-04-01T05:00:00Z
    let items: Vec<Value> = (0..READINGS)
        .map(|i| {
            let at = jiff::Timestamp::from_millisecond(start + i * 43_200_000).unwrap();
            json!({ "id": i, "userId": 1, "username": "Bench",
                    "date": at.strftime("%Y-%m-%dT%H:%M:%S%.3fZ").to_string(),
                    "weight": 80.0 + f64::from(i32::try_from(i % 30).unwrap()) / 10.0, "body_fat": 20.0,
                    "water": 55.0, "muscle": 40.0 })
        })
        .collect();
    json!({ "event": "insert", "measurements": items }).to_string()
}

/// POST `body` (already JSON) to `uri`.
async fn post_raw(app: &Router, uri: &str, body: &str) -> StatusCode {
    let req = Request::builder()
        .method("POST")
        .uri(uri)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body.to_owned()))
        .unwrap();
    app.clone().oneshot(req).await.unwrap().status()
}

const HOOK: &str = "/api/profiles/1/sync/openscale";

/// Bind openScale user 1 and sync [`READINGS`]; the batch, for replays.
async fn scale(app: &Router) -> String {
    call(
        app,
        "POST",
        HOOK,
        Some(json!({ "event": "clear", "userId": 1 })),
    )
    .await;
    call(app, "PUT", HOOK, Some(json!({ "user_id": 1 }))).await;
    let readings = scale_batch();
    assert_eq!(post_raw(app, HOOK, &readings).await, StatusCode::OK);
    readings
}

/// A full sync replaying 10,000 readings: one transaction, each day
/// derived once. Budget 2 s (release), far inside openScale's 30 s read
/// timeout. `ponytail:` one write lock for the whole batch; chunk it if
/// other requests visibly stall during a full sync.
async fn full_sync_within_budget(app: &Router, readings: &str) -> bool {
    let budget = Duration::from_secs(2);
    let (p50, p99) = time(20, |_| {
        let (app, readings) = (app.clone(), readings.to_owned());
        async move {
            assert_eq!(post_raw(&app, HOOK, &readings).await, StatusCode::OK);
        }
    })
    .await;
    let name = "scale batch (10k)";
    println!("{name:>17}: p50 {p50:>9.2?}  p99 {p99:>9.2?}  (budget p99 {budget:?})");
    p99 <= budget
}

/// A batch naming 100,000 openScale users (none bound): folding the users
/// seen stays linear and their list capped. Budget 2 s.
async fn many_users_within_budget(app: &Router) -> bool {
    let items: Vec<Value> = (0..100_000_i64)
        .map(|i| {
            json!({ "id": i, "userId": i + 2, "date": "2020-01-01T06:00:00.000Z",
                    "weight": 80.0 })
        })
        .collect();
    let body = json!({ "event": "insert", "measurements": items }).to_string();
    let budget = Duration::from_secs(2);
    let (p50, p99) = time(5, |_| {
        let (app, body) = (app.clone(), body.clone());
        async move {
            assert_eq!(post_raw(&app, HOOK, &body).await, StatusCode::OK);
        }
    })
    .await;
    let name = "scale users (100k)";
    println!("{name:>17}: p50 {p50:>9.2?}  p99 {p99:>9.2?}  (budget p99 {budget:?})");
    p99 <= budget
}

/// Health Connect activity for 2019–2023: each day's totals, its night and
/// heart, and a watch run (promoted into a session), synced as the phone's
/// 90-day resync does, 92 days at a time.
async fn activity(app: &Router) {
    use jiff::ToSpan;
    let mut from = jiff::civil::date(2019, 1, 1);
    while from.year() < 2024 {
        let to = from.saturating_add(91.days());
        let span = || from.series(1.day()).take_while(|d| *d <= to);
        let days: Vec<Value> = span()
            .map(|d| {
                json!({ "day": d.to_string(), "active_kcal": 400, "steps": 8000,
                    "resting_hr": 54, "hrv_ms": 48, "asleep_min": 440, "in_bed_min": 475,
                    "bedtime": "23:10", "wake_time": "07:05", "deep_min": 70, "rem_min": 90,
                    "light_min": 200 })
            })
            .collect();
        let sessions: Vec<Value> = span()
            .map(|d| {
                json!({ "key": format!("hc-{d}"), "day": d.to_string(),
                "start_at": format!("{d}T15:00:00Z"), "end_at": format!("{d}T15:45:00Z"),
                "type": 33, "name": "Running", "kcal": 410, "distance_m": 8200 })
            })
            .collect();
        let body = json!({ "from": from.to_string(), "to": to.to_string(), "device": "Bench",
            "days": days, "sessions": sessions });
        let (status, res) = call(app, "POST", "/api/profiles/1/sync/health", Some(body)).await;
        assert_eq!(status, StatusCode::OK, "{res}");
        from = to.saturating_add(1.day());
    }
}

/// A 90-day resync with two watch workouts a day into a profile that hand
/// logged one of them each day (claimed) and never saw the other
/// (promoted): one transaction. Each run gets a fresh profile. Budget
/// 300 ms (release).
async fn health_sync_within_budget(app: &Router) -> bool {
    use jiff::ToSpan;
    const RUNS: usize = 20;
    let from = jiff::civil::date(2024, 1, 1);
    let span = || from.series(1.day()).take(90);
    let mut profiles = Vec::with_capacity(RUNS);
    for i in 0..RUNS {
        let (_, p) = call(
            app,
            "POST",
            "/api/profiles",
            Some(json!({ "name": format!("Sync {i}"), "sex": "female",
                "birth_date": "1990-01-01", "height_cm": 165,
                "activity": 1.6, "goal_kg_per_week": 0 })),
        )
        .await;
        let pid = p["id"].as_i64().unwrap_or_else(|| panic!("{p}"));
        for d in span() {
            call(
                app,
                "POST",
                &format!("/api/profiles/{pid}/sessions"),
                Some(
                    json!({ "day": d.to_string(), "name": "Morning run", "minutes": 40,
                    "start_at": format!("{d}T06:00:00Z") }),
                ),
            )
            .await;
        }
        profiles.push(pid);
    }
    let sessions: Vec<Value> = span()
        .flat_map(|d| {
            [("am", "06:02", "06:44", 33), ("pm", "17:00", "17:50", 4)].map(|(k, s, e, t)| {
                json!({ "key": format!("hc-{d}-{k}"), "day": d.to_string(),
                    "start_at": format!("{d}T{s}:00Z"), "end_at": format!("{d}T{e}:00Z"),
                    "type": t, "name": "Workout", "kcal": 300, "distance_m": 9000 })
            })
        })
        .collect();
    let body = json!({ "from": "2024-01-01", "to": "2024-03-30", "device": "Bench",
        "days": [], "sessions": sessions });
    let (p50, p99) = time(RUNS, |i| {
        let (app, body, pid) = (app.clone(), body.clone(), profiles[i]);
        async move {
            let uri = format!("/api/profiles/{pid}/sync/health");
            let (status, res) = call(&app, "POST", &uri, Some(body)).await;
            assert_eq!(status, StatusCode::OK, "{res}");
        }
    })
    .await;
    let (_, after) = call(
        app,
        "GET",
        &format!("/api/profiles/{}/sessions", profiles[0]),
        None,
    )
    .await;
    assert_eq!(
        after.as_array().map(Vec::len),
        Some(180),
        "claimed + promoted"
    );
    let budget = Duration::from_millis(300);
    let name = "health sync (90d)";
    println!("{name:>17}: p50 {p50:>9.2?}  p99 {p99:>9.2?}  (budget p99 {budget:?})");
    p99 <= budget
}

/// [`SESSIONS`] sessions of 15 sets.
async fn sessions(app: &Router) {
    let (_, exercises) = call(app, "GET", "/api/exercises", None).await;
    let exercise = exercises[0]["id"].as_i64().unwrap();
    for s in 0..SESSIONS {
        let sets: Vec<Value> = (0..15)
            .map(|r| json!({ "exercise_id": exercise, "reps": 5 + r % 10 }))
            .collect();
        call(
            app,
            "POST",
            "/api/profiles/1/sessions",
            Some(json!({ "day": day(s), "name": "Bench", "minutes": 30, "sets": sets })),
        )
        .await;
    }
}

/// p50 and p99 of `runs` calls of `f`.
async fn time<F, Fut>(runs: usize, mut f: F) -> (Duration, Duration)
where
    F: FnMut(usize) -> Fut,
    Fut: Future<Output = ()>,
{
    let mut took = Vec::with_capacity(runs);
    for i in 0..runs {
        let start = Instant::now();
        f(i).await;
        took.push(start.elapsed());
    }
    took.sort();
    (took[runs / 2], took[runs * 99 / 100])
}

/// The address a timed read named `name` asks on its `i`th run.
fn read_uri(name: &str, i: usize, words: &[&str]) -> String {
    match name {
        "search" => format!("/api/profiles/1/foods?q={}", words[i % words.len()]),
        "day" => format!("/api/profiles/1/day/{}", day(i % DAYS)),
        "recent" => "/api/profiles/1/foods/recent".to_owned(),
        "summary (year)" => "/api/profiles/1/summary?from=2023-01-01&to=2023-12-28".to_owned(),
        "sources (year)" => {
            "/api/profiles/1/summary/foods?from=2023-01-01&to=2023-12-28&nutrient=sodium".to_owned()
        }
        "fit" => format!("/api/profiles/1/foods?sort=fit&day={}", day(i % DAYS)),
        "fit (q)" => format!(
            "/api/profiles/1/foods?sort=fit&day={}&q={}",
            day(i % DAYS),
            words[i % words.len()]
        ),
        "scale (year)" => "/api/profiles/1/scale?from=2023-01-01&to=2023-12-31".to_owned(),
        "activity (year)" => "/api/profiles/1/activity?from=2023-01-01&to=2023-12-31".to_owned(),
        "check-ins (year)" => "/api/profiles/1/check-ins?from=2023-01-01&to=2023-12-31".to_owned(),
        "habit days (year)" => {
            "/api/profiles/1/habits/days?from=2023-01-01&to=2023-12-28".to_owned()
        }
        _ => "/api/profiles/1/sessions".to_owned(),
    }
}

#[tokio::test]
#[ignore = "seeds a large database; run on demand"]
async fn hot_reads_stay_within_budget() {
    let mut conn = kaloriina::open(std::path::Path::new(":memory:")).unwrap();
    import_history(&mut conn);
    let app = router(AppState::new(conn, "http://127.0.0.1:9".to_owned()));
    let words = [
        "kana", "riisi", "omena", "maito", "leipä", "juusto", "kaura",
    ];
    let keys = nutrient_keys(&app).await;
    let mut ids = Vec::with_capacity(FOODS);
    for i in 0..FOODS {
        // Every fourth food in a category, so habit days sum them.
        let category = [
            "fruit_veg",
            "sweets_snacks",
            "sugary_drinks",
            "processed_meat",
        ]
        .get(i % 16)
        .copied();
        let (_, f) = call(
            &app,
            "POST",
            "/api/foods",
            Some(json!({
                "name": format!("{} {i}", words[i % words.len()]),
                "per100": per100(i, &keys),
                "servings": [{ "label": "portion", "grams": 100 + i % 200 }],
                "category": category,
            })),
        )
        .await;
        ids.push(f["id"].as_i64().unwrap_or_else(|| panic!("{f}")));
    }
    for d in 0..DAYS {
        for e in 0..ENTRIES_PER_DAY {
            call(
                &app,
                "POST",
                "/api/profiles/1/entries",
                Some(json!({ "day": day(d), "group": "Consumed",
                             "food_id": ids[(d * 7 + e * 13) % FOODS], "grams": 120 })),
            )
            .await;
        }
    }
    plan_and_target(&app, &ids).await;
    habits(&app).await;
    check_ins(&app).await;
    let readings = scale(&app).await;
    sessions(&app).await;
    activity(&app).await;

    // Budgets (p99, server side): a keystroke's search 50 ms, so typing
    // stays under the 100 ms that feels instant; a screen's read 150 ms, so
    // opening it stays under 300 ms with the network and the page.
    let budgets = [
        ("search", 50),
        ("day", 150),
        ("recent", 150),
        ("summary (year)", 150),
        ("sessions", 150),
        ("sources (year)", 150),
        ("fit", 50),
        ("fit (q)", 50),
        ("habit days (year)", 150),
        ("scale (year)", 150),
        ("activity (year)", 150),
        ("check-ins (year)", 150),
    ];
    let mut over = Vec::new();
    for (name, ms) in budgets {
        let budget = Duration::from_millis(ms);
        let (p50, p99) = time(RUNS, |i| {
            let app = app.clone();
            let uri = read_uri(name, i, &words);
            async move {
                let (status, _) = call(&app, "GET", &uri, None).await;
                assert!(status.is_success(), "{uri}: {status}");
            }
        })
        .await;
        println!("{name:>17}: p50 {p50:>9.2?}  p99 {p99:>9.2?}  (budget p99 {budget:?})");
        if p99 > budget {
            over.push(name);
        }
    }
    if !full_sync_within_budget(&app, &readings).await {
        over.push("scale batch (10k)");
    }
    if !many_users_within_budget(&app).await {
        over.push("scale users (100k)");
    }
    if !health_sync_within_budget(&app).await {
        over.push("health sync (90d)");
    }
    assert!(over.is_empty(), "over budget: {over:?}");
}
