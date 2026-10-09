//! Sessions: workouts done, set by set, or as a whole (a run, a ride) with
//! its type, distance and start; logged by hand or from the watch.

use jiff::{Timestamp, ToSpan, tz::TimeZone};

use super::prelude::*;
use super::{Side, checked_uid};

text_enum! {
    /// What kind of workout a whole session is; `None` on a session is a
    /// set-based "Workout".
    pub enum SessionType {
        Run = "run",
        Cycling = "cycling",
        Swim = "swim",
        Walk = "walk",
        Hike = "hike",
        Other = "other",
    }
}

impl SessionType {
    #[must_use]
    pub fn label(self) -> &'static str {
        match self {
            Self::Run => "Run",
            Self::Cycling => "Cycling",
            Self::Swim => "Swimming",
            Self::Walk => "Walk",
            Self::Hike => "Hike",
            Self::Other => "Other",
        }
    }
}

text_enum! {
    /// Where a session came from: logged here, or promoted from the watch.
    #[derive(Default)]
    pub enum SessionSource {
        #[default]
        Manual = "manual",
        HealthConnect = "health_connect",
    }
}
/// One exercise as it was done in a session: reps or seconds (exactly one),
/// the weight actually used and the side. The server keeps the exercise's
/// name with it (one sent is overwritten), so the set still reads if the
/// exercise is deleted later.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionSet {
    pub exercise_id: i64,
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
pub struct SessionInput {
    pub day: String,
    #[serde(default)]
    pub workout_id: Option<i64>,
    pub name: String,
    pub minutes: u32,
    #[serde(default)]
    pub kcal: Option<u32>,
    #[serde(default)]
    pub sets: Vec<SessionSet>,
    #[serde(default, rename = "type")]
    pub kind: Option<SessionType>,
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
pub struct Session {
    pub id: i64,
    pub day: String,
    pub workout_id: Option<i64>,
    pub name: String,
    pub minutes: u32,
    /// As set; `None`: clients show their estimate.
    pub kcal: Option<u32>,
    pub sets: Vec<SessionSet>,
    #[serde(rename = "type")]
    pub kind: Option<SessionType>,
    pub distance_m: Option<u32>,
    /// UTC, RFC 3339.
    pub start_at: Option<String>,
    pub source: SessionSource,
    /// The Health Connect record it holds: promoted from the watch, or
    /// claimed by a hand log.
    pub source_key: Option<String>,
    /// The weigh-in in effect on its day: the latest on or before it, else
    /// the earliest after (`None` without any). What its energy is
    /// estimated from, so a past session never follows a new weigh-in.
    pub weight_kg: Option<f64>,
    pub uid: String,
    pub rev: i64,
}

impl Session {
    /// Where it sits in time, for matching.
    #[must_use]
    pub fn span(&self) -> Span<'_> {
        let start = self.start_at.as_deref().and_then(|s| s.parse().ok());
        Span {
            day: &self.day,
            kind: self.kind,
            start,
            end: start
                .and_then(|s: Timestamp| s.checked_add(i64::from(self.minutes).minutes()).ok()),
        }
    }
}

/// A session's day, type and time, for matching a watch workout to one
/// logged.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Span<'a> {
    pub day: &'a str,
    pub kind: Option<SessionType>,
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

/// Whether the watch's `w` is the workout `m` (logged, or already held from
/// the watch): the same day, compatible types (equal, or `m` untyped), and
/// both timed, overlapping by at least half of the shorter. Without times
/// nothing matches.
#[must_use]
pub fn matches(m: &Span, w: &Span) -> bool {
    let (Some(overlap), Some(a), Some(b)) = (m.overlap(w), m.seconds(), w.seconds()) else {
        return false;
    };
    m.day == w.day
        && (m.kind.is_none() || m.kind == w.kind)
        && a.min(b) > 0
        && 2 * overlap >= a.min(b)
}

