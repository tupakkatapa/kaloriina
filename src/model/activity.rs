//! Activities: anything you did (ADR 0027): a workout, set by set, or a
//! whole one (a run, a ride) with its type, distance and start; logged by
//! hand or from the device. Its sets are rows (`activity_set`): history,
//! bests and last done are the server's.

use jiff::{Timestamp, ToSpan, tz::TimeZone};

use super::prelude::*;
use super::{Side, checked_uid};

text_enum! {
    /// What kind of activity it is: a set-based workout (a workout done
    /// without sets, too), or a whole one (a run, a ride). The
    /// vocabulary lives here only; the column has no SQL check.
    #[derive(Default)]
    pub enum ActivityType {
        #[default]
        Workout = "workout",
        Run = "run",
        Walk = "walk",
        Hike = "hike",
        Cycling = "cycling",
        Swim = "swim",
        Rowing = "rowing",
        Elliptical = "elliptical",
        Hiit = "hiit",
        Yoga = "yoga",
        Sports = "sports",
        Ski = "ski",
        Climb = "climb",
        Dance = "dance",
        Other = "other",
    }
}

impl ActivityType {
    #[must_use]
    pub fn label(self) -> &'static str {
        match self {
            Self::Workout => "Workout",
            Self::Run => "Run",
            Self::Walk => "Walk",
            Self::Hike => "Hike",
            Self::Cycling => "Cycling",
            Self::Swim => "Swimming",
            Self::Rowing => "Rowing",
            Self::Elliptical => "Elliptical",
            Self::Hiit => "HIIT",
            Self::Yoga => "Yoga",
            Self::Sports => "Sports",
            Self::Ski => "Skiing",
            Self::Climb => "Climbing",
            Self::Dance => "Dance",
            Self::Other => "Other",
        }
    }

    /// Whether a session of this type takes a distance: the ones that
    /// cover ground, and "other" (whatever the device measured).
    #[must_use]
    pub fn distance(self) -> bool {
        matches!(
            self,
            Self::Run
                | Self::Walk
                | Self::Hike
                | Self::Cycling
                | Self::Swim
                | Self::Rowing
                | Self::Ski
                | Self::Other
        )
    }

    /// The slowest a session of this type moves (km/h) for its distance
    /// to have a pace: slower is a phone's step-count leftover (317 m in 19
    /// min is no walk). `web/activities.mjs` `MIN_KMH` says the same.
    #[must_use]
    pub fn min_kmh(self) -> f64 {
        match self {
            Self::Walk => 2.0,
            Self::Run | Self::Cycling => 5.0,
            _ => 0.0,
        }
    }

    /// How a session's pace reads: `per_km` ("5:37 /km"), `speed`
    /// ("24.3 km/h") or `per_100m` ("2:05 /100 m"); `None` for a type with
    /// no distance or no one way to read it (rowing, skiing, other).
    #[must_use]
    pub fn pace(self) -> Option<&'static str> {
        match self {
            Self::Run | Self::Walk | Self::Hike => Some("per_km"),
            Self::Cycling => Some("speed"),
            Self::Swim => Some("per_100m"),
            _ => None,
        }
    }

    /// Its metabolic equivalent (MET) at a moderate effort, for an
    /// energy estimate of (MET − 1) × kg × hours (clients; a run with its
    /// distance at its net cost per km instead). 2024 Adult Compendium of
    /// Physical Activities (Herrmann et al., J Sport Health Sci 2024,
    /// pacompendium.com); codes noted.
    #[must_use]
    pub fn met(self) -> f64 {
        match self {
            // 12050 running, 6–6.3 mph (a client takes a run's distance
            // when known)
            Self::Run => 9.3,
            // 15533 rock or mountain climbing
            Self::Climb => 8.0,
            // 02040 circuit training, some aerobic movement with minimal
            // rest, vigorous
            Self::Hiit => 7.5,
            // 01014 bicycling, general; 15610 soccer, casual, general;
            // 19075 skiing, general
            Self::Cycling | Self::Sports | Self::Ski => 7.0,
            // 17080 hiking, cross country
            Self::Hike => 6.0,
            // 18240 swimming laps, freestyle, slow, recreational
            Self::Swim => 5.8,
            // 02052 resistance training, squats, deadlift; 02048
            // elliptical trainer, moderate; 02071 rowing, stationary,
            // under 100 W, moderate; 03010 ballet, modern or jazz, class
            Self::Workout | Self::Elliptical | Self::Rowing | Self::Dance => 5.0,
            // a light-to-moderate activity
            Self::Other => 4.0,
            // 17160 walking for pleasure
            Self::Walk => 3.5,
            // 02150 yoga, hatha
            Self::Yoga => 2.3,
        }
    }

    /// Whether a session logged by hand as `hand` may be the device's
    /// `device` session: the same type, or a hand-logged workout and a
    /// device workout, HIIT or unmapped ("other") session.
    #[must_use]
    pub fn compatible(hand: Self, device: Self) -> bool {
        hand == device
            || (hand == Self::Workout && matches!(device, Self::Workout | Self::Hiit | Self::Other))
    }
}

