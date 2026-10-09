//! A profile as one file: export format v1 and the checks an
//! import passes before anything is written.

use std::collections::{BTreeMap, BTreeSet};

use super::prelude::*;
use super::{
    ActivityDay, ActivitySession, Body, BodyPart, CheckIn, CheckInInput, ExerciseInput,
    ExerciseTraits, FoodInput, GoalDir, HabitInput, ItemInput, MeasurementInput, NoteInput,
    PlanInput, ProfileInput, RecipeInput, Serving, SessionInput, SessionSet, SessionSource,
    SessionType, Side, Source, Step, SyncedWorkouts, Target, TargetInput, TargetsInput,
    WeightInput, WeightSource, WorkoutInput, checked_day, checked_group, checked_habit_amount,
    checked_session, checked_time, checked_uid, is_barcode, is_key,
};

/// What the file says it is.
pub const EXPORT_FORMAT: &str = "kaloriina-profile";
/// The newest format this release reads and the one it writes.
pub const EXPORT_VERSION: u64 = 1;

/// A whole profile: what it owns, plus the shared foods and exercises it
/// uses, named by file-local refs. Readers ignore keys they don't know.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProfileExport {
    pub format: String,
    pub version: u64,
    #[serde(default)]
    pub exported_at: String,
    pub profile: ExportedProfile,
    #[serde(default)]
    pub targets: Vec<ExportedTarget>,
    #[serde(default)]
    pub weights: Vec<ExportedWeight>,
    #[serde(default)]
    pub measurements: Vec<ExportedMeasurement>,
    #[serde(default)]
    pub notes: Vec<ExportedNote>,
    /// Daily check-ins; files from before check-ins have none.
    #[serde(default)]
    pub check_ins: Vec<CheckIn>,
    #[serde(default)]
    pub entries: Vec<ExportedEntry>,
    #[serde(default)]
    pub day_totals: Vec<ExportedDayTotal>,
    #[serde(default)]
    pub sessions: Vec<ExportedSession>,
    /// Food refs.
    #[serde(default)]
    pub favorites: Vec<String>,
    #[serde(default)]
    pub foods: Vec<ExportedFood>,
    #[serde(default)]
    pub exercises: Vec<ExportedExercise>,
    /// Trackers of your own with their days; files from before habits
    /// have none.
    #[serde(default)]
    pub habits: Vec<ExportedHabit>,
    /// Scale readings; files from before scale sync have none.
    /// The connection is `openscale`.
    #[serde(default)]
    pub scale_readings: Vec<ExportedScaleReading>,
    /// Health Connect activity; files from before have none. The
    /// sync's status stays with the installation.
    #[serde(default)]
    pub activity_days: Vec<ActivityDay>,
    #[serde(default)]
    pub activity_sessions: Vec<ActivitySession>,
    /// Watch workouts deleted or dismissed, never promoted again; files
    /// from before have none.
    #[serde(default)]
    pub workout_tombstones: Vec<ExportedTombstone>,
    /// Whether a sync adds new watch workouts or lists them.
    #[serde(default)]
    pub synced_workouts: SyncedWorkouts,
    /// The food "+ Water" logs, when the profile picked one: a food ref.
    #[serde(default)]
    pub water_food: Option<String>,
    /// The openScale user bound to the profile. Applied by a restore only
    /// (`?restore=true`): a copy never takes over another's scale.
    #[serde(default)]
    pub openscale: Option<ExportedBinding>,
    /// The workouts its sessions and plans name; their steps name
    /// exercises by ref.
    #[serde(default)]
    pub workouts: Vec<ExportedWorkout>,
    /// Workouts planned on a day.
    #[serde(default)]
    pub plans: Vec<ExportedPlan>,
}

/// The bound openScale user.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportedBinding {
    pub bound_user: i64,
    #[serde(default)]
    pub bound_username: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportedWorkout {
    #[serde(rename = "ref")]
    pub reference: String,
    pub name: String,
    pub steps: Vec<ExportedStep>,
    #[serde(default)]
    pub minutes: Option<u32>,
    #[serde(default)]
    pub kcal: Option<u32>,
}

/// A workout step as [`Step`] has it, its exercise by ref.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ExportedStep {
    Exercise {
        exercise: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reps: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        seconds: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        kg: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        side: Option<Side>,
    },
    Rest {
        seconds: u32,
    },
    Repeat {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        times: u32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        every: Option<u32>,
        steps: Vec<ExportedStep>,
    },
}

impl ExportedStep {
    /// The file's steps for `steps`, each exercise named by `reference`.
    #[must_use]
    pub fn from_steps(steps: &[Step], reference: &impl Fn(i64) -> String) -> Vec<Self> {
        steps
            .iter()
            .map(|s| match s {
                Step::Exercise {
                    exercise_id,
                    reps,
                    seconds,
                    kg,
                    side,
                } => Self::Exercise {
                    exercise: reference(*exercise_id),
                    reps: *reps,
                    seconds: *seconds,
                    kg: *kg,
                    side: *side,
                },
                Step::Rest { seconds } => Self::Rest { seconds: *seconds },
                Step::Repeat {
                    name,
                    times,
                    every,
                    steps,
                } => Self::Repeat {
                    name: name.clone(),
                    times: *times,
                    every: *every,
                    steps: Self::from_steps(steps, reference),
                },
            })
            .collect()
    }

