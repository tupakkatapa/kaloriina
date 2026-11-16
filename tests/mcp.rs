//! `kaloriina mcp` against a served instance: the protocol, and each tool
//! through the real HTTP client.

use std::path::Path;

use kaloriina::mcp::{Client, handle_line};
use kaloriina::{AppState, Connection, open, router};
use serde_json::{Value, json};

/// Every tool, in the order listed.
const TOOLS: &[&str] = &[
    "profiles",
    "day",
    "summary",
    "trends",
    "weights",
    "activities",
    "workouts",
    "food_search",
    "food_get",
    "log_food",
    "tick_daily",
    "entry_update",
    "entry_delete",
    "food_create",
    "food_add_serving",
    "recipe_create",
    "recipe_update",
    "feedback_list",
    "feedback_pull",
    "device_days",
    "habits",
    "check_ins",
    "measurements",
    "notes",
    "targets",
    "records",
    "stats",
    "nutrient_sources",
    "plans",
    "foods_recent",
    "foods_favorites",
    "food_suggestions",
    "foods_rich",
    "recommended_targets",
    "export",
    "hidden_suggestions",
    "insight_prefs",
    "water_food",
    "meta",
    "now",
    "exercises",
    "workout_templates",
    "backups",
    "food_usage",
    "food_last",
    "workout_get",
    "exercise_history",
    "weight_set",
    "note_set",
    "check_in_set",
    "measurement_set",
    "habit_day_set",
    "api",
];

/// A fresh database holding one Fineli food (id 900).
fn database() -> Connection {
    let conn = open(Path::new(":memory:")).unwrap();
    conn.execute_batch(
        r#"INSERT INTO food (id, name, source, per100, fineli_id, fineli_class)
           VALUES (900, 'Maito, 1 %', 'fineli', '{"energy": 40, "protein": 3.5}', 211, 'MILK');"#,
    )
    .unwrap();
    conn
}

/// Serve `state` on a free loopback port: its base URL.
async fn serve(state: AppState) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, router(state)).await.unwrap() });
    format!("http://{addr}")
}

/// A client of a fresh instance.
async fn client() -> Client {
    let url = serve(AppState::new(database(), "http://127.0.0.1:9".into())).await;
    Client::new(&url, None, None).unwrap()
}

/// The answer to `msg`, parsed.
async fn rpc(client: &Client, msg: &Value) -> Value {
    let line = handle_line(client, &msg.to_string()).await.unwrap();
    assert!(!line.contains('\n'), "one line: {line}");
    serde_json::from_str(&line).unwrap()
}

/// Call tool `name`: whether it failed, and its text (as JSON when it is).
async fn call(client: &Client, name: &str, arguments: Value) -> (bool, Value) {
    let msg = json!({ "jsonrpc": "2.0", "id": 7, "method": "tools/call",
                      "params": { "name": name, "arguments": arguments } });
    let res = rpc(client, &msg).await;
    let result = &res["result"];
    assert_eq!(result["content"][0]["type"], "text", "{res}");
    let text = result["content"][0]["text"].as_str().unwrap();
    let value = serde_json::from_str(text).unwrap_or_else(|_| json!(text));
    (result["isError"].as_bool().unwrap(), value)
}

/// Tool `name`'s answer; fails the test if it failed.
async fn ok(client: &Client, name: &str, arguments: Value) -> Value {
    let (failed, value) = call(client, name, arguments).await;
    assert!(!failed, "{name}: {value}");
    value
}

/// A custom food "Oats", 380 kcal and 13 g protein a 100 g: its id.
async fn oats(client: &Client) -> i64 {
    let food = ok(
        client,
        "food_create",
        json!({ "name": "Oats", "per100": { "energy": 380, "protein": 13 } }),
    )
    .await;
    food["id"].as_i64().unwrap()
}

/// The food `id` reads, without what a save moves on.
async fn read_food(client: &Client, id: i64) -> Value {
    let mut food = ok(client, "food_get", json!({ "id": id })).await;
    let food = food.as_object_mut().unwrap();
    food.remove("rev");
    food.remove("servings");
    food.into_iter()
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect()
}

const DAY: &str = "2026-10-06";

