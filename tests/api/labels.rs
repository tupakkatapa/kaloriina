//! Food labels (the server's, stored and filtered in SQL), drinks and what
//! hydrates.

use super::*;

const HABIT_DAYS: &str = "/api/profiles/1/habits/days";

/// A food's labels as keys: its verdict, then its sublabels.
fn label_keys(food: &Value) -> Vec<String> {
    let l = &food["labels"];
    l["verdict"]
        .as_str()
        .into_iter()
        .chain(
            l["subs"]
                .as_array()
                .unwrap()
                .iter()
                .map(|s| s["key"].as_str().unwrap()),
        )
        .map(str::to_owned)
        .collect()
}

#[tokio::test]
async fn every_food_view_and_hit_carries_its_labels() {
    let app = app();
    let chicken = create_food(
        &app,
        "Chicken breast",
        json!({ "energy": 110, "protein": 23, "fat": 1.5, "saturated": 0.4,
                "sugars": 0, "sodium": 60 }),
    )
    .await;
    let (_, food) = call(&app, "GET", &format!("/api/foods/{chicken}"), None).await;
    assert_eq!(
        food["labels"]["subs"][0],
        json!({ "key": "high_protein", "text": "High protein", "kind": "high",
                "nutrient": "protein", "positive": true })
    );
    assert_eq!(
        label_keys(&food),
        [
            "healthy",
            "high_protein",
            "low_fat",
            "low_saturated",
            "low_sugars",
            "low_sodium"
        ]
    );
    let (_, hits) = search(&app, "q=chicken").await;
    assert_eq!(label_keys(&hits[0]), label_keys(&food));
    let (_, meta) = call(&app, "GET", "/api/meta", None).await;
    let vocabulary: Vec<&str> = meta["labels"]
        .as_array()
        .unwrap()
        .iter()
        .map(|l| l["key"].as_str().unwrap())
        .collect();
    assert_eq!(
        &vocabulary[..5],
        [
            "healthy",
            "ok",
            "unhealthy",
            "high_protein",
            "source_protein"
        ]
    );
    assert_eq!(meta["labels"][1]["positive"], false);
    assert_eq!(meta["labels"][2]["positive"], false);
    // Reasons are no labels: none in the vocabulary.
    assert!(
        !vocabulary.iter().any(|k| k.starts_with("why_")),
        "{vocabulary:?}"
    );
    assert!(vocabulary.contains(&"source_vitamin_c"), "{vocabulary:?}");

    // A recipe is labelled from its values, and again when a part changes.
    let (status, recipe) = call(
        &app,
        "POST",
        "/api/recipes",
        Some(json!({ "name": "Chicken bowl", "cooked_g": null,
                     "items": [{ "food_id": chicken, "grams": 200.0 }] })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{recipe}");
    assert_eq!(label_keys(&recipe)[..2], ["healthy", "high_protein"]);
    let (status, res) = put_with_rev(
        &app,
        &format!("/api/foods/{chicken}"),
        json!({ "per100": { "energy": 400, "protein": 10, "fat": 30 } }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{res}");
    let (_, recipe) = call(&app, "GET", &format!("/api/recipes/{}", recipe["id"]), None).await;
    // 30 g fat, the rest of its negatives unknown: no score yet (ADR 0033).
    assert_eq!(label_keys(&recipe), ["high_fat"]);
    // A meal, from its items' values, as a food.
    let (status, meal) = call(
        &app,
        "POST",
        "/api/meals",
        Some(json!({ "name": "Chicken lunch",
                     "items": [{ "food_id": chicken, "grams": 150.0 }] })),
    )
    .await;
    assert!(status.is_success(), "{meal}");
    assert_eq!(label_keys(&meal), ["high_fat"]);
    let (_, hits) = search(&app, "label=high_fat").await;
    let names: Vec<&str> = hits
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["Chicken bowl", "Chicken breast"]);
}

/// A recipe whose sugars only a quarter of its energy
/// carries read "Low sugar", and so Healthy, from a partial sum. Its labels
/// judge only what its parts prove; a floor still proves a "Source of".
#[tokio::test]
async fn a_recipes_labels_judge_what_its_parts_prove() {
    let app = app();
    let pie = create_food(
        &app,
        "Pie",
        json!({ "energy": 224, "protein": 6, "fat": 9, "saturated": 1, "sodium": 100 }),
    )
    .await;
    let cheese = create_food(
        &app,
        "Cheese",
        json!({ "energy": 300, "protein": 25, "fat": 22, "saturated": 1, "sugars": 0,
                "sodium": 100, "calcium": 800 }),
    )
    .await;
    let (_, recipe) = call(
        &app,
        "POST",
        "/api/recipes",
        Some(json!({ "name": "Pie with cheese", "cooked_g": null,
                     "items": [{ "food_id": pie, "grams": 70.0 },
                               { "food_id": cheese, "grams": 20.0 }] })),
    )
    .await;
    // Sugars 0 from 28 % of the energy: no Low sugar, so no Healthy.
    let keys = label_keys(&recipe);
    assert!(!keys.contains(&"low_sugars".to_owned()), "{keys:?}");
    assert!(!keys.contains(&"healthy".to_owned()), "{keys:?}");
    // 178 mg calcium from part of it is still at least a source.
    assert!(keys.contains(&"source_calcium".to_owned()), "{keys:?}");
    let (_, hits) = search(&app, "label=low_sugars&q=pie").await;
    assert_eq!(hits, json!([]));
    let (_, read) = call(&app, "GET", &format!("/api/recipes/{}", recipe["id"]), None).await;
    assert_eq!(label_keys(&read), keys);
}

/// The filter runs in SQL: a match past the 50 foods a search returns is
/// still found.
#[tokio::test]
async fn a_label_filter_finds_a_match_past_row_50() {
    let app = app();
    for i in 0..60 {
        create_food(&app, &format!("Aaa {i:02}"), json!({ "energy": 300 })).await;
    }
    let bran = create_food(
        &app,
        "Zzz bran",
        json!({ "energy": 300, "fiber": 40, "fat": 3 }),
    )
    .await;
    let (status, hits) = search(&app, "sort=name&label=high_fiber").await;
    assert_eq!(status, StatusCode::OK, "{hits}");
    let ids: Vec<i64> = hits
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["id"].as_i64().unwrap())
        .collect();
    assert_eq!(ids, [bran]);
    // Repeated, every label must hold.
    let (_, hits) = search(&app, "label=high_fiber&label=low_fat").await;
    assert_eq!(hits.as_array().unwrap().len(), 1, "{hits}");
    let (_, hits) = search(&app, "label=high_fiber&label=low_sugars").await;
    assert_eq!(hits, json!([]));
    // A label that doesn't exist is refused, naming the field.
    let (status, e) = search(&app, "label=fruit_veg").await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{e}");
    assert_eq!(e["field"], "label");
}

/// One Drink tick (ADR 0020 rework): drink is derived unless set by hand;
/// what a food adds to hydration is read from its values, and a sent
/// `hydrates` is ignored.
#[tokio::test]
async fn drink_is_derived_unless_set_by_hand() {
    let app = app();
    let read = |id: i64| {
        let app = app.clone();
        async move { call(&app, "GET", &format!("/api/foods/{id}"), None).await.1 }
    };
    // A water value hydrates, a drink or not.
    let soup = create_food(&app, "Soup", json!({ "energy": 40, "water": 90 })).await;
    let f = read(soup).await;
    assert_eq!(f["drink"], false);
    assert_eq!(f["hydration"], json!({ "water": 90.0, "alcohol": 0.0 }));
    assert!(f.get("hydrates").is_none(), "{f}");
    let (_, cola) = call(
        &app,
        "POST",
        "/api/foods",
        Some(json!({ "name": "Cola", "category": "sugary_drinks",
                     "per100": { "energy": 48, "net_carbs": 12 } })),
    )
    .await;
    // A sugary drink is a drink; its water is estimated.
    assert_eq!(cola["drink"], true);
    assert_eq!(cola["hydration"], json!({ "water": 88.0, "alcohol": 0.0 }));
    // A drink takes the drink thresholds: 12 g sugar is no red for a food.
    let crisps = create_food(&app, "Crisps", json!({ "energy": 530 })).await;
    assert_eq!(read(crisps).await["hydration"], Value::Null);
    let uri = format!("/api/foods/{crisps}");
    let (status, f) = put_with_rev(
        &app,
        &uri,
        json!({ "per100": { "energy": 530, "water": 2 }, "hydrates": false }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{f}");
    assert_eq!(f["hydration"]["water"], 2.0, "hydrates is ignored");
    // Ticked by hand: a drink, labelled as one.
    let (_, f) = put_with_rev(&app, &uri, json!({ "drink": true })).await;
    assert_eq!(f["drink"], true);
}

/// Hydration (ml) and whether it's known on `DAY`.
async fn hydration(app: &Router) -> (f64, bool) {
    let (_, days) = call(
        app,
        "GET",
        &format!("{HABIT_DAYS}?from={DAY}&to={DAY}"),
        None,
    )
    .await;
    let row = days
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["habit"] == "water")
        .unwrap_or_else(|| panic!("no water row in {days}"));
    (
        row["amount"].as_f64().unwrap(),
        row["known"].as_bool().unwrap(),
    )
}

/// Hydration is read from what was eaten and drunk (ADR 0020, EFSA 2010:
/// food moisture is part of the water intake): a drink's water value or
/// estimate, any food's water value; a food with neither adds nothing and
/// leaves the day's hydration unknown by its dry matter.
#[tokio::test]
async fn hydration_counts_water_values_and_estimates_drinks() {
    let app = app();
    // A drink without a water value: 100 − (10.6 + 0.1) ml per 100 ml.
    let (_, cola) = call(
        &app,
        "POST",
        "/api/foods",
        Some(json!({ "name": "Cola", "category": "sugary_drinks",
                     "per100": { "energy": 42, "net_carbs": 10.6, "protein": 0.1,
                                 "caffeine": 10 } })),
    )
    .await;
    log_entry_on(&app, DAY, "Eaten", cola["id"].as_i64().unwrap(), 330.0).await;
    let (ml, known) = hydration(&app).await;
    assert!((ml - 294.69).abs() < 1e-9, "{ml}");
    // Caffeine takes nothing off (Killer 2014); the estimate is known.
    assert!(known);
    // Bread counts its moisture.
    let bread = create_food(&app, "Bread", json!({ "energy": 250, "water": 38 })).await;
    log_entry_on(&app, DAY, "Eaten", bread, 100.0).await;
    let (ml, known) = hydration(&app).await;
    assert!((ml - 332.69).abs() < 1e-9 && known, "{ml} {known}");
    // A food with no water value adds nothing, and its dry matter (all its
    // grams: 100 of 35.31 + 62 + 100) leaves the day unknown.
    let jelly = create_food(
        &app,
        "Jelly",
        json!({ "energy": 60, "net_carbs": 14, "protein": 1 }),
    )
    .await;
    log_entry_on(&app, DAY, "Eaten", jelly, 100.0).await;
    let (ml, known) = hydration(&app).await;
    assert!((ml - 332.69).abs() < 1e-9 && !known, "{ml} {known}");
}

/// A beer counts its water less alcohol's debit: 10 ml a gram (Hobson &
/// Maughan 2010), never more than its water.
#[tokio::test]
async fn a_beer_hydrates_its_water_less_the_alcohol() {
    let app = app();
    let (_, beer) = call(
        &app,
        "POST",
        "/api/foods",
        Some(json!({ "name": "Lager 5%",
                     "per100": { "energy": 43, "net_carbs": 3, "protein": 0.5, "alcohol": 4 },
                     "servings": [{ "label": "0,33 l can", "grams": 330.0 }] })),
    )
    .await;
    assert_eq!(beer["drink"], true, "{beer}");
    // 100 − 3 − 0.5 − 4 = 92.5 ml, less 40 ml for its 4 g of alcohol.
    assert_eq!(beer["hydration"], json!({ "water": 92.5, "alcohol": 40.0 }));
    log_entry_on(&app, DAY, "Eaten", beer["id"].as_i64().unwrap(), 330.0).await;
    let (ml, known) = hydration(&app).await;
    assert!((ml - 173.25).abs() < 1e-9 && known, "{ml} {known}");
}

#[tokio::test]
async fn a_drink_with_nothing_known_hydrates_nothing_known() {
    let app = app();
    let (_, mystery) = call(
        &app,
        "POST",
        "/api/foods",
        Some(json!({ "name": "Mystery drink", "drink": true, "per100": {} })),
    )
    .await;
    log_entry_on(&app, DAY, "Eaten", mystery["id"].as_i64().unwrap(), 250.0).await;
    assert_eq!(hydration(&app).await, (0.0, false));
}

#[tokio::test]
async fn a_recipe_hydrates_through_its_parts() {
    let app = app();
    let water = create_food(&app, "Tap water", json!({ "water": 100 })).await;
    let oats = create_food(&app, "Oats", json!({ "energy": 380, "water": 10 })).await;
    let (_, porridge) = call(
        &app,
        "POST",
        "/api/recipes",
        Some(json!({ "name": "Porridge", "cooked_g": null,
                     "items": [{ "food_id": water, "grams": 300.0 },
                               { "food_id": oats, "grams": 100.0 }] })),
    )
    .await;
    // Half of it: 150 ml of the water and 5 of the oats'.
    assert_eq!(porridge["hydration"]["water"], 77.5, "{porridge}");
    log_entry_on(&app, DAY, "Eaten", porridge["id"].as_i64().unwrap(), 200.0).await;
    let (ml, known) = hydration(&app).await;
    assert!((ml - 155.0).abs() < 1e-9 && known, "{ml} {known}");
}

/// A soft drink of your own, served "250 ml", with no
/// category or water value, counted 0 toward hydration as if known. Its
/// volume serving makes it a drink, so it hydrates by the estimate.
#[tokio::test]
async fn a_soft_drink_served_by_volume_hydrates() {
    let app = app();
    let (status, pepsi) = call(
        &app,
        "POST",
        "/api/foods",
        Some(json!({ "name": "Pepsi Max",
                     "per100": { "energy": 0.4, "net_carbs": 0, "protein": 0, "fat": 0 },
                     "servings": [{ "label": "250 ml", "grams": 250.0 }] })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{pepsi}");
    assert_eq!(pepsi["drink"], true);
    assert_eq!(pepsi["hydration"]["water"], 100.0);
    log_entry_on(&app, DAY, "Eaten", pepsi["id"].as_i64().unwrap(), 1200.0).await;
    assert_eq!(hydration(&app).await, (1200.0, true));
    // An update that adds a volume serving makes one too.
    let juice = create_food(&app, "Juice", json!({ "energy": 45 })).await;
    let (_, f) = put_with_rev(
        &app,
        &format!("/api/foods/{juice}"),
        json!({ "servings": [{ "label": "1 dl", "grams": 100.0 }] }),
    )
    .await;
    assert_eq!(f["drink"], true);
}

/// A cooked recipe's lost weight is water. Soup of
/// 900 ml water and 100 g lentils cooked down to 800 g holds 700 ml: a
/// 200 g bowl hydrates 175 ml, not the raw 225.
#[tokio::test]
async fn a_cooked_recipe_hydrates_by_its_cooked_water() {
    let app = app();
    let water = create_food(&app, "Tap water", json!({ "water": 100 })).await;
    let lentils = create_food(&app, "Lentils", json!({ "energy": 350, "water": 0 })).await;
    let (_, soup) = call(
        &app,
        "POST",
        "/api/recipes",
        Some(json!({ "name": "Soup", "cooked_g": 800.0,
                     "items": [{ "food_id": water, "grams": 900.0 },
                               { "food_id": lentils, "grams": 100.0 }] })),
    )
    .await;
    assert!(
        (soup["per100"]["water"].as_f64().unwrap() - 87.5).abs() < 1e-9,
        "{soup}"
    );
    log_entry_on(&app, DAY, "Eaten", soup["id"].as_i64().unwrap(), 200.0).await;
    let (ml, known) = hydration(&app).await;
    assert!((ml - 175.0).abs() < 1e-9 && known, "{ml} {known}");
}

/// Labels are read as stored: a recipe made by an import is labelled too,
/// so its view and the label filter agree.
#[tokio::test]
async fn an_imported_recipe_is_labelled() {
    let app = app();
    let file = json!({
        "format": "kaloriina-profile", "version": 3, "exported_at": "2026-10-08T10:00:00Z",
        "profile": { "name": "Imported", "sex": null, "birth_date": null, "height_cm": null,
                     "activity": null, "goal_kg_per_week": 0.0 },
        "foods": [
            { "ref": "b", "name": "Bacon", "source": "custom",
              "per100": { "energy": 500, "fat": 40, "saturated": 15, "sugars": 0,
                          "sodium": 1500 } },
            { "ref": "r", "name": "Bacon bits", "source": "custom", "kind": "recipe", "per100": {},
              "items": [{ "food": "b", "grams": 100.0 }] }
        ],
        "entries": [{ "uid": "imp-entry-0001", "day": DAY, "group": "Eaten", "kind": "food",
            "food": "r", "name": "Bacon bits", "grams": 50.0, "amount": "50 g",
            "nutrients": { "energy": 250.0, "fat": 20.0 },
            "created_at": "2026-10-06T10:00:00Z" }],
    });
    let (status, p) = call(&app, "POST", "/api/profiles/import", Some(file)).await;
    assert_eq!(status, StatusCode::CREATED, "{p}");
    let (_, hits) = search(&app, "q=bacon+bits").await;
    let keys = label_keys(&hits[0]);
    assert_eq!(keys[0], "unhealthy", "{hits}");
    assert!(keys.contains(&"high_fat".to_owned()), "{hits}");
}

/// The why of a food, recipe or meal: its reasons' texts, against then for.
fn why(food: &Value) -> Vec<&str> {
    food["labels"]["why"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["text"].as_str().unwrap())
        .collect()
}

/// The owner's fermented pickles (ADR 0033): 3 g of salt, but vegetables,
/// so OK, not Unhealthy; still "High salt". The verdict follows the food's
/// category, and its recipes and meals follow it by the share of their
/// grams that is fruit & veg, through a recipe inside a recipe too.
#[tokio::test]
async fn pickles_score_ok_for_their_vegetables() {
    let app = app();
    let (status, pickles) = call(
        &app,
        "POST",
        "/api/foods",
        Some(
            json!({ "name": "Fermented pickles", "category": "fruit_veg",
                     "per100": { "energy": 12, "net_carbs": 1.4, "sugars": 0, "fat": 0.1,
                                 "saturated": 0, "protein": 1, "sodium": 1200 } }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{pickles}");
    let id = pickles["id"].as_i64().unwrap();
    assert_eq!(pickles["labels"]["verdict"], "ok");
    assert!(label_keys(&pickles).contains(&"high_sodium".to_owned()));
    assert_eq!(why(&pickles), ["salt", "fruit & veg"]);
    assert_eq!(
        pickles["labels"]["why"][0],
        json!({ "key": "sodium", "text": "salt", "positive": false })
    );
    // As read and as searched, from what's stored; the verdict filters.
    let (_, read) = call(&app, "GET", &format!("/api/foods/{id}"), None).await;
    assert_eq!(read["labels"], pickles["labels"]);
    let (status, hits) = search(&app, "label=ok&q=pickles").await;
    assert_eq!(status, StatusCode::OK, "{hits}");
    assert_eq!(hits[0]["labels"], pickles["labels"]);
    // A reason is no filter.
    let (status, _) = search(&app, "label=why_sodium").await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // A recipe of them, and a recipe holding that one: all vegetables.
    let recipe = |name: &str, part: i64| {
        let app = app.clone();
        let name = name.to_owned();
        async move {
            let (status, r) = call(
                &app,
                "POST",
                "/api/recipes",
                Some(json!({ "name": name, "cooked_g": null,
                             "items": [{ "food_id": part, "grams": 100.0 }] })),
            )
            .await;
            assert_eq!(status, StatusCode::CREATED, "{r}");
            r
        }
    };
    let jar = recipe("Pickle jar", id).await;
    assert_eq!(jar["labels"]["verdict"], "ok", "{jar}");
    let platter = recipe("Pickle platter", jar["id"].as_i64().unwrap()).await;
    assert_eq!(platter["labels"]["verdict"], "ok", "{platter}");
    let (status, meal) = call(
        &app,
        "POST",
        "/api/meals",
        Some(json!({ "name": "Pickle snack",
                     "items": [{ "food_id": id, "grams": 50.0 }] })),
    )
    .await;
    assert!(status.is_success(), "{meal}");
    assert_eq!(meal["labels"]["verdict"], "ok", "{meal}");
    assert_eq!(why(&meal), ["salt", "fruit & veg"]);

    // Out of Fruit and vegetables, salt decides: so do its recipes.
    let (status, f) = put_with_rev(
        &app,
        &format!("/api/foods/{id}"),
        json!({ "category": null }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{f}");
    assert_eq!(f["labels"]["verdict"], "unhealthy");
    assert_eq!(why(&f), ["salt"]);
    for r in [&jar, &platter] {
        let (_, r) = call(&app, "GET", &format!("/api/recipes/{}", r["id"]), None).await;
        assert_eq!(r["labels"]["verdict"], "unhealthy", "{r}");
    }
}

/// A drink named for its sweeteners scores one class worse (Nutri-Score
/// 2023): Cola Zero is OK, sparkling water Healthy.
#[tokio::test]
async fn a_sweetened_drink_scores_ok() {
    let app = app();
    let drink = |name: &str| {
        let app = app.clone();
        let name = name.to_owned();
        async move {
            call(
                &app,
                "POST",
                "/api/foods",
                Some(json!({ "name": name, "drink": true,
                             "per100": { "energy": 0.4, "fat": 0, "saturated": 0,
                                         "sugars": 0, "sodium": 8 } })),
            )
            .await
            .1
        }
    };
    let zero = drink("Cola Zero").await;
    assert_eq!(zero["labels"]["verdict"], "ok", "{zero}");
    assert_eq!(why(&zero), ["sweeteners"]);
    let water = drink("Sparkling water").await;
    assert_eq!(water["labels"]["verdict"], "healthy", "{water}");
}