    /// The [`Step`]s, each exercise ref looked up in `ids`.
    ///
    /// # Errors
    /// An exercise ref `ids` doesn't hold.
    pub fn to_steps(steps: &[Self], ids: &BTreeMap<&str, i64>) -> Result<Vec<Step>, Error> {
        steps
            .iter()
            .map(|s| {
                Ok(match s {
                    Self::Exercise {
                        exercise,
                        reps,
                        seconds,
                        kg,
                        side,
                    } => Step::Exercise {
                        exercise_id: *ids
                            .get(exercise.as_str())
                            .ok_or_else(|| bad(format!("unknown exercise ref “{exercise}”")))?,
                        reps: *reps,
                        seconds: *seconds,
                        kg: *kg,
                        side: *side,
                    },
                    Self::Rest { seconds } => Step::Rest { seconds: *seconds },
                    Self::Repeat {
                        name,
                        times,
                        every,
                        steps,
                    } => Step::Repeat {
                        name: name.clone(),
                        times: *times,
                        every: *every,
                        steps: Self::to_steps(steps, ids)?,
                    },
                })
            })
            .collect()
    }
}

/// A workout planned on a day.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportedPlan {
    #[serde(default)]
    pub uid: Option<String>,
    pub day: String,
    /// Workout ref.
    pub workout: String,
    #[serde(default)]
    pub created_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportedHabit {
    pub name: String,
    pub unit: String,
    #[serde(default)]
    pub goal_value: Option<f64>,
    /// `at_most` when left out.
    #[serde(default)]
    pub goal_dir: Option<GoalDir>,
    /// Files from before habit goals: an `at_most` goal. Read only.
    #[serde(default, skip_serializing)]
    pub day_limit: Option<f64>,
    #[serde(default)]
    pub archived: bool,
    /// `YYYY-MM-DDTHH:MM:SSZ`; now when left out.
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub days: Vec<ExportedHabitDay>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportedHabitDay {
    pub day: String,
    pub amount: f64,
}

/// One scale reading as stored: its time in epoch ms, its local day.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportedScaleReading {
    pub source: String,
    pub source_user: i64,
    #[serde(default)]
    pub source_id: Option<i64>,
    pub taken_at: i64,
    pub day: String,
    pub weight: f64,
    #[serde(default)]
    pub body_fat: Option<f64>,
    #[serde(default)]
    pub water: Option<f64>,
    #[serde(default)]
    pub muscle: Option<f64>,
}