#[tokio::test]
async fn initialize_answers_a_known_version_and_ours_otherwise() {
    let client = client().await;
    for (asked, answered) in [
        ("2025-03-26", "2025-03-26"),
        ("2024-11-05", "2024-11-05"),
        ("1999-01-01", "2025-06-18"),
    ] {
        let res = rpc(
            &client,
            &json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize",
                     "params": { "protocolVersion": asked, "capabilities": {},
                                 "clientInfo": { "name": "test", "version": "0" } } }),
        )
        .await;
        assert_eq!(res["id"], 1);
        let result = &res["result"];
        assert_eq!(result["protocolVersion"], answered, "{res}");
        assert_eq!(result["capabilities"], json!({ "tools": {} }));
        assert_eq!(result["serverInfo"]["name"], "kaloriina");
        assert!(
            result["instructions"].as_str().unwrap().contains("03:00"),
            "{res}"
        );
    }
}

#[tokio::test]
async fn the_protocol_lists_tools_and_refuses_what_it_lacks() {
    let client = client().await;
    let notification = json!({ "jsonrpc": "2.0", "method": "notifications/initialized" });
    assert_eq!(handle_line(&client, &notification.to_string()).await, None);
    assert_eq!(handle_line(&client, "").await, None, "a blank line");
    let ping = rpc(
        &client,
        &json!({ "jsonrpc": "2.0", "id": "p", "method": "ping" }),
    )
    .await;
    assert_eq!(ping, json!({ "jsonrpc": "2.0", "id": "p", "result": {} }));

    let list = rpc(
        &client,
        &json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }),
    )
    .await;
    let tools = list["result"]["tools"].as_array().unwrap();
    let names: Vec<&str> = tools.iter().map(|t| t["name"].as_str().unwrap()).collect();
    assert_eq!(names, TOOLS);
    for t in tools {
        assert!(!t["description"].as_str().unwrap().is_empty(), "{t}");
        assert_eq!(t["inputSchema"]["type"], "object", "{t}");
    }
    let log = tools.iter().find(|t| t["name"] == "log_food").unwrap();
    assert_eq!(
        log["inputSchema"]["properties"]["group"]["enum"],
        json!(["Planned", "Eaten"])
    );
    let trends = tools.iter().find(|t| t["name"] == "trends").unwrap();
    assert_eq!(
        trends["inputSchema"]["properties"]["by"]["enum"],
        json!(["week", "month"])
    );

    let unknown = rpc(
        &client,
        &json!({ "jsonrpc": "2.0", "id": 3, "method": "resources/list" }),
    )
    .await;
    assert_eq!(
        (&unknown["id"], &unknown["error"]["code"]),
        (&json!(3), &json!(-32601))
    );
    let bad: Value =
        serde_json::from_str(&handle_line(&client, "{not json").await.unwrap()).unwrap();
    assert_eq!(
        (&bad["id"], &bad["error"]["code"]),
        (&Value::Null, &json!(-32700))
    );
    let tool = rpc(
        &client,
        &json!({ "jsonrpc": "2.0", "id": 4, "method": "tools/call",
                 "params": { "name": "drop_tables", "arguments": {} } }),
    )
    .await;
    assert_eq!(tool["error"]["code"], -32602, "{tool}");
}

#[tokio::test]
async fn reads_answer_the_apis_data() {
    let client = client().await;
    let profiles = ok(&client, "profiles", json!({})).await;
    assert_eq!(profiles[0]["name"], "Me");
    let oats = oats(&client).await;
    ok(
        &client,
        "log_food",
        json!({ "food_id": oats, "grams": 100, "group": "Eaten", "day": DAY }),
    )
    .await;

    let day = ok(&client, "day", json!({ "day": DAY })).await;
    assert_eq!(day["eaten"]["energy"], 380.0, "{day}");
    let summary = ok(
        &client,
        "summary",
        json!({ "from": DAY, "to": DAY, "keys": "energy" }),
    )
    .await;
    assert_eq!(summary["days"][0]["total"], json!({ "energy": 380.0 }));
    let trends = ok(
        &client,
        "trends",
        json!({ "from": DAY, "to": DAY, "by": "month" }),
    )
    .await;
    assert_eq!(trends["buckets"][0]["energy"], 380.0, "{trends}");
    let activities = ok(&client, "activities", json!({ "from": DAY, "to": DAY })).await;
    assert_eq!(activities, json!([]));
    let workouts = ok(&client, "workouts", json!({ "from": DAY, "to": DAY })).await;
    assert_eq!(workouts, json!([]), "none done in the range");
    let weights = ok(&client, "weights", json!({ "from": DAY, "to": DAY })).await;
    assert_eq!(weights, json!({ "weights": [], "scale": [] }));

    let found = ok(&client, "food_search", json!({ "q": "oat" })).await;
    assert_eq!(
        found,
        json!([{ "id": oats, "name": "Oats", "brand": null, "source": "custom",
                 "kind": "food", "servings": [],
                 "per100": { "energy": 380.0, "protein": 13.0, "carbs": null,
                             "fat": null, "alcohol": null } }])
    );
    let fineli = ok(
        &client,
        "food_search",
        json!({ "q": "maito", "sources": "fineli", "limit": 1 }),
    )
    .await;
    assert_eq!(fineli.as_array().unwrap().len(), 1, "{fineli}");
    let food = ok(&client, "food_get", json!({ "id": 900 })).await;
    assert_eq!(food["name"], "Maito, 1 %");
}

