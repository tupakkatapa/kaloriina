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
    // 35: which databases hold a food (/api/meta asks on every start).
    r"
CREATE INDEX food_source ON food (source);
",
    // 36: a plain Creatine monohydrate (the `creatine` nutrient, as
    // labelled) to log the built-in from, once (as Water in 25), unless a
    // live food of that name is already there; a 3 g dose. No stored food
    // could hold `creatine` before, so the serving goes to the seed only.
    r#"
INSERT INTO food (name, source, per100)
    SELECT 'Creatine monohydrate', 'custom', '{"creatine":100.0,"energy":0.0}'
    WHERE NOT EXISTS (
        SELECT 1 FROM food WHERE name = 'Creatine monohydrate' COLLATE NOCASE AND NOT archived
    );
INSERT INTO serving (food_id, label, grams)
    SELECT id, 'Dose', 3.0 FROM food
    WHERE source = 'custom' AND json_extract(per100, '$.creatine') IS NOT NULL;
"#,
    // 37: a recipe or meal item remembers how it was measured, as an entry
    // does: `quantity` of its food's serving `serving`, or grams when both
    // are NULL. Grams stay what counts.
    r"
ALTER TABLE recipe_item ADD COLUMN serving TEXT;
ALTER TABLE recipe_item ADD COLUMN quantity REAL;
ALTER TABLE meal_item ADD COLUMN serving TEXT;
ALTER TABLE meal_item ADD COLUMN quantity REAL;
",
    // 38: a Google Health import's own values per day, `activity_day`'s
    // columns. `activity_day` is what shows: a Health Connect sync replaces
    // its window there, then these fill what it left empty again, so a
    // sync never erases another source's value.
    r"
CREATE TABLE activity_import (
    profile_id INTEGER NOT NULL REFERENCES profile (id) ON DELETE CASCADE,
    day TEXT NOT NULL,
    active_kcal INTEGER,
    steps INTEGER,
    resting_hr INTEGER,
    hrv_ms INTEGER,
    asleep_min INTEGER,
    in_bed_min INTEGER,
    bedtime TEXT,
    wake_time TEXT,
    deep_min INTEGER,
    rem_min INTEGER,
    light_min INTEGER,
    PRIMARY KEY (profile_id, day)
);
",
    // 39: a recipe's instructions are its notes: any kind, how it's made
    // among them.
    r"
ALTER TABLE food RENAME COLUMN instructions TO notes;
",
    // 40: the serving a food's values were typed for (they're kept per 100
    // g, `NULL`: typed per 100 g) and whether its weight is a guess.
    r"
ALTER TABLE food ADD COLUMN basis TEXT;
ALTER TABLE food ADD COLUMN basis_estimated INTEGER NOT NULL DEFAULT 0;
",
    // 41: every session has a type; a set-based one (NULL) is a workout.
    // The vocabulary lives in `SessionType` (as metrics do, ADR 0016), so
    // the rebuild drops the CHECK; indexes, the uid trigger and the
    // AUTOINCREMENT counter (a deleted session's id stays used) carry over.
    r"
CREATE TABLE workout_session_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id INTEGER NOT NULL REFERENCES profile (id) ON DELETE CASCADE,
    day TEXT NOT NULL,
    workout_id INTEGER REFERENCES workout (id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    minutes INTEGER NOT NULL,
    kcal INTEGER,
    sets TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    rev INTEGER NOT NULL DEFAULT 1,
    uid TEXT,
    type TEXT NOT NULL,
    distance_m INTEGER CHECK (distance_m >= 0),
    start_at TEXT,
    source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'health_connect')),
    source_key TEXT
);
INSERT INTO workout_session_new (id, profile_id, day, workout_id, name, minutes, kcal, sets,
                                 created_at, rev, uid, type, distance_m, start_at, source,
                                 source_key)
    SELECT id, profile_id, day, workout_id, name, minutes, kcal, sets, created_at, rev, uid,
           coalesce(type, 'workout'), distance_m, start_at, source, source_key
    FROM workout_session;
DELETE FROM sqlite_sequence WHERE name = 'workout_session_new';
UPDATE sqlite_sequence SET name = 'workout_session_new' WHERE name = 'workout_session';
DROP TABLE workout_session;
ALTER TABLE workout_session_new RENAME TO workout_session;
CREATE INDEX workout_session_day ON workout_session (profile_id, day);
CREATE UNIQUE INDEX workout_session_uid ON workout_session (profile_id, uid);
CREATE TRIGGER workout_session_uid AFTER INSERT ON workout_session WHEN NEW.uid IS NULL BEGIN
    UPDATE workout_session SET uid = lower(hex(randomblob(16))) WHERE id = NEW.id;
END;
CREATE UNIQUE INDEX workout_session_source_key
    ON workout_session (profile_id, source_key) WHERE source_key IS NOT NULL;
",
    // 42: connections keep everything (ADR 0019).
    // - `health_record`: every record a source sent, as sent (JSON), upserted
    //   and never deleted or read by the app: an archive that travels in
    //   backups, not in exports. No index beyond its key.
    // - A device workout's average and peak heart rate, raw and on sessions.
    // - Where a session's energy came from (`hand`, `device`, `import`):
    //   a sync refreshes only what no hand typed. Rows before: a synced
    //   session's is the device's, an imported one's (`gh-` key) the
    //   import's, any other the hand's.
    // - Everything the scale measured; Health Connect's weigh-ins as readings
    //   of their own (`weight.source` rebuilt to allow them).
    // - Naps: sleep blocks too short to be a night, by wake day.
    r"
CREATE TABLE health_record (
    profile_id INTEGER NOT NULL REFERENCES profile (id) ON DELETE CASCADE,
    source TEXT NOT NULL,
    kind TEXT NOT NULL,
    record_id TEXT NOT NULL,
    start_at TEXT,
    end_at TEXT,
    day TEXT,
    data TEXT NOT NULL CHECK (json_valid(data)),
    received_at INTEGER NOT NULL,
    PRIMARY KEY (profile_id, source, kind, record_id)
) WITHOUT ROWID;

