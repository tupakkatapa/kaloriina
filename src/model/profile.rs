//! Profiles, their body measurements and targets.

use super::metric::{CLOCK_WINDOW_MIN, DAY_MIN, ESSENTIAL_FAT, is_clock};
use super::prelude::*;
use super::{Gone, METRICS, Per, find_metric, refuse_gone, target_key};

use crate::dri::Person;

text_enum! {
    pub enum Sex {
        Female = "female",
        Male = "male",
    }
}

/// What targets are recommended from, besides the weight (which is the
/// weight log's). Each may be unknown (`null`) until recommendations are
/// wanted. On input every key must be present, `null` for unknown: a
/// profile update replaces the whole profile, so a forgotten key must not
/// silently wipe a value.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Body {
    #[serde(deserialize_with = "present")]
    pub sex: Option<Sex>,
    #[serde(deserialize_with = "present")]
    pub birth_date: Option<String>,
    #[serde(deserialize_with = "present")]
    pub height_cm: Option<f64>,
    /// Physical activity level (PAL), see [`ACTIVITY_MIN`].
    #[serde(deserialize_with = "present")]
    pub activity: Option<f64>,
    pub goal_kg_per_week: f64,
    /// The day to reach the goal weight or body fat by: the other way to say
    /// how fast. Past or `null`, `goal_kg_per_week` says it. Set only after the
    /// client's today (one stored before stays readable). Optional (absent is
    /// `null`): files exported before it lack it (ADR 0031).
    #[serde(default)]
    pub goal_date: Option<String>,
    /// Degrees north (south negative), to one decimal: whether winter
    /// sun makes vitamin D in the skin. Optional, as `goal_date`.
    #[serde(default)]
    pub latitude: Option<f64>,
}

/// A person whose diary, weight log, sessions and targets are kept apart
/// from others'.
#[derive(Debug, Clone, Serialize)]
pub struct Profile {
    pub id: ProfileId,
    pub name: String,
    #[serde(flatten)]
    pub body: Body,
    /// The latest weigh-in up to [`super::day_so_far`]; `None` without one.
    pub latest_weight_kg: Option<f64>,
    pub rev: i64,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct ProfileInput {
    pub name: String,
    #[serde(flatten)]
    pub body: Body,
    /// Gone: the weight is the weight log's.
    #[serde(default)]
    pub weight_kg: Gone,
    /// Gone: the `workouts_per_week` and `goal_weight` targets.
    #[serde(default)]
    pub workouts_per_week: Gone,
    #[serde(default)]
    pub goal_weight_kg: Gone,
    /// The client's today: ages are counted to it. The server's today when
    /// absent (see [`ProfileInput::checked`]).
    #[serde(default)]
    pub day: Option<String>,
    /// The revision this update was made from (required on update).
    #[serde(default)]
    pub rev: Option<i64>,
    /// A create's retry key: a create naming one saved before
    /// answers with that record. Ignored by an update.
    #[serde(default)]
    pub uid: Option<String>,
}

/// A nullable field that must still be present. A `deserialize_with` field
/// without `default` makes serde reject a missing key.
pub(super) fn present<'de, D, T>(d: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::deserialize(d)
}

fn in_range(value: Option<f64>, field: &str, what: &str, lo: f64, hi: f64) -> Result<(), Error> {
    match value {
        Some(v) if !(v.is_finite() && (lo..=hi).contains(&v)) => Err(Error::invalid_field(
            field,
            format!("{what} must be {lo}–{hi}"),
        )),
        _ => Ok(()),
    }
}

impl ProfileInput {
    /// The day ages count on: the client's, else the server's (set by
    /// [`ProfileInput::checked`]).
    #[must_use]
    pub fn today(&self) -> &str {
        self.day.as_deref().unwrap_or_default()
    }

