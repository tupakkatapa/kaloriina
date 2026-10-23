use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use axum::body::Body;
use axum::extract::Path;
use axum::http::{Request, header};
use axum::response::IntoResponse;
use axum::routing::get;
use tower::ServiceExt;

use super::*;
use crate::common::{ME, raw};

#[tokio::test]
async fn log_food_then_mark_eaten() {
    let app = app();
    let oats = create_food(&app, "Oats", json!({ "energy": 380.0, "protein": 13.0 })).await;

    let (status, res) = call(
        &app,
        "POST",
        "/api/profiles/1/entries",
        Some(json!({ "day": DAY, "group": "Planned", "food_id": oats, "grams": 50.0 })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let id = res["entries"][0]["id"].as_i64().unwrap();

    let (_, day) = call(&app, "GET", &format!("/api/profiles/1/day/{DAY}"), None).await;
    assert_eq!(group(&day, "Planned")["totals"]["energy"], 190.0);
    assert_eq!(group(&day, "Eaten")["entries"].as_array().unwrap().len(), 0);
    assert_eq!(day["total"]["protein"], 6.5);

    let (status, entry) = call(
        &app,
        "PATCH",
        &format!("/api/profiles/1/entries/{id}"),
        Some(json!({ "group": "Eaten" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(entry["group"], "Eaten");
    assert_eq!(entry["amount"], "50 g");

    let (_, day) = call(&app, "GET", &format!("/api/profiles/1/day/{DAY}"), None).await;
    assert_eq!(group(&day, "Eaten")["totals"]["energy"], 190.0);
}

#[tokio::test]
async fn deleting_an_entry_twice_is_404() {
    let app = app();
    let oats = create_food(&app, "Oats", json!({})).await;
    let entry = log_entry(&app, "Eaten", oats, 1.0).await;
    let uri = format!("/api/profiles/1/entries/{}", entry["id"]);
    assert_eq!(
        call(&app, "DELETE", &uri, None).await.0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        call(&app, "DELETE", &uri, None).await.0,
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn recipe_and_meal_logging() {
    let app = app();
    let oats = create_food(
        &app,
        "Oats",
        json!({ "energy": 400.0, "iron": 4.0, "water": 10.0 }),
    )
    .await;
    let milk = create_food(&app, "Milk", json!({ "energy": 50.0, "water": 90.0 })).await;

    let (status, recipe) = call(
        &app,
        "POST",
        "/api/recipes",
        Some(json!({ "name": "Porridge", "cooked_g": 500.0,
                     "items": [{ "food_id": oats, "grams": 100.0 }, { "food_id": milk, "grams": 200.0 }] })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{recipe}");
    // (400 + 100) kcal over 500 g cooked.
    assert_eq!(recipe["per100"]["energy"], 100.0);
    assert_eq!(recipe["items"][1]["name"], "Milk");

    let (_, meal) = call(
        &app,
        "POST",
        "/api/meals",
        Some(json!({ "name": "Breakfast", "items": [
            { "food_id": recipe["id"], "grams": 250.0 }, { "food_id": milk, "grams": 100.0 }] })),
    )
    .await;
    let (status, res) = call(
        &app,
        "POST",
        "/api/profiles/1/entries",
        Some(json!({ "day": DAY, "group": "Eaten", "meal_id": meal["id"] })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(res["entries"].as_array().unwrap().len(), 2);

    let (_, day) = call(&app, "GET", &format!("/api/profiles/1/day/{DAY}"), None).await;
    assert_eq!(day["total"]["energy"], 300.0);
    // The day knows what the meal's preview (web `recipeKnown`
    // over its items, pinned to the server's rule by
    // tests/fixtures/coverage-cases.json) says. The porridge is 22 g dry a
    // 100 g, iron on 18 of it; the milk 10 g dry, no iron. 250 g and
    // 100 g: 65 g dry, iron behind 45 of it.
    let known = &day["known"];
    let keys: Vec<&String> = known.as_object().unwrap().keys().collect();
    assert_eq!(keys, ["dry", "iron"], "{known}");
    assert!(
        (known["dry"].as_f64().unwrap() - 65.0).abs() < 1e-9,
        "{known}"
    );
    assert!(
        (known["iron"].as_f64().unwrap() - 45.0 / 65.0).abs() < 1e-9,
        "{known}"
    );

    let (_, foods) = search(&app, "q=porr").await;
    // A recipe is a kind of food, its own (ADR 0031): not a source.
    assert_eq!(
        (&foods[0]["kind"], &foods[0]["source"]),
        (&json!("recipe"), &json!("custom"))
    );
}

#[tokio::test]
async fn targets_and_summary() {
    let app = app();
    let (status, _) = put_targets(&app, 1, json!([{ "metric": "energy", "value": 2000.0 }])).await;
    assert_eq!(status, StatusCode::OK);

    let oats = create_food(&app, "Oats", json!({ "energy": 400.0 })).await;
    for (day, grams) in [("2026-10-05", 100.0), ("2026-10-06", 300.0)] {
        log_entry_on(&app, day, "Eaten", oats, grams).await;
    }
    let (_, sum) = call(
        &app,
        "GET",
        "/api/profiles/1/summary?from=2026-10-01&to=2026-10-07",
        None,
    )
    .await;
    // The days, each its own total; the mean is the client's.
    let totals: Vec<&Value> = sum["days"]
        .as_array()
        .unwrap()
        .iter()
        .map(|d| &d["total"]["energy"])
        .collect();
    assert_eq!(totals, [&json!(400.0), &json!(1200.0)]);
    assert!(
        sum.get("average").is_none() && sum.get("days_logged").is_none(),
        "{sum}"
    );

    let (_, day) = call(&app, "GET", "/api/profiles/1/day/2026-10-06", None).await;
    assert_eq!(day["targets"][0]["value"], 2000.0);
    // Energy is an "about" target: within 5 % either way is on target.
    assert_eq!(day["targets"][0]["min"], 1900.0);
    assert_eq!(day["targets"][0]["max"], 2100.0);
}

#[tokio::test]
async fn validation_rejects_bad_input() {
    let app = app();
    let oats = create_food(&app, "Oats", json!({})).await;
    let bad = [
        ("POST", "/api/foods", json!({ "name": "  " })),
        (
            "POST",
            "/api/foods",
            json!({ "name": "X", "per100": { "bogus": 1.0 } }),
        ),
        (
            "POST",
            "/api/foods",
            json!({ "name": "X", "barcode": "12ab" }),
        ),
        (
            "POST",
            "/api/profiles/1/entries",
            json!({ "day": "2026-13-01", "group": "Eaten", "food_id": oats, "grams": 1.0 }),
        ),
        (
            "POST",
            "/api/profiles/1/entries",
            json!({ "day": DAY, "group": "Eaten", "food_id": oats, "grams": -1.0 }),
        ),
        (
            "POST",
            "/api/profiles/1/entries",
            json!({ "day": DAY, "group": "Eaten" }),
        ),
        (
            "POST",
            "/api/recipes",
            json!({ "name": "Empty", "items": [] }),
        ),
        (
            "PUT",
            "/api/profiles/1/targets",
            json!({ "rev": 1, "targets": [{ "metric": "energy", "value": -1.0 }] }),
        ),
        (
            "PUT",
            "/api/profiles/1/targets",
            json!({ "rev": 1, "targets": [{ "metric": "nope", "value": 1.0 }] }),
        ),
    ];
    for (method, uri, body) in bad {
        let (status, res) = call(&app, method, uri, Some(body.clone())).await;
        assert_eq!(
            status,
            StatusCode::BAD_REQUEST,
            "{method} {uri} {body} -> {res}"
        );
        assert!(res["error"].is_string());
    }
    let (status, _) = call(
        &app,
        "GET",
        "/api/profiles/1/summary?from=2026-10-07&to=2026-10-01",
        None,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = call(&app, "GET", "/api/nope", None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn cross_site_form_post_is_rejected() {
    let app = app();
    let (status, _) = raw(
        &app,
        "POST",
        "/api/foods",
        "application/x-www-form-urlencoded",
        "name=evil",
    )
    .await;
    assert_eq!(status, StatusCode::UNSUPPORTED_MEDIA_TYPE);
    assert_only_seeded_foods(&app).await;
}

#[tokio::test]
async fn duplicate_barcode_conflicts() {
    let app = app();
    let body = json!({ "name": "A", "barcode": "6408430000258" });
    assert_eq!(
        call(&app, "POST", "/api/foods", Some(body.clone())).await.0,
        StatusCode::CREATED
    );
    assert_eq!(
        call(&app, "POST", "/api/foods", Some(body)).await.0,
        StatusCode::CONFLICT
    );
}

#[tokio::test]
async fn barcode_lookup_caches_open_food_facts() {
    let hits = Arc::new(AtomicUsize::new(0));
    let counter = hits.clone();
    let stub = Router::new().route(
        "/api/v2/product/{file}",
        get(move |Path(file): Path<String>| {
            counter.fetch_add(1, Ordering::SeqCst);
            async move {
                if file == "6408430000258.json" {
                    axum::Json(
                        json!({ "product": { "product_name": "Rye bread", "brands": "Fazer",
                        "nutriments": { "energy-kcal_100g": 250, "proteins_100g": 9 } } }),
                    )
                    .into_response()
                } else {
                    StatusCode::NOT_FOUND.into_response()
                }
            }
        }),
    );
    let app = app_with_stub(stub).await;
    let (_, meta) = call(&app, "GET", "/api/meta", None).await;
    assert_eq!(meta["food_sources"], json!(["custom", "recipe"]));
    let (status, food) = call(
        &app,
        "POST",
        "/api/foods/barcode/6408430000258",
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{food}");
    // The first cached Open Food Facts food makes it a source to filter by.
    let (_, meta) = call(&app, "GET", "/api/meta", None).await;
    assert_eq!(meta["food_sources"], json!(["custom", "recipe", "off"]));
    assert_eq!(food["name"], "Rye bread");
    assert_eq!(food["source"], "off");
    assert_eq!(food["per100"]["protein"], 9.0);

    let (status, again) = call(
        &app,
        "POST",
        "/api/foods/barcode/6408430000258",
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(again["id"], food["id"]);
    assert_eq!(
        hits.load(Ordering::SeqCst),
        1,
        "second scan must be served locally"
    );

    assert_eq!(
        call(
            &app,
            "POST",
            "/api/foods/barcode/4000000000000",
            Some(json!({}))
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call(&app, "POST", "/api/foods/barcode/abc", Some(json!({})))
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
}

#[tokio::test]
async fn barcode_lookup_survives_off_outage() {
    let app = app();
    let (status, res) = call(
        &app,
        "POST",
        "/api/foods/barcode/6408430000258",
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_GATEWAY, "{res}");
    assert!(res["error"].as_str().unwrap().contains("unreachable"));
}

#[tokio::test]
async fn serves_embedded_ui() {
    let app = app();
    let res = app
        .clone()
        .oneshot(Request::builder().uri("/").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    assert!(
        res.headers()[header::CONTENT_SECURITY_POLICY]
            .to_str()
            .unwrap()
            .contains("default-src 'self'")
    );
}

/// Every API answer names the build that served it: the hash `index.html`
/// loads the app from, so a page from another build can tell.
#[tokio::test]
async fn api_answers_name_the_build() {
    use http_body_util::BodyExt;
    let app = app();
    let get = |uri: &str| {
        let req = Request::builder().uri(uri).body(Body::empty()).unwrap();
        app.clone().oneshot(req)
    };
    let index = get("/").await.unwrap();
    assert!(index.headers().get("x-kaloriina-build").is_none());
    let html = index.into_body().collect().await.unwrap().to_bytes();
    let html = String::from_utf8_lossy(&html);
    let hash = html
        .split("/v/")
        .nth(1)
        .and_then(|s| s.split('/').next())
        .unwrap();
    for uri in ["/api/meta", "/api/nope"] {
        let res = get(uri).await.unwrap();
        assert_eq!(
            res.headers()
                .get("x-kaloriina-build")
                .map(|v| v.to_str().unwrap()),
            Some(hash),
            "{uri}"
        );
    }
}

/// Goal plausibility bounds are served, so the client checks the server's
/// numbers instead of copies.
#[tokio::test]
async fn meta_serves_the_goal_bounds() {
    let (_, meta) = call(&app(), "GET", "/api/meta", None).await;
    let l = &meta["limits"];
    assert_eq!(l["goal_bmi"], json!([15.0, 40.0]));
    assert_eq!(l["essential_fat"], json!({ "male": 5.0, "female": 12.0 }));
    assert_eq!(
        (&l["fat_muscle_max"], &l["muscle_of_lean_max"]),
        (&json!(85.0), &json!(0.62))
    );
}

#[tokio::test]
async fn barcode_lookup_tolerates_long_serving_label() {
    let stub = Router::new().route(
        "/api/v2/product/{file}",
        get(|| async {
            axum::Json(json!({ "product": {
                "product_name": "Muesli",
                "serving_quantity": "45",
                "serving_size": "45 g muesli + 125 ml semi-skimmed milk (one bowl, prepared)",
                "nutriments": { "energy-kcal_100g": 370 } } }))
        }),
    );
    let app = app_with_stub(stub).await;
    let (status, food) = call(
        &app,
        "POST",
        "/api/foods/barcode/4000000000017",
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{food}");
    let label = food["servings"][0]["label"].as_str().unwrap();
    assert!(label.chars().count() <= 50, "{label}");
    assert_eq!(food["servings"][0]["grams"], 45.0);
}

fn imported_app() -> Router {
    let mut conn = open(FsPath::new(":memory:")).unwrap();
    let csv = "Day,Group,Food Name,Amount\n2026-06-02,Planned,Rye Bread,70.00 g\n";
    common::import_servings(&mut conn, ME, csv.as_bytes()).unwrap();
    app_from(conn, NO_OFF)
}

#[tokio::test]
async fn imported_entries_only_change_group() {
    let app = imported_app();
    let (_, day) = call(&app, "GET", "/api/profiles/1/day/2026-06-02", None).await;
    let entry = &group(&day, "Planned")["entries"][0];
    assert_eq!(
        entry["src_group"], "Planned",
        "imported rows name their group"
    );
    assert_eq!(entry["grams"], Value::Null, "imported rows carry no grams");
    assert_eq!(entry["source"], Value::Null, "imported rows have no food");
    let uri = format!("/api/profiles/1/entries/{}", entry["id"]);

    for body in [
        json!({ "grams": 10.0 }),
        json!({ "serving": "Slice", "quantity": 2.0 }),
    ] {
        let (status, res) = call(&app, "PATCH", &uri, Some(body)).await;
        assert_eq!(status, StatusCode::CONFLICT, "{res}");
    }
    assert_eq!(
        call(&app, "DELETE", &uri, None).await.0,
        StatusCode::CONFLICT
    );
    let (status, moved) = call(&app, "PATCH", &uri, Some(json!({ "group": "Eaten" }))).await;
    assert_eq!(status, StatusCode::OK, "{moved}");
    assert_eq!(moved["group"], "Eaten");
}

#[tokio::test]
async fn entry_groups_are_closed() {
    let app = app();
    let oats = create_food(&app, "Oats", json!({ "energy": 100.0 })).await;
    let (status, _) = call(
        &app,
        "POST",
        "/api/profiles/1/entries",
        Some(json!({ "day": DAY, "group": "Lunch", "food_id": oats, "grams": 1.0 })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let entry = log_entry(&app, "Planned", oats, 1.0).await;
    let uri = format!("/api/profiles/1/entries/{}", entry["id"]);
    let (status, _) = call(&app, "PATCH", &uri, Some(json!({ "group": "consumed" }))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn every_api_error_is_json() {
    let app = app();
    let cases = [
        (
            "POST",
            "/api/foods",
            "text/plain",
            "{}",
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
        ),
        (
            "POST",
            "/api/foods",
            "application/json",
            "{nope",
            StatusCode::BAD_REQUEST,
        ),
        (
            "POST",
            "/api/foods",
            "application/json",
            r#"{"name": 5}"#,
            StatusCode::BAD_REQUEST,
        ),
        (
            "GET",
            "/api/foods/abc",
            "application/json",
            "",
            StatusCode::BAD_REQUEST,
        ),
        (
            "GET",
            "/api/profiles/1/summary?from=2026-10-01",
            "application/json",
            "",
            StatusCode::BAD_REQUEST,
        ),
        (
            "DELETE",
            "/api/foods/1/usage",
            "application/json",
            "",
            StatusCode::METHOD_NOT_ALLOWED,
        ),
    ];
    for (method, uri, ctype, body, want) in cases {
        let (status, res) = raw(&app, method, uri, ctype, body).await;
        assert_eq!(status, want, "{method} {uri}");
        assert!(res["error"].is_string(), "{method} {uri} -> {res}");
    }
}

#[tokio::test]
async fn error_messages_name_the_problem() {
    let app = app();
    let oats = create_food(&app, "Oats", json!({})).await;
    let cases = [
        (
            "POST",
            "/api/profiles/1/entries",
            json!({ "day": DAY, "group": "Eaten", "food_id": oats, "grams": 0.0 }),
            "Grams must be more than 0",
        ),
        (
            "POST",
            "/api/profiles/1/entries",
            json!({ "day": DAY, "group": "Eaten", "meal_id": 999 }),
            "Unknown meal 999",
        ),
        (
            "PUT",
            "/api/profiles/1/targets",
            json!({ "rev": 1, "targets": [{ "metric": "protein", "value": -5.0 }] }),
            "Protein: target must be 0–400",
        ),
        (
            "PUT",
            "/api/profiles/1/targets",
            json!({ "rev": 1, "targets": [{ "metric": "enrgy", "value": 1.0 }] }),
            "Unknown metric “enrgy”",
        ),
        (
            "POST",
            "/api/meals",
            json!({ "name": "M", "items": [{ "food_id": oats, "grams": 1.0 }, { "food_id": oats, "grams": -1.0 }] }),
            "Item 2: grams must be more than 0",
        ),
        (
            "POST",
            "/api/meals",
            json!({ "name": "M", "items": [{ "food_id": 999, "grams": 1.0 }] }),
            "Unknown food 999",
        ),
        (
            "POST",
            "/api/foods",
            json!({ "name": "F", "per100": { "net_carbs": -1.0 } }),
            "Carbs: must be a number ≥ 0",
        ),
        (
            "POST",
            "/api/foods",
            json!({ "name": "F", "per100": { "carbz": 1.0 } }),
            "Unknown nutrient carbz",
        ),
        (
            "POST",
            "/api/foods",
            json!({ "name": "F", "servings": [{ "label": "slice", "grams": 30.0 }, { "label": "bowl", "grams": 0.0 }] }),
            "Serving 2: grams must be more than 0",
        ),
        (
            "POST",
            "/api/foods",
            json!({ "name": "F", "barcode": "123" }),
            "Barcode must be 4–32 digits",
        ),
    ];
    for (method, uri, body, want) in cases {
        let (status, res) = call(&app, method, uri, Some(body)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{uri} -> {res}");
        assert!(
            res["error"].as_str().unwrap().contains(want),
            "{uri}: {res} lacks {want:?}"
        );
    }
}

#[tokio::test]
async fn duplicate_barcode_names_its_owner() {
    let app = app();
    let body = json!({ "name": "Rye Bread", "barcode": "6408430000258" });
    call(&app, "POST", "/api/foods", Some(body)).await;
    let (status, res) = call(
        &app,
        "POST",
        "/api/foods",
        Some(json!({ "name": "X", "barcode": "6408430000258" })),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert!(
        res["error"].as_str().unwrap().contains("Rye Bread"),
        "{res}"
    );
}

#[tokio::test]
async fn archived_foods_are_listed_on_request() {
    let app = app();
    let (_, food) = call(
        &app,
        "POST",
        "/api/foods",
        Some(json!({ "name": "Old Oats", "archived": true })),
    )
    .await;
    let (_, active) = search(&app, "q=Old").await;
    assert_eq!(active, json!([]));
    let (_, archived) = search(&app, "q=Old&archived=true").await;
    assert_eq!(archived[0]["id"], food["id"]);
}

#[tokio::test]
async fn created_entries_are_returned() {
    let app = app();
    let oats = create_food(&app, "Oats", json!({ "energy": 100.0 })).await;
    let entry = log_entry(&app, "Eaten", oats, 50.0).await;
    assert_eq!(entry["nutrients"]["energy"], 50.0);
    assert_eq!(entry["amount"], "50 g");
    assert_eq!(
        entry["source"], "custom",
        "entries name their food's database"
    );
}

#[tokio::test]
async fn barcode_lookup_is_post_only_and_guarded() {
    let hits = Arc::new(AtomicUsize::new(0));
    let counter = hits.clone();
    let stub = Router::new().route(
        "/api/v2/product/{file}",
        get(move || {
            counter.fetch_add(1, Ordering::SeqCst);
            async { axum::Json(json!({ "product": { "product_name": "Bread" } })) }
        }),
    );
    let app = app_with_stub(stub).await;

    // A cross-site page can make GETs; they must never call out or write.
    let (status, res) = call(&app, "GET", "/api/foods/barcode/6408430000258", None).await;
    assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED, "{res}");
    let (status, _) = raw(
        &app,
        "POST",
        "/api/foods/barcode/6408430000258",
        "text/plain",
        "",
    )
    .await;
    assert_eq!(
        status,
        StatusCode::UNSUPPORTED_MEDIA_TYPE,
        "lookup needs the JSON guard"
    );
    assert_eq!(hits.load(Ordering::SeqCst), 0);
    assert_only_seeded_foods(&app).await;
}

#[tokio::test]
async fn food_edit_updates_recipes_and_logged_history() {
    let app = app();
    let oats = create_food(&app, "Oats", json!({ "energy": 400.0 })).await;
    let (_, recipe) = call(
        &app,
        "POST",
        "/api/recipes",
        Some(json!({ "name": "Porridge", "items": [{ "food_id": oats, "grams": 100.0 }] })),
    )
    .await;
    log_entry(&app, "Eaten", oats, 100.0).await;

    let (status, food) = put_with_rev(
        &app,
        &format!("/api/foods/{oats}"),
        json!({ "name": "Oats", "per100": { "energy": 200.0 } }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(food["per100"]["energy"], 200.0);
    assert_eq!(food["entries_updated"], 1);
    let (_, got) = call(&app, "GET", &format!("/api/recipes/{}", recipe["id"]), None).await;
    assert_eq!(got["per100"]["energy"], 200.0);
    let (_, day) = call(&app, "GET", &format!("/api/profiles/1/day/{DAY}"), None).await;
    assert_eq!(day["total"]["energy"], 200.0, "the entry follows its food");
}

#[tokio::test]
async fn meal_crud() {
    let app = app();
    let egg = create_food(&app, "Egg", json!({})).await;
    let (status, meal) = call(
        &app,
        "POST",
        "/api/meals",
        Some(json!({ "name": "Breakfast", "items": [{ "food_id": egg, "grams": 60.0 }] })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let uri = format!("/api/meals/{}", meal["id"]);
    let (status, meal) = put_with_rev(
        &app,
        &uri,
        json!({ "name": "Big breakfast", "items": [{ "food_id": egg, "grams": 120.0 }] }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(meal["items"][0]["grams"], 120.0);
    assert_eq!(meal["items"][0]["name"], "Egg");
    let (_, list) = call(&app, "GET", "/api/meals", None).await;
    assert_eq!(list[0]["name"], "Big breakfast");
    assert_eq!(
        call(&app, "DELETE", &uri, None).await.0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        call(&app, "DELETE", &uri, None).await.0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(call(&app, "GET", &uri, None).await.0, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn entry_grams_edit_rescales_snapshot() {
    let app = app();
    let oats = create_food(&app, "Oats", json!({ "energy": 400.0 })).await;
    let entry = log_entry(&app, "Eaten", oats, 50.0).await;
    let uri = format!("/api/profiles/1/entries/{}", entry["id"]);
    let (status, entry) = call(&app, "PATCH", &uri, Some(json!({ "grams": 100.0 }))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(entry["nutrients"]["energy"], 400.0);
    assert_eq!(entry["amount"], "100 g");
}

#[tokio::test]
async fn recipe_cycle_is_rejected_over_http() {
    let app = app();
    let oats = create_food(&app, "Oats", json!({})).await;
    let (_, a) = call(
        &app,
        "POST",
        "/api/recipes",
        Some(json!({ "name": "A", "items": [{ "food_id": oats, "grams": 1.0 }] })),
    )
    .await;
    let (status, res) = put_with_rev(
        &app,
        &format!("/api/recipes/{}", a["id"]),
        json!({ "name": "A", "items": [{ "food_id": a["id"], "grams": 1.0 }] }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(
        res["error"]
            .as_str()
            .unwrap()
            .contains("cannot contain itself")
    );
}

#[tokio::test]
async fn unknown_ids_are_404() {
    let app = app();
    let oats = create_food(&app, "Oats", json!({})).await;
    let item = json!([{ "food_id": oats, "grams": 1.0 }]);
    let cases = [
        (
            "PUT",
            "/api/foods/999",
            json!({ "name": "X", "brand": null, "barcode": null, "per100": {}, "servings": [],
                    "archived": false, "category": null, "basis": null, "rev": 1 }),
        ),
        (
            "PUT",
            "/api/recipes/999",
            json!({ "name": "X", "cooked_g": null, "makes": null, "items": item, "servings": [],
                    "archived": false, "notes": null, "category": null, "rev": 1 }),
        ),
        (
            "PUT",
            "/api/meals/999",
            json!({ "name": "X", "items": item, "rev": 1 }),
        ),
        (
            "PATCH",
            "/api/profiles/1/entries/999",
            json!({ "group": "Eaten" }),
        ),
    ];
    for (method, uri, body) in cases {
        assert_eq!(
            call(&app, method, uri, Some(body)).await.0,
            StatusCode::NOT_FOUND,
            "{uri}"
        );
    }
    for uri in ["/api/foods/999", "/api/recipes/999", "/api/meals/999"] {
        assert_eq!(
            call(&app, "GET", uri, None).await.0,
            StatusCode::NOT_FOUND,
            "{uri}"
        );
    }
    // A plain food is not a recipe.
    let (status, _) = call(&app, "GET", &format!("/api/recipes/{oats}"), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn entry_uids_are_never_reused() {
    let app = app();
    let oats = create_food(&app, "Oats", json!({})).await;
    let first = log_entry(&app, "Eaten", oats, 1.0).await;
    let uid = first["uid"].as_str().expect("entry has a uid").to_owned();
    assert_eq!(uid.len(), 32);
    call(
        &app,
        "DELETE",
        &format!("/api/profiles/1/entries/{}", first["id"]),
        None,
    )
    .await;

    // Neither the id nor the uid is handed out again.
    let second = log_entry(&app, "Eaten", oats, 1.0).await;
    assert_ne!(second["id"], first["id"]);
    assert_ne!(second["uid"].as_str().unwrap(), uid);
}

#[tokio::test]
async fn duplicate_target_nutrient_is_400() {
    let app = app();
    let (status, res) = put_targets(
        &app,
        1,
        json!([{ "metric": "energy", "value": 2000.0 }, { "metric": "energy", "value": 2100.0 }]),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{res}");
    assert!(
        res["error"]
            .as_str()
            .unwrap()
            .contains("Energy: listed twice")
    );
}

#[tokio::test]
async fn food_put_keeps_own_barcode_and_rejects_anothers() {
    let app = app();
    let (_, a) = call(
        &app,
        "POST",
        "/api/foods",
        Some(json!({ "name": "Rye", "barcode": "6408430000258" })),
    )
    .await;
    let b = create_food(&app, "Oats", json!({})).await;

    let (status, renamed) = put_with_rev(
        &app,
        &format!("/api/foods/{}", a["id"]),
        json!({ "name": "Rye bread", "barcode": "6408430000258" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{renamed}");
    assert_eq!(renamed["name"], "Rye bread");

    let (status, res) = put_with_rev(
        &app,
        &format!("/api/foods/{b}"),
        json!({ "name": "Oats", "barcode": "6408430000258" }),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert!(
        res["error"].as_str().unwrap().contains("Rye bread"),
        "{res}"
    );
}

#[tokio::test]
async fn off_failures_map_to_404_or_502_and_cache_nothing() {
    let stub = Router::new().route(
        "/api/v2/product/{file}",
        get(|Path(file): Path<String>| async move {
            match file.trim_end_matches(".json") {
                "4000000000001" => StatusCode::SERVICE_UNAVAILABLE.into_response(),
                "4000000000002" => "not json".into_response(),
                "4000000000003" => axum::Json(json!({})).into_response(),
                _ => axum::Json(json!({ "product": { "product_name": "" } })).into_response(),
            }
        }),
    );
    let app = app_with_stub(stub).await;
    let cases = [
        ("4000000000001", StatusCode::BAD_GATEWAY),
        ("4000000000002", StatusCode::BAD_GATEWAY),
        ("4000000000003", StatusCode::NOT_FOUND),
        ("4000000000004", StatusCode::NOT_FOUND),
    ];
    for (code, want) in cases {
        let (status, res) = call(
            &app,
            "POST",
            &format!("/api/foods/barcode/{code}"),
            Some(json!({})),
        )
        .await;
        assert_eq!(status, want, "{code}: {res}");
        assert!(res["error"].is_string(), "{code}: {res}");
    }
    // Failed lookups cache nothing.
    assert_only_seeded_foods(&app).await;
}

/// A 36-year-old woman, whatever year the tests run in: iron and calcium
/// targets depend on age bands.
fn adult(name: &str) -> Value {
    let year: i32 = kaloriina::model::day_so_far().to_string()[..4]
        .parse()
        .unwrap();
    json!({
        "name": name, "sex": "female", "birth_date": format!("{}-05-01", year - 36),
        "height_cm": 170.0, "activity": 1.6, "goal_kg_per_week": 0.0,
        "goal_date": null, "latitude": null
    })
}

/// A new profile has no weigh-in, so no recommendation yet: it starts
/// with the registry defaults only; once weighed, its targets are
/// recommended.
#[tokio::test]
async fn a_new_profile_is_recommended_targets_once_weighed() {
    let app = app();
    let (status, p) = call(&app, "POST", "/api/profiles", Some(adult("Anna"))).await;
    assert_eq!(status, StatusCode::CREATED, "{p}");
    let pid = p["id"].as_i64().unwrap();
    let (_, targets) = call(&app, "GET", &format!("/api/profiles/{pid}/targets"), None).await;
    assert!(
        targets
            .as_array()
            .unwrap()
            .iter()
            .all(|t| t["default"] == true),
        "{targets}"
    );
    let rec = format!("/api/profiles/{pid}/recommended");
    let (status, err) = call(&app, "GET", &rec, None).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{err}");
    let weight = format!("/api/profiles/{pid}/weights/{DAY}");
    call(&app, "PUT", &weight, Some(json!({ "kg": 65.0 }))).await;
    let (_, rec) = call(&app, "GET", &rec, None).await;
    let iron = rec
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["metric"] == "iron")
        .unwrap();
    assert_eq!(iron["value"], 16.0, "premenopausal EFSA PRI");

    let (_, list) = call(&app, "GET", "/api/profiles", None).await;
    let names: Vec<_> = list
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["Me", "Anna"]);
}

#[tokio::test]
async fn profile_validation() {
    let app = app();
    let cases = [
        (adult("  "), "Name must be 1–50 characters"),
        (
            {
                let mut p = adult("Cy");
                p["weight_kg"] = json!(65.0);
                p
            },
            "no longer takes weight_kg",
        ),
        (
            {
                let mut p = adult("Di");
                p["birth_date"] = json!("2999-01-01");
                p
            },
            "Birth date must be a date in the past",
        ),
        (
            {
                let mut p = adult("Ed");
                p["goal_kg_per_week"] = json!(-3.0);
                p
            },
            "Weight goal (kg/week) must be -1–1",
        ),
        (
            {
                let mut p = adult("Fa");
                p["sex"] = json!("other");
                p
            },
            "",
        ),
    ];
    for (body, want) in cases {
        let (status, res) = call(&app, "POST", "/api/profiles", Some(body.clone())).await;
        assert!(status.is_client_error(), "{body} -> {status} {res}");
        assert!(
            res["error"].as_str().unwrap().contains(want),
            "{res} lacks {want:?}"
        );
    }
    call(&app, "POST", "/api/profiles", Some(adult("Gus"))).await;
    let (status, _) = call(&app, "POST", "/api/profiles", Some(adult("Gus"))).await;
    assert_eq!(status, StatusCode::CONFLICT, "names are unique");
}

#[tokio::test]
async fn me_can_be_filled_in_later_then_recalculated() {
    let app = app();
    let (status, res) = call(&app, "GET", "/api/profiles/1/recommended", None).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{res}");
    let (status, me) = put_with_rev(&app, "/api/profiles/1", adult("Me")).await;
    assert_eq!(status, StatusCode::OK, "{me}");
    // The profile's weight is the log's: saving it logged nothing.
    let (status, err) = call(&app, "GET", "/api/profiles/1/recommended", None).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{err}");
    let weight = format!("/api/profiles/1/weights/{DAY}");
    call(&app, "PUT", &weight, Some(json!({ "kg": 65.0 }))).await;
    // The energy target is the client's (ADR 0020); the fat target scales
    // with the energy it passes.
    let (status, rec) = call(&app, "GET", "/api/profiles/1/recommended?energy=2000", None).await;
    assert_eq!(status, StatusCode::OK);
    assert!(rec.as_array().unwrap().iter().any(|t| t["metric"] == "fat"));
}

#[tokio::test]
async fn profiles_are_isolated_and_deletable() {
    let app = app();
    let (_, other) = call(&app, "POST", "/api/profiles", Some(adult("Anna"))).await;
    let pid = other["id"].as_i64().unwrap();
    let oats = create_food(&app, "Oats", json!({ "energy": 100.0 })).await;
    let mine = log_entry(&app, "Eaten", oats, 100.0).await;

    // Anna doesn't see or touch Me's entries; foods are shared.
    let (_, day) = call(&app, "GET", &format!("/api/profiles/{pid}/day/{DAY}"), None).await;
    assert_eq!(day["total"], json!({}));
    let uri = format!("/api/profiles/{pid}/entries/{}", mine["id"]);
    assert_eq!(
        call(&app, "DELETE", &uri, None).await.0,
        StatusCode::NOT_FOUND
    );
    let (status, _) = call(
        &app,
        "POST",
        &format!("/api/profiles/{pid}/entries"),
        Some(json!({ "day": DAY, "group": "Eaten", "food_id": oats, "grams": 50.0 })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let (_, sum) = call(
        &app,
        "GET",
        &format!("/api/profiles/{pid}/summary?from={DAY}&to={DAY}"),
        None,
    )
    .await;
    assert_eq!(sum["days"][0]["total"]["energy"], 50.0);

    assert_eq!(
        call(&app, "DELETE", &format!("/api/profiles/{pid}"), None)
            .await
            .0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        call(&app, "GET", &format!("/api/profiles/{pid}/day/{DAY}"), None)
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    let (status, res) = call(&app, "DELETE", "/api/profiles/1", None).await;
    assert_eq!(status, StatusCode::CONFLICT, "{res}");
    let (_, day) = call(&app, "GET", &format!("/api/profiles/1/day/{DAY}"), None).await;
    assert_eq!(day["total"]["energy"], 100.0, "Me untouched");
}

#[tokio::test]
async fn planned_comes_before_consumed() {
    let app = app();
    let (_, day) = call(&app, "GET", &format!("/api/profiles/1/day/{DAY}"), None).await;
    let names: Vec<_> = day["groups"]
        .as_array()
        .unwrap()
        .iter()
        .map(|g| g["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["Planned", "Eaten"]);
}

/// An app with the Fineli fixture imported ("Maito, rasvaton" among its foods).
fn fineli_app() -> Router {
    let mut conn = open(FsPath::new(":memory:")).unwrap();
    let dir = FsPath::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fineli");
    kaloriina::fineli::store(&mut conn, &kaloriina::fineli::read(&dir).unwrap(), &[]).unwrap();
    app_from(conn, NO_OFF)
}

#[tokio::test]
async fn food_search_filters_by_database() {
    let app = fineli_app();
    create_food(&app, "Maito, oma", json!({ "energy": 50.0 })).await;
    let (_, all) = search(&app, "q=maito").await;
    assert_eq!(
        names(&all),
        ["Maito, oma", "Maito, rasvaton"],
        "all databases by default"
    );
    let (_, fineli) = search(&app, "q=maito&sources=fineli").await;
    assert_eq!(names(&fineli), ["Maito, rasvaton"]);
    let (_, mine) = search(&app, "q=maito&sources=custom,recipe").await;
    assert_eq!(names(&mine), ["Maito, oma"]);
    let (_, me) = call(&app, "GET", "/api/profiles/1", None).await;
    assert!(
        me.get("hidden_sources").is_none(),
        "database choice lives in the search"
    );
}

fn names(list: &Value) -> Vec<&str> {
    list.as_array()
        .unwrap()
        .iter()
        .map(|f| f["name"].as_str().unwrap())
        .collect()
}

#[tokio::test]
async fn food_search_filters_and_sorts_by_nutrients() {
    let app = app();
    create_food(
        &app,
        "Zq chicken",
        json!({ "energy": 400.0, "protein": 30.0 }),
    )
    .await;
    create_food(&app, "Zq broth", json!({ "energy": 50.0, "protein": 5.0 })).await;
    create_food(&app, "Zq water", json!({})).await;
    let zq = |query: &str| {
        let app = app.clone();
        let query = format!("q=zq&{query}");
        async move { search(&app, &query).await }
    };

    let (_, rich) = zq("min=protein:20").await;
    assert_eq!(names(&rich), ["Zq chicken"]);
    let (_, light) = zq("max=energy:100").await;
    assert_eq!(names(&light), ["Zq broth"], "unknown values fail the rule");
    let (_, both) = zq("min=protein:1,energy:1&max=energy:500").await;
    assert_eq!(names(&both).len(), 2);
    let (_, by_protein) = zq("sort=protein").await;
    assert_eq!(
        names(&by_protein),
        ["Zq chicken", "Zq broth", "Zq water"],
        "missing last"
    );
    let (_, by_energy) = zq("sort=energy").await;
    assert_eq!(names(&by_energy), ["Zq broth", "Zq chicken", "Zq water"]);
    let (_, lean) = zq("sort=protein_per_kcal").await;
    assert_eq!(
        names(&lean)[0],
        "Zq broth",
        "5 g / 50 kcal beats 30 g / 400 kcal"
    );
    let (_, by_name) = zq("sort=name").await;
    assert_eq!(names(&by_name), ["Zq broth", "Zq chicken", "Zq water"]);

    for (bad, word) in [
        ("min=nope:1", "nope"),
        ("min=protein:lots", "lots"),
        ("min=protein", "protein"),
        ("sources=elsewhere", "elsewhere"),
        ("sort=random", "random"),
    ] {
        let (status, err) = zq(bad).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{bad}: {err}");
        assert!(
            err["error"].as_str().unwrap().contains(word),
            "{bad}: {err}"
        );
    }
}

#[tokio::test]
async fn best_match_puts_names_starting_with_the_query_first() {
    let app = app();
    create_food(&app, "Oat milk", json!({})).await;
    create_food(&app, "Milk, skimmed", json!({})).await;
    create_food(&app, "Äyriäiset", json!({})).await;
    let (_, milk) = search(&app, "q=milk").await;
    assert_eq!(names(&milk), ["Milk, skimmed", "Oat milk"]);
    let (_, words) = search(&app, "q=skimmed+milk").await;
    assert_eq!(names(&words), ["Milk, skimmed"], "every word, any order");
    let (_, branded) = search(&app, "q=milk+nobrand").await;
    assert_eq!(
        names(&branded),
        Vec::<&str>::new(),
        "a food without a brand still needs every word"
    );
    let (_, shellfish) = search(&app, "q=%C3%A4yri").await;
    assert_eq!(names(&shellfish), ["Äyriäiset"], "Unicode case folding");
}

#[tokio::test]
async fn recent_foods_are_per_profile() {
    let app = app();
    let oats = create_food(&app, "Oats", json!({ "energy": 380.0 })).await;
    let tea = create_food(&app, "Tea", json!({})).await;
    log_entry(&app, "Eaten", oats, 50.0).await;
    log_entry(&app, "Eaten", tea, 200.0).await;
    log_entry(&app, "Eaten", oats, 60.0).await;
    let (_, recent) = call(&app, "GET", "/api/profiles/1/foods/recent", None).await;
    assert_eq!(
        names(&recent),
        ["Oats", "Tea"],
        "most recent first, once each"
    );
    let (_, anna) = call(&app, "POST", "/api/profiles", Some(adult("Anna"))).await;
    let uri = format!("/api/profiles/{}/foods/recent", anna["id"]);
    let (_, hers) = call(&app, "GET", &uri, None).await;
    assert_eq!(hers, json!([]));
    let (status, _) = call(&app, "GET", "/api/profiles/99/foods/recent", None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn favorites_are_per_profile() {
    let app = app();
    let oats = create_food(&app, "Oats", json!({ "energy": 380.0 })).await;
    let (_, anna) = call(&app, "POST", "/api/profiles", Some(adult("Anna"))).await;
    let anna = anna["id"].as_i64().unwrap();
    let favorites = |pid: i64| format!("/api/profiles/{pid}/foods/favorites");

    let (status, _) = call(
        &app,
        "POST",
        &favorites(1),
        Some(json!({ "food_id": oats })),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    // Starring twice is harmless.
    let (status, _) = call(
        &app,
        "POST",
        &favorites(1),
        Some(json!({ "food_id": oats })),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (_, mine) = call(&app, "GET", &favorites(1), None).await;
    assert_eq!(mine.as_array().unwrap().len(), 1);
    assert_eq!(mine[0]["name"], "Oats");
    let (_, hers) = call(&app, "GET", &favorites(anna), None).await;
    assert_eq!(hers, json!([]), "favorites belong to one profile");

    let (status, _) = call(&app, "POST", &favorites(1), Some(json!({ "food_id": 999 }))).await;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "an unknown food in the body is bad input"
    );
    let (status, _) = call(&app, "GET", &favorites(99), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "unknown profile");

    let uri = format!("{}/{oats}", favorites(1));
    let (status, _) = call(&app, "DELETE", &uri, None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, _) = call(&app, "DELETE", &uri, None).await;
    assert_eq!(status, StatusCode::NO_CONTENT, "unstarring is idempotent");
    let (_, mine) = call(&app, "GET", &favorites(1), None).await;
    assert_eq!(mine, json!([]));
}

/// Imported rows (Rye, Soup in Consumed; total 500) plus a Planned total of
/// 100 with no rows, as a diary export can have.
fn imported_day_app() -> Router {
    let mut conn = open(FsPath::new(":memory:")).unwrap();
    let servings = "Day,Group,Food Name,Amount\n\
                    2026-06-02,Consumed,Rye,1 slice\n2026-06-02,Consumed,Soup,1 bowl\n";
    common::import_servings(&mut conn, ME, servings.as_bytes()).unwrap();
    let summary = "Date,Group,Energy (kcal),Completed\n\
                   2026-06-02,Consumed,500,true\n2026-06-02,Remaining,100,true\n";
    common::import_summary(&mut conn, ME, summary.as_bytes()).unwrap();
    app_from(conn, NO_OFF)
}

#[tokio::test]
async fn imported_moves_are_reversible() {
    // An imported group's total shows under the group all its rows share;
    // while they are split it stays put. Every move can be undone exactly.
    let app = imported_day_app();
    let day = "/api/profiles/1/day/2026-06-02";
    let energy = |d: &Value, g: &str| group(d, g)["totals"]["energy"].as_f64();
    let (_, before) = call(&app, "GET", day, None).await;
    let ids: Vec<_> = group(&before, "Eaten")["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["id"].clone())
        .collect();
    let to = |g: &str| json!({ "group": g });
    let entry = |i: usize| format!("/api/profiles/1/entries/{}", ids[i]);

    call(&app, "PATCH", &entry(0), Some(to("Planned"))).await;
    let (_, split) = call(&app, "GET", day, None).await;
    assert_eq!(
        energy(&split, "Eaten"),
        Some(500.0),
        "split rows keep the total"
    );
    assert_eq!(energy(&split, "Planned"), Some(100.0));

    call(&app, "PATCH", &entry(1), Some(to("Planned"))).await;
    let (_, moved) = call(&app, "GET", day, None).await;
    assert_eq!(
        energy(&moved, "Planned"),
        Some(600.0),
        "all rows moved: total follows"
    );
    assert_eq!(energy(&moved, "Eaten"), None);

    call(&app, "PATCH", &entry(1), Some(to("Eaten"))).await;
    call(&app, "PATCH", &entry(0), Some(to("Eaten"))).await;
    let (_, back) = call(&app, "GET", day, None).await;
    assert_eq!(energy(&back, "Eaten"), Some(500.0), "back where it started");
    assert_eq!(energy(&back, "Planned"), Some(100.0));
    assert_eq!(back["total"], before["total"]);
}

#[tokio::test]
async fn whole_group_move_route_is_gone() {
    let app = imported_day_app();
    let (status, _) = call(
        &app,
        "POST",
        "/api/profiles/1/day/2026-06-02/move",
        Some(json!({ "from": "Eaten", "to": "Planned" })),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::NOT_FOUND,
        "single-row moves replaced it"
    );
}

#[tokio::test]
async fn summary_counts_eaten_food_only() {
    let app = app();
    let oats = create_food(&app, "Oats", json!({ "energy": 100.0 })).await;
    log_entry_on(&app, "2026-03-02", "Planned", oats, 400.0).await;
    log_entry_on(&app, "2026-03-03", "Eaten", oats, 300.0).await;
    log_entry_on(&app, "2026-03-03", "Planned", oats, 200.0).await;
    let (_, s) = call(
        &app,
        "GET",
        "/api/profiles/1/summary?from=2026-03-02&to=2026-03-08",
        None,
    )
    .await;
    assert_eq!(
        s["days"],
        json!([{ "day": "2026-03-03", "total": { "energy": 300.0 }, "known": { "dry": 300.0 } }]),
        "a day with only planned food isn't logged; planned food isn't eaten"
    );
}

#[tokio::test]
async fn errors_carry_a_code_and_name_what_is_missing() {
    let app = app();
    let oats = create_food(&app, "Oats", json!({})).await;
    let cases = [
        (
            "GET",
            "/api/foods/999999".to_owned(),
            None,
            404,
            "not_found",
            "Food 999999 not found",
        ),
        (
            "GET",
            "/api/profiles/77/day/2026-01-01".to_owned(),
            None,
            404,
            "not_found",
            "Profile 77 not found",
        ),
        (
            "GET",
            "/api/nope".to_owned(),
            None,
            404,
            "not_found",
            "Route not found",
        ),
        (
            "POST",
            "/api/profiles/1/foods/favorites".to_owned(),
            Some(json!({ "food_id": 999_999 })),
            400,
            "invalid",
            "Unknown food 999999",
        ),
        (
            "DELETE",
            "/api/profiles/1".to_owned(),
            None,
            409,
            "last_profile",
            "last profile",
        ),
        (
            "POST",
            "/api/foods".to_owned(),
            Some(json!({ "name": "y", "barcode": "12345678" })),
            409,
            "barcode_taken",
            "Oats",
        ),
    ];
    // Oats owns the barcode the last case tries to reuse.
    put_with_rev(
        &app,
        &format!("/api/foods/{oats}"),
        json!({ "name": "Oats", "barcode": "12345678" }),
    )
    .await;
    for (method, uri, body, status, code, text) in cases {
        let (got, res) = call(&app, method, &uri, body).await;
        assert_eq!(got.as_u16(), status, "{method} {uri}: {res}");
        assert_eq!(res["code"], code, "{method} {uri}: {res}");
        assert!(
            res["error"].as_str().unwrap().contains(text),
            "{method} {uri}: {res}"
        );
    }
    let (status, res) = raw(&app, "POST", "/api/foods", "text/plain", "{}").await;
    assert_eq!(status, StatusCode::UNSUPPORTED_MEDIA_TYPE);
    assert_eq!(res["code"], "unsupported_media_type", "{res}");
}

#[tokio::test]
async fn api_contract_edges() {
    let app = app();
    // A partial profile PUT is refused instead of wiping measurements.
    let (status, res) = call(
        &app,
        "PUT",
        "/api/profiles/1",
        Some(json!({ "name": "Me" })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{res}");

    // Recipes change only through /api/recipes.
    let oats = create_food(&app, "Oats", json!({ "energy": 380.0 })).await;
    let (_, recipe) = call(
        &app,
        "POST",
        "/api/recipes",
        Some(json!({ "name": "Porridge", "items": [{ "food_id": oats, "grams": 50.0 }] })),
    )
    .await;
    let uri = format!("/api/foods/{}", recipe["id"]);
    let (status, res) = put_with_rev(
        &app,
        &uri,
        json!({ "name": "Renamed", "servings": [], "basis": null }),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{res}");

    // A nutrient may appear once per rule list.
    let (status, res) = search(&app, "q=&min=energy:1,energy:500").await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{res}");
    assert!(res["error"].as_str().unwrap().contains("Energy"), "{res}");

    // Dates are real calendar dates.
    let (status, _) = call(&app, "GET", "/api/profiles/1/day/2026-02-30", None).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = call(&app, "GET", "/api/profiles/1/day/2028-02-29", None).await;
    assert_eq!(status, StatusCode::OK, "leap day");

    // Unknown sorts and databases name the valid ones.
    let (_, res) = search(&app, "sort=random").await;
    assert!(
        res["error"].as_str().unwrap().contains("protein_per_kcal"),
        "{res}"
    );
    let (_, res) = search(&app, "sources=elsewhere").await;
    assert!(res["error"].as_str().unwrap().contains("fineli"), "{res}");
}

#[tokio::test]
async fn search_recency_is_per_profile() {
    let app = app();
    let apple = create_food(&app, "Zz apple", json!({})).await;
    let banana = create_food(&app, "Zz banana", json!({})).await;
    let (_, anna) = call(&app, "POST", "/api/profiles", Some(adult("Anna"))).await;
    let anna = anna["id"].as_i64().unwrap();
    call(
        &app,
        "POST",
        &format!("/api/profiles/{anna}/entries"),
        Some(json!({ "day": DAY, "group": "Eaten", "food_id": banana, "grams": 10.0 })),
    )
    .await;
    let (_, mine) = search(&app, "q=zz").await;
    assert_eq!(
        names(&mine),
        ["Zz apple", "Zz banana"],
        "Anna's logging doesn't reorder mine"
    );
    log_entry(&app, "Eaten", apple, 10.0).await;
    log_entry(&app, "Eaten", banana, 10.0).await;
    let (_, mine) = search(&app, "q=zz").await;
    assert_eq!(names(&mine), ["Zz banana", "Zz apple"], "my recent first");
}

/// GET \`uri\` with a \`Host\` header, as a browser sends it.
async fn get_as_host(app: &Router, uri: &str, host: &str) -> (StatusCode, Value) {
    let req = Request::builder()
        .uri(uri)
        .header(header::HOST, host)
        .body(Body::empty())
        .unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    let status = res.status();
    let bytes = http_body_util::BodyExt::collect(res.into_body())
        .await
        .unwrap()
        .to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

#[tokio::test]
async fn only_known_host_names_are_served() {
    // DNS rebinding: a page on evil.example re-resolved to 127.0.0.1 is
    // same-origin with the app, but its requests still say Host: evil.example.
    let mut state = kaloriina::AppState::new(open(FsPath::new(":memory:")).unwrap(), NO_OFF.into());
    state.allowed_hosts = vec!["kaloriina.tail1234.ts.net".into()];
    let app = kaloriina::router(state);
    for host in [
        "localhost:8080",
        "127.0.0.1",
        "[::1]:8080",
        "kaloriina.tail1234.ts.net",
        "KALORIINA.tail1234.ts.net:443",
    ] {
        let (status, res) = get_as_host(&app, "/api/profiles", host).await;
        assert_eq!(status, StatusCode::OK, "{host}: {res}");
    }
    for host in [
        "evil.example",
        "evil.example:8080",
        "127.0.0.1.evil.example",
    ] {
        let (status, res) = get_as_host(&app, "/api/profiles", host).await;
        assert_eq!(status, StatusCode::MISDIRECTED_REQUEST, "{host}: {res}");
        assert_eq!(res["code"], "bad_host");
        let (status, _) = get_as_host(&app, "/", host).await;
        assert_eq!(
            status,
            StatusCode::MISDIRECTED_REQUEST,
            "{host}: the page too"
        );
    }
}

#[tokio::test]
async fn huge_searches_are_refused() {
    // Every word is matched against every food under the database lock.
    let app = app();
    let words = ["a"; 9].join("+");
    let (status, res) = search(&app, &format!("q={words}")).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{res}");
    let long = "a".repeat(201);
    let (status, _) = search(&app, &format!("q={long}")).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = search(&app, "q=a+b+c+d+e+f+g+h").await;
    assert_eq!(status, StatusCode::OK, "eight words are fine");
}

#[tokio::test]
async fn pages_carry_the_security_headers() {
    let app = app();
    for uri in ["/", "/main.mjs", "/screens/diary.mjs"] {
        let req = Request::builder().uri(uri).body(Body::empty()).unwrap();
        let res = app.clone().oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK, "{uri}");
        let h = |name| {
            res.headers()
                .get(name)
                .unwrap()
                .to_str()
                .unwrap()
                .to_owned()
        };
        assert_eq!(
            h(header::CONTENT_SECURITY_POLICY),
            "default-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
            "{uri}"
        );
        assert_eq!(h(header::X_CONTENT_TYPE_OPTIONS), "nosniff", "{uri}");
    }
    // JSON too, errors included.
    for uri in ["/api/meta", "/api/nope"] {
        let req = Request::builder().uri(uri).body(Body::empty()).unwrap();
        let res = app.clone().oneshot(req).await.unwrap();
        assert_eq!(
            res.headers()[header::X_CONTENT_TYPE_OPTIONS],
            "nosniff",
            "{uri}"
        );
    }
}

#[tokio::test]
async fn assets_revalidate_instead_of_downloading_again() {
    let app = app();
    let req = Request::builder()
        .uri("/main.mjs")
        .body(Body::empty())
        .unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    assert_eq!(res.headers()[header::CACHE_CONTROL], "no-cache");
    let etag = res.headers()[header::ETAG].clone();
    let req = Request::builder()
        .uri("/main.mjs")
        .header(header::IF_NONE_MATCH, etag)
        .body(Body::empty())
        .unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::NOT_MODIFIED);
}

#[tokio::test]
async fn archived_foods_leave_recent_but_stay_favourites() {
    let app = app();
    let oats = create_food(&app, "Oats", json!({})).await;
    log_entry(&app, "Eaten", oats, 50.0).await;
    call(
        &app,
        "POST",
        "/api/profiles/1/foods/favorites",
        Some(json!({ "food_id": oats })),
    )
    .await;
    let (status, _) = put_with_rev(
        &app,
        &format!("/api/foods/{oats}"),
        json!({ "name": "Oats", "archived": true }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (_, recent) = call(&app, "GET", "/api/profiles/1/foods/recent", None).await;
    assert_eq!(recent, json!([]), "archived foods leave the recent list");
    let (_, favourites) = call(&app, "GET", "/api/profiles/1/foods/favorites", None).await;
    assert_eq!(names(&favourites), ["Oats"], "a starred food stays starred");
}

#[tokio::test]
async fn nutrients_contract() {
    // What the web app and the Android client read from /api/meta.
    let (_, meta) = call(&app(), "GET", "/api/meta", None).await;
    let list = meta["nutrients"].as_array().unwrap();
    assert_eq!(list.len(), 63);
    let mut keys: Vec<_> = list.iter().map(|n| n["key"].as_str().unwrap()).collect();
    keys.sort_unstable();
    keys.dedup();
    assert_eq!(keys.len(), 63, "keys are unique");
    for n in list {
        for field in ["key", "label", "unit", "goal", "category"] {
            assert!(n[field].is_string(), "{n} lacks {field}");
        }
        assert!(n["display"]["factor"].is_number(), "{n} lacks display");
        for field in ["derived", "ai"] {
            assert!(n[field].is_boolean(), "{n} lacks {field}");
        }
    }
    let energy = list.iter().find(|n| n["key"] == "energy").unwrap();
    assert_eq!(energy["unit"], "kcal");
    assert_eq!(energy["goal"], "about");
    assert_eq!(energy["category"], "General");
    let creatine = list.iter().find(|n| n["key"] == "creatine").unwrap();
    assert_eq!(creatine["label"], "Creatine");
    assert_eq!(creatine["unit"], "g");
    assert_eq!(creatine["goal"], "at_least");
    assert_eq!(creatine["category"], "General");
}

#[tokio::test]
async fn meta_serves_the_reference_data() {
    let app = app();
    let (status, meta) = call(&app, "GET", "/api/meta", None).await;
    assert_eq!(status, StatusCode::OK, "{meta}");
    assert_eq!(meta["groups"], json!(["Planned", "Eaten"]));
    let sodium = meta["nutrients"]
        .as_array()
        .unwrap()
        .iter()
        .find(|n| n["key"] == "sodium")
        .unwrap();
    assert_eq!(
        sodium["display"],
        json!({ "label": "Salt", "short": "Salt", "unit": "g", "factor": 0.0025 })
    );
    // The US label: sodium in mg, vitamin D in µg, %DV from the FDA's
    // Daily Values in the stored unit (vitamin D 20 µg = 800 IU).
    assert_eq!(
        sodium["display_us"],
        json!({ "label": "Sodium", "short": "Sodium", "unit": "mg", "factor": 1.0 })
    );
    let nutrient = |key: &str| {
        meta["nutrients"]
            .as_array()
            .unwrap()
            .iter()
            .find(|n| n["key"] == key)
            .unwrap()
            .clone()
    };
    assert_eq!(sodium["dv"], 2300.0);
    assert_eq!(nutrient("vitamin_d")["dv"], 800.0);
    assert_eq!(
        nutrient("vitamin_d")["display_us"],
        json!({ "label": "Vitamin D", "short": "Vitamin D", "unit": "µg", "factor": 0.025 })
    );
    assert_eq!(nutrient("carbs")["dv"], 275.0);
    assert_eq!(
        nutrient("net_carbs")["dv"],
        Value::Null,
        "the DV is total carbs'"
    );
    assert_eq!(nutrient("energy")["dv"], Value::Null);
    assert_eq!(nutrient("net_carbs")["display_us"]["label"], "Net carbs");
    let laterality = meta["exercise_traits"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["key"] == "laterality")
        .unwrap();
    assert!(laterality["value_labels"].is_array(), "{laterality}");
    assert_eq!(meta["limits"]["items"], 200);
    let limits = &meta["limits"];
    assert_eq!(limits["body_kg"], json!([30.0, 300.0]));
    assert_eq!(limits["height_cm"], json!([100.0, 250.0]));
    assert_eq!(limits["activity"], json!([1.2, 2.5]));
    assert_eq!(limits["goal_kg_per_week"], json!([-1.0, 1.0]));
    assert_eq!(limits["portions"], 100.0);
    assert_eq!(limits["barcode_digits"], json!([4, 32]));
    assert_eq!(limits["uid"], json!([8, 64]));
    assert_eq!(limits["note"], 500);
    assert_eq!(limits["makes"], 100);
    assert_eq!(limits["measure_cm"], json!([20.0, 300.0]));
    assert_eq!(limits["plan_days_ahead"], 366);
    // What it replaced is gone.
    for uri in ["/api/nutrients", "/api/exercise-vocabulary"] {
        let (status, err) = call(&app, "GET", uri, None).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{uri}");
        assert_eq!(err["code"], "not_found");
    }
}

/// Create an exercise of your own and return its id.
async fn exercise(app: &Router, name: &str, measure: &str) -> i64 {
    let (status, e) = call(
        app,
        "POST",
        "/api/exercises",
        Some(json!({ "name": name, "measure": measure })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{e}");
    e["id"].as_i64().unwrap()
}

/// A base-set exercise's id, by name.
async fn base(app: &Router, name: &str) -> i64 {
    let (_, list) = call(app, "GET", "/api/exercises", None).await;
    list.as_array()
        .unwrap()
        .iter()
        .find(|e| e["name"] == name)
        .unwrap_or_else(|| panic!("{name} in the base set"))["id"]
        .as_i64()
        .unwrap()
}

#[tokio::test]
async fn a_base_set_of_exercises_comes_built_in() {
    let app = app();
    let (_, list) = call(&app, "GET", "/api/exercises", None).await;
    let list = list.as_array().unwrap();
    assert!(list.len() > 100, "{}", list.len());
    let find = |name: &str| list.iter().find(|e| e["name"] == name).unwrap();
    assert_eq!(find("Pull-up")["measure"], "reps");
    assert_eq!(find("Pull-up")["source"], "base");
    assert_eq!(find("Low plank")["measure"], "time");
    assert_eq!(find("Back squat")["measure"], "reps");
}

#[tokio::test]
async fn exercises_are_kept_with_unique_names() {
    let app = app();
    let id = exercise(&app, "Towel pull-up", "reps").await;
    let (_, made) = call(&app, "GET", &format!("/api/exercises/{id}"), None).await;
    assert_eq!(made["source"], "custom");
    for name in ["towel PULL-UP", "pull-up"] {
        let (status, err) = call(
            &app,
            "POST",
            "/api/exercises",
            Some(json!({ "name": name, "measure": "reps" })),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT, "{name}");
        assert_eq!(err["code"], "name_taken");
    }
    let (status, renamed) = put_with_rev(
        &app,
        &format!("/api/exercises/{id}"),
        json!({ "name": "Towel chin-up", "measure": "reps" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{renamed}");
    assert_eq!(renamed["name"], "Towel chin-up");

    let (status, _) = call(&app, "DELETE", &format!("/api/exercises/{id}"), None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, err) = call(&app, "GET", &format!("/api/exercises/{id}"), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(err["error"], format!("Exercise {id} not found"));
}

#[tokio::test]
async fn workouts_are_saved_edited_and_removed() {
    let app = app();
    let pull = base(&app, "Pull-up").await;
    let split = base(&app, "Bulgarian split squat").await;
    let plank = base(&app, "Low plank").await;
    let workout = |times: u32| {
        json!({ "name": "Upper", "minutes": 40, "kcal": 250, "steps": [
            { "kind": "repeat", "name": "main", "times": times, "steps": [
                { "kind": "exercise", "exercise_id": pull, "reps": 3 },
                { "kind": "rest", "seconds": 60 },
                { "kind": "note", "name": "Form", "text": "Grip wide.\nSlow on the way down." },
                { "kind": "exercise", "exercise_id": split, "reps": 10,
                  "kg": 12.5, "side": "left" },
            ]},
            { "kind": "exercise", "exercise_id": plank, "seconds": 45 },
        ]})
    };
    let (status, created) = call(&app, "POST", "/api/workouts", Some(workout(2))).await;
    assert_eq!(status, StatusCode::CREATED, "{created}");
    assert_eq!(created["steps"], workout(2)["steps"]);
    assert_eq!(created["minutes"], 40);
    assert_eq!(created["kcal"], 250);
    let id = created["id"].as_i64().unwrap();

    let mut edited = workout(3);
    edited["minutes"] = Value::Null;
    edited["kcal"] = Value::Null;
    let (status, put) = put_with_rev(&app, &format!("/api/workouts/{id}"), edited).await;
    assert_eq!(status, StatusCode::OK, "{put}");
    assert_eq!(put["steps"][0]["times"], 3);
    assert_eq!(put["minutes"], Value::Null);
    assert_eq!(put["kcal"], Value::Null);
    let (_, list) = call(&app, "GET", "/api/workouts", None).await;
    assert_eq!(list[0], put);

    let (status, _) = call(&app, "DELETE", &format!("/api/workouts/{id}"), None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, err) = call(&app, "GET", &format!("/api/workouts/{id}"), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(err["error"], format!("Workout {id} not found"));
}

#[tokio::test]
async fn workout_steps_are_validated_with_their_position() {
    let app = app();
    let pull = base(&app, "Pull-up").await;
    let plank = base(&app, "Low plank").await;
    let cases = [
        (json!([]), "A workout needs at least one step"),
        (
            json!([{ "kind": "rest", "seconds": 0 }]),
            "Step 1: seconds must be 1–3600",
        ),
        (
            json!([{ "kind": "repeat", "times": 2, "steps": [
                { "kind": "exercise", "exercise_id": pull, "reps": 5, "seconds": 30 }]}]),
            "Step 1.1: give reps or seconds, not both",
        ),
        (
            json!([{ "kind": "exercise", "exercise_id": pull }]),
            "Step 1: give reps or seconds",
        ),
        (
            json!([{ "kind": "repeat", "times": 0, "steps": [{ "kind": "rest", "seconds": 5 }] }]),
            "Step 1: times must be 1–99",
        ),
        (
            json!([{ "kind": "repeat", "times": 2, "steps": [] }]),
            "Step 1: a repeat needs at least one step",
        ),
        (
            json!([{ "kind": "rest", "seconds": 5 },
                   { "kind": "exercise", "exercise_id": 9999, "reps": 3 }]),
            "Step 2: unknown exercise 9999",
        ),
        (
            json!([{ "kind": "exercise", "exercise_id": pull, "seconds": 30 }]),
            "Step 1: Pull-up is done for reps",
        ),
        (
            json!([{ "kind": "exercise", "exercise_id": plank, "reps": 3 }]),
            "Step 1: Low plank is done for a time",
        ),
        (
            json!([{ "kind": "exercise", "exercise_id": pull, "reps": 3, "kg": 0 }]),
            "Step 1: kg must be more than 0 and at most 500",
        ),
        (
            json!([{ "kind": "exercise", "exercise_id": base(&app, "Burpee").await,
                     "reps": 10, "kg": 5 }]),
            "Step 1: Burpee takes no weight",
        ),
        (
            json!([{ "kind": "exercise", "exercise_id": base(&app, "Bench press").await,
                     "reps": 5 }]),
            "Step 1: Bench press needs a weight (kg)",
        ),
        (
            json!([{ "kind": "rest", "seconds": 5 }, { "kind": "note", "name": " ", "text": " \n " }]),
            "Step 2: a note needs a name or text",
        ),
        (
            json!([{ "kind": "repeat", "times": 2, "steps": [
                { "kind": "rest", "seconds": 5 },
                { "kind": "note", "text": "a".repeat(10_001) }] }]),
            "Step 1.2: note must be at most 10000 characters",
        ),
        (
            json!([{ "kind": "rest", "seconds": 5 },
                   { "kind": "note", "name": "a".repeat(51), "text": "Hm" }]),
            "Step 2: note name must be 1–50 characters",
        ),
        (
            json!([{ "kind": "note", "text": "Only words" }]),
            "A workout needs at least one step besides notes",
        ),
        (
            json!([{ "kind": "rest", "seconds": 5 },
                   { "kind": "repeat", "times": 2, "steps": [{ "kind": "note", "text": "Hm" }] }]),
            "Step 2: a repeat needs at least one step besides notes",
        ),
    ];
    for (steps, message) in cases {
        let (status, err) = call(
            &app,
            "POST",
            "/api/workouts",
            Some(json!({ "name": "W", "steps": steps })),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{steps}");
        assert_eq!(err["error"], message, "{steps}");
    }
}

// A name alone is a note: the name says it, a blank text is none.
#[tokio::test]
async fn a_named_note_needs_no_text() {
    let app = app();
    let rest = json!({ "kind": "rest", "seconds": 5 });
    for note in [
        json!({ "kind": "note", "name": "Breathe out" }),
        json!({ "kind": "note", "name": "Breathe out", "text": " \n " }),
    ] {
        let (status, made) = call(
            &app,
            "POST",
            "/api/workouts",
            Some(json!({ "name": "W", "steps": [rest, note] })),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "{made}");
        assert_eq!(
            made["steps"][1],
            json!({ "kind": "note", "name": "Breathe out" })
        );
    }
    let (status, err) = call(
        &app,
        "POST",
        "/api/workouts",
        Some(json!({ "name": "W", "steps": [rest, { "kind": "note" }] })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{err}");
    assert_eq!(err["error"], "Step 2: a note needs a name or text");
}

#[tokio::test]
async fn workout_totals_and_nesting_are_bounded() {
    let app = app();
    let (status, err) = call(
        &app,
        "POST",
        "/api/workouts",
        Some(json!({ "name": "W", "minutes": 0,
                     "steps": [{ "kind": "rest", "seconds": 5 }] })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(err["error"], "Minutes must be 1–600");
    assert_eq!(err["field"], "minutes");
    let (status, err) = call(
        &app,
        "POST",
        "/api/workouts",
        Some(json!({ "name": "W", "kcal": 0,
                     "steps": [{ "kind": "rest", "seconds": 5 }] })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(err["error"], "Kcal must be 1–5000");
    assert_eq!(err["field"], "kcal");
    // Five repeats deep is too deep.
    let mut steps = json!([{ "kind": "rest", "seconds": 5 }]);
    for _ in 0..5 {
        steps = json!([{ "kind": "repeat", "times": 2, "steps": steps }]);
    }
    let (status, err) = call(
        &app,
        "POST",
        "/api/workouts",
        Some(json!({ "name": "W", "steps": steps })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(err["error"], "Step 1.1.1.1.1: repeats nest at most 4 deep");
}

#[tokio::test]
async fn exercises_in_use_keep_their_kind_and_stay() {
    let app = app();
    let towel = exercise(&app, "Towel pull-up", "reps").await;
    let (_, w) = call(
        &app,
        "POST",
        "/api/workouts",
        Some(json!({ "name": "Upper", "steps": [
            { "kind": "repeat", "times": 2, "steps": [
                { "kind": "exercise", "exercise_id": towel, "reps": 3 }]}]})),
    )
    .await;

    let (status, err) = call(&app, "DELETE", &format!("/api/exercises/{towel}"), None).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(err["code"], "exercise_in_use");
    assert_eq!(err["error"], "Towel pull-up is used by Upper");

    let uri = format!("/api/exercises/{towel}");
    let (status, err) = put_with_rev(
        &app,
        &uri,
        json!({ "name": "Towel pull-up", "measure": "time" }),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(err["code"], "exercise_in_use");

    // Renaming is fine, and once the workout is gone so is the exercise.
    let (status, _) = put_with_rev(
        &app,
        &uri,
        json!({ "name": "Towel chin-up", "measure": "reps" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    call(&app, "DELETE", &format!("/api/workouts/{}", w["id"]), None).await;
    let (status, _) = call(&app, "DELETE", &format!("/api/exercises/{towel}"), None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn exercises_carry_traits_and_the_base_set_is_read_only() {
    let app = app();
    let pull = base(&app, "Pull-up").await;
    let (_, e) = call(&app, "GET", &format!("/api/exercises/{pull}"), None).await;
    assert_eq!(e["pattern"], "vertical pull");
    assert!(
        e["equipment"]
            .as_array()
            .unwrap()
            .contains(&json!("pull-up bar"))
    );
    for (method, body) in [("PUT", Some(e.clone())), ("DELETE", None)] {
        let (status, err) = call(&app, method, &format!("/api/exercises/{pull}"), body).await;
        assert_eq!(status, StatusCode::CONFLICT, "{method}");
        assert_eq!(err["code"], "base_read_only");
    }

    let mine = json!({ "name": "Towel row", "measure": "reps",
        "equipment": ["bodyweight"], "pattern": "horizontal pull", "region": "upper body",
        "group": "back", "primary": ["latissimus dorsi"], "secondary": ["biceps"],
        "mechanics": "compound", "laterality": "bilateral", "difficulty": "beginner",
        "variant_of": base(&app, "Inverted row").await });
    let (status, made) = call(&app, "POST", "/api/exercises", Some(mine.clone())).await;
    assert_eq!(status, StatusCode::CREATED, "{made}");
    for key in [
        "equipment",
        "pattern",
        "primary",
        "variant_of",
        "difficulty",
    ] {
        assert_eq!(made[key], mine[key], "{key}");
    }
    let (status, err) = call(
        &app,
        "POST",
        "/api/exercises",
        Some(json!({ "name": "Odd", "measure": "reps", "equipment": ["spoon"] })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(err["error"], "Equipment: unknown “spoon”");

    let (_, meta) = call(&app, "GET", "/api/meta", None).await;
    let values = |key: &str| {
        meta["exercise_traits"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["key"] == key)
            .unwrap()["values"]
            .clone()
    };
    // Each trait lists the values its field takes.
    assert!(values("primary").as_array().unwrap().len() > 20);
    assert_eq!(values("primary"), values("secondary"));
}

#[tokio::test]
async fn fineli_foods_keep_their_values_and_take_your_servings() {
    let app = fineli_app();
    let (_, found) = search(&app, "q=maito&sources=fineli").await;
    let milk = found[0].clone();
    let id = milk["id"].as_i64().unwrap();
    let mut body = json!({
        "name": milk["name"], "brand": milk["brand"], "barcode": "6408430000258",
        "per100": milk["per100"], "archived": false,
        "servings": [{ "label": "dl", "grams": 103.0 }, { "label": "Glass", "grams": 200.0 }],
    });
    let uri = format!("/api/foods/{id}");
    let (status, saved) = put_with_rev(&app, &uri, body.clone()).await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    assert_eq!(saved["servings"][1]["label"], "Glass");
    assert_eq!(saved["barcode"], "6408430000258");

    for (key, value) in [
        ("name", json!("Maito, oma")),
        ("per100", json!({ "energy": 1.0 })),
    ] {
        let mut changed = body.clone();
        changed[key] = value;
        let (status, err) = put_with_rev(&app, &uri, changed).await;
        assert_eq!(status, StatusCode::CONFLICT, "{key}");
        assert_eq!(err["code"], "base_read_only");
    }
    body["archived"] = json!(true);
    let (status, _) = put_with_rev(&app, &uri, body).await;
    assert_eq!(status, StatusCode::OK, "archiving is yours");
}

#[tokio::test]
async fn sides_go_only_on_one_sided_exercises() {
    let app = app();
    let pull = base(&app, "Pull-up").await;
    let split = base(&app, "Bulgarian split squat").await;
    let save = |steps: Value| {
        let app = app.clone();
        async move {
            call(
                &app,
                "POST",
                "/api/workouts",
                Some(json!({ "name": "W", "steps": steps })),
            )
            .await
        }
    };
    let (status, _) =
        save(json!([{ "kind": "exercise", "exercise_id": split, "reps": 8, "side": "left" }]))
            .await;
    assert_eq!(status, StatusCode::CREATED);
    let (status, err) =
        save(json!([{ "kind": "exercise", "exercise_id": pull, "reps": 8, "side": "left" }])).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(err["error"], "Step 1: Pull-up has no sides");
    // The pre-rename "loop" spelling is gone: steps repeat.
    let (status, err) = save(json!([{ "kind": "loop", "times": 2, "steps": [
        { "kind": "exercise", "exercise_id": pull, "reps": 3 }]}]))
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{err}");
    let (status, w) = save(json!([{ "kind": "repeat", "times": 2, "steps": [
        { "kind": "exercise", "exercise_id": pull, "reps": 3 }]}]))
    .await;
    assert_eq!(status, StatusCode::CREATED, "{w}");
    assert_eq!(w["steps"][0]["kind"], "repeat");
}

#[tokio::test]
async fn variants_hang_one_level_under_a_root_move() {
    let app = app();
    let push = base(&app, "Push-up").await;
    let diamond = base(&app, "Diamond push-up").await;
    let (_, d) = call(&app, "GET", &format!("/api/exercises/{diamond}"), None).await;
    assert_eq!(d["variant_of"], push);

    let mine = |variant_of: i64| json!({ "name": "Towel push-up", "measure": "reps", "variant_of": variant_of });
    let (status, err) = call(&app, "POST", "/api/exercises", Some(mine(diamond))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        err["error"],
        "Variant of: Diamond push-up is a variant itself; pick its root move"
    );
    let (status, towel) = call(&app, "POST", "/api/exercises", Some(mine(push))).await;
    assert_eq!(status, StatusCode::CREATED, "{towel}");

    // A root of yours with variants stays until they go.
    let root = exercise(&app, "Towel row", "reps").await;
    let (_, variant) = call(
        &app,
        "POST",
        "/api/exercises",
        Some(json!({ "name": "Towel row, wide", "measure": "reps", "variant_of": root })),
    )
    .await;
    let (status, err) = call(&app, "DELETE", &format!("/api/exercises/{root}"), None).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(err["error"], "Towel row has variants: Towel row, wide");
    call(
        &app,
        "DELETE",
        &format!("/api/exercises/{}", variant["id"]),
        None,
    )
    .await;
    let (status, _) = call(&app, "DELETE", &format!("/api/exercises/{root}"), None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn an_exercise_in_use_changes_only_in_ways_its_workouts_still_fit() {
    let app = app();
    let towel = exercise(&app, "Towel pull-up", "reps").await;
    call(
        &app,
        "POST",
        "/api/workouts",
        Some(json!({ "name": "Upper", "steps": [
            { "kind": "exercise", "exercise_id": towel, "reps": 3 }]})),
    )
    .await;
    let uri = format!("/api/exercises/{towel}");
    let put = |body: Value| {
        let (app, uri) = (app.clone(), uri.clone());
        async move { put_with_rev(&app, &uri, body).await }
    };
    // The step has no weight: "never weighted" still fits it, "always" doesn't.
    let (status, _) =
        put(json!({ "name": "Towel pull-up", "measure": "reps", "load": "none" })).await;
    assert_eq!(status, StatusCode::OK, "harmless for the workout");
    let (status, err) =
        put(json!({ "name": "Towel pull-up", "measure": "reps", "load": "required" })).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(err["code"], "exercise_in_use");
    assert_eq!(
        err["error"],
        "Towel pull-up is used by Upper, where step 1: Towel pull-up needs a weight (kg)"
    );
}

#[tokio::test]
async fn sessions_are_kept_per_profile_and_keep_their_workout() {
    let app = app();
    let pull = base(&app, "Pull-up").await;
    let (_, w) = call(
        &app,
        "POST",
        "/api/workouts",
        Some(json!({ "name": "Pulls", "steps": [
            { "kind": "exercise", "exercise_id": pull, "reps": 5 }] })),
    )
    .await;
    let wid = w["id"].as_i64().unwrap();
    let session = |day: &str, reps: u32| {
        json!({ "day": day, "workout_id": wid, "name": "Pulls", "minutes": 12,
                "kcal": 60, "sets": [
                    { "exercise_id": pull, "name": "Pull-up", "reps": reps, "kg": 10.0 }] })
    };
    let (status, made) = call(
        &app,
        "POST",
        "/api/profiles/1/activities",
        Some(session("2030-03-02", 7)),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{made}");
    assert_eq!(made["sets"][0]["reps"], 7);
    let id = made["id"].as_i64().unwrap();
    call(
        &app,
        "POST",
        "/api/profiles/1/activities",
        Some(session("2030-03-09", 8)),
    )
    .await;

    // Listed by range, and by exercise.
    let (_, list) = call(
        &app,
        "GET",
        "/api/profiles/1/activities?from=2030-03-01&to=2030-03-05",
        None,
    )
    .await;
    assert_eq!(list.as_array().unwrap().len(), 1);
    let (_, plank) = call(
        &app,
        "GET",
        &format!(
            "/api/profiles/1/activities?from=2030-01-01&to=2030-12-31&exercise_id={}",
            base(&app, "Plank").await
        ),
        None,
    )
    .await;
    assert_eq!(plank, json!([]));

    // Edited in place; the workout going leaves the session and its name.
    let mut edited = session("2030-03-03", 9);
    edited["kcal"] = Value::Null;
    let (status, put) =
        put_with_rev(&app, &format!("/api/profiles/1/activities/{id}"), edited).await;
    assert_eq!(status, StatusCode::OK, "{put}");
    assert_eq!(
        (put["day"].clone(), put["kcal"].clone()),
        (json!("2030-03-03"), Value::Null)
    );
    // A workout a session used can't go (archive it instead).
    let (status, err) = call(&app, "DELETE", &format!("/api/workouts/{wid}"), None).await;
    assert_eq!(status, StatusCode::CONFLICT, "{err}");
    assert_eq!(err["code"], "workout_in_use");
    let (_, kept) = call(
        &app,
        "GET",
        &format!("/api/profiles/1/activities/{id}"),
        None,
    )
    .await;
    assert_eq!(
        (kept["workout_id"].clone(), kept["name"].clone()),
        (json!(wid), json!("Pulls"))
    );

    let (status, _) = call(
        &app,
        "DELETE",
        &format!("/api/profiles/1/activities/{id}"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn session_sets_are_named_after_their_exercise() {
    let app = app();
    let (_, own) = call(
        &app,
        "POST",
        "/api/exercises",
        Some(json!({ "name": "Towel row", "measure": "reps" })),
    )
    .await;
    let own = own["id"].as_i64().unwrap();
    let pull = base(&app, "Pull-up").await;
    // No name, or a wrong one: the server names each set.
    let (status, made) = call(
        &app,
        "POST",
        "/api/profiles/1/activities",
        Some(
            json!({ "day": "2030-04-01", "name": "Mix", "minutes": 10, "sets": [
            { "exercise_id": pull, "reps": 5 },
            { "exercise_id": own, "name": "Bogus", "reps": 3 }] }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{made}");
    let names = |s: &Value| -> Vec<String> {
        s["sets"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| x["name"].as_str().unwrap().to_owned())
            .collect()
    };
    assert_eq!(names(&made), ["Pull-up", "Towel row"]);

    // The exercise going keeps its name in the session, through edits too.
    let id = made["id"].as_i64().unwrap();
    let (status, _) = call(&app, "DELETE", &format!("/api/exercises/{own}"), None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let mut edited = made.clone();
    edited["minutes"] = json!(11);
    let (status, put) =
        put_with_rev(&app, &format!("/api/profiles/1/activities/{id}"), edited).await;
    assert_eq!(status, StatusCode::OK, "{put}");
    assert_eq!(names(&put), ["Pull-up", "Towel row"]);
}

#[tokio::test]
async fn sessions_belong_to_their_profile() {
    let app = app();
    let pull = base(&app, "Pull-up").await;
    let session = json!({ "day": "2030-03-04", "name": "Pulls", "minutes": 12,
        "sets": [{ "exercise_id": pull, "name": "Pull-up", "reps": 1 }] });
    let (_, mine) = call(
        &app,
        "POST",
        "/api/profiles/1/activities",
        Some(session.clone()),
    )
    .await;
    let id = mine["id"].as_i64().unwrap();
    // Another profile can't see or touch it, and its own go with it.
    let (_, other) = call(&app, "POST", "/api/profiles", Some(adult("Other"))).await;
    let other = other["id"].as_i64().unwrap();
    let (status, _) = call(
        &app,
        "GET",
        &format!("/api/profiles/{other}/activities/{id}"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (_, own) = call(
        &app,
        "POST",
        &format!("/api/profiles/{other}/activities"),
        Some(session),
    )
    .await;
    call(&app, "DELETE", &format!("/api/profiles/{other}"), None).await;
    let (status, _) = call(
        &app,
        "GET",
        &format!("/api/profiles/1/activities/{}", own["id"]),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    let (status, _) = call(
        &app,
        "DELETE",
        &format!("/api/profiles/1/activities/{id}"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn sessions_are_validated() {
    let app = app();
    let pull = base(&app, "Pull-up").await;
    for (body, error, field) in [
        (
            json!({ "day": "3 March", "name": "S", "minutes": 5 }),
            "Day must be YYYY-MM-DD",
            json!("day"),
        ),
        (
            json!({ "day": "2030-03-03", "name": "S", "minutes": 0 }),
            "Minutes must be 1–1440",
            json!("minutes"),
        ),
        (
            json!({ "day": "2030-03-03", "name": "S", "minutes": 5, "kcal": 9000 }),
            "Kcal must be 0–5000",
            json!("kcal"),
        ),
        (
            json!({ "day": "2030-03-03", "name": "S", "minutes": 5,
                    "sets": [{ "exercise_id": pull, "name": "Pull-up", "reps": 1000 }] }),
            "Set 1: reps must be 0–999",
            Value::Null,
        ),
    ] {
        let (status, err) = call(&app, "POST", "/api/profiles/1/activities", Some(body)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{err}");
        assert_eq!(err["error"], error);
        assert_eq!(err["field"], field, "{err}");
    }
}

/// Keys the API took before goals and the weight log had one home each:
/// sent at all, `null` too, they are refused and nothing changes, so an
/// older client never loses a value silently.
#[tokio::test]
async fn gone_keys_are_400() {
    let app = app();
    for key in ["weight_kg", "workouts_per_week", "goal_weight_kg"] {
        for value in [json!(70), Value::Null] {
            let mut body = adult("Old");
            body[key] = value.clone();
            let (status, err) = call(&app, "POST", "/api/profiles", Some(body.clone())).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{key}: {err}");
            assert_eq!(err["field"], key, "{err}");
            body["name"] = json!("Me");
            let (status, err) = put_with_rev(&app, "/api/profiles/1", body).await;
            assert_eq!(
                (status, &err["field"]),
                (StatusCode::BAD_REQUEST, &json!(key))
            );
        }
    }
    let (_, list) = call(&app, "GET", "/api/profiles", None).await;
    assert_eq!(list.as_array().unwrap().len(), 1, "none was made");
    let (status, err) =
        put_targets(&app, 1, json!([{ "nutrient": "energy", "value": 2000 }])).await;
    assert_eq!(
        (status, &err["field"]),
        (StatusCode::BAD_REQUEST, &json!("nutrient")),
        "{err}"
    );
    let (status, err) = call(
        &app,
        "POST",
        "/api/profiles/1/habits",
        Some(json!({ "name": "Snus", "unit": "x", "day_limit": 5 })),
    )
    .await;
    assert_eq!(
        (status, &err["field"]),
        (StatusCode::BAD_REQUEST, &json!("day_limit")),
        "{err}"
    );
    let (_, me) = call(&app, "GET", "/api/profiles/1", None).await;
    for key in ["workouts_per_week", "goal_weight_kg"] {
        assert!(me.get(key).is_none(), "{key} is not served: {me}");
    }
}

#[tokio::test]
async fn stale_revs_are_refused_and_change_nothing() {
    let app = app();
    let oats = create_food(&app, "Oats", json!({})).await;
    let items = json!([{ "food_id": oats, "grams": 50.0 }]);
    let (_, meal) = call(
        &app,
        "POST",
        "/api/meals",
        Some(json!({ "name": "Breakfast", "items": items })),
    )
    .await;
    let steps =
        json!([{ "kind": "exercise", "exercise_id": base(&app, "Pull-up").await, "reps": 3 }]);
    let (_, workout) = call(
        &app,
        "POST",
        "/api/workouts",
        Some(json!({ "name": "Upper", "steps": steps })),
    )
    .await;
    let (_, recipe) = call(
        &app,
        "POST",
        "/api/recipes",
        Some(json!({ "name": "Porridge", "items": items })),
    )
    .await;
    let squat = exercise(&app, "My squat", "reps").await;
    let session = json!({ "day": DAY, "name": "Run", "minutes": 30 });
    let (_, session) = call(&app, "POST", "/api/profiles/1/activities", Some(session)).await;
    let cases = [
        (format!("/api/foods/{oats}"), json!({ "name": "Renamed" })),
        (
            format!("/api/meals/{}", meal["id"]),
            json!({ "name": "Renamed", "items": items }),
        ),
        (
            format!("/api/workouts/{}", workout["id"]),
            json!({ "name": "Renamed", "steps": steps }),
        ),
        (
            format!("/api/recipes/{}", recipe["id"]),
            json!({ "name": "Renamed", "items": items }),
        ),
        (
            format!("/api/exercises/{squat}"),
            json!({ "name": "Renamed", "measure": "reps" }),
        ),
        (
            format!("/api/profiles/1/activities/{}", session["id"]),
            json!({ "day": DAY, "name": "Renamed", "minutes": 30 }),
        ),
    ];
    for (uri, body) in cases {
        let (status, saved) = put_with_rev(&app, &uri, body.clone()).await;
        assert_eq!(status, StatusCode::OK, "{uri}: {saved}");
        assert_eq!(saved["rev"], 2, "{uri}: every save moves rev on");
        // Another client still holding rev 1.
        let mut stale = saved.clone();
        stale["name"] = json!("Stale");
        stale["rev"] = json!(1);
        let (status, err) = call(&app, "PUT", &uri, Some(stale)).await;
        assert_eq!(status, StatusCode::CONFLICT, "{uri}: {err}");
        assert_eq!(err["code"], "stale", "{uri}");
        let (_, now) = call(&app, "GET", &uri, None).await;
        assert_eq!((&now["name"], &now["rev"]), (&json!("Renamed"), &json!(2)));
        // No rev at all.
        let mut bare = now.clone();
        bare.as_object_mut().unwrap().remove("rev");
        let (status, err) = call(&app, "PUT", &uri, Some(bare)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{uri}: {err}");
        assert_eq!(err["field"], "rev", "{uri}");
        assert_eq!(err["error"], "Rev is required", "{uri}");
    }

    // Targets are saved at the profile's rev and move it on.
    let energy = |value: f64| json!([{ "metric": "energy", "value": value }]);
    let (_, me) = call(&app, "GET", "/api/profiles/1", None).await;
    let (status, _) = put_targets(&app, 1, energy(2000.0)).await;
    assert_eq!(status, StatusCode::OK);
    let (status, err) = call(
        &app,
        "PUT",
        "/api/profiles/1/targets",
        Some(json!({ "rev": me["rev"], "targets": energy(1500.0) })),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{err}");
    assert_eq!(err["code"], "stale");
    let (_, targets) = call(&app, "GET", "/api/profiles/1/targets", None).await;
    assert_eq!(targets[0]["value"], 2000.0);
}

#[tokio::test]
async fn retried_creates_with_a_uid_save_once() {
    let app = app();
    let oats = create_food(&app, "Oats", json!({ "energy": 100.0 })).await;
    let milk = create_food(&app, "Milk", json!({ "energy": 50.0 })).await;
    let post_twice = |uri: &str, body: Value| {
        let (app, uri) = (app.clone(), uri.to_owned());
        async move {
            let (status, first) = call(&app, "POST", &uri, Some(body.clone())).await;
            assert_eq!(status, StatusCode::CREATED, "{first}");
            let (status, again) = call(&app, "POST", &uri, Some(body)).await;
            assert_eq!(status, StatusCode::CREATED, "{again}");
            (first, again)
        }
    };

    let entry = json!({ "day": DAY, "group": "Eaten", "food_id": oats, "grams": 50.0,
                        "uid": "entry-0001" });
    let (first, again) = post_twice("/api/profiles/1/entries", entry).await;
    assert_eq!(first["entries"][0]["id"], again["entries"][0]["id"]);
    assert_eq!(first["entries"][0]["uid"], "entry-0001");

    let (_, meal) = call(
        &app,
        "POST",
        "/api/meals",
        Some(json!({ "name": "Breakfast", "items": [
            { "food_id": oats, "grams": 50.0 }, { "food_id": milk, "grams": 200.0 }] })),
    )
    .await;
    let logged = json!({ "day": DAY, "group": "Eaten", "meal_id": meal["id"],
                         "uid": "meal-0001" });
    let (first, again) = post_twice("/api/profiles/1/entries", logged).await;
    assert_eq!(first, again);
    let uids: Vec<_> = first["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["uid"].as_str().unwrap())
        .collect();
    assert_eq!(uids, ["meal-0001:1", "meal-0001:2"]);

    let (_, day) = call(&app, "GET", &format!("/api/profiles/1/day/{DAY}"), None).await;
    let count = group(&day, "Eaten")["entries"].as_array().unwrap().len();
    assert_eq!(count, 3, "one food and two meal items, each once");

    let session = json!({ "day": DAY, "name": "Run", "minutes": 30, "uid": "session-0001" });
    let (first, again) = post_twice("/api/profiles/1/activities", session).await;
    assert_eq!(first["id"], again["id"]);
    assert_eq!(first["uid"], "session-0001");
}

#[tokio::test]
async fn entries_can_be_measured_by_serving() {
    let app = app();
    let (_, bread) = call(
        &app,
        "POST",
        "/api/foods",
        Some(json!({ "name": "Bread", "per100": { "energy": 250.0 },
                     "servings": [{ "label": "Slice", "grams": 40.0 }] })),
    )
    .await;
    let log = |serving: &str| {
        json!({ "day": DAY, "group": "Eaten", "food_id": bread["id"],
                "serving": serving, "quantity": 2.0 })
    };
    let (status, res) = call(&app, "POST", "/api/profiles/1/entries", Some(log("Slice"))).await;
    assert_eq!(status, StatusCode::CREATED, "{res}");
    let entry = &res["entries"][0];
    assert_eq!(entry["grams"], 80.0);
    assert_eq!(entry["amount"], "2 × Slice (80 g)");
    assert_eq!(
        (&entry["serving"], &entry["quantity"]),
        (&json!("Slice"), &json!(2.0))
    );
    assert_eq!(entry["nutrients"]["energy"], 200.0);

    let uri = format!("/api/profiles/1/entries/{}", entry["id"]);
    let (status, patched) = call(
        &app,
        "PATCH",
        &uri,
        Some(json!({ "serving": "Slice", "quantity": 3.0 })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{patched}");
    assert_eq!(patched["grams"], 120.0);
    assert_eq!(patched["amount"], "3 × Slice (120 g)");
    assert_eq!(patched["nutrients"]["energy"], 300.0, "rescaled");

    let (status, err) = call(&app, "POST", "/api/profiles/1/entries", Some(log("Loaf"))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{err}");
    assert_eq!(err["field"], "serving");
}

#[tokio::test]
async fn weight_log_drives_the_profile_weight() {
    let app = app();
    let weight = |day: &str| format!("/api/profiles/1/weights/{day}");
    let kg = |app: Router| async move {
        call(&app, "GET", "/api/profiles/1", None).await.1["latest_weight_kg"].clone()
    };
    for (day, value) in [("2026-10-01", 70.0), ("2026-10-05", 68.5)] {
        let (status, res) = call(&app, "PUT", &weight(day), Some(json!({ "kg": value }))).await;
        assert_eq!(status, StatusCode::OK, "{res}");
    }
    assert_eq!(kg(app.clone()).await, 68.5, "the latest day's");
    let (status, _) = call(&app, "DELETE", &weight("2026-10-05"), None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(kg(app.clone()).await, 70.0, "falls back to the one before");

    let (status, err) = call(&app, "PUT", &weight(DAY), Some(json!({ "kg": 10.0 }))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{err}");
    assert_eq!(err["field"], "kg");
}

#[tokio::test]
async fn a_profile_read_puts_back_as_it_is() {
    // Read, edit, write back: nothing the GET serves is refused by the PUT.
    let app = app();
    let weight = format!("/api/profiles/1/weights/{DAY}");
    let (status, _) = call(&app, "PUT", &weight, Some(json!({ "kg": 70.0 }))).await;
    assert_eq!(status, StatusCode::OK);
    let (_, mut me) = call(&app, "GET", "/api/profiles/1", None).await;
    assert_eq!(me["latest_weight_kg"], 70.0, "{me}");
    me["name"] = json!("Renamed");
    let (status, res) = call(&app, "PUT", "/api/profiles/1", Some(me)).await;
    assert_eq!(status, StatusCode::OK, "{res}");
    assert_eq!(res["name"], "Renamed");
}

#[tokio::test]
async fn saving_the_profile_never_rewrites_a_newer_weigh_in() {
    // The weight lives in the log only. A profile editor loaded
    // before today's 82 kg weigh-in saves: the weigh-in stays, and the
    // save isn't refused for it either.
    let app = app();
    let mut me = adult("Me");
    me["day"] = json!(DAY);
    let (status, res) = put_with_rev(&app, "/api/profiles/1", me.clone()).await;
    assert_eq!(status, StatusCode::OK, "{res}");
    let (_, loaded) = call(&app, "GET", "/api/profiles/1", None).await;
    let weight = format!("/api/profiles/1/weights/{DAY}");
    let (status, _) = call(&app, "PUT", &weight, Some(json!({ "kg": 82.0 }))).await;
    assert_eq!(status, StatusCode::OK);
    me["rev"] = loaded["rev"].clone();
    let (status, res) = call(&app, "PUT", "/api/profiles/1", Some(me.clone())).await;
    assert_eq!(
        status,
        StatusCode::OK,
        "a weigh-in doesn't stale the profile: {res}"
    );
    me["rev"] = res["rev"].clone();
    let (status, res) = call(&app, "PUT", "/api/profiles/1", Some(me)).await;
    assert_eq!(status, StatusCode::OK, "{res}");
    let (_, logged) = call(&app, "GET", "/api/profiles/1/weights", None).await;
    assert_eq!(logged, json!([{ "day": DAY, "kg": 82.0 }]));
    assert_eq!(res["latest_weight_kg"], 82.0, "read from the log");
}

#[tokio::test]
async fn weight_write_leaves_the_profile_rev_alone() {
    let app = app();
    let rev = |app: Router| async move {
        call(&app, "GET", "/api/profiles/1", None).await.1["rev"].clone()
    };
    let before = rev(app.clone()).await;
    let weight = format!("/api/profiles/1/weights/{DAY}");
    let (status, _) = call(&app, "PUT", &weight, Some(json!({ "kg": 71.5 }))).await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = call(&app, "DELETE", &weight, None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(rev(app.clone()).await, before);
}

#[tokio::test]
async fn deleting_the_last_weight_leaves_none() {
    // Regression: the profile kept a shadow weight that
    // outlived the log.
    let app = app();
    let mut me = adult("Me");
    me["day"] = json!(DAY);
    let (status, res) = put_with_rev(&app, "/api/profiles/1", me).await;
    assert_eq!(status, StatusCode::OK, "{res}");
    let weight = format!("/api/profiles/1/weights/{DAY}");
    let (status, _) = call(&app, "PUT", &weight, Some(json!({ "kg": 80.0 }))).await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = call(&app, "DELETE", &weight, None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (_, p) = call(&app, "GET", "/api/profiles/1", None).await;
    assert_eq!(p["latest_weight_kg"], Value::Null, "{p}");
    let (status, err) = call(&app, "GET", "/api/profiles/1/recommended", None).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{err}");
    assert!(err["error"].as_str().unwrap().contains("weight"), "{err}");
}

#[tokio::test]
async fn weights_after_tomorrow_are_refused() {
    let app = app();
    let day = |ahead: i64| {
        let secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let (y, m, d) =
            kaloriina::model::civil_from_days(i64::try_from(secs / 86_400).unwrap() + ahead);
        format!("{y:04}-{m:02}-{d:02}")
    };
    let (status, res) = call(
        &app,
        "PUT",
        &format!("/api/profiles/1/weights/{}", day(1)),
        Some(json!({ "kg": 70.0 })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "a client east of UTC: {res}");
    let (_, p) = call(&app, "GET", "/api/profiles/1", None).await;
    assert_eq!(p["latest_weight_kg"], 70.0);
    let (status, err) = call(
        &app,
        "PUT",
        &format!("/api/profiles/1/weights/{}", day(2)),
        Some(json!({ "kg": 71.0 })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{err}");
    assert_eq!(err["field"], "day");
    let mut me = adult("Me");
    me["day"] = json!(day(2));
    let (status, err) = put_with_rev(&app, "/api/profiles/1", me).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{err}");
    assert_eq!(err["field"], "day");
}

#[tokio::test]
async fn day_view_counts_eaten_food_and_shows_workouts_and_weight() {
    let app = app();
    let oats = create_food(&app, "Oats", json!({ "energy": 100.0 })).await;
    log_entry(&app, "Planned", oats, 100.0).await;
    log_entry(&app, "Eaten", oats, 50.0).await;
    let uri = format!("/api/profiles/1/day/{DAY}");
    let (_, day) = call(&app, "GET", &uri, None).await;
    assert_eq!(day["total"]["energy"], 150.0);
    assert_eq!(day["eaten"]["energy"], 50.0, "planned food isn't eaten");
    assert_eq!(
        (&day["activities"], &day["weight"]),
        (&json!([]), &Value::Null)
    );
    assert_eq!(
        (&day["device_day"], day.get("activity")),
        (&Value::Null, None),
        "Health Connect's day is `device_day`"
    );

    let session = json!({ "day": DAY, "name": "Run", "minutes": 30 });
    call(&app, "POST", "/api/profiles/1/activities", Some(session)).await;
    let weight = format!("/api/profiles/1/weights/{DAY}");
    call(&app, "PUT", &weight, Some(json!({ "kg": 70.0 }))).await;
    let (_, day) = call(&app, "GET", &uri, None).await;
    assert_eq!(names(&day["activities"]), ["Run"]);
    assert_eq!(day["weight"], 70.0);
    let (_, next) = call(&app, "GET", "/api/profiles/1/day/2026-10-07", None).await;
    assert_eq!(
        (&next["activities"], &next["weight"]),
        (&json!([]), &Value::Null),
        "only the day's own"
    );
}

#[tokio::test]
async fn recipes_carry_a_whole_recipe_serving() {
    let app = app();
    let oats = create_food(&app, "Oats", json!({})).await;
    let milk = create_food(&app, "Milk", json!({})).await;
    let items = json!([{ "food_id": oats, "grams": 100.0 }, { "food_id": milk, "grams": 200.0 }]);
    let (status, recipe) = call(
        &app,
        "POST",
        "/api/recipes",
        Some(json!({ "name": "Porridge", "items": items,
                     "servings": [{ "label": "Bowl", "grams": 250.0 }] })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{recipe}");
    assert_eq!(
        recipe["servings"],
        json!([{ "label": "Whole recipe", "grams": 300.0 }, { "label": "Bowl", "grams": 250.0 }]),
        "first, weighing all its items"
    );

    // Sent back second, it stays second and weighs what was cooked.
    let uri = format!("/api/recipes/{}", recipe["id"]);
    let servings = json!([recipe["servings"][1], recipe["servings"][0]]);
    let (status, saved) = put_with_rev(
        &app,
        &uri,
        json!({ "name": "Porridge", "cooked_g": 500.0, "items": items, "servings": servings }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    assert_eq!(
        saved["servings"],
        json!([{ "label": "Bowl", "grams": 250.0 }, { "label": "Whole recipe", "grams": 500.0 }])
    );

    let (status, err) = call(
        &app,
        "POST",
        "/api/foods",
        Some(json!({ "name": "Bread", "servings": [{ "label": "Whole recipe", "grams": 500.0 }] })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "kept for recipes: {err}");
}

#[tokio::test]
async fn session_sets_fit_their_exercise() {
    let app = app();
    let pull = base(&app, "Pull-up").await;
    let split = base(&app, "Bulgarian split squat").await;
    let save = |sets: Value, workout_id: Value| {
        let app = app.clone();
        let body = json!({ "day": DAY, "name": "S", "minutes": 5, "sets": sets,
                           "workout_id": workout_id });
        async move { call(&app, "POST", "/api/profiles/1/activities", Some(body)).await }
    };
    for (set, error) in [
        (
            json!({ "exercise_id": pull, "name": "Pull-up", "reps": 5, "seconds": 30 }),
            "Set 1: give reps or seconds",
        ),
        (
            json!({ "exercise_id": pull, "name": "Pull-up", "reps": 5, "side": "left" }),
            "Set 1: Pull-up has no sides",
        ),
    ] {
        let (status, err) = save(json!([set]), Value::Null).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{err}");
        assert_eq!(err["error"], error);
    }
    let one_side = json!([{ "exercise_id": split, "name": "Split squat", "reps": 8,
                            "side": "left" }]);
    let (status, made) = save(one_side, Value::Null).await;
    assert_eq!(status, StatusCode::CREATED, "{made}");

    // A workout deleted meanwhile (or never there) is saved as no link.
    let (_, w) = call(
        &app,
        "POST",
        "/api/workouts",
        Some(json!({ "name": "Pulls", "steps": [
            { "kind": "exercise", "exercise_id": pull, "reps": 5 }] })),
    )
    .await;
    call(&app, "DELETE", &format!("/api/workouts/{}", w["id"]), None).await;
    for workout_id in [w["id"].clone(), json!(999)] {
        let (status, made) = save(json!([]), workout_id).await;
        assert_eq!(status, StatusCode::CREATED, "{made}");
        assert_eq!(made["workout_id"], Value::Null);
    }
}

#[tokio::test]
async fn framework_rejections_read_like_ours() {
    let app = app();
    let (status, err) = call(&app, "POST", "/api/foods", Some(json!({}))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        err,
        json!({ "error": "Name is required", "code": "invalid", "field": "name" })
    );
    let (status, err) = call(&app, "GET", "/api/foods/abc", None).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        err,
        json!({ "error": "An id in the address isn't a number", "code": "invalid" })
    );
    let (status, err) = call(
        &app,
        "POST",
        "/api/foods",
        Some(json!({ "name": "Oat\u{1b}[31m" })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{err}");
    assert_eq!(err["error"], "Name can't contain control characters");
    assert_eq!(err["field"], "name");
    let (status, err) = call(&app, "POST", "/api/foods", Some(json!({ "name": 5 }))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        err,
        json!({ "error": "Name has the wrong type", "code": "invalid", "field": "name" })
    );
    let session = json!({ "day": DAY, "name": "Run", "minutes": "half an hour" });
    let (status, err) = call(&app, "POST", "/api/profiles/1/activities", Some(session)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(err["field"], "minutes", "{err}");
    assert_eq!(err["error"], "Minutes has the wrong type");
}

#[tokio::test]
async fn search_ranks_favourites_then_own_foods_per_profile() {
    let stub = Router::new().route(
        "/api/v2/product/{file}",
        get(|Path(file): Path<String>| async move {
            let name = if file.starts_with("4000000000001") {
                "Zz alpha"
            } else {
                "Zz beta"
            };
            axum::Json(json!({ "product": { "product_name": name } }))
        }),
    );
    let app = app_with_stub(stub).await;
    let mut beta = Value::Null;
    for code in ["4000000000001", "4000000000002"] {
        let uri = format!("/api/foods/barcode/{code}");
        let (status, food) = call(&app, "POST", &uri, Some(json!({}))).await;
        assert_eq!(status, StatusCode::OK, "{food}");
        beta = food["id"].clone();
    }
    create_food(&app, "Zz gamma", json!({})).await;
    let star = |pid: i64| {
        let app = app.clone();
        let body = json!({ "food_id": beta });
        let uri = format!("/api/profiles/{pid}/foods/favorites");
        async move { call(&app, "POST", &uri, Some(body)).await }
    };

    let (_, found) = search(&app, "q=zz").await;
    assert_eq!(
        names(&found),
        ["Zz gamma", "Zz alpha", "Zz beta"],
        "own first"
    );
    let (_, anna) = call(&app, "POST", "/api/profiles", Some(adult("Anna"))).await;
    star(anna["id"].as_i64().unwrap()).await;
    let (_, found) = search(&app, "q=zz").await;
    assert_eq!(
        names(&found),
        ["Zz gamma", "Zz alpha", "Zz beta"],
        "Anna's favourites aren't mine"
    );
    star(1).await;
    let (_, found) = search(&app, "q=zz").await;
    assert_eq!(
        names(&found),
        ["Zz beta", "Zz gamma", "Zz alpha"],
        "favourite first"
    );
}

#[tokio::test]
async fn a_uid_is_one_profiles_own() {
    let app = app();
    let (_, anna) = call(&app, "POST", "/api/profiles", Some(adult("Anna"))).await;
    let anna = anna["id"].as_i64().unwrap();
    let (_, f) = call(
        &app,
        "POST",
        "/api/foods",
        Some(json!({ "name": "Uid oats", "per100": { "energy": 380.0 } })),
    )
    .await;
    let pull = base(&app, "Pull-up").await;
    for pid in [1, anna] {
        let (status, res) = call(
            &app,
            "POST",
            &format!("/api/profiles/{pid}/entries"),
            Some(json!({ "day": DAY, "group": "Eaten", "food_id": f["id"],
                         "grams": 50.0, "uid": "shared-0001" })),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "entry for {pid}: {res}");
        let (status, res) = call(
            &app,
            "POST",
            &format!("/api/profiles/{pid}/activities"),
            Some(
                json!({ "day": DAY, "name": "Pulls", "minutes": 10, "uid": "shared-0002",
                         "sets": [{ "exercise_id": pull, "reps": 5 }] }),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "session for {pid}: {res}");
    }
}

#[tokio::test]
async fn a_meal_replay_matches_only_its_own_uid() {
    let app = app();
    let (_, f) = call(
        &app,
        "POST",
        "/api/foods",
        Some(json!({ "name": "Replay oats", "per100": { "energy": 380.0 } })),
    )
    .await;
    let (_, meal) = call(
        &app,
        "POST",
        "/api/meals",
        Some(json!({ "name": "Replay", "items": [{ "food_id": f["id"], "grams": 50.0 }] })),
    )
    .await;
    let log =
        |uid: &str| json!({ "day": DAY, "group": "Eaten", "meal_id": meal["id"], "uid": uid });
    call(
        &app,
        "POST",
        "/api/profiles/1/entries",
        Some(log("MEALUID01")),
    )
    .await;
    // Another uid differing only in case is another write.
    let (status, res) = call(
        &app,
        "POST",
        "/api/profiles/1/entries",
        Some(log("mealuid01")),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{res}");
    assert_eq!(res["entries"][0]["uid"], "mealuid01:1");
    // ":" is the server's, for meal items.
    let (status, err) = call(
        &app,
        "POST",
        "/api/profiles/1/entries",
        Some(log("mine:0001")),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{err}");
    assert_eq!(err["field"], "uid");
}

#[tokio::test]
async fn a_recipe_is_not_a_food_to_put_whatever_the_rev() {
    let app = app();
    let (_, f) = call(
        &app,
        "POST",
        "/api/foods",
        Some(json!({ "name": "Put oats", "per100": { "energy": 380.0 } })),
    )
    .await;
    let (_, recipe) = call(
        &app,
        "POST",
        "/api/recipes",
        Some(json!({ "name": "Put porridge", "items": [{ "food_id": f["id"], "grams": 50.0 }] })),
    )
    .await;
    let id = recipe["id"].as_i64().unwrap();
    let (status, err) = call(
        &app,
        "PUT",
        &format!("/api/foods/{id}"),
        Some(
            json!({ "name": "Put porridge", "brand": null, "barcode": null,
                     "per100": { "energy": 1.0 }, "servings": [], "archived": false,
                     "category": null, "basis": null, "rev": 999 }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{err}");
}

#[tokio::test]
async fn a_taken_barcode_or_name_names_its_field() {
    let app = app();
    let food = json!({ "name": "Coded", "barcode": "6410000000001", "per100": {} });
    call(&app, "POST", "/api/foods", Some(food.clone())).await;
    let (status, err) = call(&app, "POST", "/api/foods", Some(food)).await;
    assert_eq!(
        (status, err["code"].clone()),
        (StatusCode::CONFLICT, json!("barcode_taken"))
    );
    assert_eq!(err["field"], "barcode");
    call(&app, "POST", "/api/profiles", Some(adult("Twin"))).await;
    let (_, err) = call(&app, "POST", "/api/profiles", Some(adult("Twin"))).await;
    assert_eq!(
        (err["code"].clone(), err["field"].clone()),
        (json!("name_taken"), json!("name"))
    );
}

#[tokio::test]
async fn a_profile_without_measurements_starts_without_targets() {
    let app = app();
    let mut bo = adult("Bo");
    bo["height_cm"] = Value::Null;
    let (status, made) = call(&app, "POST", "/api/profiles", Some(bo)).await;
    assert_eq!(status, StatusCode::CREATED, "{made}");
    let id = made["id"].as_i64().unwrap();
    let (_, targets) = call(&app, "GET", &format!("/api/profiles/{id}/targets"), None).await;
    assert!(
        targets
            .as_array()
            .unwrap()
            .iter()
            .all(|t| t["default"] == true),
        "only the registry's defaults: {targets}"
    );
    // Recommendations come once the measurements are there.
    let (status, err) = call(
        &app,
        "GET",
        &format!("/api/profiles/{id}/recommended"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{err}");
}

#[tokio::test]
async fn distance_needs_a_whole_session_type() {
    // The server owns which sessions take a distance: the types that cover
    // ground (and "other"), never a workout, typed or left out.
    let app = app();
    let session = |kind: Value| json!({ "day": DAY, "name": "S", "minutes": 30, "type": kind, "distance_m": 8234 });
    for kind in [Value::Null, json!("workout"), json!("yoga")] {
        let (status, err) = call(
            &app,
            "POST",
            "/api/profiles/1/activities",
            Some(session(kind)),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{err}");
        assert_eq!(err["field"], "distance_m");
    }
    for kind in ["run", "rowing", "other"] {
        let (status, s) = call(
            &app,
            "POST",
            "/api/profiles/1/activities",
            Some(session(json!(kind))),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "{kind}: {s}");
        assert_eq!(s["distance_m"], 8234);
    }
    let (_, meta) = call(&app, "GET", "/api/meta", None).await;
    let distance = |key: &str| {
        meta["activity_types"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["key"] == key)
            .unwrap()["distance"]
            .clone()
    };
    assert_eq!(
        (distance("run"), distance("workout"), distance("yoga")),
        (json!(true), json!(false), json!(false))
    );
}

#[tokio::test]
async fn huge_per100_is_400_not_500() {
    // Regression: 1e20 was stored, 1e300 answered 500.
    let app = app();
    for (per100, key) in [
        (json!({ "energy": 1e20 }), "energy"),
        (json!({ "energy": 1e300 }), "energy"),
        (json!({ "protein": 1e308 }), "protein"),
        (json!({ "energy": 991.0 }), "energy"),
        (json!({ "protein": 110.1 }), "protein"),
    ] {
        let (status, err) = call(
            &app,
            "POST",
            "/api/foods",
            Some(json!({ "name": "Typo", "per100": per100 })),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{per100}: {err}");
        assert_eq!(err["code"], "invalid");
        assert_eq!(err["field"], "per100");
        assert!(
            err["error"].as_str().unwrap().to_lowercase().contains(key),
            "{err}"
        );
    }
    assert_only_seeded_foods(&app).await;
    let fat = create_food(&app, "Oil", json!({ "energy": 900.0, "fat": 100.0 })).await;
    assert!(fat > 0);
    let (_, meta) = call(&app, "GET", "/api/meta", None).await;
    assert_eq!(meta["limits"]["per100_max"]["kcal"], 990.0);
    assert_eq!(meta["limits"]["per100_max"]["g"], 110.0);
}

#[tokio::test]
async fn meta_serves_the_version_and_the_goal_registry() {
    let app = app();
    let (_, meta) = call(&app, "GET", "/api/meta", None).await;
    assert_eq!(meta["version"], env!("CARGO_PKG_VERSION"));
    let keys: Vec<&str> = meta["metrics"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["key"].as_str().unwrap())
        .collect();
    for key in ["steps", "sleep_min", "workouts_per_week", "goal_weight"] {
        assert!(keys.contains(&key), "{key}: {keys:?}");
    }
    let steps = &meta["metrics"][keys.iter().position(|k| *k == "steps").unwrap()];
    assert_eq!(
        (&steps["default"], &steps["goal"], &steps["per"]),
        (&json!(10000.0), &json!("at_least"), &json!("day"))
    );
    // The values PUT /targets takes, so clients needn't copy them.
    assert_eq!(steps["range"], json!([0.0, 60_000.0]));
}

/// Every per-day PUT/DELETE (a path addressed by a day, no `rev`) repeats
/// harmlessly: the outbox may send one twice (the API contract behind
/// `web/outbox.mjs` `DAY_WRITE`). Twice the same PUT leaves what one does;
/// a second DELETE is 204 or 404 (the outbox takes a DELETE's 404 as done).
#[tokio::test]
async fn day_writes_repeat_harmlessly() {
    let app = app();
    let (status, habit) = call(
        &app,
        "POST",
        "/api/profiles/1/habits",
        Some(json!({ "name": "Snus", "unit": "pouches" })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let habit = &habit["id"];
    let day = format!("/api/profiles/1/day/{DAY}");
    for (path, body) in [
        (
            format!("/api/profiles/1/weights/{DAY}"),
            json!({ "kg": 70.5 }),
        ),
        (
            format!("/api/profiles/1/notes/{DAY}"),
            json!({ "text": "gym" }),
        ),
        (
            format!("/api/profiles/1/check-ins/{DAY}"),
            json!({ "mood": 4, "tags": ["travel"] }),
        ),
        (
            format!("/api/profiles/1/measurements/{DAY}/waist"),
            json!({ "value": 80.5 }),
        ),
        (
            format!("/api/profiles/1/habits/{habit}/days/{DAY}"),
            json!({ "amount": 3 }),
        ),
    ] {
        let (status, _) = call(&app, "PUT", &path, Some(body.clone())).await;
        assert!(status.is_success(), "{path}: {status}");
        let once = call(&app, "GET", &day, None).await.1;
        let (status, _) = call(&app, "PUT", &path, Some(body)).await;
        assert!(status.is_success(), "{path} again: {status}");
        assert_eq!(call(&app, "GET", &day, None).await.1, once, "{path}");

        let (status, _) = call(&app, "DELETE", &path, None).await;
        assert_eq!(status, StatusCode::NO_CONTENT, "{path}");
        let gone = call(&app, "GET", &day, None).await.1;
        let (status, _) = call(&app, "DELETE", &path, None).await;
        assert!(
            status == StatusCode::NO_CONTENT || status == StatusCode::NOT_FOUND,
            "{path} again: {status}"
        );
        assert_eq!(call(&app, "GET", &day, None).await.1, gone, "{path}");
    }
}

#[tokio::test]
async fn impossible_open_food_facts_values_are_502_and_nothing_is_stored() {
    // Upstream data no food can have (1e9 kcal/100 g) is Open Food
    // Facts' fault, not the caller's: 502, and no food is cached.
    let stub = Router::new().route(
        "/api/v2/product/{file}",
        get(|| async {
            axum::Json(json!({ "product": {
                "product_name": "Bad bar", "nutriments": { "energy-kcal_100g": 1e9 }
            } }))
        }),
    );
    let app = app_with_stub(stub).await;
    let (status, err) = call(
        &app,
        "POST",
        "/api/foods/barcode/4000000000099",
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_GATEWAY, "{err}");
    assert_eq!(err["code"], "unavailable");
    let (_, found) = search(&app, "q=bad%20bar").await;
    assert_eq!(found, json!([]));
}

#[tokio::test]
async fn unknown_category_is_400() {
    let app = app();
    for (uri, body) in [
        ("/api/foods", json!({ "name": "Gum", "category": "candy" })),
        (
            "/api/recipes",
            json!({ "name": "Pie", "items": [], "category": "dessert" }),
        ),
    ] {
        let (status, err) = call(&app, "POST", uri, Some(body)).await;
        assert_eq!(
            (status, &err["field"]),
            (StatusCode::BAD_REQUEST, &json!("category")),
            "{uri}: {err}"
        );
    }
    let (status, food) = call(
        &app,
        "POST",
        "/api/foods",
        Some(json!({ "name": "Gum", "category": "sweets_snacks" })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{food}");
    assert_eq!(food["category"], "sweets_snacks");
}

// ----------------------------------------------------------- hardening

#[tokio::test]
async fn every_response_has_no_referrer() {
    // One header instead of per-link opt-outs: the server's name
    // never leaves in a Referer.
    let app = app();
    for uri in [
        "/",
        "/api/meta",
        "/api/profiles/1/day/2026-10-06",
        "/api/nope",
    ] {
        let req = Request::builder().uri(uri).body(Body::empty()).unwrap();
        let res = app.clone().oneshot(req).await.unwrap();
        assert_eq!(
            res.headers()
                .get("referrer-policy")
                .and_then(|v| v.to_str().ok()),
            Some("no-referrer"),
            "{uri}"
        );
    }
}

#[tokio::test]
async fn an_unknown_device_workout_names_its_resource() {
    let app = app();
    let (status, res) = call(
        &app,
        "POST",
        "/api/profiles/1/sync/health/workouts/no-such-key",
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{res}");
    assert_eq!(res["resource"], "device_workout");
}

#[tokio::test]
async fn serving_and_meal_amounts_are_bounded() {
    let app = app();
    let bread = call(
        &app,
        "POST",
        "/api/foods",
        Some(json!({ "name": "Bread", "per100": { "energy": 250.0 },
                     "servings": [{ "label": "Slice", "grams": 30.0 }] })),
    )
    .await
    .1["id"]
        .clone();
    let (_, meal) = call(
        &app,
        "POST",
        "/api/meals",
        Some(json!({ "name": "Toast", "items": [{ "food_id": bread, "grams": 60.0 }] })),
    )
    .await;
    let entry = |extra: Value| {
        let mut body = json!({ "day": DAY, "group": "Eaten" });
        body.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        body
    };
    for (body, field) in [
        (
            json!({ "food_id": bread, "serving": "Slice", "quantity": 0 }),
            "quantity",
        ),
        (
            json!({ "food_id": bread, "serving": "Slice", "quantity": -1 }),
            "quantity",
        ),
        (json!({ "meal_id": meal["id"], "portions": 0 }), "portions"),
        (
            json!({ "meal_id": meal["id"], "portions": 100.5 }),
            "portions",
        ),
        (json!({ "food_id": 9999, "grams": 100 }), "food_id"),
    ] {
        let (status, res) = call(
            &app,
            "POST",
            "/api/profiles/1/entries",
            Some(entry(body.clone())),
        )
        .await;
        assert_eq!(
            (status, &res["field"]),
            (StatusCode::BAD_REQUEST, &json!(field)),
            "{body}: {res}"
        );
    }
    let (_, day) = call(&app, "GET", &format!("/api/profiles/1/day/{DAY}"), None).await;
    assert_eq!(group(&day, "Eaten")["entries"], json!([]), "nothing logged");
}

#[tokio::test]
async fn unfavouriting_is_idempotent() {
    let app = app();
    let oats = create_food(&app, "Oats", json!({ "energy": 380.0 })).await;
    let uri = format!("/api/profiles/1/foods/favorites/{oats}");
    let (status, _) = call(
        &app,
        "POST",
        "/api/profiles/1/foods/favorites",
        Some(json!({ "food_id": oats })),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    for _ in 0..2 {
        let (status, _) = call(&app, "DELETE", &uri, None).await;
        assert_eq!(status, StatusCode::NO_CONTENT);
    }
    let (_, list) = call(&app, "GET", "/api/profiles/1/foods/favorites", None).await;
    assert_eq!(list, json!([]));
    let (status, res) = call(
        &app,
        "DELETE",
        &format!("/api/profiles/99/foods/favorites/{oats}"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{res}");
    assert_eq!(res["resource"], "profile");
}

#[tokio::test]
async fn latitude_is_one_decimal_within_90_or_null() {
    let app = app();
    let (_, mut p) = call(&app, "GET", "/api/profiles/1", None).await;
    assert_eq!(p["latitude"], Value::Null);
    for good in [json!(60.2), json!(-33.9), json!(90.0), Value::Null] {
        let mut b = p.clone();
        b["latitude"] = good.clone();
        let (status, res) = call(&app, "PUT", "/api/profiles/1", Some(b)).await;
        assert_eq!(status, StatusCode::OK, "{good}: {res}");
        assert_eq!(res["latitude"], good);
        p = res;
    }
    for bad in [json!(-90.1), json!(90.1), json!(60.25), json!("60")] {
        let mut b = p.clone();
        b["latitude"] = bad.clone();
        let (status, e) = call(&app, "PUT", "/api/profiles/1", Some(b)).await;
        assert!(status.is_client_error(), "{bad}: {e}");
    }
    let mut b = p.clone();
    b["latitude"] = json!(60.25);
    let (_, e) = call(&app, "PUT", "/api/profiles/1", Some(b)).await;
    assert_eq!(e["field"], "latitude", "{e}");
    // Optional, as in export files from before it: absent is null.
    let mut b = adult("Lat");
    b["latitude"] = json!(61.5);
    let (status, created) = call(&app, "POST", "/api/profiles", Some(b)).await;
    assert_eq!(
        (status, &created["latitude"]),
        (StatusCode::CREATED, &json!(61.5)),
        "{created}"
    );
    let (status, created) = call(&app, "POST", "/api/profiles", Some(adult("NoLat"))).await;
    assert_eq!(
        (status, &created["latitude"]),
        (StatusCode::CREATED, &Value::Null),
        "{created}"
    );
}

#[tokio::test]
async fn query_errors_name_their_field() {
    let app = app();
    for (query, field) in [
        ("from=x", "from"),
        ("to=2026-02-30", "to"),
        ("from=2026-02-02&to=2026-02-01", "from"),
    ] {
        let (status, e) = call(
            &app,
            "GET",
            &format!("/api/profiles/1/activities?{query}"),
            None,
        )
        .await;
        assert_eq!(
            (status, &e["field"]),
            (StatusCode::BAD_REQUEST, &json!(field)),
            "{query}: {e}"
        );
    }
    // Resource keys are lower case, as every other one.
    let (status, e) = call(&app, "GET", "/api/nope", None).await;
    assert_eq!(
        (status, &e["resource"]),
        (StatusCode::NOT_FOUND, &json!("route")),
        "{e}"
    );
}

/// A create retried after its answer was lost saves once. Each
/// catalogue kind and a profile take an optional `uid`; the same uid
/// again answers the first record (201, same id), the body not read again.
#[tokio::test]
async fn a_create_with_a_uid_answers_the_first() {
    let app = app();
    let oats = create_food(&app, "Oats", json!({ "energy": 380.0 })).await;
    let (_, x) = call(
        &app,
        "POST",
        "/api/exercises",
        Some(json!({ "name": "Towel hang", "measure": "reps" })),
    )
    .await;
    let creates = [
        (
            "/api/foods",
            json!({ "name": "Dup food", "per100": { "energy": 100.0 } }),
        ),
        (
            "/api/recipes",
            json!({ "name": "Dup recipe", "cooked_g": null,
                    "items": [{ "food_id": oats, "grams": 50.0 }] }),
        ),
        (
            "/api/meals",
            json!({ "name": "Dup meal", "items": [{ "food_id": oats, "grams": 50.0 }] }),
        ),
        (
            "/api/workouts",
            json!({ "name": "Dup workout",
                    "steps": [{ "kind": "exercise", "exercise_id": x["id"], "reps": 5 }] }),
        ),
        (
            "/api/exercises",
            json!({ "name": "Dup move", "measure": "reps" }),
        ),
        (
            "/api/profiles",
            json!({ "name": "Dup", "sex": null, "birth_date": null, "height_cm": null,
                    "activity": null, "goal_kg_per_week": 0.0 }),
        ),
    ];
    for (i, (uri, body)) in creates.into_iter().enumerate() {
        let mut body = body;
        body["uid"] = json!(format!("create-uid-000{i}"));
        let (status, first) = call(&app, "POST", uri, Some(body.clone())).await;
        assert_eq!(status, StatusCode::CREATED, "{uri}: {first}");
        // A retry may differ (the form was edited meanwhile): the first
        // record answers, unchanged.
        body["name"] = json!("Edited");
        let (status, again) = call(&app, "POST", uri, Some(body)).await;
        assert_eq!(status, StatusCode::CREATED, "{uri}: {again}");
        assert_eq!(again["id"], first["id"], "{uri}");
        assert_eq!(again["name"], first["name"], "{uri}");
    }
    let (status, err) = call(
        &app,
        "POST",
        "/api/foods",
        Some(json!({ "name": "Bad", "uid": "no spaces allowed" })),
    )
    .await;
    assert_eq!(
        (status, &err["field"]),
        (StatusCode::BAD_REQUEST, &json!("uid"))
    );
}

/// A bad nutrient names `per100`, and a date in the right
/// shape that is no date says so, not that its shape is wrong.
#[tokio::test]
async fn errors_name_their_field_and_a_date_that_isnt_one() {
    let app = app();
    for per100 in [json!({ "protien": 1.0 }), json!({ "protein": -1.0 })] {
        let (status, err) = call(
            &app,
            "POST",
            "/api/foods",
            Some(json!({ "name": "F", "per100": per100 })),
        )
        .await;
        assert_eq!(
            (status, &err["field"]),
            (StatusCode::BAD_REQUEST, &json!("per100")),
            "{err}"
        );
    }
    let oats = create_food(&app, "Oats", json!({ "energy": 380.0 })).await;
    let (status, err) = call(
        &app,
        "POST",
        "/api/profiles/1/entries",
        Some(json!({ "day": "2026-13-01", "group": "Eaten", "food_id": oats, "grams": 50.0 })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{err}");
    assert!(
        err["error"].as_str().unwrap().contains("real date"),
        "{err}"
    );
    let (status, err) = call(&app, "GET", "/api/profiles/1/day/2026-13-01", None).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{err}");
    assert!(
        err["error"].as_str().unwrap().contains("real date"),
        "{err}"
    );
}
