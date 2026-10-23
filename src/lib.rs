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
pub mod google_health;
pub mod import;
pub mod loop_habits;
pub mod model;
mod nutrients;
mod off;

use std::path::Path;
use std::sync::{Arc, Mutex};

pub use api::{newest_backup, router, stale_backup};
pub use db::{derived_current, feedback_list, feedback_pull};
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
    /// Outbound hooks' client (ADR 0024): plain HTTP allowed (Home
    /// Assistant runs on the LAN), redirects never followed, never a
    /// link-local or unspecified address. Without TLS roots only `http://`
    /// hooks go.
    pub hooks: reqwest::Client,
    /// How long a hook call may take: 5 s; overridable for tests.
    pub hook_timeout: std::time::Duration,
    /// Host names served besides loopback ones (e.g. the HTTPS proxy's name).
    /// Requests naming any other host are refused: DNS rebinding defence.
    pub allowed_hosts: Vec<String>,
    /// The server's time zone: which local day a scale reading falls on.
    pub tz: jiff::tz::TimeZone,
    /// Where the backup job writes its copies (`--backup-dir`), for
    /// `/api/backups`; `None` when backups are off.
    pub backup_dir: Option<std::path::PathBuf>,
    /// One import at a time (a profile file, Cronometer, Google Health):
    /// each may hold 64 MiB and its parsed tree, and two don't fit the
    /// service's memory. Held until the import's work ends.
    pub imports: Arc<tokio::sync::Semaphore>,
    /// The database file's directory, for its disk's free space; `None`
    /// in memory.
    pub data_dir: Option<std::path::PathBuf>,
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
        let data_dir = conn
            .path()
            .filter(|p| !p.is_empty())
            .and_then(|p| Path::new(p).parent())
            .map(Path::to_path_buf);
        Self {
            db: Arc::new(Mutex::new(conn)),
            http,
            hooks: api::hook_client(),
            hook_timeout: api::HOOK_TIMEOUT,
            off_url,
            allowed_hosts: Vec::new(),
            tz: jiff::tz::TimeZone::UTC,
            backup_dir: None,
            imports: Arc::new(tokio::sync::Semaphore::new(1)),
            data_dir,
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