ALTER TABLE activity_session ADD COLUMN avg_hr INTEGER;
ALTER TABLE activity_session ADD COLUMN max_hr INTEGER;
ALTER TABLE workout_session ADD COLUMN avg_hr INTEGER;
ALTER TABLE workout_session ADD COLUMN max_hr INTEGER;
ALTER TABLE workout_session ADD COLUMN kcal_source TEXT;
UPDATE workout_session SET kcal_source = CASE
    WHEN source = 'health_connect' THEN 'device'
    WHEN source_key LIKE 'gh-%' THEN 'import'
    ELSE 'hand' END
WHERE kcal IS NOT NULL;

ALTER TABLE scale_reading ADD COLUMN bone_kg REAL;
ALTER TABLE scale_reading ADD COLUMN lbm_kg REAL;
ALTER TABLE scale_reading ADD COLUMN visceral_fat REAL;
ALTER TABLE scale_reading ADD COLUMN bmr_kcal REAL;

CREATE TABLE weight_new (
    profile_id INTEGER NOT NULL REFERENCES profile (id) ON DELETE CASCADE,
    day TEXT NOT NULL,
    kg REAL NOT NULL,
    source TEXT NOT NULL DEFAULT 'manual'
        CHECK (source IN ('manual', 'openscale', 'health_connect')),
    set_at INTEGER,
    PRIMARY KEY (profile_id, day)
);
INSERT INTO weight_new (profile_id, day, kg, source, set_at)
    SELECT profile_id, day, kg, source, set_at FROM weight;
DROP TABLE weight;
ALTER TABLE weight_new RENAME TO weight;

CREATE TABLE nap (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id INTEGER NOT NULL REFERENCES profile (id) ON DELETE CASCADE,
    uid TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))),
    day TEXT NOT NULL,
    start_at TEXT NOT NULL,
    end_at TEXT NOT NULL,
    source TEXT NOT NULL,
    source_key TEXT,
    UNIQUE (profile_id, uid),
    UNIQUE (profile_id, source_key)
);
CREATE INDEX nap_day ON nap (profile_id, day);
",
    // 43: the energy model (ADR 0020).
    // - A goal date: the other way to say how fast, beside kg a week.
    // - A day's total energy burned as the device counted it (Health
    //   Connect's TotalCaloriesBurned), shown and imported alike.
    r"
ALTER TABLE profile ADD COLUMN goal_date TEXT;
ALTER TABLE activity_day ADD COLUMN total_kcal INTEGER;
ALTER TABLE activity_import ADD COLUMN total_kcal INTEGER;
",
    // 44: Summary insights (ADR 0021).
    // - A profile's latitude, for the winter vitamin D tip.
    // - EPA+DHA, derived as their sum wherever either is known, stored so
    //   SQL (nutrient sources, search rules) reads it like any other.
    r"
ALTER TABLE profile ADD COLUMN latitude REAL;
UPDATE food SET per100 = json_set(per100, '$.epa_dha',
        coalesce(json_extract(per100, '$.epa'), 0) + coalesce(json_extract(per100, '$.dha'), 0))
    WHERE json_extract(per100, '$.epa') IS NOT NULL OR json_extract(per100, '$.dha') IS NOT NULL;
UPDATE entry SET nutrients = json_set(nutrients, '$.epa_dha',
        coalesce(json_extract(nutrients, '$.epa'), 0) + coalesce(json_extract(nutrients, '$.dha'), 0))
    WHERE json_extract(nutrients, '$.epa') IS NOT NULL OR json_extract(nutrients, '$.dha') IS NOT NULL;
UPDATE day_total SET nutrients = json_set(nutrients, '$.epa_dha',
        coalesce(json_extract(nutrients, '$.epa'), 0) + coalesce(json_extract(nutrients, '$.dha'), 0))
    WHERE json_extract(nutrients, '$.epa') IS NOT NULL OR json_extract(nutrients, '$.dha') IS NOT NULL;
",
    // 45: diary and editing polish (ADR 0023).
    // - Daily items: a food and amount due in Planned every day from
    //   `start` until ticked (an entry linked for that day) or skipped. Due
    //   days are computed, never stored.
    // - Workouts are archived, not deleted, once a session or plan used
    //   them.
    r"
CREATE TABLE daily_item (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id INTEGER NOT NULL REFERENCES profile (id) ON DELETE CASCADE,
    food_id INTEGER NOT NULL REFERENCES food (id),
    grams REAL NOT NULL CHECK (grams > 0),
    serving TEXT,
    quantity REAL,
    start TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX daily_item_profile ON daily_item (profile_id);
CREATE INDEX daily_item_food ON daily_item (food_id);
CREATE TABLE daily_skip (
    daily_item_id INTEGER NOT NULL REFERENCES daily_item (id) ON DELETE CASCADE,
    day TEXT NOT NULL,
    PRIMARY KEY (daily_item_id, day)
);
ALTER TABLE entry ADD COLUMN daily_item_id INTEGER REFERENCES daily_item (id) ON DELETE SET NULL;
CREATE UNIQUE INDEX entry_daily_item ON entry (daily_item_id, day) WHERE daily_item_id IS NOT NULL;
ALTER TABLE workout ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
",
    // 46: photos and feedback (ADR 0022).
    // - Photos on a day and group, their bytes in the row: they travel in
    //   backups, not in exports. Ids never reused (served immutable).
    // - Feedback for the instance's maintainer, pulled by the CLI.
    // - A Fineli food's ingredient class (`IGCLASS`: `BEEF`, `POTATO`), for
    //   All time; filled by the next `kaloriina fineli`.
    r"
ALTER TABLE food ADD COLUMN fineli_class TEXT;
CREATE TABLE photo (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id INTEGER NOT NULL REFERENCES profile (id) ON DELETE CASCADE,
    uid TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))),
    day TEXT NOT NULL,
    grp TEXT NOT NULL,
    entry_id INTEGER REFERENCES entry (id) ON DELETE SET NULL,
    taken_at INTEGER NOT NULL,
    mime TEXT NOT NULL CHECK (mime IN ('image/jpeg', 'image/webp')),
    bytes BLOB NOT NULL,
    UNIQUE (profile_id, uid)
);
CREATE INDEX photo_day ON photo (profile_id, day);
CREATE INDEX photo_entry ON photo (entry_id);
CREATE TABLE feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK (kind IN ('bug', 'feature')),
    text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 4000),
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'pulled')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
",
    // 47: outbound hooks (ADR 0024): a profile's Home Assistant webhook.
    // `kind`'s vocabulary is the model's; `events` a JSON array of event
    // names, `last_result` how the last call went (JSON). Not exported.
    r"