/// A session type that may be sent as `null` (an older client's set-based
/// session): a workout.
pub(super) fn workout_if_null<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> Result<ActivityType, D::Error> {
    Ok(Option::<ActivityType>::deserialize(d)?.unwrap_or_default())
}

text_enum! {
    /// Where a session's energy came from: typed by hand, the device's
    /// active energy, the device's total (resting included: a device that
    /// writes no active energy), or an import's. A sync refreshes all but a
    /// hand's ([`super::Provenance`]).
    pub enum KcalSource {
        Hand = "hand",
        HealthConnect = "health_connect",
        HealthConnectTotal = "health_connect_total",
        Import = "import",
    }
}

text_enum! {
    /// Where a session came from: logged here (`hand`), promoted from the
    /// device, or added by a Google Health import (editable; removing the
    /// import removes it).
    #[derive(Default)]
    pub enum ActivitySource {
        #[default]
        Hand = "hand",
        HealthConnect = "health_connect",
        Import = "import",
    }
}
/// One exercise as it was done in an activity: reps or seconds (exactly
/// one), the weight actually used and the side. The server keeps the
/// exercise's name with it (one sent is overwritten), so the set still
/// reads once the exercise is deleted: its `exercise_id` is then `None`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ActivitySet {
    pub exercise_id: Option<i64>,
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

/// A workout done on a day by one profile: from a run or logged by hand.
/// `workout_id` links the workout it came from, if any (and while it lasts).
#[derive(Debug, Clone, Deserialize)]
pub struct ActivityInput {
    pub day: String,
    #[serde(default)]
    pub workout_id: Option<i64>,
    pub name: String,
    pub minutes: u32,
    #[serde(default)]
    pub kcal: Option<u32>,
    #[serde(default)]
    pub sets: Vec<ActivitySet>,
    /// Absent or `null`: a workout.
    #[serde(default, rename = "type", deserialize_with = "workout_if_null")]
    pub kind: ActivityType,
    #[serde(default)]
    pub distance_m: Option<u32>,
    /// When it started: RFC 3339, stored in UTC.
    #[serde(default)]
    pub start_at: Option<String>,
    /// The client's id for a new session: sending it again saves nothing
    /// more and answers with the first one.
    #[serde(default)]
    pub uid: Option<String>,
    /// The revision an update was made from (required on update).
    #[serde(default)]
    pub rev: Option<i64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Activity {
    pub id: i64,
    pub day: String,
    pub workout_id: Option<i64>,
    pub name: String,
    pub minutes: u32,
    /// As set; `None`: clients show their estimate.
    pub kcal: Option<u32>,
    pub sets: Vec<ActivitySet>,
    #[serde(rename = "type")]
    pub kind: ActivityType,
    pub distance_m: Option<u32>,
    /// UTC, RFC 3339.
    pub start_at: Option<String>,
    pub source: ActivitySource,
    /// The record it holds: the device workout it was promoted from, the
    /// imported workout it is (`gh-…`), or either one claimed by a hand log.
    pub source_key: Option<String>,
    /// Where `kcal` came from; `None` without one.
    pub kcal_source: Option<KcalSource>,
    /// The device's average and peak heart rate (bpm).
    pub avg_hr: Option<u32>,
    pub max_hr: Option<u32>,
    /// The weigh-in in effect on its day: the latest on or before it, else
    /// the earliest after (`None` without any). What its energy is
    /// estimated from, so a past session never follows a new weigh-in.
    pub weight_kg: Option<f64>,
    /// The resting energy in effect on its day (kcal a day): Health
    /// Connect's, carried up to 6 days; `None` without one (clients then
    /// take Mifflin–St Jeor at `weight_kg`). What a total is netted of.
    pub bmr_kcal: Option<f64>,
    pub uid: String,
    pub rev: i64,
}

impl Activity {
    /// Where it sits in time, for matching.
    #[must_use]
    pub fn span(&self) -> Span<'_> {
        let start = self.start_at.as_deref().and_then(|s| s.parse().ok());
        Span {
            day: &self.day,
            kind: self.kind,
            any_type: false,
            start,
            end: start
                .and_then(|s: Timestamp| s.checked_add(i64::from(self.minutes).minutes()).ok()),
        }
    }
}

