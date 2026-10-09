//! The server's clock: one "now" and one rule for "today". The server's
//! own today is [`crate::AppState::today`], in its `--time-zone`.

use jiff::civil::Date;
use jiff::tz::TimeZone;
use jiff::{Timestamp, ToSpan};

/// Now, in epoch milliseconds.
#[must_use]
pub fn now_ms() -> i64 {
    Timestamp::now().as_millisecond()
}

/// Today in `tz`.
#[must_use]
pub fn today_in(tz: &TimeZone) -> Date {
    Timestamp::now().to_zoned(tz.clone()).date()
}

/// The last day a reading may fall on: tomorrow in `tz`.
#[must_use]
pub fn latest_day(tz: &TimeZone) -> Date {
    today_in(tz).saturating_add(1.day())
}

/// The latest day a client may call today: tomorrow in UTC, as far ahead
/// as any time zone is. Bounds client-named days, which follow the client's
/// zone, not the server's.
#[must_use]
pub fn day_so_far() -> Date {
    latest_day(&TimeZone::UTC)
}
