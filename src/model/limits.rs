//! Every input limit in one place. The API enforces them and serves them in
//! `/api/meta`, so clients check the same numbers instead of copying them.

use serde::Serialize;

/// Longest accepted food, recipe, meal, exercise, workout or activity name
/// (and brand), in characters.
pub const NAME_MAX: usize = 200;
/// Longest serving label, profile or habit name, group or amount text, in
/// characters.
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
/// A workout or activity's time and energy.
pub const MINUTES_MAX: u32 = 600;
pub const KCAL_MAX: u32 = 5000;
/// An activity's time: a device workout can last most of a day.
pub const ACTIVITY_MINUTES_MAX: u32 = 1440;
/// An activity's distance, in metres.
pub const DISTANCE_M_MAX: u32 = 1_000_000;
/// Sets one activity records.
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
/// A profile's latitude, in degrees (south negative), to one decimal.
pub const LATITUDE_MIN: f64 = -90.0;
pub const LATITUDE_MAX: f64 = 90.0;
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
/// Daily items a profile has.
pub const DAILY_ITEMS_MAX: u32 = 20;
/// A tracker's count on one day, and its daily limit.
pub const HABIT_AMOUNT_MAX: f64 = 999.0;
/// Longest tracker unit ("pouches"), in characters.
pub const UNIT_MAX: usize = 20;
/// Longest recipe or workout notes, and note block, in characters.
pub const NOTES_MAX: usize = 10_000;
/// One "+ Water" log, in ml (logged as as many grams). Not checked by the
/// server, which takes any grams: served for the dialog.
pub const WATER_ML_MIN: f64 = 1.0;
pub const WATER_ML_MAX: f64 = 5000.0;
/// Largest profile, Cronometer or Google Health import body: 64 MiB, years
/// of diary or about four years of Google Health activity files. Served:
/// the browser's Takeout reader stops before it.
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
/// Device workouts in one sync.
pub const DEVICE_WORKOUTS_MAX: usize = 2000;
/// A day's active energy (kcal) and steps from Health Connect.
pub const ACTIVE_KCAL_MAX: i64 = 20_000;
/// A day's total energy burned (kcal) from Health Connect: resting and
/// active.
pub const TOTAL_KCAL_MAX: i64 = 30_000;
pub const STEPS_MAX: i64 = 200_000;
/// Characters in a Health Connect record id; its exercise type numbers.
pub const ACTIVITY_KEY_MAX: usize = 128;
pub const ACTIVITY_TYPE_MAX: i64 = 1000;
/// Longest device workout name, in characters.
pub const ACTIVITY_NAME_MAX: usize = 100;
/// A synced day's resting heart rate (bpm) and HRV (ms).
pub const RESTING_HR_MIN: i64 = 20;
pub const RESTING_HR_MAX: i64 = 250;
pub const HRV_MS_MIN: i64 = 1;
pub const HRV_MS_MAX: i64 = 500;
/// Deleted device workouts one profile file carries.
pub const TOMBSTONES_MAX: usize = 100_000;
/// A check-in's mood, energy and stress scale.
pub const CHECK_IN_SCALE_MIN: i64 = 1;
pub const CHECK_IN_SCALE_MAX: i64 = 5;
/// Longest check-in tag, in characters, and most tags on one check-in.
pub const CHECK_IN_TAG_MAX: usize = 30;
pub const CHECK_IN_TAGS_MAX: usize = 8;
/// Largest Health Connect sync body: 1 MiB (the phone pages its records
/// under 768 KiB). Not served.
pub const HEALTH_BYTES_MAX: usize = 1024 * 1024;
/// Largest record kept as sent (its JSON); a bigger one is kept as a flag
/// with its size and top-level scalars. Not served.
pub const HEALTH_RECORD_BYTES_MAX: usize = 512 * 1024;
/// Records in one POST of the records route. Not served.
pub const HEALTH_RECORDS_MAX: usize = 50_000;
/// Characters in a record's kind (`HeartRate`, `UserSleeps`).
pub const RECORD_KIND_MAX: usize = 64;
/// A device workout's average and peak heart rate (bpm).
pub const HEART_RATE_MIN: i64 = 20;
pub const HEART_RATE_MAX: i64 = 250;
/// Sleep sessions at most this many seconds apart are one block (ADR 0032).
pub const SLEEP_JOIN_S: i64 = 2 * 60 * 60;
/// A session starting at least this many seconds after a block that is
/// already a night, and itself shorter than a night, starts a block of its
/// own: a nap after waking, not the night's end.
pub const SLEEP_SPLIT_S: i64 = 60 * 60;
/// A block with at least this many minutes in bed is a night; a shorter one
/// is naps, one a session.
pub const NIGHT_MIN_MIN: i64 = 180;
/// A block too short for a night that ends before this (minutes after local
/// midnight) on the wake day of the night block after it is that night's
/// start, not a nap: a sleep broken by hours awake in the small hours.
pub const NIGHT_PART_END_MIN: i64 = 6 * 60;
/// A block with more minutes in bed than a day is no sleep: skipped, and
/// counted so.
pub const IN_BED_MAX_MIN: i64 = 1440;
/// Longest nap, in minutes: three hours in bed is a night.
pub const NAP_MINUTES_MAX: i64 = NIGHT_MIN_MIN - 1;
/// Naps on one synced day; Health Connect weigh-ins in one sync.
pub const NAPS_MAX: usize = 24;
/// Sleep stage spans on one synced day (a night's hypnogram).
pub const SLEEP_STAGES_MAX: usize = 300;
pub const BODY_READINGS_MAX: usize = 5000;
/// A reading's bone mass (kg) and basal metabolic rate (kcal a day).
pub const BONE_KG_MAX: f64 = 10.0;
pub const BMR_KCAL_MAX: f64 = 5000.0;