#[tokio::test]
async fn a_tool_without_a_day_logs_to_the_diary_day() {
    let client = client().await;
    let oats = oats(&client).await;
    let logged = ok(
        &client,
        "log_food",
        json!({ "food_id": oats, "grams": 50, "group": "Eaten" }),
    )
    .await;
    let now = ok(&client, "day", json!({})).await;
    assert_eq!(logged["entries"][0]["day"], now["day"], "{logged}");
    assert_eq!(now["eaten"]["energy"], 190.0, "{now}");
}

#[tokio::test]
async fn a_uid_logs_once() {
    let client = client().await;
    let oats = oats(&client).await;
    let log = json!({ "food_id": oats, "grams": 100, "group": "Eaten", "day": DAY,
                      "uid": "agent-log-1" });
    let first = ok(&client, "log_food", log.clone()).await;
    assert_eq!(first["logged"], 1, "{first}");
    let again = ok(&client, "log_food", log).await;
    assert_eq!(again["entries"][0]["id"], first["entries"][0]["id"]);

    let entry = &first["entries"][0];
    let key = entry["key"].as_str().unwrap();
    let repeated = ok(
        &client,
        "entry_update",
        json!({ "key": key, "repeat": { "start": DAY } }),
    )
    .await;
    let item = repeated["repeat"]["id"].as_i64().unwrap();
    let next = "2026-10-07";
    for _ in 0..2 {
        let tick = ok(
            &client,
            "tick_daily",
            json!({ "item": item, "day": next, "uid": "agent-tick-1" }),
        )
        .await;
        assert_eq!(tick["logged"], 1, "{tick}");
    }
    let day = ok(&client, "day", json!({ "day": DAY })).await;
    assert_eq!(day["eaten"]["energy"], 380.0, "logged once: {day}");
    let day = ok(&client, "day", json!({ "day": next })).await;
    assert_eq!(day["eaten"]["energy"], 380.0, "ticked once: {day}");
}

#[tokio::test]
async fn entries_change_and_go() {
    let client = client().await;
    let oats = oats(&client).await;
    let logged = ok(
        &client,
        "log_food",
        json!({ "food_id": oats, "grams": 100, "group": "Eaten", "day": DAY }),
    )
    .await;
    let key = logged["entries"][0]["key"].as_str().unwrap();
    let changed = ok(
        &client,
        "entry_update",
        json!({ "key": key, "grams": 50, "time": "08:15" }),
    )
    .await;
    assert_eq!(
        (&changed["grams"], &changed["time"]),
        (&json!(50.0), &json!("08:15"))
    );
    ok(&client, "entry_delete", json!({ "key": key })).await;
    let day = ok(&client, "day", json!({ "day": DAY })).await;
    assert_eq!(day["eaten"]["energy"], Value::Null, "{day}");
    let (failed, e) = call(&client, "entry_delete", json!({ "key": key })).await;
    assert!(failed);
    assert_eq!(e["code"], "not_found", "{e}");
}

#[tokio::test]
async fn an_api_error_is_a_failed_call_with_its_body() {
    let client = client().await;
    let (failed, e) = call(&client, "summary", json!({ "from": DAY })).await;
    assert!(failed);
    assert_eq!(
        e,
        json!({ "error": "From and to are required", "code": "invalid" })
    );
    let (failed, e) = call(&client, "food_get", json!({})).await;
    assert!(failed, "{e}");
    assert!(e.as_str().unwrap().contains("id"), "{e}");
    let (failed, e) = call(&client, "food_get", json!({ "id": "1/../../profiles" })).await;
    assert!(failed, "{e}");
    assert_eq!(e["code"], "invalid", "the id stays one path segment: {e}");
}

