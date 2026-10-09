//! Exercises and their traits (closed vocabularies).

use super::prelude::*;

text_enum! {
    /// How an exercise is measured: repeated for a count, or done for a time.
    pub enum Measure {
        Reps = "reps",
        Time = "time",
    }
}

text_enum! {
    /// Where an exercise comes from: the built-in base set, or added by you.
    pub enum ExerciseSource {
        Base = "base",
        Custom = "custom",
    }
}

/// What an exercise is, for finding it. Every value comes from the closed
/// vocabularies below, so a search for "rings" or "hamstrings" finds all of
/// them. Two drive the step rules ([`step_fits`]): `laterality` (only
/// unilateral exercises take a side) and `load` (whether a step takes a
/// weight).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ExerciseTraits {
    pub equipment: Vec<String>,
    pub pattern: Option<String>,
    pub region: Option<String>,
    pub group: Option<String>,
    pub primary: Vec<String>,
    pub secondary: Vec<String>,
    pub mechanics: Option<String>,
    pub laterality: Option<String>,
    pub difficulty: Option<String>,
    /// Whether a step of it takes a weight: never, optionally, or always
    /// (absent: optionally).
    pub load: Option<String>,
}

pub const EQUIPMENT: &[&str] = &[
    "bodyweight",
    "barbell",
    "dumbbell",
    "kettlebell",
    "pull-up bar",
    "rings",
    "parallel bars",
    "bench",
    "box",
    "cable",
    "machine",
    "landmine",
    "trap bar",
    "ez bar",
    "resistance band",
    "ab wheel",
    "jump rope",
    "rowing machine",
    "bike",
    "elliptical",
    "stair climber",
    "ski erg",
    "plate",
    "wall",
];
pub const PATTERNS: &[&str] = &[
    "squat",
    "hinge",
    "lunge",
    "horizontal push",
    "vertical push",
    "horizontal pull",
    "vertical pull",
    "carry",
    "anti-extension",
    "anti-rotation",
    "anti-lateral flexion",
    "rotation",
    "spinal flexion",
    "spinal extension",
    "hip extension",
    "hip abduction",
    "knee flexion",
    "knee extension",
    "elbow flexion",
    "elbow extension",
    "shoulder abduction",
    "shoulder flexion",
    "shoulder extension",
    "scapular elevation",
    "plyometric",
    "olympic lift",
    "isometric hold",
    "conditioning",
    "plantar flexion",
    "horizontal adduction",
    "horizontal abduction",
    "get-up",
    "mobility",
    "stretch",
];
pub const REGIONS: &[&str] = &["upper body", "lower body", "core", "full body"];
pub const MUSCLE_GROUPS: &[&str] = &[
    "chest",
    "back",
    "shoulders",
    "arms",
    "legs",
    "glutes",
    "core",
    "full body",
];
pub const MUSCLES: &[&str] = &[
    "pectorals",
    "upper pectorals",
    "latissimus dorsi",
    "trapezius",
    "rhomboids",
    "front deltoids",
    "side deltoids",
    "rear deltoids",
    "rotator cuff",
    "biceps",
    "brachialis",
    "forearms",
    "triceps",
    "quadriceps",
    "hamstrings",
    "glutes",
    "adductors",
    "abductors",
    "calves",
    "hip flexors",
    "rectus abdominis",
    "obliques",
    "transverse abdominis",
    "erector spinae",
    "serratus anterior",
];
pub const MECHANICS: &[&str] = &["compound", "isolation"];
pub const LATERALITY: &[&str] = &["bilateral", "unilateral", "alternating"];
pub const DIFFICULTY: &[&str] = &["beginner", "intermediate", "advanced"];
pub const LOAD: &[&str] = &["none", "optional", "required"];

/// One trait as clients show and edit it: its label, whether it holds
/// several values, whether search filters by it, and its values (with
/// labels where the value alone doesn't read well).
#[derive(Debug, Serialize)]
pub struct Trait {
    pub key: &'static str,
    pub label: &'static str,
    pub many: bool,
    pub facet: bool,
    pub values: &'static [&'static str],
    #[serde(skip_serializing_if = "<[_]>::is_empty")]
    pub value_labels: &'static [(&'static str, &'static str)],
}

