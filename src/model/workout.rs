//! Workouts: the step tree, its limits and the step rules.

use super::Exercise;
use super::prelude::*;

text_enum! {
    /// The side a one-sided step works.
    pub enum Side {
        Left = "left",
        Right = "right",
    }
}

/// One step of a workout: an exercise done for reps or for seconds (optionally
/// with a weight, and on one side if it's one-sided), a rest, or a repeat doing
/// its steps a number of times (with `every`, a round takes that many seconds:
/// the run pads each round out, EMOM style), or a note (a name, words to read
/// where it stands, or both: never run, timed or counted). Stored as JSON as
/// is, so a renamed variant or field needs a migration rewriting the stored
/// steps.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Step {
    Exercise {
        exercise_id: i64,
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
        steps: Vec<Step>,
    },
    Note {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        text: Option<String>,
    },
}

/// A workout. Its time is estimated from its steps and its energy from
/// that and the viewing profile's weight; `minutes` and `kcal` override
/// the estimates.
#[derive(Debug, Clone, Deserialize)]
pub struct WorkoutInput {
    pub name: String,
    pub steps: Vec<Step>,
    #[serde(default)]
    pub minutes: Option<u32>,
    #[serde(default)]
    pub kcal: Option<u32>,
    /// Notes (how it's done, or anything): up to [`NOTES_MAX`] characters,
    /// line breaks kept; blank or absent is none.
    #[serde(default)]
    pub notes: Option<String>,
    /// Hidden from the lists to start or plan; past sessions and plans
    /// keep it.
    #[serde(default)]
    pub archived: bool,
    #[serde(default)]
    pub rev: Option<i64>,
    /// A create's retry key: a create naming one saved before
    /// answers with that record. Ignored by an update.
    #[serde(default)]
    pub uid: Option<String>,
}