/// The recommended BMI range by age, `(from age, min, max)`, the last
/// row at or under an age applying (none under 18: adult cut-offs don't
/// apply). From 18 the WHO's 18.5–25, the same for both sexes; from 65
/// 22–27, the older adult's cut-offs (Lipschitz, Prim Care 1994; the
/// Nutrition Screening Initiative's). Mortality alone would put it higher:
/// Winter et al. (Am J Clin Nutr 2014) found it rising under 23 and lowest
/// about 27–28.
pub const RECOMMENDED_BMI: [(f64, f64, f64); 2] = [(18.0, 18.5, 25.0), (65.0, 22.0, 27.0)];

/// Largest photo upload: 2 MiB (the client sends ~300 KB: ≤ 1600 px,
/// JPEG quality 0.8).
pub const PHOTO_BYTES_MAX: usize = 2 * 1024 * 1024;
/// Photos one profile keeps, in bytes: 512 MiB (about 1,700 photos).
pub const PHOTO_BYTES_TOTAL_MAX: usize = 512 * 1024 * 1024;
/// A photo's longest side, in pixels.
pub const PHOTO_PX_MAX: u32 = 4096;
/// Longest feedback text, in characters.
pub const FEEDBACK_TEXT_MAX: usize = 4000;
/// Feedback rows the instance keeps (pulled ones included).
pub const FEEDBACK_MAX: u32 = 1000;
/// A Home Assistant hook's base URL and webhook id, in characters.
pub const HOOK_URL_MAX: usize = 500;
pub const HOOK_ID_MAX: usize = 200;

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
    pub activity_minutes: u32,
    pub distance_m: u32,
    pub kcal: u32,
    pub sets: usize,
    pub workouts_per_week: u32,
    pub body_kg: (f64, f64),
    pub height_cm: (f64, f64),
    pub activity: (f64, f64),
    pub goal_kg_per_week: (f64, f64),
    pub latitude: (f64, f64),
    pub portions: f64,
    pub barcode_digits: (usize, usize),
    pub uid: (usize, usize),
    pub note: usize,
    pub makes: u32,
    pub measure_cm: (f64, f64),
    pub plan_days_ahead: u32,
    pub habits: u32,
    pub daily_items: u32,
    pub habit_amount: f64,
    pub unit: usize,
    pub notes: usize,
    pub water_ml: (f64, f64),
    pub activity_window: usize,
    pub device_workouts: usize,
    pub tombstones: usize,
    pub check_in_scale: (i64, i64),
    pub check_in_tag: usize,
    pub check_in_tags_max: usize,
    pub photo_bytes: usize,
    pub photo_bytes_total: usize,
    pub photo_px: u32,
    pub feedback_text: usize,
    pub feedback: u32,
    pub hook_url: usize,
    pub hook_id: usize,
    pub import_bytes: usize,
    /// Per 100 g of a food, by stored unit (`nutrients::PER100_MAX`).
    pub per100_max: UnitMaxima,
    /// A goal weight's BMI, `[min, max]`.
    pub goal_bmi: (f64, f64),
    /// The least body fat (%) a goal may be: essential fat, by sex.
    pub essential_fat: BySex,
    /// A goal's body fat plus muscle (%) at most.
    pub fat_muscle_max: f64,
    /// A goal's muscle at most, as a share of the lean mass.
    pub muscle_of_lean_max: f64,
    /// [`RECOMMENDED_BMI`]: the Body chart's recommended range.
    pub recommended_bmi: [(f64, f64, f64); 2],
}

