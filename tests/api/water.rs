//! The water food "+ Water" logs: the default, a pick of your own, and the
//! day naming it.

use super::*;

const WATER: &str = "/api/profiles/1/water-food";

#[tokio::test]
async fn water_food_defaults_and_can_be_chosen() {
    let app = app();
    // A fresh instance: the seeded Water, not a pick.
    let (status, w) = call(&app, "GET", WATER, None).await;
    assert_eq!(status, StatusCode::OK, "{w}");
    assert_eq!(w["chosen"], false);
    assert_eq!(w["food"]["name"], "Water");
    assert_eq!(w["food"]["per100"]["water"], 100.0);
    let seeded = w["food"]["id"].clone();

    // Pick another; the same PUT twice is the same.
    let mine = create_food(&app, "Sparkling water", json!({ "water": 99.9 })).await;
    for _ in 0..2 {
        let (status, w) = call(&app, "PUT", WATER, Some(json!({ "food_id": mine }))).await;
        assert_eq!(status, StatusCode::OK, "{w}");
        assert_eq!(
            (w["chosen"].clone(), w["food"]["id"].clone()),
            (json!(true), json!(mine))
        );
    }
    let (_, w) = call(&app, "GET", WATER, None).await;
    assert_eq!(w["food"]["id"], mine);

    // Unknown foods are refused, naming the field; the key must be sent.
    let (status, e) = call(&app, "PUT", WATER, Some(json!({ "food_id": 999_999 }))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{e}");
    assert_eq!(e["field"], "food_id");
    let (status, e) = call(&app, "PUT", WATER, Some(json!({}))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{e}");
    assert_eq!(e["field"], "food_id");

    // Back to the default.
    let (_, w) = call(&app, "PUT", WATER, Some(json!({ "food_id": null }))).await;
    assert_eq!(
        (w["chosen"].clone(), w["food"]["id"].clone()),
        (json!(false), seeded)
    );

    // A missing profile is 404.
    let (status, e) = call(&app, "GET", "/api/profiles/99/water-food", None).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{e}");
    assert_eq!(e["resource"], "profile");

    // The ml limits are served.
    let (_, meta) = call(&app, "GET", "/api/meta", None).await;
    assert_eq!(meta["limits"]["water_ml"], json!([1.0, 5000.0]));
    assert_eq!(meta["limits"]["instructions"], 10_000);
}

#[tokio::test]
async fn the_day_names_the_water_food() {
    let app = app();
    let day = |app: &Router| {
        let app = app.clone();
        async move {
            call(&app, "GET", "/api/profiles/1/day/2026-09-02", None)
                .await
                .1
        }
    };
    let (_, w) = call(&app, "GET", WATER, None).await;
    assert_eq!(day(&app).await["water_food_id"], w["food"]["id"]);
    let mine = create_food(&app, "Sparkling water", json!({ "water": 99.9 })).await;
    call(&app, "PUT", WATER, Some(json!({ "food_id": mine }))).await;
    assert_eq!(day(&app).await["water_food_id"], json!(mine));
}