/// A session's day, type and time, for matching a device workout to one
/// logged. `any_type`: one person, one workout at a time, whatever the
/// types (an imported workout against what is there).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Span<'a> {
    pub day: &'a str,
    pub kind: ActivityType,
    pub any_type: bool,
    pub start: Option<Timestamp>,
    pub end: Option<Timestamp>,
}

impl Span<'_> {
    /// Seconds `self` and `other` overlap, if both have times.
    #[must_use]
    pub fn overlap(&self, other: &Span) -> Option<i64> {
        let (a0, a1, b0, b1) = (self.start?, self.end?, other.start?, other.end?);
        Some((a1.min(b1).as_second() - a0.max(b0).as_second()).max(0))
    }

    fn seconds(&self) -> Option<i64> {
        Some(self.end?.as_second() - self.start?.as_second())
    }
}

/// Whether the device's `w` is the workout `m` (logged, or already held
/// from the device): the same day, [`ActivityType::compatible`] types (or
/// either span `any_type`), and both timed, overlapping by at least half of
/// the shorter. Without times nothing matches.
#[must_use]
pub fn matches(m: &Span, w: &Span) -> bool {
    let (Some(overlap), Some(a), Some(b)) = (m.overlap(w), m.seconds(), w.seconds()) else {
        return false;
    };
    m.day == w.day
        && (m.any_type || w.any_type || ActivityType::compatible(m.kind, w.kind))
        && a.min(b) > 0
        && 2 * overlap >= a.min(b)
}

impl ActivityInput {
    /// A date, trimmed names, numbers within limits, each set done for reps
    /// or for seconds; errors name the set ("set 3: …"). Whether each
    /// exercise exists and takes a side is the store's check.
    ///
    /// # Errors
    /// Blank or long names, numbers out of range, too many sets.
    pub fn checked(mut self) -> Result<Self, Error> {
        if !is_date(&self.day) {
            return Err(Error::invalid_field("day", "day must be YYYY-MM-DD"));
        }
        if let Some(uid) = &self.uid {
            checked_uid(uid)?;
        }
        self.name = text(&self.name, "name", NAME_MAX)?;
        if !(1..=ACTIVITY_MINUTES_MAX).contains(&self.minutes) {
            return Err(Error::invalid_field(
                "minutes",
                format!("minutes must be 1–{ACTIVITY_MINUTES_MAX}"),
            ));
        }
        if !self.kind.distance() && self.distance_m.is_some() {
            return Err(Error::invalid_field(
                "distance_m",
                format!("{} activities have no distance", self.kind.label()),
            ));
        }
        if self.distance_m.is_some_and(|d| d > DISTANCE_M_MAX) {
            return Err(Error::invalid_field(
                "distance_m",
                format!("distance_m must be 0–{DISTANCE_M_MAX}"),
            ));
        }
        if let Some(at) = &self.start_at {
            self.start_at = Some(checked_start(at, &self.day)?);
        }
        if self.kcal.is_some_and(|k| k > KCAL_MAX) {
            return Err(Error::invalid_field(
                "kcal",
                format!("kcal must be 0–{KCAL_MAX}"),
            ));
        }
        if self.sets.len() > SETS_MAX {
            return Err(bad(format!("an activity has at most {SETS_MAX} sets")));
        }
        for (i, set) in self.sets.iter_mut().enumerate() {
            let here = |msg: String| bad(format!("set {}: {msg}", i + 1));
            if set.reps.is_some() == set.seconds.is_some() {
                return Err(here("give reps or seconds".to_owned()));
            }
            if set.reps.is_some_and(|r| r > REPS_MAX) {
                return Err(here(format!("reps must be 0–{REPS_MAX}")));
            }
            if set.seconds.is_some_and(|s| s > STEP_SECONDS_MAX) {
                return Err(here(format!("seconds must be 0–{STEP_SECONDS_MAX}")));
            }
            if set
                .kg
                .is_some_and(|kg| !(kg.is_finite() && (0.0..=KG_MAX).contains(&kg)))
            {
                return Err(here(format!("kg must be 0–{KG_MAX}")));
            }
        }
        Ok(self)
    }
}