/// A number for men and one for women.
#[derive(Debug, Serialize)]
pub struct BySex {
    pub male: f64,
    pub female: f64,
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
    activity_minutes: ACTIVITY_MINUTES_MAX,
    distance_m: DISTANCE_M_MAX,
    kcal: KCAL_MAX,
    sets: SETS_MAX,
    workouts_per_week: WORKOUTS_PER_WEEK_MAX,
    body_kg: (BODY_KG_MIN, BODY_KG_MAX),
    height_cm: (HEIGHT_CM_MIN, HEIGHT_CM_MAX),
    activity: (ACTIVITY_MIN, ACTIVITY_MAX),
    goal_kg_per_week: (GOAL_KG_PER_WEEK_MIN, GOAL_KG_PER_WEEK_MAX),
    latitude: (LATITUDE_MIN, LATITUDE_MAX),
    portions: PORTIONS_MAX,
    barcode_digits: (BARCODE_DIGITS_MIN, BARCODE_DIGITS_MAX),
    uid: (UID_MIN, UID_MAX),
    note: NOTE_MAX,
    makes: MAKES_MAX,
    measure_cm: (MEASURE_CM_MIN, MEASURE_CM_MAX),
    plan_days_ahead: PLAN_DAYS_AHEAD,
    habits: HABITS_MAX,
    daily_items: DAILY_ITEMS_MAX,
    habit_amount: HABIT_AMOUNT_MAX,
    unit: UNIT_MAX,
    notes: NOTES_MAX,
    water_ml: (WATER_ML_MIN, WATER_ML_MAX),
    activity_window: ACTIVITY_WINDOW_MAX,
    device_workouts: DEVICE_WORKOUTS_MAX,
    tombstones: TOMBSTONES_MAX,
    check_in_scale: (CHECK_IN_SCALE_MIN, CHECK_IN_SCALE_MAX),
    check_in_tag: CHECK_IN_TAG_MAX,
    check_in_tags_max: CHECK_IN_TAGS_MAX,
    photo_bytes: PHOTO_BYTES_MAX,
    photo_bytes_total: PHOTO_BYTES_TOTAL_MAX,
    photo_px: PHOTO_PX_MAX,
    feedback_text: FEEDBACK_TEXT_MAX,
    feedback: FEEDBACK_MAX,
    hook_url: HOOK_URL_MAX,
    hook_id: HOOK_ID_MAX,
    import_bytes: IMPORT_BYTES_MAX,
    per100_max: UnitMaxima(&crate::nutrients::PER100_MAX),
    goal_bmi: super::profile::GOAL_BMI,
    essential_fat: BySex {
        male: super::metric::ESSENTIAL_FAT.0,
        female: super::metric::ESSENTIAL_FAT.1,
    },
    fat_muscle_max: super::profile::FAT_MUSCLE_MAX,
    muscle_of_lean_max: super::profile::MUSCLE_OF_LEAN_MAX,
    recommended_bmi: RECOMMENDED_BMI,
};

/// `(unit, max)` pairs, served as `{unit: max}`.
#[derive(Debug)]
pub struct UnitMaxima(pub &'static [(&'static str, f64)]);

impl Serialize for UnitMaxima {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.collect_map(self.0.iter().copied())
    }
}