const fn plain(
    key: &'static str,
    label: &'static str,
    many: bool,
    facet: bool,
    values: &'static [&'static str],
) -> Trait {
    Trait {
        key,
        label,
        many,
        facet,
        values,
        value_labels: &[],
    }
}

/// The traits in the order they're shown and edited.
pub const TRAITS: &[Trait] = &[
    Trait {
        key: "laterality",
        label: "Sides",
        many: false,
        facet: false,
        values: LATERALITY,
        value_labels: &[
            ("bilateral", "Both sides together"),
            ("unilateral", "One side at a time"),
            ("alternating", "Alternating sides"),
        ],
    },
    Trait {
        key: "load",
        label: "Weight",
        many: false,
        facet: false,
        values: LOAD,
        value_labels: &[
            ("none", "Takes no weight"),
            ("optional", "Optional"),
            ("required", "Always weighted"),
        ],
    },
    plain("equipment", "Equipment", true, true, EQUIPMENT),
    plain("pattern", "Movement pattern", false, true, PATTERNS),
    plain("region", "Body region", false, true, REGIONS),
    plain("group", "Muscle group", false, false, MUSCLE_GROUPS),
    plain("primary", "Primary muscles", true, false, MUSCLES),
    plain("secondary", "Secondary muscles", true, false, MUSCLES),
    plain(
        "mechanics",
        "Compound or isolation",
        false,
        false,
        MECHANICS,
    ),
    plain("difficulty", "Difficulty", false, true, DIFFICULTY),
];

/// A move workouts are built from. A variant (diamond push-up) is an
/// exercise of its own, linked to its root move (push-up) by `variant_of`,
/// one level deep: variants differ in what they take (side, weight). Side
/// and weight themselves are set on each step.
#[derive(Debug, Clone, Deserialize)]
pub struct ExerciseInput {
    pub name: String,
    pub measure: Measure,
    #[serde(default)]
    pub variant_of: Option<i64>,
    #[serde(flatten)]
    pub traits: ExerciseTraits,
    #[serde(default)]
    pub rev: Option<i64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Exercise {
    pub id: i64,
    pub name: String,
    pub measure: Measure,
    pub source: ExerciseSource,
    pub variant_of: Option<i64>,
    #[serde(flatten)]
    pub traits: ExerciseTraits,
    pub rev: i64,
}

impl ExerciseInput {
    /// # Errors
    /// A blank or long name, or a trait outside its vocabulary.
    pub fn checked(mut self) -> Result<Self, Error> {
        self.name = text(&self.name, "name", NAME_MAX)?;
        self.traits.check()?;
        Ok(self)
    }
}

impl ExerciseTraits {
    /// Every value from its vocabulary, none twice.
    ///
    /// # Errors
    /// The first value that isn't, named with its field.
    pub fn check(&self) -> Result<(), Error> {
        fn known<'a>(
            field: &str,
            vocabulary: &[&str],
            values: impl IntoIterator<Item = &'a String>,
        ) -> Result<(), Error> {
            let mut seen = Vec::new();
            for v in values {
                if !vocabulary.contains(&v.as_str()) {
                    return Err(bad(format!("{field}: unknown “{v}”")));
                }
                if seen.contains(&v) {
                    return Err(bad(format!("{field}: “{v}” listed twice")));
                }
                seen.push(v);
            }
            Ok(())
        }
        known("equipment", EQUIPMENT, &self.equipment)?;
        known("pattern", PATTERNS, &self.pattern)?;
        known("region", REGIONS, &self.region)?;
        known("group", MUSCLE_GROUPS, &self.group)?;
        known("primary", MUSCLES, &self.primary)?;
        known("secondary", MUSCLES, &self.secondary)?;
        known("mechanics", MECHANICS, &self.mechanics)?;
        known("laterality", LATERALITY, &self.laterality)?;
        known("difficulty", DIFFICULTY, &self.difficulty)?;
        known("load", LOAD, &self.load)?;
        Ok(())
    }
}
