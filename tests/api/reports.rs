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
    log_entry(&app, "Eaten", lunch, 100.0).await; // 150 mg
    log_entry(&app, "Eaten", lunch, 100.0).await; // 150 mg
    log_entry(&app, "Eaten", salty, 50.0).await; // 500 mg
    log_entry(&app, "Eaten", salty, 30.0).await; // 300 mg
    log_entry(&app, "Eaten", mild, 200.0).await; // 200 mg
    log_entry(&app, "Eaten", plain, 100.0).await; // no sodium
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
        log_entry(&app, "Eaten", f, f64::from(10 + i)).await;
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

/// EPA+DHA is derived, never typed: the sum of EPA and DHA wherever
/// nutrients are served (food, entry, day, summary, sources), absent when
/// neither is known.
#[tokio::test]
async fn epa_dha_is_the_sum_of_epa_and_dha() {
    let app = app();
    let (_, meta) = call(&app, "GET", "/api/meta", None).await;
    let keys: Vec<&str> = meta["nutrients"]
        .as_array()
        .unwrap()
        .iter()
        .map(|n| n["key"].as_str().unwrap())
        .collect();
    let at = keys.iter().position(|k| *k == "epa_dha").expect("epa_dha");
    assert_eq!(keys[at - 1], "dha");
    let n = &meta["nutrients"][at];
    assert_eq!(
        (
            &n["unit"],
            &n["category"],
            &n["goal"],
            &n["derived"],
            &n["ai"]
        ),
        (
            &json!("g"),
            &json!("Fats"),
            &json!("at_least"),
            &json!(true),
            &json!(true)
        )
    );
    assert_eq!(meta["nutrients"][0]["derived"], false);

    // A typed EPA+DHA is overwritten by the sum.
    let salmon = create_food(
        &app,
        "Salmon",
        json!({ "epa": 0.5, "dha": 1.2, "epa_dha": 99.0 }),
    )
    .await;
    let plain = create_food(&app, "Rice", json!({ "energy": 130.0 })).await;
    let (_, food) = call(&app, "GET", &format!("/api/foods/{salmon}"), None).await;
    let close = |v: &Value, want: f64| (v.as_f64().unwrap() - want).abs() < 1e-9;
    assert!(close(&food["per100"]["epa_dha"], 1.7), "{food}");
    let entry = log_entry(&app, "Eaten", salmon, 200.0).await;
    assert!(close(&entry["nutrients"]["epa_dha"], 3.4), "{entry}");
    log_entry_on(&app, "2026-10-05", "Eaten", plain, 100.0).await;

    let (_, day) = call(&app, "GET", &format!("/api/profiles/1/day/{DAY}"), None).await;
    assert!(close(&day["total"]["epa_dha"], 3.4), "{}", day["total"]);
    let (_, rice_day) = call(&app, "GET", "/api/profiles/1/day/2026-10-05", None).await;
    assert_eq!(
        rice_day["total"].get("epa_dha"),
        None,
        "{}",
        rice_day["total"]
    );

    let (_, summary) = call(
        &app,
        "GET",
        &format!("/api/profiles/1/summary?{FROM_TO}"),
        None,
    )
    .await;
    // The days carry it; the mean is the client's (no `average`).
    assert!(
        close(&summary["days"][1]["total"]["epa_dha"], 3.4),
        "{summary}"
    );
    assert!(summary.get("average").is_none(), "{summary}");
    let (status, src) = sources(&app, &format!("{FROM_TO}&nutrient=epa_dha")).await;
    assert_eq!(status, StatusCode::OK, "{src}");
    assert!(close(&src["total"], 3.4), "{src}");
    assert_eq!(src["foods"][0]["name"], "Salmon", "{src}");
    assert!(close(&src["foods"][0]["amount"], 3.4), "{src}");
}

