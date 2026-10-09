//! The schema as a list of migrations; `PRAGMA user_version` counts how many
//! ran.

/// Every migration in a released build is frozen: it may have run on a live
/// database. Change the schema only by appending one.
pub(super) const MIGRATIONS: &[&str] = &[
    r"
CREATE TABLE food (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    brand TEXT,
    barcode TEXT UNIQUE,
    source TEXT NOT NULL CHECK (source IN ('custom', 'off', 'recipe')),
    per100 TEXT NOT NULL DEFAULT '{}',
    cooked_g REAL,
    archived INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE serving (
    id INTEGER PRIMARY KEY,
    food_id INTEGER NOT NULL REFERENCES food (id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    grams REAL NOT NULL
);
CREATE TABLE recipe_item (
    recipe_id INTEGER NOT NULL REFERENCES food (id) ON DELETE CASCADE,
    food_id INTEGER NOT NULL REFERENCES food (id),
    grams REAL NOT NULL
);
CREATE INDEX recipe_item_food ON recipe_item (food_id);
CREATE TABLE meal (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL
);
CREATE TABLE meal_item (
    meal_id INTEGER NOT NULL REFERENCES meal (id) ON DELETE CASCADE,
    food_id INTEGER NOT NULL REFERENCES food (id),
    grams REAL NOT NULL
);
CREATE TABLE entry (
    id INTEGER PRIMARY KEY,
    day TEXT NOT NULL,
    grp TEXT NOT NULL,
    food_id INTEGER REFERENCES food (id),
    name TEXT NOT NULL,
    grams REAL,
    amount TEXT NOT NULL,
    nutrients TEXT,
    imported INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX entry_day ON entry (day);
CREATE INDEX entry_food ON entry (food_id);
CREATE TABLE day_total (
    day TEXT NOT NULL,
    grp TEXT NOT NULL,
    nutrients TEXT NOT NULL,
    PRIMARY KEY (day, grp)
);
CREATE TABLE target (
    nutrient TEXT PRIMARY KEY,
    min REAL,
    max REAL
);
",
    // A random, never-reused id per entry: the Health Connect sync key.
    // Integer ids are reused by SQLite after a delete and rewound by a restore.
    r"
ALTER TABLE entry ADD COLUMN uid TEXT;
UPDATE entry SET uid = lower(hex(randomblob(16)));
CREATE UNIQUE INDEX entry_uid ON entry (uid);
CREATE TRIGGER entry_uid AFTER INSERT ON entry WHEN NEW.uid IS NULL BEGIN
    UPDATE entry SET uid = lower(hex(randomblob(16))) WHERE id = NEW.id;
END;
",
    // Profiles: diary, imported totals and targets become per person. Every
    // existing row belongs to the first profile, "Me". SQLite can't add a
    // foreign-key column or change a primary key in place, so the three tables
    // are rebuilt (row ids, and with them entry uids, are kept).
    r"
CREATE TABLE profile (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    sex TEXT CHECK (sex IN ('female', 'male')),
    birth_date TEXT,
    height_cm REAL,
    weight_kg REAL,
    activity REAL,
    goal_kg_per_week REAL NOT NULL DEFAULT 0
);
INSERT INTO profile (id, name) VALUES (1, 'Me');

CREATE TABLE entry_new (
    id INTEGER PRIMARY KEY,
    profile_id INTEGER NOT NULL REFERENCES profile (id) ON DELETE CASCADE,
    day TEXT NOT NULL,
    grp TEXT NOT NULL,
    food_id INTEGER REFERENCES food (id),
    name TEXT NOT NULL,
    grams REAL,
    amount TEXT NOT NULL,
    nutrients TEXT,
    imported INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    uid TEXT
);
INSERT INTO entry_new
    (id, profile_id, day, grp, food_id, name, grams, amount, nutrients, imported, created_at, uid)
    SELECT id, 1, day, grp, food_id, name, grams, amount, nutrients, imported, created_at, uid
    FROM entry;
DROP TABLE entry;
ALTER TABLE entry_new RENAME TO entry;
CREATE INDEX entry_day ON entry (profile_id, day);
CREATE INDEX entry_food ON entry (food_id);
CREATE UNIQUE INDEX entry_uid ON entry (uid);
CREATE TRIGGER entry_uid AFTER INSERT ON entry WHEN NEW.uid IS NULL BEGIN
    UPDATE entry SET uid = lower(hex(randomblob(16))) WHERE id = NEW.id;
END;

CREATE TABLE day_total_new (
    profile_id INTEGER NOT NULL REFERENCES profile (id) ON DELETE CASCADE,
    day TEXT NOT NULL,
    grp TEXT NOT NULL,
    nutrients TEXT NOT NULL,
    PRIMARY KEY (profile_id, day, grp)
);
INSERT INTO day_total_new SELECT 1, day, grp, nutrients FROM day_total;
DROP TABLE day_total;
ALTER TABLE day_total_new RENAME TO day_total;

CREATE TABLE target_new (
    profile_id INTEGER NOT NULL REFERENCES profile (id) ON DELETE CASCADE,
    nutrient TEXT NOT NULL,
    min REAL,
    max REAL,
    PRIMARY KEY (profile_id, nutrient)
);
INSERT INTO target_new SELECT 1, nutrient, min, max FROM target;
DROP TABLE target;
ALTER TABLE target_new RENAME TO target;
",
    // Open Food Facts carbohydrate is the EU label's available carbohydrate.
    // Foods cached before this stored it as total carbs and subtracted fibre
    // again for net carbs; re-map them (recipes are recomputed in `migrate`).
    r"
UPDATE food SET per100 = json_set(
    per100,
    '$.net_carbs', json_extract(per100, '$.carbs'),
    '$.carbs', json_extract(per100, '$.carbs') + coalesce(json_extract(per100, '$.fiber'), 0)
)
WHERE source = 'off' AND json_extract(per100, '$.carbs') IS NOT NULL;
",
    // "Remaining" (the export's name for food not eaten yet) reads better as
    // "Planned". The importer maps it the same way.
    r"
UPDATE entry SET grp = 'Planned' WHERE grp = 'Remaining';
UPDATE day_total SET grp = 'Planned' WHERE grp = 'Remaining';
",
    // Profile ids are never reused: browsers remember the current profile by
    // id, so a recycled id would open another person's diary. Rebuilt because
    // SQLite can't add AUTOINCREMENT in place; foreign keys are off while
    // migrating and child tables keep referring to `profile` by name.
    r"
CREATE TABLE profile_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    sex TEXT CHECK (sex IN ('female', 'male')),
    birth_date TEXT,
    height_cm REAL,
    weight_kg REAL,
    activity REAL,
    goal_kg_per_week REAL NOT NULL DEFAULT 0
);
INSERT INTO profile_new SELECT * FROM profile;
DROP TABLE profile;
ALTER TABLE profile_new RENAME TO profile;
",
    // Foods from Fineli: a new source, and their Fineli id so a newer release
    // updates them in place. Rebuilt to widen the source check; row ids are
    // kept, so everything referring to a food stays linked.
    r"
CREATE TABLE food_new (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    brand TEXT,
    barcode TEXT UNIQUE,
    source TEXT NOT NULL CHECK (source IN ('custom', 'off', 'recipe', 'fineli')),
    per100 TEXT NOT NULL DEFAULT '{}',
    cooked_g REAL,
    archived INTEGER NOT NULL DEFAULT 0,
    fineli_id INTEGER UNIQUE
);
INSERT INTO food_new (id, name, brand, barcode, source, per100, cooked_g, archived)
    SELECT id, name, brand, barcode, source, per100, cooked_g, archived FROM food;
DROP TABLE food;
ALTER TABLE food_new RENAME TO food;
",
    // Each profile picks which food databases its food search shows, as a
    // JSON list of hidden sources.
    r"
ALTER TABLE profile ADD COLUMN hidden_sources TEXT NOT NULL DEFAULT '[]';
",
    // Each profile's favorite foods.
    r"
CREATE TABLE favorite (
    profile_id INTEGER NOT NULL REFERENCES profile (id) ON DELETE CASCADE,
    food_id INTEGER NOT NULL REFERENCES food (id),
    PRIMARY KEY (profile_id, food_id)
);
",
    // Which databases to search moved into the search itself.
    r"
ALTER TABLE profile DROP COLUMN hidden_sources;
",
    // A target is one number; its bounds follow from the nutrient's goal, so
    // only the number is stored. Older rows kept a min/max pair (legacy ones
    // min = max): the number is the max for "at most" nutrients and the min
    // otherwise, as the goals were on this date.
    r"
CREATE TABLE target_new (
    profile_id INTEGER NOT NULL REFERENCES profile (id) ON DELETE CASCADE,
    nutrient TEXT NOT NULL,
    value REAL NOT NULL,
    PRIMARY KEY (profile_id, nutrient)
);
INSERT INTO target_new
    SELECT profile_id, nutrient,
        CASE WHEN nutrient IN ('sodium', 'saturated', 'trans_fats', 'sugars', 'added_sugars',
                               'alcohol', 'caffeine', 'cholesterol', 'oxalate')
             THEN coalesce(max, min) ELSE coalesce(min, max) END
    FROM target
    WHERE coalesce(min, max) IS NOT NULL;
DROP TABLE target;
ALTER TABLE target_new RENAME TO target;
",
    // Child rows are read per parent: servings for every search result, items
    // for every recipe and meal. Fineli brought 20,000 servings.
    r"
CREATE INDEX serving_food ON serving (food_id);
CREATE INDEX recipe_item_recipe ON recipe_item (recipe_id);
CREATE INDEX meal_item_meal ON meal_item (meal_id);
",
    // Imported rows remember the group they were imported into, which keys
    // their day's total. Moving rows then never rewrites totals, so every
    // move can be undone exactly (see `group_totals`).
    r"
ALTER TABLE entry ADD COLUMN src_grp TEXT;
UPDATE entry SET src_grp = grp WHERE imported;
",
    // Workouts, shared like meals. Steps are a tree (moves, rests, loops)
    // always read and written whole, so they're one JSON column.
    r"
CREATE TABLE workout (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    steps TEXT NOT NULL
);
",
    // Workouts are built from a library of exercises, each done for reps or
    // held for a time; steps say the side and weight. The base set below is
    // built in, like Fineli for foods. Steps now reference exercises by id;
    // the few workouts that named their moves inline are dropped
    // (unreleased; the pre-migration snapshot keeps them).
    r"
CREATE TABLE exercise (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    kind TEXT NOT NULL CHECK (kind IN ('reps', 'time')),
    source TEXT NOT NULL DEFAULT 'custom' CHECK (source IN ('base', 'custom'))
);
DELETE FROM workout;
-- Your own estimates of a workout's energy and duration.
ALTER TABLE workout ADD COLUMN kcal INTEGER;
ALTER TABLE workout ADD COLUMN minutes INTEGER;
INSERT INTO exercise (name, kind, source) VALUES
    -- Calisthenics: pulling
    ('Pull-up', 'reps', 'base'),
    ('Chin-up', 'reps', 'base'),
    ('Neutral-grip pull-up', 'reps', 'base'),
    ('Wide-grip pull-up', 'reps', 'base'),
    ('Archer pull-up', 'reps', 'base'),
    ('Scapular pull-up', 'reps', 'base'),
    ('Negative pull-up', 'reps', 'base'),
    ('Muscle-up', 'reps', 'base'),
    ('Ring muscle-up', 'reps', 'base'),
    ('Inverted row', 'reps', 'base'),
    ('Ring row', 'reps', 'base'),
    ('Skin the cat', 'reps', 'base'),
    ('Front lever row', 'reps', 'base'),
    -- Calisthenics: pushing
    ('Push-up', 'reps', 'base'),
    ('Diamond push-up', 'reps', 'base'),
    ('Wide push-up', 'reps', 'base'),
    ('Incline push-up', 'reps', 'base'),
    ('Decline push-up', 'reps', 'base'),
    ('Knee push-up', 'reps', 'base'),
    ('Pike push-up', 'reps', 'base'),
    ('Archer push-up', 'reps', 'base'),
    ('Pseudo planche push-up', 'reps', 'base'),
    ('Clap push-up', 'reps', 'base'),
    ('Ring push-up', 'reps', 'base'),
    ('Handstand push-up', 'reps', 'base'),
    ('Dip', 'reps', 'base'),
    ('Ring dip', 'reps', 'base'),
    ('Bench dip', 'reps', 'base'),
    -- Calisthenics: legs
    ('Bodyweight squat', 'reps', 'base'),
    ('Jump squat', 'reps', 'base'),
    ('Pistol squat', 'reps', 'base'),
    ('Shrimp squat', 'reps', 'base'),
    ('Bulgarian split squat', 'reps', 'base'),
    ('Split squat', 'reps', 'base'),
    ('Lunge', 'reps', 'base'),
    ('Reverse lunge', 'reps', 'base'),
    ('Walking lunge', 'reps', 'base'),
    ('Jumping lunge', 'reps', 'base'),
    ('Step-up', 'reps', 'base'),
    ('Glute bridge', 'reps', 'base'),
    ('Single-leg glute bridge', 'reps', 'base'),
    ('Nordic hamstring curl', 'reps', 'base'),
    ('Calf raise', 'reps', 'base'),
    ('Box jump', 'reps', 'base'),
    ('Broad jump', 'reps', 'base'),
    -- Calisthenics: core
    ('Hanging knee raise', 'reps', 'base'),
    ('Hanging leg raise', 'reps', 'base'),
    ('Toes-to-bar', 'reps', 'base'),
    ('Lying leg raise', 'reps', 'base'),
    ('Sit-up', 'reps', 'base'),
    ('Crunch', 'reps', 'base'),
    ('Bicycle crunch', 'reps', 'base'),
    ('Russian twist', 'reps', 'base'),
    ('V-up', 'reps', 'base'),
    ('Ab wheel rollout', 'reps', 'base'),
    ('Dragon flag', 'reps', 'base'),
    ('Pallof press', 'reps', 'base'),
    ('Dead bug', 'reps', 'base'),
    ('Bird dog', 'reps', 'base'),
    ('Back extension', 'reps', 'base'),
    ('Mountain climber', 'reps', 'base'),
    ('Burpee', 'reps', 'base'),
    ('Jumping jack', 'reps', 'base'),
    -- Holds
    ('Plank', 'time', 'base'),
    ('Low plank', 'time', 'base'),
    ('Side plank', 'time', 'base'),
    ('Copenhagen plank', 'time', 'base'),
    ('Hollow body hold', 'time', 'base'),
    ('Superman hold', 'time', 'base'),
    ('L-sit', 'time', 'base'),
    ('Dead hang', 'time', 'base'),
    ('Flexed-arm hang', 'time', 'base'),
    ('Wall sit', 'time', 'base'),
    ('Handstand hold', 'time', 'base'),
    ('Support hold', 'time', 'base'),
    ('Front lever', 'time', 'base'),
    ('Back lever', 'time', 'base'),
    ('Planche lean', 'time', 'base'),
    ('Tuck planche', 'time', 'base'),
    ('Farmer''s carry', 'time', 'base'),
    ('Suitcase carry', 'time', 'base'),
    ('Jump rope', 'time', 'base'),
    ('Rowing', 'time', 'base'),
    -- Weightlifting: legs and hips
    ('Back squat', 'reps', 'base'),
    ('Front squat', 'reps', 'base'),
    ('Goblet squat', 'reps', 'base'),
    ('Overhead squat', 'reps', 'base'),
    ('Deadlift', 'reps', 'base'),
    ('Sumo deadlift', 'reps', 'base'),
    ('Trap bar deadlift', 'reps', 'base'),
    ('Romanian deadlift', 'reps', 'base'),
    ('Single-leg Romanian deadlift', 'reps', 'base'),
    ('Good morning', 'reps', 'base'),
    ('Hip thrust', 'reps', 'base'),
    ('Leg press', 'reps', 'base'),
    ('Leg extension', 'reps', 'base'),
    ('Leg curl', 'reps', 'base'),
    ('Kettlebell swing', 'reps', 'base'),
    -- Weightlifting: chest, shoulders, arms
    ('Bench press', 'reps', 'base'),
    ('Incline bench press', 'reps', 'base'),
    ('Decline bench press', 'reps', 'base'),
    ('Close-grip bench press', 'reps', 'base'),
    ('Dumbbell bench press', 'reps', 'base'),
    ('Dumbbell fly', 'reps', 'base'),
    ('Overhead press', 'reps', 'base'),
    ('Push press', 'reps', 'base'),
    ('Dumbbell shoulder press', 'reps', 'base'),
    ('Arnold press', 'reps', 'base'),
    ('Landmine press', 'reps', 'base'),
    ('Lateral raise', 'reps', 'base'),
    ('Front raise', 'reps', 'base'),
    ('Rear delt fly', 'reps', 'base'),
    ('Face pull', 'reps', 'base'),
    ('Upright row', 'reps', 'base'),
    ('Shrug', 'reps', 'base'),
    ('Bicep curl', 'reps', 'base'),
    ('Hammer curl', 'reps', 'base'),
    ('Preacher curl', 'reps', 'base'),
    ('Overhead tricep extension', 'reps', 'base'),
    ('Skull crusher', 'reps', 'base'),
    ('Tricep pushdown', 'reps', 'base'),
    -- Weightlifting: back
    ('Barbell row', 'reps', 'base'),
    ('Pendlay row', 'reps', 'base'),
    ('Dumbbell row', 'reps', 'base'),
    ('T-bar row', 'reps', 'base'),
    ('Seated cable row', 'reps', 'base'),
    ('Lat pulldown', 'reps', 'base'),
    -- Olympic and full body
    ('Clean', 'reps', 'base'),
    ('Power clean', 'reps', 'base'),
    ('Hang clean', 'reps', 'base'),
    ('Snatch', 'reps', 'base'),
    ('Power snatch', 'reps', 'base'),
    ('Clean and jerk', 'reps', 'base'),
    ('Thruster', 'reps', 'base'),
    ('Turkish get-up', 'reps', 'base');
",
    // What each exercise is, for search: equipment, pattern, muscles and
    // more, as JSON (see `ExerciseTraits`). The base set's come from
    // `exercises.json` on every start (`seed_exercises`).
    r"
ALTER TABLE exercise ADD COLUMN traits TEXT NOT NULL DEFAULT '{}';
",
    // Variants are exercises of their own, linked to their root move (one
    // level). Energy depends on who does a workout, so it's estimated per
    // profile, never stored.
    r"
ALTER TABLE exercise ADD COLUMN variant_of INTEGER REFERENCES exercise (id);
ALTER TABLE workout DROP COLUMN kcal;
",
    // Energy you set yourself for a workout, overriding the estimate (which
    // is per profile, from its weight).
    r"
ALTER TABLE workout ADD COLUMN kcal INTEGER;
",
    // Workouts done: one row per session, per profile, with its sets as
    // JSON (see `SessionSet`). The workout link goes if the workout does;
    // the name stays. Plus a weekly target for how often to train.
    r"
CREATE TABLE workout_session (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id INTEGER NOT NULL REFERENCES profile (id) ON DELETE CASCADE,
    day TEXT NOT NULL,
    workout_id INTEGER REFERENCES workout (id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    minutes INTEGER NOT NULL,
    kcal INTEGER,
    sets TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX workout_session_day ON workout_session (profile_id, day);
ALTER TABLE profile ADD COLUMN workouts_per_week INTEGER;
",
    // The API contract:
    // - `rev` on everything edited whole, so a stale update is refused
    //   instead of overwriting another tab's;
    // - client `uid`s on sessions, so a retried create saves once; a uid
    //   is unique within its profile, as it is looked up (entries too);
    // - the weight log, seeded with each profile's weight;
    // - entries keep the serving and quantity they were logged by;
    // - exercises say how they're measured (`measure`), and stored steps
    //   say `repeat` (the old `loop` alias goes);
    // - searches rank by one profile's logging (index).
    r#"
ALTER TABLE food ADD COLUMN rev INTEGER NOT NULL DEFAULT 1;
ALTER TABLE meal ADD COLUMN rev INTEGER NOT NULL DEFAULT 1;
ALTER TABLE exercise ADD COLUMN rev INTEGER NOT NULL DEFAULT 1;
ALTER TABLE workout ADD COLUMN rev INTEGER NOT NULL DEFAULT 1;
ALTER TABLE profile ADD COLUMN rev INTEGER NOT NULL DEFAULT 1;
ALTER TABLE workout_session ADD COLUMN rev INTEGER NOT NULL DEFAULT 1;

ALTER TABLE workout_session ADD COLUMN uid TEXT;
UPDATE workout_session SET uid = lower(hex(randomblob(16)));
CREATE UNIQUE INDEX workout_session_uid ON workout_session (profile_id, uid);
CREATE TRIGGER workout_session_uid AFTER INSERT ON workout_session WHEN NEW.uid IS NULL BEGIN
    UPDATE workout_session SET uid = lower(hex(randomblob(16))) WHERE id = NEW.id;
END;

CREATE TABLE weight (
    profile_id INTEGER NOT NULL REFERENCES profile (id) ON DELETE CASCADE,
    day TEXT NOT NULL,
    kg REAL NOT NULL,
    PRIMARY KEY (profile_id, day)
);
INSERT INTO weight (profile_id, day, kg)
    SELECT id, date('now'), weight_kg FROM profile WHERE weight_kg IS NOT NULL;

DROP INDEX entry_uid;
CREATE UNIQUE INDEX entry_uid ON entry (profile_id, uid);

ALTER TABLE entry ADD COLUMN serving TEXT;
ALTER TABLE entry ADD COLUMN quantity REAL;
CREATE INDEX entry_profile_food ON entry (profile_id, food_id);

ALTER TABLE exercise RENAME COLUMN kind TO measure;
UPDATE workout SET steps = replace(steps, '"kind":"loop"', '"kind":"repeat"');
"#,
    // Merging, portions, quick adds, times, plans and day records:
    // - foods can be merged away (deleted), so their ids must never be
    //   reused (a restore or a queued write would point at another food):
    //   rebuilt for AUTOINCREMENT, ids and uniques kept; recipes say how
    //   many portions they make;
    // - an entry is a logged food (or imported history) or a quick add, and
    //   may say when it was eaten ("HH:MM", display only);
    // - workouts planned on a day, a note per day, body measurements.
    r"
CREATE TABLE food_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    brand TEXT,
    barcode TEXT UNIQUE,
    source TEXT NOT NULL CHECK (source IN ('custom', 'off', 'recipe', 'fineli')),
    per100 TEXT NOT NULL DEFAULT '{}',
    cooked_g REAL,
    archived INTEGER NOT NULL DEFAULT 0,
    fineli_id INTEGER UNIQUE,
    rev INTEGER NOT NULL DEFAULT 1,
    makes INTEGER
);
INSERT INTO food_new (id, name, brand, barcode, source, per100, cooked_g, archived, fineli_id, rev)
    SELECT id, name, brand, barcode, source, per100, cooked_g, archived, fineli_id, rev FROM food;
DROP TABLE food;
ALTER TABLE food_new RENAME TO food;

ALTER TABLE entry ADD COLUMN kind TEXT NOT NULL DEFAULT 'food' CHECK (kind IN ('food', 'quick'));
ALTER TABLE entry ADD COLUMN time TEXT;

-- Gone when a session of its workout is saved that day, or by hand. uid:
-- the client's id for offline replay, unique per profile.
CREATE TABLE planned_workout (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id INTEGER NOT NULL REFERENCES profile (id) ON DELETE CASCADE,
    day TEXT NOT NULL,
    workout_id INTEGER NOT NULL REFERENCES workout (id) ON DELETE CASCADE,
    uid TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX planned_workout_day ON planned_workout (profile_id, day);
CREATE UNIQUE INDEX planned_workout_uid ON planned_workout (profile_id, uid);

CREATE TABLE day_note (
    profile_id INTEGER NOT NULL REFERENCES profile (id) ON DELETE CASCADE,
    day TEXT NOT NULL,
    text TEXT NOT NULL,
    PRIMARY KEY (profile_id, day)
);

CREATE TABLE measurement (
    profile_id INTEGER NOT NULL REFERENCES profile (id) ON DELETE CASCADE,
    day TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('waist', 'hips', 'chest')),
    value REAL NOT NULL,
    PRIMARY KEY (profile_id, day, kind)
);
",
    // Habits: trackers of your
    // own, counted by hand, one total per day. Ids are never reused (a
    // queued day write must not land on another tracker).
    r"
CREATE TABLE habit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id INTEGER NOT NULL REFERENCES profile (id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    unit TEXT NOT NULL,
    day_limit REAL,
    archived INTEGER NOT NULL DEFAULT 0,
    rev INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE UNIQUE INDEX habit_name ON habit (profile_id, name COLLATE NOCASE);

CREATE TABLE habit_day (
    habit_id INTEGER NOT NULL REFERENCES habit (id) ON DELETE CASCADE,
    day TEXT NOT NULL,
    amount REAL NOT NULL CHECK (amount > 0),
    PRIMARY KEY (habit_id, day)
);
CREATE INDEX habit_day_day ON habit_day (day);
",
    // Scale sync:
    // - a day's weight says where it came from, and when it was set
    //   (server time, epoch ms), so a replayed or late reading never
    //   overrides one typed after it; rows from before read `manual`, `NULL`;
    // - readings keyed by (source, the source's user, time): openScale's own
    //   ids are reused after a reinstall, so `source_id` is a plain column;
    // - each profile's connection: the openScale user bound to it, the
    //   users seen, and what the last POST did.
    r"
ALTER TABLE weight ADD COLUMN source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'scale'));
ALTER TABLE weight ADD COLUMN set_at INTEGER;

CREATE TABLE scale_reading (
    profile_id INTEGER NOT NULL REFERENCES profile (id) ON DELETE CASCADE,
    source TEXT NOT NULL,
    source_user INTEGER NOT NULL,
    taken_at INTEGER NOT NULL,
    source_id INTEGER,
    day TEXT NOT NULL,
    weight REAL NOT NULL,
    body_fat REAL,
    water REAL,
    muscle REAL,
    PRIMARY KEY (profile_id, source, source_user, taken_at)
);
CREATE INDEX scale_reading_day ON scale_reading (profile_id, day);
CREATE INDEX scale_reading_source_id ON scale_reading (profile_id, source, source_user, source_id);

CREATE TABLE sync_state (
    profile_id INTEGER NOT NULL REFERENCES profile (id) ON DELETE CASCADE,
    source TEXT NOT NULL,
    bound_user INTEGER,
    bound_username TEXT,
    seen_users TEXT NOT NULL DEFAULT '[]',
    last_seen INTEGER,
    last_result TEXT,
    PRIMARY KEY (profile_id, source)
);
",
    // Health Connect sync: each day's active energy and steps,
    // and the watch's workouts, replaced a window of days at a time. Shown,
    // never added to targets;
    // watch workouts are not `workout_session` rows. The sync's status is a
    // `sync_state` row with source `health_connect`.
    r"
CREATE TABLE activity_day (
    profile_id INTEGER NOT NULL REFERENCES profile (id) ON DELETE CASCADE,
    day TEXT NOT NULL,
    active_kcal INTEGER,
    steps INTEGER,
    PRIMARY KEY (profile_id, day)
);

-- source_key: Health Connect's record id. day: the phone's local day of
-- start_at. Times are UTC RFC 3339; type is Health Connect's exercise type.
CREATE TABLE activity_session (
    profile_id INTEGER NOT NULL REFERENCES profile (id) ON DELETE CASCADE,
    source_key TEXT NOT NULL,
    day TEXT NOT NULL,
    start_at TEXT NOT NULL,
    end_at TEXT NOT NULL,
    type INTEGER NOT NULL,
    name TEXT NOT NULL,
    kcal INTEGER,
    PRIMARY KEY (profile_id, source_key)
);
CREATE INDEX activity_session_day ON activity_session (profile_id, day);
",
    // Water, recipe instructions and a weight goal:
    // - the food a profile's "+ Water" logs (`NULL`: the default one), let go
    //   when the food is;
    // - a recipe's method, free text;
    // - the weight a profile aims for;
    // - a plain Water food, once, when there is no Fineli water to default
    //   to (a seed at every start would return after you merge it away).
    r#"
ALTER TABLE profile ADD COLUMN water_food_id INTEGER REFERENCES food (id) ON DELETE SET NULL;
ALTER TABLE profile ADD COLUMN goal_weight_kg REAL;
ALTER TABLE food ADD COLUMN instructions TEXT;

INSERT INTO food (name, source, per100)
    SELECT 'Water', 'custom', '{"energy":0.0,"water":100.0}'
    WHERE NOT EXISTS (
        SELECT 1 FROM food WHERE source = 'fineli'
            AND (lower(name) IN ('vesi', 'vesijohtovesi') OR lower(name) LIKE 'vesi, %')
    );
"#,
    // Health Connect 2:
    // - each synced day's resting heart rate, HRV and the night that ended
    //   it (minutes in bed, asleep and per stage; local "HH:MM" times);
    // - watch workouts' distance and recording method (2: detected by the
    //   watch itself);
    // - sessions gain a type (NULL: set-based), distance, start (UTC) and
    //   where they came from; `source_key` is the Health Connect record a
    //   session holds, promoted from the watch or claimed by a hand log;
    // - tombstones: watch workouts deleted or dismissed, never promoted
    //   again (type and start catch a re-id'd copy);
    // - whether new watch workouts are added or wait to be.
    // Schema only: the first auto sync promotes the stored watch workouts.
    r"
ALTER TABLE activity_day ADD COLUMN resting_hr INTEGER;
ALTER TABLE activity_day ADD COLUMN hrv_ms INTEGER;
ALTER TABLE activity_day ADD COLUMN asleep_min INTEGER;
ALTER TABLE activity_day ADD COLUMN in_bed_min INTEGER;
ALTER TABLE activity_day ADD COLUMN bedtime TEXT;
ALTER TABLE activity_day ADD COLUMN wake_time TEXT;
ALTER TABLE activity_day ADD COLUMN deep_min INTEGER;
ALTER TABLE activity_day ADD COLUMN rem_min INTEGER;
ALTER TABLE activity_day ADD COLUMN light_min INTEGER;
ALTER TABLE activity_session ADD COLUMN distance_m INTEGER;
ALTER TABLE activity_session ADD COLUMN recording_method INTEGER NOT NULL DEFAULT 0;

ALTER TABLE workout_session ADD COLUMN type TEXT
    CHECK (type IN ('run', 'cycling', 'swim', 'walk', 'hike', 'other'));
ALTER TABLE workout_session ADD COLUMN distance_m INTEGER CHECK (distance_m >= 0);
ALTER TABLE workout_session ADD COLUMN start_at TEXT;
ALTER TABLE workout_session ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'
    CHECK (source IN ('manual', 'health_connect'));
ALTER TABLE workout_session ADD COLUMN source_key TEXT;
CREATE UNIQUE INDEX workout_session_source_key
    ON workout_session (profile_id, source_key) WHERE source_key IS NOT NULL;

CREATE TABLE workout_tombstone (
    profile_id INTEGER NOT NULL REFERENCES profile (id) ON DELETE CASCADE,
    source_key TEXT NOT NULL,
    type TEXT,
    start_at TEXT,
    PRIMARY KEY (profile_id, source_key)
);

ALTER TABLE profile ADD COLUMN synced_workouts TEXT NOT NULL DEFAULT 'auto'
    CHECK (synced_workouts IN ('auto', 'ask'));
",
    // Daily check-ins: how the day felt, 1–5 each, and a few lowercase tags
    // (built-ins from /api/meta or your own), one row per profile and day.
    // The server stores tags as it serialises them, so `[]` is the only
    // empty spelling; the row check counts them anyway.
    r"
CREATE TABLE check_in (
    profile_id INTEGER NOT NULL REFERENCES profile (id) ON DELETE CASCADE,
    day TEXT NOT NULL,
    mood INTEGER CHECK (mood BETWEEN 1 AND 5),
    energy INTEGER CHECK (energy BETWEEN 1 AND 5),
    stress INTEGER CHECK (stress BETWEEN 1 AND 5),
    tags TEXT NOT NULL DEFAULT '[]'
        CHECK (json_valid(tags) AND json_type(tags) = 'array'),
    CHECK (mood IS NOT NULL OR energy IS NOT NULL OR stress IS NOT NULL
           OR json_array_length(tags) > 0),
    PRIMARY KEY (profile_id, day)
);
",
    // Goals and built-in habits, 28–33.
    // 28: the weight lives in the log only. A profile's own weight
    // with nothing logged is logged first, on `date('now')`: UTC, accepted
    // (a profile without any weigh-in has no better day).
    r"
INSERT INTO weight (profile_id, day, kg, source)
    SELECT id, date('now'), weight_kg, 'manual' FROM profile
    WHERE weight_kg IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM weight WHERE profile_id = profile.id);
ALTER TABLE profile DROP COLUMN weight_kg;
",
    // 29: one home for goals. A target names a metric: a
    // nutrient or a goal (`model::METRICS`); the weekly workouts and the
    // goal weight move in from the profile. Steps and sleep get no rows:
    // their defaults apply without one. A habit's limit becomes its
    // goal, at most; a goal may now point the other way. Profiles move
    // on a revision: a client holding the old shape reloads.
    r"
ALTER TABLE target RENAME COLUMN nutrient TO metric;
INSERT INTO target (profile_id, metric, value)
    SELECT id, 'workouts_per_week', workouts_per_week FROM profile
    WHERE workouts_per_week IS NOT NULL;
INSERT INTO target (profile_id, metric, value)
    SELECT id, 'goal_weight', goal_weight_kg FROM profile WHERE goal_weight_kg IS NOT NULL;
ALTER TABLE profile DROP COLUMN workouts_per_week;
ALTER TABLE profile DROP COLUMN goal_weight_kg;
ALTER TABLE habit RENAME COLUMN day_limit TO goal_value;
ALTER TABLE habit ADD COLUMN goal_dir TEXT NOT NULL DEFAULT 'at_most'
    CHECK (goal_dir IN ('at_least', 'at_most'));
UPDATE profile SET rev = rev + 1;
",
    // 30: a weight's source names the sync it came from, as
    // `sync_state.source` does: `scale` is `openscale`. Rebuilt to
    // change the check.
    r"
CREATE TABLE weight_new (
    profile_id INTEGER NOT NULL REFERENCES profile (id) ON DELETE CASCADE,
    day TEXT NOT NULL,
    kg REAL NOT NULL,
    source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'openscale')),
    set_at INTEGER,
    PRIMARY KEY (profile_id, day)
);
INSERT INTO weight_new (profile_id, day, kg, source, set_at)
    SELECT profile_id, day, kg, CASE source WHEN 'scale' THEN 'openscale' ELSE source END, set_at
    FROM weight;