    /// `server_today` stands in for a `day` the client didn't give.
    /// `stored_goal` is the profile's goal date as saved: echoed back
    /// unchanged it may have passed; a new one must be after today.
    ///
    /// # Errors
    /// The first field out of bounds, named.
    pub fn checked(mut self, server_today: &str, stored_goal: Option<&str>) -> Result<Self, Error> {
        refuse_gone(&[
            (
                self.weight_kg,
                "weight_kg",
                "log a weight with PUT /weights/{day}",
            ),
            (
                self.workouts_per_week,
                "workouts_per_week",
                "set the workouts_per_week target",
            ),
            (
                self.goal_weight_kg,
                "goal_weight_kg",
                "set the goal_weight target",
            ),
        ])?;
        self.name = text(&self.name, "name", LABEL_MAX)?;
        super::checked_opt_uid(self.uid.as_deref())?;
        match &self.day {
            Some(day) => {
                checked_day_so_far(day)?;
            }
            None => self.day = Some(server_today.to_owned()),
        }
        let today = self.today().to_owned();
        let b = &mut self.body;
        b.birth_date = opt_text(b.birth_date.as_deref(), "birth date", 10)?;
        if let Some(birth) = &b.birth_date {
            match age_on(birth, &today) {
                Some(age) if age <= 120 => {}
                _ => {
                    return Err(Error::invalid_field(
                        "birth_date",
                        "birth date must be a date in the past, at most 120 years ago",
                    ));
                }
            }
        }
        if b.goal_date.as_deref().is_some_and(|d| !is_date(d)) {
            return Err(Error::invalid_field(
                "goal_date",
                "goal date must be a real date (YYYY-MM-DD)",
            ));
        }
        // Both are YYYY-MM-DD: text order is date order.
        if b.goal_date
            .as_deref()
            .is_some_and(|d| Some(d) != stored_goal && d <= today.as_str())
        {
            return Err(Error::invalid_field(
                "goal_date",
                "goal date must be after today",
            ));
        }
        in_range(
            b.height_cm,
            "height_cm",
            "height (cm)",
            HEIGHT_CM_MIN,
            HEIGHT_CM_MAX,
        )?;
        in_range(
            b.activity,
            "activity",
            "activity level",
            ACTIVITY_MIN,
            ACTIVITY_MAX,
        )?;
        in_range(
            Some(b.goal_kg_per_week),
            "goal_kg_per_week",
            "weight goal (kg/week)",
            GOAL_KG_PER_WEEK_MIN,
            GOAL_KG_PER_WEEK_MAX,
        )?;
        in_range(
            b.latitude,
            "latitude",
            "latitude",
            LATITUDE_MIN,
            LATITUDE_MAX,
        )?;
        if b.latitude
            .is_some_and(|v| ((v * 10.0).round() - v * 10.0).abs() > 1e-6)
        {
            return Err(Error::invalid_field(
                "latitude",
                "latitude takes at most one decimal",
            ));
        }
        Ok(self)
    }
}

impl Body {
    /// Who recommendations are for, on `today`, weighing `weight_kg`.
    ///
    /// # Errors
    /// A measurement is missing; says which are needed.
    pub fn person(&self, weight_kg: Option<f64>, today: &str) -> Result<Person, Error> {
        let age = self.birth_date.as_deref().and_then(|b| age_on(b, today));
        match (self.sex, age, self.height_cm, weight_kg, self.activity) {
            // Height and activity aren't the server's to use: the client's
            // energy model needs them for the energy the targets scale with.
            (Some(sex), Some(age), Some(_), Some(weight_kg), Some(_)) => Ok(Person {
                sex,
                age,
                weight_kg,
            }),
            _ => Err(bad(
                "sex, birth date, height, a logged weight and activity level are needed to recommend targets",
            )),
        }
    }
}

/// A target: a nutrient or a goal from [`METRICS`]. People set one number
/// (`value`); `min`/`max` follow from its direction (at least, at most,
/// about).
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Target {
    pub metric: String,
    pub value: f64,
    pub min: Option<f64>,
    pub max: Option<f64>,
    /// The registry's default, applying because the profile set none.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub default: bool,
}

impl Target {
    /// A target of `value` for `metric`, bounded by its direction; a
    /// point to reach (goal weight) has no bounds; a clock time is kept
    /// within [`CLOCK_WINDOW_MIN`] either way, mod 1440 (past midnight
    /// `min > max`).
    ///
    /// # Panics
    /// If `metric` isn't a target key; callers validate keys first.
    #[must_use]
    pub fn single(metric: &str, value: f64) -> Self {
        let (_, goal, _) =
            target_key(metric).expect("target metrics are validated against the registry");
        let (min, max) = if find_metric(metric).is_some_and(|m| m.per == Per::Once) {
            (None, None)
        } else if is_clock(metric) {
            let at = |m: f64| Some(m.rem_euclid(DAY_MIN));
            (at(value - CLOCK_WINDOW_MIN), at(value + CLOCK_WINDOW_MIN))
        } else {
            goal.bounds(value)
        };
        Self {
            metric: metric.to_owned(),
            value,
            min,
            max,
            default: false,
        }
    }

    /// The registry defaults: steps and sleep, for everyone.
    pub fn defaults() -> impl Iterator<Item = Self> {
        METRICS.iter().filter_map(|m| {
            m.default.map(|value| Self {
                default: true,
                ..Self::single(m.key, value)
            })
        })
    }
}

/// One target as set: a metric and its number.
#[derive(Debug, Clone, Deserialize)]
pub struct TargetInput {
    #[serde(default)]
    pub metric: Option<String>,
    /// Gone: the old name of `metric`.
    #[serde(default)]
    pub nutrient: Gone,
    pub value: f64,
}

