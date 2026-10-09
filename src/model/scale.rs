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
use super::sneaky;

/// The only scale source so far; the column leaves room for another.
pub const OPENSCALE: &str = "openscale";

text_enum! {
    /// Where a day's weight came from: typed here, or a sync source (the
    /// names `sync_state.source` uses). Export files from before say
    /// `"scale"` for openScale.
    #[derive(Default)]
    pub enum WeightSource {
        #[default]
        Manual = "manual",
        #[serde(alias = "scale")]
        OpenScale = "openscale",
    }
}
/// One weigh-in as stored. Percentages are `None` when the scale sent
/// none (openScale sends 0).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ScaleReading {
    pub source: String,
    /// Epoch milliseconds, UTC.
    pub taken_at: i64,
    /// Local day, in the server's time zone.
    pub day: String,
    pub weight: f64,
    pub body_fat: Option<f64>,
    pub water: Option<f64>,
    pub muscle: Option<f64>,
}

/// A reading as it arrived, with whom it belongs to in openScale.
#[derive(Debug, Clone, PartialEq)]
pub struct Incoming {
    pub user: i64,
    pub username: Option<String>,
    /// openScale's id: per installation, reused after a reinstall.
    pub source_id: Option<i64>,
    pub reading: ScaleReading,
}

/// What one webhook item asks for.
#[derive(Debug, Clone, PartialEq)]
pub enum ScaleOp {
    Upsert(Incoming),
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
                        .map(ScaleOp::Upsert),
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
            "insert" | "update" => push(incoming(&obj, tz, latest).map(ScaleOp::Upsert)),
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
        reading: ScaleReading {
            source: OPENSCALE.to_owned(),
            taken_at: ts.as_millisecond(),
            day: day.to_string(),
            weight,
            body_fat: percent(m, "body_fat"),
            water: percent(m, "water"),
            muscle: percent(m, "muscle"),
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