CREATE TABLE hook (
    profile_id INTEGER NOT NULL REFERENCES profile (id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    url TEXT NOT NULL,
    webhook_id TEXT NOT NULL,
    events TEXT NOT NULL DEFAULT '[]',
    last_result TEXT,
    PRIMARY KEY (profile_id, kind)
);
",
    // 48: sleep stages and the day's heart rate (ADR 0019 amendment).
    // - A night's stage spans, one row per span on its wake day; `stage`'s
    //   vocabulary is the model's. A sync replaces its source's spans in
    //   its window, as it does naps.
    // - The day's average, lowest and highest heart rate and the night's
    //   average, synced and imported alike.
    r"
CREATE TABLE sleep_stage (
    profile_id INTEGER NOT NULL REFERENCES profile (id) ON DELETE CASCADE,
    day TEXT NOT NULL,
    start_at TEXT NOT NULL,
    end_at TEXT NOT NULL,
    stage TEXT NOT NULL,
    source TEXT NOT NULL,
    PRIMARY KEY (profile_id, source, start_at)
);
CREATE INDEX sleep_stage_day ON sleep_stage (profile_id, day);
ALTER TABLE activity_day ADD COLUMN avg_hr INTEGER;
ALTER TABLE activity_day ADD COLUMN min_hr INTEGER;
ALTER TABLE activity_day ADD COLUMN max_hr INTEGER;
ALTER TABLE activity_day ADD COLUMN sleep_avg_hr INTEGER;
ALTER TABLE activity_import ADD COLUMN avg_hr INTEGER;
ALTER TABLE activity_import ADD COLUMN min_hr INTEGER;
ALTER TABLE activity_import ADD COLUMN max_hr INTEGER;
ALTER TABLE activity_import ADD COLUMN sleep_avg_hr INTEGER;
",
    // 49: a workout's notes, shown on each step of a run. Note blocks need
    // no migration: they live in the steps JSON.
    r"
ALTER TABLE workout ADD COLUMN notes TEXT;
",
    // 50: what shows is read, not copied (polish 3).
    // - `activity_day` holds the device's values only: a value equal to that
    //   day's import is the import's copy and goes (the read falls back to
    //   the import per column, so the same number shows); the night goes as
    //   a group, only when the whole night is the import's. Days left empty
    //   go.
    // - The phone's last records outcome, beside its last sync.
    // - The scale's visceral fat rating: never shown, the raw record keeps
    //   it.
    r"
UPDATE activity_day SET
    in_bed_min = NULL, asleep_min = NULL, bedtime = NULL, wake_time = NULL,
    deep_min = NULL, rem_min = NULL, light_min = NULL, sleep_avg_hr = NULL
WHERE in_bed_min IS NOT NULL AND EXISTS (
    SELECT 1 FROM activity_import i
    WHERE i.profile_id = activity_day.profile_id AND i.day = activity_day.day
      AND i.in_bed_min IS activity_day.in_bed_min AND i.asleep_min IS activity_day.asleep_min
      AND i.bedtime IS activity_day.bedtime AND i.wake_time IS activity_day.wake_time
      AND i.deep_min IS activity_day.deep_min AND i.rem_min IS activity_day.rem_min
      AND i.light_min IS activity_day.light_min AND i.sleep_avg_hr IS activity_day.sleep_avg_hr);
UPDATE activity_day SET
    active_kcal = CASE WHEN activity_day.active_kcal = i.active_kcal THEN NULL ELSE activity_day.active_kcal END,
    total_kcal = CASE WHEN activity_day.total_kcal = i.total_kcal THEN NULL ELSE activity_day.total_kcal END,
    steps = CASE WHEN activity_day.steps = i.steps THEN NULL ELSE activity_day.steps END,
    resting_hr = CASE WHEN activity_day.resting_hr = i.resting_hr THEN NULL ELSE activity_day.resting_hr END,
    hrv_ms = CASE WHEN activity_day.hrv_ms = i.hrv_ms THEN NULL ELSE activity_day.hrv_ms END,
    avg_hr = CASE WHEN activity_day.avg_hr = i.avg_hr THEN NULL ELSE activity_day.avg_hr END,
    min_hr = CASE WHEN activity_day.min_hr = i.min_hr THEN NULL ELSE activity_day.min_hr END,
    max_hr = CASE WHEN activity_day.max_hr = i.max_hr THEN NULL ELSE activity_day.max_hr END
FROM activity_import i
WHERE i.profile_id = activity_day.profile_id AND i.day = activity_day.day;
DELETE FROM activity_day
WHERE active_kcal IS NULL AND total_kcal IS NULL AND steps IS NULL AND resting_hr IS NULL
  AND hrv_ms IS NULL AND avg_hr IS NULL AND min_hr IS NULL AND max_hr IS NULL
  AND in_bed_min IS NULL AND asleep_min IS NULL AND bedtime IS NULL AND wake_time IS NULL
  AND deep_min IS NULL AND rem_min IS NULL AND light_min IS NULL AND sleep_avg_hr IS NULL;
ALTER TABLE sync_state ADD COLUMN records_result TEXT CHECK (json_valid(records_result));
ALTER TABLE scale_reading DROP COLUMN visceral_fat;
",
    // 51: photos and hooks without what no client uses (polish 3).
    // - A photo is placed by its day and group alone: `entry_id` and its
    //   index go. JPEG only: a WebP photo (never sent by a client) goes.
    //   Served by `uid`, so the ids a restore rewinds are never in a URL.
    // - One Home Assistant hook per profile: `kind` goes.
    r"
CREATE TABLE photo_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id INTEGER NOT NULL REFERENCES profile (id) ON DELETE CASCADE,
    uid TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))),
    day TEXT NOT NULL,
    grp TEXT NOT NULL,
    taken_at INTEGER NOT NULL,
    mime TEXT NOT NULL CHECK (mime = 'image/jpeg'),
    bytes BLOB NOT NULL,
    UNIQUE (profile_id, uid)
);
INSERT INTO photo_new (id, profile_id, uid, day, grp, taken_at, mime, bytes)
SELECT id, profile_id, uid, day, grp, taken_at, mime, bytes FROM photo
WHERE mime = 'image/jpeg';
DROP TABLE photo;
ALTER TABLE photo_new RENAME TO photo;
CREATE INDEX photo_day ON photo (profile_id, day);
CREATE TABLE hook_new (
    profile_id INTEGER PRIMARY KEY REFERENCES profile (id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    webhook_id TEXT NOT NULL,
    events TEXT NOT NULL DEFAULT '[]',
    last_result TEXT
);
INSERT INTO hook_new (profile_id, url, webhook_id, events, last_result)
SELECT profile_id, url, webhook_id, events, last_result FROM hook
WHERE kind = 'home-assistant';
DROP TABLE hook;
ALTER TABLE hook_new RENAME TO hook;
",
    // 52: import provenance and stale servings (polish 3).
    // - A Google Health import's sessions are `google_health`, apart from
    //   hand logs that claimed an imported workout (`manual`, `gh-` key):
    //   removing the import removes the former only. The rebuild widens
    //   `source`'s CHECK; columns, indexes, the uid trigger and the
    //   AUTOINCREMENT counter carry over (as in 41). Before, both were
    //   `manual`: a `gh-` session counts as the import's only when it is as
    //   the import wrote it (a claim always bumps `rev`: `rev = 1`, no sets,
    //   no energy typed by hand). One edited since stays `manual` and is
    //   kept when the import goes.
    // - A recipe, meal or daily item whose serving its food no longer has
    //   is measured in grams (what a serving edit does since).
    r"
CREATE TABLE workout_session_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id INTEGER NOT NULL REFERENCES profile (id) ON DELETE CASCADE,
    day TEXT NOT NULL,
    workout_id INTEGER REFERENCES workout (id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    minutes INTEGER NOT NULL,
    kcal INTEGER,
    sets TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    rev INTEGER NOT NULL DEFAULT 1,
    uid TEXT,
    type TEXT NOT NULL,
    distance_m INTEGER CHECK (distance_m >= 0),
    start_at TEXT,
    source TEXT NOT NULL DEFAULT 'manual'
        CHECK (source IN ('manual', 'health_connect', 'google_health')),
    source_key TEXT,
    avg_hr INTEGER,
    max_hr INTEGER,
    kcal_source TEXT
);
INSERT INTO workout_session_new (id, profile_id, day, workout_id, name, minutes, kcal, sets,
                                 created_at, rev, uid, type, distance_m, start_at, source,
                                 source_key, avg_hr, max_hr, kcal_source)
    SELECT id, profile_id, day, workout_id, name, minutes, kcal, sets, created_at, rev, uid,
           type, distance_m, start_at,
           CASE WHEN source = 'manual' AND source_key LIKE 'gh-%' AND rev = 1 AND sets = '[]'
                     AND kcal_source IS NOT 'hand'
                THEN 'google_health' ELSE source END,
           source_key, avg_hr, max_hr, kcal_source
    FROM workout_session;
DELETE FROM sqlite_sequence WHERE name = 'workout_session_new';
UPDATE sqlite_sequence SET name = 'workout_session_new' WHERE name = 'workout_session';
DROP TABLE workout_session;
ALTER TABLE workout_session_new RENAME TO workout_session;
CREATE INDEX workout_session_day ON workout_session (profile_id, day);
CREATE UNIQUE INDEX workout_session_uid ON workout_session (profile_id, uid);
CREATE TRIGGER workout_session_uid AFTER INSERT ON workout_session WHEN NEW.uid IS NULL BEGIN
    UPDATE workout_session SET uid = lower(hex(randomblob(16))) WHERE id = NEW.id;
END;
CREATE UNIQUE INDEX workout_session_source_key
    ON workout_session (profile_id, source_key) WHERE source_key IS NOT NULL;

UPDATE recipe_item SET serving = NULL, quantity = NULL
WHERE serving IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM serving s WHERE s.food_id = recipe_item.food_id AND s.label = recipe_item.serving);
UPDATE meal_item SET serving = NULL, quantity = NULL
WHERE serving IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM serving s WHERE s.food_id = meal_item.food_id AND s.label = meal_item.serving);
UPDATE daily_item SET serving = NULL, quantity = NULL
WHERE serving IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM serving s WHERE s.food_id = daily_item.food_id AND s.label = daily_item.serving);
",
    // 53: the eaten group is `Eaten`, the word `kcal_eaten` and the UI use
    // (polish 3; `Consumed` stays accepted on input). An amount text no
    // longer marks a guessed weight with "≈" (`weight_estimated` does);
    // imported rows keep their export's text. An imported day that already
    // has an `Eaten` total (a Cronometer group of that name) gets one: its
    // rows are one group now, so the two totals are summed per nutrient.
    r"