/// A profile's targets as set, with the profile revision they were read at.
#[derive(Debug, Clone, Deserialize)]
pub struct TargetsInput {
    pub targets: Vec<TargetInput>,
    #[serde(default)]
    pub rev: Option<i64>,
}

/// Body mass index a goal weight may give, kg/m²: under 15 is starvation
/// (WHO: < 16 severe thinness), over 40 no goal anyone sets.
pub const GOAL_BMI: (f64, f64) = (15.0, 40.0);
/// Body fat + muscle may be at most this % of weight: bone, organs and
/// water are the rest.
pub const FAT_MUSCLE_MAX: f64 = 85.0;
/// Skeletal muscle may be at most this share of fat-free mass (elite
/// bodybuilders reach about 0.6).
pub const MUSCLE_OF_LEAN_MAX: f64 = 0.62;

fn invalid(key: &str, message: String) -> Error {
    Error::invalid_field(key, message)
}

impl TargetsInput {
    /// [`TargetsInput::checked`], then each value in its range and the
    /// body goals possible for `body`: body fat over essential fat for its
    /// sex, body fat and muscle leaving room for the rest of a body, a goal
    /// weight a healthy BMI for its height. Errors name the metric as the
    /// field.
    ///
    /// # Errors
    /// The first target that fails.
    pub fn checked_for(&self, body: &Body) -> Result<Vec<Target>, Error> {
        let list = self.parsed(true)?;
        let value = |key: &str| list.iter().find(|t| t.metric == key).map(|t| t.value);
        if let Some(bf) = value("goal_body_fat") {
            let (floor, who) = match body.sex {
                Some(Sex::Female) => (ESSENTIAL_FAT.1, "women"),
                Some(Sex::Male) => (ESSENTIAL_FAT.0, "men"),
                None => (ESSENTIAL_FAT.0, "anyone"),
            };
            if bf < floor {
                return Err(invalid(
                    "goal_body_fat",
                    format!("Goal body fat: at least {floor} %, essential fat for {who}"),
                ));
            }
        }
        if let (Some(muscle), Some(bf)) = (value("goal_muscle"), value("goal_body_fat")) {
            let most = (MUSCLE_OF_LEAN_MAX * (100.0 - bf)).min(FAT_MUSCLE_MAX - bf);
            if muscle > most {
                let most = (most * 10.0).floor() / 10.0;
                return Err(invalid(
                    "goal_muscle",
                    format!(
                        "Goal muscle: at most {most} % with {bf} % body fat (bone, organs and water are the rest)"
                    ),
                ));
            }
        }
        if let (Some(kg), Some(cm)) = (value("goal_weight"), body.height_cm) {
            let m2 = (cm / 100.0).powi(2);
            let (lo, hi) = (GOAL_BMI.0 * m2, GOAL_BMI.1 * m2);
            if !(lo..=hi).contains(&kg) {
                return Err(invalid(
                    "goal_weight",
                    format!(
                        "Goal weight: {lo:.1}–{hi:.1} kg for your height (BMI {}–{})",
                        GOAL_BMI.0, GOAL_BMI.1
                    ),
                ));
            }
        }
        Ok(list)
    }

    /// Known metrics, each once, each value finite and at least 0: what an
    /// import takes (a value stored before a range tightened stays
    /// restorable). New targets go through [`TargetsInput::checked_for`].
    ///
    /// # Errors
    /// The first target that fails, named by its metric.
    pub fn checked(&self) -> Result<Vec<Target>, Error> {
        self.parsed(false)
    }

    /// Known metrics, each once, each value finite: within its range when
    /// `ranged`, else at least 0 (a clock time under a day).
    fn parsed(&self, ranged: bool) -> Result<Vec<Target>, Error> {
        let mut list: Vec<Target> = Vec::new();
        for t in &self.targets {
            refuse_gone(&[(t.nutrient, "nutrient", "name it as metric")])?;
            let key = t
                .metric
                .as_deref()
                .ok_or_else(|| Error::invalid_field("metric", "metric is required"))?;
            let (label, _, (lo, hi)) =
                target_key(key).ok_or_else(|| bad(format!("unknown metric “{key}”")))?;
            if list.iter().any(|x| x.metric == key) {
                return Err(bad(format!("{label}: listed twice")));
            }
            let ok = if ranged {
                (lo..=hi).contains(&t.value)
            } else {
                t.value >= 0.0 && (!is_clock(key) || t.value < DAY_MIN)
            };
            if !(t.value.is_finite() && ok) {
                return Err(invalid(key, format!("{label}: target must be {lo}–{hi}")));
            }
            list.push(Target::single(key, t.value));
        }
        Ok(list)
    }
}