/// What names a workout, across every profile: once used it is archived,
/// not deleted.
#[derive(Debug, Clone, Serialize)]
pub struct WorkoutUsage {
    pub activities: i64,
    pub plans: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Workout {
    pub id: i64,
    pub name: String,
    pub steps: Vec<Step>,
    pub minutes: Option<u32>,
    pub kcal: Option<u32>,
    pub notes: Option<String>,
    pub archived: bool,
    pub rev: i64,
}

impl Workout {
    /// Whether `w` is this workout as written: every field a person sees or
    /// set (name, steps, time, energy, notes, archived). An import binds a
    /// file's workout only to such a one, so nothing of the file is dropped.
    /// A field added to [`WorkoutInput`] doesn't compile here until it's
    /// decided.
    #[must_use]
    pub fn same_definition(&self, w: &WorkoutInput) -> bool {
        let WorkoutInput {
            name,
            steps,
            minutes,
            kcal,
            notes,
            archived,
            rev: _,
            uid: _,
        } = w;
        (
            &self.name,
            &self.steps,
            self.minutes,
            self.kcal,
            &self.notes,
            self.archived,
        ) == (name, steps, *minutes, *kcal, notes, *archived)
    }
}

impl WorkoutInput {
    /// Trimmed names, steps within limits. Errors name the step, counting
    /// from 1 and into repeats: "step 2.3: …". Whether each exercise exists
    /// and fits its step is the store's check (see [`exercise_steps`]).
    ///
    /// # Errors
    /// Blank or long names, empty workouts or repeats, numbers out of range,
    /// repeats nested too deep, too many steps unrolled.
    pub fn checked(mut self) -> Result<Self, Error> {
        self.name = text(&self.name, "name", NAME_MAX)?;
        super::checked_opt_uid(self.uid.as_deref())?;
        if self.steps.is_empty() {
            return Err(bad("a workout needs at least one step"));
        }
        if only_notes(&self.steps) {
            return Err(bad("a workout needs at least one step besides notes"));
        }
        if self
            .minutes
            .is_some_and(|m| !(1..=MINUTES_MAX).contains(&m))
        {
            return Err(Error::invalid_field(
                "minutes",
                format!("minutes must be 1–{MINUTES_MAX}"),
            ));
        }
        if self.kcal.is_some_and(|k| !(1..=KCAL_MAX).contains(&k)) {
            return Err(Error::invalid_field(
                "kcal",
                format!("kcal must be 1–{KCAL_MAX}"),
            ));
        }
        self.notes = opt_multiline(self.notes.as_deref(), "notes", NOTES_MAX)?;
        check_steps(&mut self.steps, "", 1)?;
        if run_length(&self.steps) > RUN_STEPS_MAX {
            return Err(bad(format!(
                "a workout may take at most {RUN_STEPS_MAX} steps once its repeats are unrolled"
            )));
        }
        Ok(self)
    }
}

/// "2.3": the position of step `i` (from 0) under `parent`.
pub(super) fn position(parent: &str, i: usize) -> String {
    if parent.is_empty() {
        (i + 1).to_string()
    } else {
        format!("{parent}.{}", i + 1)
    }
}

pub(super) fn check_steps(steps: &mut [Step], parent: &str, depth: usize) -> Result<(), Error> {
    for (i, step) in steps.iter_mut().enumerate() {
        let at = position(parent, i);
        let here = |msg: &str| bad(format!("step {at}: {msg}"));
        let seconds_ok = |s: u32| (1..=STEP_SECONDS_MAX).contains(&s);
        match step {
            Step::Exercise {
                reps, seconds, kg, ..
            } => {
                match (reps.is_some(), seconds.is_some()) {
                    (true, true) => return Err(here("give reps or seconds, not both")),
                    (false, false) => return Err(here("give reps or seconds")),
                    _ => {}
                }
                if reps.is_some_and(|r| !(1..=REPS_MAX).contains(&r)) {
                    return Err(here(&format!("reps must be 1–{REPS_MAX}")));
                }
                if seconds.is_some_and(|s| !seconds_ok(s)) {
                    return Err(here(&format!("seconds must be 1–{STEP_SECONDS_MAX}")));
                }
                if kg.is_some_and(|k| !(k > 0.0 && k <= KG_MAX)) {
                    return Err(here(&format!(
                        "kg must be more than 0 and at most {KG_MAX}"
                    )));
                }
            }
            Step::Rest { seconds } => {
                if !seconds_ok(*seconds) {
                    return Err(here(&format!("seconds must be 1–{STEP_SECONDS_MAX}")));
                }
            }
            Step::Repeat {
                name,
                times,
                every,
                steps,
            } => {
                if depth > DEPTH_MAX {
                    return Err(here(&format!("repeats nest at most {DEPTH_MAX} deep")));
                }
                *name = opt_text(name.as_deref(), "repeat name", NAME_MAX)
                    .map_err(|e| here(&e.to_string()))?;
                if !(1..=TIMES_MAX).contains(times) {
                    return Err(here(&format!("times must be 1–{TIMES_MAX}")));
                }
                if every.is_some_and(|s| !seconds_ok(s)) {
                    return Err(here(&format!("every must be 1–{STEP_SECONDS_MAX} s")));
                }
                if steps.is_empty() {
                    return Err(here("a repeat needs at least one step"));
                }
                if only_notes(steps) {
                    return Err(here("a repeat needs at least one step besides notes"));
                }
                check_steps(steps, &at, depth + 1)?;
            }
            Step::Note { name, text } => {
                *name = opt_text(name.as_deref(), "note name", LABEL_MAX)
                    .map_err(|e| here(&e.to_string()))?;
                *text = opt_multiline(text.as_deref(), "note", NOTES_MAX)
                    .map_err(|e| here(&e.to_string()))?;
                if name.is_none() && text.is_none() {
                    return Err(here("a note needs a name or text"));
                }
            }
        }
    }
    Ok(())
}

/// Whether nothing in `steps` is done: every one a note.
fn only_notes(steps: &[Step]) -> bool {
    steps.iter().all(|s| matches!(s, Step::Note { .. }))
}

/// Steps taken once repeats are unrolled (notes take none), counting the pad
/// that ends each round of a repeat done `every` so many seconds.
pub(super) fn run_length(steps: &[Step]) -> u64 {
    steps
        .iter()
        .map(|s| match s {
            Step::Repeat {
                times,
                every,
                steps,
                ..
            } => u64::from(*times) * (run_length(steps) + u64::from(every.is_some())),
            Step::Note { .. } => 0,
            _ => 1,
        })
        .sum()
}

/// An exercise step, where it is and what it asks for.
pub struct ExerciseStep {
    /// "2.3", as in error messages.
    pub at: String,
    pub exercise_id: i64,
    pub for_reps: bool,
    pub weighted: bool,
    pub sided: bool,
}

/// Every exercise step, depth first, in order.
#[must_use]
pub fn exercise_steps(steps: &[Step]) -> Vec<ExerciseStep> {
    fn walk(steps: &[Step], parent: &str, out: &mut Vec<ExerciseStep>) {
        for (i, step) in steps.iter().enumerate() {
            match step {
                Step::Exercise {
                    exercise_id,
                    reps,
                    kg,
                    side,
                    ..
                } => out.push(ExerciseStep {
                    at: position(parent, i),
                    exercise_id: *exercise_id,
                    for_reps: reps.is_some(),
                    weighted: kg.is_some(),
                    sided: side.is_some(),
                }),
                Step::Repeat { steps, .. } => walk(steps, &position(parent, i), out),
                Step::Rest { .. } | Step::Note { .. } => {}
            }
        }
    }
    let mut out = Vec::new();
    walk(steps, "", &mut out);
    out
}

/// Whether a step fits its exercise: reps or seconds as the exercise is
/// measured, a weight only if it takes one (always, if it needs one), a side
/// only if it's one-sided. The web editor applies the same rules (`stepError`
/// in web/workouts.mjs); tests/fixtures/step-cases.json holds the cases both
/// must agree on.
///
/// # Errors
/// The first rule the step breaks, in the user's words.
pub fn step_fits(exercise: &Exercise, step: &ExerciseStep) -> Result<(), String> {
    let name = &exercise.name;
    match (exercise.measure, step.for_reps) {
        (Measure::Reps, false) => return Err(format!("{name} is done for reps")),
        (Measure::Time, true) => return Err(format!("{name} is done for a time")),
        _ => {}
    }
    match (
        exercise.traits.load.as_deref().unwrap_or("optional"),
        step.weighted,
    ) {
        ("none", true) => return Err(format!("{name} takes no weight")),
        ("required", false) => return Err(format!("{name} needs a weight (kg)")),
        _ => {}
    }
    if step.sided && exercise.traits.laterality.as_deref() != Some("unilateral") {
        return Err(format!("{name} has no sides"));
    }
    Ok(())
}

#[cfg(test)]
mod step_rule_tests {
    use super::*;
    use crate::model::{ExerciseSource, ExerciseTraits};