UPDATE entry SET grp = 'Eaten' WHERE grp = 'Consumed';
UPDATE entry SET src_grp = 'Eaten' WHERE src_grp = 'Consumed';
UPDATE entry SET amount = replace(amount, '≈', '') WHERE NOT imported AND amount LIKE '%≈%';
UPDATE day_total SET nutrients = (
    SELECT json_group_object(key, v) FROM (
        SELECT key, sum(value) AS v FROM (
            SELECT key, value FROM json_each(day_total.nutrients)
            UNION ALL
            SELECT j.key, j.value FROM day_total c, json_each(c.nutrients) j
            WHERE c.profile_id = day_total.profile_id AND c.day = day_total.day
              AND c.grp = 'Consumed')
        GROUP BY key))
WHERE grp = 'Eaten' AND EXISTS (
    SELECT 1 FROM day_total c
    WHERE c.profile_id = day_total.profile_id AND c.day = day_total.day AND c.grp = 'Consumed');
DELETE FROM day_total WHERE grp = 'Consumed' AND EXISTS (
    SELECT 1 FROM day_total e
    WHERE e.profile_id = day_total.profile_id AND e.day = day_total.day AND e.grp = 'Eaten');
UPDATE day_total SET grp = 'Eaten' WHERE grp = 'Consumed';
UPDATE photo SET grp = 'Eaten' WHERE grp = 'Consumed';
",
    // 54: an entry is imported history when it names its import group
    // (`src_grp`); the `imported` flag said the same twice. A flagged row
    // without its group takes the one it's in, an unflagged row's group
    // goes (it was your own), then the flag goes.
    r"
