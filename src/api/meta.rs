//! Reference data the client loads once at start: the nutrient registry with
//! its EU display units, the diary groups, the exercise traits, the body
//! measurements, the goals besides nutrients, the built-in habits, the food
//! categories, every input limit and the version. Clients read these
//! instead of copying them.

use super::prelude::*;

/// How a stored amount is shown: `shown = stored × factor` in `unit`.
#[derive(Serialize)]
struct Display {
    label: &'static str,
    unit: &'static str,
    factor: f64,
}

#[derive(Serialize)]
struct NutrientView {
    key: &'static str,
    label: &'static str,
    unit: &'static str,
    goal: nutrients::Goal,
    category: nutrients::Category,
    display: Display,
}

/// A session type: its key, label and whether it takes a distance
/// (every whole-session type does; a set-based session, type `null`,
/// doesn't).
#[derive(Serialize)]
struct SessionTypeView {
    key: &'static str,
    label: &'static str,
    distance: bool,
}

/// A food category: its key and label.
#[derive(Serialize)]
struct CategoryView {
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
    /// Whole-session types (a run, a ride), in order.
    session_types: Vec<SessionTypeView>,
    /// Goals besides nutrients a target can hold.
    metrics: &'static [model::Metric],
    /// This build's version (`Cargo.toml`).
    version: &'static str,
    /// The built-in habits, read from what was eaten.
    habits: &'static [model::Builtin],
    /// The food categories a food may have, in order.
    food_categories: Vec<CategoryView>,
    /// Tags every check-in offers; any other text is a tag of your own.
    check_in_tags: &'static [&'static str],
}

pub(super) fn routes() -> Router<AppState> {
    Router::new().route("/api/meta", get(meta))
}

async fn meta() -> Json<Meta> {
    let nutrients = REGISTRY
        .iter()
        .map(|n| NutrientView {
            key: n.key,
            label: n.label,
            unit: n.unit,
            goal: n.goal(),
            category: n.category,
            display: {
                let (label, unit, factor) = n.display();
                Display {
                    label,
                    unit,
                    factor,
                }
            },
        })
        .collect();
    Json(Meta {
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
        session_types: model::SessionType::ALL
            .iter()
            .map(|t| SessionTypeView {
                key: t.as_str(),
                label: t.label(),
                distance: true,
            })
            .collect(),
        check_in_tags: model::CHECK_IN_TAGS,
        metrics: model::METRICS,
        habits: model::BUILTINS,
        food_categories: model::FoodCategory::ALL
            .iter()
            .map(|c| CategoryView {
                key: c.as_str(),
                label: c.label(),
            })
            .collect(),
        version: env!("CARGO_PKG_VERSION"),
    })
}
