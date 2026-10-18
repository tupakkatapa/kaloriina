//! Scale readings from openScale sync's webhook: the body read
//! once at the boundary into operations on readings. Only the envelope can
//! be refused (400); a bad item is skipped and counted, because openScale
//! retries anything but 2xx forever.

use std::collections::BTreeMap;

use jiff::Timestamp;
use jiff::civil::Date;
use jiff::tz::TimeZone;

use serde_json::value::RawValue;
use serde_json::{Map, Value};

use super::prelude::*;
use super::{Provenance, sneaky};

/// openScale's source key; Health Connect readings use `health_connect`.
pub const OPENSCALE: &str = "openscale";

text_enum! {
    /// Where a day's weight came from: typed here, or a sync source (the
    /// names `sync_state.source` uses). A typed weight beats openScale's,
    /// which beats Health Connect's ([`Provenance`]).
    #[derive(Default)]
    pub enum WeightSource {
        #[default]
        Hand = "hand",
        OpenScale = "openscale",
        HealthConnect = "health_connect",
    }
}
/// One weigh-in as stored: openScale's, or Health Connect's
/// (`health_connect`, another app's). Values are `None` when the scale sent
/// none (openScale sends 0).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ScaleReading {
    /// `openscale` or `health_connect`.
    pub source: WeightSource,
    /// Epoch milliseconds, UTC.
    pub taken_at: i64,
    /// Local day: the server's time zone (openScale), the phone's (Health
    /// Connect).
    pub day: String,
    pub weight: f64,
    pub body_fat: Option<f64>,
    pub water: Option<f64>,
    pub muscle: Option<f64>,
    pub bone_kg: Option<f64>,
    /// Lean body mass.
    pub lbm_kg: Option<f64>,
    /// Basal metabolic rate, kcal a day.
    pub bmr_kcal: Option<f64>,
}

/// Without a night, a day's weigh-in counts from this local hour: one before
/// it was taken before that night's sleep.
pub const WEIGH_IN_FROM_HOUR: i8 = 4;

/// When `day`'s weigh-in may be taken from (epoch ms): its night's wake time
/// `wake` ("HH:MM", local), else [`WEIGH_IN_FROM_HOUR`], in `tz`; `None`
/// when `day` or `wake` doesn't read.
#[must_use]
pub fn woke_at(day: &str, wake: Option<&str>, tz: &TimeZone) -> Option<i64> {
    let (h, m) = match wake {
        Some(w) => {
            let (h, m) = w.split_once(':')?;
            (h.parse().ok()?, m.parse().ok()?)
        }
        None => (WEIGH_IN_FROM_HOUR, 0),
    };
    let at = day.parse::<Date>().ok()?.at(h, m, 0, 0);
    Some(at.to_zoned(tz.clone()).ok()?.timestamp().as_millisecond())
}

/// The reading that stands for a day (`readings`, that day's): the first taken
/// from `woke` ([`woke_at`]: the morning weight), the better source first
/// ([`Provenance`]: openScale's before Health Connect's). With the day's
/// `night` known, one taken before its wake time is the evening before's, so a
/// day with only such readings has no morning weight; without a night there's
/// no evidence of when sleep was, so the day's earliest reading stands rather
/// than none.
#[must_use]
pub fn day_reading(
    readings: &[ScaleReading],
    woke: Option<i64>,
    night: bool,
) -> Option<&ScaleReading> {
    let first = |after: Option<i64>| {
        readings
            .iter()
            .filter(|r| after.is_none_or(|w| r.taken_at >= w))
            .min_by_key(|r| (Provenance::from(r.source), r.taken_at))
    };
    first(woke).or_else(|| if night { None } else { first(None) })
}

/// A reading as listed: whether it is its day's weight ([`day_reading`]).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ShownReading {
    #[serde(flatten)]
    pub reading: ScaleReading,
    pub chosen: bool,
}

/// A reading as it arrived, with whom it belongs to in openScale.
#[derive(Debug, Clone, PartialEq)]
pub struct Incoming {
    pub user: i64,
    pub username: Option<String>,
    /// openScale's id: per installation, reused after a reinstall.
    pub source_id: Option<i64>,
    pub reading: ScaleReading,
    /// The measurement as sent (JSON), every value of it.
    pub raw: String,
}

