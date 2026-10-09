//! The food library: recipe portions and instructions, the best-fit sort,
//! food usage and merging duplicates.

use super::*;

/// A recipe of `items` (`[(food_id, grams)]`) plus `extra` keys; its body.
async fn recipe(app: &Router, name: &str, items: &[(i64, f64)], extra: Value) -> Value {
    let mut body = json!({
        "name": name,
        "items": items.iter().map(|(id, g)| json!({ "food_id": id, "grams": g })).collect::<Vec<_>>(),
    });
    body.as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    let (status, recipe) = call(app, "POST", "/api/recipes", Some(body)).await;
    assert_eq!(status, StatusCode::CREATED, "{recipe}");
    recipe
}

fn serving(food: &Value, label: &str) -> Option<f64> {
    food["servings"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["label"] == label)
        .map(|s| s["grams"].as_f64().unwrap())
}

fn labels(food: &Value) -> Vec<&str> {
    food["servings"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["label"].as_str().unwrap())
        .collect()
}

// ------------------------------------------- recipes: portions, instructions

#[tokio::test]
async fn a_recipe_making_portions_has_a_portion_serving_that_follows_it() {
    let app = app();
    let oats = create_food(&app, "Oats", json!({ "energy": 380 })).await;
    let milk = create_food(&app, "Milk", json!({ "energy": 50 })).await;
    let porridge = recipe(
        &app,
        "Porridge",
        &[(oats, 100.0), (milk, 300.0)],
        json!({ "makes": 4 }),
    )
    .await;
    assert_eq!(porridge["makes"], 4);
    assert_eq!(serving(&porridge, "Portion"), Some(100.0), "400 g ÷ 4");
    assert_eq!(labels(&porridge), ["Whole recipe", "Portion"]);

    // Item and cooked-weight edits move it; its place is yours.
    let uri = format!("/api/recipes/{}", porridge["id"]);
    let (status, saved) = put_with_rev(
        &app,
        &uri,
        json!({
            "name": "Porridge", "makes": 4, "cooked_g": 600,
            "items": [{ "food_id": oats, "grams": 100 }, { "food_id": milk, "grams": 500 }],
            "servings": [{ "label": "Portion", "grams": 1 }, { "label": "Whole recipe", "grams": 1 }],
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    assert_eq!(serving(&saved, "Portion"), Some(150.0), "600 g cooked ÷ 4");
    assert_eq!(labels(&saved), ["Portion", "Whole recipe"]);

    // Without makes it goes, whatever the client sent.
    let (status, saved) = put_with_rev(
        &app,
        &uri,
        json!({
            "name": "Porridge", "makes": null,
            "items": [{ "food_id": oats, "grams": 100 }],
            "servings": saved["servings"],
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    assert_eq!(saved["makes"], Value::Null);
    assert_eq!(labels(&saved), ["Whole recipe"]);

    // Plain foods make nothing.
    let (_, food) = call(&app, "GET", &format!("/api/foods/{oats}"), None).await;
    assert_eq!(food["makes"], Value::Null);
}

#[tokio::test]
async fn a_portion_follows_a_nested_recipe_and_makes_is_bounded() {
    let app = app();
    let flour = create_food(&app, "Flour", json!({ "energy": 360 })).await;
    let dough = recipe(&app, "Dough", &[(flour, 500.0)], json!({ "makes": 5 })).await;
    assert_eq!(serving(&dough, "Portion"), Some(100.0));
    for bad in [json!(0), json!(101), json!(2.5), json!("4")] {
        let (status, err) = call(
            &app,
            "POST",
            "/api/recipes",
            Some(
                json!({ "name": "Bad", "makes": bad, "items": [{ "food_id": flour, "grams": 1 }] }),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{bad}: {err}");
        assert_eq!(err["field"], "makes", "{bad}: {err}");
    }
}

#[tokio::test]
async fn recipe_instructions_keep_lines_and_are_bounded() {
    let app = app();
    let text = "1. Boil the water.\r\n\t2. Stir in the oats.\n\n3. Eat.";
    let (status, r) = porridge(&app, json!(format!("  {text}  "))).await;
    assert_eq!(status, StatusCode::CREATED, "{r}");
    assert_eq!(
        r["instructions"], "1. Boil the water.\n\t2. Stir in the oats.\n\n3. Eat.",
        "trimmed, CRLF read as LF, tabs and blank lines kept"
    );
    let uri = format!("/api/recipes/{}", r["id"]);
    let (_, got) = call(&app, "GET", &uri, None).await;
    assert_eq!(got["instructions"], r["instructions"]);
    // The food read shows them too.
    let (_, food) = call(&app, "GET", &format!("/api/foods/{}", r["id"]), None).await;
    assert_eq!(food["instructions"], r["instructions"]);

    // Exactly the limit passes; one more, or a sneaky character, is refused.
    let max = "a".repeat(10_000);
    let (status, r) = porridge(&app, json!(max)).await;
    assert_eq!(status, StatusCode::CREATED, "{r}");
    for bad in [
        "a".repeat(10_001),
        "Stir\u{1b}[2J".to_owned(),
        "a\u{202e}b".to_owned(),
        "a\rb".to_owned(),
    ] {
        let (status, e) = porridge(&app, json!(bad)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{e}");
        assert_eq!(e["field"], "instructions", "{e}");
    }

    // Blank or left out is none; an update replaces them.
    let (_, r) = porridge(&app, json!("  \n ")).await;
    assert_eq!(r["instructions"], Value::Null);
    let (_, r) = porridge(&app, Value::Null).await;
    assert_eq!(r["instructions"], Value::Null);
    let uri = format!("/api/recipes/{}", r["id"]);
    let (status, r) = put_with_rev(
        &app,
        &uri,
        json!({ "name": "Porridge", "cooked_g": null, "instructions": "Boil.",
                "items": r["items"].as_array().unwrap().iter()
                    .map(|i| json!({ "food_id": i["food_id"], "grams": i["grams"] }))
                    .collect::<Vec<_>>() }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{r}");
    assert_eq!(r["instructions"], "Boil.");

    // Plain foods have none.
    let id = create_food(&app, "Milk", json!({})).await;
    let (_, food) = call(&app, "GET", &format!("/api/foods/{id}"), None).await;
    assert_eq!(food["instructions"], Value::Null);
}

// ------------------------------------------------------------ best-fit sort

/// Profile 1's targets: 2000 kcal, 150 g protein, 200 g carbohydrate,
/// 60 g fat.
async fn macro_targets(app: &Router) {
    let (status, res) = put_targets(
        app,
        1,
        json!([{ "metric": "energy", "value": 2000 }, { "metric": "protein", "value": 150 },
               { "metric": "net_carbs", "value": 200 }, { "metric": "fat", "value": 60 }]),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{res}");
}

#[tokio::test]
async fn best_fit_ranks_by_what_is_left_of_the_day() {
    let app = app();
    let (status, err) = search(&app, "sort=fit").await;
    assert_eq!(
        (status, &err["field"]),
        (StatusCode::BAD_REQUEST, &json!("day"))
    );
    let (status, err) = search(&app, "sort=fit&day=2026-13-01").await;
    assert_eq!(
        (status, &err["field"]),
        (StatusCode::BAD_REQUEST, &json!("day"))
    );
    let (status, err) = search(&app, &format!("sort=fit&day={DAY}")).await;
    assert_eq!(
        (status, &err["field"]),
        (StatusCode::BAD_REQUEST, &json!("sort")),
        "no energy target: {err}"
    );

    macro_targets(&app).await;
    // The day's carbohydrate and fat are eaten (one planned): protein is left.
    let bread = create_food(
        &app,
        "Fit bread",
        json!({ "energy": 250, "net_carbs": 50, "fat": 2, "protein": 8 }),
    )
    .await;
    let oil = create_food(&app, "Fit oil", json!({ "energy": 900, "fat": 100 })).await;
    log_entry(&app, "Consumed", bread, 380.0).await;
    log_entry(&app, "Planned", oil, 50.0).await;

    let chicken = json!({ "energy": 110, "protein": 23, "fat": 1.5 });
    create_food(&app, "Fit chicken", chicken.clone()).await;
    create_food(
        &app,
        "Fit rice",
        json!({ "energy": 130, "net_carbs": 28, "protein": 3 }),
    )
    .await;
    create_food(&app, "Fit butter", json!({ "energy": 740, "fat": 82 })).await;
    create_food(&app, "Fit water", json!({})).await;
    // As fitting as the chicken, but a serving is more than the energy left.
    let (_, big) = call(
        &app,
        "POST",
        "/api/foods",
        Some(json!({ "name": "Fit chicken tray", "per100": chicken,
                     "servings": [{ "label": "Tray", "grams": 2000 }] })),
    )
    .await;
    assert_eq!(big["name"], "Fit chicken tray");

    let (status, found) = search(&app, &format!("q=fit&sort=fit&day={DAY}")).await;
    assert_eq!(status, StatusCode::OK, "{found}");
    let order = food_names(&found);
    assert_eq!(order[0], "Fit chicken", "{order:?}");
    assert_eq!(
        order.last(),
        Some(&"Fit water"),
        "no energy last: {order:?}"
    );
    let at = |n: &str| order.iter().position(|x| *x == n).unwrap();
    assert!(at("Fit rice") < at("Fit butter"), "{order:?}");
    assert!(
        at("Fit chicken tray") > at("Fit rice"),
        "too big: {order:?}"
    );
}

#[test]
fn fit_scores_cosine_and_the_energy_penalty() {
    use kaloriina::model::{Macros, fit_score};
    let m = |energy, protein, net_carbs, fat| Macros {
        energy,
        protein,
        net_carbs,
        fat,
    };
    let left = m(500.0, 50.0, 0.0, 0.0);
    let same = fit_score(&m(100.0, 25.0, 0.0, 0.0), 100.0, &left).unwrap();
    assert!((same - 1.0).abs() < 1e-9, "{same}");
    let other = fit_score(&m(900.0, 0.0, 0.0, 100.0), 10.0, &left).unwrap();
    assert!(other.abs() < 1e-9, "{other}");
    let too_big = fit_score(&m(100.0, 25.0, 0.0, 0.0), 600.0, &left).unwrap();
    assert!((too_big - 0.0).abs() < 1e-9, "{too_big}");
    // Over a target counts as nothing left of it.
    let over = fit_score(
        &m(100.0, 0.0, 25.0, 0.0),
        100.0,
        &m(500.0, 50.0, -30.0, 0.0),
    )
    .unwrap();
    assert!(over.abs() < 1e-9, "{over}");
    assert_eq!(fit_score(&m(f64::NAN, 1.0, 1.0, 1.0), 100.0, &left), None);
}

// ------------------------------------------------ food usage and merging

#[tokio::test]
async fn usage_counts_what_a_merge_would_move() {
    let app = app();
    let (status, err) = call(&app, "GET", "/api/foods/999/usage", None).await;
    assert_eq!(
        (status, &err["resource"]),
        (StatusCode::NOT_FOUND, &json!("food"))
    );
    let rye = create_food(&app, "Rye", json!({ "energy": 250 })).await;
    log_entry(&app, "Consumed", rye, 50.0).await;
    log_entry(&app, "Planned", rye, 50.0).await;
    recipe(&app, "Toast", &[(rye, 60.0)], json!({})).await;
    let (status, _) = call(
        &app,
        "POST",
        "/api/meals",
        Some(json!({ "name": "Lunch", "items": [{ "food_id": rye, "grams": 80 }] })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    call(
        &app,
        "POST",
        "/api/profiles/1/foods/favorites",
        Some(json!({ "food_id": rye })),
    )
    .await;
    let (status, usage) = call(&app, "GET", &format!("/api/foods/{rye}/usage"), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        usage,
        json!({ "entries": 2, "recipes": 1, "meals": 1, "favorites": 1 })
    );
}

/// "Oat milk" (kept, a Glass) and its duplicate "Oatmilk" (a barcode, a
/// glass and a Carton): the kept food and the duplicate's id.
async fn oat_milks(app: &Router) -> (Value, i64) {
    let (_, keep) = call(
        app,
        "POST",
        "/api/foods",
        Some(json!({ "name": "Oat milk", "per100": { "energy": 50 },
                     "servings": [{ "label": "Glass", "grams": 200 }] })),
    )
    .await;
    let (_, dup) = call(
        app,
        "POST",
        "/api/foods",
        Some(json!({ "name": "Oatmilk", "barcode": "6411111111111", "per100": { "energy": 40 },
                     "servings": [{ "label": "glass", "grams": 250 }, { "label": "Carton", "grams": 1000 }] })),
    )
    .await;
    (keep, dup["id"].as_i64().unwrap())
}

#[tokio::test]
async fn a_merge_names_the_kept_foods_rev() {
    let app = app();
    let (keep, b) = oat_milks(&app).await;
    let uri = format!("/api/foods/{}/merge", keep["id"]);
    let (status, err) = call(&app, "POST", &uri, Some(json!({ "from": b, "rev": 99 }))).await;
    assert_eq!(
        (status, &err["code"]),
        (StatusCode::CONFLICT, &json!("stale"))
    );
    let (status, err) = call(&app, "POST", &uri, Some(json!({ "from": b }))).await;
    assert_eq!(
        (status, &err["field"]),
        (StatusCode::BAD_REQUEST, &json!("rev"))
    );
    let (status, _) = call(&app, "GET", &format!("/api/foods/{b}"), None).await;
    assert_eq!(status, StatusCode::OK, "nothing moved");
}

#[tokio::test]
async fn merging_moves_everything_onto_the_kept_food() {
    let app = app();
    let (keep, b) = oat_milks(&app).await;
    let a = keep["id"].as_i64().unwrap();
    let logged = log_entry(&app, "Consumed", b, 100.0).await;
    let (_, other) = call(
        &app,
        "POST",
        "/api/profiles",
        Some(
            json!({ "name": "Other", "sex": null, "birth_date": null, "height_cm": null,
                     "activity": null, "goal_kg_per_week": 0 }),
        ),
    )
    .await;
    let other = other["id"].as_i64().unwrap();
    for (pid, food) in [(1, a), (1, b), (other, b)] {
        let (status, _) = call(
            &app,
            "POST",
            &format!("/api/profiles/{pid}/foods/favorites"),
            Some(json!({ "food_id": food })),
        )
        .await;
        assert_eq!(status, StatusCode::NO_CONTENT);
    }
    let latte = recipe(&app, "Latte", &[(a, 100.0), (b, 100.0)], json!({})).await;
    assert_eq!(latte["per100"]["energy"], 45.0);
    let outer = recipe(
        &app,
        "Latte bowl",
        &[(latte["id"].as_i64().unwrap(), 200.0)],
        json!({}),
    )
    .await;
    let (_, meal) = call(
        &app,
        "POST",
        "/api/meals",
        Some(json!({ "name": "Breakfast", "items": [{ "food_id": b, "grams": 300 }] })),
    )
    .await;

    let uri = format!("/api/foods/{a}/merge");
    let (status, merged) = call(
        &app,
        "POST",
        &uri,
        Some(json!({ "from": b, "rev": keep["rev"] })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{merged}");
    assert_eq!(merged["id"], a);
    assert_eq!(merged["rev"], keep["rev"].as_i64().unwrap() + 1);
    assert_eq!(merged["barcode"], "6411111111111", "the barcode moves");
    assert_eq!(labels(&merged), ["Glass", "Carton"], "labels ignore case");
    assert_eq!(merged["per100"]["energy"], 50.0, "A keeps its values");

    let (status, err) = call(&app, "GET", &format!("/api/foods/{b}"), None).await;
    assert_eq!(
        (status, &err["resource"]),
        (StatusCode::NOT_FOUND, &json!("food"))
    );
    // The entry points at A and keeps what it was logged with.
    let (_, entry) = call(
        &app,
        "GET",
        &format!("/api/profiles/1/entries/{}", logged["id"]),
        None,
    )
    .await;
    assert_eq!(entry["food_id"], a);
    assert_eq!(entry["nutrients"], logged["nutrients"]);
    for pid in [1, other] {
        let (_, favs) = call(
            &app,
            "GET",
            &format!("/api/profiles/{pid}/foods/favorites"),
            None,
        )
        .await;
        assert_eq!(food_names(&favs), ["Oat milk"], "profile {pid}");
    }
    // A twice in the recipe: one row, grams summed, values recalculated
    // with A's, and the recipe using it follows.
    let (_, latte_now) = call(&app, "GET", &format!("/api/recipes/{}", latte["id"]), None).await;
    assert_eq!(
        latte_now["items"],
        json!([{ "food_id": a, "grams": 200.0, "name": "Oat milk",
                                            "source": "custom", "per100": { "energy": 50.0 } }])
    );
    assert_eq!(latte_now["per100"]["energy"], 50.0);
    assert_eq!(latte_now["rev"], latte["rev"].as_i64().unwrap() + 1);
    let (_, outer_now) = call(&app, "GET", &format!("/api/recipes/{}", outer["id"]), None).await;
    assert_eq!(outer_now["per100"]["energy"], 50.0);
    let (_, meal_now) = call(&app, "GET", &format!("/api/meals/{}", meal["id"]), None).await;
    assert_eq!(meal_now["items"][0]["food_id"], a);
    assert_eq!(meal_now["rev"], meal["rev"].as_i64().unwrap() + 1);
    let (_, usage) = call(&app, "GET", &format!("/api/foods/{a}/usage"), None).await;
    assert_eq!(
        usage,
        json!({ "entries": 1, "recipes": 1, "meals": 1, "favorites": 2 })
    );

    // B's id is never handed out again.
    let next = create_food(&app, "Fresh", json!({})).await;
    assert!(next > b, "{next} reuses {b}");
}

#[tokio::test]
async fn merge_refusals_name_their_reason() {
    let app = app();
    let food = |name: &'static str, barcode: Option<&'static str>| {
        let app = app.clone();
        async move {
            let (status, f) = call(
                &app,
                "POST",
                "/api/foods",
                Some(json!({ "name": name, "barcode": barcode, "per100": { "energy": 10 } })),
            )
            .await;
            assert_eq!(status, StatusCode::CREATED, "{f}");
            f["id"].as_i64().unwrap()
        }
    };
    let a = food("Kept", Some("6400000000001")).await;
    let b = food("Duplicate", Some("6400000000002")).await;
    let plain = food("Plain", None).await;
    let inner = recipe(&app, "Inner", &[(plain, 10.0)], json!({})).await["id"]
        .as_i64()
        .unwrap();
    let outer = recipe(&app, "Outer", &[(inner, 10.0)], json!({})).await["id"]
        .as_i64()
        .unwrap();

    let merge = |into: i64, from: i64| {
        let app = app.clone();
        async move {
            let uri = format!("/api/foods/{into}");
            let (_, current) = call(&app, "GET", &uri, None).await;
            call(
                &app,
                "POST",
                &format!("{uri}/merge"),
                Some(json!({ "from": from, "rev": current["rev"] })),
            )
            .await
        }
    };
    let (status, err) = merge(a, b).await;
    assert_eq!(
        (status, &err["code"]),
        (StatusCode::CONFLICT, &json!("barcode_taken"))
    );
    for (into, from, why) in [
        (a, a, "itself"),
        (a, 999, "unknown"),
        (plain, inner, "a food and a recipe"),
        (inner, plain, "a recipe and a food"),
        (outer, inner, "a recipe holding the other"),
    ] {
        let (status, err) = merge(into, from).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{why}: {err}");
        assert_eq!(err["field"], "from", "{why}: {err}");
    }
    let (status, err) = call(
        &app,
        "POST",
        "/api/foods/999/merge",
        Some(json!({ "from": a, "rev": 1 })),
    )
    .await;
    assert_eq!(
        (status, &err["resource"]),
        (StatusCode::NOT_FOUND, &json!("food"))
    );
    // Recipes merge with recipes; the inner one may go into the outer one's
    // place the other way round.
    let (status, merged) = merge(inner, outer).await;
    assert_eq!(status, StatusCode::OK, "{merged}");
}

/// An app with the Fineli fixture: one food, "Maito, rasvaton".
fn fineli_app() -> Router {
    let mut conn = open(FsPath::new(":memory:")).unwrap();
    let dir = FsPath::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fineli");
    kaloriina::fineli::store(&mut conn, &kaloriina::fineli::read(&dir).unwrap()).unwrap();
    app_from(conn, NO_OFF)
}

#[tokio::test]
async fn a_fineli_food_is_merged_into_never_away() {
    let app = fineli_app();
    let (_, found) = search(&app, "q=maito&sources=fineli").await;
    let fineli = found[0]["id"].as_i64().unwrap();
    let mine = create_food(&app, "My skim milk", json!({ "energy": 35 })).await;
    let (_, current) = call(&app, "GET", &format!("/api/foods/{mine}"), None).await;
    let (status, err) = call(
        &app,
        "POST",
        &format!("/api/foods/{mine}/merge"),
        Some(json!({ "from": fineli, "rev": current["rev"] })),
    )
    .await;
    assert_eq!(
        (status, &err["code"]),
        (StatusCode::CONFLICT, &json!("base_read_only"))
    );
    let (_, current) = call(&app, "GET", &format!("/api/foods/{fineli}"), None).await;
    let (status, merged) = call(
        &app,
        "POST",
        &format!("/api/foods/{fineli}/merge"),
        Some(json!({ "from": mine, "rev": current["rev"] })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{merged}");
    assert_eq!(merged["source"], "fineli");
}

fn food_names(list: &Value) -> Vec<&str> {
    list.as_array()
        .unwrap()
        .iter()
        .map(|f| f["name"].as_str().unwrap())
        .collect()
}