DROP TABLE weight;
ALTER TABLE weight_new RENAME TO weight;
",
    // 31: quick adds are gone. Each distinct one (name and values)
    // becomes an archived food of your own; its entries point at it,
    // keeping their nutrients and amount text, so no day's total moves.
    // Per 100 g it is the nutrients over the entry's grams (100 without),
    // or over more grams where that keeps every value within the per-100
    // caps (`nutrients::PER100_MAX`, frozen here as they were); the entry
    // takes those grams.
    r"
CREATE TEMP TABLE quick AS
SELECT e.id, e.name, (
    SELECT max(coalesce(e.grams, 100.0), coalesce(max(j.value * 100.0 / CASE
        WHEN j.key = 'energy' THEN 900.0
        WHEN j.key = 'vitamin_d' THEN 4000000000.0
        WHEN j.key IN ('vitamin_a', 'b12', 'folate', 'vitamin_k', 'selenium') THEN 100000000.0
        WHEN j.key IN ('caffeine', 'oxalate', 'phytate', 'cholesterol', 'b1', 'b2', 'b3',
                       'b5', 'b6', 'vitamin_c', 'vitamin_e', 'sodium', 'potassium',
                       'calcium', 'magnesium', 'phosphorus', 'iron', 'zinc', 'copper',
                       'manganese') THEN 100000.0
        ELSE 100.0 END) * 1.000000001, 0.0))
    FROM json_each(e.nutrients) j
) AS g
FROM entry e WHERE e.kind = 'quick';
CREATE TEMP TABLE quick_food AS
SELECT q.id, q.name, q.g, (
    SELECT json_group_object(j.key, j.value * 100.0 / q.g)
    FROM entry e, json_each(e.nutrients) j WHERE e.id = q.id
) AS per100
FROM quick q;
INSERT INTO food (name, source, per100, archived)
    SELECT name, 'custom', per100, 1 FROM quick_food GROUP BY name, per100 ORDER BY min(id);
