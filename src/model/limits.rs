//! Every input limit in one place. The API enforces them and serves them in
//! `/api/meta`, so clients check the same numbers instead of copying them.

use serde::Serialize;

/// Longest accepted food, recipe, meal, exercise, workout or session name
/// (and brand), in characters.
pub const NAME_MAX: usize = 200;
/// Longest accepted serving label, group or amount text, in characters.
pub const LABEL_MAX: usize = 50;
/// Largest amount of one entry, serving or ingredient: 100 kg.
pub const GRAMS_MAX: f64 = 100_000.0;
/// Most ingredients in a recipe or items in a meal.
pub const ITEMS_MAX: usize = 200;
/// Most servings a food has.
pub const SERVINGS_MAX: usize = 50;
/// Longest rest or timed exercise: an hour.
pub const STEP_SECONDS_MAX: u32 = 3600;
pub const REPS_MAX: u32 = 999;
pub const KG_MAX: f64 = 500.0;
/// Rounds of one repeat.
pub const TIMES_MAX: u32 = 99;
/// Repeats inside repeats.
pub const DEPTH_MAX: usize = 4;
/// Steps a workout may take once its repeats are unrolled; the run screen
/// walks them one by one.
pub const RUN_STEPS_MAX: u64 = 10_000;
/// A workout or session's time and energy.
pub const MINUTES_MAX: u32 = 600;
pub const KCAL_MAX: u32 = 5000;
/// A session's time: a watch workout can last most of a day.
pub const SESSION_MINUTES_MAX: u32 = 1440;
/// A session's distance, in metres.
pub const DISTANCE_M_MAX: u32 = 1_000_000;
/// Sets one session records.
pub const SETS_MAX: usize = 2000;
pub const WORKOUTS_PER_WEEK_MAX: u32 = 14;
/// Body weight in a profile or the weight log.
pub const BODY_KG_MIN: f64 = 30.0;
pub const BODY_KG_MAX: f64 = 300.0;
pub const HEIGHT_CM_MIN: f64 = 100.0;
pub const HEIGHT_CM_MAX: f64 = 250.0;
/// Physical activity level (PAL).
pub const ACTIVITY_MIN: f64 = 1.2;
pub const ACTIVITY_MAX: f64 = 2.5;
/// Weight to lose (negative) or gain a week, in kg.
pub const GOAL_KG_PER_WEEK_MIN: f64 = -1.0;
pub const GOAL_KG_PER_WEEK_MAX: f64 = 1.0;
/// Most portions of a meal logged at once.
pub const PORTIONS_MAX: f64 = 100.0;
/// Digits in a barcode (EAN, UPC and shop-internal codes).
pub const BARCODE_DIGITS_MIN: usize = 4;
pub const BARCODE_DIGITS_MAX: usize = 32;
/// Characters in a client-made id.
pub const UID_MIN: usize = 8;
pub const UID_MAX: usize = 64;
/// Longest day note, in characters.
pub const NOTE_MAX: usize = 500;
/// Most portions a recipe makes.
pub const MAKES_MAX: u32 = 100;
/// A body measurement (waist, hips, chest), in cm.
pub const MEASURE_CM_MIN: f64 = 20.0;
pub const MEASURE_CM_MAX: f64 = 300.0;
/// How far ahead of today a workout can be planned, in days.
pub const PLAN_DAYS_AHEAD: u32 = 366;
/// Trackers of your own a profile has, archived included.
pub const HABITS_MAX: u32 = 20;
/// A tracker's count on one day, and its daily limit.
pub const HABIT_AMOUNT_MAX: f64 = 999.0;
/// Longest tracker unit ("pouches"), in characters.
pub const UNIT_MAX: usize = 20;
/// Longest recipe instructions, in characters.
pub const INSTRUCTIONS_MAX: usize = 10_000;
/// One "+ Water" log, in ml (logged as as many grams). Not checked by the
/// server, which takes any grams: served for the dialog.
pub const WATER_ML_MIN: f64 = 1.0;
pub const WATER_ML_MAX: f64 = 5000.0;
/// Largest profile or Cronometer import body: 64 MiB, years of diary. Not
/// served: only the import routes take it.
pub const IMPORT_BYTES_MAX: usize = 64 * 1024 * 1024;
/// Most readings in one openScale sync batch: decades of daily weigh-ins
/// (about 8 MiB). Not served.
pub const SCALE_BATCH_MAX: usize = 100_000;
/// Largest openScale webhook body: 16 MiB, a full batch with room to
/// spare. Not served.
pub const SCALE_BYTES_MAX: usize = 16 * 1024 * 1024;
/// openScale users a profile's connection remembers (the bound one always
/// among them). Not served.
pub const SCALE_USERS_MAX: usize = 16;
/// Days one Health Connect sync replaces at most (a 90-day resync fits).
pub const ACTIVITY_WINDOW_MAX: usize = 92;
/// Watch workouts in one sync.
pub const ACTIVITY_SESSIONS_MAX: usize = 2000;
/// A day's active energy (kcal) and steps from Health Connect.
pub const ACTIVE_KCAL_MAX: i64 = 20_000;
pub const STEPS_MAX: i64 = 200_000;
/// Characters in a Health Connect record id; its exercise type numbers.
pub const ACTIVITY_KEY_MAX: usize = 128;
pub const ACTIVITY_TYPE_MAX: i64 = 1000;
/// Longest watch workout name, in characters.
pub const ACTIVITY_NAME_MAX: usize = 100;
/// A synced day's resting heart rate (bpm) and HRV (ms).
pub const RESTING_HR_MIN: i64 = 20;
pub const RESTING_HR_MAX: i64 = 250;
pub const HRV_MS_MIN: i64 = 1;
pub const HRV_MS_MAX: i64 = 500;
/// Deleted watch workouts one profile file carries.
pub const TOMBSTONES_MAX: usize = 100_000;
/// A check-in's mood, energy and stress scale.
pub const CHECK_IN_SCALE_MIN: i64 = 1;
pub const CHECK_IN_SCALE_MAX: i64 = 5;
/// Longest check-in tag, in characters, and most tags on one check-in.
pub const CHECK_IN_TAG_MAX: usize = 30;
pub const CHECK_IN_TAGS_MAX: usize = 8;
/// Largest Health Connect sync body: 1 MiB. Not served.
pub const HEALTH_BYTES_MAX: usize = 1024 * 1024;