/// The profile's own fields. The weight travels as `weights`, goals as
/// `targets`; files from before say `weight_kg` (a weigh-in on the
/// import day when the file has no `weights`), `workouts_per_week` and
/// `goal_weight_kg` (read as targets).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportedProfile {
    /// The id it had: kept by a restore when free, else unused.
    #[serde(default)]
    pub id: Option<i64>,
    pub name: String,
    #[serde(flatten)]
    pub body: Body,
    #[serde(default, skip_serializing)]
    pub workouts_per_week: Option<u32>,
    #[serde(default, skip_serializing)]
    pub goal_weight_kg: Option<f64>,
    #[serde(default, skip_serializing)]
    pub weight_kg: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportedTarget {
    /// Files from before goals say `nutrient`.
    #[serde(alias = "nutrient")]
    pub metric: String,
    pub value: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportedWeight {
    pub day: String,
    pub kg: f64,
    /// `manual` when left out (files from before scale sync).
    #[serde(default)]
    pub source: WeightSource,
    /// When it was set, epoch ms (decides a scale reading against a typed
    /// weight); files from before have none.
    #[serde(default)]
    pub set_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportedMeasurement {
    pub day: String,
    pub kind: BodyPart,
    pub value: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportedNote {
    pub day: String,
    pub text: String,
}

/// A diary entry as stored, its food by ref.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportedEntry {
    pub uid: String,
    pub day: String,
    pub group: String,
    #[serde(default)]
    pub food: Option<String>,
    pub name: String,
    #[serde(default)]
    pub grams: Option<f64>,
    #[serde(default)]
    pub serving: Option<String>,
    #[serde(default)]
    pub quantity: Option<f64>,
    pub amount: String,
    #[serde(default)]
    pub nutrients: Option<Nutrients>,
    #[serde(default)]
    pub imported: bool,
    /// The group imported history came in under.
    #[serde(default)]
    pub src_group: Option<String>,
    #[serde(default)]
    pub time: Option<String>,
    pub created_at: String,
}

/// An imported history total.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportedDayTotal {
    pub day: String,
    pub group: String,
    pub nutrients: Nutrients,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportedSession {
    pub uid: String,
    pub day: String,
    pub name: String,
    pub minutes: u32,
    #[serde(default)]
    pub kcal: Option<u32>,
    #[serde(default)]
    pub sets: Vec<ExportedSet>,
    /// Files from before Health Connect 2 have none of these.
    #[serde(default, rename = "type")]
    pub kind: Option<SessionType>,
    #[serde(default)]
    pub distance_m: Option<u32>,
    #[serde(default)]
    pub start_at: Option<String>,
    #[serde(default)]
    pub source: SessionSource,
    #[serde(default)]
    pub source_key: Option<String>,
    /// The workout it was done from: a workout ref.
    #[serde(default)]
    pub workout: Option<String>,
    /// `YYYY-MM-DDTHH:MM:SSZ`; now when left out.
    #[serde(default)]
    pub created_at: Option<String>,
}

/// A deleted or dismissed watch workout: its key, and the type and start
/// that catch a re-id'd copy.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportedTombstone {
    pub key: String,
    #[serde(default, rename = "type")]
    pub kind: Option<SessionType>,
    #[serde(default)]
    pub start_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportedSet {
    /// Exercise ref.
    pub exercise: String,
    #[serde(default)]
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reps: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seconds: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kg: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub side: Option<Side>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportedFood {
    #[serde(rename = "ref")]
    pub reference: String,
    pub name: String,
    #[serde(default)]
    pub brand: Option<String>,
    #[serde(default)]
    pub barcode: Option<String>,
    pub source: Source,
    #[serde(default)]
    pub fineli_id: Option<i64>,
    #[serde(default)]
    pub per100: Nutrients,
    #[serde(default)]
    pub cooked_g: Option<f64>,
    #[serde(default)]
    pub makes: Option<u32>,
    /// A recipe's; left out when none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instructions: Option<String>,
    #[serde(default)]
    pub archived: bool,
    /// A food category key; none when left out.
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub servings: Vec<Serving>,
    /// A recipe's ingredients.
    #[serde(default)]
    pub items: Vec<ExportedItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportedItem {
    /// Food ref.
    pub food: String,
    pub grams: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportedExercise {
    #[serde(rename = "ref")]
    pub reference: String,
    pub name: String,
    pub measure: Measure,
    #[serde(default)]
    pub variant_of: Option<String>,
    #[serde(flatten)]
    pub traits: ExerciseTraits,
}

/// An export that passed every check: inputs normalised as the API would
/// store them, foods ordered ingredients first and exercises roots first.
#[derive(Debug, Clone)]
pub struct CheckedImport {
    pub profile: ProfileInput,
    pub targets: Vec<Target>,
    pub file: ProfileExport,
}

/// Bad input inside one list of the file: blamed on that list, the message
/// saying which item.
fn within(field: &'static str, what: String) -> impl Fn(Error) -> Error {
    move |e| match e {
        Error::Invalid { message, .. } => Error::invalid_field(field, format!("{what}: {message}")),
        other => other,
    }
}

/// A uid as stored: a client uid, optionally followed by `:<digits>` (the
/// items of one meal or copy write).
fn checked_stored_uid(uid: &str) -> Result<(), Error> {
    let base = match uid.rsplit_once(':') {
        Some((base, n)) if !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()) => base,
        Some(_) => return Err(bad("uid must be a client uid, optionally with :<digits>")),
        None => uid,
    };
    checked_uid(base).map(|_| ())
}

/// `YYYY-MM-DDTHH:MM:SSZ`, as the database writes `created_at`.
fn is_timestamp(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 20
        && s.get(..10).is_some_and(is_date)
        && b[10] == b'T'
        && b[13] == b':'
        && b[16] == b':'
        && b[19] == b'Z'
        && [11, 12, 14, 15, 17, 18]
            .iter()
            .all(|&i| b[i].is_ascii_digit())
}

fn checked_created_at(at: Option<&str>) -> Result<(), Error> {
    if at.is_some_and(|t| !is_timestamp(t)) {
        return Err(bad("created_at must be YYYY-MM-DDTHH:MM:SSZ"));
    }
    Ok(())
}

fn nutrients_ok(n: &Nutrients) -> Result<(), Error> {
    n.validate()
        .map_err(|key| bad(format!("nutrient {key} must be known and ≥ 0")))
}

/// Each ref once.
fn unique_refs<'a>(field: &'static str, refs: impl Iterator<Item = &'a str>) -> Result<(), Error> {
    let mut seen = BTreeSet::new();
    for r in refs {
        if !seen.insert(r) {
            return Err(Error::invalid_field(
                field,
                format!("ref “{r}” is listed twice"),
            ));
        }
    }
    Ok(())
}

/// The two fields of a file read before the rest.
#[derive(Deserialize)]
struct Header {
    #[serde(default)]
    format: Option<serde_json::Value>,
    #[serde(default)]
    version: Option<serde_json::Value>,
}

impl ProfileExport {
    /// The file in `bytes`, typed straight from them (no JSON tree: an
    /// import's memory is its body plus what it holds). The format and
    /// version are read first, so a newer file is refused for what it is
    /// rather than for a shape this release doesn't know.
    ///
    /// # Errors
    /// Not JSON or not an export (400 `format`), a newer version (400
    /// `version`), or a shape this version doesn't have (400).
    pub fn read(bytes: &[u8]) -> Result<Self, Error> {
        let unreadable = |e: serde_json::Error| bad(format!("couldn't read the file: {e}"));
        let header: Header = serde_json::from_slice(bytes).map_err(unreadable)?;
        if header.format.as_ref().and_then(serde_json::Value::as_str) != Some(EXPORT_FORMAT) {
            return Err(Error::invalid_field(
                "format",
                format!("format must be “{EXPORT_FORMAT}”: this isn't a profile export"),
            ));
        }
        match header.version.as_ref().and_then(serde_json::Value::as_u64) {
            Some(v) if (1..=EXPORT_VERSION).contains(&v) => {}
            _ => {
                return Err(Error::invalid_field(
                    "version",
                    format!("version must be 1–{EXPORT_VERSION}: the file is from a newer release"),
                ));
            }
        }
        serde_json::from_slice(bytes).map_err(unreadable)
    }

    /// Every check the API makes on the same data, plus the file's own:
    /// uids well formed and each once, refs resolving, recipes acyclic.
    /// Ages count to `today`; quick adds become foods (see
    /// `quick_adds_to_foods`); goals a profile kept become targets.
    ///
    /// # Errors
    /// The first failure, blamed on the list it's in.
    pub fn checked(mut self, today: &str) -> Result<CheckedImport, Error> {
        let profile = ProfileInput {
            name: self.profile.name.clone(),
            body: self.profile.body.clone(),
            ..ProfileInput::default()
        }
        .checked(today)?;
        // A file from before goals keeps two of them on the profile.
        let legacy = [
            (
                "workouts_per_week",
                self.profile.workouts_per_week.map(f64::from),
            ),
            ("goal_weight", self.profile.goal_weight_kg),
        ];
        for (metric, value) in legacy {
            if let Some(value) = value
                && !self.targets.iter().any(|t| t.metric == metric)
            {
                self.targets.push(ExportedTarget {
                    metric: metric.to_owned(),
                    value,
                });
            }
        }
        // ... and its weight, when it has no weight log.
        if let Some(kg) = self.profile.weight_kg
            && self.weights.is_empty()
        {
            self.weights.push(ExportedWeight {
                day: today.to_owned(),
                kg,
                source: WeightSource::Manual,
                set_at: None,
            });
        }
        let targets = TargetsInput {
            targets: self
                .targets
                .iter()
                .map(|t| TargetInput {
                    metric: Some(t.metric.clone()),
                    nutrient: super::Gone::default(),
                    value: t.value,
                })
                .collect(),
            rev: None,
        }
        .checked()
        .map_err(within("targets", "targets".to_owned()))?;
        self.check_days()?;
        self.quick_adds_to_foods();
        self.check_foods()?;
        self.check_exercises()?;
        let foods: BTreeSet<String> = self.foods.iter().map(|f| f.reference.clone()).collect();
        if let Some(r) = self.favorites.iter().find(|r| !foods.contains(r.as_str())) {
            return Err(Error::invalid_field(
                "favorites",
                format!("unknown food ref “{r}”"),
            ));
        }
        self.check_entries(&foods)?;
        if let Some(r) = self.water_food.as_ref().filter(|r| !foods.contains(*r)) {
            return Err(Error::invalid_field(
                "water_food",
                format!("unknown food ref “{r}”"),
            ));
        }
        self.check_workouts()?;
        self.check_sessions()?;
        self.check_habits()?;
        self.check_activity()?;
        if let Some(b) = &mut self.openscale {
            b.bound_username = opt_text(b.bound_username.as_deref(), "bound_username", LABEL_MAX)
                .map_err(within("openscale", "openscale".to_owned()))?;
        }
        Ok(CheckedImport {
            profile,
            targets,
            file: self,
        })
    }

    /// Quick adds (entries with nutrients and no food, logged before quick
    /// adds were removed) become archived foods of their own, one per name
    /// and values, as migration 31 turned the stored ones.
    fn quick_adds_to_foods(&mut self) {
        let mut refs: BTreeSet<String> = self.foods.iter().map(|f| f.reference.clone()).collect();
        let mut made: BTreeMap<(String, String), String> = BTreeMap::new();
        for e in &mut self.entries {
            let (false, None, Some(n)) = (e.imported, &e.food, &e.nutrients) else {
                continue;
            };
            let (grams, per100) = n.per100_fitting(e.grams);
            let values = serde_json::to_string(&per100).unwrap_or_default();
            let reference = made
                .entry((e.name.clone(), values))
                .or_insert_with(|| {
                    // One of these is free: there are more than refs.
                    let reference = (0..=refs.len())
                        .map(|i| format!("quick-{i}"))
                        .find(|r| !refs.contains(r))
                        .unwrap_or_default();
                    refs.insert(reference.clone());
                    self.foods.push(ExportedFood {
                        reference: reference.clone(),
                        name: e.name.clone(),
                        brand: None,
                        barcode: None,
                        source: Source::Custom,
                        fineli_id: None,
                        per100,
                        cooked_g: None,
                        makes: None,
                        instructions: None,
                        archived: true,
                        category: None,
                        servings: Vec::new(),
                        items: Vec::new(),
                    });
                    reference
                })
                .clone();
            e.food = Some(reference);
            e.grams = Some(grams);
        }
    }

    /// Weights, measurements, notes and check-ins as their routes take them
    /// (a check-in's day once); imported
    /// totals with a known shape, one per day and group.
    fn check_days(&mut self) -> Result<(), Error> {
        for w in &self.weights {
            let at = within("weights", w.day.clone());
            checked_day_so_far(&w.day).map_err(&at)?;
            WeightInput {
                kg: w.kg,
                set_at: None,
            }
            .checked()
            .map_err(&at)?;
            // Kept as it was (no clamp): it orders the weight against
            // readings already made.
            if w.set_at.is_some_and(|t| t < 0) {
                return Err(at(bad("set_at must be epoch milliseconds")));
            }
        }
        for m in &self.measurements {
            let at = within("measurements", m.day.clone());
            checked_day_so_far(&m.day).map_err(&at)?;
            MeasurementInput { value: m.value }.checked().map_err(&at)?;
        }
        for n in &mut self.notes {
            let at = within("notes", n.day.clone());
            checked_day_so_far(&n.day).map_err(&at)?;
            n.text = NoteInput {
                text: n.text.clone(),
            }
            .checked()
            .map_err(&at)?
            .text;
        }
        let mut days = BTreeSet::new();
        for c in &mut self.check_ins {
            let at = within("check_ins", c.day.clone());
            checked_day_so_far(&c.day).map_err(&at)?;
            let input = CheckInInput {
                mood: c.mood,
                energy: c.energy,
                stress: c.stress,
                tags: std::mem::take(&mut c.tags),
            }
            .checked()
            .map_err(&at)?;
            c.tags = input.tags;
            if !days.insert(c.day.clone()) {
                return Err(at(bad("the day is listed twice")));
            }
        }
        let mut readings = BTreeSet::new();
        for r in &mut self.scale_readings {
            let at = within("scale_readings", r.day.clone());
            r.source = text(&r.source, "source", LABEL_MAX).map_err(&at)?;
            if !is_date(&r.day) {
                return Err(at(bad("day must be YYYY-MM-DD")));
            }
            WeightInput {
                kg: r.weight,
                set_at: None,
            }
            .checked()
            .map_err(&at)?;
            let percent = |v: Option<f64>| v.is_none_or(|v| v > 0.0 && v <= 100.0);
            if !(percent(r.body_fat) && percent(r.water) && percent(r.muscle)) {
                return Err(at(bad("body fat, water and muscle must be 0–100 %")));
            }
            if !readings.insert((r.source.clone(), r.source_user, r.taken_at)) {
                return Err(at(bad("a reading is listed twice")));
            }
        }
        let mut seen = BTreeSet::new();
        for t in &mut self.day_totals {
            let at = within("day_totals", t.day.clone());
            if !is_date(&t.day) {
                return Err(at(bad("day must be YYYY-MM-DD")));
            }
            t.group = text(&t.group, "group", LABEL_MAX).map_err(&at)?;
            nutrients_ok(&t.nutrients).map_err(&at)?;
            if !seen.insert((t.day.clone(), t.group.clone())) {
                return Err(at(bad(format!("{} is listed twice", t.group))));
            }
        }
        Ok(())
    }

    /// Health Connect activity within the sync's value bounds (no window
    /// applies to a file), each day and workout key once.
    fn check_activity(&mut self) -> Result<(), Error> {
        let mut days = BTreeSet::new();
        for d in &self.activity_days {
            let at = within("activity_days", d.day.clone());
            if checked_day(d.clone()).is_none() {
                return Err(at(bad("a day's values must be in bounds, one at least")));
            }
            if !days.insert(d.day.clone()) {
                return Err(at(bad("the day is listed twice")));
            }
        }
        let mut keys = BTreeSet::new();
        for s in &mut self.activity_sessions {
            let at = within("activity_sessions", s.day.clone());
            *s = checked_session(s.clone()).ok_or_else(|| {
                at(bad(
                    "a workout's key, times, type or energy is out of bounds",
                ))
            })?;
            if !keys.insert(s.key.clone()) {
                return Err(at(bad(format!("workout {} is listed twice", s.key))));
            }
        }
        if self.workout_tombstones.len() > TOMBSTONES_MAX {
            return Err(Error::invalid_field(
                "workout_tombstones",
                format!("workout_tombstones holds at most {TOMBSTONES_MAX} items"),
            ));
        }
        let mut keys = BTreeSet::new();
        for t in &mut self.workout_tombstones {
            let at = within("workout_tombstones", t.key.clone());
            if !is_key(&t.key) || !keys.insert(t.key.clone()) {
                return Err(at(bad("a key must be a Health Connect id, once")));
            }
            if let Some(s) = &t.start_at {
                let ts: jiff::Timestamp =
                    s.parse().map_err(|_| at(bad("start_at must be a time")))?;
                t.start_at = Some(ts.to_string());
            }
        }
        Ok(())
    }

    /// Each food as a food or recipe input would be checked; an invalid
    /// barcode is dropped, not refused. Ordered ingredients first.
    fn check_foods(&mut self) -> Result<(), Error> {
        unique_refs("foods", self.foods.iter().map(|f| f.reference.as_str()))?;
        let index: BTreeMap<String, usize> = self
            .foods
            .iter()
            .enumerate()
            .map(|(i, f)| (f.reference.clone(), i))
            .collect();
        for f in &mut self.foods {
            let at = within("foods", format!("food “{}”", f.reference));
            if f.source == Source::Recipe {
                let items = f
                    .items
                    .iter()
                    .map(|i| {
                        let food_id = index
                            .get(&i.food)
                            .ok_or_else(|| bad(format!("unknown ingredient ref “{}”", i.food)))?;
                        Ok(ItemInput {
                            food_id: i64::try_from(*food_id).unwrap_or(i64::MAX),
                            grams: i.grams,
                        })
                    })
                    .collect::<Result<Vec<_>, Error>>()
                    .map_err(&at)?;
                let input = RecipeInput {
                    name: f.name.clone(),
                    cooked_g: f.cooked_g,
                    makes: f.makes,
                    items,
                    servings: f.servings.clone(),
                    archived: f.archived,
                    category: f.category.clone(),
                    instructions: f.instructions.clone(),
                    rev: None,
                }
                .checked()
                .map_err(&at)?;
                f.name = input.name;
                f.servings = input.servings;
                f.category = input.category;
                f.instructions = input.instructions;
                for (item, checked) in f.items.iter_mut().zip(input.items) {
                    item.grams = checked.grams;
                }
            } else {
                if f.instructions.is_some() {
                    return Err(at(bad("only a recipe has instructions")));
                }
                if !f.items.is_empty() {
                    return Err(at(bad("only a recipe has ingredients")));
                }
                let input = FoodInput {
                    name: f.name.clone(),
                    brand: f.brand.clone(),
                    barcode: f.barcode.clone().filter(|b| is_barcode(b)),
                    per100: f.per100.clone(),
                    servings: f.servings.clone(),
                    archived: f.archived,
                    category: f.category.clone(),
                    rev: None,
                }
                .checked_kept()
                .map_err(&at)?;
                f.name = input.name;
                f.brand = input.brand;
                f.barcode = input.barcode;
                f.per100 = input.per100;
                f.servings = input.servings;
                f.category = input.category;
            }
        }
        self.foods = ingredients_first(std::mem::take(&mut self.foods), &index)?;
        Ok(())
    }

    /// Workouts as their route takes them (exercises by ref), refs once;
    /// plans as theirs, naming a workout here, uids once.
    fn check_workouts(&mut self) -> Result<(), Error> {
        unique_refs(
            "workouts",
            self.workouts.iter().map(|w| w.reference.as_str()),
        )?;
        // Stand-in ids, one per exercise ref: the real ones are the
        // store's to find.
        let exercises: BTreeMap<&str, i64> = self
            .exercises
            .iter()
            .zip(0..)
            .map(|(x, i)| (x.reference.as_str(), i))
            .collect();
        for w in &mut self.workouts {
            let at = within("workouts", format!("workout “{}”", w.reference));
            let input = WorkoutInput {
                name: w.name.clone(),
                steps: ExportedStep::to_steps(&w.steps, &exercises).map_err(&at)?,
                minutes: w.minutes,
                kcal: w.kcal,
                rev: None,
            }
            .checked()
            .map_err(&at)?;
            w.name = input.name;
        }
        let workouts: BTreeSet<&str> = self.workouts.iter().map(|w| w.reference.as_str()).collect();
        let mut uids = BTreeSet::new();
        for p in &self.plans {
            let at = within("plans", p.day.clone());
            if !workouts.contains(p.workout.as_str()) {
                return Err(at(bad(format!("unknown workout ref “{}”", p.workout))));
            }
            PlanInput {
                day: p.day.clone(),
                workout_id: 0,
                uid: p.uid.clone(),
            }
            .checked()
            .map_err(&at)?;
            checked_created_at(p.created_at.as_deref()).map_err(&at)?;
            if let Some(uid) = &p.uid
                && !uids.insert(uid.as_str())
            {
                return Err(at(bad(format!("uid “{uid}” is listed twice"))));
            }
        }
        for s in &self.sessions {
            if let Some(r) = s.workout.as_deref().filter(|r| !workouts.contains(r)) {
                return Err(Error::invalid_field(
                    "sessions",
                    format!("session “{}”: unknown workout ref “{r}”", s.uid),
                ));
            }
        }
        Ok(())
    }

    /// Each exercise as an exercise input would be checked; roots first.
    fn check_exercises(&mut self) -> Result<(), Error> {
        unique_refs(
            "exercises",
            self.exercises.iter().map(|x| x.reference.as_str()),
        )?;
        let refs: BTreeSet<String> = self.exercises.iter().map(|x| x.reference.clone()).collect();
        for x in &mut self.exercises {
            let at = within("exercises", format!("exercise “{}”", x.reference));
            if let Some(v) = &x.variant_of
                && !refs.contains(v)
            {
                return Err(at(bad(format!("unknown variant_of ref “{v}”"))));
            }
            let input = ExerciseInput {
                name: x.name.clone(),
                measure: x.measure,
                variant_of: None,
                traits: x.traits.clone(),
                rev: None,
            }
            .checked()
            .map_err(&at)?;
            x.name = input.name;
        }
        self.exercises.sort_by_key(|x| x.variant_of.is_some());
        Ok(())
    }

    /// Entries: uids well formed and each once (checked before anything
    /// else about them), then each as stored rows look.
    fn check_entries(&mut self, foods: &BTreeSet<String>) -> Result<(), Error> {
        let mut uids = BTreeSet::new();
        for e in &self.entries {
            checked_stored_uid(&e.uid).map_err(within("entries", format!("uid “{}”", e.uid)))?;
            if !uids.insert(e.uid.as_str()) {
                return Err(Error::invalid_field(
                    "entries",
                    format!("uid “{}” is listed twice", e.uid),
                ));
            }
        }
        for e in &mut self.entries {
            let at = within("entries", format!("entry “{}”", e.uid));
            check_entry(e, foods).map_err(&at)?;
        }
        Ok(())
    }

    /// Sessions as their route takes them (sets by exercise ref), uids once.
    fn check_sessions(&mut self) -> Result<(), Error> {
        let exercises: BTreeMap<&str, i64> = self
            .exercises
            .iter()
            .zip(0..)
            .map(|(x, i)| (x.reference.as_str(), i))
            .collect();
        let (mut uids, mut keys) = (BTreeSet::new(), BTreeSet::new());
        for s in &mut self.sessions {
            let at = within("sessions", format!("session “{}”", s.uid));
            if !uids.insert(s.uid.clone()) {
                return Err(at(bad("uid is listed twice")));
            }
            // A set-based session has no distance: dropped as
            // migration 33 dropped stored ones, not refused.
            if s.kind.is_none() {
                s.distance_m = None;
            }
            let sets = s
                .sets
                .iter()
                .map(|set| {
                    let exercise_id = *exercises
                        .get(set.exercise.as_str())
                        .ok_or_else(|| bad(format!("unknown exercise ref “{}”", set.exercise)))?;
                    Ok(SessionSet {
                        exercise_id,
                        name: set.name.clone(),
                        reps: set.reps,
                        seconds: set.seconds,
                        kg: set.kg,
                        side: set.side,
                    })
                })
                .collect::<Result<Vec<_>, Error>>()
                .map_err(&at)?;
            let input = SessionInput {
                day: s.day.clone(),
                workout_id: None,
                name: s.name.clone(),
                minutes: s.minutes,
                kcal: s.kcal,
                sets,
                uid: Some(s.uid.clone()),
                kind: s.kind,
                distance_m: s.distance_m,
                start_at: s.start_at.clone(),
                rev: None,
            }
            .checked()
            .map_err(&at)?;
            s.name = input.name;
            s.start_at = input.start_at;
            if let Some(key) = &s.source_key
                && !(is_key(key) && keys.insert(key.clone()))
            {
                return Err(at(bad("source_key must be a Health Connect id, once")));
            }
            if s.source == SessionSource::HealthConnect && s.source_key.is_none() {
                return Err(at(bad("a synced session needs its source_key")));
            }
            checked_created_at(s.created_at.as_deref()).map_err(&at)?;
        }
        Ok(())
    }

    /// Trackers as their route takes them, names once (ignoring case), at
    /// most [`HABITS_MAX`]; each day as its route takes it, once.
    fn check_habits(&mut self) -> Result<(), Error> {
        if self.habits.len() > HABITS_MAX as usize {
            return Err(Error::invalid_field(
                "habits",
                format!("at most {HABITS_MAX} habits"),
            ));
        }
        let mut names = BTreeSet::new();
        for h in &mut self.habits {
            let at = within("habits", format!("habit “{}”", h.name));
            let input = HabitInput {
                name: h.name.clone(),
                unit: h.unit.clone(),
                // Files from before goals had a direction say `day_limit`:
                // an at-most goal, the default direction.
                goal_value: h.goal_value.or(h.day_limit),
                goal_dir: h.goal_dir.map(|d| d.as_str().to_owned()),
                day_limit: super::Gone::default(),
                archived: h.archived,
                rev: None,
            }
            .checked()
            .map_err(&at)?;
            if !names.insert(input.name.to_lowercase()) {
                return Err(at(bad("name is listed twice")));
            }
            (h.name, h.unit) = (input.name, input.unit);
            (h.goal_value, h.goal_dir, h.day_limit) =
                (input.goal_value, Some(input.goal_dir), None);
            checked_created_at(h.created_at.as_deref()).map_err(&at)?;
            let mut days = BTreeSet::new();
            for d in &h.days {
                checked_day_so_far(&d.day).map_err(&at)?;
                checked_habit_amount(d.amount).map_err(&at)?;
                if !days.insert(d.day.as_str()) {
                    return Err(at(bad(format!("{} is listed twice", d.day))));
                }
            }
        }
        Ok(())
    }
}

/// One entry as stored rows look: imported history has no food and no
/// nutrients (its totals are `day_totals`); a logged food names one. Quick
/// adds were made foods before (`quick_adds_to_foods`).
fn check_entry(e: &mut ExportedEntry, foods: &BTreeSet<String>) -> Result<(), Error> {
    if !is_date(&e.day) {
        return Err(bad("day must be YYYY-MM-DD"));
    }
    e.group = if e.imported {
        text(&e.group, "group", LABEL_MAX)?
    } else {
        checked_group(&e.group)?.to_owned()
    };
    e.src_group = opt_text(e.src_group.as_deref(), "source group", LABEL_MAX)?;
    e.name = text(&e.name, "name", NAME_MAX)?;
    e.amount = text(&e.amount, "amount", NAME_MAX)?;
    e.serving = opt_text(e.serving.as_deref(), "serving", LABEL_MAX)?;
    if let Some(g) = e.grams {
        grams(g)?;
    }
    if e.quantity.is_some_and(|q| !(q.is_finite() && q > 0.0)) {
        return Err(bad("quantity must be more than 0"));
    }
    if let Some(n) = &e.nutrients {
        nutrients_ok(n)?;
    }
    if let Some(t) = &e.time {
        checked_time(t)?;
    }
    if !is_timestamp(&e.created_at) {
        return Err(bad("created_at must be YYYY-MM-DDTHH:MM:SSZ"));
    }
    if let Some(f) = &e.food
        && !foods.contains(f)
    {
        return Err(bad(format!("unknown food ref “{f}”")));
    }
    let shape_ok = if e.imported {
        e.food.is_none() && e.nutrients.is_none()
    } else {
        e.food.is_some()
    };
    if !shape_ok {
        return Err(bad(
            "imported history has no food and no nutrients, a logged food names its food",
        ));
    }
    Ok(())
}

/// Foods reordered so every recipe comes after its ingredients.
///
/// # Errors
/// A recipe containing itself, through any depth.
fn ingredients_first(
    foods: Vec<ExportedFood>,
    index: &BTreeMap<String, usize>,
) -> Result<Vec<ExportedFood>, Error> {
    // 0 unvisited, 1 on the path, 2 placed.
    fn visit(
        i: usize,
        foods: &[ExportedFood],
        index: &BTreeMap<String, usize>,
        state: &mut [u8],
        order: &mut Vec<usize>,
    ) -> Result<(), Error> {
        match state[i] {
            2 => return Ok(()),
            1 => {
                return Err(Error::invalid_field(
                    "foods",
                    format!("recipe “{}” contains itself", foods[i].reference),
                ));
            }
            _ => {}
        }
        state[i] = 1;
        for item in &foods[i].items {
            visit(index[&item.food], foods, index, state, order)?;
        }
        state[i] = 2;
        order.push(i);
        Ok(())
    }
    let mut state = vec![0; foods.len()];
    let mut order = Vec::with_capacity(foods.len());
    for i in 0..foods.len() {
        visit(i, &foods, index, &mut state, &mut order)?;
    }
    let mut slots: Vec<Option<ExportedFood>> = foods.into_iter().map(Some).collect();
    Ok(order.into_iter().filter_map(|i| slots[i].take()).collect())
}

/// `kaloriina-<slug>-<day>.json`: the name as lower-case ASCII letters and
/// digits, other runs as one `-` ("profile" if nothing is left).
#[must_use]
pub fn export_filename(name: &str, day: &str) -> String {
    let mut slug = String::new();
    for c in name.chars() {
        if c.is_ascii_alphanumeric() {
            slug.push(c.to_ascii_lowercase());
        } else if !slug.is_empty() && !slug.ends_with('-') {
            slug.push('-');
        }
    }
    let slug = slug.trim_end_matches('-');
    let slug = if slug.is_empty() { "profile" } else { slug };
    format!("kaloriina-{slug}-{day}.json")
}

/// The UTF-8 name for `filename*` (RFC 8187), percent-encoded: the same
/// file name with the profile's own spelling.
#[must_use]
pub fn export_filename_utf8(name: &str, day: &str) -> String {
    use std::fmt::Write;
    let mut out = String::new();
    for b in format!("kaloriina-{name}-{day}.json").bytes() {
        if b.is_ascii_alphanumeric() || b"!#$&+-.^_`|~".contains(&b) {
            out.push(char::from(b));
        } else {
            let _ = write!(out, "%{b:02X}");
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stored_uids() {
        for ok in ["abcdefgh", "abcdefgh:1", "abcdefgh:12", &"a".repeat(32)] {
            assert!(checked_stored_uid(ok).is_ok(), "{ok}");
        }
        for bad in [
            "abc",
            "abcdefgh:",
            "abcdefgh:x",
            "abcdefgh:1:2",
            "abc def gh",
            ":1",
        ] {
            assert!(checked_stored_uid(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn timestamps() {
        assert!(is_timestamp("2026-10-08T12:30:00Z"));
        assert!(!is_timestamp("2026-10-08 12:30:00"));
        assert!(!is_timestamp("2026-13-08T12:30:00Z"));
    }

    #[test]
    fn filenames() {
        assert_eq!(
            export_filename("Äiti & Anna", "2026-10-08"),
            "kaloriina-iti-anna-2026-10-08.json"
        );
        assert_eq!(
            export_filename("ÄÖ", "2026-10-08"),
            "kaloriina-profile-2026-10-08.json"
        );
        assert_eq!(
            export_filename_utf8("Ä b", "2026-10-08"),
            "kaloriina-%C3%84%20b-2026-10-08.json"
        );
    }
}
