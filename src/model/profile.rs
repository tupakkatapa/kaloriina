//! Profiles, their body measurements and targets.

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
    ///
    /// # Errors
    /// The first field out of bounds, named.
    pub fn checked(mut self, server_today: &str) -> Result<Self, Error> {
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
            (Some(sex), Some(age), Some(height_cm), Some(weight_kg), Some(activity)) => {
                Ok(Person {
                    sex,
                    age,
                    height_cm,
                    weight_kg,
                    activity,
                    goal_kg_per_week: self.goal_kg_per_week,
                })
            }
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
    /// point to reach (goal weight) has no bounds.
    ///
    /// # Panics
    /// If `metric` isn't a target key; callers validate keys first.
    #[must_use]
    pub fn single(metric: &str, value: f64) -> Self {
        let (_, goal, _) =
            target_key(metric).expect("target metrics are validated against the registry");
        let (min, max) = if find_metric(metric).is_some_and(|m| m.per == Per::Once) {
            (None, None)
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

impl TargetsInput {
    /// Known metrics, each once, each value in its range.
    ///
    /// # Errors
    /// The first target that fails, named by its metric.
    pub fn checked(&self) -> Result<Vec<Target>, Error> {
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
            if !(t.value.is_finite() && (lo..=hi).contains(&t.value)) {
                return Err(bad(if hi.is_finite() {
                    format!("{label}: target must be {lo}–{hi}")
                } else {
                    format!("{label}: target must be {lo} or more")
                }));
            }
            list.push(Target::single(key, t.value));
        }
        Ok(list)
    }
}
