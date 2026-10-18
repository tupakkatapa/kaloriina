//! Raw records: everything a connection sent, kept as sent (ADR 0019). The
//! phone's records route posts pages of them; openScale's measurements and
//! a Google Health export's rows land in the same store. An archive: never
//! shown or exported, upserted and never deleted; the server makes Health
//! Connect's nights and resting energy from it.

use jiff::Timestamp;
use jiff::tz::{Offset, TimeZone};
use serde_json::{Map, Value};

use super::is_key;
use super::prelude::*;

/// One record to keep.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HealthRecord {
    /// The source's record type (`HeartRate`, `UserSleeps`, `measurement`).
    pub kind: String,
    /// The source's id for it.
    pub id: String,
    /// UTC, RFC 3339; `end_at` is `None` for an instant.
    pub start_at: Option<String>,
    pub end_at: Option<String>,
    /// The local day of its start.
    pub day: Option<String>,
    /// JSON, at most [`HEALTH_RECORD_BYTES_MAX`] bytes (see [`kept_data`]).
    pub data: String,
    /// Whether `data` is the flag of a bigger record (the phone's or this
    /// server's).
    pub truncated: bool,
}

/// What a records POST did: its whole answer.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RawCounts {
    /// Records kept (new or again).
    pub records: u64,
    /// Of those, kept as a flag: over [`HEALTH_RECORD_BYTES_MAX`].
    pub truncated: u64,
    /// Items refused, and kinds the phone may not read (not granted).
    pub skipped: u64,
    /// Reads that failed on the phone (it says how many).
    pub failed: u64,
}

/// The phone's records outcome of its last sync (its pages; the first after
/// a window starts it over), as
/// `sync_state` keeps it: every page's counts added, and when the last one
/// came (epoch milliseconds). The window marks it `closed` in the stored
/// JSON (not read here, never served): the next page starts over.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecordsResult {
    #[serde(flatten)]
    pub counts: RawCounts,
    pub at: i64,
}

impl RecordsResult {
    /// This outcome with a page's `counts`, which came `at`.
    #[must_use]
    pub fn add(self, counts: RawCounts, at: i64) -> Self {
        let c = self.counts;
        Self {
            counts: RawCounts {
                records: c.records + counts.records,
                truncated: c.truncated + counts.truncated,
                skipped: c.skipped + counts.skipped,
                failed: c.failed + counts.failed,
            },
            at,
        }
    }
}

/// A records body, read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecordsPost {
    pub records: Vec<HealthRecord>,
    pub skipped: u64,
    pub failed: u64,
}

/// `data` as kept: its JSON when within [`HEALTH_RECORD_BYTES_MAX`], else
/// `{"truncated": true, "bytes": N}` with its top-level scalars (never a
/// cut text: what's kept is whole or not there). Whether it was cut.
#[must_use]
pub fn kept_data(data: &Map<String, Value>) -> (String, bool) {
    let text = serde_json::to_string(data).unwrap_or_default();
    if text.len() <= HEALTH_RECORD_BYTES_MAX {
        return (text, false);
    }
    let mut flag = Map::new();
    flag.insert("truncated".into(), Value::Bool(true));
    flag.insert("bytes".into(), Value::from(text.len()));
    for (k, v) in data {
        let scalar = !matches!(v, Value::Array(_) | Value::Object(_));
        let small = v.as_str().is_none_or(|s| s.len() <= LABEL_MAX * 4);
        if scalar && small && !flag.contains_key(k) {
            flag.insert(k.clone(), v.clone());
        }
    }
    (Value::Object(flag).to_string(), true)
}