#[tokio::test]
async fn an_unreachable_instance_is_a_failed_call() {
    let client = Client::new("http://127.0.0.1:9", None, None).unwrap();
    let (failed, e) = call(&client, "profiles", json!({})).await;
    assert!(failed);
    assert!(e.as_str().unwrap().contains("127.0.0.1:9"), "{e}");
}

#[tokio::test]
async fn several_profiles_need_one_named() {
    let conn = database();
    conn.execute("INSERT INTO profile (id, name) VALUES (2, 'Anna')", [])
        .unwrap();
    let url = serve(AppState::new(conn, "http://127.0.0.1:9".into())).await;
    let client = Client::new(&url, None, None).unwrap();
    let (failed, e) = call(&client, "day", json!({ "day": DAY })).await;
    assert!(failed);
    let e = e.as_str().unwrap();
    assert!(e.contains("Me") && e.contains("Anna"), "{e}");
    let anna = ok(&client, "day", json!({ "day": DAY, "profile": "Anna" })).await;
    assert_eq!(anna["day"], DAY);
    ok(&client, "day", json!({ "day": DAY, "profile": 2 })).await;
    let (failed, _) = call(&client, "day", json!({ "day": DAY, "profile": "Bob" })).await;
    assert!(failed);
    let named = Client::new(&url, None, Some("Anna".into())).unwrap();
    ok(&named, "day", json!({ "day": DAY })).await;
}

#[tokio::test]
async fn the_host_header_is_the_one_given() {
    let mut state = AppState::new(database(), "http://127.0.0.1:9".into());
    state.allowed_hosts = vec!["diary.example".into()];
    let url = serve(state).await;
    let known = Client::new(&url, Some("diary.example".into()), None).unwrap();
    ok(&known, "profiles", json!({})).await;
    let unknown = Client::new(&url, Some("other.example".into()), None).unwrap();
    let (failed, e) = call(&unknown, "profiles", json!({})).await;
    assert!(failed);
    assert_eq!(e["code"], "bad_host", "{e}");
}

#[tokio::test]
async fn a_volume_serving_is_added_and_logged_by() {
    let client = client().await;
    let before = read_food(&client, 900).await;
    let food = ok(
        &client,
        "food_add_serving",
        json!({ "id": 900, "label": "dl", "grams": 103 }),
    )
    .await;
    assert_eq!(food["servings"], json!([{ "label": "dl", "grams": 103.0 }]));
    let logged = ok(
        &client,
        "log_food",
        json!({ "food_id": 900, "serving": "dl", "quantity": 2, "group": "Eaten",
                "day": DAY }),
    )
    .await;
    assert_eq!(logged["entries"][0]["grams"], 206.0, "{logged}");
    let (mut before, mut after) = (before, read_food(&client, 900).await);
    // Milk poured by the decilitre is a drink by the server's own rule.
    for food in [&mut before, &mut after] {
        for key in ["drink", "hydration", "labels"] {
            food.as_object_mut().unwrap().remove(key);
        }
    }
    assert_eq!(after, before, "the rest reads the same");
}