    #[derive(Deserialize)]
    struct Case {
        exercise: CaseExercise,
        step: CaseStep,
        error: Option<String>,
    }

    #[derive(Deserialize)]
    struct CaseExercise {
        name: String,
        measure: Measure,
        load: Option<String>,
        laterality: Option<String>,
    }

    #[derive(Deserialize)]
    struct CaseStep {
        reps: Option<u32>,
        kg: Option<f64>,
        side: Option<Side>,
    }

    #[test]
    fn step_rules_match_the_shared_cases() {
        let cases: Vec<Case> =
            serde_json::from_str(include_str!("../../tests/fixtures/step-cases.json")).unwrap();
        for case in cases {
            let exercise = Exercise {
                id: 1,
                name: case.exercise.name,
                measure: case.exercise.measure,
                source: ExerciseSource::Custom,
                variant_of: None,
                rev: 1,
                traits: ExerciseTraits {
                    load: case.exercise.load,
                    laterality: case.exercise.laterality,
                    ..ExerciseTraits::default()
                },
            };
            let step = ExerciseStep {
                at: "1".into(),
                exercise_id: 1,
                for_reps: case.step.reps.is_some(),
                weighted: case.step.kg.is_some(),
                sided: case.step.side.is_some(),
            };
            assert_eq!(
                step_fits(&exercise, &step).err(),
                case.error,
                "{}",
                exercise.name
            );
        }
    }
}

#[cfg(test)]
mod note_tests {
    use super::*;

    #[test]
    fn notes_take_no_place_in_a_run() {
        let note = || Step::Note {
            name: None,
            text: Some("Breathe.".into()),
        };
        let steps = [
            note(),
            Step::Rest { seconds: 5 },
            Step::Repeat {
                name: None,
                times: 3,
                every: None,
                steps: vec![note(), Step::Rest { seconds: 5 }],
            },
        ];
        assert_eq!(run_length(&steps), 4);
        assert!(exercise_steps(&steps).is_empty());
    }
}
