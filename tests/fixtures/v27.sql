-- A v27 database (the schema before goals and built-in habits) with one row
-- in every table: db::tests::v27_fixture_matches_the_migrations guards it;
-- the VM rollback drill starts from it. Regenerate only by hand, never from
-- live data.
PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;
CREATE TABLE serving (
    id INTEGER PRIMARY KEY,
    food_id INTEGER NOT NULL REFERENCES food (id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    grams REAL NOT NULL
);
INSERT INTO serving VALUES(1,100,'Cup',80.0);
CREATE TABLE recipe_item (
    recipe_id INTEGER NOT NULL REFERENCES food (id) ON DELETE CASCADE,
    food_id INTEGER NOT NULL REFERENCES food (id),
    grams REAL NOT NULL
);
INSERT INTO recipe_item VALUES(101,100,80.0);
CREATE TABLE meal (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL
, rev INTEGER NOT NULL DEFAULT 1);
INSERT INTO meal VALUES(1,'Snack',1);
CREATE TABLE meal_item (
    meal_id INTEGER NOT NULL REFERENCES meal (id) ON DELETE CASCADE,
    food_id INTEGER NOT NULL REFERENCES food (id),
    grams REAL NOT NULL
);
INSERT INTO meal_item VALUES(1,100,30.0);
CREATE TABLE IF NOT EXISTS "entry" (
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
, src_grp TEXT, serving TEXT, quantity REAL, kind TEXT NOT NULL DEFAULT 'food' CHECK (kind IN ('food', 'quick')), time TEXT);
INSERT INTO entry VALUES(1,1,'2026-10-01','Consumed',100,'Oats',50.0,'50 g','{"energy":185}',0,'2026-10-09T03:43:05Z','entry-food-0001',NULL,NULL,NULL,'food',NULL);
INSERT INTO entry VALUES(2,1,'2026-10-01','Consumed',NULL,'Snack',NULL,'Quick add','{"energy":250}',0,'2026-10-09T03:43:05Z','entry-quick-0001',NULL,NULL,NULL,'quick',NULL);
CREATE TABLE IF NOT EXISTS "day_total" (
    profile_id INTEGER NOT NULL REFERENCES profile (id) ON DELETE CASCADE,
    day TEXT NOT NULL,
    grp TEXT NOT NULL,
    nutrients TEXT NOT NULL,
    PRIMARY KEY (profile_id, day, grp)
);
INSERT INTO day_total VALUES(1,'2026-06-02','Lunch','{"energy":500}');
CREATE TABLE IF NOT EXISTS "profile" (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    sex TEXT CHECK (sex IN ('female', 'male')),
    birth_date TEXT,
    height_cm REAL,
    weight_kg REAL,
    activity REAL,
    goal_kg_per_week REAL NOT NULL DEFAULT 0
, workouts_per_week INTEGER, rev INTEGER NOT NULL DEFAULT 1, water_food_id INTEGER REFERENCES food (id) ON DELETE SET NULL, goal_weight_kg REAL, synced_workouts TEXT NOT NULL DEFAULT 'auto'
    CHECK (synced_workouts IN ('auto', 'ask')));
INSERT INTO profile VALUES(1,'Me','female','1990-05-01',170.0,68.5,1.600000000000000088,0.0,3,1,100,65.0,'ask');
CREATE TABLE favorite (
    profile_id INTEGER NOT NULL REFERENCES profile (id) ON DELETE CASCADE,
    food_id INTEGER NOT NULL REFERENCES food (id),
    PRIMARY KEY (profile_id, food_id)
);
INSERT INTO favorite VALUES(1,100);
CREATE TABLE IF NOT EXISTS "target" (
    profile_id INTEGER NOT NULL REFERENCES profile (id) ON DELETE CASCADE,
    nutrient TEXT NOT NULL,
    value REAL NOT NULL,
    PRIMARY KEY (profile_id, nutrient)
);
INSERT INTO target VALUES(1,'energy',2100.0);
CREATE TABLE workout (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    steps TEXT NOT NULL
, minutes INTEGER, kcal INTEGER, rev INTEGER NOT NULL DEFAULT 1);
INSERT INTO workout VALUES(1,'Pulls','[{"kind":"exercise","exercise_id":1,"reps":5}]',NULL,NULL,1);
CREATE TABLE exercise (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    measure TEXT NOT NULL CHECK (measure IN ('reps', 'time')),
    source TEXT NOT NULL DEFAULT 'custom' CHECK (source IN ('base', 'custom'))
, traits TEXT NOT NULL DEFAULT '{}', variant_of INTEGER REFERENCES exercise (id), rev INTEGER NOT NULL DEFAULT 1);
INSERT INTO exercise VALUES(1,'Pull-up','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(2,'Chin-up','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(3,'Neutral-grip pull-up','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(4,'Wide-grip pull-up','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(5,'Archer pull-up','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(6,'Scapular pull-up','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(7,'Negative pull-up','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(8,'Muscle-up','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(9,'Ring muscle-up','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(10,'Inverted row','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(11,'Ring row','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(12,'Skin the cat','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(13,'Front lever row','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(14,'Push-up','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(15,'Diamond push-up','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(16,'Wide push-up','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(17,'Incline push-up','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(18,'Decline push-up','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(19,'Knee push-up','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(20,'Pike push-up','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(21,'Archer push-up','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(22,'Pseudo planche push-up','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(23,'Clap push-up','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(24,'Ring push-up','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(25,'Handstand push-up','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(26,'Dip','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(27,'Ring dip','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(28,'Bench dip','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(29,'Bodyweight squat','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(30,'Jump squat','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(31,'Pistol squat','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(32,'Shrimp squat','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(33,'Bulgarian split squat','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(34,'Split squat','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(35,'Lunge','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(36,'Reverse lunge','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(37,'Walking lunge','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(38,'Jumping lunge','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(39,'Step-up','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(40,'Glute bridge','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(41,'Single-leg glute bridge','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(42,'Nordic hamstring curl','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(43,'Calf raise','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(44,'Box jump','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(45,'Broad jump','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(46,'Hanging knee raise','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(47,'Hanging leg raise','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(48,'Toes-to-bar','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(49,'Lying leg raise','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(50,'Sit-up','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(51,'Crunch','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(52,'Bicycle crunch','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(53,'Russian twist','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(54,'V-up','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(55,'Ab wheel rollout','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(56,'Dragon flag','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(57,'Pallof press','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(58,'Dead bug','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(59,'Bird dog','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(60,'Back extension','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(61,'Mountain climber','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(62,'Burpee','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(63,'Jumping jack','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(64,'Plank','time','base','{}',NULL,1);
INSERT INTO exercise VALUES(65,'Low plank','time','base','{}',NULL,1);
INSERT INTO exercise VALUES(66,'Side plank','time','base','{}',NULL,1);
INSERT INTO exercise VALUES(67,'Copenhagen plank','time','base','{}',NULL,1);
INSERT INTO exercise VALUES(68,'Hollow body hold','time','base','{}',NULL,1);
INSERT INTO exercise VALUES(69,'Superman hold','time','base','{}',NULL,1);
INSERT INTO exercise VALUES(70,'L-sit','time','base','{}',NULL,1);
INSERT INTO exercise VALUES(71,'Dead hang','time','base','{}',NULL,1);
INSERT INTO exercise VALUES(72,'Flexed-arm hang','time','base','{}',NULL,1);
INSERT INTO exercise VALUES(73,'Wall sit','time','base','{}',NULL,1);
INSERT INTO exercise VALUES(74,'Handstand hold','time','base','{}',NULL,1);
INSERT INTO exercise VALUES(75,'Support hold','time','base','{}',NULL,1);
INSERT INTO exercise VALUES(76,'Front lever','time','base','{}',NULL,1);
INSERT INTO exercise VALUES(77,'Back lever','time','base','{}',NULL,1);
INSERT INTO exercise VALUES(78,'Planche lean','time','base','{}',NULL,1);
INSERT INTO exercise VALUES(79,'Tuck planche','time','base','{}',NULL,1);
INSERT INTO exercise VALUES(80,'Farmer''s carry','time','base','{}',NULL,1);
INSERT INTO exercise VALUES(81,'Suitcase carry','time','base','{}',NULL,1);
INSERT INTO exercise VALUES(82,'Jump rope','time','base','{}',NULL,1);
INSERT INTO exercise VALUES(83,'Rowing','time','base','{}',NULL,1);
INSERT INTO exercise VALUES(84,'Back squat','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(85,'Front squat','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(86,'Goblet squat','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(87,'Overhead squat','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(88,'Deadlift','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(89,'Sumo deadlift','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(90,'Trap bar deadlift','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(91,'Romanian deadlift','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(92,'Single-leg Romanian deadlift','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(93,'Good morning','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(94,'Hip thrust','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(95,'Leg press','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(96,'Leg extension','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(97,'Leg curl','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(98,'Kettlebell swing','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(99,'Bench press','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(100,'Incline bench press','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(101,'Decline bench press','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(102,'Close-grip bench press','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(103,'Dumbbell bench press','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(104,'Dumbbell fly','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(105,'Overhead press','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(106,'Push press','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(107,'Dumbbell shoulder press','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(108,'Arnold press','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(109,'Landmine press','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(110,'Lateral raise','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(111,'Front raise','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(112,'Rear delt fly','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(113,'Face pull','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(114,'Upright row','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(115,'Shrug','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(116,'Bicep curl','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(117,'Hammer curl','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(118,'Preacher curl','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(119,'Overhead tricep extension','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(120,'Skull crusher','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(121,'Tricep pushdown','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(122,'Barbell row','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(123,'Pendlay row','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(124,'Dumbbell row','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(125,'T-bar row','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(126,'Seated cable row','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(127,'Lat pulldown','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(128,'Clean','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(129,'Power clean','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(130,'Hang clean','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(131,'Snatch','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(132,'Power snatch','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(133,'Clean and jerk','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(134,'Thruster','reps','base','{}',NULL,1);
INSERT INTO exercise VALUES(135,'Turkish get-up','reps','base','{}',NULL,1);
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
, rev INTEGER NOT NULL DEFAULT 1, uid TEXT, type TEXT
    CHECK (type IN ('run', 'cycling', 'swim', 'walk', 'hike', 'other')), distance_m INTEGER CHECK (distance_m >= 0), start_at TEXT, source TEXT NOT NULL DEFAULT 'manual'
    CHECK (source IN ('manual', 'health_connect')), source_key TEXT);
INSERT INTO workout_session VALUES(1,1,'2026-10-01',1,'Pulls',20,NULL,'[{"exercise_id":1,"name":"Pull-up","reps":5}]','2026-10-09T03:43:05Z',1,'session-0001',NULL,500,NULL,'manual',NULL);
CREATE TABLE weight (
    profile_id INTEGER NOT NULL REFERENCES profile (id) ON DELETE CASCADE,
    day TEXT NOT NULL,
    kg REAL NOT NULL, source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'scale')), set_at INTEGER,
    PRIMARY KEY (profile_id, day)
);
INSERT INTO weight VALUES(1,'2026-10-01',68.5,'scale',1790000000000);
CREATE TABLE IF NOT EXISTS "food" (
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
, instructions TEXT);
INSERT INTO food VALUES(1,'Water',NULL,NULL,'custom','{"energy":0.0,"water":100.0}',NULL,0,NULL,1,NULL,NULL);
INSERT INTO food VALUES(100,'Oats',NULL,'6410000000017','custom','{"energy":370,"protein":13}',NULL,0,NULL,1,NULL,NULL);
INSERT INTO food VALUES(101,'Porridge',NULL,NULL,'recipe','{"energy":100}',NULL,0,NULL,1,2,NULL);
CREATE TABLE planned_workout (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id INTEGER NOT NULL REFERENCES profile (id) ON DELETE CASCADE,
    day TEXT NOT NULL,
    workout_id INTEGER NOT NULL REFERENCES workout (id) ON DELETE CASCADE,
    uid TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
INSERT INTO planned_workout VALUES(1,1,'2026-10-10',1,'plan-0001','2026-10-09T03:43:05Z');
CREATE TABLE day_note (
    profile_id INTEGER NOT NULL REFERENCES profile (id) ON DELETE CASCADE,
    day TEXT NOT NULL,
    text TEXT NOT NULL,
    PRIMARY KEY (profile_id, day)
);
INSERT INTO day_note VALUES(1,'2026-10-01','Slept well');
CREATE TABLE measurement (
    profile_id INTEGER NOT NULL REFERENCES profile (id) ON DELETE CASCADE,
    day TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('waist', 'hips', 'chest')),
    value REAL NOT NULL,
    PRIMARY KEY (profile_id, day, kind)
);
INSERT INTO measurement VALUES(1,'2026-10-01','waist',80.0);
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
INSERT INTO habit VALUES(1,1,'Snus','pouches',6.0,0,1,'2026-10-09T03:43:05Z');
CREATE TABLE habit_day (
    habit_id INTEGER NOT NULL REFERENCES habit (id) ON DELETE CASCADE,
    day TEXT NOT NULL,
    amount REAL NOT NULL CHECK (amount > 0),
    PRIMARY KEY (habit_id, day)
);
INSERT INTO habit_day VALUES(1,'2026-10-01',4.0);
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
INSERT INTO scale_reading VALUES(1,'openscale',1,1790000000000,4,'2026-10-01',68.5,NULL,NULL,NULL);
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
INSERT INTO sync_state VALUES(1,'openscale',1,'Alex','[]',NULL,NULL);
CREATE TABLE activity_day (
    profile_id INTEGER NOT NULL REFERENCES profile (id) ON DELETE CASCADE,
    day TEXT NOT NULL,
    active_kcal INTEGER,
    steps INTEGER, resting_hr INTEGER, hrv_ms INTEGER, asleep_min INTEGER, in_bed_min INTEGER, bedtime TEXT, wake_time TEXT, deep_min INTEGER, rem_min INTEGER, light_min INTEGER,
    PRIMARY KEY (profile_id, day)
);
INSERT INTO activity_day VALUES(1,'2026-10-01',NULL,9000,NULL,NULL,440,NULL,NULL,NULL,NULL,NULL,NULL);
CREATE TABLE activity_session (
    profile_id INTEGER NOT NULL REFERENCES profile (id) ON DELETE CASCADE,
    source_key TEXT NOT NULL,
    day TEXT NOT NULL,
    start_at TEXT NOT NULL,
    end_at TEXT NOT NULL,
    type INTEGER NOT NULL,
    name TEXT NOT NULL,
    kcal INTEGER, distance_m INTEGER, recording_method INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (profile_id, source_key)
);
INSERT INTO activity_session VALUES(1,'hc-1','2026-10-01','2026-10-01T06:00:00Z','2026-10-01T06:30:00Z',33,'Running',300,NULL,0);
CREATE TABLE workout_tombstone (
    profile_id INTEGER NOT NULL REFERENCES profile (id) ON DELETE CASCADE,
    source_key TEXT NOT NULL,
    type TEXT,
    start_at TEXT,
    PRIMARY KEY (profile_id, source_key)
);
INSERT INTO workout_tombstone VALUES(1,'hc-2','walk','2026-10-01T08:00:00Z');
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
INSERT INTO check_in VALUES(1,'2026-10-01',4,NULL,NULL,'["travel"]');
PRAGMA writable_schema=ON;
CREATE TABLE IF NOT EXISTS sqlite_sequence(name,seq);
DELETE FROM sqlite_sequence;
INSERT INTO sqlite_sequence VALUES('profile',1);
INSERT INTO sqlite_sequence VALUES('exercise',135);
INSERT INTO sqlite_sequence VALUES('food',101);
INSERT INTO sqlite_sequence VALUES('habit',1);
INSERT INTO sqlite_sequence VALUES('workout',1);
INSERT INTO sqlite_sequence VALUES('planned_workout',1);
INSERT INTO sqlite_sequence VALUES('workout_session',1);
CREATE TRIGGER entry_uid AFTER INSERT ON entry WHEN NEW.uid IS NULL BEGIN
    UPDATE entry SET uid = lower(hex(randomblob(16))) WHERE id = NEW.id;
END;
CREATE TRIGGER workout_session_uid AFTER INSERT ON workout_session WHEN NEW.uid IS NULL BEGIN
    UPDATE workout_session SET uid = lower(hex(randomblob(16))) WHERE id = NEW.id;
END;
CREATE INDEX recipe_item_food ON recipe_item (food_id);
CREATE INDEX entry_day ON entry (profile_id, day);
CREATE INDEX entry_food ON entry (food_id);
CREATE INDEX serving_food ON serving (food_id);
CREATE INDEX recipe_item_recipe ON recipe_item (recipe_id);
CREATE INDEX meal_item_meal ON meal_item (meal_id);
CREATE INDEX workout_session_day ON workout_session (profile_id, day);
CREATE UNIQUE INDEX workout_session_uid ON workout_session (profile_id, uid);
CREATE UNIQUE INDEX entry_uid ON entry (profile_id, uid);
CREATE INDEX entry_profile_food ON entry (profile_id, food_id);
CREATE INDEX planned_workout_day ON planned_workout (profile_id, day);
CREATE UNIQUE INDEX planned_workout_uid ON planned_workout (profile_id, uid);
CREATE UNIQUE INDEX habit_name ON habit (profile_id, name COLLATE NOCASE);
CREATE INDEX habit_day_day ON habit_day (day);
CREATE INDEX scale_reading_day ON scale_reading (profile_id, day);
CREATE INDEX scale_reading_source_id ON scale_reading (profile_id, source, source_user, source_id);
CREATE INDEX activity_session_day ON activity_session (profile_id, day);
CREATE UNIQUE INDEX workout_session_source_key
    ON workout_session (profile_id, source_key) WHERE source_key IS NOT NULL;
PRAGMA writable_schema=OFF;
COMMIT;
PRAGMA user_version = 27;