#[tokio::test]
async fn read_merge_writes_change_only_what_they_are_given() {
    let client = client().await;
    let oats = oats(&client).await;
    let custom = ok(
        &client,
        "food_create",
        json!({ "name": "Peanut butter", "brand": "Acme", "barcode": "6414893400016",
                "category": "sweets_snacks", "per100": { "energy": 600, "fat": 50 },
                "servings": [{ "label": "tbsp", "grams": 15 }] }),
    )
    .await;
    let id = custom["id"].as_i64().unwrap();
    let before = read_food(&client, id).await;
    let food = ok(
        &client,
        "food_add_serving",
        json!({ "id": id, "label": "jar", "grams": 350 }),
    )
    .await;
    assert_eq!(
        food["servings"],
        json!([{ "label": "tbsp", "grams": 15.0 }, { "label": "jar", "grams": 350.0 }])
    );
    assert_eq!(read_food(&client, id).await, before);

    let recipe = ok(
        &client,
        "recipe_create",
        json!({ "name": "Porridge", "cooked_g": 300, "makes": 2, "notes": "Stir.",
                "items": [{ "food_id": oats, "grams": 60 },
                          { "food_id": 900, "grams": 200 }] }),
    )
    .await;
    let rid = recipe["id"].as_i64().unwrap();
    let before = ok(&client, "food_get", json!({ "id": rid })).await;
    let changed = ok(
        &client,
        "recipe_update",
        json!({ "id": rid, "notes": "Stir well." }),
    )
    .await;
    assert_eq!(changed["notes"], "Stir well.");
    let mut after = ok(&client, "food_get", json!({ "id": rid })).await;
    after["notes"] = before["notes"].clone();
    after["rev"] = before["rev"].clone();
    assert_eq!(after, before, "the rest reads the same");

    let added = ok(
        &client,
        "food_add_serving",
        json!({ "id": rid, "label": "bowl", "grams": 250 }),
    )
    .await;
    let labels: Vec<_> = added["servings"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["label"].clone())
        .collect();
    assert!(labels.contains(&json!("bowl")), "{added}");
    let mut after = ok(&client, "food_get", json!({ "id": rid })).await;
    after["notes"] = before["notes"].clone();
    after["rev"] = before["rev"].clone();
    after["servings"] = before["servings"].clone();
    assert_eq!(after, before, "a recipe's serving alone");
}

