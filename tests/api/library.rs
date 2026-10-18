//! The food library: recipe portions and notes, the best-fit sort,
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

// -------------------------------------------- recipes: portions, notes

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
async fn a_recipes_food_read_lists_its_items() {
    let app = app();
    let oats = create_food(&app, "Oats", json!({ "energy": 380 })).await;
    let milk = create_food(&app, "Milk", json!({ "energy": 50 })).await;
    let r = recipe(
        &app,
        "Porridge",
        &[(oats, 100.0), (milk, 300.0)],
        json!({ "makes": 2 }),
    )
    .await;
    let (status, food) = call(&app, "GET", &format!("/api/foods/{}", r["id"]), None).await;
    assert_eq!(status, StatusCode::OK, "{food}");
    let (_, full) = call(&app, "GET", &format!("/api/recipes/{}", r["id"]), None).await;
    assert_eq!(food["items"], full["items"], "the recipe read's shape");
    assert_eq!(food["items"][1]["name"], "Milk");
    assert_eq!(food["makes"], 2);
    // A plain food has no items.
    let (_, plain) = call(&app, "GET", &format!("/api/foods/{oats}"), None).await;
    assert!(plain.get("items").is_none(), "{plain}");
}

#[tokio::test]
async fn recipe_notes_keep_lines_and_are_bounded() {
    let app = app();
    let text = "1. Boil the water.\r\n\t2. Stir in the oats.\n\n3. Eat.";
    let (status, r) = porridge(&app, json!(format!("  {text}  "))).await;
    assert_eq!(status, StatusCode::CREATED, "{r}");
    assert_eq!(
        r["notes"], "1. Boil the water.\n\t2. Stir in the oats.\n\n3. Eat.",
        "trimmed, CRLF read as LF, tabs and blank lines kept"
    );
    let uri = format!("/api/recipes/{}", r["id"]);
    let (_, got) = call(&app, "GET", &uri, None).await;
    assert_eq!(got["notes"], r["notes"]);
    // The food read shows them too.
    let (_, food) = call(&app, "GET", &format!("/api/foods/{}", r["id"]), None).await;
    assert_eq!(food["notes"], r["notes"]);

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
        assert_eq!(e["field"], "notes", "{e}");
    }

    // Blank or left out is none; an update replaces them.
    let (_, r) = porridge(&app, json!("  \n ")).await;
    assert_eq!(r["notes"], Value::Null);
    let (_, r) = porridge(&app, Value::Null).await;
    assert_eq!(r["notes"], Value::Null);
    let uri = format!("/api/recipes/{}", r["id"]);
    let (status, r) = put_with_rev(
        &app,
        &uri,
        json!({ "name": "Porridge", "cooked_g": null, "notes": "Boil.",
                "items": r["items"].as_array().unwrap().iter()
                    .map(|i| json!({ "food_id": i["food_id"], "grams": i["grams"] }))
                    .collect::<Vec<_>>() }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{r}");
    assert_eq!(r["notes"], "Boil.");

    // Plain foods have none.
    let id = create_food(&app, "Milk", json!({})).await;
    let (_, food) = call(&app, "GET", &format!("/api/foods/{id}"), None).await;
    assert_eq!(food["notes"], Value::Null);
}

// ------------------------------------------------------- best-fit sort

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
    log_entry(&app, "Eaten", bread, 380.0).await;
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

// ---------------------------------------------- food usage and merging

#[tokio::test]
async fn usage_counts_what_a_merge_would_move() {
    let app = app();
    let (status, err) = call(&app, "GET", "/api/foods/999/usage", None).await;
    assert_eq!(
        (status, &err["resource"]),
        (StatusCode::NOT_FOUND, &json!("food"))
    );
    let rye = create_food(&app, "Rye", json!({ "energy": 250 })).await;
    log_entry(&app, "Eaten", rye, 50.0).await;
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
    let eaten = log_entry(&app, "Eaten", rye, 30.0).await;
    let (status, res) = call(
        &app,
        "PATCH",
        &format!("/api/profiles/1/entries/{}", eaten["key"].as_str().unwrap()),
        Some(json!({ "repeat": { "start": DAY } })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{res}");
    let (status, res) = call(
        &app,
        "PUT",
        "/api/profiles/1/water-food",
        Some(json!({ "food_id": rye })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{res}");
    let (status, usage) = call(&app, "GET", &format!("/api/foods/{rye}/usage"), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        usage,
        json!({ "entries": 3, "recipes": 1, "meals": 1, "favorites": 1, "daily_items": 1,
                "water": 1, "deletable": false })
    );
}

// -------------------------------------------------------------- delete

/// DELETE a food, and what `usage.deletable` said of it: the two agree.
async fn delete_verdict(app: &Router, id: i64) -> (StatusCode, Value) {
    let (_, usage) = call(app, "GET", &format!("/api/foods/{id}/usage"), None).await;
    let (status, res) = call(app, "DELETE", &format!("/api/foods/{id}"), None).await;
    assert_eq!(
        usage["deletable"],
        json!(status == StatusCode::NO_CONTENT),
        "{usage} {status} {res}"
    );
    (status, res)
}

/// A food or recipe nothing uses goes on DELETE (a favourite goes with
/// it); one in use is archived instead (409 `food_in_use`), and a Fineli
/// food, which `kaloriina fineli` would add again, isn't yours to delete.
#[tokio::test]
async fn a_food_is_deleted_only_while_nothing_uses_it() {
    let app = app();
    let stray = create_food(&app, "Stray (copy)", json!({ "energy": 100 })).await;
    call(
        &app,
        "POST",
        "/api/profiles/1/foods/favorites",
        Some(json!({ "food_id": stray })),
    )
    .await;
    let (status, res) = delete_verdict(&app, stray).await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{res}");
    let (status, _) = call(&app, "GET", &format!("/api/foods/{stray}"), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (_, favorites) = call(&app, "GET", "/api/profiles/1/foods/favorites", None).await;
    assert_eq!(favorites, json!([]));

    let rye = create_food(&app, "Rye", json!({ "energy": 250 })).await;
    let toast = recipe(&app, "Toast", &[(rye, 60.0)], json!({})).await["id"]
        .as_i64()
        .unwrap();
    let water = create_food(&app, "Spring water", json!({ "water": 100 })).await;
    call(
        &app,
        "PUT",
        "/api/profiles/1/water-food",
        Some(json!({ "food_id": water })),
    )
    .await;
    let logged = create_food(&app, "Logged", json!({ "energy": 100 })).await;
    log_entry(&app, "Eaten", logged, 50.0).await;
    for used in [rye, water, logged] {
        let (status, err) = delete_verdict(&app, used).await;
        assert_eq!(
            (status, &err["code"]),
            (StatusCode::CONFLICT, &json!("food_in_use")),
            "{err}"
        );
        assert!(err["error"].as_str().unwrap().contains("rchive"), "{err}");
    }
    // A recipe nothing uses goes; its ingredient stays (still the
    // recipe's until then).
    let (status, res) = delete_verdict(&app, toast).await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{res}");
    let (status, _) = call(&app, "GET", &format!("/api/foods/{rye}"), None).await;
    assert_eq!(status, StatusCode::OK);
    let (_, usage) = call(&app, "GET", &format!("/api/foods/{rye}/usage"), None).await;
    assert_eq!(usage["deletable"], true, "{usage}");

    let fineli = fineli_app();
    let (_, found) = search(&fineli, "q=maito&sources=fineli").await;
    let milk = found[0]["id"].as_i64().unwrap();
    let (status, err) = delete_verdict(&fineli, milk).await;
    assert_eq!(
        (status, &err["code"]),
        (StatusCode::CONFLICT, &json!("base_read_only")),
        "{err}"
    );
    let (status, err) = call(&app, "DELETE", "/api/foods/999", None).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{err}");
}

// ---------------------------------------------------------------- copy

/// POST a copy of `what` (`foods`, `meals`, `workouts`) `id` with `body`.
async fn copy(app: &Router, what: &str, id: &Value, body: Value) -> Value {
    let (status, copy) = call(app, "POST", &format!("/api/{what}/{id}/copy"), Some(body)).await;
    assert_eq!(status, StatusCode::CREATED, "{what} {id}: {copy}");
    copy
}

/// `read` without what a copy makes its own: id, rev, name, uid, and the
/// keys `also` names.
fn but_identity(mut read: Value, also: &[&str]) -> Value {
    let o = read.as_object_mut().unwrap();
    for key in ["id", "rev", "name", "uid"].iter().chain(also) {
        o.remove(*key);
    }
    read
}

/// A copy of a saved food, recipe, meal or workout is everything it holds
/// under the name "… (copy)", yours and not archived: the server copies
/// rows, so a field the client doesn't know travels too.
#[tokio::test]
async fn a_saved_food_recipe_meal_and_workout_copy_round_trip() {
    let app = app();
    let tablet = call(
        &app,
        "POST",
        "/api/foods",
        Some(
            json!({ "name": "Monivitamiini", "brand": "Pharma", "barcode": "6410000000017",
                     "per100": { "energy": 20.0, "iron": 50.0 }, "category": "fruit_veg",
                     "servings": [{ "label": "poretabletti", "grams": 4.3 }],
                     "basis": { "serving": "poretabletti", "estimated": true },
                     "archived": true }),
        ),
    )
    .await
    .1;
    let food = copy(&app, "foods", &tablet["id"], json!({})).await;
    assert_eq!(food["name"], "Monivitamiini (copy)");
    assert_eq!(
        (&food["archived"], &food["barcode"], &food["source"]),
        (&json!(false), &Value::Null, &json!("custom"))
    );
    assert_ne!(food["id"], tablet["id"]);
    assert_eq!(
        but_identity(food.clone(), &["archived", "barcode"]),
        but_identity(tablet.clone(), &["archived", "barcode"])
    );

    let oats = create_food(&app, "Oats", json!({ "energy": 380.0, "water": 10.0 })).await;
    let porridge = recipe(
        &app,
        "Porridge",
        &[(oats, 60.0)],
        json!({ "cooked_g": 250.0, "makes": 2, "notes": "Simmer.", "category": "fast_food" }),
    )
    .await;
    let porridge_id = porridge["id"].as_i64().unwrap();
    let (_, porridge) = call(&app, "GET", &format!("/api/recipes/{porridge_id}"), None).await;
    let pot = copy(&app, "foods", &porridge["id"], json!({})).await;
    assert_eq!(pot["name"], "Porridge (copy)");
    let (_, pot) = call(&app, "GET", &format!("/api/recipes/{}", pot["id"]), None).await;
    assert_eq!(but_identity(pot, &[]), but_identity(porridge, &[]));

    let (_, meal) = call(
        &app,
        "POST",
        "/api/meals",
        Some(json!({ "name": "Breakfast", "items": [
            { "food_id": porridge_id, "grams": 250.0 },
            { "food_id": tablet["id"], "serving": "poretabletti", "quantity": 2 }] })),
    )
    .await;
    let lunch = copy(&app, "meals", &meal["id"], json!({})).await;
    assert_eq!(lunch["name"], "Breakfast (copy)");
    assert_eq!(but_identity(lunch, &[]), but_identity(meal, &[]));

    let (_, x) = call(
        &app,
        "POST",
        "/api/exercises",
        Some(json!({ "name": "Towel hang", "measure": "reps" })),
    )
    .await;
    let (_, pulls) = call(
        &app,
        "POST",
        "/api/workouts",
        Some(
            json!({ "name": "Pulls", "minutes": 20, "kcal": 90, "notes": "Slow.",
                     "steps": [{ "kind": "exercise", "exercise_id": x["id"], "reps": 5 }],
                     "archived": true }),
        ),
    )
    .await;
    let again = copy(&app, "workouts", &pulls["id"], json!({})).await;
    assert_eq!(
        (&again["name"], &again["archived"]),
        (&json!("Pulls (copy)"), &json!(false))
    );
    assert_eq!(
        but_identity(again, &["archived"]),
        but_identity(pulls, &["archived"])
    );
}

/// Each press is its own copy; a retried one (its uid) is the same; a copy
/// of nothing is 404.
#[tokio::test]
async fn a_retried_copy_is_the_same_and_a_missing_one_404s() {
    let app = app();
    let tablet = json!(create_food(&app, "Monivitamiini", json!({ "energy": 20.0 })).await);
    let a = copy(&app, "foods", &tablet, json!({ "uid": "copy-uid-0001" })).await;
    let b = copy(&app, "foods", &tablet, json!({ "uid": "copy-uid-0001" })).await;
    let c = copy(&app, "foods", &tablet, json!({})).await;
    assert_eq!(a["id"], b["id"]);
    assert_ne!(a["id"], c["id"]);
    for what in ["foods", "meals", "workouts"] {
        let (status, err) = call(
            &app,
            "POST",
            &format!("/api/{what}/999/copy"),
            Some(json!({})),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{what}: {err}");
    }
}

/// A Fineli food's copy is yours to change: name and values included, and
/// no brand of Fineli's. A name at the limit is cut to fit "(copy)".
#[tokio::test]
async fn a_fineli_copy_is_yours_and_a_long_name_fits() {
    let app = fineli_app();
    let (_, found) = search(&app, "q=maito&sources=fineli").await;
    let milk = &found[0];
    let mine = copy(&app, "foods", &milk["id"], json!({})).await;
    assert_eq!(
        (&mine["source"], &mine["brand"], &mine["per100"]),
        (&json!("custom"), &Value::Null, &milk["per100"])
    );
    let (status, res) = put_with_rev(
        &app,
        &format!("/api/foods/{}", mine["id"]),
        json!({ "name": "My milk", "per100": { "energy": 40.0 } }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{res}");

    let long = "Ä".repeat(200);
    let id = create_food(&app, &long, json!({ "energy": 1 })).await;
    let cut = copy(&app, "foods", &json!(id), json!({})).await;
    let name = cut["name"].as_str().unwrap();
    assert_eq!(name.chars().count(), 200, "{name}");
    assert!(name.ends_with("Ä (copy)"), "{name}");
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

// A second profile, "Other", and favourites: A and B for profile 1, B for
// Other; Other's id.
async fn favorites_of_two(app: &Router, a: i64, b: i64) -> i64 {
    let (_, other) = call(
        app,
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
            app,
            "POST",
            &format!("/api/profiles/{pid}/foods/favorites"),
            Some(json!({ "food_id": food })),
        )
        .await;
        assert_eq!(status, StatusCode::NO_CONTENT);
    }
    other
}

#[tokio::test]
async fn merging_moves_everything_onto_the_kept_food() {
    let app = app();
    let (keep, b) = oat_milks(&app).await;
    let a = keep["id"].as_i64().unwrap();
    let logged = log_entry(&app, "Eaten", b, 100.0).await;
    let other = favorites_of_two(&app, a, b).await;
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
    // The entry points at A and takes its values.
    let (_, entry) = call(
        &app,
        "GET",
        &format!("/api/profiles/1/entries/{}", logged["id"]),
        None,
    )
    .await;
    assert_eq!(entry["food_id"], a);
    assert_eq!(entry["nutrients"], json!({ "energy": 50.0 }));
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
        json!([{ "food_id": a, "grams": 200.0, "serving": null, "quantity": null, "name": "Oat milk",
                 "source": "custom", "kind": "food", "per100": { "energy": 50.0 }, "weight_estimated": false, "labels": { "verdict": null, "subs": [], "why": [] },
                 "drink": true, "borne": { "caffeine": 100.0 },
                 "servings": [{ "label": "Glass", "grams": 200.0 }, { "label": "Carton", "grams": 1000.0 }] }])
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
        json!({ "entries": 1, "recipes": 1, "meals": 1, "favorites": 2, "daily_items": 0,
                "water": 0, "deletable": false })
    );

    // B's id is never handed out again.
    let next = create_food(&app, "Fresh", json!({})).await;
    assert!(next > b, "{next} reuses {b}");
}

#[tokio::test]
async fn merging_a_food_repoints_daily_items() {
    let app = app();
    let (keep, b) = oat_milks(&app).await;
    let a = keep["id"].as_i64().unwrap();
    let logged = log_entry(&app, "Eaten", b, 100.0).await;
    let (status, made) = call(
        &app,
        "PATCH",
        &format!("/api/profiles/1/entries/{}", logged["id"]),
        Some(json!({ "repeat": { "start": DAY } })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{made}");
    let uri = format!("/api/foods/{a}/merge");
    let (status, merged) = call(
        &app,
        "POST",
        &uri,
        Some(json!({ "from": b, "rev": keep["rev"] })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{merged}");
    let (_, now) = call(
        &app,
        "GET",
        &format!(
            "/api/profiles/1/entries/daily-{}-2026-10-07",
            made["repeat"]["id"]
        ),
        None,
    )
    .await;
    assert_eq!(
        (&now["food_id"], &now["name"], &now["grams"]),
        (&json!(a), &json!("Oat milk"), &json!(100.0))
    );
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

/// An app with the Fineli fixture imported ("Maito, rasvaton" among its foods).
fn fineli_app() -> Router {
    let mut conn = open(FsPath::new(":memory:")).unwrap();
    let dir = FsPath::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fineli");
    kaloriina::fineli::store(&mut conn, &kaloriina::fineli::read(&dir).unwrap(), &[]).unwrap();
    app_from(conn, NO_OFF)
}

/// Only the databases that hold a food are offered to filter by; your own
/// foods and recipes always are.
#[tokio::test]
async fn meta_lists_the_food_sources_that_exist() {
    let (_, meta) = call(&app(), "GET", "/api/meta", None).await;
    assert_eq!(meta["food_sources"], json!(["custom", "recipe"]));
    let (_, meta) = call(&fineli_app(), "GET", "/api/meta", None).await;
    assert_eq!(meta["food_sources"], json!(["custom", "recipe", "fineli"]));
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

/// A food's values typed per one of its servings keep that serving as
/// their basis; a PUT of `basis: null` clears it.
#[tokio::test]
async fn food_basis_round_trips_and_clears() {
    let app = app();
    let body = json!({
        "name": "Burger", "per100": { "energy": 540.0 * 100.0 / 210.0 },
        "servings": [{ "label": "Burger", "grams": 210 }],
        "basis": { "serving": "Burger", "estimated": true },
    });
    let (status, food) = call(&app, "POST", "/api/foods", Some(body.clone())).await;
    assert_eq!(status, StatusCode::CREATED, "{food}");
    let uri = format!("/api/foods/{}", food["id"]);
    let (_, read) = call(&app, "GET", &uri, None).await;
    assert_eq!(
        read["basis"],
        json!({ "serving": "Burger", "estimated": true })
    );

    let (status, saved) = put_with_rev(&app, &uri, json!({ "basis": null })).await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    assert_eq!(saved["basis"], Value::Null);
    let (_, read) = call(&app, "GET", &uri, None).await;
    assert_eq!(read["basis"], Value::Null);
}

/// Fineli's values are its own, per 100 g: not typed per a serving.
#[tokio::test]
async fn fineli_food_refuses_basis() {
    let app = fineli_app();
    let (_, found) = search(&app, "q=maito&sources=fineli").await;
    let uri = format!("/api/foods/{}", found[0]["id"]);
    let (_, mut food) = call(&app, "GET", &uri, None).await;
    food["servings"] = json!([{ "label": "Glass", "grams": 200 }]);
    food["basis"] = json!({ "serving": "Glass", "estimated": false });
    let (status, err) = put_with_rev(&app, &uri, food.clone()).await;
    assert_eq!(
        (status, &err["field"]),
        (StatusCode::BAD_REQUEST, &json!("basis")),
        "{err}"
    );
    food["basis"] = Value::Null;
    let (status, saved) = put_with_rev(&app, &uri, food).await;
    assert_eq!(status, StatusCode::OK, "{saved}");
}

fn food_names(list: &Value) -> Vec<&str> {
    list.as_array()
        .unwrap()
        .iter()
        .map(|f| f["name"].as_str().unwrap())
        .collect()
}

// ---------------------------- items: a quantity of a serving, or grams

/// A multivitamin with a "poretabletti" serving (4.3 g) and plain oats.
async fn tablet_and_oats(app: &Router) -> (i64, i64) {
    let (status, tablet) = call(
        app,
        "POST",
        "/api/foods",
        Some(
            json!({ "name": "Monivitamiini", "per100": { "energy": 20.0 },
                     "servings": [{ "label": "poretabletti", "grams": 4.3 }] }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{tablet}");
    let oats = create_food(app, "Oats", json!({ "energy": 380 })).await;
    (tablet["id"].as_i64().unwrap(), oats)
}

#[tokio::test]
async fn recipe_and_meal_items_keep_their_serving_and_quantity() {
    let app = app();
    let (tablet, oats) = tablet_and_oats(&app).await;
    // Old clients send grams only; they still work.
    let items = json!([
        { "food_id": tablet, "serving": "poretabletti", "quantity": 2 },
        { "food_id": oats, "grams": 60 },
    ]);
    let (status, recipe) = call(
        &app,
        "POST",
        "/api/recipes",
        Some(json!({ "name": "Drink", "cooked_g": null, "items": items })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{recipe}");
    let (status, meal) = call(
        &app,
        "POST",
        "/api/meals",
        Some(json!({ "name": "Morning", "items": items })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{meal}");
    for uri in [
        format!("/api/recipes/{}", recipe["id"]),
        format!("/api/meals/{}", meal["id"]),
    ] {
        let (_, read) = call(&app, "GET", &uri, None).await;
        let i = &read["items"];
        assert_eq!(
            (&i[0]["grams"], &i[0]["serving"], &i[0]["quantity"]),
            (&json!(8.6), &json!("poretabletti"), &json!(2.0)),
            "{uri}: {i}"
        );
        assert_eq!(
            i[0]["servings"],
            json!([{ "label": "poretabletti", "grams": 4.3 }])
        );
        assert_eq!(
            (&i[1]["grams"], &i[1]["serving"], &i[1]["quantity"]),
            (&json!(60.0), &Value::Null, &Value::Null),
            "{uri}: {i}"
        );
    }
    // Grams stay the truth: 8.6 g of 20 kcal/100 g and 60 g of 380.
    let (_, read) = call(&app, "GET", &format!("/api/recipes/{}", recipe["id"]), None).await;
    let whole = 8.6 * 0.2 + 60.0 * 3.8;
    let per100 = read["per100"]["energy"].as_f64().unwrap();
    assert!((per100 - whole / 68.6 * 100.0).abs() < 0.01, "{per100}");

    // A meal logs its servings as they were chosen, times the portions.
    let (status, logged) = call(
        &app,
        "POST",
        "/api/profiles/1/entries",
        Some(json!({ "day": DAY, "group": "Eaten", "meal_id": meal["id"], "portions": 2 })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{logged}");
    let amounts: Vec<&str> = logged["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["amount"].as_str().unwrap())
        .collect();
    assert_eq!(amounts, ["4 × poretabletti (17.2 g)", "120 g"]);
}

#[tokio::test]
async fn an_item_names_a_serving_its_food_has() {
    let app = app();
    let (tablet, oats) = tablet_and_oats(&app).await;
    for item in [
        json!({ "food_id": tablet, "serving": "Cup", "quantity": 1 }),
        json!({ "food_id": oats, "serving": "poretabletti", "quantity": 1 }),
        json!({ "food_id": tablet, "serving": "poretabletti", "quantity": 0 }),
        json!({ "food_id": tablet, "serving": "poretabletti" }),
        json!({ "food_id": tablet, "grams": 4.3, "serving": "poretabletti", "quantity": 1 }),
    ] {
        for (uri, name) in [("/api/recipes", "R"), ("/api/meals", "M")] {
            let (status, err) = call(
                &app,
                "POST",
                uri,
                Some(json!({ "name": name, "cooked_g": null, "items": [item] })),
            )
            .await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{uri} {item}: {err}");
        }
    }
}

#[tokio::test]
async fn an_item_whose_serving_is_gone_reads_as_grams() {
    let app = app();
    let (tablet, _) = tablet_and_oats(&app).await;
    let item = json!([{ "food_id": tablet, "serving": "poretabletti", "quantity": 2 }]);
    let (_, recipe) = call(
        &app,
        "POST",
        "/api/recipes",
        Some(json!({ "name": "Drink", "cooked_g": null, "items": item })),
    )
    .await;
    let (_, meal) = call(
        &app,
        "POST",
        "/api/meals",
        Some(json!({ "name": "Morning", "items": item })),
    )
    .await;
    let (status, _) = put_with_rev(
        &app,
        &format!("/api/foods/{tablet}"),
        json!({ "name": "Monivitamiini", "per100": { "energy": 20.0 },
                "servings": [{ "label": "tabletti", "grams": 4.3 }] }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    for uri in [
        format!("/api/recipes/{}", recipe["id"]),
        format!("/api/meals/{}", meal["id"]),
    ] {
        let (_, read) = call(&app, "GET", &uri, None).await;
        let i = &read["items"][0];
        assert_eq!(
            (&i["grams"], &i["serving"], &i["quantity"]),
            (&json!(8.6), &Value::Null, &Value::Null),
            "{uri}: {i}"
        );
    }
}

#[tokio::test]
async fn a_merged_items_serving_comes_along_unless_its_grams_are_summed() {
    let app = app();
    let (keep, b) = oat_milks(&app).await;
    let a = keep["id"].as_i64().unwrap();
    let carton = |q: f64| json!({ "food_id": b, "serving": "Carton", "quantity": q });
    let (_, latte) = call(
        &app,
        "POST",
        "/api/recipes",
        Some(json!({ "name": "Latte", "cooked_g": null,
                     "items": [carton(0.1), { "food_id": a, "grams": 100 }] })),
    )
    .await;
    let (_, meal) = call(
        &app,
        "POST",
        "/api/meals",
        Some(json!({ "name": "Breakfast", "items": [carton(0.3)] })),
    )
    .await;
    let (status, _) = call(
        &app,
        "POST",
        &format!("/api/foods/{a}/merge"),
        Some(json!({ "from": b, "rev": keep["rev"] })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (_, latte) = call(&app, "GET", &format!("/api/recipes/{}", latte["id"]), None).await;
    let i = &latte["items"][0];
    assert_eq!(
        (&i["grams"], &i["serving"]),
        (&json!(200.0), &Value::Null),
        "{i}"
    );
    let (_, meal) = call(&app, "GET", &format!("/api/meals/{}", meal["id"]), None).await;
    let i = &meal["items"][0];
    assert_eq!(
        (&i["food_id"], &i["serving"], &i["quantity"]),
        (&json!(a), &json!("Carton"), &json!(0.3)),
        "{i}"
    );
}

// ------------------------------------------ renames, workout archiving

/// Profile 1's session `id`.
async fn session_read(app: &Router, id: &Value) -> Value {
    let (status, s) = call(
        app,
        "GET",
        &format!("/api/profiles/1/activities/{id}"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{s}");
    s
}

#[tokio::test]
async fn a_users_rename_rewrites_past_names_but_not_amounts() {
    let app = app();
    // A food and a recipe: entries logged under the old name follow, and
    // their values follow the food's (Porridge's stay the same).
    let oats = create_food(&app, "Oats", json!({ "energy": 380.0 })).await;
    let logged = log_entry(&app, "Eaten", oats, 50.0).await;
    let (status, _) = put_with_rev(
        &app,
        &format!("/api/foods/{oats}"),
        json!({ "name": "Rolled oats", "per100": { "energy": 400.0 } }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let porridge = recipe(&app, "Porridge", &[(oats, 60.0)], json!({})).await;
    let bowl = log_entry(&app, "Eaten", porridge["id"].as_i64().unwrap(), 200.0).await;
    let (status, _) = put_with_rev(
        &app,
        &format!("/api/recipes/{}", porridge["id"]),
        json!({ "name": "Oat porridge", "items": [{ "food_id": oats, "grams": 60.0 }] }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let rolled = json!({ "energy": 200.0 });
    for (e, name, nutrients) in [
        (&logged, "Rolled oats", &rolled),
        (&bowl, "Oat porridge", &bowl["nutrients"]),
    ] {
        let (_, now) = call(
            &app,
            "GET",
            &format!("/api/profiles/1/entries/{}", e["id"]),
            None,
        )
        .await;
        assert_eq!((&now["name"], &now["nutrients"]), (&json!(name), nutrients));
    }

    // A workout and an exercise of yours: sessions under the old name and
    // sets of the old exercise name follow; a session you named stays.
    let (_, towel) = call(
        &app,
        "POST",
        "/api/exercises",
        Some(json!({ "name": "Towel hang", "measure": "reps" })),
    )
    .await;
    let (_, w) = call(
        &app,
        "POST",
        "/api/workouts",
        Some(json!({ "name": "Pulls", "steps": [
            { "kind": "exercise", "exercise_id": towel["id"], "reps": 5 }] })),
    )
    .await;
    let mut sessions = Vec::new();
    for (name, uid) in [("Pulls", "rename-0001"), ("Evening pulls", "rename-0002")] {
        let (status, s) = call(
            &app,
            "POST",
            "/api/profiles/1/activities",
            Some(
                json!({ "day": DAY, "workout_id": w["id"], "name": name, "minutes": 20,
                         "uid": uid, "sets": [{ "exercise_id": towel["id"], "reps": 5 }] }),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "{s}");
        sessions.push(s["id"].clone());
    }
    let (status, _) = put_with_rev(
        &app,
        &format!("/api/workouts/{}", w["id"]),
        json!({ "name": "Pull day", "steps": w["steps"] }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = put_with_rev(
        &app,
        &format!("/api/exercises/{}", towel["id"]),
        json!({ "name": "Towel pull-up", "measure": "reps" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let first = session_read(&app, &sessions[0]).await;
    let second = session_read(&app, &sessions[1]).await;
    assert_eq!(
        (&first["name"], &second["name"]),
        (&json!("Pull day"), &json!("Evening pulls"))
    );
    assert_eq!(
        (&first["sets"][0]["name"], &first["sets"][0]["reps"]),
        (&json!("Towel pull-up"), &json!(5))
    );
}

#[tokio::test]
async fn a_workout_is_deleted_only_while_nothing_names_it() {
    let app = app();
    let (_, pull) = call(&app, "GET", "/api/exercises", None).await;
    let pull = pull
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["name"] == "Pull-up")
        .unwrap()["id"]
        .clone();
    let workout = |name: &str| json!({ "name": name, "steps": [{ "kind": "exercise", "exercise_id": pull, "reps": 5 }] });
    let (_, unused) = call(&app, "POST", "/api/workouts", Some(workout("Spare"))).await;
    assert_eq!(unused["archived"], false);
    let usage = |id: &Value| format!("/api/workouts/{id}/usage");
    let (status, u) = call(&app, "GET", &usage(&unused["id"]), None).await;
    assert_eq!(
        (status, u),
        (StatusCode::OK, json!({ "activities": 0, "plans": 0 }))
    );

    // Planned by another profile: used instance-wide, so it's archived.
    let (_, used) = call(&app, "POST", "/api/workouts", Some(workout("Planned"))).await;
    let (_, other) = call(
        &app,
        "POST",
        "/api/profiles",
        Some(
            json!({ "name": "Anna", "sex": null, "birth_date": null, "height_cm": null,
                     "activity": null, "goal_kg_per_week": 0 }),
        ),
    )
    .await;
    let (status, _) = call(
        &app,
        "POST",
        &format!("/api/profiles/{}/plans", other["id"]),
        Some(json!({ "day": DAY, "workout_id": used["id"], "uid": "plan-anna-1" })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let (_, u) = call(&app, "GET", &usage(&used["id"]), None).await;
    assert_eq!(u, json!({ "activities": 0, "plans": 1 }));
    let mut archive = workout("Planned");
    archive["archived"] = json!(true);
    let uri = format!("/api/workouts/{}", used["id"]);
    let (status, archived) = put_with_rev(&app, &uri, archive).await;
    assert_eq!(
        (status, &archived["archived"]),
        (StatusCode::OK, &json!(true))
    );
    let (_, list) = call(&app, "GET", "/api/workouts", None).await;
    assert!(
        list.as_array()
            .unwrap()
            .iter()
            .any(|w| w["id"] == used["id"]),
        "archived workouts are listed, flagged"
    );
    let (status, _) = call(&app, "GET", &usage(&json!(999)), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn workout_notes_keep_lines_are_bounded_and_survive_rename_and_archive() {
    let app = app();
    let (_, list) = call(&app, "GET", "/api/exercises", None).await;
    let pull = list
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["name"] == "Pull-up")
        .unwrap()["id"]
        .clone();
    let workout = |name: &str, notes: Value| {
        json!({ "name": name, "notes": notes,
                "steps": [{ "kind": "exercise", "exercise_id": pull, "reps": 5 }] })
    };
    let (status, w) = call(
        &app,
        "POST",
        "/api/workouts",
        Some(workout(
            "Pulls",
            json!("  Warm up first.\r\n\tShoulders down.  "),
        )),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{w}");
    let kept = json!("Warm up first.\n\tShoulders down.");
    assert_eq!(w["notes"], kept, "trimmed, CRLF read as LF, tabs kept");
    let uri = format!("/api/workouts/{}", w["id"]);
    let (_, got) = call(&app, "GET", &uri, None).await;
    assert_eq!(got["notes"], kept);

    // Exactly the limit passes; one more, or a sneaky character, is refused.
    let (status, max) = call(
        &app,
        "POST",
        "/api/workouts",
        Some(workout("Max", json!("a".repeat(10_000)))),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{max}");
    for bad in ["a".repeat(10_001), "a\u{202e}b".to_owned()] {
        let (status, e) = call(
            &app,
            "POST",
            "/api/workouts",
            Some(workout("W", json!(bad))),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{e}");
        assert_eq!(e["field"], "notes", "{e}");
    }

    // A rename and an archive keep them; blank or left out is none.
    let mut renamed = workout("Pull day", kept.clone());
    renamed["archived"] = json!(true);
    let (status, r) = put_with_rev(&app, &uri, renamed).await;
    assert_eq!(status, StatusCode::OK, "{r}");
    assert_eq!((&r["name"], &r["notes"]), (&json!("Pull day"), &kept));
    let (_, r) = put_with_rev(&app, &uri, workout("Pull day", json!(" \n "))).await;
    assert_eq!(r["notes"], Value::Null);
    let mut absent = workout("Bare", Value::Null);
    absent.as_object_mut().unwrap().remove("notes");
    let (_, r) = call(&app, "POST", "/api/workouts", Some(absent)).await;
    assert_eq!(r["notes"], Value::Null);
}

// --------------------------------------- PUT replaces the whole entity

/// PUT `uri` with what it reads, less `field`.
async fn put_without(app: &Router, uri: &str, field: &str) -> (StatusCode, Value) {
    let mut current = read_one(app, uri).await;
    current.as_object_mut().unwrap().remove(field);
    call(app, "PUT", uri, Some(current)).await
}

/// A workout of one Pull-up step, archived, with notes: its URI.
async fn archived_workout(app: &Router) -> String {
    let (_, list) = call(app, "GET", "/api/exercises", None).await;
    let pull = list
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["name"] == "Pull-up")
        .unwrap()["id"]
        .clone();
    let (status, w) = call(
        app,
        "POST",
        "/api/workouts",
        Some(
            json!({ "name": "Pulls", "notes": "Shoulders down.", "archived": true,
                     "steps": [{ "kind": "exercise", "exercise_id": pull, "reps": 5 }] }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{w}");
    format!("/api/workouts/{}", w["id"])
}

#[tokio::test]
async fn a_put_missing_archived_is_refused() {
    let app = app();
    let uri = archived_workout(&app).await;
    let (status, e) = put_without(&app, &uri, "archived").await;
    assert_eq!(
        (status, &e["field"]),
        (StatusCode::BAD_REQUEST, &json!("archived")),
        "{e}"
    );
    let (_, w) = call(&app, "GET", &uri, None).await;
    assert_eq!(w["archived"], true, "never a reset");
}

#[tokio::test]
async fn a_put_missing_notes_is_refused() {
    let app = app();
    let uri = archived_workout(&app).await;
    let (status, e) = put_without(&app, &uri, "notes").await;
    assert_eq!(
        (status, &e["field"]),
        (StatusCode::BAD_REQUEST, &json!("notes")),
        "{e}"
    );
    // `null` is the way to clear them.
    let (_, mut w) = call(&app, "GET", &uri, None).await;
    w["notes"] = Value::Null;
    let (status, w) = call(&app, "PUT", &uri, Some(w)).await;
    assert_eq!((status, &w["notes"]), (StatusCode::OK, &Value::Null), "{w}");
}

/// Each field `uri`'s PUT reads is required, and what GET answers goes
/// back as it came.
async fn requires_every_field(app: &Router, uri: &str, fields: &[&str]) {
    for field in fields {
        let (status, e) = put_without(app, uri, field).await;
        assert_eq!(
            (status, &e["code"], &e["field"]),
            (StatusCode::BAD_REQUEST, &json!("invalid"), &json!(field)),
            "{uri} without {field}: {e}"
        );
    }
    let (status, e) = put_without(app, uri, "id").await;
    assert_eq!(status, StatusCode::OK, "{uri} as read: {e}");
}

/// Every library entity a PUT replaces requires each field it reads.
#[tokio::test]
async fn every_library_put_field_is_required() {
    let app = app();
    let workout = archived_workout(&app).await;
    let oats = create_food(&app, "Oats", json!({ "energy": 380 })).await;
    let (_, porridge) = porridge(&app, json!("Stir.")).await;
    let (_, meal) = call(
        &app,
        "POST",
        "/api/meals",
        Some(json!({ "name": "Breakfast", "items": [{ "food_id": oats, "grams": 50 }] })),
    )
    .await;
    let (_, exercise) = call(
        &app,
        "POST",
        "/api/exercises",
        Some(json!({ "name": "Towel hang", "measure": "reps" })),
    )
    .await;
    requires_every_field(
        &app,
        &workout,
        &[
            "name", "steps", "minutes", "kcal", "notes", "archived", "rev",
        ],
    )
    .await;
    requires_every_field(
        &app,
        &format!("/api/foods/{oats}"),
        &[
            "name", "brand", "barcode", "per100", "servings", "archived", "category", "basis",
            "rev",
        ],
    )
    .await;
    requires_every_field(
        &app,
        &format!("/api/recipes/{}", porridge["id"]),
        &[
            "name", "cooked_g", "makes", "items", "servings", "archived", "notes", "category",
            "rev",
        ],
    )
    .await;
    requires_every_field(
        &app,
        &format!("/api/meals/{}", meal["id"]),
        &["name", "items", "rev"],
    )
    .await;
    requires_every_field(
        &app,
        &format!("/api/exercises/{}", exercise["id"]),
        &[
            "name",
            "measure",
            "variant_of",
            "rev",
            "equipment",
            "pattern",
            "region",
            "group",
            "primary",
            "secondary",
            "mechanics",
            "laterality",
            "difficulty",
            "load",
        ],
    )
    .await;
}

/// Every profile entity a PUT replaces requires each field it reads.
#[tokio::test]
async fn every_profile_put_field_is_required() {
    let app = app();
    let (_, habit) = call(
        &app,
        "POST",
        "/api/profiles/1/habits",
        Some(json!({ "name": "Snus", "unit": "pouches" })),
    )
    .await;
    let (_, session) = call(
        &app,
        "POST",
        "/api/profiles/1/activities",
        Some(json!({ "day": DAY, "name": "Walk", "minutes": 20, "type": "walk" })),
    )
    .await;
    requires_every_field(
        &app,
        &format!("/api/profiles/1/habits/{}", habit["id"]),
        &["name", "unit", "goal_value", "goal_dir", "archived", "rev"],
    )
    .await;
    requires_every_field(
        &app,
        "/api/profiles/1",
        &[
            "name",
            "sex",
            "birth_date",
            "height_cm",
            "activity",
            "goal_kg_per_week",
            "goal_date",
            "latitude",
            "rev",
        ],
    )
    .await;
    requires_every_field(
        &app,
        &format!("/api/profiles/1/activities/{}", session["id"]),
        &[
            "day",
            "workout_id",
            "name",
            "minutes",
            "kcal",
            "sets",
            "type",
            "distance_m",
            "start_at",
            "rev",
        ],
    )
    .await;
}

/// A rename that rewrites sessions moves their `rev` on, so an editor
/// holding the old one is refused instead of reverting it.
#[tokio::test]
async fn rename_bumps_session_rev() {
    let app = app();
    let (_, towel) = call(
        &app,
        "POST",
        "/api/exercises",
        Some(json!({ "name": "Towel hang", "measure": "reps" })),
    )
    .await;
    let (_, w) = call(
        &app,
        "POST",
        "/api/workouts",
        Some(json!({ "name": "Pulls", "steps": [
            { "kind": "exercise", "exercise_id": towel["id"], "reps": 5 }] })),
    )
    .await;
    let (status, s) = call(
        &app,
        "POST",
        "/api/profiles/1/activities",
        Some(
            json!({ "day": DAY, "workout_id": w["id"], "name": "Pulls", "minutes": 20,
                     "sets": [{ "exercise_id": towel["id"], "reps": 5 }] }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{s}");
    let uri = format!("/api/profiles/1/activities/{}", s["id"]);
    let (status, _) = put_with_rev(
        &app,
        &format!("/api/workouts/{}", w["id"]),
        json!({ "name": "Pull day" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (_, after) = call(&app, "GET", &uri, None).await;
    assert_eq!(
        (&after["name"], &after["rev"]),
        (&json!("Pull day"), &json!(2))
    );
    let (status, _) = put_with_rev(
        &app,
        &format!("/api/exercises/{}", towel["id"]),
        json!({ "name": "Towel pull-up" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (_, after) = call(&app, "GET", &uri, None).await;
    assert_eq!(
        (&after["sets"][0]["name"], &after["rev"]),
        (&json!("Towel pull-up"), &json!(3))
    );
    // The editor still holding rev 1 is stale, not a silent revert.
    let mut stale = s.clone();
    stale["minutes"] = json!(25);
    let (status, e) = call(&app, "PUT", &uri, Some(stale)).await;
    assert_eq!(
        (status, &e["code"]),
        (StatusCode::CONFLICT, &json!("stale"))
    );
}

/// A serving whose grams change, or that goes, unlinks the recipe and meal
/// items measured by it: they keep their grams, so nothing they count moves
/// on the next unrelated save.
#[tokio::test]
async fn serving_change_clears_stale_items() {
    let app = app();
    let (_, bread) = call(
        &app,
        "POST",
        "/api/foods",
        Some(json!({ "name": "Bread", "per100": { "energy": 250 },
                     "servings": [{ "label": "Slice", "grams": 40 }, { "label": "Loaf", "grams": 500 }] })),
    )
    .await;
    let two = |label: &str| json!([{ "food_id": bread["id"], "serving": label, "quantity": 2 }]);
    let toast = recipe(&app, "Toast", &[], json!({ "items": two("Slice") })).await;
    let (status, meal) = call(
        &app,
        "POST",
        "/api/meals",
        Some(json!({ "name": "Picnic", "items": two("Loaf") })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{meal}");
    assert_eq!(
        (&toast["items"][0]["serving"], &toast["items"][0]["grams"]),
        (&json!("Slice"), &json!(80.0))
    );

    let uri = format!("/api/foods/{}", bread["id"]);
    let (status, res) = put_with_rev(
        &app,
        &uri,
        json!({ "servings": [{ "label": "Slice", "grams": 50 }] }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{res}");
    let recipe_uri = format!("/api/recipes/{}", toast["id"]);
    let (_, toast) = call(&app, "GET", &recipe_uri, None).await;
    let (_, meal) = call(&app, "GET", &format!("/api/meals/{}", meal["id"]), None).await;
    for (what, item, grams) in [
        ("changed grams", &toast["items"][0], 80.0),
        ("gone", &meal["items"][0], 1000.0),
    ] {
        assert_eq!(
            (&item["serving"], &item["quantity"], &item["grams"]),
            (&Value::Null, &Value::Null, &json!(grams)),
            "{what}: {item}"
        );
    }
    // Saved again as read, the recipe counts the same.
    let (status, again) = put_with_rev(&app, &recipe_uri, json!({})).await;
    assert_eq!(status, StatusCode::OK, "{again}");
    assert_eq!(again["items"][0]["grams"], 80.0, "{again}");
}

// --------------------------------------------- carbohydrate, both ways

/// Total = carbohydrate + fibre: the other is derived only when fibre is
/// known. Unknown fibre is not 0, so the other stays
/// unknown ("–"), never a bound passed off as the value.
#[tokio::test]
async fn carbs_derive_the_other_only_with_fibre_known() {
    let app = app();
    for (per100, net, total) in [
        (json!({ "carbs": 50, "fiber": 5 }), json!(45.0), json!(50.0)),
        (
            json!({ "net_carbs": 45, "fiber": 5 }),
            json!(45.0),
            json!(50.0),
        ),
        (json!({ "carbs": 3, "fiber": 5 }), json!(0.0), json!(3.0)),
        (json!({ "carbs": 50 }), Value::Null, json!(50.0)),
        (json!({ "net_carbs": 34 }), json!(34.0), Value::Null),
        // Both sent, fibre unsaid: both kept, fibre not guessed.
        (
            json!({ "carbs": 50, "net_carbs": 45 }),
            json!(45.0),
            json!(50.0),
        ),
    ] {
        let (status, f) = call(
            &app,
            "POST",
            "/api/foods",
            Some(json!({ "name": format!("Carbs {per100}"), "per100": per100 })),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "{f}");
        assert_eq!(
            (&f["per100"]["net_carbs"], &f["per100"]["carbs"]),
            (&net, &total),
            "{per100}"
        );
        assert_eq!(
            f["per100"]["fiber"].as_f64(),
            per100["fiber"].as_f64(),
            "{per100}"
        );
    }
}

#[tokio::test]
async fn disagreeing_carbs_are_refused() {
    let app = app();
    let post = |per100: Value| {
        let app = app.clone();
        async move {
            call(
                &app,
                "POST",
                "/api/foods",
                Some(json!({ "name": "Bar", "per100": per100 })),
            )
            .await
        }
    };
    let (status, e) = post(json!({ "carbs": 80, "net_carbs": 50, "fiber": 5 })).await;
    assert_eq!(
        (status, &e["field"]),
        (StatusCode::BAD_REQUEST, &json!("carbs")),
        "{e}"
    );
    // Fibre unsaid: the total can't be under the carbohydrate.
    let (status, e) = post(json!({ "carbs": 40, "net_carbs": 50 })).await;
    assert_eq!(
        (status, &e["field"]),
        (StatusCode::BAD_REQUEST, &json!("carbs")),
        "{e}"
    );
    // Within half a gram is the same number, rounded.
    let (status, f) = post(json!({ "carbs": 55.4, "net_carbs": 50, "fiber": 5 })).await;
    assert_eq!(status, StatusCode::CREATED, "{f}");
    assert_eq!(f["per100"]["carbs"], 55.0, "net + fibre wins: {f}");
}

/// A recipe is a kind of food (ADR 0031), its own: `kind` says recipe,
/// `source` custom; a food is kind food; the search can tell them apart.
#[tokio::test]
async fn recipe_is_a_kind() {
    let app = app();
    let oats = create_food(&app, "Oats", json!({ "energy": 380.0 })).await;
    let (status, recipe) = call(
        &app,
        "POST",
        "/api/recipes",
        Some(json!({ "name": "Porridge", "items": [{ "food_id": oats, "grams": 60.0 }] })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{recipe}");
    let kinds = |f: &Value| (f["kind"].clone(), f["source"].clone());
    let food = |id: i64| {
        let app = app.clone();
        async move { call(&app, "GET", &format!("/api/foods/{id}"), None).await.1 }
    };
    assert_eq!(
        kinds(&food(recipe["id"].as_i64().unwrap()).await),
        (json!("recipe"), json!("custom"))
    );
    assert_eq!(kinds(&food(oats).await), (json!("food"), json!("custom")));
    // A client names neither: a saved food is yours, a food.
    let (status, f) = call(
        &app,
        "POST",
        "/api/foods",
        Some(json!({ "name": "X", "source": "recipe", "kind": "recipe",
                     "per100": { "energy": 1.0 } })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{f}");
    assert_eq!(kinds(&f), (json!("food"), json!("custom")));
}

/// An ingredient without energy leaves the
/// recipe's energy partial, and a key only some ingredients carry is known
/// as far as their dry matter (no water values here: all their grams).
#[tokio::test]
async fn a_recipe_knows_its_energy_only_as_far_as_its_ingredients() {
    let app = app();
    let oats = create_food(&app, "Oats", json!({ "energy": 380.0, "iron": 4.0 })).await;
    let mystery = create_food(&app, "Mystery spice", json!({ "protein": 10.0 })).await;
    let milk = create_food(&app, "Milk", json!({ "energy": 40.0 })).await;
    let (status, recipe) = call(
        &app,
        "POST",
        "/api/recipes",
        Some(json!({ "name": "Porridge", "items": [
            { "food_id": oats, "grams": 50.0 },
            { "food_id": milk, "grams": 200.0 },
            { "food_id": mystery, "grams": 50.0 }] })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{recipe}");
    let (_, read) = call(&app, "GET", &format!("/api/recipes/{}", recipe["id"]), None).await;
    // 270 kcal in 300 g: 90 per 100 g. Energy rides on 250 of 300 g;
    // iron on the oats' 50; protein on the spice's 50, though it has no
    // energy.
    assert_eq!(read["per100"]["energy"], 90.0, "{read}");
    let known = &read["known"];
    assert_eq!(known["dry"], 100.0, "{read}");
    let near = |key: &str, want: f64| {
        assert!(
            (known[key].as_f64().unwrap() - want).abs() < 1e-6,
            "{key}: {read}"
        );
    };
    near("energy", 250.0 / 300.0);
    near("iron", 50.0 / 300.0);
    near("protein", 50.0 / 300.0);
}