/// All time reads years of `/summary` for one number: `?keys=` narrows
/// each day's totals to the keys asked; an unknown key is
/// refused.
#[tokio::test]
async fn summary_keys_narrow_the_days() {
    let app = app();
    let oats = create_food(
        &app,
        "Oats",
        json!({ "energy": 380.0, "protein": 13.0, "fat": 7.0 }),
    )
    .await;
    log_entry(&app, "Eaten", oats, 100.0).await;
    let uri = |q: &str| format!("/api/profiles/1/summary?from={DAY}&to={DAY}{q}");
    let (status, all) = call(&app, "GET", &uri(""), None).await;
    assert_eq!(status, StatusCode::OK, "{all}");
    assert_eq!(all["days"][0]["total"]["protein"], 13.0, "{all}");
    let (status, some) = call(&app, "GET", &uri("&keys=energy,fat"), None).await;
    assert_eq!(status, StatusCode::OK, "{some}");
    assert_eq!(
        some["days"][0]["total"],
        json!({ "energy": 380.0, "fat": 7.0 }),
        "{some}"
    );
    assert!(some.get("average").is_none() && some.get("days_logged").is_none());
    let (status, err) = call(&app, "GET", &uri("&keys=energy,nope"), None).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{err}");
    assert_eq!(err["field"], "keys", "{err}");
}