UPDATE entry SET src_grp = grp WHERE imported AND src_grp IS NULL;
UPDATE entry SET src_grp = NULL WHERE NOT imported;
ALTER TABLE entry DROP COLUMN imported;
",
    // 55: a nap's time asleep: its span less the awake
    // stages, when the source had stages; NULL (only in bed is known) for
    // every stored one until its sync or import sends it again. A nap
    // logged by hand reads as asleep throughout.
    r"
ALTER TABLE nap ADD COLUMN asleep_min INTEGER CHECK (asleep_min >= 0);
",
    // 56: one provenance vocabulary (ADR 0019 amendment): `hand`,
    // `import`, or the device by name. `manual` is `hand` (weight, session,
    // nap); a Google Health session's `google_health` is `import`; a
    // session's energy from the device (`device`) is `health_connect`.
    // A recipe is a food's `kind`, not its source: a recipe row is
    // `custom`, kind `recipe`. `weight`, `workout_session` and `food` are
    // rebuilt for their CHECKs; columns, indexes, triggers and the
    // AUTOINCREMENT counters carry over (as in 52).
    r"
UPDATE nap SET source = 'hand' WHERE source = 'manual';
UPDATE workout_session SET kcal_source = 'health_connect' WHERE kcal_source = 'device';

CREATE TABLE weight_new (
    profile_id INTEGER NOT NULL REFERENCES profile (id) ON DELETE CASCADE,
    day TEXT NOT NULL,
    kg REAL NOT NULL,
    source TEXT NOT NULL DEFAULT 'hand'
        CHECK (source IN ('hand', 'openscale', 'health_connect')),
    set_at INTEGER,
    PRIMARY KEY (profile_id, day)
);
INSERT INTO weight_new (profile_id, day, kg, source, set_at)
    SELECT profile_id, day, kg, CASE source WHEN 'manual' THEN 'hand' ELSE source END, set_at
    FROM weight;
DROP TABLE weight;
ALTER TABLE weight_new RENAME TO weight;

CREATE TABLE workout_session_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id INTEGER NOT NULL REFERENCES profile (id) ON DELETE CASCADE,
    day TEXT NOT NULL,
    workout_id INTEGER REFERENCES workout (id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    minutes INTEGER NOT NULL,
    kcal INTEGER,
    sets TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    rev INTEGER NOT NULL DEFAULT 1,
    uid TEXT,
    type TEXT NOT NULL,
    distance_m INTEGER CHECK (distance_m >= 0),
    start_at TEXT,
    source TEXT NOT NULL DEFAULT 'hand'
        CHECK (source IN ('hand', 'health_connect', 'import')),
    source_key TEXT,
    avg_hr INTEGER,
    max_hr INTEGER,
    kcal_source TEXT
);
INSERT INTO workout_session_new (id, profile_id, day, workout_id, name, minutes, kcal, sets,
                                 created_at, rev, uid, type, distance_m, start_at, source,
                                 source_key, avg_hr, max_hr, kcal_source)
    SELECT id, profile_id, day, workout_id, name, minutes, kcal, sets, created_at, rev, uid,
           type, distance_m, start_at,
           CASE source WHEN 'manual' THEN 'hand' WHEN 'google_health' THEN 'import'
                ELSE source END,
           source_key, avg_hr, max_hr, kcal_source
    FROM workout_session;
DELETE FROM sqlite_sequence WHERE name = 'workout_session_new';
UPDATE sqlite_sequence SET name = 'workout_session_new' WHERE name = 'workout_session';
DROP TABLE workout_session;
ALTER TABLE workout_session_new RENAME TO workout_session;
CREATE INDEX workout_session_day ON workout_session (profile_id, day);
CREATE UNIQUE INDEX workout_session_uid ON workout_session (profile_id, uid);
CREATE TRIGGER workout_session_uid AFTER INSERT ON workout_session WHEN NEW.uid IS NULL BEGIN
    UPDATE workout_session SET uid = lower(hex(randomblob(16))) WHERE id = NEW.id;
END;
CREATE UNIQUE INDEX workout_session_source_key
    ON workout_session (profile_id, source_key) WHERE source_key IS NOT NULL;

