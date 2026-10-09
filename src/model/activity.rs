//! Activity from the Android companion's Health Connect sync: each day's
//! active energy, steps, sleep and heart, and the watch's
//! workouts as it recorded them (the raw copy promoted into sessions). A
//! POST replaces a window of days; only its envelope can be refused (400),
//! a bad value is dropped and a bad item skipped, each counted.

use std::collections::BTreeSet;

use jiff::civil::Date;
use jiff::{Timestamp, ToSpan};
use serde_json::{Map, Value};

use super::prelude::*;
use super::{SessionType, sneaky};

/// The `sync_state` source of the companion's status row.
pub const HEALTH_CONNECT: &str = "health_connect";
/// Health Connect's recording method of a workout the watch detected by
/// itself: it waits to be added, even in auto mode.
pub const AUTO_RECORDED: i64 = 2;

/// One day's values, each `None` when Health Connect had none. Sleep is the
/// night that ended this day; its four main fields come all or none.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ActivityDay {
    pub day: String,
    #[serde(default)]
    pub active_kcal: Option<i64>,
    #[serde(default)]
    pub steps: Option<i64>,
    #[serde(default)]
    pub resting_hr: Option<i64>,
    #[serde(default)]
    pub hrv_ms: Option<i64>,
    #[serde(default)]
    pub asleep_min: Option<i64>,
    #[serde(default)]
    pub in_bed_min: Option<i64>,
    /// Local "HH:MM" in the phone's zone.
    #[serde(default)]
    pub bedtime: Option<String>,
    #[serde(default)]
    pub wake_time: Option<String>,
    #[serde(default)]
    pub deep_min: Option<i64>,
    #[serde(default)]
    pub rem_min: Option<i64>,
    #[serde(default)]
    pub light_min: Option<i64>,
}

/// "HH:MM", 00:00–23:59.
fn is_clock(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 5
        && b[2] == b':'
        && s[..2].parse::<u8>().is_ok_and(|h| h < 24)
        && s[3..].parse::<u8>().is_ok_and(|m| m < 60)
        && b.iter()
            .enumerate()
            .all(|(i, c)| i == 2 || c.is_ascii_digit())
}

impl ActivityDay {
    /// The day with every value out of bounds dropped (a bad sleep field
    /// drops the night, the stages go with it), and whether any was.
    #[must_use]
    pub fn trimmed(mut self) -> (Self, bool) {
        let mut dropped = false;
        let mut keep = |v: &mut Option<i64>, lo: i64, hi: i64| {
            if v.is_some_and(|v| !(lo..=hi).contains(&v)) {
                *v = None;
                dropped = true;
            }
        };
        keep(&mut self.active_kcal, 0, ACTIVE_KCAL_MAX);
        keep(&mut self.steps, 0, STEPS_MAX);
        keep(&mut self.resting_hr, RESTING_HR_MIN, RESTING_HR_MAX);
        keep(&mut self.hrv_ms, HRV_MS_MIN, HRV_MS_MAX);
        let night = [
            self.in_bed_min.is_some(),
            self.asleep_min.is_some(),
            self.bedtime.is_some(),
            self.wake_time.is_some(),
        ];
        let whole = self.in_bed_min.is_some_and(|b| (1..=1440).contains(&b))
            && self
                .asleep_min
                .is_some_and(|a| (0..=self.in_bed_min.unwrap_or(0)).contains(&a))
            && self.bedtime.as_deref().is_some_and(is_clock)
            && self.wake_time.as_deref().is_some_and(is_clock);
        if !whole && night.contains(&true) {
            dropped = true;
            (self.in_bed_min, self.asleep_min) = (None, None);
            (self.bedtime, self.wake_time) = (None, None);
        }
        let in_bed = self.in_bed_min.unwrap_or(-1);
        for stage in [&mut self.deep_min, &mut self.rem_min, &mut self.light_min] {
            if stage.is_some_and(|m| !(0..=in_bed).contains(&m)) {
                *stage = None;
                dropped = true;
            }
        }
        (self, dropped)
    }