impl SessionInput {
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
        if !(1..=SESSION_MINUTES_MAX).contains(&self.minutes) {
            return Err(Error::invalid_field(
                "minutes",
                format!("minutes must be 1–{SESSION_MINUTES_MAX}"),
            ));
        }
        if self.kind.is_none() && self.distance_m.is_some() {
            return Err(Error::invalid_field(
                "distance_m",
                "only a whole session (a run, a ride) has a distance",
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
            return Err(bad(format!("a session has at most {SETS_MAX} sets")));
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
    let wrong = || Error::invalid_field("start_at", "start_at must be a time on the session's day");
    let ts: Timestamp = at.parse().map_err(|_| wrong())?;
    let day: jiff::civil::Date = day.parse().map_err(|_| wrong())?;
    let on = ts.to_zoned(TimeZone::UTC).date();
    if on < day.yesterday().map_err(|_| wrong())? || on > day.tomorrow().map_err(|_| wrong())? {
        return Err(wrong());
    }
    Ok(ts.to_string())
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

    fn span(kind: Option<SessionType>, start: &str, end: &str) -> Span<'static> {
        Span {
            day: "2026-10-09",
            kind,
            start: Some(start.parse().unwrap()),
            end: Some(end.parse().unwrap()),
        }
    }

    fn input(start_at: Option<&str>) -> SessionInput {
        SessionInput {
            day: "2026-10-09".into(),
            workout_id: None,
            name: "Run".into(),
            minutes: 30,
            kcal: None,
            sets: Vec::new(),
            kind: Some(SessionType::Run),
            distance_m: Some(5000),
            start_at: start_at.map(str::to_owned),
            uid: None,
            rev: None,
        }
    }

    #[test]
    fn matches_needs_half_the_shorter_and_times() {
        let run = Some(SessionType::Run);
        // 100 s against 100 s: 50 s overlap matches, 49 s doesn't.
        let w = span(run, "2026-10-09T17:00:00Z", "2026-10-09T17:01:40Z");
        let half = span(run, "2026-10-09T17:00:50Z", "2026-10-09T17:02:30Z");
        let less = span(run, "2026-10-09T17:00:51Z", "2026-10-09T17:02:31Z");
        assert!(matches(&half, &w));
        assert!(!matches(&less, &w));
        // An untyped hand log matches any type; a different type never.
        let untyped = span(None, "2026-10-09T17:00:00Z", "2026-10-09T17:01:40Z");
        assert!(matches(&untyped, &w));
        let ride = span(
            Some(SessionType::Cycling),
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
    fn type_distance_and_start_are_checked() {
        let ok = input(Some("2026-10-09T19:30:00+03:00")).checked().unwrap();
        assert_eq!(ok.start_at.as_deref(), Some("2026-10-09T16:30:00Z"));
        // A start in a far time zone: its UTC date may be a day off.
        assert!(input(Some("2026-10-08T23:30:00Z")).checked().is_ok());
        assert!(input(Some("2026-10-07T23:59:00Z")).checked().is_err());
        assert!(input(Some("2026-10-11T00:00:00Z")).checked().is_err());
        assert!(input(Some("17:00")).checked().is_err());
        let far = SessionInput {
            distance_m: Some(DISTANCE_M_MAX + 1),
            ..input(None)
        };
        assert!(far.checked().is_err());
        for (minutes, ok) in [
            (SESSION_MINUTES_MAX, true),
            (SESSION_MINUTES_MAX + 1, false),
        ] {
            let s = SessionInput {
                minutes,
                ..input(None)
            };
            assert_eq!(s.checked().is_ok(), ok, "{minutes}");
        }
        let typed: SessionInput =
            serde_json::from_value(serde_json::json!({"day": "2026-10-09", "name": "x",
                "minutes": 1, "type": "hike"}))
            .unwrap();
        assert_eq!(typed.kind, Some(SessionType::Hike));
        assert!(
            serde_json::from_value::<SessionInput>(serde_json::json!({"day": "2026-10-09",
                "name": "x", "minutes": 1, "type": "strength"}))
            .is_err()
        );
    }
}