/// A record kind: 1–[`RECORD_KIND_MAX`] of `[A-Za-z0-9_]`.
#[must_use]
pub fn is_kind(s: &str) -> bool {
    (1..=RECORD_KIND_MAX).contains(&s.len())
        && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

/// The offset a record's data names for its start (Health Connect's
/// `start_zone_offset`, or an instant's `zone_offset`: `+03:00`, `Z`).
fn start_offset(data: &Map<String, Value>) -> Option<Offset> {
    let text = data
        .get("start_zone_offset")
        .or_else(|| data.get("zone_offset"))?
        .as_str()?;
    let at: Timestamp = format!("1970-01-01T00:00:00{text}").parse().ok()?;
    Offset::from_seconds(i32::try_from(-at.as_second()).ok()?).ok()
}

/// An item: a kind, an id, a start (an end too unless an instant) and its
/// data, an object; `None` to skip it. Its day falls in its own offset,
/// else in `tz`.
fn read_record(m: &Map<String, Value>, tz: &TimeZone) -> Option<HealthRecord> {
    let text = |k: &str| m.get(k).and_then(Value::as_str);
    let kind = text("kind").filter(|k| is_kind(k))?;
    let id = text("id").filter(|i| is_key(i))?;
    let start: Timestamp = text("start")?.parse().ok()?;
    let end = match m.get("end") {
        None | Some(Value::Null) => None,
        Some(v) => Some(v.as_str()?.parse::<Timestamp>().ok()?),
    };
    let data = m.get("data")?.as_object()?;
    let zone = start_offset(data).map_or_else(|| tz.clone(), TimeZone::fixed);
    // The phone flags a record over the cap itself, in the same shape.
    let flagged = data.get("truncated") == Some(&Value::Bool(true));
    let (data, cut) = kept_data(data);
    Some(HealthRecord {
        kind: kind.to_owned(),
        id: id.to_owned(),
        start_at: Some(start.to_string()),
        end_at: end.map(|e| e.to_string()),
        day: Some(start.to_zoned(zone).date().to_string()),
        data,
        truncated: cut || flagged,
    })
}

impl RecordsPost {
    /// Read a records body (`{device, records, skipped, failed}`); a bad
    /// item is skipped and counted.
    ///
    /// # Errors
    /// Not an object; `records` not a list of at most
    /// [`HEALTH_RECORDS_MAX`] (400).
    pub fn read(body: &Value, tz: &TimeZone) -> Result<Self, Error> {
        let Some(obj) = body.as_object() else {
            return Err(bad("the body must be a JSON object"));
        };
        let items = match obj.get("records") {
            None => &[][..],
            Some(Value::Array(items)) if items.len() <= HEALTH_RECORDS_MAX => items,
            Some(_) => {
                return Err(Error::invalid_field(
                    "records",
                    format!("records must be a list of at most {HEALTH_RECORDS_MAX}"),
                ));
            }
        };
        // What the phone couldn't read: `skipped` an ungranted kind or an
        // item, `failed` a read that failed.
        let phone = obj
            .get("skipped")
            .and_then(Value::as_u64)
            .unwrap_or_default();
        let mut post = Self {
            records: Vec::with_capacity(items.len()),
            skipped: phone,
            failed: obj
                .get("failed")
                .and_then(Value::as_u64)
                .unwrap_or_default(),
        };
        for item in items {
            match item.as_object().and_then(|m| read_record(m, tz)) {
                Some(r) => post.records.push(r),
                None => post.skipped += 1,
            }
        }
        Ok(post)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn an_oversized_record_keeps_its_scalars_and_size() {
        let small = json!({ "bpm": 61, "samples": [1, 2] });
        assert_eq!(
            kept_data(small.as_object().unwrap()),
            (small.to_string(), false)
        );
        let big = json!({ "id": "hr-1", "origin": "com.fitbit", "count": 3,
            "samples": vec![0; HEALTH_RECORD_BYTES_MAX], "nested": { "a": 1 } });
        let (text, cut) = kept_data(big.as_object().unwrap());
        assert!(cut);
        let flag: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(
            flag,
            json!({ "truncated": true, "bytes": big.to_string().len(), "id": "hr-1",
                    "origin": "com.fitbit", "count": 3 })
        );
    }

    #[test]
    fn raw_day_uses_the_record_offset() {
        let day = |m: Value| {
            RecordsPost::read(&json!({ "records": [m] }), &TimeZone::UTC)
                .unwrap()
                .records[0]
                .day
                .clone()
        };
        // 01:30 in Helsinki is the day before in UTC.
        assert_eq!(
            day(
                json!({ "kind": "Steps", "id": "s-1", "start": "2026-09-01T22:30:00Z",
                "end": "2026-09-01T23:30:00Z",
                "data": { "start_zone_offset": "+03:00", "end_zone_offset": "+03:00" } })
            ),
            Some("2026-09-02".into())
        );
        assert_eq!(
            day(
                json!({ "kind": "Weight", "id": "w-1", "start": "2026-09-01T22:30:00Z",
                "data": { "zone_offset": "+03:00" } })
            ),
            Some("2026-09-02".into())
        );
        // No offset, or one that doesn't read: the server's zone.
        for data in [json!({}), json!({ "zone_offset": "Helsinki" })] {
            assert_eq!(
                day(
                    json!({ "kind": "Weight", "id": "w-2", "start": "2026-09-01T22:30:00Z",
                    "data": data })
                ),
                Some("2026-09-01".into())
            );
        }
    }

    #[test]
    fn limits_match_the_shared_table() {
        let limits: Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/health/record-limits.json"
        ))
        .unwrap();
        let n = |k: &str| usize::try_from(limits[k].as_u64().unwrap()).unwrap();
        assert_eq!(n("health_bytes_max"), HEALTH_BYTES_MAX);
        assert_eq!(n("health_record_bytes_max"), HEALTH_RECORD_BYTES_MAX);
        assert_eq!(n("flag_text_bytes_max"), LABEL_MAX * 4);
        // A page the phone fills to its size always fits the route.
        assert!(n("page_bytes") < HEALTH_BYTES_MAX);
        assert!(HEALTH_RECORD_BYTES_MAX < n("page_bytes"));
    }

    #[test]
    fn a_record_the_phone_flagged_counts_as_truncated() {
        let post = RecordsPost::read(
            &json!({ "records": [{ "kind": "HeartRate", "id": "hr-1",
                "start": "2026-09-01T10:00:00Z", "end": "2026-09-01T11:00:00Z",
                "data": { "truncated": true, "bytes": 2_097_152, "origin": "com.fitbit" } }] }),
            &TimeZone::UTC,
        )
        .unwrap();
        assert!(post.records[0].truncated);
    }
}
