use std::fmt::Write as _;

use super::profiles::day_weight_refresh;
use super::*;
use crate::model::{
    ActivitySource, BUILTINS, BuiltinSource, CheckedHabit, DeviceDay, DeviceSession, GoalDir,
    HealthPost, HealthRecord, ImportedWorkout, ItemInput, NAPS_MAX, NapIn, NapSource, RecordsPost,
    SleepStage, SleepStageKind, StageSource, SyncedWorkouts,
};

#[test]
fn the_base_exercise_set_is_well_formed() {
    let base: Vec<BaseExercise> = serde_json::from_str(BASE_EXERCISES).unwrap();
    assert!(base.len() > 100, "{}", base.len());
    let names: Vec<String> = base.iter().map(|e| e.name.to_lowercase()).collect();
    for (i, e) in base.iter().enumerate() {
        e.traits
            .check()
            .unwrap_or_else(|err| panic!("{}: {err}", e.name));
        assert!(!names[..i].contains(&names[i]), "{} twice", e.name);
        let t = &e.traits;
        assert!(
            !t.equipment.is_empty()
                && !t.primary.is_empty()
                && t.pattern.is_some()
                && t.region.is_some()
                && t.group.is_some()
                && t.mechanics.is_some()
                && t.laterality.is_some()
                && t.difficulty.is_some()
                && t.load.is_some(),
            "{} lacks a trait",
            e.name
        );
        if let Some(root) = &e.variant_of {
            let root = base
                .iter()
                .find(|r| &r.name == root)
                .unwrap_or_else(|| panic!("{}: no root {root}", e.name));
            assert!(
                root.variant_of.is_none(),
                "{}: variants are one level",
                e.name
            );
            assert_ne!(root.name, e.name, "{} varies itself", e.name);
        }
    }
}

#[test]
fn base_exercises_refresh_and_yours_stay() {
    let mut conn = Connection::open_in_memory().unwrap();
    migrate(&mut conn).unwrap();
    conn.execute(
        "UPDATE exercise SET traits = '{}' WHERE name = 'Pull-up'",
        [],
    )
    .unwrap();
    conn.execute("DELETE FROM exercise WHERE name = 'Chin-up'", [])
        .unwrap();
    conn.execute(
        "INSERT INTO exercise (name, measure) VALUES ('Burpee pull-up', 'reps')",
        [],
    )
    .unwrap();
    seed_exercises(&mut conn).unwrap();
    let pull = exercise_list(&conn)
        .unwrap()
        .into_iter()
        .find(|e| e.name == "Pull-up")
        .unwrap();
    assert!(pull.traits.primary.contains(&"latissimus dorsi".to_owned()));
    let all = exercise_list(&conn).unwrap();
    assert!(all.iter().any(|e| e.name == "Chin-up"));
    let yours = all.iter().find(|e| e.name == "Burpee pull-up").unwrap();
    assert_eq!(yours.source, ExerciseSource::Custom);
    let chin = all.iter().find(|e| e.name == "Chin-up").unwrap();
    assert_eq!(
        chin.variant_of,
        Some(pull.id),
        "re-added variants find their root"
    );
}

#[test]
fn seeding_an_unchanged_base_set_writes_nothing() {
    let mut conn = Connection::open_in_memory().unwrap();
    migrate(&mut conn).unwrap();
    seed_exercises(&mut conn).unwrap();
    let sequence = |conn: &Connection| -> i64 {
        conn.query_row(
            "SELECT seq FROM sqlite_sequence WHERE name = 'exercise'",
            [],
            |r| r.get(0),
        )
        .unwrap()
    };
    let before = sequence(&conn);
    let changes = conn.total_changes();
    seed_exercises(&mut conn).unwrap();
    assert_eq!(sequence(&conn), before, "no ids burnt");
    assert_eq!(conn.total_changes(), changes, "no rows rewritten");
}

const ME: ProfileId = ProfileId(1);

fn memory() -> Connection {
    let mut conn = Connection::open_in_memory().expect("in-memory db");
    migrate(&mut conn).expect("migrate");
    conn.pragma_update(None, "foreign_keys", "ON")
        .expect("pragma");
    register_functions(&conn).expect("functions");
    conn
}

#[test]
fn search_puts_favourites_then_your_own_first() {
    let conn = memory();
    conn.execute_batch(
        "INSERT INTO food (id, name, source, per100) VALUES
           (11, 'Apple a', 'fineli', '{}'),
           (12, 'Apple b', 'custom', '{}'),
           (13, 'Apple z', 'off', '{}'),
           (14, 'Apple m', 'custom', '{}');
         INSERT INTO favorite (profile_id, food_id) VALUES (1, 13);",
    )
    .unwrap();
    let names: Vec<String> = food_search(&conn, &query("apple"))
        .unwrap()
        .into_iter()
        .map(|f| f.name)
        .collect();
    assert_eq!(names, ["Apple z", "Apple b", "Apple m", "Apple a"]);
}

fn nut(pairs: &[(&str, f64)]) -> Nutrients {
    Nutrients::of(pairs)
}

fn food(conn: &mut Connection, name: &str, per100: &[(&str, f64)]) -> i64 {
    let input = FoodInput {
        name: name.into(),
        per100: nut(per100),
        ..FoodInput::default()
    };
    food_insert(conn, &input, Source::Custom).unwrap().id
}

/// A search for `q` as the first profile, everything else default.
fn query(q: &str) -> FoodQuery<'_> {
    FoodQuery {
        q,
        archived: false,
        sources: vec![],
        min: vec![],
        max: vec![],
        sort: Sort::Relevance,
        profile: ME,
        left: None,
        labels: vec![],
    }
}

/// Log `grams` of `food`.
fn log(
    conn: &mut Connection,
    profile: ProfileId,
    day: &str,
    group: &str,
    food: &Food,
    grams: f64,
) -> Entry {
    let m = Measured {
        grams,
        serving: None,
        quantity: None,
        amount: gram_amount(grams),
    };
    let at = Slot {
        profile,
        day,
        group,
        uid: None,
        time: None,
    };
    entry_log(conn, &at, food, &m, None).unwrap()
}

/// The revision a row is at now, for an update made from it.
fn rev(conn: &Connection, table: &str, id: i64) -> i64 {
    conn.query_row(
        &format!("SELECT rev FROM {table} WHERE id = ?"),
        [id],
        |r| r.get(0),
    )
    .unwrap()
}

fn recipe(name: &str, items: &[(i64, f64)]) -> RecipeInput {
    RecipeInput {
        name: name.into(),
        cooked_g: None,
        makes: None,
        items: items
            .iter()
            .map(|&(food_id, grams)| ItemInput::grams(food_id, grams))
            .collect(),
        servings: vec![],
        rev: None,
        uid: None,
        archived: false,
        notes: None,
        category: None,
    }
}

#[test]
fn gram_amounts_are_short() {
    assert_eq!(gram_amount(50.0), "50 g");
    assert_eq!(gram_amount(100.0 / 3.0), "33.3 g");
    assert_eq!(gram_amount(0.25), "0.3 g");
}

#[test]
fn migrate_is_idempotent() {
    let mut conn = memory();
    migrate(&mut conn).unwrap();
    let v: u32 = conn
        .pragma_query_value(None, "user_version", |r| r.get(0))
        .unwrap();
    assert_eq!(v as usize, MIGRATIONS.len());
}

#[test]
fn migration_2_backfills_uids() {
    let mut conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(MIGRATIONS[0]).unwrap();
    conn.pragma_update(None, "user_version", 1).unwrap();
    conn.execute(
        "INSERT INTO entry (day, grp, name, amount) VALUES
             ('2026-01-01', 'Eaten', 'A', '1 g'), ('2026-01-01', 'Eaten', 'B', '1 g')",
        [],
    )
    .unwrap();
    migrate(&mut conn).unwrap();
    let uids: Vec<String> = conn
        .prepare("SELECT uid FROM entry")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert_eq!(uids.len(), 2);
    assert!(uids.iter().all(|u| u.len() == 32));
    assert_ne!(uids[0], uids[1]);
}

#[test]
fn migration_3_moves_everything_into_me() {
    let mut conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(MIGRATIONS[0]).unwrap();
    conn.execute_batch(MIGRATIONS[1]).unwrap();
    conn.pragma_update(None, "user_version", 2).unwrap();
    conn.execute_batch(
        "INSERT INTO entry (day, grp, name, amount) VALUES ('2026-01-01', 'Eaten', 'A', '1 g');
         INSERT INTO day_total VALUES ('2026-01-01', 'Other', '{}');
         INSERT INTO target VALUES ('energy', 2000, NULL);",
    )
    .unwrap();
    let uid: String = conn
        .query_row("SELECT uid FROM entry", [], |r| r.get(0))
        .unwrap();
    migrate(&mut conn).unwrap();
    conn.pragma_update(None, "foreign_keys", "ON").unwrap();

    let me = profile_by_name(&conn, "Me").unwrap().unwrap();
    assert_eq!(me.id, ME);
    let entries = entry_list_for_day(&conn, ME, "2026-01-01").unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].uid, uid, "uids survive the rebuild");
    assert_eq!(
        group_totals(&conn, ME, "2026-01-01", "2026-01-01")
            .unwrap()
            .len(),
        1
    );
    assert_eq!(target_list(&conn, ME).unwrap()[0].min, Some(1900.0));
    // The rebuilt table still assigns uids to new rows.
    let food_id = food(&mut conn, "Milk", &[]);
    let milk = food_get(&conn, food_id).unwrap().unwrap();
    assert_eq!(
        log(&mut conn, ME, "2026-01-02", "Eaten", &milk, 1.0)
            .uid
            .len(),
        32
    );
}