/// `at` as UTC RFC 3339, its UTC date within a day of `day` (any time zone).
fn checked_start(at: &str, day: &str) -> Result<String, Error> {
    let wrong =
        || Error::invalid_field("start_at", "start_at must be a time on the activity's day");
    let ts: Timestamp = at.parse().map_err(|_| wrong())?;
    let day: jiff::civil::Date = day.parse().map_err(|_| wrong())?;
    let on = ts.to_zoned(TimeZone::UTC).date();
    if on < day.yesterday().map_err(|_| wrong())? || on > day.tomorrow().map_err(|_| wrong())? {
        return Err(wrong());
    }
    Ok(ts.to_string())
}

/// A set at its best and where it was done.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct BestSet {
    pub set: ActivitySet,
    pub day: String,
    pub activity_id: i64,
}

/// An exercise's bests: the set with the most reps, the longest and the
/// heaviest; `None` for one it never had. The latest wins a tie: a record
/// is when you last reached it.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct Bests {
    pub reps: Option<BestSet>,
    pub seconds: Option<BestSet>,
    pub kg: Option<BestSet>,
}

/// One activity's sets of an exercise, in order.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct HistoryDay {
    pub day: String,
    pub activity_id: i64,
    pub sets: Vec<ActivitySet>,
}

/// An exercise as a profile did it: its bests and its sets by activity,
/// newest first.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ExerciseHistory {
    pub bests: Bests,
    pub days: Vec<HistoryDay>,
}

/// An exercise's bests, for the records.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ExerciseRecord {
    pub exercise_id: i64,
    /// The exercise's name now.
    pub name: String,
    #[serde(flatten)]
    pub bests: Bests,
}

/// An activity type's bests, each the activity holding it: the longest
/// distance and time and the fastest pace (over 1 km or more). No "most
/// energy": a session's energy is a device's measure, a typed total or an
/// estimate, no record. The later day wins a tie.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct TypeBests {
    pub distance: Option<Activity>,
    pub minutes: Option<Activity>,
    pub pace: Option<Activity>,
}

/// A profile's records: each exercise's bests by name, and each activity
/// type's (by its key) that has any.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct Records {
    pub exercises: Vec<ExerciseRecord>,
    pub types: std::collections::BTreeMap<&'static str, TypeBests>,
}

/// A workout and the day a profile last did it (`None`: never).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct WorkoutDone {
    #[serde(flatten)]
    pub workout: super::Workout,
    pub last_done: Option<String>,
}