/// What one webhook item asks for.
#[derive(Debug, Clone, PartialEq)]
pub enum ScaleOp {
    Upsert(Box<Incoming>),
    Delete { user: i64, taken_at: i64 },
    Clear { user: i64 },
}

impl ScaleOp {
    #[must_use]
    pub fn user(&self) -> i64 {
        match self {
            Self::Upsert(i) => i.user,
            Self::Delete { user, .. } | Self::Clear { user } => *user,
        }
    }
}

/// A webhook body, read.
#[derive(Debug, Clone, PartialEq)]
pub struct ScalePost {
    /// `insert`, `update`, `delete`, `clear`, `test` or `unknown`.
    pub event: &'static str,
    pub ops: Vec<ScaleOp>,
    /// Items that couldn't be read or were out of bounds.
    pub skipped: u64,
}

/// What one POST did: the webhook's whole answer.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScaleCounts {
    /// Readings stored or removed.
    pub applied: u64,
    /// Items refused: unreadable, out of bounds or too far ahead.
    pub skipped: u64,
    /// Items of openScale users other than the bound one (all while unbound).
    pub ignored: u64,
}

/// An openScale user the webhook has carried, with how many of their items
/// the last POST naming them ignored.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SeenUser {
    pub id: i64,
    pub username: String,
    pub ignored: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LastResult {
    pub event: String,
    #[serde(flatten)]
    pub counts: ScaleCounts,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BoundUser {
    pub id: i64,
    pub username: String,
}

/// A profile's openScale connection as Profile → Connections shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SyncStatus {
    pub bound_user: Option<BoundUser>,
    pub seen_users: Vec<SeenUser>,
    /// Epoch milliseconds of the last POST, if any.
    pub last_seen: Option<i64>,
    pub last_result: Option<LastResult>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct BindInput {
    pub user_id: i64,
}

const EVENTS: [&str; 5] = ["insert", "update", "delete", "clear", "test"];

impl ScalePost {
    /// Read a webhook body. A batch is `{event, measurements: [...]}`, its
    /// items without an event of their own; anything else is one event.
    /// Unknown events do nothing. `tz` makes each reading's local day; a
    /// reading after `latest` is skipped.
    ///
    /// The body is read in place: its envelope as raw parts, a batch's
    /// items one at a time, so memory stays near the body's size.
    ///
    /// # Errors
    /// Not an object, or `measurements` not a list of at most
    /// [`SCALE_BATCH_MAX`] (400).
    pub fn read(body: &[u8], tz: &TimeZone, latest: Date) -> Result<Self, Error> {
        let obj: BTreeMap<String, &RawValue> =
            serde_json::from_slice(body).map_err(|_| bad("the body must be a JSON object"))?;
        let event = obj
            .get("event")
            .and_then(|e| serde_json::from_str::<String>(e.get()).ok())
            .and_then(|e| EVENTS.into_iter().find(|&k| k == e))
            .unwrap_or("unknown");
        let mut post = Self {
            event,
            ops: Vec::new(),
            skipped: 0,
        };
        let mut push = |op: Option<ScaleOp>| match op {
            Some(op) => post.ops.push(op),
            None => post.skipped += 1,
        };
        if let Some(list) = obj.get("measurements") {
            let list: Vec<&RawValue> = serde_json::from_str(list.get())
                .map_err(|_| Error::invalid_field("measurements", "measurements must be a list"))?;
            if list.len() > SCALE_BATCH_MAX {
                return Err(Error::invalid_field(
                    "measurements",
                    format!("a batch holds at most {SCALE_BATCH_MAX} measurements"),
                ));
            }
            for item in list {
                push(
                    serde_json::from_str::<Map<String, Value>>(item.get())
                        .ok()
                        .and_then(|m| incoming(&m, tz, latest))
                        .map(|i| ScaleOp::Upsert(Box::new(i))),
                );
            }
            return Ok(post);
        }
        // One event: a small object, read whole.
        let obj: Map<String, Value> = obj
            .into_iter()
            .filter_map(|(k, v)| Some((k, serde_json::from_str(v.get()).ok()?)))
            .collect();
        match event {
            "insert" | "update" => {
                push(incoming(&obj, tz, latest).map(|i| ScaleOp::Upsert(Box::new(i))));
            }
            "delete" => push(
                user(&obj)
                    .zip(taken_at(&obj))
                    .map(|(user, ts)| ScaleOp::Delete {
                        user,
                        taken_at: ts.as_millisecond(),
                    }),
            ),
            "clear" => push(user(&obj).map(|user| ScaleOp::Clear { user })),
            _ => {}
        }
        Ok(post)
    }
}

fn user(m: &Map<String, Value>) -> Option<i64> {
    m.get("userId").and_then(Value::as_i64)
}

/// openScale writes `yyyy-MM-dd'T'HH:mm:ss.SSS'Z'`; any RFC 3339 instant
/// reads.
fn taken_at(m: &Map<String, Value>) -> Option<Timestamp> {
    m.get("date")?.as_str()?.parse().ok()
}

/// A body percentage; 0 is openScale's "none", and over 100 is no reading.
fn percent(m: &Map<String, Value>, key: &str) -> Option<f64> {
    m.get(key)
        .and_then(Value::as_f64)
        .filter(|v| *v > 0.0 && *v <= 100.0)
}

/// A value of `values[]` (openScale's every measurement, by key) in
/// `0 < v <= max`; 0 is "none".
fn measured(m: &Map<String, Value>, key: &str, max: f64) -> Option<f64> {
    m.get("values")?
        .as_array()?
        .iter()
        .find(|v| v.get("key").and_then(Value::as_str) == Some(key))?
        .get("value")?
        .as_f64()
        .filter(|v| *v > 0.0 && *v <= max)
}

/// The display name, as a label: control characters dropped, trimmed,
/// at most [`LABEL_MAX`] characters.
fn username(m: &Map<String, Value>) -> Option<String> {
    let name: String = m
        .get("username")?
        .as_str()?
        .chars()
        .filter(|c| !sneaky(*c))
        .take(LABEL_MAX)
        .collect();
    let name = name.trim();
    (!name.is_empty()).then(|| name.to_owned())
}

/// One measurement, or `None` to skip it: no user or date, a weight out of
/// [`BODY_KG_MIN`]–[`BODY_KG_MAX`], or a day after `latest`.
fn incoming(m: &Map<String, Value>, tz: &TimeZone, latest: Date) -> Option<Incoming> {
    let user = user(m)?;
    let ts = taken_at(m)?;
    let weight = m
        .get("weight")
        .and_then(Value::as_f64)
        .filter(|w| (BODY_KG_MIN..=BODY_KG_MAX).contains(w))?;
    let day = ts.to_zoned(tz.clone()).date();
    if day > latest {
        return None;
    }
    Some(Incoming {
        user,
        username: username(m),
        source_id: m.get("id").and_then(Value::as_i64),
        raw: Value::Object(m.clone()).to_string(),
        reading: ScaleReading {
            source: WeightSource::OpenScale,
            taken_at: ts.as_millisecond(),
            day: day.to_string(),
            weight,
            body_fat: percent(m, "body_fat"),
            water: percent(m, "water"),
            muscle: percent(m, "muscle"),
            bone_kg: measured(m, "bone", BONE_KG_MAX),
            lbm_kg: measured(m, "lbm", BODY_KG_MAX),
            bmr_kcal: measured(m, "bmr", BMR_KCAL_MAX),
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn helsinki() -> TimeZone {
        TimeZone::posix("EET-2EEST,M3.5.0/3,M10.5.0/4").unwrap()
    }

    fn read(body: &Value, tz: &TimeZone, latest: Date) -> Result<ScalePost, Error> {
        ScalePost::read(body.to_string().as_bytes(), tz, latest)
    }

    fn far() -> Date {
        jiff::civil::date(2100, 1, 1)
    }

    #[test]
    fn a_reading_after_local_midnight_is_that_local_day() {
        let post = read(
            &json!({ "event": "insert", "id": 7, "userId": 1, "username": "Alex",
                     "date": "2026-10-07T22:30:00.000Z", "weight": 80.5,
                     "body_fat": 0, "water": 55.5, "muscle": 120 }),
            &helsinki(),
            far(),
        )
        .unwrap();
        let [ScaleOp::Upsert(i)] = post.ops.as_slice() else {
            panic!("{post:?}")
        };
        assert_eq!(i.reading.day, "2026-10-08");
        assert_eq!(i.reading.taken_at, 1_791_412_200_000);
        assert_eq!(
            (i.reading.body_fat, i.reading.water, i.reading.muscle),
            (None, Some(55.5), None),
            "0 and over 100 are no reading"
        );
        assert_eq!(i.username.as_deref(), Some("Alex"));
    }

    fn weighed(at: &str, weight: f64) -> ScaleReading {
        ScaleReading {
            source: WeightSource::OpenScale,
            taken_at: at.parse::<Timestamp>().unwrap().as_millisecond(),
            day: "2026-07-10".to_owned(),
            weight,
            body_fat: None,
            water: None,
            muscle: None,
            bone_kg: None,
            lbm_kg: None,
            bmr_kcal: None,
        }
    }

    /// Jul 10, 78.6 kg at 00:26 before that night's sleep, 77.35 kg at
    /// 10:00 after it: the day's weight is the morning's.
    #[test]
    fn the_days_weight_is_the_first_after_waking() {
        let tz = helsinki();
        let day = [
            weighed("2026-07-09T21:26:00Z", 78.6),
            weighed("2026-07-10T07:00:00Z", 77.35),
            weighed("2026-07-10T15:00:00Z", 77.9),
        ];
        let woke = woke_at("2026-07-10", Some("09:30"), &tz);
        assert_eq!(woke, Some(1_783_665_000_000));
        assert_close!(day_reading(&day, woke, true).unwrap().weight, 77.35);
        // No night: from 04:00.
        let dawn = woke_at("2026-07-10", None, &tz);
        assert_close!(day_reading(&day, dawn, false).unwrap().weight, 77.35);
        // Only a reading before that night's sleep: no morning weight.
        assert_eq!(day_reading(&day[..1], woke, true), None);
        // Without a night, nothing says it was before sleep: it stands.
        assert_close!(day_reading(&day[..1], dawn, false).unwrap().weight, 78.6);
        // openScale's before Health Connect's.
        let mut phone = weighed("2026-07-10T06:50:00Z", 77.0);
        phone.source = WeightSource::HealthConnect;
        let both = [phone, day[1].clone()];
        assert_close!(day_reading(&both, woke, true).unwrap().weight, 77.35);
        assert_eq!(woke_at("2026-07-10", Some("nonsense"), &tz), None);
    }

    /// A wake time the clock skips (03:30 on the night daylight
    /// saving time starts in Helsinki) is still an instant: the one after
    /// the gap, 04:30 EEST.
    #[test]
    fn a_wake_time_in_the_spring_gap_is_an_instant() {
        let at = woke_at("2026-03-29", Some("03:30"), &helsinki());
        assert_eq!(
            at.map(|ms| Timestamp::from_millisecond(ms).unwrap().to_string()),
            Some("2026-03-29T01:30:00Z".to_owned())
        );
    }

    #[test]
    fn only_the_envelope_is_refused() {
        let tz = TimeZone::UTC;
        assert!(read(&json!([1]), &tz, far()).is_err());
        assert!(read(&json!({ "measurements": {} }), &tz, far()).is_err());
        let post = read(&json!({ "event": "whatever" }), &tz, far()).unwrap();
        assert_eq!(
            (post.event, post.ops.len(), post.skipped),
            ("unknown", 0, 0)
        );
        let post = read(
            &json!({ "event": "insert", "measurements": [
                { "userId": 1, "date": "2026-10-01T06:00:00.000Z", "weight": 80 },
                { "userId": 1, "date": "not a date", "weight": 80 },
                { "userId": 1, "date": "2026-10-01T06:00:00.000Z", "weight": 0 },
                { "userId": 1, "date": "2099-10-01T06:00:00.000Z", "weight": 80 },
                "nonsense",
            ] }),
            &tz,
            jiff::civil::date(2026, 10, 2),
        )
        .unwrap();
        assert_eq!((post.ops.len(), post.skipped), (1, 4));
    }
}
