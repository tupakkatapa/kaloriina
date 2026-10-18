//! Reference data the client loads once at start: the nutrient registry with
//! its EU and US display units and FDA Daily Values, the diary groups, the
//! exercise traits, the body measurements, the goals besides nutrients, the
//! built-in habits, the food categories, the hook events, every input limit,
//! the food sources there are to search, the food labels and the version.
//! Clients read these instead of copying them.

use super::prelude::*;

/// How a stored amount is shown: `shown = stored × factor` in `unit`;
/// `short` where room is tight (a chart, the macro trio).
#[derive(Serialize)]
struct Display {
    label: &'static str,
    short: &'static str,
    unit: &'static str,
    factor: f64,
}

impl Display {
    fn of(
        n: &nutrients::Nutrient,
        (label, unit, factor): (&'static str, &'static str, f64),
    ) -> Self {
        Self {
            label,
            short: n.short(label),
            unit,
            factor,
        }
    }
}

#[derive(Serialize)]
struct NutrientView {
    key: &'static str,
    label: &'static str,
    unit: &'static str,
    goal: nutrients::Goal,
    category: nutrients::Category,
    display: Display,
    /// How the US Nutrition Facts label shows it.
    display_us: Display,
    /// The FDA Daily Value in the stored unit, for the US label's %DV;
    /// null without one.
    dv: Option<f64>,
    /// Computed from other nutrients (EPA+DHA): shown, never typed.
    derived: bool,
    /// Its target is an adequate intake, not a requirement.
    ai: bool,
    /// Values its target may take, stored unit: `[min, max]`.
    range: (f64, f64),
}

/// An activity type: its key, label, whether it takes a distance, how its
/// pace reads ([`model::ActivityType::pace`]) and its MET (the energy
/// estimate's, [`model::ActivityType::met`]).
#[derive(Serialize)]
struct ActivityTypeView {
    key: &'static str,
    label: &'static str,
    distance: bool,
    pace: Option<&'static str>,
    met: f64,
}

/// A key and its label: a food category, a hook event.
#[derive(Serialize)]
struct Labelled {
    key: &'static str,
    label: &'static str,
}

/// A body measurement: its key, label and unit.
#[derive(Serialize)]
struct MeasurementView {
    key: &'static str,
    label: &'static str,
    unit: &'static str,
}

#[derive(Serialize)]
pub(super) struct Meta {
    nutrients: Vec<NutrientView>,
    groups: [&'static str; 2],
    exercise_traits: &'static [model::Trait],
    limits: model::Limits,
    /// Body measurements the diary takes, in order.
    measurements: Vec<MeasurementView>,
    /// Activity types, in order: a workout first.
    activity_types: Vec<ActivityTypeView>,
    /// Goals besides nutrients a target can hold.
    metrics: &'static [model::Metric],
    /// This build's version (`Cargo.toml`).
    version: &'static str,
    /// The built-in habits, read from what was eaten.
    habits: &'static [model::Builtin],
    /// The food categories a food may have, in order.
    food_categories: Vec<Labelled>,
    /// The food sources there are to search, in order: `custom` and
    /// `recipe` always, `fineli` and `off` once they hold a food.
    food_sources: Vec<model::FoodScope>,
    /// Tags every check-in offers; any other text is a tag of your own.
    check_in_tags: &'static [&'static str],
    /// The events a Home Assistant hook may be set to send, in order.
    hook_events: Vec<Labelled>,
    /// The food labels, in display order: the verdicts, the positive
    /// sublabels, the negative ones ([`model::Label`]).
    labels: &'static [model::Label],
}

pub(super) fn routes() -> Router<AppState> {
    Router::new().route("/api/meta", get(meta))
}

async fn meta(State(s): State<AppState>) -> Res<Meta> {
    let food_sources = on_db(&s, |conn| db::food_sources(conn)).await?;
    let nutrients = REGISTRY
        .iter()
        .map(|n| NutrientView {
            key: n.key,
            label: n.label,
            unit: n.unit,
            goal: n.goal(),
            category: n.category,
            display: Display::of(n, n.display()),
            display_us: Display::of(n, n.display_us()),
            dv: n.fda_dv(),
            derived: n.derived(),
            ai: n.ai(),
            range: model::nutrient_range(n),
        })
        .collect();
    Ok(Json(Meta {
        nutrients,
        groups: GROUPS,
        exercise_traits: model::TRAITS,
        limits: model::LIMITS,
        measurements: model::BodyPart::ALL
            .iter()
            .map(|p| MeasurementView {
                key: p.as_str(),
                label: p.label(),
                unit: "cm",
            })
            .collect(),
        activity_types: model::ActivityType::ALL
            .iter()
            .map(|t| ActivityTypeView {
                key: t.as_str(),
                label: t.label(),
                distance: t.distance(),
                pace: t.pace(),
                met: t.met(),
            })
            .collect(),
        check_in_tags: model::CHECK_IN_TAGS,
        metrics: model::METRICS,
        habits: model::BUILTINS,
        food_categories: model::FoodCategory::ALL
            .iter()
            .map(|c| Labelled {
                key: c.as_str(),
                label: c.label(),
            })
            .collect(),
        hook_events: model::HookEvent::CHOSEN
            .iter()
            .map(|e| Labelled {
                key: e.as_str(),
                label: e.label(),
            })
            .collect(),
        food_sources,
        labels: model::LABELS.as_slice(),
        version: env!("CARGO_PKG_VERSION"),
    }))
}