    /// Whether anything is left to store.
    #[must_use]
    pub fn has_value(&self) -> bool {
        self.active_kcal.is_some()
            || self.steps.is_some()
            || self.resting_hr.is_some()
            || self.hrv_ms.is_some()
            || self.in_bed_min.is_some()
    }
}

/// One workout the watch recorded, as it recorded it: the raw copy a
/// session is promoted from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ActivitySession {
    /// Health Connect's record id.
    pub key: String,
    /// The phone's local day of its start.
    pub day: String,
    /// UTC, RFC 3339.
    pub start_at: String,
    pub end_at: String,
    /// Health Connect's exercise type number.
    #[serde(rename = "type")]
    pub kind: i64,
    pub name: String,
    #[serde(default)]
    pub kcal: Option<i64>,
    /// Whole metres, distance types only.
    #[serde(default)]
    pub distance_m: Option<i64>,
    /// Health Connect's: 0 unknown, 1 active, 2 automatic, 3 manual entry.
    #[serde(default)]
    pub recording_method: i64,
}

/// A watch workout's session type.
#[must_use]
pub fn hc_type(kind: i64) -> SessionType {
    match kind {
        33 | 34 => SessionType::Run,
        4 | 5 => SessionType::Cycling,
        48 | 49 => SessionType::Swim,
        53 => SessionType::Walk,
        21 => SessionType::Hike,
        _ => SessionType::Other,
    }
}

/// A range of days' activity.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Activity {
    pub days: Vec<ActivityDay>,
    pub sessions: Vec<ActivitySession>,
}

/// What one POST did: its whole answer.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct HealthCounts {
    pub days: u64,
    pub sessions: u64,
    /// Days that carry a night's sleep.
    #[serde(default)]
    pub nights: u64,
    /// Items refused (unreadable, out of bounds, outside the window or
    /// repeated) or stored with a value dropped, each once.
    pub skipped: u64,
}

/// The last POST, as Profile → Connections shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HealthResult {
    #[serde(flatten)]
    pub counts: HealthCounts,
    pub from: String,
    pub to: String,
    pub device: Option<String>,
    /// The device of the POST before: two phones on one profile replace
    /// each other's days.
    pub previous_device: Option<String>,
}

text_enum! {
    /// What a sync does with a new watch workout: add it, or list it to be
    /// added or dismissed.
    #[derive(Default)]
    pub enum SyncedWorkouts {
        #[default]
        Auto = "auto",
        Ask = "ask",
    }
}

/// `PUT …/sync/health/workouts`.
#[derive(Debug, Clone, Copy, Deserialize)]
pub struct WorkoutsMode {
    pub mode: SyncedWorkouts,
}

/// A profile's Health Connect sync status.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct HealthStatus {
    /// Epoch milliseconds of the last POST, if any.
    pub last_seen: Option<i64>,
    pub last_result: Option<HealthResult>,
    pub workouts: SyncedWorkouts,
}

/// A watch workout waiting to be added or dismissed (the Day view's
/// `pending_sessions`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PendingSession {
    pub key: String,
    pub day: String,
    pub start_at: String,
    pub end_at: String,
    #[serde(rename = "type")]
    pub kind: SessionType,
    pub name: String,
    pub minutes: u32,
    pub kcal: Option<i64>,
    pub distance_m: Option<i64>,
}

/// A watch workout's minutes: rounded, at least 1, at most a day.
#[must_use]
pub fn session_minutes(seconds: i64) -> u32 {
    u32::try_from(((seconds + 30) / 60).clamp(1, i64::from(SESSION_MINUTES_MAX))).unwrap_or(1)
}

/// A sync body, read: the window it replaces and the valid items in it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HealthPost {
    pub from: String,
    pub to: String,
    pub device: Option<String>,
    pub days: Vec<ActivityDay>,
    pub sessions: Vec<ActivitySession>,
    pub skipped: u64,
}

/// A whole number in `0..=max`, `Ok(None)` when absent or null, `Err`
/// when anything else (a fraction included: the phone rounds).
fn amount(m: &Map<String, Value>, key: &str, max: i64) -> Result<Option<i64>, ()> {
    match m.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => v
            .as_i64()
            .filter(|n| (0..=max).contains(n))
            .map(Some)
            .ok_or(()),
    }
}