CREATE TABLE food_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    brand TEXT,
    barcode TEXT UNIQUE,
    source TEXT NOT NULL CHECK (source IN ('custom', 'off', 'fineli')),
    kind TEXT NOT NULL DEFAULT 'food' CHECK (kind IN ('food', 'recipe')),
    per100 TEXT NOT NULL DEFAULT '{}',
    cooked_g REAL,
    archived INTEGER NOT NULL DEFAULT 0,
    fineli_id INTEGER UNIQUE,
    rev INTEGER NOT NULL DEFAULT 1,
    makes INTEGER,
    notes TEXT,
    category TEXT,
    category_auto INTEGER NOT NULL DEFAULT 0,
    basis TEXT,
    basis_estimated INTEGER NOT NULL DEFAULT 0,
    fineli_class TEXT
);
INSERT INTO food_new (id, name, brand, barcode, source, kind, per100, cooked_g, archived,
                      fineli_id, rev, makes, notes, category, category_auto, basis,
                      basis_estimated, fineli_class)
    SELECT id, name, brand, barcode,
           CASE source WHEN 'recipe' THEN 'custom' ELSE source END,
           CASE source WHEN 'recipe' THEN 'recipe' ELSE 'food' END,
           per100, cooked_g, archived, fineli_id, rev, makes, notes, category, category_auto,
           basis, basis_estimated, fineli_class
    FROM food;
DELETE FROM sqlite_sequence WHERE name = 'food_new';
UPDATE sqlite_sequence SET name = 'food_new' WHERE name = 'food';
DROP TABLE food;
ALTER TABLE food_new RENAME TO food;
CREATE INDEX food_category ON food (category);
CREATE INDEX food_source ON food (source);
",
    // 57: a profile's insight preferences (ADR 0021 amendment, scannable
    // cards), by the insight's stable id: hidden until a day (YYYY-MM-DD,
    // the client's; "Hide for 2 weeks") or pinned ("Interesting"), never
    // both.
    r"
CREATE TABLE insight_pref (
    profile_id INTEGER NOT NULL REFERENCES profile (id) ON DELETE CASCADE,
    insight_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('hidden', 'pinned')),
    until TEXT,
    CHECK ((state = 'hidden') = (until IS NOT NULL)),
    PRIMARY KEY (profile_id, insight_id)
);
",
    // 58: total carbohydrate is carbohydrate plus fibre; with fibre unknown
    // the save derived each from the other as an equal copy (fibre taken
    // as 0). Which was typed isn't known: carbohydrate
    // stays (the macro every total reads), the copied total goes (unknown,
    // "–"). Entries' snapshots alike; recipes are recomputed in `migrate`.
    r"
UPDATE food SET per100 = json_remove(per100, '$.carbs')
WHERE json_type(per100, '$.fiber') IS NULL
  AND json_extract(per100, '$.carbs') = json_extract(per100, '$.net_carbs');
UPDATE entry SET nutrients = json_remove(nutrients, '$.carbs')
WHERE nutrients IS NOT NULL
  AND json_type(nutrients, '$.fiber') IS NULL
  AND json_extract(nutrients, '$.carbs') = json_extract(nutrients, '$.net_carbs');
",
    // 59: one word per thing (ADR 0027). What you did is an
    // `activity` (was `workout_session`); the device's raw workouts are
    // `device_session` (was `activity_session`) and its days `device_day`
    // (was `activity_day`). A pure rename: columns, rows, ids and the
    // AUTOINCREMENT counter carry over; indexes and the uid trigger take
    // the new names.
    r"
ALTER TABLE workout_session RENAME TO activity;
DROP INDEX workout_session_day;
DROP INDEX workout_session_uid;
DROP INDEX workout_session_source_key;
DROP TRIGGER workout_session_uid;
CREATE INDEX activity_profile_day ON activity (profile_id, day);
CREATE UNIQUE INDEX activity_uid ON activity (profile_id, uid);
CREATE TRIGGER activity_uid AFTER INSERT ON activity WHEN NEW.uid IS NULL BEGIN
    UPDATE activity SET uid = lower(hex(randomblob(16))) WHERE id = NEW.id;
END;
CREATE UNIQUE INDEX activity_source_key
    ON activity (profile_id, source_key) WHERE source_key IS NOT NULL;

ALTER TABLE activity_session RENAME TO device_session;
DROP INDEX activity_session_day;
CREATE INDEX device_session_day ON device_session (profile_id, day);

ALTER TABLE activity_day RENAME TO device_day;
",
    // 60: an activity's sets as rows: history, bests and last
    // done are queries, not scans of JSON. Each set keeps its exercise's
    // name, so one of an exercise deleted (before, or since: SET NULL)
    // still reads. `idx` is its place in the activity. The JSON goes.
    r"
