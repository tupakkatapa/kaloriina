//! All time (Profile → All time): a profile's totals since its first day,
//! from per-day aggregates. Its time budget is `tests/bench.rs`'s: a
//! wall clock in this tier fails on a busy host.

use super::*;
use common::app_from;

const STATS: &str = "/api/profiles/1/stats";

/// A database holding two Fineli foods by class: minced beef (`BEEF`,
/// its name no help) and a beef soup (a dish: no beef counted).
fn with_fineli() -> kaloriina::Connection {
    let conn = open(FsPath::new(":memory:")).unwrap();
    conn.execute_batch(
        r#"INSERT INTO food (id, name, source, per100, fineli_id, fineli_class)
           VALUES (900, 'Jauheliha, 10 %', 'fineli', '{"energy": 180}', 712, 'BEEF'),
                  (901, 'Naudanlihakeitto', 'fineli', '{"energy": 60}', 3001, 'DISH');"#,
    )
    .unwrap();
    conn
}

/// Food over three days (a gap before the third), three sessions, two
/// synced days with a night, a nap and two weigh-ins.
async fn seed(app: &Router) {
    let coffee = create_food(
        app,
        "Coffee",
        json!({ "energy": 2.0, "caffeine": 40.0, "water": 99.0 }),
    )
    .await;
    let steak = create_food(app, "Beef steak", json!({ "energy": 250.0 })).await;
    let mash = create_food(app, "Potato mash", json!({ "energy": 90.0 })).await;
    let beer = create_food(app, "Beer", json!({ "energy": 40.0, "alcohol": 4.0 })).await;
    // Two days in a row, a gap, one more; Planned counts for nothing.
    for (day, food, grams) in [
        ("2026-09-01", coffee, 200.0),
        ("2026-09-01", steak, 150.0),
        ("2026-09-02", mash, 300.0),
        ("2026-09-02", 900, 100.0),
        ("2026-09-02", 901, 400.0),
        ("2026-09-05", beer, 500.0),
    ] {
        log_entry_on(app, day, "Eaten", food, grams).await;
    }
    log_entry_on(app, "2026-09-07", "Planned", steak, 1000.0).await;
    let session = |day: &str, kind: &str, minutes: u32, distance: Value| {
        json!({ "day": day, "name": "Out", "type": kind, "minutes": minutes,
                "kcal": null, "sets": [], "distance_m": distance })
    };
    for body in [
        session("2026-09-01", "run", 30, json!(5000)),
        session("2026-09-03", "run", 60, json!(10000)),
        session("2026-09-02", "workout", 45, Value::Null),
    ] {
        let (status, res) = call(app, "POST", "/api/profiles/1/activities", Some(body)).await;
        assert_eq!(status, StatusCode::CREATED, "{res}");
    }
    // The night of the 1st: 450 min in bed, the first 30 awake.
    hc_records(
        app,
        1,
        json!([hc_sleep(
            "s-1",
            "2026-08-31T23:00:00Z",
            "2026-09-01T06:30:00Z",
            &[("2026-08-31T23:00:00Z", "2026-08-31T23:30:00Z", 1)]
        )]),
    )
    .await;
    let (status, res) = call(
        app,
        "POST",
        "/api/profiles/1/sync/health",
        Some(
            json!({ "from": "2026-09-01", "to": "2026-09-02", "device": "Pixel 9",
            "days": [{ "day": "2026-09-01", "steps": 8000 },
                     { "day": "2026-09-02", "steps": 12000 }] }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{res}");
    call(
        app,
        "POST",
        "/api/profiles/1/naps",
        Some(json!({ "uid": "stats-nap-1", "day": "2026-09-02",
            "start_at": "2026-09-02T12:00:00Z", "end_at": "2026-09-02T12:30:00Z" })),
    )
    .await;
    for (day, kg) in [("2026-09-01", 70.0), ("2026-09-05", 69.5)] {
        call(
            app,
            "PUT",
            &format!("/api/profiles/1/weights/{day}"),
            Some(json!({ "kg": kg })),
        )
        .await;
    }
}

#[tokio::test]
async fn all_time_counts_the_profiles_days_food_activity_and_sleep() {
    let app = app_from(with_fineli(), NO_OFF);
    let (status, empty) = call(&app, "GET", STATS, None).await;
    assert_eq!(status, StatusCode::OK, "{empty}");
    assert_eq!(
        (
            &empty["first_day"],
            &empty["days_logged"],
            &empty["longest_streak"]
        ),
        (&Value::Null, &json!(0), &json!(0))
    );

    seed(&app).await;

    let (status, s) = call(&app, "GET", STATS, None).await;
    assert_eq!(status, StatusCode::OK, "{s}");
    let close = |key: &str, want: f64| {
        let got = s[key].as_f64().unwrap_or_else(|| panic!("{key}: {s}"));
        assert!((got - want).abs() < 1e-6, "{key}: {got} != {want}");
    };
    assert_eq!(s["first_day"], "2026-09-01");
    assert_eq!(s["days_logged"], 3);
    assert_eq!(s["longest_streak"], 2);
    assert_eq!(s["entries"], 6);
    close("kcal_eaten", 4.0 + 375.0 + 270.0 + 180.0 + 240.0 + 200.0);
    close("caffeine_mg", 80.0);
    close("water_ml", 198.0);
    close("alcohol_g", 20.0);
    // A class decides a Fineli food; a name decides one of your own.
    close("beef_g", 250.0);
    close("potato_g", 300.0);
    assert_eq!(s["activities"], 3);
    assert_eq!(s["minutes_trained"], 135);
    assert_eq!(s["distance_m"], 15000);
    assert_eq!(
        s["by_type"],
        json!([
            { "type": "run", "activities": 2, "minutes": 90, "distance_m": 15000 },
            { "type": "workout", "activities": 1, "minutes": 45, "distance_m": 0 },
        ])
    );
    assert_eq!(s["steps"], 20000);
    // The days the device counted steps, for "steps a day".
    assert_eq!(s["step_days"], 2);
    assert_eq!(s["asleep_min"], 450);
    assert_eq!(s["naps"], 1);
    assert_eq!(s["weigh_ins"], 2);
    // Each total's own first day, as its tile says it.
    assert_eq!(
        (&s["activities_from"], &s["naps_from"], &s["weigh_ins_from"]),
        (
            &json!("2026-09-01"),
            &json!("2026-09-02"),
            &json!("2026-09-01")
        )
    );
    // The library's: instance-wide, the seeded Water and Creatine aside.
    assert_eq!(s["custom_foods"], 4);
    assert_eq!(s["recipes"], 0);
    assert_eq!(s["meals"], 0);

    let (status, _) = call(&app, "GET", "/api/profiles/9/stats", None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn all_time_sums_a_year_of_data() {
    let conn = open(FsPath::new(":memory:")).unwrap();
    // A year: ten entries a day with a few nutrients each, a session every
    // other day, a synced day with a night every day.
    conn.execute_batch(
        r#"INSERT INTO food (id, name, source, per100) VALUES (900, 'Oats', 'custom', '{"energy": 380}');
           WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 3649)
           INSERT INTO entry (profile_id, day, grp, food_id, name, grams, amount, nutrients)
           SELECT 1, date('2025-01-01', '+' || (i / 10) || ' days'), 'Eaten', 900, 'Oats', 60,
                  '60 g', '{"energy": 228, "protein": 8, "caffeine": 10, "water": 50, "alcohol": 0}'
           FROM n;
           WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 364)
           INSERT INTO device_day (profile_id, day, steps, active_kcal, asleep_min, in_bed_min,
                                     bedtime, wake_time)
           SELECT 1, date('2025-01-01', '+' || i || ' days'), 9000, 400, 430, 460, '23:00', '07:00'
           FROM n;
           WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 182)
           INSERT INTO activity (profile_id, day, name, minutes, type, distance_m)
           SELECT 1, date('2025-01-01', '+' || (i * 2) || ' days'), 'Run', 40, 'run', 7000
           FROM n;"#,
    )
    .unwrap();
    let app = app_from(conn, NO_OFF);
    let (status, s) = call(&app, "GET", STATS, None).await;
    assert_eq!(status, StatusCode::OK, "{s}");
    assert_eq!(
        (&s["days_logged"], &s["longest_streak"]),
        (&json!(365), &json!(365))
    );
    assert_eq!(s["entries"], 3650);
    assert_eq!(s["kcal_eaten"], 832_200.0);
    assert_eq!(s["steps"], 365 * 9000);
    assert_eq!(s["step_days"], 365);
    assert_eq!(s["asleep_min"], 365 * 430);
    assert_eq!(s["activities"], 183);
}

/// Before a `kaloriina fineli` run no food has its class: beef and potato
/// can't be told, so All time doesn't say them.
#[tokio::test]
async fn classes_unknown_hides_beef() {
    let (status, s) = call(&app(), "GET", STATS, None).await;
    assert_eq!(status, StatusCode::OK, "{s}");
    assert_eq!(s["classes_known"], false, "{s}");
    let (_, s) = call(&app_from(with_fineli(), NO_OFF), "GET", STATS, None).await;
    assert_eq!(s["classes_known"], true, "{s}");
}

/// A recipe counts its ingredients' shares (down through recipes in
/// recipes); a Fineli food without a class is never named into beef (a
/// dish's name says little); a name of your own is folded beyond ASCII.
#[tokio::test]
async fn recipe_beef_counts_by_share() {
    let conn = with_fineli();
    conn.execute_batch(
        r#"INSERT INTO food (id, name, source, per100, fineli_id)
           VALUES (902, 'Naudan jauheliha-perunavuoka', 'fineli', '{"energy": 120}', 3002);"#,
    )
    .unwrap();
    let app = app_from(conn, NO_OFF);
    let beef = create_food(&app, "HÄRKÄPAISTI", json!({ "energy": 200.0 })).await;
    let carrot = create_food(&app, "Carrot", json!({ "energy": 40.0 })).await;
    let recipe = |name: &str, items: &[(i64, f64)]| {
        json!({ "name": name, "items": items.iter()
            .map(|(id, g)| json!({ "food_id": id, "grams": g })).collect::<Vec<_>>() })
    };
    let (status, stew) = call(
        &app,
        "POST",
        "/api/recipes",
        Some(recipe("Stew", &[(beef, 300.0), (carrot, 100.0)])),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{stew}");
    let stew = stew["id"].as_i64().unwrap();
    // A meal of half stew (by weight), half Fineli beef.
    let (status, plate) = call(
        &app,
        "POST",
        "/api/recipes",
        Some(recipe("Plate", &[(stew, 100.0), (900, 100.0)])),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{plate}");
    let plate = plate["id"].as_i64().unwrap();
    for (food, grams) in [(stew, 200.0), (plate, 400.0), (902, 300.0)] {
        log_entry_on(&app, "2026-09-01", "Eaten", food, grams).await;
    }
    let (_, s) = call(&app, "GET", STATS, None).await;
    // Stew: 200 × ¾ = 150. Plate: 400 × ½ × ¾ = 150 of stew's, 200 Fineli.
    assert_eq!(s["beef_g"], 500.0, "{s}");
    assert_eq!(s["potato_g"], 0.0, "{s}");
}

/// The foods a migration seeds (Water 25, Creatine monohydrate 36) and the
/// archived ones aren't "foods of your own".
#[tokio::test]
async fn seeded_foods_are_not_yours() {
    let app = app();
    let (_, s) = call(&app, "GET", STATS, None).await;
    assert_eq!(s["custom_foods"], 0, "{s}");
    let mine = create_food(&app, "Porridge", json!({ "energy": 70.0 })).await;
    create_food(&app, "Gone", json!({ "energy": 70.0 })).await;
    let (_, s) = call(&app, "GET", STATS, None).await;
    assert_eq!(s["custom_foods"], 2, "{s}");
    let uri = format!("/api/foods/{}", mine + 1);
    let (_, mut gone) = call(&app, "GET", &uri, None).await;
    gone["archived"] = json!(true);
    let (status, res) = put_with_rev(&app, &uri, gone).await;
    assert_eq!(status, StatusCode::OK, "{res}");
    let (_, s) = call(&app, "GET", STATS, None).await;
    assert_eq!(s["custom_foods"], 1, "{s}");
}

/// Beef and potato from every source: a Fineli dish counts by the class
/// its import gave it (plain cooked potato `POTATO`, a beef steak `BEEF`;
/// see `fineli::ingredient_classes`), an Open Food Facts food by its name,
/// unless the name says it is mixed (pork) or a dry product (crisps).
#[tokio::test]
async fn beef_and_potato_from_fineli_dishes_and_off_names() {
    let conn = with_fineli();
    conn.execute_batch(
        r#"INSERT INTO food (id, name, source, per100, fineli_id, fineli_class)
           VALUES (910, 'Peruna, keitetty', 'fineli', '{"energy": 75}', 4001, 'POTATO'),
                  (911, 'Naudanlihapihvi, paistettu', 'fineli', '{"energy": 200}', 4002, 'BEEF'),
                  (912, 'Kermaperuna', 'fineli', '{"energy": 120}', 4003, 'DISH');
           INSERT INTO food (id, name, source, per100) VALUES
                  (920, 'Uudet perunat', 'off', '{"energy": 70}'),
                  (921, 'Perunalastut', 'off', '{"energy": 530}'),
                  (922, 'Naudan ja sian jauheliha', 'off', '{"energy": 220}'),
                  (923, 'Beef burger', 'off', '{"energy": 250}');"#,
    )
    .unwrap();
    let app = app_from(conn, NO_OFF);
    for (food, grams) in [
        (910, 100.0),
        (911, 150.0),
        (912, 1000.0),
        (920, 200.0),
        (921, 1000.0),
        (922, 1000.0),
        (923, 120.0),
    ] {
        log_entry_on(&app, "2026-09-01", "Eaten", food, grams).await;
    }
    let (_, s) = call(&app, "GET", STATS, None).await;
    assert_eq!(
        (&s["beef_g"], &s["potato_g"]),
        (&json!(270.0), &json!(300.0)),
        "{s}"
    );
}

/// All time's totals are only as far as the foods eaten carry them
/// (coverage, ADR 0030): a drink that could hold caffeine or alcohol
/// without its value, or a food without a water value, leaves the total a
/// lower bound (`at_least`); water is Hydration's.
#[tokio::test]
async fn caffeine_and_alcohol_say_when_they_are_lower_bounds() {
    let app = app();
    let drink = |name: &str, per100: Value| {
        json!({ "name": name, "per100": per100,
                "servings": [{ "label": "250 ml", "grams": 250.0 }] })
    };
    let (_, both) = call(
        &app,
        "POST",
        "/api/foods",
        Some(drink(
            "Irish coffee",
            json!({ "energy": 100.0, "caffeine": 40.0, "alcohol": 5.0, "water": 80.0 }),
        )),
    )
    .await;
    log_entry_on(
        &app,
        "2026-09-01",
        "Eaten",
        both["id"].as_i64().unwrap(),
        100.0,
    )
    .await;
    let (_, s) = call(&app, "GET", STATS, None).await;
    assert_eq!(s["at_least"], json!([]), "{s}");
    // 80 ml of water less 50 ml for 5 g of alcohol.
    assert_eq!(s["water_ml"], 30.0, "{s}");
    // A cola without its caffeine: a floor.
    let (_, cola) = call(
        &app,
        "POST",
        "/api/foods",
        Some(drink("Cola", json!({ "energy": 40.0, "water": 90.0 }))),
    )
    .await;
    log_entry_on(
        &app,
        "2026-09-02",
        "Eaten",
        cola["id"].as_i64().unwrap(),
        330.0,
    )
    .await;
    // Planned counts for nothing.
    let bread = create_food(&app, "Bread", json!({ "energy": 250.0 })).await;
    log_entry_on(&app, "2026-09-03", "Planned", bread, 100.0).await;
    let (_, s) = call(&app, "GET", STATS, None).await;
    assert_eq!(s["at_least"], json!(["caffeine"]), "{s}");
    // A beer without its alcohol; bread without a water value.
    let (_, beer) = call(
        &app,
        "POST",
        "/api/foods",
        Some(drink(
            "Lager 5%",
            json!({ "energy": 43.0, "water": 92.0, "caffeine": 0.0 }),
        )),
    )
    .await;
    log_entry_on(
        &app,
        "2026-09-03",
        "Eaten",
        beer["id"].as_i64().unwrap(),
        330.0,
    )
    .await;
    log_entry_on(&app, "2026-09-03", "Eaten", bread, 100.0).await;
    let (_, s) = call(&app, "GET", STATS, None).await;
    assert_eq!(
        s["at_least"],
        json!(["water", "caffeine", "alcohol"]),
        "{s}"
    );
}