/// The limits as served to clients.
#[derive(Debug, Serialize)]
pub struct Limits {
    pub name: usize,
    pub label: usize,
    pub grams: f64,
    pub items: usize,
    pub servings: usize,
    pub step_seconds: u32,
    pub reps: u32,
    pub kg: f64,
    pub times: u32,
    pub depth: usize,
    pub run_steps: u64,
    pub minutes: u32,
    pub session_minutes: u32,
    pub distance_m: u32,
    pub kcal: u32,
    pub sets: usize,
    pub workouts_per_week: u32,
    pub body_kg: (f64, f64),
    pub height_cm: (f64, f64),
    pub activity: (f64, f64),
    pub goal_kg_per_week: (f64, f64),
    pub portions: f64,
    pub barcode_digits: (usize, usize),
    pub uid: (usize, usize),
    pub note: usize,
    pub makes: u32,
    pub measure_cm: (f64, f64),
    pub plan_days_ahead: u32,
    pub habits: u32,
    pub habit_amount: f64,
    pub unit: usize,
    pub instructions: usize,
    pub water_ml: (f64, f64),
    pub activity_window: usize,
    pub activity_sessions: usize,
    pub tombstones: usize,
    pub check_in_scale: (i64, i64),
    pub check_in_tag: usize,
    pub check_in_tags_max: usize,
    /// Per 100 g of a food, by stored unit (`nutrients::PER100_MAX`).
    pub per100_max: UnitMaxima,
}

pub const LIMITS: Limits = Limits {
    name: NAME_MAX,
    label: LABEL_MAX,
    grams: GRAMS_MAX,
    items: ITEMS_MAX,
    servings: SERVINGS_MAX,
    step_seconds: STEP_SECONDS_MAX,
    reps: REPS_MAX,
    kg: KG_MAX,
    times: TIMES_MAX,
    depth: DEPTH_MAX,
    run_steps: RUN_STEPS_MAX,
    minutes: MINUTES_MAX,
    session_minutes: SESSION_MINUTES_MAX,
    distance_m: DISTANCE_M_MAX,
    kcal: KCAL_MAX,
    sets: SETS_MAX,
    workouts_per_week: WORKOUTS_PER_WEEK_MAX,
    body_kg: (BODY_KG_MIN, BODY_KG_MAX),
    height_cm: (HEIGHT_CM_MIN, HEIGHT_CM_MAX),
    activity: (ACTIVITY_MIN, ACTIVITY_MAX),
    goal_kg_per_week: (GOAL_KG_PER_WEEK_MIN, GOAL_KG_PER_WEEK_MAX),
    portions: PORTIONS_MAX,
    barcode_digits: (BARCODE_DIGITS_MIN, BARCODE_DIGITS_MAX),
    uid: (UID_MIN, UID_MAX),
    note: NOTE_MAX,
    makes: MAKES_MAX,
    measure_cm: (MEASURE_CM_MIN, MEASURE_CM_MAX),
    plan_days_ahead: PLAN_DAYS_AHEAD,
    habits: HABITS_MAX,
    habit_amount: HABIT_AMOUNT_MAX,
    unit: UNIT_MAX,
    instructions: INSTRUCTIONS_MAX,
    water_ml: (WATER_ML_MIN, WATER_ML_MAX),
    activity_window: ACTIVITY_WINDOW_MAX,
    activity_sessions: ACTIVITY_SESSIONS_MAX,
    tombstones: TOMBSTONES_MAX,
    check_in_scale: (CHECK_IN_SCALE_MIN, CHECK_IN_SCALE_MAX),
    check_in_tag: CHECK_IN_TAG_MAX,
    check_in_tags_max: CHECK_IN_TAGS_MAX,
    per100_max: UnitMaxima(&crate::nutrients::PER100_MAX),
};

/// `(unit, max)` pairs, served as `{unit: max}`.
#[derive(Debug)]
pub struct UnitMaxima(pub &'static [(&'static str, f64)]);

impl Serialize for UnitMaxima {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.collect_map(self.0.iter().copied())
    }
}
