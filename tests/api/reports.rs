//! Reports: where a nutrient came from (`/summary/foods`).

use super::*;
use crate::common::ME;

const FROM_TO: &str = "from=2026-10-01&to=2026-10-07";

async fn sources(app: &Router, query: &str) -> (StatusCode, Value) {
    call(
        app,
        "GET",
        &format!("/api/profiles/1/summary/foods?{query}"),
        None,
    )
    .await
}

/// A diary with imported history (500 mg sodium eaten on DAY).
fn app_with_history() -> Router {
    let mut conn = open(FsPath::new(":memory:")).unwrap();
    let summary = format!("Date,Group,Sodium (mg),Completed\n{DAY},Consumed,500,true\n");
    common::import_summary(&mut conn, ME, summary.as_bytes()).unwrap();
    app_from(conn, NO_OFF)
}

#[tokio::test]
async fn nutrient_sources_rank_eaten_foods_and_leave_history_unattributed() {
    let app = app_with_history();
    let salty = create_food(&app, "Salty", json!({ "sodium": 1000.0 })).await;
    let mild = create_food(&app, "Mild", json!({ "sodium": 100.0 })).await;
    let plain = create_food(&app, "Plain", json!({ "energy": 50.0 })).await;
    let lunch = create_food(&app, "Lunch out", json!({ "sodium": 150.0 })).await;
    log_entry(&app, "Consumed", lunch, 100.0).await; // 150 mg
    log_entry(&app, "Consumed", lunch, 100.0).await; // 150 mg
    log_entry(&app, "Consumed", salty, 50.0).await; // 500 mg
    log_entry(&app, "Consumed", salty, 30.0).await; // 300 mg
    log_entry(&app, "Consumed", mild, 200.0).await; // 200 mg
    log_entry(&app, "Consumed", plain, 100.0).await; // no sodium
    log_entry(&app, "Planned", salty, 500.0).await; // not eaten

    let (status, res) = sources(&app, &format!("{FROM_TO}&nutrient=sodium")).await;
    assert_eq!(status, StatusCode::OK, "{res}");
    assert_eq!(res["nutrient"], "sodium");
    assert_eq!(res["total"], 1800.0, "foods and history");
    assert_eq!(res["unattributed"], 500.0, "the imported total");
    let foods = res["foods"].as_array().unwrap();
    let rows: Vec<_> = foods
        .iter()
        .map(|f| (f["food_id"].clone(), f["name"].clone(), f["amount"].clone()))
        .collect();
    assert_eq!(
        rows,
        [
            (json!(salty), json!("Salty"), json!(800.0)),
            (json!(lunch), json!("Lunch out"), json!(300.0)),
            (json!(mild), json!("Mild"), json!(200.0)),
        ],
        "summed per food, largest first; none without it"
    );
    let shares: f64 = foods.iter().map(|f| f["share"].as_f64().unwrap()).sum();
    assert!((foods[0]["share"].as_f64().unwrap() - 800.0 / 1800.0).abs() < 1e-9);
    assert!(shares <= 1.0, "{shares}");

    // The Summary's average for the same range is built from the same total.
    let (_, summary) = call(
        &app,
        "GET",
        &format!("/api/profiles/1/summary?{FROM_TO}"),
        None,
    )
    .await;
    assert_eq!(summary["days"][0]["total"]["sodium"], res["total"]);
}

#[tokio::test]
async fn nutrient_sources_list_at_most_twenty() {
    let app = app();
    for i in 0..25 {
        let f = create_food(&app, &format!("Food {i:02}"), json!({ "protein": 10.0 })).await;
        log_entry(&app, "Consumed", f, f64::from(10 + i)).await;
    }
    let (_, res) = sources(&app, &format!("{FROM_TO}&nutrient=protein")).await;
    let foods = res["foods"].as_array().unwrap();
    assert_eq!(foods.len(), 20);
    assert_eq!(foods[0]["name"], "Food 24");
    assert_eq!(
        res["unattributed"], 0.0,
        "the rest are named, just not listed"
    );
}

#[tokio::test]
async fn nutrient_sources_refuse_bad_queries() {
    let app = app();
    let (status, res) = sources(&app, &format!("{FROM_TO}&nutrient=nope")).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(res["field"], "nutrient");
    let (status, res) = sources(&app, FROM_TO).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(res["field"], "nutrient");
    let (status, res) = sources(&app, "from=2026-10-01&nutrient=sodium").await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{res}");
    assert_eq!(res["code"], "invalid");
    let (status, _) = sources(&app, "from=2026-10-07&to=2026-10-01&nutrient=sodium").await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, res) = call(
        &app,
        "GET",
        &format!("/api/profiles/99/summary/foods?{FROM_TO}&nutrient=sodium"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(res["resource"], "profile");
}
