-- Rows a v40 database holds (the shape the owner's database has before the
-- 2026-10-12 batch), run on the schema migrations 1–40 build:
-- db::tests::upgrade_from_v40_to_head migrates them. Each wave that changes
-- one of these tables adds its rows here and its checks there. Written by
-- hand, never from live data.

-- Sessions: set-based (type NULL, the old "Workout"), typed (one claiming
-- a device run), one a Health Connect sync promoted and one a Google Health
-- import added; the highest id was deleted (AUTOINCREMENT must not hand it
-- out again).
INSERT INTO workout_session (id, profile_id, day, name, minutes, kcal, sets, uid, type,
                             distance_m, start_at, source, source_key)
VALUES (1, 1, '2026-10-01', 'Gym', 60, NULL,
        '[{"exercise_id":1,"name":"Pull-up","reps":5,"kg":80.0}]', 'v40-gym1', NULL,
        NULL, '2026-10-01T16:00:00Z', 'manual', NULL),
       (2, 1, '2026-10-02', 'Evening run', 45, 380, '[]', 'v40-run1', 'run',
        8200, '2026-10-02T17:00:00Z', 'manual', 'hc-1'),
       (3, 1, '2026-10-03', 'Biking', 30, 200, '[]', 'v40-ride', 'cycling',
        10000, '2026-10-03T18:00:00Z', 'health_connect', 'hc-2'),
       (4, 1, '2026-10-03', 'Outdoor Walk', 40, 120, '[]', 'v40-walk', 'walk',
        2400, '2026-10-03T07:00:00Z', 'manual', 'gh-9'),
       (5, 1, '2026-10-04', 'Gone', 10, NULL, '[]', 'v40-gone', NULL,
        NULL, NULL, 'manual', NULL);
DELETE FROM workout_session WHERE id = 5;

-- Health Connect: a day with its night, the raw copies of both synced
-- workouts, and a deleted one's tombstone.
INSERT INTO activity_day (profile_id, day, active_kcal, steps, resting_hr, hrv_ms,
                          asleep_min, in_bed_min, bedtime, wake_time)
VALUES (1, '2026-10-02', 512, 9120, 54, 48, 440, 475, '23:10', '07:05');
INSERT INTO activity_session (profile_id, source_key, day, start_at, end_at, type, name,
                              kcal, distance_m, recording_method)
VALUES (1, 'hc-1', '2026-10-02', '2026-10-02T17:05:00Z', '2026-10-02T17:50:00Z', 33,
        'Running', 410, 8200, 1),
       (1, 'hc-2', '2026-10-03', '2026-10-03T18:00:00Z', '2026-10-03T18:30:00Z', 4,
        'Biking', 200, 10000, 1);
-- A Google Health import's own day (heart rate columns come later).
INSERT INTO activity_import (profile_id, day, resting_hr, hrv_ms)
VALUES (1, '2026-10-02', 55, 47);
-- Days as the import's fill merged them (migration 50 un-merges): 10-03
-- a copy of the import's day and night, 10-04 the device's steps with the
-- import's energy copied in.
INSERT INTO activity_import (profile_id, day, active_kcal, steps, asleep_min, in_bed_min,
                             bedtime, wake_time, deep_min)
VALUES (1, '2026-10-03', 300, 4000, 400, 420, '23:00', '06:00', 90),
       (1, '2026-10-04', 350, 6500, NULL, NULL, NULL, NULL, NULL);
INSERT INTO activity_day (profile_id, day, active_kcal, steps, asleep_min, in_bed_min,
                          bedtime, wake_time, deep_min)
VALUES (1, '2026-10-03', 300, 4000, 400, 420, '23:00', '06:00', 90),
       (1, '2026-10-04', 350, 7000, NULL, NULL, NULL, NULL, NULL);
INSERT INTO workout_tombstone (profile_id, source_key, type, start_at)
VALUES (1, 'hc-3', 'walk', '2026-10-03T08:00:00Z');

-- openScale: a reading and the day weight it set.
INSERT INTO scale_reading (profile_id, source, source_user, taken_at, source_id, day,
                           weight, body_fat, water, muscle)
VALUES (1, 'openscale', 1, 1790919000000, 1, '2026-10-02', 81.5, 18.2, 55.0, 40.1);
INSERT INTO weight (profile_id, day, kg, source, set_at)
VALUES (1, '2026-10-02', 81.5, 'openscale', 1790919000000);

-- Targets: the water goal (W3 keeps the `water` metric as is).
INSERT INTO target (profile_id, metric, value) VALUES (1, 'water', 2500);

-- Profile: a weight goal in kg a week (W3 adds `goal_date` beside it).
UPDATE profile SET goal_kg_per_week = -0.5, height_cm = 180 WHERE id = 1;

-- Fish oil: EPA and DHA on a food, an entry of it, an imported day total
-- and a food with neither (W4 derives `epa_dha` from them).
INSERT INTO food (id, name, source, per100)
VALUES (900, 'Salmon', 'custom', '{"energy":200,"epa":0.5,"dha":1.2}'),
       (901, 'Rice', 'custom', '{"energy":130}');
INSERT INTO entry (profile_id, day, grp, food_id, name, grams, amount, nutrients, uid)
VALUES (1, '2026-10-02', 'Consumed', 900, 'Salmon', 200, '200 g',
        '{"energy":400,"epa":1.0,"dha":2.4}', 'v40-salmon');
INSERT INTO day_total (profile_id, day, grp, nutrients)
VALUES (1, '2026-10-01', 'Dinner', '{"dha":0.3}');

-- A workout (W5 adds `archived`, unarchived to start).
INSERT INTO workout (id, name, steps) VALUES (900, 'Legs', '[{"kind":"rest","seconds":60}]');
-- A7 adds `notes` (none to start); stored steps read as before.
INSERT INTO workout (id, name, steps, minutes) VALUES (901, 'Core',
  '[{"kind":"repeat","name":"Plank","times":2,"every":60,"steps":[{"kind":"rest","seconds":30}]}]', 12);