/// A day with an eaten food that carries no energy says so
/// (`energy_unknown`): its energy is a lower bound, as the Diary's "≥".
/// Planned and fully known days don't.
#[tokio::test]
async fn summary_days_say_when_eaten_energy_is_partial() {
    let app = app();
    let oats = create_food(&app, "Oats", json!({ "energy": 380.0 })).await;
    let mystery = create_food(&app, "Mystery", json!({ "protein": 5.0 })).await;
    log_entry(&app, "Eaten", oats, 100.0).await;
    log_entry(&app, "Eaten", mystery, 100.0).await;
    log_entry_on(&app, "2026-10-05", "Eaten", oats, 100.0).await;
    log_entry_on(&app, "2026-10-05", "Planned", mystery, 100.0).await;
    let (status, summary) = call(
        &app,
        "GET",
        &format!("/api/profiles/1/summary?{FROM_TO}&keys=energy"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{summary}");
    let days = summary["days"].as_array().unwrap();
    let of = |d: &str| days.iter().find(|x| x["day"] == d).unwrap();
    assert_eq!(of(DAY)["energy_unknown"], true, "{summary}");
    assert!(
        of("2026-10-05").get("energy_unknown").is_none(),
        "{summary}"
    );
}

/// A Diary group's total is known as far as the day's (`known` by group): a
/// recipe with an ingredient without energy leaves its group's energy
/// partial, as the headline's, and no other group's.
#[tokio::test]
async fn a_diary_groups_energy_is_known_as_far_as_its_recipes() {
    let app = app();
    let oats = create_food(&app, "Oats", json!({ "energy": 380.0 })).await;
    let mystery = create_food(&app, "Mystery spice", json!({ "protein": 10.0 })).await;
    let (status, recipe) = call(
        &app,
        "POST",
        "/api/recipes",
        Some(json!({ "name": "Porridge", "items": [
            { "food_id": oats, "grams": 50.0 },
            { "food_id": mystery, "grams": 50.0 }] })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{recipe}");
    log_entry(&app, "Eaten", recipe["id"].as_i64().unwrap(), 100.0).await;
    log_entry(&app, "Planned", oats, 100.0).await;
    let (status, day) = call(&app, "GET", &format!("/api/profiles/1/day/{DAY}"), None).await;
    assert_eq!(status, StatusCode::OK, "{day}");
    let group = |name: &str| {
        day["groups"]
            .as_array()
            .unwrap()
            .iter()
            .find(|g| g["name"] == name)
            .unwrap()
            .clone()
    };
    // Half of its dry matter carries energy.
    assert!(
        (group("Eaten")["known"]["energy"].as_f64().unwrap() - 0.5).abs() < 1e-6,
        "{day}"
    );
    assert_eq!(group("Eaten")["known"], day["known"], "{day}");
    assert_eq!(group("Planned")["known"], json!({ "dry": 100.0 }), "{day}");
}

/// A nutrient is known as far as the foods eaten carry it: each Summary
/// day's `known` is the share of its food's dry matter that carries a key,
/// for the keys some of its foods lacked, and the dry matter (ADR 0030:
/// warnings need 80 %).
#[tokio::test]
async fn summary_days_say_the_energy_whose_foods_carry_a_key() {
    let app = app();
    let oil = create_food(
        &app,
        "Rapeseed oil",
        json!({ "energy": 900.0, "ala": 9.0, "water": 0.0 }),
    )
    .await;
    let potato = create_food(&app, "Potato", json!({ "energy": 80.0, "water": 80.0 })).await;
    let bread = create_food(
        &app,
        "Rye bread",
        json!({ "energy": 250.0, "ala": 0.1, "iron": 2.0, "water": 40.0 }),
    )
    .await;
    log_entry(&app, "Eaten", oil, 10.0).await; // 90 kcal
    log_entry(&app, "Eaten", potato, 500.0).await; // 400 kcal
    log_entry(&app, "Eaten", bread, 100.0).await; // 250 kcal
    log_entry(&app, "Planned", potato, 500.0).await; // not eaten
    let uri = |q: &str| format!("/api/profiles/1/summary?from={DAY}&to={DAY}{q}");
    let (status, all) = call(&app, "GET", &uri(""), None).await;
    assert_eq!(status, StatusCode::OK, "{all}");
    assert_eq!(all["days"][0]["total"]["energy"], 740.0, "{all}");
    // Dry: oil 10 g, potato 100 g, bread 60 g.
    assert_eq!(
        all["days"][0]["known"],
        json!({ "ala": 70.0 / 170.0, "iron": 60.0 / 170.0, "dry": 170.0 }),
        "energy is on every food, so not listed; {all}"
    );
    let (_, some) = call(&app, "GET", &uri("&keys=energy,ala"), None).await;
    assert_eq!(
        some["days"][0]["known"],
        json!({ "ala": 70.0 / 170.0, "dry": 170.0 }),
        "{some}"
    );
}

async fn rich(app: &Router, query: &str) -> (StatusCode, Value) {
    call(
        app,
        "GET",
        &format!("/api/profiles/1/foods/rich?{query}"),
        None,
    )
    .await
}

/// Good sources of a nutrient for a low warning: per 100 kcal, at least
/// `min`, foods the profile has eaten first, then the library's.
#[tokio::test]
async fn rich_foods_rank_per_100_kcal_eaten_first() {
    let app = app();
    let spinach = create_food(&app, "Spinach", json!({ "energy": 23.0, "iron": 2.7 })).await;
    let beef = create_food(&app, "Beef", json!({ "energy": 250.0, "iron": 2.6 })).await;
    let liver = create_food(&app, "Liver", json!({ "energy": 130.0, "iron": 9.0 })).await;
    let lentils = create_food(&app, "Lentils", json!({ "energy": 116.0, "iron": 3.3 })).await;
    // Too little energy to weigh per 100 kcal; none at all.
    create_food(&app, "Coffee", json!({ "energy": 2.0, "iron": 0.1 })).await;
    create_food(&app, "Iron tablet", json!({ "iron": 14.0 })).await;
    log_entry(&app, "Eaten", spinach, 100.0).await;
    log_entry(&app, "Eaten", beef, 100.0).await;
    log_entry(&app, "Planned", liver, 100.0).await; // planned isn't eaten

    let (status, res) = rich(&app, "nutrient=iron&min=1.6").await;
    assert_eq!(status, StatusCode::OK, "{res}");
    let rows: Vec<_> = res
        .as_array()
        .unwrap()
        .iter()
        .map(|f| (f["food_id"].clone(), f["name"].clone(), f["eaten"].clone()))
        .collect();
    assert_eq!(
        rows,
        [
            (json!(spinach), json!("Spinach"), json!(true)),
            (json!(liver), json!("Liver"), json!(false)),
            (json!(lentils), json!("Lentils"), json!(false)),
        ],
        "beef is under the bar; {res}"
    );
    assert!(
        (res[0]["per_100kcal"].as_f64().unwrap() - 2.7 / 23.0 * 100.0).abs() < 1e-6,
        "{res}"
    );
    // Without a bar, beef is a source too, after the other eaten food.
    let (_, any) = rich(&app, "nutrient=iron").await;
    assert_eq!(any[1]["food_id"], json!(beef), "{any}");

    for bad in [
        "nutrient=nope",
        "",
        "nutrient=iron&min=-1",
        "nutrient=iron&min=x",
    ] {
        let (status, err) = rich(&app, bad).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{bad}: {err}");
    }
}

/// Highlights' hide and pin (ADR 0030): one preference per
/// insight, replaced by the next; hidden needs an `until` day, pinned
/// takes none; deleting one that isn't there is 404.
#[tokio::test]
async fn insight_prefs_hide_pin_and_clear() {
    let app = app();
    let uri = |id: &str| format!("/api/profiles/1/insights/prefs/{id}");
    let list = "/api/profiles/1/insights/prefs";
    assert_eq!(call(&app, "GET", list, None).await.1, json!([]));
    let hidden = json!({ "state": "hidden", "until": "2026-11-01" });
    for _ in 0..2 {
        let (status, p) = call(&app, "PUT", &uri("low-fibre"), Some(hidden.clone())).await;
        assert_eq!(status, StatusCode::OK, "{p}");
    }
    let (status, _) = call(
        &app,
        "PUT",
        &uri("protein-streak"),
        Some(json!({ "state": "pinned" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        call(&app, "GET", list, None).await.1,
        json!([{ "id": "low-fibre", "state": "hidden", "until": "2026-11-01" },
               { "id": "protein-streak", "state": "pinned" }])
    );
    // Pinning a hidden one replaces it.
    call(
        &app,
        "PUT",
        &uri("low-fibre"),
        Some(json!({ "state": "pinned" })),
    )
    .await;
    assert_eq!(call(&app, "GET", list, None).await.1[0]["state"], "pinned");
    for (id, body, field) in [
        ("x", json!({ "state": "hidden" }), "until"),
        ("x", json!({ "state": "hidden", "until": "soon" }), "until"),
        (
            "x",
            json!({ "state": "pinned", "until": "2026-11-01" }),
            "until",
        ),
        (&*"y".repeat(121), json!({ "state": "pinned" }), "id"),
    ] {
        let (status, e) = call(&app, "PUT", &uri(id), Some(body.clone())).await;
        assert_eq!(
            (status, &e["field"]),
            (StatusCode::BAD_REQUEST, &json!(field)),
            "{body}: {e}"
        );
    }
    let (status, e) = call(&app, "PUT", &uri("x"), Some(json!({ "state": "starred" }))).await;
    assert!(status.is_client_error(), "{e}");
    let (status, _) = call(&app, "DELETE", &uri("low-fibre"), None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, e) = call(&app, "DELETE", &uri("low-fibre"), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{e}");
    let (status, _) = call(&app, "GET", "/api/profiles/99/insights/prefs", None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

/// The Summary's charts read their words and lines from meta: the macro
/// trio's short label ("Carbs" for net carbs on either label), and the
/// recommended BMI by age (WHO 18.5–25 from 18, 22–27 from 65).
#[tokio::test]
async fn meta_serves_short_labels_and_the_recommended_bmi() {
    let app = app();
    let (_, meta) = call(&app, "GET", "/api/meta", None).await;
    let n = |key: &str| {
        meta["nutrients"]
            .as_array()
            .unwrap()
            .iter()
            .find(|n| n["key"] == key)
            .unwrap()
            .clone()
    };
    for style in ["display", "display_us"] {
        assert_eq!(n("net_carbs")[style]["short"], "Carbs", "{style}");
        assert_eq!(n("protein")[style]["short"], "Protein", "{style}");
    }
    assert_eq!(n("fiber")["display_us"]["short"], "Fiber");
    assert_eq!(
        meta["limits"]["recommended_bmi"],
        json!([[18.0, 18.5, 25.0], [65.0, 22.0, 27.0]])
    );
}