#[tokio::test]
async fn feedback_is_listed_and_pulled() {
    let client = client().await;
    assert_eq!(ok(&client, "feedback_list", json!({})).await, json!([]));
    let conn = database();
    conn.execute_batch(
        "INSERT INTO feedback (kind, text) VALUES ('bug', 'One'), ('feature', 'Two');",
    )
    .unwrap();
    let url = serve(AppState::new(conn, "http://127.0.0.1:9".into())).await;
    let client = Client::new(&url, None, None).unwrap();
    let open = ok(&client, "feedback_list", json!({})).await;
    let ids: Vec<i64> = open
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["id"].as_i64().unwrap())
        .collect();
    assert_eq!(open[1]["text"], "Two");
    let left = ok(&client, "feedback_pull", json!({ "ids": [ids[0]] })).await;
    assert_eq!(left, json!({ "open": 1 }));
    let open = ok(&client, "feedback_list", json!({})).await;
    assert_eq!(open.as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn the_rest_of_the_diary_is_read() {
    let client = client().await;
    let range = json!({ "from": "2026-11-01", "to": "2026-11-15" });
    let device = ok(&client, "device_days", range.clone()).await;
    assert!(device["days"].is_array(), "{device}");
    for tool in ["check_ins", "measurements", "notes"] {
        let read = ok(&client, tool, range.clone()).await;
        assert!(read.is_array(), "{tool}: {read}");
    }
    let habits = ok(&client, "habits", range.clone()).await;
    assert!(habits["habits"].is_array(), "{habits}");
    assert!(habits["days"].is_array(), "{habits}");
    for tool in ["targets", "records", "stats"] {
        let read = ok(&client, tool, json!({})).await;
        assert!(read.is_object() || read.is_array(), "{tool}: {read}");
    }
    let mut sources = range.clone();
    sources["nutrient"] = json!("protein");
    let read = ok(&client, "nutrient_sources", sources).await;
    assert!(!read.is_null(), "{read}");
    // The API's own refusal comes through.
    let (failed, err) = call(&client, "nutrient_sources", range).await;
    assert!(failed, "{err}");
    assert_eq!(err["field"], "nutrient", "{err}");
}

#[tokio::test]
async fn every_other_read_has_a_tool() {
    let client = client().await;
    let range = json!({ "from": "2026-11-01", "to": "2026-11-15" });
    for (tool, arguments) in [
        ("plans", range.clone()),
        ("foods_recent", json!({})),
        ("foods_favorites", json!({})),
        (
            "food_suggestions",
            json!({ "day": "2026-11-15", "time": "08:00" }),
        ),
        ("foods_rich", json!({ "nutrient": "protein" })),
        ("export", json!({})),
        ("hidden_suggestions", json!({})),
        ("insight_prefs", json!({})),
        ("water_food", json!({})),
        ("meta", json!({})),
        ("now", json!({})),
        ("exercises", json!({})),
        ("workout_templates", json!({})),
        ("backups", json!({})),
        ("food_usage", json!({ "id": 900 })),
        ("food_last", json!({ "id": 900 })),
    ] {
        let (failed, read) = call(&client, tool, arguments).await;
        assert!(!failed, "{tool}: {read}");
    }
    // A profile without a body: the API says what it lacks.
    let (failed, err) = call(&client, "recommended_targets", json!({})).await;
    assert!(failed, "{err}");
    assert_eq!(err["code"], "invalid", "{err}");
    let exercises = ok(&client, "exercises", json!({})).await;
    let id = exercises[0]["id"].as_i64().unwrap();
    let history = ok(&client, "exercise_history", json!({ "id": id })).await;
    assert!(!history.is_null(), "{history}");
    let (failed, err) = call(&client, "workout_get", json!({ "id": 9999 })).await;
    assert!(failed, "{err}");
    assert_eq!(err["code"], "not_found", "{err}");
}

#[tokio::test]
async fn a_day_is_written_by_its_tools() {
    let client = client().await;
    let day = "2026-11-10";
    ok(&client, "weight_set", json!({ "day": day, "kg": 81.5 })).await;
    ok(
        &client,
        "note_set",
        json!({ "day": day, "text": "Long run" }),
    )
    .await;
    ok(&client, "check_in_set", json!({ "day": day, "mood": 4 })).await;
    ok(
        &client,
        "measurement_set",
        json!({ "day": day, "kind": "waist", "value": 84.0 }),
    )
    .await;
    let range = json!({ "from": day, "to": day });
    let weights = ok(&client, "weights", range.clone()).await;
    assert_eq!(weights["weights"][0]["kg"], 81.5, "{weights}");
    assert_eq!(
        ok(&client, "notes", range.clone()).await[0]["text"],
        "Long run"
    );
    assert_eq!(ok(&client, "check_ins", range.clone()).await[0]["mood"], 4);
    assert_eq!(
        ok(&client, "measurements", range.clone()).await[0]["value"],
        84.0
    );
    let (failed, err) = call(
        &client,
        "habit_day_set",
        json!({ "id": 9999, "day": day, "amount": 1 }),
    )
    .await;
    assert!(failed, "{err}");
}

#[tokio::test]
async fn the_raw_tool_reaches_the_api_and_nothing_else() {
    let client = client().await;
    let read = ok(
        &client,
        "api",
        json!({ "method": "GET", "path": "/api/now" }),
    )
    .await;
    assert!(read["day"].is_string(), "{read}");
    let found = ok(
        &client,
        "api",
        json!({ "method": "GET", "path": "/api/profiles/1/foods", "query": { "q": "maito" } }),
    )
    .await;
    assert_eq!(found[0]["id"], 900, "{found}");
    for path in [
        "/",
        "/index.html",
        "api/now",
        "//example.org/api/now",
        "/api/../x",
        "/api/now?x=1",
    ] {
        let (failed, err) = call(&client, "api", json!({ "method": "GET", "path": path })).await;
        assert!(failed, "{path}: {err}");
        assert_eq!(
            err, "path must be a route under /api/, without a query",
            "{path}"
        );
    }
    let (failed, err) = call(
        &client,
        "api",
        json!({ "method": "GET", "path": "/api/now", "query": "q=maito" }),
    )
    .await;
    assert!(failed, "{err}");
    assert_eq!(err, "query must be an object");
    // The API's own refusal comes through.
    let (failed, err) = call(
        &client,
        "api",
        json!({ "method": "DELETE", "path": "/api/now" }),
    )
    .await;
    assert!(failed, "{err}");
    assert_eq!(err["code"], "method_not_allowed", "{err}");
    let (failed, err) = call(
        &client,
        "api",
        json!({ "method": "TRACE", "path": "/api/now" }),
    )
    .await;
    assert!(failed, "{err}");
}

#[tokio::test]
async fn an_argument_is_one_path_segment_or_refused() {
    let client = client().await;
    for (tool, arguments) in [
        ("entry_delete", json!({ "key": ".." })),
        ("food_usage", json!({ "id": "." })),
    ] {
        let (failed, err) = call(&client, tool, arguments).await;
        assert!(failed, "{tool}: {err}");
        assert!(
            err.as_str().unwrap().contains("can't be part of a path"),
            "{tool}: {err}"
        );
    }
}

#[tokio::test]
async fn suggestions_without_a_day_are_the_diary_days() {
    let client = client().await;
    let read = ok(&client, "food_suggestions", json!({})).await;
    assert!(read.is_array(), "{read}");
}