/// A workout planned on a day. Saving a session of that workout on that
/// day takes the plan away.
#[derive(Debug, Clone, Deserialize)]
pub struct PlanInput {
    pub day: String,
    pub workout_id: i64,
    /// The client's id for the plan: sending it again saves nothing more.
    #[serde(default)]
    pub uid: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Plan {
    pub id: i64,
    pub uid: Option<String>,
    pub day: String,
    pub workout_id: i64,
    /// The workout's name.
    pub name: String,
}

impl PlanInput {
    /// A date no further ahead than [`PLAN_DAYS_AHEAD`] (counted from
    /// tomorrow in UTC, the furthest ahead any time zone is) and a valid uid.
    ///
    /// # Errors
    /// A bad or too distant day, a bad uid.
    pub fn checked(self) -> Result<Self, Error> {
        if !is_date(&self.day) {
            return Err(Error::invalid_field("day", "day must be YYYY-MM-DD"));
        }
        let last = super::day_so_far().saturating_add(i64::from(PLAN_DAYS_AHEAD).days());
        if self.day > last.to_string() {
            return Err(Error::invalid_field(
                "day",
                format!("plan at most {PLAN_DAYS_AHEAD} days ahead"),
            ));
        }
        if let Some(uid) = &self.uid {
            checked_uid(uid)?;
        }
        Ok(self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn span(kind: ActivityType, start: &str, end: &str) -> Span<'static> {
        Span {
            day: "2026-10-09",
            kind,
            any_type: false,
            start: Some(start.parse().unwrap()),
            end: Some(end.parse().unwrap()),
        }
    }

    fn input(start_at: Option<&str>) -> ActivityInput {
        ActivityInput {
            day: "2026-10-09".into(),
            workout_id: None,
            name: "Run".into(),
            minutes: 30,
            kcal: None,
            sets: Vec::new(),
            kind: ActivityType::Run,
            distance_m: Some(5000),
            start_at: start_at.map(str::to_owned),
            uid: None,
            rev: None,
        }
    }

    #[test]
    fn matches_needs_half_the_shorter_and_times() {
        let run = ActivityType::Run;
        // 100 s against 100 s: 50 s overlap matches, 49 s doesn't.
        let w = span(run, "2026-10-09T17:00:00Z", "2026-10-09T17:01:40Z");
        let half = span(run, "2026-10-09T17:00:50Z", "2026-10-09T17:02:30Z");
        let less = span(run, "2026-10-09T17:00:51Z", "2026-10-09T17:02:31Z");
        assert!(matches(&half, &w));
        assert!(!matches(&less, &w));
        // A hand-logged workout isn't a run; any type (an import) is.
        let workout = span(
            ActivityType::Workout,
            "2026-10-09T17:00:00Z",
            "2026-10-09T17:01:40Z",
        );
        assert!(!matches(&workout, &w));
        let untyped = Span {
            any_type: true,
            ..workout
        };
        assert!(matches(&untyped, &w));
        let ride = span(
            ActivityType::Cycling,
            "2026-10-09T17:00:00Z",
            "2026-10-09T17:01:40Z",
        );
        assert!(!matches(&ride, &w));
        // No start on either side: no match (no fallback).
        let timeless = Span {
            start: None,
            end: None,
            ..untyped
        };
        assert!(!matches(&timeless, &w));
        assert!(!matches(&untyped, &timeless));
        // Another day never.
        let other = Span {
            day: "2026-10-10",
            ..untyped
        };
        assert!(!matches(&other, &w));
    }

    #[test]
    fn compatible_types() {
        use ActivityType::{Cycling, Hiit, Other, Run, Workout, Yoga};
        for (hand, device, ok) in [
            (Run, Run, true),
            (Workout, Workout, true),
            (Workout, Hiit, true),
            (Workout, Other, true),
            (Workout, Run, false),
            (Run, Other, false),
            (Hiit, Workout, false),
            (Yoga, Workout, false),
            (Cycling, Run, false),
        ] {
            assert_eq!(
                ActivityType::compatible(hand, device),
                ok,
                "{hand:?} {device:?}"
            );
        }
    }

    #[test]
    fn type_distance_and_start_are_checked() {
        let ok = input(Some("2026-10-09T19:30:00+03:00")).checked().unwrap();
        assert_eq!(ok.start_at.as_deref(), Some("2026-10-09T16:30:00Z"));
        // A start in a far time zone: its UTC date may be a day off.
        assert!(input(Some("2026-10-08T23:30:00Z")).checked().is_ok());
        assert!(input(Some("2026-10-07T23:59:00Z")).checked().is_err());
        assert!(input(Some("2026-10-11T00:00:00Z")).checked().is_err());
        assert!(input(Some("17:00")).checked().is_err());
        let far = ActivityInput {
            distance_m: Some(DISTANCE_M_MAX + 1),
            ..input(None)
        };
        assert!(far.checked().is_err());
        for (minutes, ok) in [
            (ACTIVITY_MINUTES_MAX, true),
            (ACTIVITY_MINUTES_MAX + 1, false),
        ] {
            let s = ActivityInput {
                minutes,
                ..input(None)
            };
            assert_eq!(s.checked().is_ok(), ok, "{minutes}");
        }
        let typed: ActivityInput =
            serde_json::from_value(serde_json::json!({"day": "2026-10-09", "name": "x",
                "minutes": 1, "type": "hike"}))
            .unwrap();
        assert_eq!(typed.kind, ActivityType::Hike);
        // Absent or null: a workout, which has no distance.
        for kind in [serde_json::json!(null), serde_json::json!("workout")] {
            let s: ActivityInput = serde_json::from_value(serde_json::json!({"day": "2026-10-09",
                "name": "x", "minutes": 1, "type": kind, "distance_m": 10}))
            .unwrap();
            assert_eq!(s.kind, ActivityType::Workout);
            assert!(s.checked().is_err());
        }
        let sports: ActivityInput = serde_json::from_value(serde_json::json!({"day": "2026-10-09",
            "name": "x", "minutes": 1, "type": "sports", "distance_m": 10}))
        .unwrap();
        let why = sports.checked().unwrap_err().to_string();
        assert_eq!(why, "Sports activities have no distance");
        assert!(
            serde_json::from_value::<ActivityInput>(serde_json::json!({"day": "2026-10-09",
                "name": "x", "minutes": 1, "type": "strength"}))
            .is_err()
        );
    }
}