UPDATE entry SET
    food_id = (
        SELECT f.id FROM quick_food q
        JOIN food f ON f.name = q.name AND f.per100 = q.per100 AND f.source = 'custom'
            AND f.archived
        WHERE q.id = entry.id ORDER BY f.id DESC LIMIT 1),
    grams = (SELECT g FROM quick_food WHERE id = entry.id)
WHERE kind = 'quick';
DROP TABLE quick_food;
DROP TABLE quick;
ALTER TABLE entry DROP COLUMN kind;
",
    // 32: food categories for the built-in habits: a key
    // from the server's vocabulary (checked in the model), and whether the
    // importer owns it (your first change takes it over, so a re-import
    // never overwrites your choice; see 34).
    r"
ALTER TABLE food ADD COLUMN category TEXT;
ALTER TABLE food ADD COLUMN category_auto INTEGER NOT NULL DEFAULT 0;
CREATE INDEX food_category ON food (category);
",
    // 33: only a whole session (a run, a ride) has a distance.
    r"
UPDATE workout_session SET distance_m = NULL WHERE type IS NULL;
",
    // 34: a Fineli food without a category is still the importer's (32
    // left those unowned, so a re-import couldn't tell them from cleared).
    r"
UPDATE food SET category_auto = 1 WHERE source = 'fineli' AND category IS NULL;
",
];