CREATE TABLE activity_set (
    activity_id INTEGER NOT NULL REFERENCES activity (id) ON DELETE CASCADE,
    idx INTEGER NOT NULL,
    exercise_id INTEGER REFERENCES exercise (id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    reps INTEGER,
    seconds INTEGER,
    kg REAL,
    side TEXT,
    PRIMARY KEY (activity_id, idx)
);
CREATE INDEX activity_set_exercise ON activity_set (exercise_id);
INSERT INTO activity_set (activity_id, idx, exercise_id, name, reps, seconds, kg, side)
    SELECT a.id, s.key,
           (SELECT e.id FROM exercise e WHERE e.id = json_extract(s.value, '$.exercise_id')),
           coalesce(json_extract(s.value, '$.name'), ''),
           json_extract(s.value, '$.reps'), json_extract(s.value, '$.seconds'),
           json_extract(s.value, '$.kg'), json_extract(s.value, '$.side')
    FROM activity a, json_each(a.sets) s;
ALTER TABLE activity DROP COLUMN sets;
",
    // 61: a food's drink and hydration flags (ADR 0025): `drink` reads its
    // values per 100 ml and judges them by the drink thresholds;
    // `hydrates` counts it toward hydration. Both follow the importers and
    // the values unless set by hand (`*_set`). Its labels are stored, one
    // row a label, for search to filter (written by `db::foods`); `meta`
    // keeps the label rules' version they were made by. An entry's energy,
    // water, caffeine and alcohol become columns, kept with its snapshot by
    // triggers, for All time's sums, which an index covers.
    r"
ALTER TABLE food ADD COLUMN drink INTEGER NOT NULL DEFAULT 0;
ALTER TABLE food ADD COLUMN drink_set INTEGER NOT NULL DEFAULT 0;
ALTER TABLE food ADD COLUMN hydrates INTEGER NOT NULL DEFAULT 0;
ALTER TABLE food ADD COLUMN hydrates_set INTEGER NOT NULL DEFAULT 0;
CREATE TABLE food_label (
    food_id INTEGER NOT NULL REFERENCES food (id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    PRIMARY KEY (label, food_id)
) WITHOUT ROWID;
CREATE INDEX food_label_food ON food_label (food_id);
CREATE TABLE meta (
    key TEXT PRIMARY KEY,
    value
) WITHOUT ROWID;
ALTER TABLE entry ADD COLUMN energy REAL;
ALTER TABLE entry ADD COLUMN water REAL;
ALTER TABLE entry ADD COLUMN caffeine REAL;
ALTER TABLE entry ADD COLUMN alcohol REAL;
CREATE INDEX entry_totals
    ON entry (profile_id, grp, food_id, grams, energy, water, caffeine, alcohol);
CREATE TRIGGER entry_scalars_insert AFTER INSERT ON entry WHEN NEW.nutrients IS NOT NULL BEGIN
    UPDATE entry SET energy = json_extract(NEW.nutrients, '$.energy'),
        water = json_extract(NEW.nutrients, '$.water'),
        caffeine = json_extract(NEW.nutrients, '$.caffeine'),
        alcohol = json_extract(NEW.nutrients, '$.alcohol')
    WHERE id = NEW.id;
END;
CREATE TRIGGER entry_scalars_update AFTER UPDATE OF nutrients ON entry BEGIN
    UPDATE entry SET energy = json_extract(NEW.nutrients, '$.energy'),
        water = json_extract(NEW.nutrients, '$.water'),
        caffeine = json_extract(NEW.nutrients, '$.caffeine'),
        alcohol = json_extract(NEW.nutrients, '$.alcohol')
    WHERE id = NEW.id;
END;
",
    // 62, backfill: entries' columns; drinks are sugary drinks, a Water of
    // your own, a profile's water food, and Fineli foods of a beverage
    // ingredient class (the use class Fineli's import reads isn't kept);
    // what hydrates has a water value or is a drink. Labels are written at
    // the next start (no rules version yet).
    r"
UPDATE entry SET energy = json_extract(nutrients, '$.energy'),
    water = json_extract(nutrients, '$.water'),
    caffeine = json_extract(nutrients, '$.caffeine'),
    alcohol = json_extract(nutrients, '$.alcohol')
WHERE nutrients IS NOT NULL;
UPDATE food SET drink = 1
WHERE category = 'sugary_drinks'
   OR (source = 'custom' AND kind = 'food' AND name = 'Water' COLLATE NOCASE)
   OR id IN (SELECT water_food_id FROM profile)
   OR (source = 'fineli' AND fineli_class IN ('ALCOTH', 'BEER', 'CIDER', 'COFFEE', 'DRINKART',
       'DRINKCO', 'DRINKOTH', 'DRSPORT', 'FBDRINK', 'JUICE', 'MILKFF', 'MILKHF', 'MILKLF',
       'SDRINK', 'SOURMILK', 'SPIRIT', 'TEA', 'VEGJUICE', 'WATER', 'WINE'));
UPDATE food SET hydrates = json_type(per100, '$.water') IS NOT NULL OR drink;
",
    // 63: a food served by volume ("250 ml", "0.5 l",
    // "33 cl", "1 dl": a number, then the unit, as `drink_by_kind` reads
    // it) is a drink unless set by hand, and a drink hydrates unless set by
    // hand. Soft drinks of your own had no category and counted 0. Recipes
    // are recomputed after it (a cooked weight's change is water) and
    // relabelled at the next start (label rules 2).
    r"
UPDATE food SET drink = 1
WHERE NOT drink AND NOT drink_set AND EXISTS (
    SELECT 1 FROM serving s,
        (SELECT 'ml' AS unit UNION ALL SELECT 'cl' UNION ALL SELECT 'dl' UNION ALL SELECT 'l') v
    WHERE s.food_id = food.id
        AND lower(trim(s.label)) LIKE '%' || v.unit
        AND rtrim(substr(lower(trim(s.label)), 1, length(trim(s.label)) - length(v.unit)))
            GLOB '[0-9]*'
        AND rtrim(substr(lower(trim(s.label)), 1, length(trim(s.label)) - length(v.unit)))
            NOT GLOB '*[^0-9.,]*');
UPDATE food SET hydrates = 1 WHERE drink AND NOT hydrates_set;
",
    // 64: a device workout's total energy (resting included), sent when the
    // device wrote no active energy over it (one that writes total
    // energy only). A session given it says `health_connect_total`.
    "ALTER TABLE device_session ADD COLUMN kcal_total INTEGER;",
    // 65 (ADR 0020 rework): one Drink tick. What hydrates is read from a
    // food's values (its water; a drink's estimated), so `hydrates` goes.
    // Drinks are derived again by the wider rule after it ("0,33 l
    // bottle", "1 cocktail"; a gravy's "1 dl" is none).
    r"
ALTER TABLE food DROP COLUMN hydrates;
ALTER TABLE food DROP COLUMN hydrates_set;
",
    // 66: `entry`, `meal` and `serving` never hand an id out
    // again (AUTOINCREMENT): a stale tab's Delete or rev'd save of a
    // deleted row is a 404, never another row's. Copying the ids sets
    // `sqlite_sequence`. Each keeps its indexes and the entry uid trigger;
    // `entry` drops the energy, water, caffeine and alcohol copies
    // (nothing reads them), their two triggers and `entry_totals`.
    r"
CREATE TABLE entry_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id INTEGER NOT NULL REFERENCES profile (id) ON DELETE CASCADE,
    day TEXT NOT NULL,
    grp TEXT NOT NULL,
    food_id INTEGER REFERENCES food (id),
    name TEXT NOT NULL,
    grams REAL,
    amount TEXT NOT NULL,
    nutrients TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    uid TEXT,
    src_grp TEXT,
    serving TEXT,
    quantity REAL,
    time TEXT,
    daily_item_id INTEGER REFERENCES daily_item (id) ON DELETE SET NULL
);
INSERT INTO entry_new (id, profile_id, day, grp, food_id, name, grams, amount, nutrients,
                       created_at, uid, src_grp, serving, quantity, time, daily_item_id)
    SELECT id, profile_id, day, grp, food_id, name, grams, amount, nutrients,
           created_at, uid, src_grp, serving, quantity, time, daily_item_id
    FROM entry;
DROP TABLE entry;
ALTER TABLE entry_new RENAME TO entry;
CREATE INDEX entry_day ON entry (profile_id, day);
CREATE INDEX entry_food ON entry (food_id);
CREATE UNIQUE INDEX entry_uid ON entry (profile_id, uid);
CREATE INDEX entry_profile_food ON entry (profile_id, food_id);
CREATE UNIQUE INDEX entry_daily_item ON entry (daily_item_id, day) WHERE daily_item_id IS NOT NULL;
CREATE TRIGGER entry_uid AFTER INSERT ON entry WHEN NEW.uid IS NULL BEGIN
    UPDATE entry SET uid = lower(hex(randomblob(16))) WHERE id = NEW.id;
END;

CREATE TABLE meal_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    rev INTEGER NOT NULL DEFAULT 1
);
INSERT INTO meal_new (id, name, rev) SELECT id, name, rev FROM meal;
DROP TABLE meal;
ALTER TABLE meal_new RENAME TO meal;