/// A whole number as sent, `None` when absent, null or not one (`*bad`
/// then set): bounds are [`ActivityDay::trimmed`]'s.
fn whole(m: &Map<String, Value>, key: &str, bad: &mut bool) -> Option<i64> {
    let v = m.get(key).filter(|v| !v.is_null())?;
    let n = v.as_i64();
    *bad |= n.is_none();
    n
}

/// Text as sent, `None` when absent, null or not text (`*bad` then set).
fn string(m: &Map<String, Value>, key: &str, bad: &mut bool) -> Option<String> {
    let v = m.get(key).filter(|v| !v.is_null())?;
    let s = v.as_str().map(str::to_owned);
    *bad |= s.is_none();
    s
}

/// `field`, an optional list of at most `max` items.
fn list<'a>(obj: &'a Map<String, Value>, field: &str, max: usize) -> Result<&'a [Value], Error> {
    match obj.get(field) {
        None => Ok(&[]),
        Some(Value::Array(items)) if items.len() <= max => Ok(items),
        Some(Value::Array(_)) => Err(Error::invalid_field(
            field,
            format!("{field} holds at most {max} items"),
        )),
        Some(_) => Err(Error::invalid_field(
            field,
            format!("{field} must be a list"),
        )),
    }
}

/// `field`, an ISO day.
fn day_field(obj: &Map<String, Value>, field: &str) -> Result<Date, Error> {
    obj.get(field)
        .and_then(Value::as_str)
        .filter(|d| is_date(d))
        .and_then(|d| d.parse().ok())
        .ok_or_else(|| Error::invalid_field(field, format!("{field} must be YYYY-MM-DD")))
}

/// A label as text: control characters dropped, trimmed, at most `max`
/// characters; `None` when nothing is left.
fn label(s: &str, max: usize) -> Option<String> {
    let s: String = s.chars().filter(|c| !sneaky(*c)).collect();
    let s: String = s.trim().chars().take(max).collect();
    let s = s.trim_end();
    (!s.is_empty()).then(|| s.to_owned())
}

