use super::profiles::day_weight_refresh;
use super::*;
use crate::model::{CheckedHabit, GoalDir, ItemInput, SessionSource, SyncedWorkouts};

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
           (12, 'Apple b', 'recipe', '{}'),
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
    entry_log(conn, &at, food, &m).unwrap()
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
            .map(|&(food_id, grams)| ItemInput { food_id, grams })
            .collect(),
        servings: vec![],
        rev: None,
        archived: false,
        instructions: None,
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
             ('2026-01-01', 'Consumed', 'A', '1 g'), ('2026-01-01', 'Consumed', 'B', '1 g')",
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
        "INSERT INTO entry (day, grp, name, amount) VALUES ('2026-01-01', 'Consumed', 'A', '1 g');
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
    assert_eq!(target_list(&conn, ME).unwrap()[0].min, Some(2000.0));
    // The rebuilt table still assigns uids to new rows.
    let food_id = food(&mut conn, "Milk", &[]);
    let milk = food_get(&conn, food_id).unwrap().unwrap();
    assert_eq!(
        log(&mut conn, ME, "2026-01-02", "Consumed", &milk, 1.0)
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
    log(&mut conn, guest, "2026-10-06", "Consumed", &milk, 1.0);
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
            &crate::fineli::serving_labels()
        )
        .unwrap(),
        1
    );
    let id: i64 = conn
        .query_row("SELECT id FROM food WHERE fineli_id = 7", [], |r| r.get(0))
        .unwrap();
    let recipe = recipe_save(&mut conn, None, &recipe("Puuro", &[(id, 100.0)])).unwrap();

    assert_eq!(
        food_upsert_fineli(
            &mut conn,
            &[(7, food("Maito, rasvaton", 35.0))],
            &crate::fineli::serving_labels()
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
    food_upsert_fineli(&mut conn, &[(7, milk)], &crate::fineli::serving_labels()).unwrap();
    let milk = food_search(&conn, &query("Maito")).unwrap().remove(0);
    log(&mut conn, ME, "2026-10-07", "Consumed", &milk, 100.0);
    imported_entries_replace(
        &conn,
        ME,
        &[ImportedEntry {
            day: "2026-10-07".into(),
            group: "Consumed".into(),
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
    // Servings are read per search result; a scan per row made search 5x slower.
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
    assert_close!(energy.max.unwrap(), 2090.0, "about: 10 % over");
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
                 ('2026-01-02', 'Consumed', 1, 'Oats', 50, '50 g', '{"energy":190.0}');
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
        day.iter().any(|e| e.group == "Planned" && e.imported),
        "Remaining became Planned"
    );
    assert_eq!(day.iter().find(|e| !e.imported).unwrap().food_id, Some(1));
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

#[test]
fn entry_snapshot_is_immutable_and_rescales() {
    let mut conn = memory();
    let id = food(&mut conn, "Milk", &[("protein", 3.0)]);
    let milk = food_get(&conn, id).unwrap().unwrap();
    let e = log(&mut conn, ME, "2026-10-06", "Planned", &milk, 200.0).id;

    let input = FoodInput {
        name: "Milk".into(),
        per100: nut(&[("protein", 99.0)]),
        rev: Some(rev(&conn, "food", id)),
        ..FoodInput::default()
    };
    food_update(&mut conn, id, &input).unwrap();
    let patch = crate::model::EntryPatch {
        group: Some("Consumed".into()),
        amount: crate::model::Amount {
            grams: Some(100.0),
            ..crate::model::Amount::default()
        },
        ..crate::model::EntryPatch::default()
    };
    entry_update(&mut conn, ME, e, &patch).unwrap();

    let got = entry_get(&conn, ME, e).unwrap().unwrap();
    assert_eq!(got.group, "Consumed");
    assert_eq!(got.nutrients, Some(nut(&[("protein", 3.0)])));
}

#[test]
fn group_totals_merge_entries_and_imported() {
    let mut conn = memory();
    let id = food(&mut conn, "Milk", &[("protein", 3.0)]);
    let milk = food_get(&conn, id).unwrap().unwrap();
    log(&mut conn, ME, "2026-10-06", "Consumed", &milk, 100.0);
    day_totals_replace(
        &conn,
        ME,
        &["2026-10-06".into()],
        &[DayTotal {
            day: "2026-10-06".into(),
            group: "Consumed".into(),
            nutrients: nut(&[("protein", 10.0)]),
        }],
    )
    .unwrap();
    let totals = group_totals(&conn, ME, "2026-10-01", "2026-10-31").unwrap();
    assert_eq!(
        totals[&("2026-10-06".into(), "Consumed".into())],
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
    // Session sets name their exercise by id after it's gone: a new
    // exercise must never take that id and inherit someone else's history.
    let mut conn = memory();
    let input = |name: &str| ExerciseInput {
        name: name.into(),
        measure: Measure::Reps,
        variant_of: None,
        traits: ExerciseTraits::default(),
        rev: None,
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
    for (v, sql) in (1..=version).zip(MIGRATIONS) {
        conn.execute_batch(sql).unwrap();
        conn.pragma_update(None, "user_version", v).unwrap();
        if RECOMPUTE_RECIPES_AFTER.contains(&v) {
            let tx = conn.transaction().unwrap();
            recompute_all_recipes(&tx).unwrap();
            tx.commit().unwrap();
        }
    }
    conn
}

/// `conn` with `fixture` added, migrated to the current schema and opened
/// as the app opens it.
fn upgraded(mut conn: Connection, fixture: &str) -> Connection {
    conn.execute_batch(fixture).unwrap();
    migrate(&mut conn).unwrap();
    conn.pragma_update(None, "foreign_keys", "ON").unwrap();
    register_functions(&conn).unwrap();
    conn
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
        (entry.group.as_str(), entry.uid.as_str(), entry.imported),
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
        session_list(&conn, ME, None, None, None)
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
             VALUES (1, 1, '2026-10-01', 'Consumed', 1, 'Oats', 50, '50 g', '{"energy":190.0}', 'entry-0001');"#,
    );

    let pulls = workout_get(&conn, 1).unwrap().unwrap();
    assert!(matches!(&pulls.steps[0], Step::Repeat { times: 2, .. }));
    assert_eq!(pulls.rev, 1);
    assert_eq!(
        exercise_get(&conn, 1000).unwrap().unwrap().measure,
        Measure::Reps
    );
    let session = session_get(&conn, ME, 1).unwrap().unwrap();
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
             VALUES (1, 1, '2026-10-01', 'Consumed', 1, 'Oats', 50, '50 g', '{"energy":190.0}', 'entry-0001');
           INSERT INTO entry (id, profile_id, day, grp, name, amount, imported, uid, src_grp)
             VALUES (2, 1, '2026-10-01', 'Consumed', 'Pizza', '1 slice', 1, 'entry-0002', 'Consumed');"#,
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

    // AUTOINCREMENT: the newest food's id isn't handed out again (10 is the
    // Water migration 25 seeds, there being no Fineli water).
    let seq: i64 = conn
        .query_row(
            "SELECT seq FROM sqlite_sequence WHERE name = 'food'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(seq, 10);
    conn.execute("DELETE FROM food WHERE id = 10", []).unwrap();
    assert_eq!(food(&mut conn, "Rye", &[]), 11);

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
    assert_eq!((source, set_at), (WeightSource::Manual, None));
    assert_eq!(sync_status(&conn, ME).unwrap().bound_user, None);

    // A weight typed before set times were kept stays, even under a reading.
    conn.execute(
        "INSERT INTO scale_reading (profile_id, source, source_user, taken_at, day, weight)
         VALUES (1, 'openscale', 1, 1, '2026-10-01', 81)",
        [],
    )
    .unwrap();
    day_weight_refresh(&conn, ME, "2026-10-01", 2).unwrap();
    assert_close!(weight_list(&conn, ME, None, None).unwrap()[0].kg, 80.0);
    // Deleting it lets the reading set the day.
    weight_delete(&mut conn, ME, "2026-10-01", 3).unwrap();
    assert_eq!(
        weight_source(&conn, ME, "2026-10-01").unwrap(),
        Some(WeightSource::OpenScale)
    );
}

#[test]
fn upgrade_from_v23_adds_activity() {
    // A database as release 23 left it: a second profile, connected to openScale.
    let mut conn = upgraded(
        at_version(23),
        "INSERT INTO profile (id, name) VALUES (2, 'Anna');
         INSERT INTO sync_state (profile_id, source, bound_user) VALUES (2, 'openscale', 1);",
    );
    let anna = ProfileId(2);
    let empty = activity_list(&conn, anna, None, None).unwrap();
    assert!(empty.days.is_empty() && empty.sessions.is_empty());
    assert_eq!(health_status(&conn, anna).unwrap().last_seen, None);

    let post = crate::model::HealthPost {
        from: "2026-10-01".into(),
        to: "2026-10-07".into(),
        device: Some("Pixel 9".into()),
        days: vec![crate::model::ActivityDay {
            day: "2026-10-02".into(),
            active_kcal: Some(512),
            steps: Some(9120),
            ..Default::default()
        }],
        sessions: vec![crate::model::ActivitySession {
            key: "hc-1".into(),
            day: "2026-10-02".into(),
            start_at: "2026-10-02T14:02:00Z".into(),
            end_at: "2026-10-02T14:48:00Z".into(),
            kind: 33,
            name: "Running".into(),
            kcal: Some(410),
            distance_m: None,
            recording_method: 1,
        }],
        skipped: 0,
    };
    activity_replace(&mut conn, anna, &post, 1).unwrap();
    // Its status sits beside openScale's, which stays bound.
    assert_eq!(health_status(&conn, anna).unwrap().last_seen, Some(1));
    assert_eq!(sync_status(&conn, anna).unwrap().bound_user.unwrap().id, 1);
    activity_delete(&mut conn, anna).unwrap();
    assert!(sync_status(&conn, anna).unwrap().bound_user.is_some());

    // A profile takes its activity with it.
    activity_replace(&mut conn, anna, &post, 2).unwrap();
    profile_delete(&mut conn, anna).unwrap();
    let left: i64 = conn
        .query_row(
            "SELECT (SELECT count(*) FROM activity_day) + (SELECT count(*) FROM activity_session)",
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
    assert_eq!(
        recipe_get(&conn, 2).unwrap().unwrap().food.instructions,
        None
    );
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
            "SELECT count(*) FROM food WHERE source = 'custom'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(seeded, 0);
    assert_eq!(water_food_get(&conn, ME).unwrap().unwrap().id, 7);
}

#[test]
fn upgrade_from_v25_adds_sleep_and_synced_workouts() {
    // A database as release 25 left it: a hand-logged session, a synced day
    // and a watch workout, each without the new columns' values.
    let conn = upgraded(
        at_version(25),
        r"INSERT INTO workout_session (id, profile_id, day, name, minutes, sets, uid)
            VALUES (1, 1, '2026-10-02', 'Walk', 30, '[]', 'walk-0001');
          INSERT INTO activity_day (profile_id, day, active_kcal, steps) VALUES (1, '2026-10-02', 512, 9120);
          INSERT INTO activity_session (profile_id, source_key, day, start_at, end_at, type, name, kcal)
            VALUES (1, 'hc-1', '2026-10-02', '2026-10-02T14:02:00Z', '2026-10-02T14:48:00Z', 33, 'Running', 410);",
    );
    let s = session_get(&conn, ME, 1).unwrap().unwrap();
    assert_eq!(
        (s.kind, s.distance_m, s.start_at, s.source, s.source_key),
        (None, None, None, SessionSource::Manual, None)
    );
    let a = activity_list(&conn, ME, None, None).unwrap();
    assert_eq!(
        (a.days[0].steps, a.days[0].in_bed_min, a.days[0].hrv_ms),
        (Some(9120), None, None)
    );
    assert_eq!(
        (a.sessions[0].distance_m, a.sessions[0].recording_method),
        (None, 0)
    );
    // Schema only: the watch workout waits for the first sync.
    assert_eq!(session_list(&conn, ME, None, None, None).unwrap().len(), 1);
    assert_eq!(
        health_status(&conn, ME).unwrap().workouts,
        SyncedWorkouts::Auto
    );
    let tombstones: i64 = conn
        .query_row("SELECT count(*) FROM workout_tombstone", [], |r| r.get(0))
        .unwrap();
    assert_eq!(tombstones, 0);
    // One source key per profile; the type is a closed set.
    for bad in [
        "UPDATE workout_session SET type = 'strength' WHERE id = 1",
        "UPDATE profile SET synced_workouts = 'never'",
    ] {
        assert!(conn.execute(bad, []).is_err(), "{bad}");
    }
}
#[test]
fn water_food_prefers_your_pick_then_fineli_then_your_own() {
    let mut conn = memory();
    // A fresh database: the seeded Water.
    let seeded = water_food_get(&conn, ME).unwrap().unwrap().id;
    // Fineli's plain water outranks it; other waters and look-alikes don't count.
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

    // Your pick wins, until it's archived; unknown and archived picks are refused.
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

// ------------------------------------------------------------- upgrades and snapshots

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
            ("2026-10-01".into(), WeightSource::Manual, Some(5)),
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
             (1, '2026-10-01', 'Consumed', 'quick', NULL, 'Snack', NULL, 'Quick add', '{"energy":100.0}', 'q1'),
             (1, '2026-10-01', 'Consumed', 'quick', NULL, 'Snack', NULL, 'Quick add', '{"energy":100.0}', 'q2'),
             (1, '2026-10-01', 'Planned', 'quick', NULL, 'Snack', 50, 'Quick add', '{"energy":200.0}', 'q3'),
             (1, '2026-10-02', 'Consumed', 'quick', NULL, 'Feast', NULL, 'Dinner out',
                 '{"energy":2500.0,"fat":150.0,"sodium":3000.0}', 'q4'),
             (1, '2026-10-02', 'Consumed', 'food', 500, 'Oats', 50, '50 g', '{"energy":190.0}', 'f1');"#,
    );
    let totals = group_sums(group_rows(&conn, ME, "2026-10-01", "2026-10-02").unwrap()).unwrap();
    let energy = |day: &str, grp: &str| {
        totals[&(day.to_owned(), grp.to_owned())]
            .get("energy")
            .unwrap()
    };
    assert_close!(energy("2026-10-01", "Consumed"), 200.0);
    assert_close!(energy("2026-10-01", "Planned"), 200.0);
    assert_close!(energy("2026-10-02", "Consumed"), 2690.0);
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
    let distances: Vec<Option<u32>> = session_list(&conn, ME, None, None, None)
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
        .prepare("SELECT category_auto FROM food WHERE id >= 500 ORDER BY id")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert_eq!(auto, [true, false, false]);
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
        "INSERT INTO entry (profile_id, day, grp, name, amount) VALUES (99, '2026-10-01', 'Consumed', 'X', '1 g')",
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
    for table in exported_tables(&conn) {
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