#[test]
fn deleting_a_profile_cascades_and_keeps_the_last() {
    let mut conn = memory();
    let input = ProfileInput {
        name: "Guest".into(),
        ..ProfileInput::default()
    };
    let guest = profile_insert(&mut conn, &input, &[Target::single("energy", 1.0)])
        .unwrap()
        .id;
    let id = food(&mut conn, "Milk", &[]);
    let milk = food_get(&conn, id).unwrap().unwrap();
    log(&mut conn, guest, "2026-10-06", "Eaten", &milk, 1.0);
    favorite_set(&conn, guest, milk.id, true).unwrap();
    assert!(
        entry_list_for_day(&conn, ME, "2026-10-06")
            .unwrap()
            .is_empty(),
        "profiles are separate"
    );

    profile_delete(&mut conn, guest).unwrap();
    let left: i64 = conn
        .query_row(
            "SELECT (SELECT count(*) FROM entry) + (SELECT count(*) FROM target)
                 + (SELECT count(*) FROM favorite)",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(left, 0);
    assert!(matches!(
        profile_delete(&mut conn, ME),
        Err(Error::Conflict { .. })
    ));
    assert!(matches!(
        profile_delete(&mut conn, guest),
        Err(Error::NotFound { .. })
    ));
}

#[test]
fn fineli_foods_update_in_place() {
    let mut conn = memory();
    let food = |name: &str, kcal: f64| FoodInput {
        name: name.into(),
        per100: nut(&[("energy", kcal)]),
        servings: vec![Serving {
            label: "dl".into(),
            grams: 100.0,
        }],
        ..FoodInput::default()
    };
    assert_eq!(
        food_upsert_fineli(
            &mut conn,
            &[(7, food("Maito", 40.0))],
            &crate::fineli::serving_labels(),
            &[]
        )
        .unwrap(),
        1
    );
    let id: i64 = conn
        .query_row("SELECT id FROM food WHERE fineli_id = 7", [], |r| r.get(0))
        .unwrap();
    let recipe = recipe_save(&mut conn, None, &recipe("Puuro", &[(id, 100.0)])).unwrap();
    let at = Slot {
        profile: ME,
        day: "2026-10-01",
        group: "Eaten",
        uid: None,
        time: None,
    };
    let m = Measured {
        grams: 100.0,
        serving: None,
        quantity: None,
        amount: "100 g".into(),
    };
    let maito = food_get(&conn, id).unwrap().unwrap();
    let logged = entry_log(&mut conn, &at, &maito, &m, None).unwrap();

    assert_eq!(
        food_upsert_fineli(
            &mut conn,
            &[(7, food("Maito, rasvaton", 35.0))],
            &crate::fineli::serving_labels(),
            &[]
        )
        .unwrap(),
        0
    );
    let milk = food_get(&conn, id).unwrap().unwrap();
    assert_eq!(milk.name, "Maito, rasvaton");
    assert_eq!(milk.source, Source::Fineli);
    assert_eq!(milk.per100.get("energy"), Some(35.0));
    assert_eq!(milk.servings.len(), 1, "servings replaced, not appended");
    let recipe = food_get(&conn, recipe.food.id).unwrap().unwrap();
    assert_eq!(recipe.per100.get("energy"), Some(35.0), "recipes follow");
    assert_eq!(
        stored(&conn, logged.id.unwrap()).1,
        Some(35.0),
        "entries too"
    );
    // An importer's rename isn't yours: past entries keep their name
    // (ADR 0006).
    assert_eq!(
        entry_get(&conn, ME, logged.id.unwrap())
            .unwrap()
            .unwrap()
            .name,
        "Maito"
    );
}

/// A Fineli food an export brought before Fineli was is your own
/// copy; the Fineli import takes it back, by the Fineli id it kept or (an
/// older copy without one) by its name and brand, so its entries stay on
/// one food that gains Fineli's values.
#[test]
fn fineli_import_takes_back_an_exports_copies() {
    let mut conn = memory();
    let copy = |name: &str| FoodInput {
        name: name.into(),
        brand: Some("Fineli".into()),
        per100: Nutrients::of(&[("energy", 80.0)]),
        ..FoodInput::default()
    };
    let kept = food_insert(&mut conn, &copy("Peruna"), Source::Custom).unwrap();
    conn.execute("UPDATE food SET fineli_id = 28914 WHERE id = ?", [kept.id])
        .unwrap();
    let older = food_insert(&mut conn, &copy("Olut"), Source::Custom).unwrap();
    let fineli = |name: &str| FoodInput {
        per100: Nutrients::of(&[("energy", 81.0), ("vitamin_c", 5.5)]),
        ..copy(name)
    };
    let added = food_upsert_fineli(
        &mut conn,
        &[(28914, fineli("Peruna")), (903, fineli("Olut"))],
        &crate::fineli::serving_labels(),
        &[],
    )
    .unwrap();
    assert_eq!(added, 0, "both taken back, none new");
    for (id, fineli_id) in [(kept.id, 28914), (older.id, 903)] {
        let f = food_get(&conn, id).unwrap().unwrap();
        assert_eq!(f.source, Source::Fineli);
        assert_eq!(f.per100.get("vitamin_c"), Some(5.5));
        let stored: i64 = conn
            .query_row("SELECT fineli_id FROM food WHERE id = ?", [id], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(stored, fineli_id);
    }
}

#[test]
fn fineli_reimport_keeps_servings_you_added() {
    let mut conn = memory();
    let milk = |grams: f64| FoodInput {
        name: "Maito".into(),
        servings: vec![Serving {
            label: "dl".into(),
            grams,
        }],
        ..FoodInput::default()
    };
    food_upsert_fineli(
        &mut conn,
        &[(7, milk(103.0))],
        &crate::fineli::serving_labels(),
        &[],
    )
    .unwrap();
    let id: i64 = conn
        .query_row("SELECT id FROM food WHERE fineli_id = 7", [], |r| r.get(0))
        .unwrap();
    conn.execute(
        "INSERT INTO serving (food_id, label, grams) VALUES (?, 'Glass', 200)",
        [id],
    )
    .unwrap();
    food_upsert_fineli(
        &mut conn,
        &[(7, milk(104.0))],
        &crate::fineli::serving_labels(),
        &[],
    )
    .unwrap();
    let servings = food_get(&conn, id).unwrap().unwrap().servings;
    assert_eq!(
        servings
            .iter()
            .map(|s| (s.label.as_str(), s.grams))
            .collect::<Vec<_>>(),
        [("dl", 104.0), ("Glass", 200.0)],
        "Fineli's own unit refreshed in place, yours kept, order as it was"
    );
    // You make your glass the default (first); a re-import keeps it so.
    let mine = FoodInput {
        servings: vec![
            Serving {
                label: "Glass".into(),
                grams: 200.0,
            },
            Serving {
                label: "dl".into(),
                grams: 104.0,
            },
        ],
        rev: Some(rev(&conn, "food", id)),
        ..milk(104.0)
    };
    food_update(&mut conn, id, &mine).unwrap();
    food_upsert_fineli(
        &mut conn,
        &[(7, milk(105.0))],
        &crate::fineli::serving_labels(),
        &[],
    )
    .unwrap();
    let servings = food_get(&conn, id).unwrap().unwrap().servings;
    assert_eq!(servings[0].label, "Glass", "{servings:?}");
    assert_close!(servings[1].grams, 105.0);
}
#[test]
fn entries_tell_which_database_they_come_from() {
    let mut conn = memory();
    let milk = FoodInput {
        name: "Maito".into(),
        ..FoodInput::default()
    };
    food_upsert_fineli(
        &mut conn,
        &[(7, milk)],
        &crate::fineli::serving_labels(),
        &[],
    )
    .unwrap();
    let milk = food_search(&conn, &query("Maito")).unwrap().remove(0);
    log(&mut conn, ME, "2026-10-07", "Eaten", &milk, 100.0);
    imported_entries_replace(
        &conn,
        ME,
        &[ImportedEntry {
            day: "2026-10-07".into(),
            group: "Eaten".into(),
            name: "Old soup".into(),
            amount: "1 bowl".into(),
        }],
    )
    .unwrap();

    let sources: Vec<_> = entry_list_for_day(&conn, ME, "2026-10-07")
        .unwrap()
        .into_iter()
        .map(|e| (e.name, e.source))
        .collect();
    assert_eq!(
        sources,
        [
            ("Maito".to_owned(), Some(Source::Fineli)),
            ("Old soup".to_owned(), None),
        ]
    );
}

#[test]
fn child_rows_are_found_by_index() {
    // Servings are read per search result; a scan per row made search 5x
    // slower.
    let conn = memory();
    for (sql, index) in [
        (
            "SELECT label FROM serving WHERE food_id = 1",
            "serving_food",
        ),
        (
            "SELECT grams FROM recipe_item WHERE recipe_id = 1",
            "recipe_item_recipe",
        ),
        (
            "SELECT grams FROM meal_item WHERE meal_id = 1",
            "meal_item_meal",
        ),
    ] {
        let plan: String = conn
            .query_row(&format!("EXPLAIN QUERY PLAN {sql}"), [], |r| r.get(3))
            .unwrap();
        assert!(plan.contains(index), "{sql}: {plan}");
    }
}

#[test]
fn migration_11_keeps_one_number_per_target() {
    // Before: min/max pairs, including legacy min = max rows.
    let mut conn = Connection::open_in_memory().unwrap();
    for sql in &MIGRATIONS[..10] {
        conn.execute_batch(sql).unwrap();
    }
    conn.pragma_update(None, "user_version", 10).unwrap();
    conn.execute_batch(
        "INSERT INTO target VALUES (1, 'energy', 1900, 1900);
         INSERT INTO target VALUES (1, 'sodium', 2000, 2000);
         INSERT INTO target VALUES (1, 'iron', 11, NULL);
         INSERT INTO target VALUES (1, 'saturated', NULL, 20);
         INSERT INTO target VALUES (1, 'zinc', NULL, NULL);",
    )
    .unwrap();
    migrate(&mut conn).unwrap();

    let list = target_list(&conn, ME).unwrap();
    let get = |k: &str| list.iter().find(|t| t.metric == k).cloned();
    let energy = get("energy").unwrap();
    assert_close!(energy.value, 1900.0);
    assert_close!(energy.min.unwrap(), 1805.0, "about: 5 % under");
    assert_close!(energy.max.unwrap(), 1995.0, "about: 5 % over");
    let sodium = get("sodium").unwrap();
    assert_eq!((sodium.min, sodium.max), (None, Some(2000.0)), "at most");
    assert_close!(get("iron").unwrap().value, 11.0);
    assert_close!(get("saturated").unwrap().value, 20.0);
    assert!(get("zinc").is_none(), "a row without a number is dropped");
    let columns: Vec<String> = conn
        .prepare("SELECT name FROM pragma_table_info('target')")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert_eq!(columns, ["profile_id", "metric", "value"], "renamed by 29");
}

#[test]
fn deleted_profile_ids_are_never_reused() {
    // A browser remembering a deleted profile must not land in someone
    // else's diary.
    let mut conn = memory();
    let named = |name: &str| ProfileInput {
        name: name.into(),
        ..ProfileInput::default()
    };
    let guest = profile_insert(&mut conn, &named("Guest"), &[]).unwrap().id;
    profile_delete(&mut conn, guest).unwrap();
    let next = profile_insert(&mut conn, &named("Next"), &[]).unwrap().id;
    assert_ne!(next, guest);
}

#[test]
fn migration_4_remaps_cached_off_foods_and_their_recipes() {
    let mut conn = Connection::open_in_memory().unwrap();
    for sql in &MIGRATIONS[..3] {
        conn.execute_batch(sql).unwrap();
    }
    conn.pragma_update(None, "user_version", 3).unwrap();
    conn.execute_batch(
        r#"INSERT INTO food (id, name, source, per100) VALUES
             (1, 'Oat drink', 'off', '{"carbs":6.7,"fiber":0.8,"net_carbs":5.9}'),
             (2, 'Own bread', 'custom', '{"carbs":40,"fiber":5,"net_carbs":35}'),
             (3, 'Porridge', 'recipe', '{}');
           INSERT INTO recipe_item VALUES (3, 1, 100);"#,
    )
    .unwrap();
    migrate(&mut conn).unwrap();
    let oat = food_get(&conn, 1).unwrap().unwrap().per100;
    assert_eq!(oat.get("net_carbs"), Some(6.7));
    assert_close!(oat.get("carbs").unwrap(), 7.5);
    let own = food_get(&conn, 2).unwrap().unwrap().per100;
    assert_eq!(own.get("net_carbs"), Some(35.0), "custom foods untouched");
    let porridge = food_get(&conn, 3).unwrap().unwrap().per100;
    assert_eq!(porridge.get("net_carbs"), Some(6.7), "recipe recomputed");
}

#[test]
fn upgrade_from_v1_keeps_everything() {
    // A file from the first schema, with one row of every kind.
    let dir = std::env::temp_dir().join(format!("kaloriina-up-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("v1.db");
    {
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(MIGRATIONS[0]).unwrap();
        conn.pragma_update(None, "user_version", 1).unwrap();
        conn.execute_batch(
            r#"INSERT INTO food (id, name, brand, barcode, source, per100, cooked_g, archived) VALUES
                 (1, 'Oats', 'Mill', '4000000000017', 'custom', '{"energy":380.0,"protein":13.0}', NULL, 1),
                 (2, 'Porridge', NULL, NULL, 'recipe', '{}', 300, 0);
               INSERT INTO serving (food_id, label, grams) VALUES (1, 'cup', 80);
               INSERT INTO recipe_item (recipe_id, food_id, grams) VALUES (2, 1, 60);
               INSERT INTO meal (id, name) VALUES (1, 'Breakfast');
               INSERT INTO meal_item (meal_id, food_id, grams) VALUES (1, 1, 50);
               INSERT INTO entry (day, grp, food_id, name, grams, amount, nutrients) VALUES
                 ('2026-01-02', 'Eaten', 1, 'Oats', 50, '50 g', '{"energy":190.0}');
               INSERT INTO entry (day, grp, name, amount, imported) VALUES
                 ('2026-01-02', 'Remaining', 'Soup', '1 bowl', 1);
               INSERT INTO day_total VALUES ('2026-01-02', 'Remaining', '{"energy":300.0}');
               INSERT INTO target VALUES ('energy', 2000, 2000);"#,
        )
        .unwrap();
    }
    let conn = open(&path).unwrap();
    register_functions(&conn).unwrap();

    let oats = food_get(&conn, 1).unwrap().unwrap();
    assert_eq!(oats.brand.as_deref(), Some("Mill"));
    assert_eq!(oats.barcode.as_deref(), Some("4000000000017"));
    assert!(oats.archived);
    assert_eq!(oats.servings.len(), 1);
    let recipe = recipe_get(&conn, 2).unwrap().unwrap();
    assert_eq!(recipe.food.cooked_g, Some(300.0));
    assert_eq!(recipe.items.len(), 1);
    assert_close!(recipe.food.per100.get("energy").unwrap(), 76.0);
    assert_eq!(meal_get(&conn, 1).unwrap().unwrap().items.len(), 1);
    let day = entry_list_for_day(&conn, ME, "2026-01-02").unwrap();
    assert_eq!(day.len(), 2);
    assert!(
        day.iter().any(|e| e.group == "Planned" && e.imported()),
        "Remaining became Planned"
    );
    assert_eq!(day.iter().find(|e| !e.imported()).unwrap().food_id, Some(1));
    let totals = group_totals(&conn, ME, "2026-01-02", "2026-01-02").unwrap();
    assert_close!(
        totals[&("2026-01-02".to_owned(), "Planned".to_owned())]
            .get("energy")
            .unwrap(),
        300.0
    );
    assert_close!(target_list(&conn, ME).unwrap()[0].value, 2000.0);
    let dangling: i64 = conn
        .query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(dangling, 0);
    let fineli: Option<i64> = conn
        .query_row("SELECT fineli_id FROM food WHERE id = 1", [], |r| r.get(0))
        .unwrap();
    assert_eq!(fineli, None);
    drop(conn);
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn archiving_a_fineli_food_survives_reimport() {
    let mut conn = memory();
    let food = |archived| FoodInput {
        name: "Maito".into(),
        archived,
        ..FoodInput::default()
    };
    food_upsert_fineli(
        &mut conn,
        &[(7, food(false)), (8, food(false))],
        &crate::fineli::serving_labels(),
        &[],
    )
    .unwrap();
    let id_of = |conn: &Connection, fid: i64| -> i64 {
        conn.query_row("SELECT id FROM food WHERE fineli_id = ?", [fid], |r| {
            r.get(0)
        })
        .unwrap()
    };
    let mine = id_of(&conn, 7);
    let archived = FoodInput {
        archived: true,
        rev: Some(rev(&conn, "food", mine)),
        ..food(false)
    };
    food_update(&mut conn, mine, &archived).unwrap();
    // A newer release still lists both, unarchived; one is withdrawn now.
    food_upsert_fineli(
        &mut conn,
        &[(7, food(false)), (8, food(true))],
        &crate::fineli::serving_labels(),
        &[],
    )
    .unwrap();
    assert!(
        food_get(&conn, mine).unwrap().unwrap().archived,
        "your archiving sticks"
    );
    assert!(
        food_get(&conn, id_of(&conn, 8)).unwrap().unwrap().archived,
        "Fineli's too"
    );
}

#[test]
fn upgrading_a_file_keeps_a_snapshot_of_the_old_version() {
    let dir = std::env::temp_dir().join(format!("kaloriina-snap-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("k.db");
    {
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(MIGRATIONS[0]).unwrap();
        conn.pragma_update(None, "user_version", 1).unwrap();
        conn.execute(
            "INSERT INTO food (name, source, per100) VALUES ('Oats', 'custom', '{}')",
            [],
        )
        .unwrap();
    }
    // Another process upgrading the same file at once has its own copy.
    let theirs = dir.join("k.db.pre-v1.partial");
    std::fs::write(&theirs, "theirs").unwrap();
    drop(open(&path).unwrap());
    let snapshot = dir.join("k.db.pre-v1");
    let old = Connection::open(&snapshot).expect("snapshot written");
    let version: u32 = old
        .pragma_query_value(None, "user_version", |r| r.get(0))
        .unwrap();
    assert_eq!(version, 1, "the snapshot is the database before migrating");
    let foods: i64 = old
        .query_row("SELECT count(*) FROM food", [], |r| r.get(0))
        .unwrap();
    assert_eq!(foods, 1);
    drop(old);
    assert_eq!(std::fs::read_to_string(&theirs).unwrap(), "theirs");
    std::fs::remove_file(&theirs).unwrap();
    // Up to date: opening again writes nothing new.
    drop(open(&path).unwrap());
    let snapshots = std::fs::read_dir(&dir)
        .unwrap()
        .filter(|e| {
            e.as_ref()
                .unwrap()
                .file_name()
                .to_string_lossy()
                .contains(".pre-v")
        })
        .count();
    assert_eq!(snapshots, 1);
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn migration_5_renames_remaining_to_planned() {
    let mut conn = Connection::open_in_memory().unwrap();
    for sql in &MIGRATIONS[..4] {
        conn.execute_batch(sql).unwrap();
    }
    conn.pragma_update(None, "user_version", 4).unwrap();
    conn.execute_batch(
        "INSERT INTO entry (profile_id, day, grp, name, amount)
             VALUES (1, '2026-01-01', 'Remaining', 'A', '1 g'), (1, '2026-01-01', 'Other', 'B', '1 g');
         INSERT INTO day_total VALUES (1, '2026-01-01', 'Remaining', '{}');",
    )
    .unwrap();
    migrate(&mut conn).unwrap();
    let groups: Vec<String> = conn
        .prepare("SELECT grp FROM entry UNION ALL SELECT grp FROM day_total ORDER BY 1")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert_eq!(groups, ["Other", "Planned", "Planned"]);
}

/// A Planned row timed before Planned lost its time reads untimed, and
/// moved back to Eaten stays so.
#[test]
fn a_stale_planned_time_never_shows() {
    let mut conn = memory();
    conn.execute(
        "INSERT INTO entry (profile_id, day, grp, name, amount, time)
             VALUES (?, '2026-01-01', 'Planned', 'A', '1 g', '08:15')",
        [ME],
    )
    .unwrap();
    let id = conn.last_insert_rowid();
    assert_eq!(entry_get(&conn, ME, id).unwrap().unwrap().time, None);
    let patch = crate::model::EntryPatch {
        group: Some("Eaten".into()),
        ..crate::model::EntryPatch::default()
    };
    assert_eq!(entry_update(&mut conn, ME, id, &patch).unwrap().time, None);
}

#[test]
fn newer_schema_is_refused() {
    let mut conn = memory();
    conn.pragma_update(None, "user_version", 99).unwrap();
    let err = migrate(&mut conn).unwrap_err();
    assert!(err.to_string().contains("newer than this binary"), "{err}");
}

#[test]
fn recipe_per100_uses_cooked_weight() {
    let parts = [
        (nut(&[("protein", 10.0)]), 200.0),
        (nut(&[("protein", 0.0)]), 200.0),
    ];
    assert_eq!(recipe_per100(&parts, None), nut(&[("protein", 5.0)]));
    assert_eq!(
        recipe_per100(&parts, Some(200.0)),
        nut(&[("protein", 10.0)])
    );
    assert_eq!(recipe_per100(&[], None), Nutrients::default());
    // The weight cooking takes or gives is water.
    let soup = [
        (nut(&[("water", 100.0)]), 900.0),
        (nut(&[("water", 0.0), ("protein", 25.0)]), 100.0),
    ];
    let water = |cooked| recipe_per100(&soup, Some(cooked)).get("water");
    assert_eq!(water(800.0), Some(87.5), "700 g of water in 800 g");
    assert_eq!(water(1000.0), Some(90.0));
    assert_eq!(water(50.0), Some(0.0), "never below none");
    assert_eq!(recipe_per100(&parts, Some(100.0)).get("water"), None);
}

#[test]
fn recipe_follows_ingredient_edits_transitively() {
    let mut conn = memory();
    let oats = food(&mut conn, "Oats", &[("energy", 400.0)]);
    let inner = recipe_save(&mut conn, None, &recipe("Porridge", &[(oats, 100.0)]))
        .unwrap()
        .food
        .id;
    let outer = recipe_save(&mut conn, None, &recipe("Bowl", &[(inner, 50.0)]))
        .unwrap()
        .food
        .id;
    assert_eq!(
        food_get(&conn, outer).unwrap().unwrap().per100,
        nut(&[("energy", 400.0)])
    );

    let input = FoodInput {
        name: "Oats".into(),
        per100: nut(&[("energy", 200.0)]),
        rev: Some(rev(&conn, "food", oats)),
        ..FoodInput::default()
    };
    food_update(&mut conn, oats, &input).unwrap();
    assert_eq!(
        food_get(&conn, inner).unwrap().unwrap().per100,
        nut(&[("energy", 200.0)])
    );
    assert_eq!(
        food_get(&conn, outer).unwrap().unwrap().per100,
        nut(&[("energy", 200.0)])
    );
}

#[test]
fn recipe_cycle_rejected() {
    let mut conn = memory();
    let oats = food(&mut conn, "Oats", &[]);
    let a = recipe_save(&mut conn, None, &recipe("A", &[(oats, 1.0)]))
        .unwrap()
        .food
        .id;
    let b = recipe_save(&mut conn, None, &recipe("B", &[(a, 1.0)]))
        .unwrap()
        .food
        .id;
    let at = Some(rev(&conn, "food", a));
    let again = |items: &[(i64, f64)]| RecipeInput {
        rev: at,
        ..recipe("A", items)
    };
    assert!(matches!(
        recipe_save(&mut conn, Some(a), &again(&[(b, 1.0)])),
        Err(Error::Invalid { .. })
    ));
    assert!(matches!(
        recipe_save(&mut conn, Some(a), &again(&[(a, 1.0)])),
        Err(Error::Invalid { .. })
    ));
    // Rejected save rolled back: A still holds oats.
    assert_eq!(
        recipe_get(&conn, a).unwrap().unwrap().items[0].food_id,
        oats
    );
}

/// An entry's stored values, and its stored energy as SQL reads it.
fn stored(conn: &Connection, id: i64) -> (Option<Nutrients>, Option<f64>) {
    (
        entry_get(conn, ME, id).unwrap().unwrap().nutrients,
        conn.query_row(
            "SELECT json_extract(nutrients, '$.energy') FROM entry WHERE id = ?",
            [id],
            |r| r.get(0),
        )
        .unwrap(),
    )
}

#[test]
fn entries_follow_their_food_and_rescale() {
    let mut conn = memory();
    let id = food(&mut conn, "Milk", &[("energy", 50.0), ("protein", 3.0)]);
    let milk = food_get(&conn, id).unwrap().unwrap();
    let planned = log(&mut conn, ME, "2026-10-06", "Planned", &milk, 200.0)
        .id
        .unwrap();
    let eaten = log(&mut conn, ME, "2025-01-01", "Eaten", &milk, 100.0)
        .id
        .unwrap();
    // Imported history: its values are the import's, whatever it names.
    conn.execute(
        "INSERT INTO entry (profile_id, day, grp, src_grp, food_id, name, grams, amount, nutrients)
         VALUES (1, '2025-01-01', 'Eaten', 'Eaten', ?, 'Milk', 100, '100 g', '{\"energy\":7.0}')",
        [id],
    )
    .unwrap();
    let imported = conn.last_insert_rowid();

    let input = FoodInput {
        name: "Milk".into(),
        per100: nut(&[("energy", 60.0), ("protein", 5.0)]),
        rev: Some(rev(&conn, "food", id)),
        ..FoodInput::default()
    };
    let saved = food_update(&mut conn, id, &input).unwrap();
    assert_eq!(saved.entries_updated, Some(2));
    assert_eq!(
        stored(&conn, planned),
        (
            Some(nut(&[("energy", 120.0), ("protein", 10.0)])),
            Some(120.0)
        )
    );
    assert_eq!(
        stored(&conn, eaten),
        (Some(nut(&[("energy", 60.0), ("protein", 5.0)])), Some(60.0))
    );
    assert_eq!(stored(&conn, imported).1, Some(7.0), "imported untouched");

    // Saved again unchanged, nothing is rewritten.
    let again = FoodInput {
        rev: Some(rev(&conn, "food", id)),
        ..input
    };
    assert_eq!(
        food_update(&mut conn, id, &again).unwrap().entries_updated,
        Some(0)
    );

    let patch = crate::model::EntryPatch {
        group: Some("Eaten".into()),
        amount: crate::model::Amount {
            grams: Some(100.0),
            ..crate::model::Amount::default()
        },
        ..crate::model::EntryPatch::default()
    };
    entry_update(&mut conn, ME, planned, &patch).unwrap();
    let got = entry_get(&conn, ME, planned).unwrap().unwrap();
    assert_eq!(got.group, "Eaten");
    assert_eq!(
        got.nutrients,
        Some(nut(&[("energy", 60.0), ("protein", 5.0)]))
    );
}

#[test]
fn entries_of_recipes_follow_their_ingredients() {
    let mut conn = memory();
    let oats = food(&mut conn, "Oats", &[("energy", 400.0)]);
    let inner = recipe_save(&mut conn, None, &recipe("Porridge", &[(oats, 100.0)]))
        .unwrap()
        .food;
    assert_eq!(
        inner.entries_updated, None,
        "a new recipe's answer is plain"
    );
    let inner = inner.id;
    let outer = recipe_save(&mut conn, None, &recipe("Bowl", &[(inner, 50.0)]))
        .unwrap()
        .food
        .id;
    let bowl = food_get(&conn, outer).unwrap().unwrap();
    let e = log(&mut conn, ME, "2025-01-01", "Eaten", &bowl, 50.0)
        .id
        .unwrap();
    assert_eq!(stored(&conn, e).1, Some(200.0));

    let input = FoodInput {
        name: "Oats".into(),
        per100: nut(&[("energy", 200.0)]),
        rev: Some(rev(&conn, "food", oats)),
        ..FoodInput::default()
    };
    assert_eq!(
        food_update(&mut conn, oats, &input)
            .unwrap()
            .entries_updated,
        Some(1)
    );
    assert_eq!(stored(&conn, e).1, Some(100.0));

    // A recipe's own save: half the oats.
    let at = Some(rev(&conn, "food", inner));
    let saved = recipe_save(
        &mut conn,
        Some(inner),
        &RecipeInput {
            rev: at,
            ..recipe("Porridge", &[(oats, 50.0)])
        },
    )
    .unwrap();
    assert_eq!(saved.food.entries_updated, Some(0), "same per 100 g");
    let at = Some(rev(&conn, "food", inner));
    let water = food(&mut conn, "Water", &[("energy", 0.0)]);
    let saved = recipe_save(
        &mut conn,
        Some(inner),
        &RecipeInput {
            rev: at,
            ..recipe("Porridge", &[(oats, 50.0), (water, 50.0)])
        },
    )
    .unwrap();
    assert_eq!(saved.food.entries_updated, Some(1));
    assert_eq!(stored(&conn, e).1, Some(50.0));
}

#[test]
fn merged_entries_take_their_new_foods_values() {
    let mut conn = memory();
    let a = food(&mut conn, "Oats", &[("energy", 100.0)]);
    let b = food(&mut conn, "Oats (dup)", &[("energy", 200.0)]);
    let dup = food_get(&conn, b).unwrap().unwrap();
    let e = log(&mut conn, ME, "2025-01-01", "Eaten", &dup, 100.0)
        .id
        .unwrap();
    let at = Some(rev(&conn, "food", a));
    let merged = food_merge(&mut conn, a, &MergeInput { from: b, rev: at }).unwrap();
    assert_eq!(merged.entries_updated, Some(1));
    assert_eq!(stored(&conn, e).1, Some(100.0));
}

#[test]
fn group_totals_merge_entries_and_imported() {
    let mut conn = memory();
    let id = food(&mut conn, "Milk", &[("protein", 3.0)]);
    let milk = food_get(&conn, id).unwrap().unwrap();
    log(&mut conn, ME, "2026-10-06", "Eaten", &milk, 100.0);
    day_totals_replace(
        &conn,
        ME,
        &["2026-10-06".into()],
        &[DayTotal {
            day: "2026-10-06".into(),
            group: "Eaten".into(),
            nutrients: nut(&[("protein", 10.0)]),
        }],
    )
    .unwrap();
    let totals = group_totals(&conn, ME, "2026-10-01", "2026-10-31").unwrap();
    assert_eq!(
        totals[&("2026-10-06".into(), "Eaten".into())],
        nut(&[("protein", 13.0)])
    );
}

#[test]
fn base_exercise_names_only_grow() {
    let shipped: Vec<BaseExercise> = serde_json::from_str(BASE_EXERCISES).unwrap();
    let names: Vec<&str> = shipped.iter().map(|e| e.name.as_str()).collect();
    for released in include_str!("base-exercise-names.txt")
        .lines()
        .filter(|l| !l.starts_with('#') && !l.is_empty())
    {
        assert!(
            names.contains(&released),
            "{released} left exercises.json; rename or remove it with a migration"
        );
    }
}

#[test]
fn deleted_exercise_ids_are_never_reused() {
    // Activity sets name their exercise by id after it's gone: a new
    // exercise must never take that id and inherit someone else's history.
    let mut conn = memory();
    let input = |name: &str| ExerciseInput {
        name: name.into(),
        measure: Measure::Reps,
        variant_of: None,
        traits: ExerciseTraits::default(),
        rev: None,
        uid: None,
    };
    let gone = exercise_save(&mut conn, None, &input("Towel row"))
        .unwrap()
        .id;
    exercise_delete(&mut conn, gone).unwrap();
    let next = exercise_save(&mut conn, None, &input("Towel curl"))
        .unwrap()
        .id;
    assert!(next > gone, "{next} after {gone}");
}

/// An in-memory database as release `version` left it (foreign keys off,
/// as `migrate` runs).
fn at_version(version: u32) -> Connection {
    let mut conn = Connection::open_in_memory().unwrap();
    conn.pragma_update(None, "foreign_keys", "OFF").unwrap();
    let tx = conn.transaction().unwrap();
    migrate_to(&tx, 0, version as usize).unwrap();
    tx.commit().unwrap();
    conn
}

/// `conn` with `fixture` added, migrated to the current schema and opened
/// as the app opens it.
fn upgraded(mut conn: Connection, fixture: &str) -> Connection {
    conn.execute_batch(fixture).unwrap();
    migrate(&mut conn).unwrap();
    conn.pragma_update(None, "foreign_keys", "ON").unwrap();
    register_functions(&conn).unwrap();
    derived_current(&mut conn, None, 0);
    conn
}

#[test]
fn an_upgrade_brings_entries_to_their_foods_values() {
    // Logged before entries followed their food, then the food was edited:
    // the entry kept 380 kcal per 100 g, the food says 400.
    let conn = upgraded(
        at_version(63),
        r#"INSERT INTO food (id, name, source, per100) VALUES (990, 'Oats', 'custom', '{"energy":400.0}');
           INSERT INTO entry (id, profile_id, day, grp, food_id, name, grams, amount, nutrients)
               VALUES (990, 1, '2025-01-01', 'Eaten', 990, 'Oats', 50, '50 g', '{"energy":190.0}');"#,
    );
    assert_eq!(stored(&conn, 990).1, Some(200.0));
}

#[test]
fn upgrade_from_v13_keeps_the_diary() {
    // Before workouts: a food, an imported entry remembering its group, a
    // profile with a weight.
    let conn = upgraded(
        at_version(13),
        r#"INSERT INTO food (id, name, source, per100) VALUES (1, 'Oats', 'custom', '{"energy":380.0}');
           INSERT INTO entry (id, profile_id, day, grp, food_id, name, grams, amount, nutrients, imported, uid, src_grp)
             VALUES (1, 1, '2026-01-02', 'Breakfast', 1, 'Oats', 50, '50 g', '{"energy":190.0}', 1, 'entry-0001', 'Breakfast');
           UPDATE profile SET weight_kg = 80 WHERE id = 1;"#,
    );
    let entry = entry_get(&conn, ME, 1).unwrap().unwrap();
    assert_eq!(
        (entry.group.as_str(), entry.uid.as_str(), entry.imported()),
        ("Breakfast", "entry-0001", true)
    );
    assert_eq!(food_get(&conn, 1).unwrap().unwrap().rev, 1);
    assert_close!(weight_list(&conn, ME, None, None).unwrap()[0].kg, 80.0);
    assert!(workout_list(&conn).unwrap().is_empty());
}

#[test]
fn upgrade_from_v14_drops_inline_workouts_and_seeds_exercises() {
    // Workouts that named their moves inline go (migration 15).
    let conn = upgraded(
        at_version(14),
        r#"INSERT INTO workout (id, name, steps) VALUES (1, 'Old', '[{"kind":"move","name":"Squat","reps":5}]');"#,
    );
    assert!(workout_list(&conn).unwrap().is_empty());
    let names: Vec<String> = exercise_list(&conn)
        .unwrap()
        .into_iter()
        .map(|e| e.name)
        .collect();
    assert!(names.iter().any(|n| n == "Pull-up"), "{names:?}");
}

#[test]
fn upgrade_from_v15_keeps_your_exercises() {
    // Before traits: an exercise of your own.
    let conn = upgraded(
        at_version(15),
        "INSERT INTO exercise (id, name, kind, source) VALUES (1000, 'Towel hang', 'time', 'custom');",
    );
    let towel = exercise_get(&conn, 1000).unwrap().unwrap();
    assert_eq!(
        (
            towel.name.as_str(),
            towel.measure,
            towel.source,
            towel.variant_of
        ),
        ("Towel hang", Measure::Time, ExerciseSource::Custom, None)
    );
    assert_eq!(towel.rev, 1);
}

#[test]
fn upgrade_from_v16_drops_stored_workout_energy() {
    // Energy was stored per workout; migration 17 drops it (estimated per
    // profile since). The time stays.
    let conn = upgraded(
        at_version(16),
        r#"INSERT INTO exercise (id, name, kind, source, traits) VALUES (1000, 'Towel pull-up', 'reps', 'custom', '{}');
           INSERT INTO workout (id, name, steps, minutes, kcal) VALUES (1, 'Pulls',
             '[{"kind":"exercise","exercise_id":1000,"reps":5}]', 20, 150);"#,
    );
    let pulls = workout_get(&conn, 1).unwrap().unwrap();
    assert_eq!((pulls.minutes, pulls.kcal), (Some(20), None));
    assert_eq!(exercise_get(&conn, 1000).unwrap().unwrap().variant_of, None);
}

#[test]
fn upgrade_from_v17_keeps_workouts() {
    let conn = upgraded(
        at_version(17),
        r#"INSERT INTO exercise (id, name, kind, source, traits) VALUES (1000, 'Towel pull-up', 'reps', 'custom', '{}');
           INSERT INTO exercise (id, name, kind, source, traits, variant_of)
             VALUES (1001, 'Towel chin-up', 'reps', 'custom', '{}', 1000);
           INSERT INTO workout (id, name, steps, minutes) VALUES (1, 'Pulls',
             '[{"kind":"exercise","exercise_id":1001,"reps":5}]', 20);"#,
    );
    let pulls = workout_get(&conn, 1).unwrap().unwrap();
    assert_eq!(
        (pulls.minutes, pulls.kcal, pulls.steps.len()),
        (Some(20), None, 1)
    );
    assert_eq!(
        exercise_get(&conn, 1001).unwrap().unwrap().variant_of,
        Some(1000)
    );
}

#[test]
fn upgrade_from_v18_starts_without_sessions() {
    // Before sessions: a workout with your own energy, a profile.
    let conn = upgraded(
        at_version(18),
        r#"INSERT INTO exercise (id, name, kind, source, traits) VALUES (1000, 'Towel pull-up', 'reps', 'custom', '{}');
           INSERT INTO workout (id, name, steps, minutes, kcal) VALUES (1, 'Pulls',
             '[{"kind":"exercise","exercise_id":1000,"reps":5}]', 20, 150);"#,
    );
    let pulls = workout_get(&conn, 1).unwrap().unwrap();
    assert_eq!((pulls.minutes, pulls.kcal), (Some(20), Some(150)));
    let me = profile_get(&conn, ME).unwrap().unwrap();
    assert_eq!(me.rev, 2, "29 moved the rev on");
    assert!(
        target_list(&conn, ME)
            .unwrap()
            .iter()
            .all(|t| t.metric != "workouts_per_week")
    );
    assert!(
        activity_list(&conn, ME, None, None, None)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn upgrade_from_v19_keeps_workouts_sessions_and_recipes() {
    // A database as release 19 left it: an exercise measured by `kind`, a
    // workout stored with a "loop", a session without a uid, a recipe
    // without its whole serving, a profile with a weight, an entry whose
    // uid was unique across profiles.
    let conn = upgraded(
        at_version(19),
        r#"INSERT INTO exercise (id, name, kind, source, traits) VALUES (1000, 'Towel pull-up', 'reps', 'custom', '{}');
           INSERT INTO workout (id, name, steps, minutes, kcal) VALUES (1, 'Pulls',
             '[{"kind":"loop","name":"main","times":2,"steps":[{"kind":"exercise","exercise_id":1000,"reps":5}]}]', NULL, NULL);
           INSERT INTO workout_session (id, profile_id, day, workout_id, name, minutes, kcal, sets)
             VALUES (1, 1, '2026-10-01', 1, 'Pulls', 12, NULL, '[{"exercise_id":1000,"name":"Towel pull-up","reps":5}]');
           UPDATE profile SET weight_kg = 72.5 WHERE id = 1;
           INSERT INTO food (id, name, source, per100) VALUES (1, 'Oats', 'custom', '{"energy":380.0}');
           INSERT INTO food (id, name, source, per100) VALUES (2, 'Porridge', 'recipe', '{}');
           INSERT INTO recipe_item (recipe_id, food_id, grams) VALUES (2, 1, 60);
           INSERT INTO serving (food_id, label, grams) VALUES (2, 'Bowl', 250);
           INSERT INTO entry (id, profile_id, day, grp, food_id, name, grams, amount, nutrients, uid)
             VALUES (1, 1, '2026-10-01', 'Eaten', 1, 'Oats', 50, '50 g', '{"energy":190.0}', 'entry-0001');"#,
    );

    let pulls = workout_get(&conn, 1).unwrap().unwrap();
    assert!(matches!(&pulls.steps[0], Step::Repeat { times: 2, .. }));
    assert_eq!(pulls.rev, 1);
    assert_eq!(
        exercise_get(&conn, 1000).unwrap().unwrap().measure,
        Measure::Reps
    );
    let session = activity_get(&conn, ME, 1).unwrap().unwrap();
    assert_eq!(session.uid.len(), 32);
    assert_eq!(session.sets[0].reps, Some(5));
    assert_close!(weight_list(&conn, ME, None, None).unwrap()[0].kg, 72.5);
    let porridge = recipe_get(&conn, 2).unwrap().unwrap().food;
    let servings: Vec<(&str, f64)> = porridge
        .servings
        .iter()
        .map(|s| (s.label.as_str(), s.grams))
        .collect();
    assert_eq!(servings, [(WHOLE_RECIPE, 60.0), ("Bowl", 250.0)]);
    // The uid index went from global to per profile; the entry kept its uid.
    let oats = entry_get(&conn, ME, 1).unwrap().unwrap();
    assert_eq!((oats.uid.as_str(), oats.grams), ("entry-0001", Some(50.0)));
    let index: String = conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE name = 'entry_uid' AND type = 'index'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(index.contains("(profile_id, uid)"), "{index}");
}

#[test]
fn upgrade_from_v20_rebuilds_food_and_adds_day_tables() {
    // A database as release 20 left it: foods with a barcode, a Fineli id
    // and a moved-on rev, a recipe, a meal, a favourite, a logged and an
    // imported entry. Food 9 is the newest and used by nothing.
    let mut conn = upgraded(
        at_version(20),
        r#"INSERT INTO food (id, name, source, per100, barcode, rev) VALUES (1, 'Oats', 'custom', '{"energy":380.0}', '6410000000001', 3);
           INSERT INTO food (id, name, source, per100) VALUES (2, 'Porridge', 'recipe', '{}');
           INSERT INTO recipe_item (recipe_id, food_id, grams) VALUES (2, 1, 60);
           INSERT INTO serving (food_id, label, grams) VALUES (2, 'Whole recipe', 60), (2, 'Bowl', 250);
           INSERT INTO food (id, name, brand, source, per100, fineli_id) VALUES (3, 'Ruisleipä', 'Fineli', 'fineli', '{}', 123);
           INSERT INTO food (id, name, source, per100) VALUES (9, 'Spare', 'custom', '{}');
           INSERT INTO meal (id, name) VALUES (1, 'Breakfast');
           INSERT INTO meal_item (meal_id, food_id, grams) VALUES (1, 3, 40);
           INSERT INTO favorite (profile_id, food_id) VALUES (1, 2);
           INSERT INTO entry (id, profile_id, day, grp, food_id, name, grams, amount, nutrients, uid)
             VALUES (1, 1, '2026-10-01', 'Eaten', 1, 'Oats', 50, '50 g', '{"energy":190.0}', 'entry-0001');
           INSERT INTO entry (id, profile_id, day, grp, name, amount, imported, uid, src_grp)
             VALUES (2, 1, '2026-10-01', 'Eaten', 'Pizza', '1 slice', 1, 'entry-0002', 'Eaten');"#,
    );

    // Every link resolves; ids, revs and servings are kept.
    let oats = food_get(&conn, 1).unwrap().unwrap();
    assert_eq!(
        (oats.name.as_str(), oats.barcode.as_deref(), oats.rev),
        ("Oats", Some("6410000000001"), 3)
    );
    let porridge = recipe_get(&conn, 2).unwrap().unwrap();
    assert_eq!(porridge.items[0].name, "Oats");
    assert_eq!(porridge.food.servings.len(), 2);
    assert_eq!(
        meal_get(&conn, 1).unwrap().unwrap().items[0].name,
        "Ruisleipä"
    );
    assert_eq!(favorite_list(&conn, ME).unwrap()[0].id, 2);
    assert_eq!(entry_get(&conn, ME, 1).unwrap().unwrap().food_id, Some(1));
    let dangling: i64 = conn
        .query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(dangling, 0);

    // The uniques survive the rebuild.
    for dup in [
        "INSERT INTO food (name, source, barcode) VALUES ('Copy', 'custom', '6410000000001')",
        "INSERT INTO food (name, source, fineli_id) VALUES ('Copy', 'fineli', 123)",
    ] {
        assert!(conn.execute(dup, []).is_err(), "{dup}");
    }

    // Existing entries, imported ones included, stay as they were (31
    // turned no quick add into a food: there was none).
    let entries: i64 = conn
        .query_row("SELECT count(*) FROM entry", [], |r| r.get(0))
        .unwrap();
    assert_eq!(entries, 2);

    // AUTOINCREMENT: the newest food's id isn't handed out again (10 and 11 are
    // the Water 25 seeds, there being no Fineli water, and 36's creatine).
    let seq: i64 = conn
        .query_row(
            "SELECT seq FROM sqlite_sequence WHERE name = 'food'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(seq, 11);
    conn.execute("DELETE FROM food WHERE id = 11", []).unwrap();
    assert_eq!(food(&mut conn, "Rye", &[]), 12);

    // The new tables are there and empty.
    for table in ["planned_workout", "day_note", "measurement"] {
        let rows: i64 = conn
            .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 0, "{table}");
    }
}

#[test]
fn upgrade_from_v21_adds_habits() {
    // A database as release 21 left it: a second profile with a note and a
    // measurement.
    let mut conn = upgraded(
        at_version(21),
        "INSERT INTO profile (id, name) VALUES (2, 'Anna');
         INSERT INTO day_note (profile_id, day, text) VALUES (2, '2026-10-01', 'Travel');
         INSERT INTO measurement (profile_id, day, kind, value) VALUES (2, '2026-10-01', 'waist', 80);",
    );
    let anna = ProfileId(2);
    assert_eq!(
        note_list(&conn, anna, None, None).unwrap()[0].text,
        "Travel"
    );
    assert!(habit_list(&conn, anna).unwrap().is_empty());

    let input = |name: &str| CheckedHabit {
        name: name.into(),
        unit: "pouches".into(),
        goal_value: None,
        goal_dir: GoalDir::AtMost,
        archived: false,
        rev: None,
        uid: None,
    };
    let snus = habit_save(&mut conn, anna, None, &input("Snus")).unwrap();
    habit_day_set(&conn, anna, snus.id, "2026-10-01", 4.0).unwrap();
    // Names are unique per profile ignoring case; a day's total is positive.
    assert!(matches!(
        habit_save(&mut conn, anna, None, &input("SNUS")),
        Err(Error::Conflict { .. })
    ));
    assert!(habit_save(&mut conn, ME, None, &input("Snus")).is_ok());
    assert!(
        conn.execute(
            "INSERT INTO habit_day (habit_id, day, amount) VALUES (?, '2026-10-02', 0)",
            [snus.id],
        )
        .is_err()
    );

    // Ids are never reused (AUTOINCREMENT), and a profile takes its
    // trackers and their days with it.
    habit_delete(&conn, anna, snus.id).unwrap();
    let next = habit_save(&mut conn, anna, None, &input("Snus")).unwrap();
    assert!(next.id > snus.id + 1, "{} after {}", next.id, snus.id);
    habit_day_set(&conn, anna, next.id, "2026-10-01", 1.0).unwrap();
    profile_delete(&mut conn, anna).unwrap();
    let left: i64 = conn
        .query_row(
            "SELECT (SELECT count(*) FROM habit WHERE profile_id = 2)
                 + (SELECT count(*) FROM habit_day)",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(left, 0);
}

#[test]
fn upgrade_from_v22_keeps_weights_manual() {
    // A database as release 22 left it: a logged weight.
    let mut conn = upgraded(
        at_version(22),
        "INSERT INTO weight (profile_id, day, kg) VALUES (1, '2026-10-01', 80);",
    );
    let (source, set_at): (WeightSource, Option<i64>) = conn
        .query_row(
            "SELECT source, set_at FROM weight WHERE profile_id = 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!((source, set_at), (WeightSource::Hand, None));
    assert_eq!(sync_status(&conn, ME).unwrap().bound_user, None);

    // A weight typed before set times were kept stays, even under a reading.
    conn.execute(
        "INSERT INTO scale_reading (profile_id, source, source_user, taken_at, day, weight)
         VALUES (1, 'openscale', 1, 1790838000000, '2026-10-01', 81)",
        [],
    )
    .unwrap();
    day_weight_refresh(&conn, ME, "2026-10-01", 2, &TimeZone::UTC).unwrap();
    assert_close!(weight_list(&conn, ME, None, None).unwrap()[0].kg, 80.0);
    // Deleting it lets the reading set the day.
    weight_delete(&mut conn, ME, "2026-10-01", 3, &TimeZone::UTC).unwrap();
    assert_eq!(
        weight_source(&conn, ME, "2026-10-01").unwrap(),
        Some(WeightSource::OpenScale)
    );
}

#[test]
fn upgrade_from_v23_adds_activity() {
    // A database as release 23 left it: a second profile, connected to
    // openScale.
    let mut conn = upgraded(
        at_version(23),
        "INSERT INTO profile (id, name) VALUES (2, 'Anna');
         INSERT INTO sync_state (profile_id, source, bound_user) VALUES (2, 'openscale', 1);",
    );
    let anna = ProfileId(2);
    let empty = device_day_list(&conn, anna, None, None).unwrap();
    assert!(empty.days.is_empty() && empty.sessions.is_empty());
    assert_eq!(health_status(&conn, anna).unwrap().last_seen, None);

    let post = crate::model::HealthPost {
        from: "2026-10-01".into(),
        to: "2026-10-07".into(),
        device: Some("Pixel 9".into()),
        days: vec![crate::model::DeviceDay {
            day: "2026-10-02".into(),
            active_kcal: Some(512),
            steps: Some(9120),
            ..Default::default()
        }],
        sessions: vec![crate::model::DeviceSession {
            key: "hc-1".into(),
            day: "2026-10-02".into(),
            start_at: "2026-10-02T14:02:00Z".into(),
            end_at: "2026-10-02T14:48:00Z".into(),
            kind: 33,
            name: "Running".into(),
            kcal: Some(410),
            total_kcal: None,
            distance_m: None,
            recording_method: 1,
            avg_hr: None,
            max_hr: None,
        }],
        body: Vec::new(),
        read: BTreeMap::new(),
        skipped: 0,
    };
    device_replace(&mut conn, anna, &post, 1, &TimeZone::UTC).unwrap();
    // Its status sits beside openScale's, which stays bound.
    assert_eq!(health_status(&conn, anna).unwrap().last_seen, Some(1));
    assert_eq!(sync_status(&conn, anna).unwrap().bound_user.unwrap().id, 1);
    device_delete(&mut conn, anna, 0, &TimeZone::UTC).unwrap();
    assert!(sync_status(&conn, anna).unwrap().bound_user.is_some());

    // A profile takes its activity with it.
    device_replace(&mut conn, anna, &post, 2, &TimeZone::UTC).unwrap();
    profile_delete(&mut conn, anna).unwrap();
    let left: i64 = conn
        .query_row(
            "SELECT (SELECT count(*) FROM device_day) + (SELECT count(*) FROM device_session)",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(left, 0);
}

#[test]
fn upgrade_from_v24_adds_water_instructions_and_goal() {
    // A database as release 24 left it, without Fineli: a recipe and a
    // profile, both without the new columns' values.
    let conn = upgraded(
        at_version(24),
        r#"INSERT INTO food (id, name, source, per100) VALUES (1, 'Oats', 'custom', '{"energy":380.0}');
           INSERT INTO food (id, name, source, per100) VALUES (2, 'Porridge', 'recipe', '{}');
           INSERT INTO recipe_item (recipe_id, food_id, grams) VALUES (2, 1, 60);"#,
    );
    assert_eq!(recipe_get(&conn, 2).unwrap().unwrap().food.notes, None);
    assert!(
        target_list(&conn, ME)
            .unwrap()
            .iter()
            .all(|t| t.metric != "goal_weight")
    );
    assert_eq!(water_food_choice(&conn, ME).unwrap(), None);
    // No Fineli water: a plain Water of your own is seeded, and is the default.
    let water = water_food_get(&conn, ME).unwrap().unwrap();
    assert_eq!(
        (water.name.as_str(), water.source, water.id),
        ("Water", Source::Custom, 3)
    );
    assert_eq!(water.per100.get("water"), Some(100.0));
    assert_eq!(water.per100.get("energy"), Some(0.0));

    // With Fineli's water there already, nothing is seeded: it's the default.
    let conn = upgraded(
        at_version(24),
        r#"INSERT INTO food (id, name, brand, source, per100, fineli_id)
             VALUES (7, 'Vesi, vesijohtovesi', 'Fineli', 'fineli', '{"water":100.0,"energy":0.0}', 11);"#,
    );
    let seeded: i64 = conn
        .query_row(
            "SELECT count(*) FROM food WHERE source = 'custom' AND name = 'Water'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(seeded, 0);
    assert_eq!(water_food_get(&conn, ME).unwrap().unwrap().id, 7);
}

#[test]
fn upgrade_from_v35_seeds_creatine_monohydrate() {
    let named = |conn: &Connection| -> Vec<i64> {
        conn.prepare("SELECT id FROM food WHERE name = 'Creatine monohydrate' COLLATE NOCASE")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    };
    // Only an archived one (merged away): a live one is seeded, with a dose.
    let conn = upgraded(
        at_version(35),
        r"INSERT INTO food (name, source, per100, archived)
            VALUES ('Creatine monohydrate', 'custom', '{}', 1);",
    );
    let ids = named(&conn);
    assert_eq!(ids.len(), 2, "{ids:?}");
    let seed = food_get(&conn, ids[1]).unwrap().unwrap();
    assert_eq!((seed.source, seed.archived), (Source::Custom, false));
    assert_eq!(seed.per100.get("creatine"), Some(100.0));
    assert_eq!(seed.per100.get("energy"), Some(0.0));
    assert_eq!(
        seed.servings,
        [Serving {
            label: "Dose".into(),
            grams: 3.0
        }]
    );
    assert!(
        food_get(&conn, ids[0])
            .unwrap()
            .unwrap()
            .servings
            .is_empty()
    );

    // A live one of your own, in any case: left alone, nothing seeded.
    let conn = upgraded(
        at_version(35),
        r"INSERT INTO food (name, source, per100)
            VALUES ('creatine MONOHYDRATE', 'custom', '{}');",
    );
    let ids = named(&conn);
    assert_eq!(ids.len(), 1, "{ids:?}");
    let own = food_get(&conn, ids[0]).unwrap().unwrap();
    assert_eq!(own.per100.get("creatine"), None);
    assert!(own.servings.is_empty());
}

#[test]
fn upgrade_from_v25_adds_sleep_and_synced_workouts() {
    // A database as release 25 left it: a hand-logged session, a synced day
    // and a device workout, each without the new columns' values.
    let conn = upgraded(
        at_version(25),
        r"INSERT INTO workout_session (id, profile_id, day, name, minutes, sets, uid)
            VALUES (1, 1, '2026-10-02', 'Walk', 30, '[]', 'walk-0001');
          INSERT INTO activity_day (profile_id, day, active_kcal, steps) VALUES (1, '2026-10-02', 512, 9120);
          INSERT INTO activity_session (profile_id, source_key, day, start_at, end_at, type, name, kcal)
            VALUES (1, 'hc-1', '2026-10-02', '2026-10-02T14:02:00Z', '2026-10-02T14:48:00Z', 33, 'Running', 410);",
    );
    let s = activity_get(&conn, ME, 1).unwrap().unwrap();
    assert_eq!(
        (s.kind, s.distance_m, s.start_at, s.source, s.source_key),
        (
            ActivityType::Workout,
            None,
            None,
            ActivitySource::Hand,
            None
        )
    );
    let a = device_day_list(&conn, ME, None, None).unwrap();
    assert_eq!(
        (
            a.days[0].day.steps,
            a.days[0].day.in_bed_min,
            a.days[0].day.hrv_ms
        ),
        (Some(9120), None, None)
    );
    assert_eq!(
        (a.sessions[0].distance_m, a.sessions[0].recording_method),
        (None, 0)
    );
    // Schema only: the device workout waits for the first sync.
    assert_eq!(activity_list(&conn, ME, None, None, None).unwrap().len(), 1);
    assert_eq!(
        health_status(&conn, ME).unwrap().workouts,
        SyncedWorkouts::Auto
    );
    let tombstones: i64 = conn
        .query_row("SELECT count(*) FROM workout_tombstone", [], |r| r.get(0))
        .unwrap();
    assert_eq!(tombstones, 0);
    // The mode is a closed set (the session type is `ActivityType`'s, 41).
    assert!(
        conn.execute("UPDATE profile SET synced_workouts = 'never'", [])
            .is_err()
    );
}
#[test]
fn water_food_prefers_your_pick_then_fineli_then_your_own() {
    let mut conn = memory();
    // A fresh database: the seeded Water.
    let seeded = water_food_get(&conn, ME).unwrap().unwrap().id;
    // Fineli's plain water outranks it; other waters and look-alikes don't
    // count.
    conn.execute_batch(
        r#"INSERT INTO food (id, name, source, per100) VALUES
             (20, 'Vesimeloni', 'fineli', '{"water":91.0}'),
             (21, 'Vesi, kivennäisvesi, hiilihapotettu', 'fineli', '{"water":99.9}'),
             (22, 'Vesi', 'fineli', '{"water":100.0}'),
             (23, 'Lemonade', 'custom', '{"water":90.0}');"#,
    )
    .unwrap();
    assert_eq!(water_food_get(&conn, ME).unwrap().unwrap().id, 22);
    conn.execute("UPDATE food SET archived = 1 WHERE id = 22", [])
        .unwrap();
    assert_eq!(water_food_get(&conn, ME).unwrap().unwrap().id, 21);
    conn.execute("UPDATE food SET archived = 1 WHERE id = 21", [])
        .unwrap();
    assert_eq!(water_food_get(&conn, ME).unwrap().unwrap().id, seeded);

    // Your pick wins, until it's archived; unknown and archived picks are
    // refused.
    assert_eq!(
        water_food_set(&mut conn, ME, Some(23)).unwrap().unwrap().id,
        23
    );
    assert_eq!(water_food_choice(&conn, ME).unwrap(), Some(23));
    for bad in [999, 22] {
        assert!(matches!(
            water_food_set(&mut conn, ME, Some(bad)),
            Err(Error::Invalid { field: Some(f), .. }) if f == "food_id"
        ));
    }
    conn.execute("UPDATE food SET archived = 1 WHERE id = 23", [])
        .unwrap();
    assert_eq!(water_food_get(&conn, ME).unwrap().unwrap().id, seeded);
    conn.execute("UPDATE food SET archived = 0 WHERE id = 23", [])
        .unwrap();

    // A merge carries the pick over; a deleted food lets it go.
    let merged = food(&mut conn, "Tap water", &[("water", 100.0)]);
    food_merge(
        &mut conn,
        merged,
        &MergeInput {
            from: 23,
            rev: Some(1),
        },
    )
    .unwrap();
    assert_eq!(water_food_choice(&conn, ME).unwrap(), Some(merged));
    conn.execute("DELETE FROM food WHERE id = ?", [merged])
        .unwrap();
    assert_eq!(water_food_choice(&conn, ME).unwrap(), None);
    // Back to the default.
    assert_eq!(
        water_food_set(&mut conn, ME, None).unwrap().unwrap().id,
        seeded
    );

    // With nothing left, there is none.
    conn.execute("UPDATE food SET archived = 1", []).unwrap();
    assert!(water_food_get(&conn, ME).unwrap().is_none());
}

#[test]
fn upgrade_from_v26_adds_check_ins() {
    // A database as release 26 left it: a second profile with a note.
    let conn = upgraded(
        at_version(26),
        "INSERT INTO profile (id, name) VALUES (2, 'Anna');
         INSERT INTO day_note (profile_id, day, text) VALUES (2, '2026-10-01', 'Travel');",
    );
    let anna = ProfileId(2);
    assert_eq!(
        note_list(&conn, anna, None, None).unwrap()[0].text,
        "Travel"
    );
    assert!(check_in_list(&conn, anna, None, None).unwrap().is_empty());
    conn.execute(
        "INSERT INTO check_in (profile_id, day, mood) VALUES (2, '2026-10-01', 4)",
        [],
    )
    .unwrap();
    // A check-in holds a scale or a tag, in bounds; tags are an array.
    for bad in [
        "INSERT INTO check_in (profile_id, day) VALUES (2, '2026-10-02')",
        "INSERT INTO check_in (profile_id, day, tags) VALUES (2, '2026-10-02', '[ ]')",
        "INSERT INTO check_in (profile_id, day, mood) VALUES (2, '2026-10-02', 6)",
        r#"INSERT INTO check_in (profile_id, day, mood, tags) VALUES (2, '2026-10-02', 3, '{"a":1}')"#,
        "INSERT INTO check_in (profile_id, day, mood, tags) VALUES (2, '2026-10-02', 3, 'travel')",
    ] {
        assert!(conn.execute(bad, []).is_err(), "{bad}");
    }
    conn.execute(
        r#"INSERT INTO check_in (profile_id, day, tags) VALUES (2, '2026-10-02', '["sick"]')"#,
        [],
    )
    .unwrap();
    // The profile takes its check-ins with it.
    conn.execute("DELETE FROM profile WHERE id = 2", [])
        .unwrap();
    let left: i64 = conn
        .query_row("SELECT count(*) FROM check_in", [], |r| r.get(0))
        .unwrap();
    assert_eq!(left, 0);
}

// ---------------------------------------------- upgrades and snapshots

#[test]
fn upgrade_from_v27_logs_an_unlogged_profile_weight() {
    // Me has only the profile's own weight; Anna has a log already,
    // which stays the only truth.
    let conn = upgraded(
        at_version(27),
        "UPDATE profile SET weight_kg = 70 WHERE id = 1;
         INSERT INTO profile (id, name, weight_kg) VALUES (2, 'Anna', 60);
         INSERT INTO weight (profile_id, day, kg) VALUES (2, '2026-10-01', 58);",
    );
    let today: String = conn
        .query_row("SELECT date('now')", [], |r| r.get(0))
        .unwrap();
    assert_eq!(
        weight_list(&conn, ME, None, None).unwrap(),
        [Weight {
            day: today,
            kg: 70.0
        }]
    );
    let anna = ProfileId(2);
    assert_eq!(
        weight_list(&conn, anna, None, None).unwrap(),
        [Weight {
            day: "2026-10-01".into(),
            kg: 58.0
        }]
    );
    assert_eq!(
        profile_get(&conn, anna).unwrap().unwrap().latest_weight_kg,
        Some(58.0)
    );
    let column: i64 = conn
        .query_row(
            "SELECT count(*) FROM pragma_table_info('profile') WHERE name = 'weight_kg'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(column, 0, "one store per fact");
}

#[test]
fn upgrade_from_v28_moves_goals_into_targets() {
    // Every old goal lands as a target or a habit goal.
    let conn = upgraded(
        at_version(28),
        "UPDATE profile SET workouts_per_week = 3, goal_weight_kg = 70.5, rev = 4 WHERE id = 1;
         INSERT INTO profile (id, name) VALUES (2, 'Anna');
         INSERT INTO target (profile_id, nutrient, value) VALUES (1, 'energy', 2000);
         INSERT INTO habit (id, profile_id, name, unit, day_limit) VALUES
             (1, 1, 'Snus', 'pouches', 5), (2, 1, 'Coffee', 'cups', NULL);",
    );
    let me = profile_get(&conn, ME).unwrap().unwrap();
    assert_eq!(me.rev, 5, "a client holding the old shape reloads");
    let set: Vec<(String, f64, bool)> = target_list(&conn, ME)
        .unwrap()
        .into_iter()
        .map(|t| (t.metric, t.value, t.default))
        .collect();
    for want in [
        ("energy".to_owned(), 2000.0, false),
        ("workouts_per_week".to_owned(), 3.0, false),
        ("goal_weight".to_owned(), 70.5, false),
        ("steps".to_owned(), 10_000.0, true),
        ("sleep_min".to_owned(), 420.0, true),
    ] {
        assert!(set.contains(&want), "{want:?} in {set:?}");
    }
    assert_eq!(set.len(), 5, "{set:?}");
    let anna: Vec<String> = target_list(&conn, ProfileId(2))
        .unwrap()
        .into_iter()
        .map(|t| t.metric)
        .collect();
    assert_eq!(anna, ["steps", "sleep_min"], "defaults only, no rows");
    let habits: Vec<(Option<f64>, GoalDir)> = habit_list(&conn, ME)
        .unwrap()
        .into_iter()
        .map(|h| (h.goal_value, h.goal_dir))
        .collect();
    assert_eq!(
        habits,
        [(Some(5.0), GoalDir::AtMost), (None, GoalDir::AtMost)]
    );
    assert!(
        conn.execute("UPDATE habit SET goal_dir = 'about'", [])
            .is_err()
    );
}

#[test]
fn upgrade_from_v29_renames_the_scale_source() {
    let conn = upgraded(
        at_version(29),
        "INSERT INTO weight (profile_id, day, kg, source, set_at) VALUES
             (1, '2026-10-01', 80, 'manual', 5), (1, '2026-10-02', 79, 'scale', 6);",
    );
    let rows: Vec<(String, WeightSource, Option<i64>)> = conn
        .prepare("SELECT day, source, set_at FROM weight ORDER BY day")
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert_eq!(
        rows,
        [
            ("2026-10-01".into(), WeightSource::Hand, Some(5)),
            ("2026-10-02".into(), WeightSource::OpenScale, Some(6)),
        ]
    );
    assert!(
        conn.execute(
            "INSERT INTO weight (profile_id, day, kg, source) VALUES (1, '2026-10-03', 1, 'scale')",
            [],
        )
        .is_err()
    );
}

#[test]
fn upgrade_from_v30_turns_quick_adds_into_foods() {
    // Two "Snack" quick adds alike, one "Snack" at 50 g (other values
    // per 100 g), a feast over the per-100 caps at 100 g, a logged food.
    let conn = upgraded(
        at_version(30),
        r#"INSERT INTO food (id, name, source, per100) VALUES (500, 'Oats', 'custom', '{"energy":380.0}');
           INSERT INTO entry (profile_id, day, grp, kind, food_id, name, grams, amount, nutrients, uid)
           VALUES
             (1, '2026-10-01', 'Eaten', 'quick', NULL, 'Snack', NULL, 'Quick add', '{"energy":100.0}', 'q1'),
             (1, '2026-10-01', 'Eaten', 'quick', NULL, 'Snack', NULL, 'Quick add', '{"energy":100.0}', 'q2'),
             (1, '2026-10-01', 'Planned', 'quick', NULL, 'Snack', 50, 'Quick add', '{"energy":200.0}', 'q3'),
             (1, '2026-10-02', 'Eaten', 'quick', NULL, 'Feast', NULL, 'Dinner out',
                 '{"energy":2500.0,"fat":150.0,"sodium":3000.0}', 'q4'),
             (1, '2026-10-02', 'Eaten', 'food', 500, 'Oats', 50, '50 g', '{"energy":190.0}', 'f1');"#,
    );
    let totals = group_sums(group_rows(&conn, ME, "2026-10-01", "2026-10-02").unwrap()).unwrap();
    let energy = |day: &str, grp: &str| {
        totals[&(day.to_owned(), grp.to_owned())]
            .get("energy")
            .unwrap()
    };
    assert_close!(energy("2026-10-01", "Eaten"), 200.0);
    assert_close!(energy("2026-10-01", "Planned"), 200.0);
    assert_close!(energy("2026-10-02", "Eaten"), 2690.0);
    let entries: Vec<(String, Option<i64>, Option<f64>, String)> = conn
        .prepare("SELECT uid, food_id, grams, amount FROM entry ORDER BY id")
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    let food_of = |uid: &str| entries.iter().find(|e| e.0 == uid).unwrap().1.unwrap();
    assert_eq!(food_of("q1"), food_of("q2"), "one food per name and values");
    assert_ne!(food_of("q1"), food_of("q3"));
    assert_eq!(food_of("f1"), 500);
    assert!(
        entries.iter().all(|e| !e.3.is_empty() && e.2.is_some()),
        "{entries:?}"
    );
    let mut made: Vec<i64> = ["q1", "q3", "q4"].iter().map(|u| food_of(u)).collect();
    made.dedup();
    for id in made {
        let f = food_get(&conn, id).unwrap().unwrap();
        assert!(f.archived && f.source == Source::Custom, "{f:?}");
        FoodInput {
            name: f.name.clone(),
            per100: f.per100.clone(),
            ..FoodInput::default()
        }
        .checked()
        .unwrap_or_else(|e| panic!("{}: {e}", f.name));
    }
    let snack = food_get(&conn, food_of("q3")).unwrap().unwrap();
    assert_close!(
        snack.per100.get("energy").unwrap(),
        400.0,
        "200 kcal in 50 g"
    );
    let feast = food_get(&conn, food_of("q4")).unwrap().unwrap();
    let grams = entries.iter().find(|e| e.0 == "q4").unwrap().2.unwrap();
    assert!(
        grams > 277.7 && grams < 277.8,
        "grams that fit 900 kcal/100 g: {grams}"
    );
    assert_close!(
        feast.per100.get("energy").unwrap() * grams / 100.0,
        2500.0,
        "the food at the entry's grams is the entry"
    );
    let column: i64 = conn
        .query_row(
            "SELECT count(*) FROM pragma_table_info('entry') WHERE name = 'kind'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(column, 0);
}

#[test]
fn upgrade_from_v31_adds_food_categories() {
    let conn = upgraded(
        at_version(31),
        "INSERT INTO food (id, name, source) VALUES (500, 'Apple', 'custom');",
    );
    let (category, auto): (Option<String>, bool) = conn
        .query_row(
            "SELECT category, category_auto FROM food WHERE id = 500",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!((category, auto), (None, false));
    let plan: String = conn
        .query_row(
            "EXPLAIN QUERY PLAN SELECT id FROM food WHERE category = 'fruit_veg'",
            [],
            |r| r.get(3),
        )
        .unwrap();
    assert!(plan.contains("food_category"), "{plan}");
}

#[test]
fn upgrade_from_v32_drops_set_based_distances() {
    let conn = upgraded(
        at_version(32),
        "INSERT INTO workout_session (id, profile_id, day, name, minutes, sets, type, distance_m)
         VALUES (1, 1, '2026-10-01', 'Gym', 60, '[]', NULL, 500),
                (2, 1, '2026-10-01', 'Run', 30, '[]', 'run', 5000);",
    );
    let distances: Vec<Option<u32>> = activity_list(&conn, ME, None, None, None)
        .unwrap()
        .into_iter()
        .map(|s| s.distance_m)
        .collect();
    assert_eq!(distances, [None, Some(5000)]);
}

#[test]
fn upgrade_from_v33_gives_fineli_foods_without_a_category_to_the_importer() {
    let conn = upgraded(
        at_version(33),
        "INSERT INTO food (id, name, source, category, category_auto)
         VALUES (500, 'Leipä', 'fineli', NULL, 0),
                (501, 'Omena', 'fineli', 'fruit_veg', 0),
                (502, 'Mine', 'custom', NULL, 0);",
    );
    let auto: Vec<bool> = conn
        .prepare("SELECT category_auto FROM food WHERE id BETWEEN 500 AND 502 ORDER BY id")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert_eq!(auto, [true, false, false]);
}

#[test]
fn upgrade_from_v36_keeps_items_as_grams() {
    let conn = upgraded(
        at_version(36),
        r#"INSERT INTO food (id, name, source, per100) VALUES (500, 'Oats', 'custom', '{"energy":380.0}');
           INSERT INTO serving (food_id, label, grams) VALUES (500, 'Cup', 80);
           INSERT INTO food (id, name, source, per100) VALUES (501, 'Porridge', 'recipe', '{}');
           INSERT INTO recipe_item (recipe_id, food_id, grams) VALUES (501, 500, 80);
           INSERT INTO meal (id, name) VALUES (1, 'Breakfast');
           INSERT INTO meal_item (meal_id, food_id, grams) VALUES (1, 500, 80);"#,
    );
    let recipe = recipe_get(&conn, 501).unwrap().unwrap().items;
    let meal = meal_get(&conn, 1).unwrap().unwrap().items;
    for item in [&recipe[0], &meal[0]] {
        assert_eq!(
            (item.grams, item.serving.as_deref(), item.quantity),
            (80.0, None, None)
        );
    }
}

#[test]
fn upgrade_from_v38_keeps_recipe_instructions_as_notes() {
    let conn = upgraded(
        at_version(38),
        r"INSERT INTO food (id, name, source, per100, instructions)
               VALUES (600, 'Porridge', 'recipe', '{}', 'Boil.');",
    );
    assert_eq!(
        recipe_get(&conn, 600)
            .unwrap()
            .unwrap()
            .food
            .notes
            .as_deref(),
        Some("Boil.")
    );
}

#[test]
fn upgrade_from_v40_to_head() {
    // The owner's database before the 2026-10-12 batch, migrated to head;
    // each wave adds its checks here (tests/fixtures/v40.sql).
    let mut conn = upgraded(at_version(40), include_str!("../../tests/fixtures/v40.sql"));
    // W1: every session has a type; a set-based one is a workout.
    let sessions = activity_list(&conn, ME, None, None, None).unwrap();
    let typed: Vec<(&str, ActivityType, Option<u32>, Option<&str>)> = sessions
        .iter()
        .map(|s| {
            (
                s.uid.as_str(),
                s.kind,
                s.distance_m,
                s.source_key.as_deref(),
            )
        })
        .collect();
    assert_eq!(
        typed,
        [
            ("v40-gym1", ActivityType::Workout, None, None),
            ("v40-run1", ActivityType::Run, Some(8200), Some("hc-1")),
            ("v40-ride", ActivityType::Cycling, Some(10000), Some("hc-2")),
            ("v40-walk", ActivityType::Walk, Some(2400), Some("gh-9")),
        ]
    );
    assert_eq!(sessions[0].sets[0].kg, Some(80.0));
    // The vocabulary lives in `ActivityType`: no SQL check to rebuild for a
    // new type, but a type is required.
    conn.execute("UPDATE activity SET type = 'yoga' WHERE id = 1", [])
        .unwrap();
    assert!(
        conn.execute("UPDATE activity SET type = NULL WHERE id = 1", [])
            .is_err()
    );
    // Rebuilt with its indexes, uid trigger and foreign keys; a deleted
    // session's id is never handed out again.
    let objects: Vec<String> = conn
        .prepare(
            "SELECT type || ' ' || name FROM sqlite_master
             WHERE tbl_name = 'activity' ORDER BY 1",
        )
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert_eq!(
        objects,
        [
            "index activity_profile_day",
            "index activity_source_key",
            "index activity_uid",
            "table activity",
            "trigger activity_uid",
        ]
    );
    let input = ActivityInput {
        day: "2026-10-05".into(),
        workout_id: None,
        name: "Walk".into(),
        minutes: 20,
        kcal: None,
        sets: Vec::new(),
        kind: ActivityType::Walk,
        distance_m: None,
        start_at: None,
        uid: None,
        rev: None,
    };
    let next = activity_save(&mut conn, ME, None, &input).unwrap();
    assert_eq!(next.id, 6, "after the deleted 5");
    assert_eq!(next.uid.len(), 32);
    assert!(
        conn.execute(
            "INSERT INTO activity (profile_id, day, name, minutes, type)
             VALUES (99, '2026-10-05', 'x', 1, 'run')",
            [],
        )
        .is_err(),
        "the profile foreign key holds"
    );
    // Untouched: the synced day, the raw copies, the tombstone, the scale.
    let a = device_day_list(&conn, ME, None, None).unwrap();
    assert_eq!((a.days.len(), a.sessions.len()), (3, 2));
    assert_eq!(scale_list(&conn, ME, None, None).unwrap().len(), 1);
    assert!(
        target_list(&conn, ME)
            .unwrap()
            .iter()
            .any(|t| t.metric == "water" && (t.value - 2500.0).abs() < 1e-9)
    );
    w2_after_v40(&conn, &sessions);
    w3_after_v40(&conn);
    w4_after_v40(&conn);
    w5_after_v40(&conn);
    a6_after_v40(&conn);
    a7_after_v40(&mut conn);
    // K (migration 53): the eaten group is `Eaten`.
    let salmon = entry_list_for_day(&conn, ME, "2026-10-02").unwrap();
    assert_eq!(
        salmon.iter().map(|e| e.group.as_str()).collect::<Vec<_>>(),
        ["Eaten"]
    );
    h_after_v40(&conn);
}

/// `upgrade_from_v40_to_head`, H (migration 56): stored in the one
/// vocabulary, as read; a food is a food.
fn h_after_v40(conn: &Connection) {
    let stored: Vec<String> = conn
        .prepare(
            "SELECT uid || ' ' || source || ' ' || coalesce(kcal_source, '-')
             FROM activity WHERE uid LIKE 'v40-%' ORDER BY id",
        )
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert_eq!(
        stored,
        [
            "v40-gym1 hand -",
            "v40-run1 hand hand",
            "v40-ride health_connect health_connect",
            "v40-walk import import",
        ]
    );
    let kind: String = conn
        .query_row(
            "SELECT source || ' ' || kind FROM food WHERE id = 900",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(kind, "custom food");
}

/// `upgrade_from_v40_to_head`, A7 (migration 49): workouts start without
/// notes, their steps as stored; notes and note blocks save after.
fn a7_after_v40(conn: &mut Connection) {
    let core = workout_get(conn, 901).unwrap().unwrap();
    assert_eq!((core.notes.as_deref(), core.minutes), (None, Some(12)));
    assert!(matches!(
        &core.steps[0],
        Step::Repeat {
            times: 2,
            every: Some(60),
            ..
        }
    ));
    let mut steps = core.steps.clone();
    steps.push(Step::Note {
        name: None,
        text: Some("Breathe.".into()),
    });
    let input = WorkoutInput {
        name: core.name,
        steps,
        minutes: core.minutes,
        kcal: None,
        notes: Some("Slow.\nSteady.".into()),
        archived: false,
        rev: Some(core.rev),
        uid: None,
    };
    let saved = workout_save(conn, Some(901), &input.checked().unwrap()).unwrap();
    assert_eq!(saved.notes.as_deref(), Some("Slow.\nSteady."));
    assert_eq!(workout_get(conn, 901).unwrap().unwrap(), saved);
}

/// `upgrade_from_v40_to_head`, A6 (migration 48): the synced and imported
/// days read with no heart rate yet; sleep stage spans start empty and
/// store per source, one per start.
fn a6_after_v40(conn: &Connection) {
    let day = &day_list(conn, ME, None, None).unwrap()[0];
    assert_eq!(
        (day.resting_hr, day.avg_hr, day.sleep_avg_hr),
        (Some(54), None, None)
    );
    let imported = &device::import_list(conn, ME).unwrap()[0];
    assert_eq!((imported.resting_hr, imported.max_hr), (Some(55), None));
    assert!(sleep_stage_list(conn, ME, None, None).unwrap().is_empty());
    let span = |stage, source| SleepStage {
        day: "2026-10-02".into(),
        start_at: "2026-10-01T21:00:00Z".into(),
        end_at: "2026-10-01T22:00:00Z".into(),
        stage,
        source,
    };
    device::stages_put(
        conn,
        ME,
        &[
            span(SleepStageKind::Deep, StageSource::Import),
            span(SleepStageKind::Light, StageSource::Import),
            span(SleepStageKind::Rem, StageSource::HealthConnect),
        ],
    )
    .unwrap();
    assert_eq!(sleep_stage_list(conn, ME, None, None).unwrap().len(), 2);
    let shown = day_stages(conn, ME, "2026-10-02").unwrap();
    assert_eq!(
        shown.iter().map(|s| s.stage).collect::<Vec<_>>(),
        [SleepStageKind::Rem],
        "the device's beat the import's"
    );
}

/// `upgrade_from_v40_to_head`, W5 (migration 45): entries link no daily
/// item; workouts start unarchived.
fn w5_after_v40(conn: &Connection) {
    let salmon: Vec<Entry> = entry_list_for_day(conn, ME, "2026-10-02").unwrap();
    assert_eq!(salmon[0].repeat, None);
    let w = workout_get(conn, 900).unwrap().unwrap();
    assert_eq!((w.name.as_str(), w.archived), ("Legs", false));
    assert_eq!(daily_due(conn, ME, "2026-10-02").unwrap().len(), 0);
}

#[test]
fn upgrade_from_v44_adds_daily_items() {
    let mut conn = upgraded(
        at_version(44),
        r#"INSERT INTO food (id, name, source, per100) VALUES (500, 'Shake', 'custom', '{"energy":400.0}');
           INSERT INTO entry (id, profile_id, day, grp, food_id, name, grams, amount, nutrients, uid)
             VALUES (1, 1, '2026-10-01', 'Eaten', 500, 'Shake', 30, '30 g', '{"energy":120.0}', 'v44-shake');"#,
    );
    assert_eq!(entry_get(&conn, ME, 1).unwrap().unwrap().repeat, None);
    let repeat = crate::model::EntryPatch {
        repeat: crate::model::Nullable::Set(crate::model::RepeatInput::default()),
        ..crate::model::EntryPatch::default()
    };
    let entry = entry_update(&mut conn, ME, 1, &repeat).unwrap();
    let item = entry.repeat.unwrap();
    assert_eq!(item.start, "2026-10-01");
    let due = daily_due(&conn, ME, "2026-10-02").unwrap();
    assert_eq!(
        (due[0].food_id, due[0].grams, due[0].repeat.as_ref()),
        (Some(500), Some(30.0), Some(&item))
    );
    // One linked entry per item and day; skips go with their item, links
    // clear.
    assert!(
        conn.execute(
            "INSERT INTO entry (profile_id, day, grp, food_id, name, grams, amount, nutrients,
                 uid, daily_item_id)
             VALUES (1, '2026-10-01', 'Eaten', 500, 'Shake', 30, '30 g', '{}', 'v44-twice', ?)",
            [item.id],
        )
        .is_err()
    );
    daily_skip(&conn, ME, item.id, "2026-10-03", true).unwrap();
    let stop = crate::model::EntryPatch {
        repeat: crate::model::Nullable::Clear,
        ..crate::model::EntryPatch::default()
    };
    entry_update(&mut conn, ME, 1, &stop).unwrap();
    let left: i64 = conn
        .query_row("SELECT count(*) FROM daily_skip", [], |r| r.get(0))
        .unwrap();
    assert_eq!(left, 0);
    assert_eq!(entry_get(&conn, ME, 1).unwrap().unwrap().repeat, None);
}

#[test]
fn upgrade_from_v46_adds_hooks_that_go_with_their_profile() {
    let mut conn = upgraded(at_version(46), "");
    assert_eq!(hook_get(&conn, ME).unwrap(), None);
    let hook = crate::model::HookInput {
        url: "http://ha.lan:8123".into(),
        webhook_id: Some("kaloriina".into()),
        events: vec!["workout_finished".into()],
    }
    .checked()
    .unwrap();
    hook_set(&mut conn, ME, &hook).unwrap();
    let target = hook_target(&conn, ME).unwrap().unwrap();
    assert_eq!(target.webhook_id, "kaloriina");
    conn.execute("DELETE FROM profile WHERE id = 1", [])
        .unwrap();
    let left: i64 = conn
        .query_row("SELECT count(*) FROM hook", [], |r| r.get(0))
        .unwrap();
    assert_eq!(left, 0);
}

/// `upgrade_from_v40_to_head`, W4 (migration 44): no latitude until one
/// is set; EPA+DHA stored wherever EPA or DHA is, so SQL reads it.
fn w4_after_v40(conn: &Connection) {
    let p = profile_get(conn, ME).unwrap().unwrap();
    assert_eq!(p.body.latitude, None);
    let stored = |sql: &str| -> Vec<Option<f64>> {
        conn.prepare(sql)
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap()
    };
    assert_eq!(
        stored(
            "SELECT json_extract(per100, '$.epa_dha') FROM food WHERE id IN (900, 901) ORDER BY id"
        ),
        [Some(1.7), None]
    );
    assert_eq!(
        stored("SELECT json_extract(nutrients, '$.epa_dha') FROM entry WHERE uid = 'v40-salmon'"),
        [Some(3.4)]
    );
    assert_eq!(
        stored("SELECT json_extract(nutrients, '$.epa_dha') FROM day_total"),
        [Some(0.3)]
    );
    let src = nutrient_sources(conn, ME, "2026-10-01", "2026-10-02", "epa_dha").unwrap();
    assert_eq!((src.foods.len(), src.foods[0].amount), (1, 3.4));
    assert!((src.total - 3.7).abs() < 1e-9 && (src.unattributed - 0.3).abs() < 1e-9);
}

/// `upgrade_from_v40_to_head`, W3 (migration 43): a goal date beside kg a
/// week, a day's device total energy; the water goal stays hydration's.
fn w3_after_v40(conn: &Connection) {
    let p = profile_get(conn, ME).unwrap().unwrap();
    assert_eq!(
        (p.body.goal_kg_per_week, p.body.goal_date.as_deref()),
        (-0.5, None)
    );
    let a = device_day_list(conn, ME, None, None).unwrap();
    assert_eq!(
        (a.days[0].day.active_kcal, a.days[0].day.total_kcal),
        (Some(512), None)
    );
    assert!(
        BUILTINS
            .iter()
            .any(|b| b.metric == "water" && b.source == BuiltinSource::Hydration)
    );
}

/// `upgrade_from_v40_to_head`, W2 (migration 42): energy sources, heart
/// rate, the scale's new measures, the weight source, naps, the raw store.
fn w2_after_v40(conn: &Connection, sessions: &[Activity]) {
    let a = device_day_list(conn, ME, None, None).unwrap();
    // Whose energy each session's is, as migration 42 read them; no heart
    // rate yet.
    let energy: Vec<(&str, Option<KcalSource>, Option<u32>)> = sessions
        .iter()
        .map(|s| (s.uid.as_str(), s.kcal_source, s.avg_hr))
        .collect();
    assert_eq!(
        energy,
        [
            ("v40-gym1", None, None),
            ("v40-run1", Some(KcalSource::Hand), None),
            ("v40-ride", Some(KcalSource::HealthConnect), None),
            ("v40-walk", Some(KcalSource::Import), None),
        ]
    );
    assert_eq!(
        (a.sessions[0].avg_hr, a.days[0].total_asleep_min),
        (None, Some(440))
    );
    // The reading kept, its new measures empty; the day's weight rebuilt
    // with its source, which may now be Health Connect's.
    let r = &scale_list(conn, ME, None, None).unwrap()[0];
    assert_eq!(
        (r.weight, r.bone_kg, r.lbm_kg, r.bmr_kcal),
        (81.5, None, None, None)
    );
    assert_eq!(
        weight_source(conn, ME, "2026-10-02").unwrap(),
        Some(WeightSource::OpenScale)
    );
    conn.execute(
        "INSERT INTO weight (profile_id, day, kg, source) VALUES (1, '2026-10-05', 80, 'health_connect')",
        [],
    )
    .unwrap();
    // Naps and the raw store start empty; a nap gets its uid.
    assert_eq!(nap_list(conn, ME, None, None).unwrap(), []);
    conn.execute(
        "INSERT INTO nap (profile_id, day, start_at, end_at, source)
         VALUES (1, '2026-10-05', '2026-10-05T12:00:00Z', '2026-10-05T12:30:00Z', 'hand')",
        [],
    )
    .unwrap();
    let nap = nap_list(conn, ME, None, None).unwrap().remove(0);
    assert_eq!((nap.uid.len(), nap.in_bed_min), (32, 30));
    let raw: i64 = conn
        .query_row("SELECT count(*) FROM health_record", [], |r| r.get(0))
        .unwrap();
    assert_eq!(raw, 0);
}

#[test]
fn raw_records_are_upserted_by_key() {
    let mut conn = memory();
    let record = |data: &str| HealthRecord {
        kind: "HeartRate".into(),
        id: "hr-1".into(),
        start_at: Some("2026-10-05T12:00:00Z".into()),
        end_at: None,
        day: Some("2026-10-05".into()),
        data: data.into(),
        truncated: false,
    };
    let page = |r: HealthRecord, skipped: u64| RecordsPost {
        records: vec![r],
        skipped,
        failed: 0,
    };
    records_put(
        &mut conn,
        ME,
        &page(record(r#"{"bpm":60}"#), 0),
        1,
        &TimeZone::UTC,
    )
    .unwrap();
    let counts = records_put(
        &mut conn,
        ME,
        &page(record(r#"{"bpm":61}"#), 2),
        2,
        &TimeZone::UTC,
    )
    .unwrap();
    assert_eq!((counts.records, counts.skipped), (1, 2));
    let rows: Vec<(String, i64)> = conn
        .prepare("SELECT data, received_at FROM health_record")
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert_eq!(rows, [(r#"{"bpm":61}"#.to_owned(), 2)]);
    // An import's row already kept isn't counted again.
    assert_eq!(
        records_add(&mut conn, ME, "google_health", &[record("{}")], 3).unwrap(),
        1
    );
    assert_eq!(
        records_add(&mut conn, ME, "google_health", &[record("{}")], 4).unwrap(),
        0
    );
    // Not JSON: refused by the table.
    assert!(records_put(&mut conn, ME, &page(record("{"), 0), 5, &TimeZone::UTC).is_err());
}

#[test]
fn records_outcome_starts_over_after_a_window_whatever_the_clock() {
    // A page and its window in one millisecond (a fast server), or the
    // window stamped before the page (the clock stepped back): the next
    // page still starts a new outcome.
    for (page_at, window_at) in [(5, 5), (5, 4)] {
        let mut conn = memory();
        let page = |id: &str, failed: u64| RecordsPost {
            records: vec![HealthRecord {
                kind: "Weight".into(),
                id: id.into(),
                start_at: Some("2026-10-05T12:00:00Z".into()),
                end_at: None,
                day: Some("2026-10-05".into()),
                data: "{}".into(),
                truncated: false,
            }],
            skipped: 0,
            failed,
        };
        let window = crate::model::HealthPost {
            from: "2026-10-01".into(),
            to: "2026-10-07".into(),
            device: None,
            days: Vec::new(),
            sessions: Vec::new(),
            body: Vec::new(),
            read: BTreeMap::new(),
            skipped: 0,
        };
        let tz = &TimeZone::UTC;
        records_put(&mut conn, ME, &page("w-1", 1), page_at, tz).unwrap();
        records_put(&mut conn, ME, &page("w-2", 2), page_at, tz).unwrap();
        device_replace(&mut conn, ME, &window, window_at, tz).unwrap();
        let kept = health_status(&conn, ME).unwrap().records_result.unwrap();
        assert_eq!((kept.counts.records, kept.counts.failed), (2, 3));
        records_put(&mut conn, ME, &page("w-3", 0), page_at, tz).unwrap();
        let next = health_status(&conn, ME).unwrap().records_result.unwrap();
        assert_eq!(
            (next.counts.records, next.counts.failed),
            (1, 0),
            "page at {page_at}, window at {window_at}"
        );
    }
}

#[test]
fn the_day_range_is_written_once() {
    // A profile's days in [from, to] read through `IN_RANGE` (db/mod.rs),
    // whose open ends are bounds the day index can use: no
    // copy of it, and no `?n IS NULL OR day …`, which defeats the index.
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/db");
    let copies: Vec<String> = std::fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| !p.ends_with("tests.rs"))
        .filter(|p| p.extension().is_some_and(|x| x == "rs"))
        .filter(|p| {
            let text: String = std::fs::read_to_string(p)
                .unwrap()
                .lines()
                .filter(|l| !l.trim_start().starts_with("//"))
                .collect::<Vec<_>>()
                .join("\n");
            // `IS NULL OR day`, or a table's (`IS NULL OR p.day`).
            let open_end = text.match_indices("IS NULL OR ").any(|(at, m)| {
                let rest = &text[at + m.len()..];
                let rest = match rest.split_once('.') {
                    Some((alias, after)) if alias.bytes().all(|b| b.is_ascii_lowercase()) => after,
                    _ => rest,
                };
                rest.starts_with("day")
            });
            // A copy of IN_RANGE; a joined table's own (`d.day >= …`) isn't.
            open_end || (!p.ends_with("mod.rs") && text.contains(" day >= coalesce(?2, '')"))
        })
        .map(|p| p.display().to_string())
        .collect();
    assert_eq!(copies, Vec::<String>::new());
    assert_eq!(
        IN_RANGE,
        "profile_id = ?1 AND day >= coalesce(?2, '') AND day <= coalesce(?3, '9999-12-31')"
    );
}

#[test]
fn no_reader_selects_health_record() {
    // The raw store is an archive (ADR 0019): nothing shows it; the
    // server's own derivations read it (nights, resting energy), through
    // `db/health_record.rs` alone.
    fn files(dir: &Path, out: &mut Vec<std::path::PathBuf>) {
        for e in std::fs::read_dir(dir).unwrap() {
            let p = e.unwrap().path();
            if p.is_dir() {
                files(&p, out);
            } else if p.extension().is_some_and(|x| x == "rs") {
                out.push(p);
            }
        }
    }
    let mut all = Vec::new();
    files(&Path::new(env!("CARGO_MANIFEST_DIR")).join("src"), &mut all);
    assert!(all.len() > 10, "{all:?}");
    let readers: Vec<String> = all
        .iter()
        .filter(|p| !p.ends_with("db/tests.rs") && !p.ends_with("db/health_record.rs"))
        .filter(|p| {
            // Erasure deletes; it reads nothing.
            let text = std::fs::read_to_string(p)
                .unwrap()
                .to_uppercase()
                .replace("DELETE FROM HEALTH_RECORD", "");
            [
                "FROM HEALTH_RECORD",
                "JOIN HEALTH_RECORD",
                "UPDATE HEALTH_RECORD",
            ]
            .iter()
            .any(|r| text.contains(r))
        })
        .map(|p| p.display().to_string())
        .collect();
    assert_eq!(readers, Vec::<String>::new());
}

/// A database file in a directory of its own at `version`, with `sql`
/// run after; the directory.
fn file_at(name: &str, version: u32, sql: &str) -> (std::path::PathBuf, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("kaloriina-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("k.db");
    let conn = Connection::open(&path).unwrap();
    for (v, sql) in (1..=version).zip(MIGRATIONS) {
        conn.execute_batch(sql).unwrap();
        conn.pragma_update(None, "user_version", v).unwrap();
    }
    conn.execute_batch(sql).unwrap();
    (dir, path)
}

/// The names in `dir` holding `part`, sorted.
fn names_with(dir: &Path, part: &str) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|n| n.contains(part))
        .collect();
    names.sort();
    names
}

#[test]
fn a_failing_migration_snapshots_once_and_names_itself() {
    // Regression: systemd restarts a failing start; each
    // start wrote another full copy, and the error named no migration.
    let (dir, path) = file_at(
        "failing",
        26,
        "CREATE TABLE check_in (profile_id INTEGER, day TEXT);",
    );
    for _ in 0..3 {
        let err = open(&path).map(|_| ()).unwrap_err();
        assert!(err.to_string().starts_with("migration 27: "), "{err}");
    }
    assert_eq!(names_with(&dir, ".pre-v"), ["k.db.pre-v26"]);
    assert_eq!(names_with(&dir, ".migrating-v"), ["k.db.migrating-v26"]);
    let version: u32 = Connection::open(&path)
        .unwrap()
        .pragma_query_value(None, "user_version", |r| r.get(0))
        .unwrap();
    assert_eq!(version, 26, "nothing committed");
    // Fixed, it migrates, and the marker goes.
    Connection::open(&path)
        .unwrap()
        .execute_batch("DROP TABLE check_in")
        .unwrap();
    drop(open(&path).unwrap());
    assert!(names_with(&dir, ".migrating-v").is_empty());
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn a_rolled_back_db_used_again_gets_a_fresh_snapshot() {
    // A snapshot from an earlier upgrade, then the file rolled back and
    // written to since: that old copy isn't this file's.
    let (dir, path) = file_at(
        "rolled",
        26,
        "INSERT INTO day_note (profile_id, day, text) VALUES (1, '2026-10-01', 'Old');",
    );
    let old = dir.join("k.db.pre-v26");
    std::fs::copy(&path, &old).unwrap();
    let past = std::time::SystemTime::now() - std::time::Duration::from_hours(1);
    std::fs::File::options()
        .write(true)
        .open(&old)
        .unwrap()
        .set_modified(past)
        .unwrap();
    Connection::open(&path)
        .unwrap()
        .execute_batch(
            "INSERT INTO day_note (profile_id, day, text) VALUES (1, '2026-10-02', 'New');",
        )
        .unwrap();
    drop(open(&path).unwrap());
    let snapshots = names_with(&dir, ".pre-v26");
    assert_eq!(snapshots.len(), 2, "{snapshots:?}");
    let fresh = Connection::open(dir.join(&snapshots[1])).unwrap();
    let notes: i64 = fresh
        .query_row("SELECT count(*) FROM day_note", [], |r| r.get(0))
        .unwrap();
    assert_eq!(notes, 2, "the fresh copy has the new note");
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn a_migration_leaving_a_dangling_row_commits_nothing() {
    // The last guard against a rebuild that orphans rows.
    let mut conn = at_version(26);
    conn.execute(
        "INSERT INTO entry (profile_id, day, grp, name, amount) VALUES (99, '2026-10-01', 'Eaten', 'X', '1 g')",
        [],
    )
    .unwrap();
    let err = migrate(&mut conn).unwrap_err();
    assert!(matches!(err, Error::Migration(_)), "{err:?}");
    assert!(err.to_string().contains("entry row"), "{err}");
    let version: u32 = conn
        .pragma_query_value(None, "user_version", |r| r.get(0))
        .unwrap();
    assert_eq!(version, 26);
}

#[test]
fn old_snapshots_are_pruned_to_two() {
    // Copies piled up, one per upgrade.
    let (dir, path) = file_at("prune", 26, "");
    for name in [
        "k.db.pre-v10",
        "k.db.pre-v20",
        "k.db.pre-v25",
        "k.db.pre-v25.123",
        "k.db.pre-v24.5.partial",
        "other.db.pre-v1",
    ] {
        std::fs::write(dir.join(name), "old").unwrap();
    }
    drop(open(&path).unwrap());
    assert_eq!(
        names_with(&dir, ".pre-v"),
        [
            "k.db.pre-v24.5.partial",
            "k.db.pre-v25.123",
            "k.db.pre-v26",
            "other.db.pre-v1"
        ]
    );
    std::fs::remove_dir_all(&dir).unwrap();
}

/// The tables a profile export reaches: those owning rows of a profile
/// (foreign keys walked transitively from `profile`) plus [`REF_TABLES`].
fn exported_tables(conn: &Connection) -> BTreeSet<String> {
    let tables: Vec<String> = conn
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    let parents = |t: &str| -> Vec<String> {
        conn.prepare("SELECT \"table\" FROM pragma_foreign_key_list(?)")
            .unwrap()
            .query_map([t], |r| r.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap()
    };
    let mut reached = BTreeSet::from(["profile".to_owned()]);
    loop {
        let more: Vec<&String> = tables
            .iter()
            .filter(|t| !reached.contains(*t) && parents(t).iter().any(|p| reached.contains(p)))
            .collect();
        if more.is_empty() {
            break;
        }
        reached.extend(more.into_iter().cloned());
    }
    reached.extend(REF_TABLES.iter().map(|t| (*t).to_owned()));
    reached
}

#[test]
fn every_profile_column_is_exported_or_excluded() {
    let conn = memory();
    let listed = |table: &str, column: &str| {
        let exported = EXPORTED
            .iter()
            .any(|(t, cols)| *t == table && cols.contains(&column));
        let excluded = EXCLUDED
            .iter()
            .any(|(t, cols, _)| *t == table && cols.contains(&column));
        let any_table = EXCLUDED
            .iter()
            .any(|(t, cols, _)| *t == "*" && cols.contains(&column));
        match (exported, excluded) {
            (true, true) => Some("both exported and excluded"),
            (true, false) | (false, true) => None,
            (false, false) if any_table => None,
            (false, false) => Some("neither exported nor excluded"),
        }
    };
    let mut wrong = Vec::new();
    let mut columns = BTreeSet::new();
    // Tables no profile owns (feedback) are checked once they are listed.
    let mut tables = exported_tables(&conn);
    tables.extend(
        EXCLUDED
            .iter()
            .map(|(t, _, _)| (*t).to_owned())
            .filter(|t| t != "*"),
    );
    for table in tables {
        let names: Vec<String> = conn
            .prepare("SELECT name FROM pragma_table_info(?)")
            .unwrap()
            .query_map([&table], |r| r.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        for column in names {
            if let Some(why) = listed(&table, &column) {
                wrong.push(format!("{table}.{column}: {why}"));
            }
            columns.insert((table.clone(), column));
        }
    }
    // Nothing listed that isn't there: a renamed column is decided again.
    let lists = EXPORTED
        .iter()
        .map(|(t, cols)| (*t, *cols))
        .chain(EXCLUDED.iter().map(|(t, cols, _)| (*t, *cols)));
    for (table, cols) in lists.filter(|(t, _)| *t != "*") {
        for column in cols {
            if !columns.contains(&(table.to_owned(), (*column).to_owned())) {
                wrong.push(format!("{table}.{column}: listed, but no such column"));
            }
        }
    }
    assert!(wrong.is_empty(), "{wrong:#?}");
}

/// Every schema object as `(type, name, sql)`, sorted.
fn schema(conn: &Connection) -> Vec<(String, String, Option<String>)> {
    conn.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name")
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
}

#[test]
fn v27_fixture_matches_the_migrations() {
    // The golden v27 database the VM rollback drill starts from has
    // the schema migrations 1–27 build and a row in every table, and the
    // current build migrates it.
    let mut conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(include_str!("../../tests/fixtures/v27.sql"))
        .unwrap();
    let version: u32 = conn
        .pragma_query_value(None, "user_version", |r| r.get(0))
        .unwrap();
    assert_eq!(version, 27);
    assert_eq!(schema(&conn), schema(&at_version(27)));
    let empty: Vec<String> = schema(&conn)
        .into_iter()
        .filter(|(kind, name, _)| kind == "table" && !name.starts_with("sqlite_"))
        .map(|(_, name, _)| name)
        .filter(|name| {
            conn.query_row(&format!("SELECT count(*) FROM \"{name}\""), [], |r| {
                r.get::<_, i64>(0)
            })
            .unwrap()
                == 0
        })
        .collect();
    assert!(empty.is_empty(), "tables without a row: {empty:?}");
    migrate(&mut conn).unwrap();
    // Every family of derived data made over its rows (none failed).
    let ran = derived_current(&mut conn, Some(&TimeZone::UTC), 0);
    assert_eq!(ran.len(), DERIVED.len(), "{ran:?}");
    let check: String = conn
        .query_row("PRAGMA integrity_check", [], |r| r.get(0))
        .unwrap();
    assert_eq!(check, "ok");
    let fks: i64 = conn
        .query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(fks, 0, "no dangling rows after the upgrade");
}

#[test]
fn photo_total_cap_refuses_the_one_over() {
    let mut conn = memory();
    let me = ProfileId(1);
    let at = |uid: &str| crate::model::PhotoInput {
        day: "2026-10-06".into(),
        group: "Eaten".into(),
        uid: Some(uid.into()),
    };
    let jpeg = crate::model::PhotoMime::Jpeg;
    photo_insert(&mut conn, me, &at("photo-0001"), jpeg, &[1; 600], 1000).unwrap();
    let err = photo_insert(&mut conn, me, &at("photo-0002"), jpeg, &[1; 600], 1000).unwrap_err();
    assert!(
        matches!(
            &err,
            Error::Conflict {
                kind: Conflict::PhotoStorageFull,
                ..
            }
        ),
        "{err}"
    );
    // A retry of one stored is no new photo; what's left still fits, up
    // to the byte.
    photo_insert(&mut conn, me, &at("photo-0001"), jpeg, &[1; 600], 1000).unwrap();
    photo_insert(&mut conn, me, &at("photo-0003"), jpeg, &[1; 400], 1000).unwrap();
    assert_eq!(photo_list(&conn, me, "2026-10-06").unwrap().len(), 2);
    // Full: the next byte is refused, a retry still answers.
    assert!(photo_insert(&mut conn, me, &at("photo-0004"), jpeg, &[1; 1], 1000).is_err());
    photo_insert(&mut conn, me, &at("photo-0003"), jpeg, &[1; 400], 1000).unwrap();
}

/// A hook stored with an event there no longer is (`workout_saved`) reads
/// without it, and its last call with that event as none.
#[test]
fn a_stored_hook_drops_events_there_no_longer_are() {
    let conn = upgraded(
        at_version(50),
        "INSERT INTO hook (profile_id, kind, url, webhook_id, events, last_result)
         VALUES (1, 'home-assistant', 'http://ha.lan:8123', 'kaloriina',
                 '[\"workout_saved\",\"workout_started\"]',
                 '{\"event\":\"workout_saved\",\"at\":1,\"ok\":true,\"status\":200,\"error\":null}');",
    );
    let hook = hook_get(&conn, ME).unwrap().unwrap();
    assert_eq!(hook.events, [crate::model::HookEvent::WorkoutStarted]);
    assert_eq!(hook.last_result, None);
    assert_eq!(
        hook_target(&conn, ME).unwrap().unwrap().events,
        [crate::model::HookEvent::WorkoutStarted]
    );
}

/// Migration 51: photos lose `entry_id` (and WebP ones go), hooks lose
/// `kind`; what's kept reads as before.
#[test]
fn migration_51_drops_photo_entries_webp_and_hook_kinds() {
    let conn = upgraded(
        at_version(50),
        "INSERT INTO photo (id, profile_id, uid, day, grp, entry_id, taken_at, mime, bytes)
         VALUES (1, 1, 'v50-jpeg', '2026-10-06', 'Eaten', 1, 5, 'image/jpeg', x'FFD8'),
                (2, 1, 'v50-webp', '2026-10-06', 'Eaten', NULL, 6, 'image/webp', x'5249');
         INSERT INTO hook (profile_id, kind, url, webhook_id, events)
         VALUES (1, 'home-assistant', 'http://ha.lan:8123', 'kaloriina', '[\"workout_finished\"]');",
    );
    let photos = photo_list(&conn, ME, "2026-10-06").unwrap();
    assert_eq!(
        photos
            .iter()
            .map(|p| (p.uid.as_str(), p.size))
            .collect::<Vec<_>>(),
        [("v50-jpeg", 2)]
    );
    assert_eq!(
        photo_bytes(&conn, ME, "v50-jpeg").unwrap().unwrap().1,
        [0xFF, 0xD8]
    );
    assert!(conn.prepare("SELECT entry_id FROM photo").is_err());
    assert!(
        conn.execute(
            "INSERT INTO photo (profile_id, day, grp, taken_at, mime, bytes)
             VALUES (1, '2026-10-06', 'Eaten', 7, 'image/webp', x'00')",
            [],
        )
        .is_err(),
        "JPEG only"
    );
    let target = hook_target(&conn, ME).unwrap().unwrap();
    assert_eq!(
        (
            target.url.as_str(),
            target.webhook_id.as_str(),
            target.events
        ),
        (
            "http://ha.lan:8123",
            "kaloriina",
            vec![crate::model::HookEvent::WorkoutFinished]
        )
    );
    assert!(conn.prepare("SELECT kind FROM hook").is_err());
    // Both still go with their profile.
    conn.execute("DELETE FROM profile WHERE id = 1", [])
        .unwrap();
    let left: i64 = conn
        .query_row(
            "SELECT (SELECT count(*) FROM photo) + (SELECT count(*) FROM hook)",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(left, 0);
}

/// Migration 53: the eaten group is `Eaten` in every table naming a group,
/// and an amount text keeps no "≈" (the entry's `weight_estimated` says it).
#[test]
fn migration_53_renames_consumed() {
    let conn = upgraded(
        at_version(52),
        "INSERT INTO entry (profile_id, day, grp, name, grams, amount, uid)
         VALUES (1, '2026-10-06', 'Consumed', 'Burger', 420, '2 × Burger (≈420 g)', 'v52-own');
         INSERT INTO entry (profile_id, day, grp, name, amount, imported, src_grp, uid)
         VALUES (1, '2026-10-06', 'Consumed', 'Pizza', '≈1 slice', 1, 'Consumed', 'v52-imp'),
                (1, '2026-10-06', 'Dinner', 'Soup', '1 bowl', 1, 'Dinner', 'v52-din');
         INSERT INTO day_total (profile_id, day, grp, nutrients)
         VALUES (1, '2026-10-06', 'Consumed', '{\"energy\":300}');
         INSERT INTO photo (profile_id, uid, day, grp, taken_at, mime, bytes)
         VALUES (1, 'v52-photo', '2026-10-06', 'Consumed', 5, 'image/jpeg', x'FFD8');",
    );
    let rows: Vec<(String, Option<String>, String)> = conn
        .prepare("SELECT grp, src_grp, amount FROM entry ORDER BY id")
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    let row =
        |g: &str, s: Option<&str>, a: &str| (g.to_owned(), s.map(str::to_owned), a.to_owned());
    assert_eq!(
        rows,
        [
            row("Eaten", None, "2 × Burger (420 g)"),
            row("Eaten", Some("Eaten"), "≈1 slice"),
            row("Dinner", Some("Dinner"), "1 bowl"),
        ],
        "an imported row keeps its export's text"
    );
    let left: i64 = conn
        .query_row(
            "SELECT (SELECT count(*) FROM day_total WHERE grp = 'Consumed')
                  + (SELECT count(*) FROM photo WHERE grp = 'Consumed')",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(left, 0);
    assert_eq!(
        photo_list(&conn, ME, "2026-10-06").unwrap()[0].group,
        "Eaten"
    );
}

/// Migration 54: `entry.imported` goes; "imported" is `src_grp` set. A v53
/// row flagged imported reads back as history (its group kept, or its own
/// group when it had none), an own row as your own.
#[test]
fn migration_54_drops_entry_imported() {
    let conn = upgraded(
        at_version(53),
        "INSERT INTO food (id, name, source, per100) VALUES (500, 'Oats', 'custom', '{\"energy\":380.0}');
         INSERT INTO entry (id, profile_id, day, grp, food_id, name, grams, amount, nutrients, uid)
         VALUES (1, 1, '2026-10-06', 'Eaten', 500, 'Oats', 50, '50 g', '{\"energy\":190.0}', 'v53-own');
         INSERT INTO entry (id, profile_id, day, grp, name, amount, imported, src_grp, uid)
         VALUES (2, 1, '2026-10-06', 'Planned', 'Soup', '1 bowl', 1, 'Dinner', 'v53-imp'),
                (3, 1, '2026-10-06', 'Lunch', 'Bread', '1 slice', 1, NULL, 'v53-gap'),
                (4, 1, '2026-10-06', 'Eaten', 'Odd', '1', 0, 'Eaten', 'v53-odd');",
    );
    let has_column: bool = conn
        .query_row(
            "SELECT count(*) > 0 FROM pragma_table_info('entry') WHERE name = 'imported'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(!has_column);
    let src = |id| entry_get(&conn, ME, id).unwrap().unwrap().src_group;
    assert_eq!(
        [src(1), src(2), src(3), src(4)],
        [None, Some("Dinner".into()), Some("Lunch".into()), None]
    );
    let fk: i64 = conn
        .query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(fk, 0);
}

fn fk_violations(conn: &Connection) -> i64 {
    conn.query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| {
        r.get(0)
    })
    .unwrap()
}

/// Migration 55: a nap's time asleep. Stored naps don't know it (`None`),
/// except a hand-logged one, asleep throughout; it is never negative.
#[test]
fn migration_55_adds_nap_asleep_min() {
    let conn = upgraded(
        at_version(54),
        "INSERT INTO nap (profile_id, day, start_at, end_at, source, source_key)
         VALUES (1, '2026-10-05', '2026-10-05T12:00:00Z', '2026-10-05T12:30:00Z', 'manual', NULL),
                (1, '2026-10-06', '2026-10-06T13:00:00Z', '2026-10-06T13:40:00Z',
                 'health_connect', 'n-1');",
    );
    let naps: Vec<(NapSource, i64, Option<i64>)> = nap_list(&conn, ME, None, None)
        .unwrap()
        .into_iter()
        .map(|n| (n.source, n.in_bed_min, n.asleep_min))
        .collect();
    assert_eq!(
        naps,
        [
            (NapSource::Hand, 30, Some(30)),
            (NapSource::HealthConnect, 40, None)
        ]
    );
    let negative = conn.execute("UPDATE nap SET asleep_min = -1", []);
    assert!(negative.is_err(), "{negative:?}");
}

/// Migration 56: one provenance vocabulary and a recipe as a food kind.
/// Old words are rewritten, the rebuilt tables' CHECKs refuse them, rows
/// keep their ids, references and AUTOINCREMENT counters.
#[test]
fn migration_56_unifies_sources() {
    let conn = upgraded(
        at_version(55),
        "INSERT INTO weight (profile_id, day, kg, source) VALUES (1, '2026-10-01', 80, 'manual'),
                (1, '2026-10-02', 79.5, 'openscale');
         INSERT INTO workout_session (id, profile_id, day, name, minutes, sets, uid, type,
                                      source, source_key, kcal, kcal_source)
         VALUES (1, 1, '2026-10-01', 'Gym', 60, '[]', 'v55-gym', 'workout', 'manual', NULL,
                 300, 'hand'),
                (2, 1, '2026-10-02', 'Run', 40, '[]', 'v55-run', 'run', 'health_connect', 'hc-1',
                 400, 'device'),
                (3, 1, '2026-10-03', 'Walk', 30, '[]', 'v55-walk', 'walk', 'google_health', 'gh-1',
                 NULL, NULL),
                (4, 1, '2026-10-04', 'Gone', 10, '[]', 'v55-gone', 'walk', 'manual', NULL,
                 NULL, NULL);
         DELETE FROM workout_session WHERE id = 4;
         INSERT INTO nap (profile_id, day, start_at, end_at, source)
         VALUES (1, '2026-10-05', '2026-10-05T12:00:00Z', '2026-10-05T12:30:00Z', 'manual');
         INSERT INTO food (id, name, source, per100) VALUES
                (700, 'Oats', 'custom', '{\"energy\":380.0}'),
                (701, 'Porridge', 'recipe', '{\"energy\":380.0}'),
                (702, 'Gone', 'custom', '{}');
         DELETE FROM food WHERE id = 702;
         INSERT INTO recipe_item (recipe_id, food_id, grams) VALUES (701, 700, 100);
         INSERT INTO entry (profile_id, day, grp, food_id, name, grams, amount, nutrients, uid)
         VALUES (1, '2026-10-06', 'Eaten', 701, 'Porridge', 100, '100 g',
                 '{\"energy\":380.0}', 'v55-porridge');",
    );
    let words = |sql: &str| -> Vec<String> {
        conn.prepare(sql)
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap()
    };
    assert_eq!(
        words("SELECT source FROM weight ORDER BY day"),
        ["hand", "openscale"]
    );
    assert_eq!(
        words("SELECT source || '/' || coalesce(kcal_source, '-') FROM activity ORDER BY id"),
        ["hand/hand", "health_connect/health_connect", "import/-"]
    );
    assert_eq!(words("SELECT source FROM nap"), ["hand"]);
    assert_eq!(
        words("SELECT source || '/' || kind FROM food WHERE id >= 700 ORDER BY id"),
        ["custom/food", "custom/recipe"]
    );
    // The CHECKs speak the new words only.
    for bad in [
        "INSERT INTO weight (profile_id, day, kg, source) VALUES (1, '2026-10-09', 80, 'manual')",
        "INSERT INTO activity (profile_id, day, name, minutes, type, source)
         VALUES (1, '2026-10-09', 'X', 1, 'walk', 'manual')",
        "INSERT INTO activity (profile_id, day, name, minutes, type, source)
         VALUES (1, '2026-10-09', 'X', 1, 'walk', 'google_health')",
        "INSERT INTO food (name, source) VALUES ('X', 'recipe')",
        "INSERT INTO food (name, source, kind) VALUES ('X', 'custom', 'meal')",
    ] {
        assert!(conn.execute(bad, []).is_err(), "{bad}");
    }
    // Ids and references kept; a deleted id is never handed out again.
    assert_eq!(fk_violations(&conn), 0);
    let porridge = food_get(&conn, 701).unwrap().unwrap();
    assert_eq!(porridge.kind, FoodKind::Recipe);
    conn.execute(
        "INSERT INTO activity (profile_id, day, name, minutes, type)
         VALUES (1, '2026-10-09', 'New', 5, 'walk')",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO food (name, source) VALUES ('New', 'custom')",
        [],
    )
    .unwrap();
    let next = |t: &str| -> i64 {
        conn.query_row(&format!("SELECT max(id) FROM {t}"), [], |r| r.get(0))
            .unwrap()
    };
    assert_eq!((next("activity"), next("food")), (5, 703));
}

/// Migration 58: before it, a food or entry without
/// fibre got its other carbohydrate as an equal copy (fibre taken as 0).
/// The copy of the total goes (unknown, "–"); carbohydrate stays; values
/// with fibre or sent apart are kept; recipes are recomputed.
#[test]
fn migration_58_drops_the_total_carbs_copied_without_fibre() {
    let conn = upgraded(
        at_version(57),
        r#"INSERT INTO food (id, name, source, kind, per100) VALUES
                (800, 'Riisipiirakka', 'custom', 'food', '{"energy":200,"carbs":34,"net_carbs":34}'),
                (801, 'Bread', 'custom', 'food', '{"energy":250,"carbs":40,"fiber":5,"net_carbs":35}'),
                (802, 'Bar', 'custom', 'food', '{"energy":400,"carbs":50,"net_carbs":45}'),
                (803, 'Pie meal', 'custom', 'recipe', '{"energy":200,"carbs":34,"net_carbs":34}');
           INSERT INTO recipe_item (recipe_id, food_id, grams) VALUES (803, 800, 100);
           INSERT INTO entry (id, profile_id, day, grp, food_id, name, grams, amount, nutrients, uid)
           VALUES (1, 1, '2026-10-06', 'Eaten', 800, 'Riisipiirakka', 50, '50 g',
                   '{"energy":100,"carbs":17,"net_carbs":17}', 'v57-pie'),
                  (2, 1, '2026-10-06', 'Eaten', 801, 'Bread', 100, '100 g',
                   '{"energy":250,"carbs":40,"fiber":5,"net_carbs":35}', 'v57-bread');"#,
    );
    let carbs = |id| {
        let p = food_get(&conn, id).unwrap().unwrap().per100;
        (p.get("net_carbs"), p.get("carbs"))
    };
    assert_eq!(carbs(800), (Some(34.0), None));
    assert_eq!(carbs(801), (Some(35.0), Some(40.0)));
    assert_eq!(carbs(802), (Some(45.0), Some(50.0)));
    assert_eq!(carbs(803), (Some(34.0), None), "recipe recomputed");
    let entry = |id| {
        let n = entry_get(&conn, ME, id)
            .unwrap()
            .unwrap()
            .nutrients
            .unwrap();
        (n.get("net_carbs"), n.get("carbs"))
    };
    assert_eq!(entry(1), (Some(17.0), None));
    assert_eq!(entry(2), (Some(35.0), Some(40.0)));
}

/// Foods gain their drink flag and their stored labels. (The entry
/// columns 61 added went in 66.)
#[test]
fn migration_food_labels() {
    let conn = upgraded(
        at_version(58),
        r#"INSERT INTO food (id, name, source, kind, per100, category, fineli_class) VALUES
                (900, 'Cola', 'custom', 'food', '{"energy":48,"sugars":12,"caffeine":10}',
                 'sugary_drinks', NULL),
                (901, 'Maito, kevyt', 'fineli', 'food',
                 '{"energy":46,"water":89,"protein":3.4,"fat":1.5}', NULL, 'MILKLF'),
                (902, 'Crisps', 'custom', 'food', '{"energy":530,"fat":33}', NULL, NULL);
           INSERT INTO entry (id, profile_id, day, grp, food_id, name, grams, amount, nutrients, uid)
           VALUES (1, 1, '2026-10-06', 'Eaten', 900, 'Cola', 330, '330 g',
                   '{"energy":158.4,"caffeine":33}', 'v58-cola');"#,
    );
    let food = |id| food_get(&conn, id).unwrap().unwrap();
    let labels = |f: &Food| f.labels.keys().map(str::to_owned).collect::<Vec<_>>();
    let cola = food(900);
    assert!(cola.drink);
    // Its sugars and energy alone prove Unhealthy (label rules 3).
    assert_eq!(
        labels(&cola),
        ["unhealthy", "high_sugars", "why_sugars", "why_energy"]
    );
    let milk = food(901);
    assert!(milk.drink);
    // Saturates, sugars and salt not given: no verdict (label rules 2).
    assert_eq!(labels(&milk), ["high_protein", "low_fat"]);
    let crisps = food(902);
    assert!(!crisps.drink);
    let stored: Vec<(i64, String)> = conn
        .prepare(
            "SELECT food_id, label FROM food_label WHERE food_id >= 900 ORDER BY food_id, label",
        )
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert_eq!(
        stored,
        [
            (900, "high_sugars".into()),
            (900, "unhealthy".into()),
            (900, "why_energy".into()),
            (900, "why_sugars".into()),
            (901, "high_protein".into()),
            (901, "low_fat".into()),
            // Crisps' fat alone scores nothing (label rules 3).
            (902, "high_fat".into()),
        ]
    );
}

/// Migration 63: soft drinks of your own, served
/// "250 ml" with no category or water value, were no drinks and hydrated
/// nothing. A volume serving makes a drink that hydrates, unless set by
/// hand; a bare "dl" (Fineli flour) or a cup doesn't.
#[test]
fn migration_63_makes_a_volume_serving_a_drink() {
    let conn = upgraded(
        at_version(62),
        r#"INSERT INTO food (id, name, source, kind, per100, drink, drink_set, hydrates,
                             hydrates_set) VALUES
                (950, 'Pepsi Max', 'custom', 'food', '{"energy":0.4,"net_carbs":0}', 0, 0, 0, 0),
                (951, 'OSHEE Zero', 'custom', 'food', '{"energy":2}', 0, 0, 0, 0),
                (952, 'Flour', 'fineli', 'food', '{"energy":340}', 0, 0, 0, 0),
                (953, 'Not a drink', 'custom', 'food', '{"energy":5}', 0, 1, 0, 0),
                (954, 'Kept dry', 'custom', 'food', '{"energy":5}', 0, 0, 0, 1),
                (955, 'Rice', 'custom', 'food', '{"energy":350}', 0, 0, 0, 0);
           INSERT INTO serving (food_id, label, grams) VALUES
                (950, '250 ml', 250), (951, '0.5 l', 500), (952, 'dl', 60),
                (953, '33 cl', 330), (954, '1 dl', 100), (955, '1 cup', 180);"#,
    );
    let drink = |id| food_get(&conn, id).unwrap().unwrap().drink;
    assert!(drink(950));
    assert!(drink(951));
    assert!(!drink(952), "a bare unit");
    assert!(!drink(953), "set by hand: no drink");
    assert!(drink(954));
    assert!(!drink(955));
}

/// Migration 65 (ADR 0020 rework): `hydrates` is gone, and drinks
/// are derived by the wider rule: a bottle's or can's label and a
/// cocktail are drinks; a gravy's decilitre isn't, though 63 made it one.
#[test]
fn migration_65_drops_hydrates_and_derives_drinks_again() {
    let conn = upgraded(
        at_version(64),
        r#"INSERT INTO food (id, name, source, kind, per100, drink, drink_set, hydrates,
                             hydrates_set) VALUES
                (960, 'Grand Cru 6,0%', 'custom', 'food', '{"energy":40}', 0, 0, 0, 0),
                (961, 'Ruskeakastike', 'custom', 'food', '{"energy":40}', 1, 0, 1, 0),
                (962, 'Moscow mule', 'custom', 'food', '{"energy":90}', 0, 0, 0, 0),
                (963, 'Mine', 'custom', 'food', '{"energy":40}', 1, 1, 1, 1);
           INSERT INTO serving (food_id, label, grams) VALUES
                (960, '0,33 l bottle', 330), (961, '1 dl', 100), (962, '1 cocktail', 225),
                (963, '1 dl', 100);"#,
    );
    let drink = |id| food_get(&conn, id).unwrap().unwrap().drink;
    assert!(drink(960));
    assert!(!drink(961), "a gravy's decilitre");
    assert!(drink(962));
    assert!(drink(963), "set by hand");
    let gone: i64 = conn
        .query_row(
            "SELECT count(*) FROM pragma_table_info('food') WHERE name LIKE 'hydrates%'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(gone, 0);
}

/// An imported day with both a `Consumed` and an `Eaten` total (a
/// Cronometer group of that name) still migrates: both stay.
#[test]
fn migration_53_merges_a_day_with_both_totals() {
    // A Cronometer group named `Eaten` beside `Consumed`: their rows are
    // one group now, so their totals are one total (summed), removable
    // with the group.
    let mut conn = upgraded(
        at_version(52),
        "INSERT INTO day_total (profile_id, day, grp, nutrients)
         VALUES (1, '2026-10-06', 'Consumed', '{\"energy\":300,\"protein\":10}'),
                (1, '2026-10-06', 'Eaten', '{\"energy\":200,\"fat\":5}');",
    );
    let totals: Vec<(String, String)> = conn
        .prepare("SELECT grp, nutrients FROM day_total")
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert_eq!(totals.len(), 1, "{totals:?}");
    assert_eq!(totals[0].0, "Eaten");
    let n: serde_json::Value = serde_json::from_str(&totals[0].1).unwrap();
    assert_eq!(
        n,
        serde_json::json!({ "energy": 500, "protein": 10, "fat": 5 })
    );
    imported_group_delete(&mut conn, ME, "2026-10-06", "Eaten").unwrap();
    let n: i64 = conn
        .query_row("SELECT count(*) FROM day_total", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 0);
}

// ---------------------------------------------------- the health store

/// Migration 50 takes the import's copies out of `activity_day`: what
/// shows is the same before and after, the copies are gone.
#[test]
fn migration_50_unmerges_losslessly() {
    type DayRow = (String, Option<i64>, Option<i64>, Option<i64>);
    let mut conn = at_version(40);
    conn.execute_batch(include_str!("../../tests/fixtures/v40.sql"))
        .unwrap();
    for (v, sql) in (41..50).zip(&MIGRATIONS[40..49]) {
        conn.execute_batch(sql).unwrap();
        conn.pragma_update(None, "user_version", v).unwrap();
    }
    // Read as the table is named then (`device_day` since the rename).
    let rows = |conn: &Connection, table: &str| -> Vec<DayRow> {
        conn.prepare(&format!(
            "SELECT day, active_kcal, steps, in_bed_min FROM {table} ORDER BY day"
        ))
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
    };
    // What shows at v49 is the row itself (the copies merged in); read
    // raw, as today's `device_day_list` reads columns v49 lacks.
    let before = rows(&conn, "activity_day");
    assert_eq!(before.len(), 3);
    migrate(&mut conn).unwrap();
    let shown: Vec<DayRow> = device_day_list(&conn, ME, None, None)
        .unwrap()
        .days
        .into_iter()
        .map(|d| (d.day.day, d.day.active_kcal, d.day.steps, d.day.in_bed_min))
        .collect();
    assert_eq!(shown, before, "what shows is the same");
    assert_eq!(
        rows(&conn, "device_day"),
        [
            ("2026-10-02".into(), Some(512), Some(9120), Some(475)),
            ("2026-10-04".into(), None, Some(7000), None),
        ],
        "the device's values only"
    );
    // The records outcome column; visceral fat is gone.
    conn.execute(
        "INSERT INTO sync_state (profile_id, source, records_result) VALUES (1, 'x', '{}')",
        [],
    )
    .unwrap();
    assert!(
        conn.execute(
            "INSERT INTO sync_state (profile_id, source, records_result) VALUES (1, 'y', '{')",
            [],
        )
        .is_err()
    );
    assert!(
        conn.prepare("SELECT visceral_fat FROM scale_reading")
            .is_err()
    );
}

fn gh_day(day: &str, set: impl FnOnce(&mut DeviceDay)) -> DeviceDay {
    let mut d = DeviceDay {
        day: day.into(),
        ..DeviceDay::default()
    };
    set(&mut d);
    d
}

fn night(d: &mut DeviceDay, bedtime: &str) {
    d.in_bed_min = Some(480);
    d.asleep_min = Some(450);
    d.bedtime = Some(bedtime.into());
    d.wake_time = Some("07:00".into());
}

fn fill(conn: &mut Connection, days: &[DeviceDay]) -> crate::model::ImportCounts {
    device_fill(conn, ME, days, &[], &[], &[], 0).unwrap()
}

fn sync_post(from: &str, to: &str) -> HealthPost {
    HealthPost {
        from: from.into(),
        to: to.into(),
        device: Some("Pixel 9".into()),
        days: Vec::new(),
        sessions: Vec::new(),
        body: Vec::new(),
        read: BTreeMap::new(),
        skipped: 0,
    }
}

/// Health Connect's sleep session `id` over `start`–`end` (UTC) in
/// `offset`, with `stages` (start, end, Health Connect's type), kept raw as
/// the phone posts it: the nights of its days follow.
fn hc_sleep(
    conn: &mut Connection,
    id: &str,
    (start, end): (&str, &str),
    offset: &str,
    stages: &[(&str, &str, i64)],
) {
    let stages: Vec<serde_json::Value> = stages
        .iter()
        .map(|(a, b, t)| serde_json::json!({ "start_time": a, "end_time": b, "type": t }))
        .collect();
    let data = serde_json::json!({ "start_time": start, "start_zone_offset": offset,
        "end_time": end, "end_zone_offset": offset, "stages": stages });
    let post = RecordsPost::read(
        &serde_json::json!({ "records": [{ "kind": "SleepSession", "id": id, "start": start,
                                           "end": end, "data": data }] }),
        &TimeZone::UTC,
    )
    .unwrap();
    records_put(conn, ME, &post, 1, &TimeZone::UTC).unwrap();
}

fn shown(conn: &Connection, day: &str) -> DeviceDay {
    device_day_list(conn, ME, Some(day), Some(day))
        .unwrap()
        .days[0]
        .day
        .clone()
}

#[test]
fn import_parts_merge_per_column() {
    let mut conn = memory();
    fill(
        &mut conn,
        &[gh_day("2026-10-05", |d| {
            d.steps = Some(5000);
            d.avg_hr = Some(70);
        })],
    );
    // A second part of the same export: the night, with its heart rate.
    fill(
        &mut conn,
        &[gh_day("2026-10-05", |d| {
            night(d, "23:00");
            d.sleep_avg_hr = Some(52);
        })],
    );
    // The same night again without heart rate (the browser's first batch).
    fill(&mut conn, &[gh_day("2026-10-05", |d| night(d, "23:00"))]);
    let d = &device::import_list(&conn, ME).unwrap()[0];
    assert_eq!(
        (d.steps, d.avg_hr, d.in_bed_min, d.sleep_avg_hr),
        (Some(5000), Some(70), Some(480), Some(52))
    );
    // A newer version of the night replaces it whole.
    fill(&mut conn, &[gh_day("2026-10-05", |d| night(d, "23:05"))]);
    let d = &device::import_list(&conn, ME).unwrap()[0];
    assert_eq!(
        (d.steps, d.bedtime.as_deref(), d.sleep_avg_hr),
        (Some(5000), Some("23:05"), None)
    );
}

#[test]
fn import_corrected_values_show() {
    let mut conn = memory();
    let counts = fill(
        &mut conn,
        &[gh_day("2026-10-05", |d| {
            d.steps = Some(5000);
            night(d, "23:00");
        })],
    );
    assert_eq!((counts.days, counts.nights), (1, 1));
    // The device has the day's energy, no steps.
    let mut post = sync_post("2026-10-05", "2026-10-05");
    post.days = vec![gh_day("2026-10-05", |d| d.active_kcal = Some(400))];
    device_replace(&mut conn, ME, &post, 1, &TimeZone::UTC).unwrap();
    assert_eq!(
        (
            shown(&conn, "2026-10-05").steps,
            shown(&conn, "2026-10-05").active_kcal
        ),
        (Some(5000), Some(400))
    );
    // A corrected export: its steps show.
    let counts = fill(&mut conn, &[gh_day("2026-10-05", |d| d.steps = Some(5200))]);
    assert_eq!((counts.days, counts.nights), (1, 0));
    assert_eq!(shown(&conn, "2026-10-05").steps, Some(5200));
    // Again: nothing changes.
    let counts = fill(&mut conn, &[gh_day("2026-10-05", |d| d.steps = Some(5200))]);
    assert_eq!((counts.days, counts.nights), (0, 0));
    // The device's own value beats it.
    post.days = vec![gh_day("2026-10-05", |d| d.steps = Some(6000))];
    device_replace(&mut conn, ME, &post, 2, &TimeZone::UTC).unwrap();
    assert_eq!(shown(&conn, "2026-10-05").steps, Some(6000));
    // The export carries the device's values only.
    let file = profile_export(&conn, ME).unwrap();
    assert_eq!(
        (file.device_days[0].steps, file.device_days[0].in_bed_min),
        (Some(6000), None)
    );
}

#[test]
fn import_newer_night_replaces_its_stages() {
    let mut conn = memory();
    let span = |start: &str, end: &str| SleepStage {
        day: "2026-10-06".into(),
        start_at: start.into(),
        end_at: end.into(),
        stage: SleepStageKind::Light,
        source: StageSource::Import,
    };
    let day = gh_day("2026-10-06", |d| night(d, "00:00"));
    device_fill(
        &mut conn,
        ME,
        std::slice::from_ref(&day),
        &[],
        &[],
        &[
            span("2026-10-05T21:00:00Z", "2026-10-05T23:00:00Z"),
            span("2026-10-05T23:00:00Z", "2026-10-06T05:00:00Z"),
        ],
        0,
    )
    .unwrap();
    device_fill(
        &mut conn,
        ME,
        &[gh_day("2026-10-06", |d| night(d, "00:05"))],
        &[],
        &[],
        &[
            span("2026-10-05T21:05:00Z", "2026-10-05T23:00:00Z"),
            span("2026-10-05T23:00:00Z", "2026-10-06T05:00:00Z"),
        ],
        0,
    )
    .unwrap();
    let starts: Vec<String> = day_stages(&conn, ME, "2026-10-06")
        .unwrap()
        .into_iter()
        .map(|s| s.start_at)
        .collect();
    assert_eq!(starts, ["2026-10-05T21:05:00Z", "2026-10-05T23:00:00Z"]);
    // A device night with no spans of its own shows none of the import's.
    hc_sleep(
        &mut conn,
        "s-1",
        ("2026-10-05T23:30:00Z", "2026-10-06T07:00:00Z"),
        "Z",
        &[],
    );
    let post = sync_post("2026-10-06", "2026-10-06");
    device_replace(&mut conn, ME, &post, 1, &TimeZone::UTC).unwrap();
    assert_eq!(shown(&conn, "2026-10-06").bedtime.as_deref(), Some("23:30"));
    assert_eq!(day_stages(&conn, ME, "2026-10-06").unwrap(), []);
}

/// The day's weight is the first reading after the night's wake time,
/// not one taken before that night's sleep; a sync's night moves it.
#[test]
fn the_days_weight_is_the_morning_reading() {
    let mut conn = memory();
    let tz = TimeZone::get("Europe/Helsinki").unwrap();
    // Jul 10: 78.6 kg at 00:26, 77.35 kg at 10:00 (UTC+3).
    for (at, kg) in [(1_783_632_360_000_i64, 78.6), (1_783_666_800_000, 77.35)] {
        conn.execute(
            "INSERT INTO scale_reading (profile_id, source, source_user, taken_at, day, weight)
             VALUES (1, 'openscale', 1, ?, '2026-07-10', ?)",
            params![at, kg],
        )
        .unwrap();
    }
    day_weight_refresh(&conn, ME, "2026-07-10", 1, &tz).unwrap();
    assert_close!(weight_list(&conn, ME, None, None).unwrap()[0].kg, 77.35);
    // Woke at 10:30: both readings were before that night's end, so the
    // day has no morning weight.
    hc_sleep(
        &mut conn,
        "s-1",
        ("2026-07-09T23:30:00Z", "2026-07-10T07:30:00Z"),
        "+03:00",
        &[],
    );
    let post = sync_post("2026-07-10", "2026-07-10");
    device_replace(&mut conn, ME, &post, 2, &tz).unwrap();
    assert_eq!(weight_list(&conn, ME, None, None).unwrap(), []);
    let chosen: Vec<bool> = scale_shown(&conn, ME, None, None, &tz)
        .unwrap()
        .iter()
        .map(|r| r.chosen)
        .collect();
    assert_eq!(chosen, [false, false]);
}

/// A night with an awake tail reads cut: its wake time, time in bed and
/// spans end at the last sleep.
#[test]
fn a_synced_awake_tail_reads_cut() {
    let mut conn = memory();
    // 23:00–09:00 in bed (UTC+3), asleep to 06:30, then awake to 09:00.
    hc_sleep(
        &mut conn,
        "s-1",
        ("2026-10-05T20:00:00Z", "2026-10-06T06:00:00Z"),
        "+03:00",
        &[
            ("2026-10-05T20:00:00Z", "2026-10-06T03:30:00Z", 4),
            ("2026-10-06T03:30:00Z", "2026-10-06T06:00:00Z", 1),
        ],
    );
    let post = sync_post("2026-10-06", "2026-10-06");
    device_replace(&mut conn, ME, &post, 1, &TimeZone::UTC).unwrap();
    let d = shown(&conn, "2026-10-06");
    assert_eq!(
        (d.wake_time.as_deref(), d.in_bed_min, d.asleep_min),
        (Some("06:30"), Some(450), Some(450))
    );
    let ends: Vec<String> = day_stages(&conn, ME, "2026-10-06")
        .unwrap()
        .into_iter()
        .map(|s| s.end_at)
        .collect();
    assert_eq!(ends, ["2026-10-06T03:30:00Z"]);
}

fn nap_in(key: &str, day: &str, start: &str, end: &str) -> NapIn {
    NapIn {
        day: day.into(),
        key: key.into(),
        start_at: format!("{day}T{start}Z"),
        end_at: format!("{day}T{end}Z"),
        asleep_min: None,
    }
}

#[test]
fn imported_naps_are_capped_per_day() {
    let mut conn = memory();
    let naps: Vec<NapIn> = (0..NAPS_MAX + 2)
        .map(|i| {
            nap_in(
                &format!("gh-{i}"),
                "2026-10-05",
                &format!("{:02}:00:00", i % 24),
                &format!("{:02}:20:00", i % 24),
            )
        })
        .collect();
    let counts = device_fill(&mut conn, ME, &[], &[], &naps, &[], 0).unwrap();
    assert_eq!((counts.naps, counts.skipped), (NAPS_MAX as u64, 2));
    assert_eq!(nap_list(&conn, ME, None, None).unwrap().len(), NAPS_MAX);
}

#[test]
fn import_drops_distance_on_non_distance_types() {
    let mut conn = memory();
    let w = |key: &str, kind: ActivityType, start: &str| ImportedWorkout {
        key: key.into(),
        day: "2026-10-05".into(),
        start_at: format!("2026-10-05T{start}Z"),
        end_at: format!("2026-10-05T{start}Z").replace(":00:00Z", ":30:00Z"),
        kind,
        name: "x".into(),
        kcal: None,
        distance_m: Some(500),
    };
    device_fill(
        &mut conn,
        ME,
        &[],
        &[
            w("gh-1", ActivityType::Hiit, "07:00:00"),
            w("gh-2", ActivityType::Run, "17:00:00"),
        ],
        &[],
        &[],
        0,
    )
    .unwrap();
    let list = activity_list(&conn, ME, None, None, None).unwrap();
    assert_eq!(
        list.iter().map(|s| s.distance_m).collect::<Vec<_>>(),
        [None, Some(500)]
    );
}

fn raw_rec(id: &str) -> HealthRecord {
    HealthRecord {
        kind: "Weight".into(),
        id: id.into(),
        start_at: Some("2026-10-05T05:00:00Z".into()),
        end_at: None,
        day: Some("2026-10-05".into()),
        data: "{}".into(),
        truncated: false,
    }
}

fn raw_sources(conn: &Connection) -> Vec<String> {
    conn.prepare("SELECT DISTINCT source FROM health_record ORDER BY source")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
}

#[test]
fn remove_synced_data_erases_raw_records() {
    let mut conn = memory();
    let page = RecordsPost {
        records: vec![raw_rec("w-1")],
        skipped: 0,
        failed: 0,
    };
    records_put(&mut conn, ME, &page, 1, &TimeZone::UTC).unwrap();
    records_add(&mut conn, ME, "google_health", &[raw_rec("g-1")], 1).unwrap();
    records_add(&mut conn, ME, "openscale", &[raw_rec("o-1")], 1).unwrap();
    device_delete(&mut conn, ME, 2, &TimeZone::UTC).unwrap();
    assert_eq!(raw_sources(&conn), ["google_health", "openscale"]);
}

/// Health Connect's day, nap, stage, workout and raw record, and an
/// import's on the same and the next day.
fn device_and_import(conn: &mut Connection) {
    // The night of the 5th, deep 22:00–23:00, and a nap at noon.
    hc_sleep(
        conn,
        "s-1",
        ("2026-10-04T21:00:00Z", "2026-10-05T04:00:00Z"),
        "Z",
        &[("2026-10-04T22:00:00Z", "2026-10-04T23:00:00Z", 5)],
    );
    hc_sleep(
        conn,
        "n-1",
        ("2026-10-05T12:00:00Z", "2026-10-05T12:30:00Z"),
        "Z",
        &[],
    );
    let mut post = sync_post("2026-10-05", "2026-10-05");
    post.days = vec![gh_day("2026-10-05", |d| d.steps = Some(8000))];
    post.sessions = vec![DeviceSession {
        key: "hc-1".into(),
        day: "2026-10-05".into(),
        start_at: "2026-10-05T17:00:00Z".into(),
        end_at: "2026-10-05T17:45:00Z".into(),
        kind: 33,
        name: "Running".into(),
        kcal: Some(400),
        total_kcal: None,
        distance_m: None,
        recording_method: 1,
        avg_hr: None,
        max_hr: None,
    }];
    device_replace(conn, ME, &post, 1, &TimeZone::UTC).unwrap();
    let page = RecordsPost {
        records: vec![raw_rec("w-1")],
        skipped: 0,
        failed: 0,
    };
    records_put(conn, ME, &page, 1, &TimeZone::UTC).unwrap();
    device_fill(
        conn,
        ME,
        &[
            gh_day("2026-10-05", |d| d.active_kcal = Some(300)),
            gh_day("2026-10-06", |d| night(d, "23:00")),
        ],
        &[ImportedWorkout {
            key: "gh-1".into(),
            day: "2026-10-07".into(),
            start_at: "2026-10-07T07:00:00Z".into(),
            end_at: "2026-10-07T07:30:00Z".into(),
            kind: ActivityType::Walk,
            name: "Walk".into(),
            kcal: None,
            distance_m: None,
        }],
        &[
            nap_in("gh-n", "2026-10-06", "13:00:00", "13:30:00"),
            nap_in("gh-m", "2026-10-05", "12:10:00", "12:20:00"),
        ],
        &[SleepStage {
            day: "2026-10-06".into(),
            start_at: "2026-10-05T22:00:00Z".into(),
            end_at: "2026-10-05T23:00:00Z".into(),
            stage: SleepStageKind::Rem,
            source: StageSource::Import,
        }],
        0,
    )
    .unwrap();
    records_add(conn, ME, "google_health", &[raw_rec("g-1")], 1).unwrap();
}

#[test]
fn remove_import_leaves_device_data() {
    let mut conn = memory();
    device_and_import(&mut conn);
    assert_eq!(shown(&conn, "2026-10-05").active_kcal, Some(300));
    google_import_delete(&mut conn, ME).unwrap();
    let a = device_day_list(&conn, ME, None, None).unwrap();
    assert_eq!(
        a.days
            .iter()
            .map(|d| (d.day.day.as_str(), d.day.steps, d.day.active_kcal))
            .collect::<Vec<_>>(),
        [("2026-10-05", Some(8000), None)]
    );
    assert_eq!(a.sessions.len(), 1);
    assert!(device::import_list(&conn, ME).unwrap().is_empty());
    let naps = nap_list(&conn, ME, None, None).unwrap();
    assert_eq!(
        naps.iter().map(|n| n.source).collect::<Vec<_>>(),
        [NapSource::HealthConnect]
    );
    assert_eq!(
        sleep_stage_list(&conn, ME, None, None)
            .unwrap()
            .iter()
            .map(|s| s.source)
            .collect::<Vec<_>>(),
        [StageSource::HealthConnect]
    );
    let sessions = activity_list(&conn, ME, None, None, None).unwrap();
    assert_eq!(
        sessions
            .iter()
            .map(|s| s.source_key.as_deref())
            .collect::<Vec<_>>(),
        [Some("hc-1")]
    );
    assert_eq!(raw_sources(&conn), ["health_connect"]);
    // No tombstone: importing again brings the workout back.
    let tombs: i64 = conn
        .query_row("SELECT count(*) FROM workout_tombstone", [], |r| r.get(0))
        .unwrap();
    assert_eq!(tombs, 0);
}

#[test]
fn naps_show_by_precedence_and_are_never_deleted() {
    let mut conn = memory();
    device_and_import(&mut conn);
    // The device's 12:00–12:30 hides the import's 12:10–12:20.
    let shown: Vec<(String, NapSource)> = nap_list(&conn, ME, None, None)
        .unwrap()
        .into_iter()
        .map(|n| (n.day, n.source))
        .collect();
    assert_eq!(
        shown,
        [
            ("2026-10-05".into(), NapSource::HealthConnect),
            ("2026-10-06".into(), NapSource::Import)
        ]
    );
    let stored: i64 = conn
        .query_row("SELECT count(*) FROM nap", [], |r| r.get(0))
        .unwrap();
    assert_eq!(stored, 3);
    let file = profile_export(&conn, ME).unwrap();
    assert_eq!(file.naps.len(), 3, "every nap travels");
}

// --------------------------------------------------- import provenance

/// Migration 52 marks the sessions an import wrote as `google_health` (a
/// claimed or edited one stays `manual`, so removing the import keeps it),
/// and measures items whose serving is gone in grams.
#[test]
fn upgrade_from_v51_marks_imports_and_drops_stale_servings() {
    let mut conn = upgraded(
        at_version(51),
        r#"
INSERT INTO workout_session (id, profile_id, day, name, minutes, kcal, sets, uid, type,
                             start_at, source, source_key, rev, kcal_source)
VALUES (1, 1, '2026-10-01', 'Walk', 40, 120, '[]', 'v51-import', 'walk',
        '2026-10-01T07:00:00Z', 'manual', 'gh-1', 1, 'import'),
       (2, 1, '2026-10-02', 'Run', 30, 300, '[]', 'v51-claimed', 'run',
        '2026-10-02T17:00:00Z', 'manual', 'gh-2', 2, 'import'),
       (3, 1, '2026-10-03', 'Ride', 30, 250, '[]', 'v51-hand-kcal', 'cycling',
        '2026-10-03T17:00:00Z', 'manual', 'gh-3', 1, 'hand'),
       (4, 1, '2026-10-04', 'Gym', 50, NULL, '[{"exercise_id":1,"name":"Squat","reps":5}]',
        'v51-sets', 'workout', '2026-10-04T17:00:00Z', 'manual', 'gh-4', 1, NULL),
       (5, 1, '2026-10-05', 'Biking', 30, 200, '[]', 'v51-device', 'cycling',
        '2026-10-05T18:00:00Z', 'health_connect', 'hc-5', 1, 'device'),
       (6, 1, '2026-10-06', 'Swim', 20, NULL, '[]', 'v51-hand', 'swim',
        NULL, 'manual', NULL, 1, NULL),
       (7, 1, '2026-10-07', 'Gone', 10, NULL, '[]', 'v51-gone', 'walk',
        NULL, 'manual', NULL, 1, NULL);
DELETE FROM workout_session WHERE id = 7;
INSERT INTO food (id, name, source, per100)
VALUES (900, 'Oats', 'custom', '{"energy":380}'),
       (901, 'Porridge', 'recipe', '{"energy":100}');
INSERT INTO serving (food_id, label, grams) VALUES (900, 'cup', 80);
INSERT INTO recipe_item (recipe_id, food_id, grams, serving, quantity)
VALUES (901, 900, 80, 'cup', 1), (901, 900, 40, 'bowl', 1);
INSERT INTO meal (id, name) VALUES (50, 'Breakfast');
INSERT INTO meal_item (meal_id, food_id, grams, serving, quantity)
VALUES (50, 900, 160, 'cup', 2), (50, 900, 60, 'scoop', 2);
INSERT INTO daily_item (profile_id, food_id, grams, serving, quantity, start)
VALUES (1, 900, 80, 'cup', 1, '2026-10-01'), (1, 900, 30, 'spoon', 3, '2026-10-01');
"#,
    );
    let sources: Vec<(String, ActivitySource)> = activity_list(&conn, ME, None, None, None)
        .unwrap()
        .into_iter()
        .map(|s| (s.uid, s.source))
        .collect();
    assert_eq!(
        sources,
        [
            ("v51-import".into(), ActivitySource::Import),
            ("v51-claimed".into(), ActivitySource::Hand),
            ("v51-hand-kcal".into(), ActivitySource::Hand),
            ("v51-sets".into(), ActivitySource::Hand),
            ("v51-device".into(), ActivitySource::HealthConnect),
            ("v51-hand".into(), ActivitySource::Hand),
        ]
    );
    // Removing the import removes only what it wrote.
    google_import_delete(&mut conn, ME).unwrap();
    let left: Vec<(String, Option<String>)> = activity_list(&conn, ME, None, None, None)
        .unwrap()
        .into_iter()
        .map(|s| (s.uid, s.source_key))
        .collect();
    assert_eq!(
        left,
        [
            ("v51-claimed".into(), None),
            ("v51-hand-kcal".into(), None),
            ("v51-sets".into(), None),
            ("v51-device".into(), Some("hc-5".into())),
            ("v51-hand".into(), None),
        ]
    );
    v52_rebuilt(&conn);
    v52_servings(&conn);
}

/// Migration 52's rebuild: indexes and trigger carry over, a deleted id
/// stays used, the new source passes the CHECK and an unknown one doesn't.
fn v52_rebuilt(conn: &Connection) {
    conn.execute(
        "INSERT INTO activity (profile_id, day, name, minutes, type, source)
         VALUES (1, '2026-10-08', 'x', 1, 'walk', 'import')",
        [],
    )
    .unwrap();
    let (id, uid): (i64, String) = conn
        .query_row(
            "SELECT id, uid FROM activity WHERE day = '2026-10-08'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!((id, uid.len()), (8, 32));
    assert!(
        conn.execute("UPDATE activity SET source = 'elsewhere' WHERE id = 8", [],)
            .is_err()
    );
    let objects: i64 = conn
        .query_row(
            "SELECT count(*) FROM sqlite_master WHERE tbl_name = 'activity'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(objects, 5, "table, three indexes, uid trigger");
}

/// Migration 52's servings: the ones the food still has stay, gone ones
/// fall back to grams.
fn v52_servings(conn: &Connection) {
    let items = |table: &str| -> Vec<(f64, Option<String>, Option<f64>)> {
        conn.prepare(&format!(
            "SELECT grams, serving, quantity FROM {table} ORDER BY grams DESC"
        ))
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
    };
    assert_eq!(
        items("recipe_item"),
        [(80.0, Some("cup".into()), Some(1.0)), (40.0, None, None)]
    );
    assert_eq!(
        items("meal_item"),
        [(160.0, Some("cup".into()), Some(2.0)), (60.0, None, None)]
    );
    assert_eq!(
        items("daily_item"),
        [(80.0, Some("cup".into()), Some(1.0)), (30.0, None, None)]
    );
}

/// The version a migration leaves, found by its text: numbers move when
/// branches merge.
fn version_of(marker: &str) -> u32 {
    let i = MIGRATIONS.iter().position(|m| m.contains(marker)).unwrap();
    u32::try_from(i + 1).unwrap()
}

/// The names of the schema's objects of `kind` (table, index, trigger).
fn schema_names(conn: &Connection, kind: &str) -> Vec<String> {
    conn.prepare("SELECT name FROM sqlite_master WHERE type = ? ORDER BY name")
        .unwrap()
        .query_map([kind], |r| r.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
}

/// The activity rename: `workout_session` is `activity`,
/// `activity_session` is `device_session` and `activity_day` is
/// `device_day`. Rows, indexes, the uid trigger and the id counter carry
/// over under the new names.
#[test]
fn migration_activity_rename() {
    let conn = upgraded(
        at_version(version_of("RENAME TO activity;") - 1),
        "INSERT INTO workout_session (id, profile_id, day, name, minutes, sets, uid, type)
         VALUES (1, 1, '2026-10-01', 'Gym', 60, '[]', 'v-gym', 'workout'),
                (2, 1, '2026-10-02', 'Gone', 10, '[]', 'v-gone', 'walk');
         DELETE FROM workout_session WHERE id = 2;
         INSERT INTO activity_session (profile_id, source_key, day, start_at, end_at, type, name)
         VALUES (1, 'hc-1', '2026-10-01', '2026-10-01T17:00:00Z', '2026-10-01T17:30:00Z', 56,
                 'Run');
         INSERT INTO activity_day (profile_id, day, steps) VALUES (1, '2026-10-01', 9000);",
    );
    let tables = schema_names(&conn, "table");
    for gone in ["workout_session", "activity_session", "activity_day"] {
        assert!(!tables.contains(&gone.to_owned()), "{gone}");
    }
    let indexes = schema_names(&conn, "index");
    for name in [
        "activity_profile_day",
        "activity_uid",
        "activity_source_key",
        "device_session_day",
    ] {
        assert!(indexes.contains(&name.to_owned()), "{name}: {indexes:?}");
    }
    assert!(
        !indexes
            .iter()
            .any(|i| i.starts_with("workout_session") || i.starts_with("activity_session")),
        "{indexes:?}"
    );
    let triggers = schema_names(&conn, "trigger");
    assert!(
        triggers.contains(&"activity_uid".to_owned()),
        "{triggers:?}"
    );
    assert!(!triggers.iter().any(|t| t.starts_with("workout_session")));
    let one = |sql: &str| -> String { conn.query_row(sql, [], |r| r.get(0)).unwrap() };
    assert_eq!(one("SELECT group_concat(name) FROM activity"), "Gym");
    assert_eq!(one("SELECT name FROM device_session"), "Run");
    assert_eq!(one("SELECT CAST(steps AS TEXT) FROM device_day"), "9000");
    // A new row gets the next id (a deleted one is never reused) and a uid.
    conn.execute(
        "INSERT INTO activity (profile_id, day, name, minutes, type)
         VALUES (1, '2026-10-09', 'New', 5, 'walk')",
        [],
    )
    .unwrap();
    assert_eq!(
        one("SELECT CAST(id AS TEXT) || '/' || length(uid) FROM activity WHERE name = 'New'"),
        "3/32"
    );
    assert_eq!(fk_violations(&conn), 0);
}

/// Sets as rows: each set in an activity's JSON becomes an
/// `activity_set` row in order. A set of an exercise deleted since keeps
/// its name, with no exercise. The JSON column goes; the API still reads
/// the sets nested. Rows go with their activity; deleting an exercise
/// unlinks its sets and keeps their names.
#[test]
fn migration_activity_set() {
    let mut conn = upgraded(
        at_version(version_of("CREATE TABLE activity_set") - 1),
        r#"INSERT INTO exercise (id, name, measure) VALUES (900, 'Test curl', 'reps');
           INSERT INTO activity (id, profile_id, day, name, minutes, sets, uid, type) VALUES
             (1, 1, '2026-10-01', 'Gym', 60,
              '[{"exercise_id":900,"name":"Test curl","reps":8,"kg":10.5},
                {"exercise_id":901,"name":"Towel row","seconds":30,"side":"left"}]',
              'v-gym', 'workout'),
             (2, 1, '2026-10-02', 'Run', 30, '[]', 'v-run', 'run');"#,
    );
    let rows: Vec<(i64, i64, Option<i64>, String)> = conn
        .prepare("SELECT activity_id, idx, exercise_id, name FROM activity_set ORDER BY 1, 2")
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert_eq!(
        rows,
        [
            (1, 0, Some(900), "Test curl".to_owned()),
            (1, 1, None, "Towel row".to_owned())
        ]
    );
    assert!(conn.prepare("SELECT sets FROM activity").is_err());
    assert_eq!(fk_violations(&conn), 0);
    let set = |exercise_id, name: &str, reps, seconds, kg, side| ActivitySet {
        exercise_id,
        name: name.to_owned(),
        reps,
        seconds,
        kg,
        side,
    };
    assert_eq!(
        activity_get(&conn, ME, 1).unwrap().unwrap().sets,
        [
            set(Some(900), "Test curl", Some(8), None, Some(10.5), None),
            set(None, "Towel row", None, Some(30), None, Some(Side::Left)),
        ]
    );
    assert!(activity_get(&conn, ME, 2).unwrap().unwrap().sets.is_empty());
    exercise_delete(&mut conn, 900).unwrap();
    assert_eq!(
        activity_get(&conn, ME, 1).unwrap().unwrap().sets[0],
        set(None, "Test curl", Some(8), None, Some(10.5), None)
    );
    conn.execute("DELETE FROM activity WHERE id = 1", [])
        .unwrap();
    let left: i64 = conn
        .query_row("SELECT count(*) FROM activity_set", [], |r| r.get(0))
        .unwrap();
    assert_eq!(left, 0);
}

/// Epoch milliseconds of an RFC 3339 instant.
fn ms(at: &str) -> i64 {
    at.parse::<jiff::Timestamp>().unwrap().as_millisecond()
}

#[test]
fn stored_day_weights_are_picked_again_once_per_rule() {
    // Oct 10 kept 77.25 kg from 01:23, before that night's
    // 02:17 bedtime, over 76.2 kg at 11:26 after it; Oct 13's only
    // reading is from 00:58, before that night's sleep.
    let tz = TimeZone::get("Europe/Helsinki").unwrap();
    let mut conn = memory();
    conn.execute(
        "INSERT INTO scale_reading (profile_id, source, source_user, taken_at, day, weight)
         VALUES (1, 'openscale', 1, ?1, '2026-10-10', 77.25),
                (1, 'openscale', 1, ?2, '2026-10-10', 76.2),
                (1, 'openscale', 1, ?3, '2026-10-13', 77.9)",
        params![
            ms("2026-10-09T22:23:00Z"),
            ms("2026-10-10T08:26:00Z"),
            ms("2026-10-12T21:58:00Z")
        ],
    )
    .unwrap();
    conn.execute_batch(
        "INSERT INTO weight (profile_id, day, kg, source, set_at) VALUES
           (1, '2026-10-10', 77.25, 'openscale', 0),
           (1, '2026-10-13', 77.9, 'openscale', 0);
         INSERT INTO device_day (profile_id, day, in_bed_min, asleep_min, bedtime, wake_time)
         VALUES (1, '2026-10-10', 480, 450, '02:17', '10:17'),
                (1, '2026-10-13', 420, 400, '02:29', '09:29');",
    )
    .unwrap();
    assert_eq!(
        derived_current(&mut conn, Some(&tz), 5).get("weight_rule_version"),
        Some(&2)
    );
    let kept: Vec<(String, f64)> = weight_list(&conn, ME, None, None)
        .unwrap()
        .into_iter()
        .map(|w| (w.day, w.kg))
        .collect();
    assert_eq!(kept, [("2026-10-10".to_owned(), 76.2)]);
    // Once per rule version.
    assert!(derived_current(&mut conn, Some(&tz), 6).is_empty());
}

#[test]
fn stored_nights_are_made_again_from_raw_sleep_sessions() {
    // An early-night block (23:30–01:30) stored as a nap of Oct 14
    // beside its night (04:45–10:00); the raw sessions make one night.
    // Oct 12 has no raw sessions: left as it is.
    let tz = TimeZone::get("Europe/Helsinki").unwrap();
    let mut conn = memory();
    let session = |start: &str, end: &str, stages: &str| {
        format!(
            r#"{{"start_time":"{start}","start_zone_offset":"+03:00","end_time":"{end}","end_zone_offset":"+03:00","stages":[{stages}]}}"#
        )
    };
    conn.execute(
        "INSERT INTO health_record (profile_id, source, kind, record_id, day, data, received_at)
         VALUES (1, 'health_connect', 'SleepSession', 's1', '2026-10-13', ?1, 0),
                (1, 'health_connect', 'SleepSession', 's2', '2026-10-14', ?2, 0)",
        params![
            session(
                "2026-10-13T20:30:00Z",
                "2026-10-13T22:30:00Z",
                r#"{"start_time":"2026-10-13T20:30:00Z","end_time":"2026-10-13T22:30:00Z","type":4}"#
            ),
            session(
                "2026-10-14T01:45:00Z",
                "2026-10-14T07:00:00Z",
                r#"{"start_time":"2026-10-14T01:45:00Z","end_time":"2026-10-14T03:45:00Z","type":5},
                   {"start_time":"2026-10-14T03:45:00Z","end_time":"2026-10-14T07:00:00Z","type":0}"#
            ),
        ],
    )
    .unwrap();
    conn.execute_batch(
        "INSERT INTO device_day (profile_id, day, steps, in_bed_min, asleep_min, bedtime,
             wake_time, deep_min, sleep_avg_hr)
         VALUES (1, '2026-10-12', 900, 400, 380, '01:00', '07:40', 60, 52),
                (1, '2026-10-14', 9000, 315, 315, '04:45', '10:00', 120, 55);
         INSERT INTO nap (profile_id, day, start_at, end_at, source, source_key)
         VALUES (1, '2026-10-14', '2026-10-13T20:30:00Z', '2026-10-13T22:30:00Z',
                 'health_connect', 's1');
         INSERT INTO sleep_stage (profile_id, day, start_at, end_at, stage, source)
         VALUES (1, '2026-10-14', '2026-10-14T01:45:00Z', '2026-10-14T03:45:00Z', 'deep',
                 'health_connect');",
    )
    .unwrap();
    assert_eq!(
        derived_current(&mut conn, Some(&tz), 0).get("night_rule_version"),
        Some(&1)
    );
    let days = device_day_list(&conn, ME, None, None).unwrap();
    let night = |day: &str| {
        let d = &days.days.iter().find(|d| d.day.day == day).unwrap().day;
        (
            d.bedtime.clone(),
            d.wake_time.clone(),
            d.in_bed_min,
            d.deep_min,
            d.light_min,
            d.sleep_avg_hr,
            d.steps,
        )
    };
    assert_eq!(
        night("2026-10-14"),
        (
            Some("23:30".into()),
            Some("10:00".into()),
            Some(435),
            Some(120),
            Some(120),
            Some(55),
            Some(9000)
        )
    );
    assert_eq!(
        night("2026-10-12"),
        (
            Some("01:00".into()),
            Some("07:40".into()),
            Some(400),
            Some(60),
            None,
            Some(52),
            Some(900)
        )
    );
    assert!(days.naps.is_empty(), "{:?}", days.naps);
    let stages: Vec<(String, SleepStageKind)> = sleep_stage_list(&conn, ME, None, None)
        .unwrap()
        .into_iter()
        .map(|s| (s.start_at, s.stage))
        .collect();
    assert_eq!(
        stages,
        [
            ("2026-10-13T20:30:00Z".to_owned(), SleepStageKind::Light),
            ("2026-10-14T01:45:00Z".to_owned(), SleepStageKind::Deep)
        ]
    );
    // Once per rule version.
    assert!(derived_current(&mut conn, Some(&tz), 0).is_empty());
}

#[test]
fn a_second_apps_copy_of_a_workout_is_one_session() {
    // On Jul 15 an "other" (65 min, 211 m) synced first, then a
    // second app's "workout" copy of it (64 min, 3 s later) synced later:
    // stored twice, as copies were compared one way only.
    let mut conn = memory();
    let raw = |key: &str, start: &str, end: &str, kind: i64, distance_m| DeviceSession {
        key: key.into(),
        day: "2026-07-15".into(),
        start_at: start.into(),
        end_at: end.into(),
        kind,
        name: "Workout".into(),
        kcal: None,
        total_kcal: None,
        distance_m,
        recording_method: 1,
        avg_hr: Some(82),
        max_hr: Some(140),
    };
    let other = raw(
        "be84",
        "2026-07-15T15:46:01Z",
        "2026-07-15T16:50:31Z",
        99,
        Some(211),
    );
    let workout = raw(
        "7b8e",
        "2026-07-15T15:46:04Z",
        "2026-07-15T16:50:03Z",
        8,
        None,
    );
    let mut post = sync_post("2026-07-15", "2026-07-15");
    post.sessions = vec![other.clone()];
    device_replace(&mut conn, ME, &post, 1, &TimeZone::UTC).unwrap();
    post.sessions = vec![other, workout];
    device_replace(&mut conn, ME, &post, 2, &TimeZone::UTC).unwrap();
    let kept = |conn: &Connection| -> Vec<(String, ActivityType)> {
        conn.prepare("SELECT source_key, type FROM activity ORDER BY id")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap()
    };
    assert_eq!(kept(&conn), [("be84".to_owned(), ActivityType::Other)]);

    // One stored twice before: the copy saying less goes, once.
    conn.execute(
        "INSERT INTO activity (profile_id, day, name, minutes, type, start_at, source,
             source_key, avg_hr, max_hr)
         VALUES (1, '2026-07-15', 'Workout', 64, 'workout', '2026-07-15T15:46:04Z',
                 'health_connect', '7b8e', 82, 140)",
        [],
    )
    .unwrap();
    assert_eq!(
        derived_current(&mut conn, None, 0).get("copy_rule_version"),
        Some(&1)
    );
    assert_eq!(kept(&conn), [("7b8e".to_owned(), ActivityType::Workout)]);
    assert!(derived_current(&mut conn, None, 0).is_empty());
}

#[test]
fn eaten_lists_by_time_eaten_and_planned_as_added() {
    // 18:18 logged after 18:34 and 21:25 still lists first; the day runs
    // to 03:00, so 01:30 lists after 21:25; one without a time last.
    // Planned keeps the order it was added in.
    let conn = memory();
    conn.execute_batch(
        "INSERT INTO entry (profile_id, day, grp, name, amount, time) VALUES
           (1, '2026-10-14', 'Eaten', 'a', '1 g', '18:34'),
           (1, '2026-10-14', 'Planned', 'p2', '1 g', '20:00'),
           (1, '2026-10-14', 'Eaten', 'b', '1 g', NULL),
           (1, '2026-10-14', 'Eaten', 'c', '1 g', '21:25'),
           (1, '2026-10-14', 'Planned', 'p1', '1 g', '08:00'),
           (1, '2026-10-14', 'Eaten', 'd', '1 g', '18:18'),
           (1, '2026-10-14', 'Eaten', 'e', '1 g', '01:30'),
           (1, '2026-10-14', 'Eaten', 'f', '1 g', '03:00');",
    )
    .unwrap();
    let names = |group: &str| -> Vec<String> {
        entry_list_for_day(&conn, ME, "2026-10-14")
            .unwrap()
            .into_iter()
            .filter(|e| e.group == group)
            .map(|e| e.name)
            .collect()
    };
    assert_eq!(names("Eaten"), ["f", "d", "a", "c", "e", "b"]);
    assert_eq!(names("Planned"), ["p2", "p1"]);
}

#[test]
fn records_and_totals_take_only_real_distances_and_paces() {
    // 1.2 km walked in an hour (1.2 km/h) is no walk's pace.
    // An "other" class's synced metres are the phone's steps, no
    // distance; one typed by hand is.
    let conn = memory();
    conn.execute_batch(
        "INSERT INTO activity (profile_id, day, name, minutes, type, distance_m, source,
             source_key)
         VALUES (1, '2026-07-23', 'Walk', 60, 'walk', 1200, 'health_connect', 'w'),
                (1, '2026-09-26', 'Zumba', 60, 'other', 641, 'health_connect', 'z'),
                (1, '2026-09-27', 'Rope', 30, 'other', 300, 'hand', NULL),
                (1, '2026-09-28', 'Zumba', 60, 'other', 900, 'health_connect', 'z2');",
    )
    .unwrap();
    let r = records(&conn, ME).unwrap();
    let walk = &r.types["walk"];
    assert_eq!(
        (
            walk.distance.as_ref().map(|a| a.distance_m),
            walk.pace.is_none()
        ),
        (Some(Some(1200)), true)
    );
    let other = &r.types["other"];
    assert_eq!(
        other.distance.as_ref().map(|a| a.name.as_str()),
        Some("Rope")
    );
    let s = stats(&conn, ME).unwrap();
    let other = s
        .by_type
        .iter()
        .find(|t| t.kind == ActivityType::Other)
        .unwrap();
    assert_eq!(other.distance_m, 300);
}

/// `actual` equals the checked-in file at `path` (from the crate root);
/// `KALORIINA_BLESS=1` writes it instead, for a change meant to move it.
fn golden(path: &str, actual: &str) {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(path);
    if std::env::var_os("KALORIINA_BLESS").is_some() {
        std::fs::write(&path, actual).unwrap();
    }
    let expected = std::fs::read_to_string(&path).unwrap_or_default();
    assert!(
        expected == actual,
        "{} differs (KALORIINA_BLESS=1 rewrites it)",
        path.display()
    );
}

/// The migrations released so far, as the owner's database ran them.
const RELEASED: usize = 69;

#[test]
fn released_migrations_are_frozen() {
    // A released migration may have run on a live database: an edit to one
    // is a schema nothing upgrades to. Extended at each release.
    let text = (1..)
        .zip(&MIGRATIONS[..RELEASED])
        .fold(String::new(), |mut text, (v, sql)| {
            let _ = writeln!(text, "-- {v}\n{sql}");
            text
        });
    golden("tests/fixtures/migrations-released.txt", &text);
}

#[test]
fn every_version_upgrades_to_the_same_schema() {
    // Every start version, each with its Rust steps, ends where a fresh
    // database does.
    let fresh = schema(&memory());
    for v in 0..=MIGRATIONS.len() {
        let mut conn = at_version(u32::try_from(v).unwrap());
        migrate(&mut conn).unwrap();
        // Then the derived data, every family made (none failed).
        let ran = derived_current(&mut conn, Some(&TimeZone::UTC), 0);
        assert_eq!(ran.len(), DERIVED.len(), "from version {v}: {ran:?}");
        assert_eq!(schema(&conn), fresh, "from version {v}");
    }
}

/// Every table's row count, `sqlite_` tables but `sqlite_sequence` left
/// out.
fn row_counts(conn: &Connection) -> BTreeMap<String, i64> {
    schema_names(conn, "table")
        .into_iter()
        .filter(|t| !t.starts_with("sqlite_"))
        .map(|t| {
            let n = conn
                .query_row(&format!("SELECT count(*) FROM \"{t}\""), [], |r| r.get(0))
                .unwrap();
            (t, n)
        })
        .collect()
}

#[test]
fn upgrades_keep_every_row() {
    // The v27 and v40 fixtures' rows all survive to head, under
    // the tables' later names; a migration that loses rows fails here even
    // with `integrity_check` ok.
    let renamed = [
        ("workout_session", "activity"),
        ("activity_session", "device_session"),
        ("activity_day", "device_day"),
        ("activity_import", "import_day"),
    ];
    let v27 = || {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(include_str!("../../tests/fixtures/v27.sql"))
            .unwrap();
        conn
    };
    let v40 = || {
        let conn = at_version(40);
        conn.execute_batch(include_str!("../../tests/fixtures/v40.sql"))
            .unwrap();
        conn
    };
    // Meant to go: migration 50 drops a device day that only copied its
    // import's (v40's 2026-10-03), whose values still show from the import.
    let meant = [("v40", "activity_day", 1)];
    for (name, conn) in [("v27", v27()), ("v40", v40())] {
        let before = row_counts(&conn);
        let mut conn = conn;
        migrate(&mut conn).unwrap();
        let helsinki = TimeZone::get("Europe/Helsinki").unwrap();
        derived_current(&mut conn, Some(&helsinki), 0);
        let after = row_counts(&conn);
        let lost: Vec<String> = before
            .iter()
            .filter_map(|(t, n)| {
                let now = renamed
                    .iter()
                    .find(|(from, _)| from == t)
                    .map_or(t.as_str(), |r| r.1);
                let gone = meant
                    .iter()
                    .find(|m| m.0 == name && m.1 == t)
                    .map_or(0, |m| m.2);
                let kept = after.get(now).copied().unwrap_or(0);
                (kept + gone < *n).then(|| format!("{t} → {now}: {n} → {kept}"))
            })
            .collect();
        assert!(lost.is_empty(), "{name}: {lost:?}");
    }
}

/// The objects on `table` as `(type, name)`, and each index's and
/// trigger's SQL.
fn objects_of(conn: &Connection, table: &str) -> BTreeMap<(String, String), Option<String>> {
    conn.prepare("SELECT type, name, sql FROM sqlite_master WHERE tbl_name = ?")
        .unwrap()
        .query_map([table], |r| {
            let kind: String = r.get(0)?;
            let sql = if kind == "table" { None } else { r.get(2)? };
            Ok(((kind, r.get(1)?), sql))
        })
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
}

/// `table`'s columns (`name type notnull default pk`) and its foreign
/// keys (`table from to on_update on_delete`), as `SQLite` reads them.
fn shape_of(conn: &Connection, table: &str) -> (Vec<String>, Vec<String>) {
    let rows = |sql: &str| -> Vec<String> {
        conn.prepare(sql)
            .unwrap()
            .query_map([table], |r| r.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap()
    };
    (
        rows(
            "SELECT concat_ws(' ', name, type, \"notnull\", coalesce(dflt_value, '-'), pk)
             FROM pragma_table_info(?)",
        ),
        rows(
            "SELECT concat_ws(' ', \"table\", \"from\", \"to\", on_update, on_delete)
             FROM pragma_foreign_key_list(?)",
        ),
    )
}

/// The rebuilt tables' `sqlite_sequence`, by name.
fn sequences(conn: &Connection) -> Vec<(String, i64)> {
    conn.prepare(
        "SELECT name, seq FROM sqlite_sequence WHERE name IN ('entry', 'meal', 'serving')
         ORDER BY name",
    )
    .unwrap()
    .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
    .unwrap()
    .collect::<rusqlite::Result<_>>()
    .unwrap()
}

#[test]
fn rebuild_keeps_every_index_and_trigger() {
    // Migration 66 rebuilt `entry`, `meal` and `serving` with AUTOINCREMENT.
    // A rebuild drops what hangs on the table: each must come
    // back as it was, but for `entry`'s columns 61 added, their two
    // triggers and `entry_totals`, which go.
    let seeded = || {
        let conn = at_version(65);
        conn.execute_batch(
            "INSERT INTO food (id, name, source) VALUES (7, 'Oats', 'custom');
             INSERT INTO serving (id, food_id, label, grams) VALUES (3, 7, 'Cup', 90);
             INSERT INTO meal (id, name) VALUES (4, 'Breakfast');
             INSERT INTO entry (id, profile_id, day, grp, food_id, name, amount, uid)
             VALUES (5, 1, '2026-10-06', 'Eaten', 7, 'Oats', '90 g', 'v65-oats');",
        )
        .unwrap();
        conn
    };
    let (before, mut after) = (seeded(), seeded());
    let tx = after.transaction().unwrap();
    migrate_to(&tx, 65, 66).unwrap();
    tx.commit().unwrap();
    let names = |objects: &BTreeMap<(String, String), Option<String>>| -> Vec<String> {
        objects.keys().map(|(k, n)| format!("{k} {n}")).collect()
    };
    let dropped = [
        "index entry_totals",
        "trigger entry_scalars_insert",
        "trigger entry_scalars_update",
    ];
    for (table, kept) in [
        (
            "entry",
            &[
                "index entry_daily_item",
                "index entry_day",
                "index entry_food",
                "index entry_profile_food",
                "index entry_uid",
                "table entry",
                "trigger entry_uid",
            ][..],
        ),
        ("meal", &["table meal"][..]),
        ("serving", &["index serving_food", "table serving"][..]),
    ] {
        let (was, is) = (objects_of(&before, table), objects_of(&after, table));
        let expected: Vec<String> = names(&was)
            .into_iter()
            .filter(|n| !dropped.contains(&n.as_str()))
            .collect();
        assert_eq!(expected, kept, "{table} before");
        assert_eq!(names(&is), kept, "{table} after");
        for (key, sql) in &is {
            assert_eq!(sql, &was[key], "{table}: {key:?}");
        }
        let (mut columns, keys) = shape_of(&before, table);
        columns.retain(|c| {
            !["energy", "water", "caffeine", "alcohol"].contains(&c.split(' ').next().unwrap())
        });
        assert_eq!(shape_of(&after, table), (columns, keys), "{table}");
        let sql: String = after
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
                [table],
                |r| r.get(0),
            )
            .unwrap();
        assert!(sql.contains("PRIMARY KEY AUTOINCREMENT"), "{sql}");
    }
    // The ids carry over and are never handed out again.
    assert_eq!(
        sequences(&after),
        [
            ("entry".into(), 5),
            ("meal".into(), 4),
            ("serving".into(), 3)
        ]
    );
    // The uid trigger and index work: one made without a uid gets one, a
    // uid twice in a profile is refused.
    migrate(&mut after).unwrap();
    after
        .execute(
            "INSERT INTO entry (profile_id, day, grp, name, amount) VALUES (1, '2026-10-06', 'Eaten', 'Tea', '1 cup')",
            [],
        )
        .unwrap();
    let (id, uid): (i64, Option<String>) = after
        .query_row("SELECT id, uid FROM entry WHERE name = 'Tea'", [], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .unwrap();
    assert_eq!(id, 6);
    assert_eq!(uid.map(|u| u.len()), Some(32));
    assert!(
        after
            .execute(
                "INSERT INTO entry (profile_id, day, grp, name, amount, uid)
                 VALUES (1, '2026-10-07', 'Eaten', 'Again', '1 g', 'v65-oats')",
                [],
            )
            .is_err()
    );
}

#[test]
fn every_own_id_is_autoincrement() {
    // A row addressed by its own id never hands that id to another.
    // `hook` is keyed by its profile.
    let conn = memory();
    let plain: Vec<String> = schema_names(&conn, "table")
        .into_iter()
        .filter(|t| {
            let own_id: bool = conn
                .query_row(
                    "SELECT count(*) = 1 AND sum(name = 'id') = 1 FROM pragma_table_info(?) WHERE pk > 0",
                    [t],
                    |r| r.get(0),
                )
                .unwrap();
            let sql: String = conn
                .query_row(
                    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
                    [t],
                    |r| r.get(0),
                )
                .unwrap();
            own_id && sql.contains("INTEGER PRIMARY KEY") && !sql.contains("AUTOINCREMENT")
        })
        .collect();
    assert_eq!(plain, Vec::<String>::new());
}

/// A file's food refs (another instance's ids) as their place in `foods`,
/// wherever a food is named.
fn food_refs_renumbered(file: &mut serde_json::Value) {
    use serde_json::Value;
    fn walk(v: &mut Value, key: &str, refs: &BTreeMap<String, String>) {
        match v {
            Value::Object(o) => o.iter_mut().for_each(|(k, x)| walk(x, k, refs)),
            Value::Array(a) => a.iter_mut().for_each(|x| walk(x, key, refs)),
            Value::String(s) if ["food", "favorites", "water_food"].contains(&key) => {
                s.clone_from(&refs[s.as_str()]);
            }
            _ => {}
        }
    }
    let refs: BTreeMap<String, String> = file["foods"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
        .map(|(i, f)| (f["ref"].as_str().unwrap().to_owned(), format!("food {i}")))
        .collect();
    for f in file["foods"].as_array_mut().unwrap() {
        f["ref"] = Value::Null;
    }
    walk(file, "", &refs);
}

#[test]
fn upgraded_fixtures_export_and_reimport() {
    // An upgraded database's profile is a file that imports:
    // into the same database under another name and into a fresh one, and
    // exports again as it was.
    let tz = TimeZone::get("Europe/Helsinki").unwrap();
    let comparable = |file: &crate::model::ProfileExport| {
        let mut v = serde_json::to_value(file).unwrap();
        let o = v.as_object_mut().unwrap();
        o.remove("exported_at");
        o.remove("openscale");
        let profile = o["profile"].as_object_mut().unwrap();
        profile.remove("name");
        profile.remove("id");
        food_refs_renumbered(&mut v);
        v
    };
    for (name, mut conn) in [
        (
            "v27",
            upgraded(
                Connection::open_in_memory().unwrap(),
                include_str!("../../tests/fixtures/v27.sql"),
            ),
        ),
        (
            "v40",
            upgraded(at_version(40), include_str!("../../tests/fixtures/v40.sql")),
        ),
    ] {
        let first = profile_export(&conn, ME).unwrap();
        let bytes = serde_json::to_vec(&first).unwrap();
        let mut fresh = memory();
        for (into, conn) in [("same", &mut conn), ("fresh", &mut fresh)] {
            let mut file = crate::model::ProfileExport::read(&bytes).unwrap();
            file.profile.name = format!("{name} {into}");
            let checked = file
                .checked("2026-10-17")
                .unwrap_or_else(|e| panic!("{name}: {e}"));
            let made = profile_import(conn, &checked, true, 1, &tz)
                .unwrap_or_else(|e| panic!("{name} into {into}: {e}"));
            let again = profile_export(conn, made.id).unwrap();
            let (again, first) = (comparable(&again), comparable(&first));
            for (key, was) in first.as_object().unwrap() {
                assert_eq!(&again[key], was, "{name} into {into}: {key}");
            }
            assert_eq!(again, first);
        }
    }
}

/// The `SQLite` VM steps `f` runs on `conn`, every statement's: a work count
/// no machine's load moves.
fn vm_steps(conn: &mut Connection, f: impl FnOnce(&mut Connection)) -> u64 {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicU64, Ordering};
    let steps = Arc::new(AtomicU64::new(0));
    let count = Arc::clone(&steps);
    conn.progress_handler(
        1,
        Some(move || {
            count.fetch_add(1, Ordering::Relaxed);
            false
        }),
    )
    .unwrap();
    f(conn);
    conn.progress_handler(1, None::<fn() -> bool>).unwrap();
    steps.load(Ordering::Relaxed)
}

#[test]
fn a_scale_batch_grows_linearly() {
    // An openScale full sync replayed at n and 4n readings (two
    // a day) costs about 4× the work, not 16× (each day's
    // lookup scanned the whole history).
    let tz = TimeZone::UTC;
    let latest = jiff::civil::date(2100, 1, 1);
    let batch = |n: i64| {
        let start = 1_333_256_400_000_i64; // 2012-04-01T05:00:00Z
        let items: Vec<serde_json::Value> = (0..n)
            .map(|i| {
                let at = jiff::Timestamp::from_millisecond(start + i * 43_200_000).unwrap();
                serde_json::json!({ "id": i, "userId": 1, "username": "Me",
                    "date": at.strftime("%Y-%m-%dT%H:%M:%S%.3fZ").to_string(),
                    "weight": 80.0 })
            })
            .collect();
        let body = serde_json::json!({ "event": "insert", "measurements": items }).to_string();
        crate::model::ScalePost::read(body.as_bytes(), &tz, latest).unwrap()
    };
    let replayed = |n: i64| {
        let mut conn = memory();
        let post = batch(n);
        scale_apply(&mut conn, ME, &post, 1, &tz).unwrap();
        sync_bind(&mut conn, ME, 1, 1, &tz).unwrap();
        scale_apply(&mut conn, ME, &post, 1, &tz).unwrap();
        vm_steps(&mut conn, |conn| {
            scale_apply(conn, ME, &post, 2, &tz).unwrap();
        })
    };
    let (small, large) = (replayed(200), replayed(800));
    #[expect(clippy::cast_precision_loss, reason = "a ratio of counts")]
    let ratio = large as f64 / small as f64;
    assert!(ratio < 6.0, "{small} → {large} steps: ×{ratio:.1}");
}

#[test]
fn all_time_grows_linearly() {
    // All time reads every day it sums (O(history)): 4 years is
    // about 4× one year's work, nothing steeper.
    let read = |days: i64| {
        let mut conn = memory();
        let start = jiff::civil::date(2022, 1, 1);
        let tx = conn.transaction().unwrap();
        for i in 0..days {
            let day = start.saturating_add(jiff::ToSpan::days(i)).to_string();
            tx.execute(
                "INSERT INTO entry (profile_id, day, grp, name, grams, amount, nutrients)
                 VALUES (1, ?, 'Eaten', 'Oats', 100, '100 g', '{\"energy\":380,\"water\":10}')",
                [&day],
            )
            .unwrap();
        }
        tx.commit().unwrap();
        vm_steps(&mut conn, |conn| {
            stats(conn, ME).unwrap();
        })
    };
    let (one, four) = (read(365), read(4 * 365));
    #[expect(clippy::cast_precision_loss, reason = "a ratio of counts")]
    let ratio = four as f64 / one as f64;
    assert!(ratio <= 4.5, "{one} → {four} steps: ×{ratio:.1}");
}

#[test]
fn a_one_day_read_searches_by_day() {
    // Every table read through `IN_RANGE` finds one day by its index on
    // (profile_id, day), not by scanning the profile.
    let conn = memory();
    let mut wrong = Vec::new();
    for table in [
        "activity",
        "check_in",
        "day_note",
        "device_day",
        "device_session",
        "import_day",
        "measurement",
        "nap",
        "scale_reading",
        "sleep_stage",
        "weight",
    ] {
        let plan: Vec<String> = conn
            .prepare(&format!(
                "EXPLAIN QUERY PLAN SELECT * FROM {table} WHERE {IN_RANGE}"
            ))
            .unwrap()
            .query_map(params![ME, "2026-10-06", "2026-10-06"], |r| r.get(3))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        let plan = plan.join("; ");
        if !(plan.contains("day>?") && plan.contains("day<?")) {
            wrong.push(format!("{table}: {plan}"));
        }
    }
    assert!(wrong.is_empty(), "{wrong:#?}");
}
