//! Library behind the `kaloriina` binary: the JSON API with the embedded web
//! UI, the `SQLite` store (diary, foods, profiles, weights, exercises,
//! workouts, sessions), the Cronometer import and the Fineli import.

#![forbid(unsafe_code)]

/// Floats from arithmetic are equal when within 1e-9.
#[cfg(test)]
macro_rules! assert_close {
    ($a:expr, $b:expr $(, $why:literal)?) => {{
        let (a, b): (f64, f64) = ($a, $b);
        assert!((a - b).abs() < 1e-9, concat!("{} != {}", $(": ", $why)?), a, b);
    }};
}

mod api;
mod db;
mod dri;
mod error;
pub mod fineli;
pub mod import;
pub mod model;
mod nutrients;
mod off;

use std::path::Path;
use std::sync::{Arc, Mutex};

pub use api::{newest_backup, router};
pub use error::Error;
pub use model::ProfileId;
pub use rusqlite::Connection;

/// Shared server state.
#[derive(Clone)]
pub struct AppState {
    pub db: Arc<Mutex<Connection>>,
    /// `None` when no TLS roots could be loaded: the diary still works,
    /// only Open Food Facts lookups are off.
    pub http: Option<reqwest::Client>,
    /// Open Food Facts base URL; overridable for tests.
    pub off_url: String,
    /// Host names served besides loopback ones (e.g. the HTTPS proxy's name).
    /// Requests naming any other host are refused: DNS rebinding defence.
    pub allowed_hosts: Vec<String>,
    /// The server's time zone: which local day a scale reading falls on.
    pub tz: jiff::tz::TimeZone,
    /// Where the backup job writes its copies (`--backup-dir`), for
    /// `/api/backups`; `None` when backups are off.
    pub backup_dir: Option<std::path::PathBuf>,
}

impl AppState {
    #[must_use]
    pub fn new(conn: Connection, off_url: String) -> Self {
        // Never followed elsewhere, and HTTPS only unless the base URL is a
        // plain-HTTP stand-in (tests).
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .https_only(off_url.starts_with("https://"))
            .user_agent(concat!("kaloriina/", env!("CARGO_PKG_VERSION")))
            .build()
            .inspect_err(|e| tracing::error!(error = %e, "barcode lookup disabled: no TLS roots"))
            .ok();
        Self {
            db: Arc::new(Mutex::new(conn)),
            http,
            off_url,
            allowed_hosts: Vec::new(),
            tz: jiff::tz::TimeZone::UTC,
            backup_dir: None,
        }
    }

    /// The server's today, in its time zone (`--time-zone`): for what the
    /// client doesn't name, as ages. Client-named days are bounded by
    /// [`model::day_so_far`] instead.
    #[must_use]
    pub fn today(&self) -> String {
        model::today_in(&self.tz).to_string()
    }
}

/// Open (or create) the database at `path` and migrate it.
///
/// # Errors
/// Fails if the file cannot be opened or a migration fails.
pub fn open(path: &Path) -> Result<Connection, Error> {
    db::open(path)
}