CREATE TABLE serving_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    food_id INTEGER NOT NULL REFERENCES food (id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    grams REAL NOT NULL
);
INSERT INTO serving_new (id, food_id, label, grams) SELECT id, food_id, label, grams FROM serving;
DROP TABLE serving;
ALTER TABLE serving_new RENAME TO serving;
CREATE INDEX serving_food ON serving (food_id);
",
    // 67: a create's own key, so a retried one answers the first
    // instead of making a second. Shared rows' are unique; a habit's per
    // profile, as an entry's. Optional: rows made before have none.
    r"
ALTER TABLE food ADD COLUMN uid TEXT;
CREATE UNIQUE INDEX food_uid ON food (uid);
ALTER TABLE meal ADD COLUMN uid TEXT;
CREATE UNIQUE INDEX meal_uid ON meal (uid);
ALTER TABLE workout ADD COLUMN uid TEXT;
CREATE UNIQUE INDEX workout_uid ON workout (uid);
ALTER TABLE exercise ADD COLUMN uid TEXT;
CREATE UNIQUE INDEX exercise_uid ON exercise (uid);
ALTER TABLE profile ADD COLUMN uid TEXT;
CREATE UNIQUE INDEX profile_uid ON profile (uid);
ALTER TABLE habit ADD COLUMN uid TEXT;
CREATE UNIQUE INDEX habit_uid ON habit (profile_id, uid);
",
    // 68: a day's resting energy from Health Connect (`bmr_kcal`, kcal a
    // day) and the app that wrote it (`bmr_origin`), on both day tables,
    // which share their columns; a Takeout day's table says what it is
    // (`import_day`), and a device workout's total energy is
    // `total_kcal` as a day's is (the sync wire keeps `kcal_total`: it is
    // the phone's contract, and renaming it would need both at once).
    r"
ALTER TABLE device_day ADD COLUMN bmr_kcal REAL;
ALTER TABLE device_day ADD COLUMN bmr_origin TEXT;
ALTER TABLE activity_import RENAME TO import_day;
ALTER TABLE import_day ADD COLUMN bmr_kcal REAL;
ALTER TABLE import_day ADD COLUMN bmr_origin TEXT;
ALTER TABLE device_session RENAME COLUMN kcal_total TO total_kcal;
",
    // 69: a day's distance from Health Connect's distance records
    // (`distance_m`, whole metres), on both day tables, which share their
    // columns.
    r"
ALTER TABLE device_day ADD COLUMN distance_m INTEGER;
ALTER TABLE import_day ADD COLUMN distance_m INTEGER;
",
    // 70: `health_record` as a rowid table: its rows (a kilobyte and more)
    // fill whole pages of their own instead of overflowing the key's, written
    // in kind and day order, and a kind's days are found by index.
    r"
CREATE TABLE health_record_new (
    profile_id INTEGER NOT NULL REFERENCES profile (id) ON DELETE CASCADE,
    source TEXT NOT NULL,
    kind TEXT NOT NULL,
    record_id TEXT NOT NULL,
    start_at TEXT,
    end_at TEXT,
    day TEXT,
    data TEXT NOT NULL CHECK (json_valid(data)),
    received_at INTEGER NOT NULL,
    UNIQUE (profile_id, source, kind, record_id)
);
INSERT INTO health_record_new
    SELECT profile_id, source, kind, record_id, start_at, end_at, day, data, received_at
    FROM health_record ORDER BY profile_id, source, kind, day, start_at, record_id;
DROP TABLE health_record;
ALTER TABLE health_record_new RENAME TO health_record;
CREATE INDEX health_record_day ON health_record (profile_id, source, kind, day);
",
];