/// A Health Connect record id: 1–128 of `[A-Za-z0-9-]`.
#[must_use]
pub fn is_key(s: &str) -> bool {
    (1..=ACTIVITY_KEY_MAX).contains(&s.len())
        && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// A day's values all in bounds with one at least, or `None` (a file's
/// check: nothing is dropped quietly).
#[must_use]
pub fn checked_day(d: ActivityDay) -> Option<ActivityDay> {
    let (d, dropped) = d.trimmed();
    (is_date(&d.day) && !dropped && d.has_value()).then_some(d)
}

/// A session's values in bounds, or `None` to skip it.
#[must_use]
pub fn checked_session(s: ActivitySession) -> Option<ActivitySession> {
    let start: Timestamp = s.start_at.parse().ok()?;
    let end: Timestamp = s.end_at.parse().ok()?;
    let long = end.duration_since(start).as_secs();
    let ok = is_key(&s.key)
        && is_date(&s.day)
        && (1..=86_400).contains(&long)
        && (0..=ACTIVITY_TYPE_MAX).contains(&s.kind)
        && s.kcal
            .is_none_or(|k| (0..=i64::from(KCAL_MAX)).contains(&k))
        && s.distance_m
            .is_none_or(|d| (0..=i64::from(DISTANCE_M_MAX)).contains(&d))
        && (0..=3).contains(&s.recording_method);
    ok.then(|| ActivitySession {
        start_at: start.to_string(),
        end_at: end.to_string(),
        name: label(&s.name, ACTIVITY_NAME_MAX).unwrap_or_else(|| "Workout".to_owned()),
        ..s
    })
}

/// A day item: `None` to skip it (no day, or nothing left), else the day
/// and whether a value was dropped.
fn read_day(m: &Map<String, Value>) -> Option<(ActivityDay, bool)> {
    let mut bad = false;
    let d = ActivityDay {
        day: m.get("day")?.as_str()?.to_owned(),
        active_kcal: whole(m, "active_kcal", &mut bad),
        steps: whole(m, "steps", &mut bad),
        resting_hr: whole(m, "resting_hr", &mut bad),
        hrv_ms: whole(m, "hrv_ms", &mut bad),
        asleep_min: whole(m, "asleep_min", &mut bad),
        in_bed_min: whole(m, "in_bed_min", &mut bad),
        bedtime: string(m, "bedtime", &mut bad),
        wake_time: string(m, "wake_time", &mut bad),
        deep_min: whole(m, "deep_min", &mut bad),
        rem_min: whole(m, "rem_min", &mut bad),
        light_min: whole(m, "light_min", &mut bad),
    };
    // A non-number reads as absent: in the sleep group, that drops the night.
    let (d, dropped) = d.trimmed();
    (is_date(&d.day) && d.has_value()).then_some((d, dropped || bad))
}

/// A workout item: `None` to skip it, else the workout and whether its
/// energy, distance or recording method was dropped.
fn read_session(m: &Map<String, Value>) -> Option<(ActivitySession, bool)> {
    let text = |k: &str| m.get(k).and_then(Value::as_str).map(str::to_owned);
    let mut bad = false;
    let mut soft = |k: &str, max: i64| {
        amount(m, k, max).unwrap_or_else(|()| {
            bad = true;
            None
        })
    };
    let kcal = soft("kcal", i64::from(KCAL_MAX));
    let distance_m = soft("distance_m", i64::from(DISTANCE_M_MAX));
    let recording_method = soft("recording_method", 3).unwrap_or(0);
    let s = checked_session(ActivitySession {
        key: text("key")?,
        day: text("day")?,
        start_at: text("start_at")?,
        end_at: text("end_at")?,
        kind: m.get("type")?.as_i64()?,
        name: match m.get("name") {
            None | Some(Value::Null) => String::new(),
            Some(v) => v.as_str()?.to_owned(),
        },
        kcal,
        distance_m,
        recording_method,
    })?;
    Some((s, bad))
}

impl HealthPost {
    /// Read a sync body. `latest` is the last day `to` may name: tomorrow
    /// in the server's time zone.
    ///
    /// # Errors
    /// A broken envelope (400): not an object; `from`/`to` missing, not
    /// days, reversed, more than [`ACTIVITY_WINDOW_MAX`] days apart or `to`
    /// after `latest`; `days`/`sessions` not lists or too long.
    pub fn read(body: &Value, latest: Date) -> Result<Self, Error> {
        let Some(obj) = body.as_object() else {
            return Err(bad("the body must be a JSON object"));
        };
        let (from, to) = (day_field(obj, "from")?, day_field(obj, "to")?);
        if from > to {
            return Err(Error::invalid_field("from", "from must not be after to"));
        }
        let window = i64::try_from(ACTIVITY_WINDOW_MAX).unwrap_or(i64::MAX);
        if from < to.saturating_sub((window - 1).days()) {
            return Err(Error::invalid_field(
                "to",
                format!("a sync covers at most {ACTIVITY_WINDOW_MAX} days"),
            ));
        }
        if to > latest {
            return Err(Error::invalid_field("to", "to can't be in the future"));
        }
        let days = list(obj, "days", ACTIVITY_WINDOW_MAX)?;
        let sessions = list(obj, "sessions", ACTIVITY_SESSIONS_MAX)?;
        let (from, to) = (from.to_string(), to.to_string());
        let within = |d: &str| (from.as_str()..=to.as_str()).contains(&d);
        let mut post = Self {
            device: obj
                .get("device")
                .and_then(Value::as_str)
                .and_then(|d| label(d, LABEL_MAX)),
            days: Vec::new(),
            sessions: Vec::new(),
            skipped: 0,
            from: from.clone(),
            to: to.clone(),
        };
        let mut seen = BTreeSet::new();
        for item in days {
            match item.as_object().and_then(read_day) {
                Some((d, dropped)) if within(&d.day) && seen.insert(d.day.clone()) => {
                    post.skipped += u64::from(dropped);
                    post.days.push(d);
                }
                _ => post.skipped += 1,
            }
        }
        let mut seen = BTreeSet::new();
        for item in sessions {
            match item.as_object().and_then(read_session) {
                Some((s, dropped)) if within(&s.day) && seen.insert(s.key.clone()) => {
                    post.skipped += u64::from(dropped);
                    post.sessions.push(s);
                }
                _ => post.skipped += 1,
            }
        }
        Ok(post)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn far() -> Date {
        jiff::civil::date(2100, 1, 1)
    }

    fn session(key: &str, start: &str, end: &str) -> Value {
        json!({ "key": key, "day": "2026-10-08", "start_at": start, "end_at": end,
                "type": 33, "name": "Running", "kcal": 410 })
    }

    #[test]
    fn items_out_of_bounds_are_skipped_and_counted() {
        let post = HealthPost::read(
            &json!({ "from": "2026-10-02", "to": "2026-10-08", "device": " Pixel\u{1b} 9 ",
                "days": [
                    { "day": "2026-10-08", "active_kcal": 512, "steps": 9120 },
                    { "day": "2026-10-07", "active_kcal": 511.6 },
                    { "day": "2026-10-08", "steps": 1 },
                    { "day": "2026-10-01", "steps": 1 },
                    { "day": "2026-10-03" },
                    { "day": "2026-10-04", "active_kcal": -1 },
                    { "day": "2026-10-05", "steps": "many" },
                    7,
                ],
                "sessions": [
                    session("a-1", "2026-10-08T14:02:00Z", "2026-10-08T14:48:00Z"),
                    session("a-1", "2026-10-08T15:02:00Z", "2026-10-08T15:48:00Z"),
                    session("a-2", "2026-10-08T14:02:00Z", "2026-10-08T14:02:00Z"),
                    session("a-3", "2026-10-08T14:02:00Z", "2026-10-09T14:02:01Z"),
                    session("a/4", "2026-10-08T14:02:00Z", "2026-10-08T14:48:00Z"),
                    { "key": "a-5", "day": "2026-10-08", "start_at": "2026-10-08T16:00:00+03:00",
                      "end_at": "2026-10-08T16:30:00+03:00", "type": 9999 },
                    { "key": "a-6", "day": "2026-10-08", "start_at": "2026-10-08T16:00:00+03:00",
                      "end_at": "2026-10-08T16:30:00+03:00", "type": 0, "name": "  " },
                ] }),
            far(),
        )
        .unwrap();
        assert_eq!(post.device.as_deref(), Some("Pixel 9"));
        assert_eq!(
            post.days,
            [ActivityDay {
                day: "2026-10-08".into(),
                active_kcal: Some(512),
                steps: Some(9120),
                ..ActivityDay::default()
            }]
        );
        assert_eq!(
            post.sessions
                .iter()
                .map(|s| (s.key.as_str(), s.name.as_str(), s.start_at.as_str(), s.kcal))
                .collect::<Vec<_>>(),
            [
                ("a-1", "Running", "2026-10-08T14:02:00Z", Some(410)),
                ("a-6", "Workout", "2026-10-08T13:00:00Z", None),
            ]
        );
        assert_eq!(post.skipped, 7 + 5);
    }

    fn night() -> Value {
        json!({ "in_bed_min": 475, "asleep_min": 440, "bedtime": "23:10", "wake_time": "07:05" })
    }

    fn one_day(extra: &Value) -> (Vec<ActivityDay>, u64) {
        let mut item = json!({ "day": "2026-10-08", "steps": 100 });
        for (k, v) in extra.as_object().unwrap() {
            item[k] = v.clone();
        }
        let post = HealthPost::read(
            &json!({ "from": "2026-10-08", "to": "2026-10-08", "days": [item] }),
            far(),
        )
        .unwrap();
        (post.days, post.skipped)
    }

    #[test]
    fn a_bad_value_is_dropped_and_the_day_kept() {
        let (days, skipped) = one_day(&json!({ "resting_hr": 54, "hrv_ms": 48,
            "deep_min": 70, "rem_min": 90, "light_min": 200 }));
        assert_eq!(skipped, 1);
        // Stages need a night: dropped, counted.
        assert_eq!((days[0].resting_hr, days[0].deep_min), (Some(54), None));
        // Each bound: the field goes, steps stay, the item counts once.
        for bad in [
            json!({ "resting_hr": 19 }),
            json!({ "resting_hr": 251 }),
            json!({ "hrv_ms": 0 }),
            json!({ "hrv_ms": 501 }),
            json!({ "hrv_ms": 48.5 }),
            json!({ "hrv_ms": "48" }),
            json!({ "hrv_ms": 600, "resting_hr": 300 }),
        ] {
            let (days, skipped) = one_day(&bad);
            assert_eq!(skipped, 1, "{bad}");
            assert_eq!(
                (days[0].steps, days[0].resting_hr, days[0].hrv_ms),
                (Some(100), None, None),
                "{bad}"
            );
        }
        // A distance out of bounds: dropped, the workout kept.
        let post = HealthPost::read(
            &json!({ "from": "2026-10-08", "to": "2026-10-08", "sessions": [{
                "key": "k", "day": "2026-10-08", "start_at": "2026-10-08T14:00:00Z",
                "end_at": "2026-10-08T14:30:00Z", "type": 33, "distance_m": 1_000_001,
                "recording_method": 2 }] }),
            far(),
        )
        .unwrap();
        assert_eq!(post.skipped, 1);
        assert_eq!(
            (
                post.sessions[0].distance_m,
                post.sessions[0].recording_method
            ),
            (None, AUTO_RECORDED)
        );
    }

    #[test]
    fn sleep_comes_all_or_none() {
        let mut full = night();
        full["deep_min"] = json!(70);
        let (days, skipped) = one_day(&full);
        assert_eq!(skipped, 0);
        assert_eq!(
            (
                days[0].in_bed_min,
                days[0].bedtime.as_deref(),
                days[0].deep_min
            ),
            (Some(475), Some("23:10"), Some(70))
        );
        let broken = |k: &str, v: &Value| {
            let mut n = night();
            if v.is_null() {
                n.as_object_mut().unwrap().remove(k);
            } else {
                n[k] = v.clone();
            }
            n["deep_min"] = json!(60);
            one_day(&n)
        };
        for (k, v) in [
            ("in_bed_min", json!(0)),
            ("in_bed_min", json!(1441)),
            ("asleep_min", json!(476)),
            ("asleep_min", json!(-1)),
            ("bedtime", json!("24:00")),
            ("wake_time", json!("7:05")),
            ("wake_time", json!(705)),
            ("bedtime", Value::Null),
        ] {
            let (days, skipped) = broken(k, &v);
            assert_eq!(skipped, 1, "{k} {v}");
            let d = &days[0];
            assert_eq!(
                (
                    d.in_bed_min,
                    d.asleep_min,
                    d.bedtime.as_deref(),
                    d.wake_time.as_deref()
                ),
                (None, None, None, None),
                "{k} {v}"
            );
            assert_eq!((d.deep_min, d.steps), (None, Some(100)), "{k} {v}");
        }
        // Stages longer than the night go alone.
        let mut long = night();
        long["rem_min"] = json!(476);
        let (days, skipped) = one_day(&long);
        assert_eq!(
            (days[0].rem_min, days[0].in_bed_min, skipped),
            (None, Some(475), 1)
        );
        // A day left with nothing goes.
        let post = HealthPost::read(
            &json!({ "from": "2026-10-08", "to": "2026-10-08", "days": [
                { "day": "2026-10-08", "in_bed_min": 0, "asleep_min": 0,
                  "bedtime": "23:00", "wake_time": "07:00" }] }),
            far(),
        )
        .unwrap();
        assert_eq!((post.days.len(), post.skipped), (0, 1));
        let hrv = |hr| ActivityDay {
            day: "2026-10-08".into(),
            hrv_ms: Some(48),
            resting_hr: hr,
            ..ActivityDay::default()
        };
        assert!(checked_day(hrv(None)).is_some());
        assert!(checked_day(hrv(Some(5))).is_none());
    }

    #[test]
    fn watch_minutes_round_to_at_least_one() {
        assert_eq!(
            [1, 59, 89, 90, 2700, 200_000].map(session_minutes),
            [1, 1, 1, 2, 45, SESSION_MINUTES_MAX]
        );
        assert_eq!(hc_type(33), SessionType::Run);
        assert_eq!(hc_type(56), SessionType::Other);
    }
}
