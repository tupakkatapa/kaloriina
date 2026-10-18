use std::fs::File;
use std::io::IsTerminal;
use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;

use anyhow::Context;
use clap::{Parser, Subcommand};
use jiff::tz::TimeZone;
use kaloriina::model::{FeedbackStatus, feedback_markdown};
use kaloriina::{
    AppState, feedback_list, feedback_pull, fineli, google_health, import, newest_backup, open,
    router, stale_backup,
};
use tokio::signal::unix::{SignalKind, signal};

#[derive(Parser)]
#[command(version, about)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Serve the web app and JSON API.
    Serve {
        /// Database file, created if missing.
        #[arg(long, default_value = "kaloriina.db")]
        db: PathBuf,
        /// Address to listen on. There is no login: keep it on loopback and
        /// expose it only over HTTPS (see the README's Security section).
        #[arg(long, default_value = "127.0.0.1")]
        address: IpAddr,
        /// Port to listen on.
        #[arg(long, default_value_t = 8080)]
        port: u16,
        /// Open Food Facts base URL.
        #[arg(long, default_value = "https://world.openfoodfacts.org")]
        off_url: String,
        /// Host name the app is reached by besides localhost, e.g. the HTTPS
        /// proxy's name. Repeat for several. Other names get 421 (DNS
        /// rebinding defence).
        #[arg(long = "allowed-host")]
        allowed_hosts: Vec<String>,
        /// IANA time zone (e.g. Europe/London) for the server's "today":
        /// which day a scale reading falls on, and the latest day a sync may
        /// name; read from the system's tz database.
        /// Default: the system's (TZ, /etc/localtime), else UTC.
        #[arg(long)]
        time_zone: Option<String>,
        /// Directory the backup job writes its copies to: `/api/backups`
        /// tells when the newest was taken, and a start warns when it is over
        /// 48 hours old.
        #[arg(long)]
        backup_dir: Option<PathBuf>,
    },
    /// Import a Cronometer export (`servings.csv` and `dailysummary.csv`).
    /// Replaces imported data for every day in the files; your own entries
    /// are kept. Both files are written together or not at all.
    Import {
        /// Existing database file (see --create).
        #[arg(long, default_value = "kaloriina.db")]
        db: PathBuf,
        /// Start a new database if --db doesn't exist.
        #[arg(long)]
        create: bool,
        /// `servings.csv` (Food & Recipe Entries).
        #[arg(long)]
        servings: Option<PathBuf>,
        /// `dailysummary.csv` (Daily Nutrition).
        #[arg(long)]
        summary: Option<PathBuf>,
        /// Profile to import into; may be left out when there is only one.
        #[arg(long)]
        profile: Option<String>,
    },
    /// Fill a profile's activity gaps from a Google Takeout export with
    /// Google Health in it, extracted: workouts, each day's active energy,
    /// steps, heart rate and HRV, nights and naps. What is already there
    /// (synced or logged) stays; running it again adds nothing.
    ImportGoogleHealth(GoogleHealthArgs),
    /// Add the Fineli food database (THL, CC BY 4.0) to the shared foods.
    /// Re-running with a newer release updates those foods in place.
    Fineli {
        /// Existing database file (see --create).
        #[arg(long, default_value = "kaloriina.db")]
        db: PathBuf,
        /// Start a new database if --db doesn't exist.
        #[arg(long)]
        create: bool,
        /// List the package's food classes (kind, code, foods, category,
        /// name; tab-separated) instead of importing: what the class →
        /// category table is filled from. Touches no database.
        #[arg(long)]
        classes: bool,
        /// Unzipped Fineli open-data package (holding `food.csv`).
        dir: PathBuf,
    },
    /// Print the open feedback (Profile → Feedback) as Markdown.
    #[command(group(clap::ArgGroup::new("mode").required(true).args(["pull", "list"])))]
    Feedback {
        /// Existing database file.
        #[arg(long, default_value = "kaloriina.db")]
        db: PathBuf,
        /// Print it and mark it pulled: the next pull prints only what came
        /// since. Writes to the database.
        #[arg(long)]
        pull: bool,
        /// Print it, marking nothing; opens the database read-only.
        #[arg(long)]
        list: bool,
    },
}

/// A typo in --db must not import into a fresh, empty database. `create`
/// is the command's `--create`, `None` when it has none.
fn existing(db: &std::path::Path, create: Option<bool>) -> anyhow::Result<()> {
    match create {
        _ if db.exists() => Ok(()),
        Some(true) => Ok(()),
        Some(false) => anyhow::bail!(
            "{} does not exist; pass --create to start a new database",
            db.display()
        ),
        None => anyhow::bail!(
            "{} does not exist; check --db (default: kaloriina.db in the current folder)",
            db.display()
        ),
    }
}

/// The zone named, or the system's (UTC if it has none).
fn resolve_time_zone(name: Option<&str>) -> anyhow::Result<TimeZone> {
    let tz = match name {
        Some(name) => TimeZone::get(name).with_context(|| {
            format!("unknown time zone {name:?}: give an IANA name; the system's tz database (/etc/zoneinfo, TZDIR) must hold it")
        })?,
        None => TimeZone::try_system().unwrap_or(TimeZone::UTC),
    };
    tracing::info!(
        time_zone = tz.iana_name().unwrap_or("fixed offset"),
        "days follow"
    );
    Ok(tz)
}

/// Open (and migrate) `db`, then bring its derived data up to the rules
/// ([`kaloriina::derived_current`]): with `tz` the zoned families too (the
/// server's days), else they wait for the next `serve`. `configured`: `tz`
/// was named, not the system's (or UTC), which the log then says.
fn open_current(
    db: &std::path::Path,
    tz: Option<&TimeZone>,
    configured: bool,
) -> anyhow::Result<kaloriina::Connection> {
    let mut conn = open(db).with_context(|| format!("opening {}", db.display()))?;
    let ran = kaloriina::derived_current(&mut conn, tz, kaloriina::model::now_ms());
    let zoned = ["night_rule_version", "weight_rule_version"];
    if let Some(tz) = tz
        && !configured
        && zoned.iter().any(|k| ran.contains_key(k))
    {
        tracing::warn!(
            time_zone = tz.iana_name().unwrap_or("fixed offset"),
            "stored days follow the current rules in the system's zone (UTC without one): \
             no --time-zone given"
        );
    }
    Ok(conn)
}

#[derive(clap::Args)]
struct GoogleHealthArgs {
    /// Existing database file.
    #[arg(long, default_value = "kaloriina.db")]
    db: PathBuf,
    /// Profile to import into; may be left out when there is only one.
    #[arg(long)]
    profile: Option<String>,
    /// IANA time zone the days are counted in: the server's (`serve
    /// --time-zone`), so a sample falls on the day a browser import files
    /// it under.
    #[arg(long)]
    time_zone: String,
    /// The folders the Takeout export was extracted to (every part's, when
    /// it came in several).
    #[arg(required = true)]
    exports: Vec<PathBuf>,
}

/// `kaloriina import-google-health`: find the export's files first, so a
/// wrong path never opens the database.
fn import_google_health(a: &GoogleHealthArgs) -> anyhow::Result<()> {
    let tz = resolve_time_zone(Some(&a.time_zone))?;
    let files = google_health::files_at(&a.exports)?;
    existing(&a.db, None)?;
    let mut conn = open_current(&a.db, Some(&tz), true)?;
    let profile = import::profile_for(&conn, a.profile.as_deref())?;
    let c = google_health::import(&mut conn, profile, &files, &tz).context("importing")?;
    println!(
        "google health: {} days filled ({} nights), {} naps, {} workouts added, {} already there, {} rows kept raw, {} rows skipped",
        c.days, c.nights, c.naps, c.activities, c.kept, c.records, c.skipped
    );
    Ok(())
}

/// `kaloriina fineli`: read the package first, so a wrong path never
/// creates a database; then its foods and their ingredient classes.
fn fineli_import(db: &std::path::Path, create: bool, dir: &std::path::Path) -> anyhow::Result<()> {
    let reading = || format!("reading {}", dir.display());
    let foods = fineli::read(dir).with_context(reading)?;
    let classes = fineli::ingredient_classes(dir).with_context(reading)?;
    existing(db, Some(create))?;
    let mut conn = open_current(db, None, false)?;
    let added = fineli::store(&mut conn, &foods, &classes)?;
    println!("fineli: {} foods, {added} new", foods.len());
    Ok(())
}

/// `kaloriina feedback`: the open feedback as Markdown; `pull` then marks
/// what was printed pulled, else the database opens read-only.
fn feedback(db: &std::path::Path, pull: bool) -> anyhow::Result<()> {
    use std::io::Write;
    existing(db, None)?;
    let what = || format!("opening {}", db.display());
    let mut conn = if pull {
        open_current(db, None, false)?
    } else {
        let conn =
            kaloriina::Connection::open_with_flags(db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
                .with_context(what)?;
        // Read-only, so not upgraded here.
        let known: bool = conn.query_row(
            "SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE name = 'feedback')",
            [],
            |r| r.get(0),
        )?;
        anyhow::ensure!(
            known,
            "{} predates feedback: start `kaloriina serve` on it once to upgrade it",
            db.display()
        );
        conn
    };
    let items = feedback_list(&conn, Some(FeedbackStatus::Open))?;
    let mut out = std::io::stdout().lock();
    out.write_all(feedback_markdown(&items).as_bytes())
        .and_then(|()| out.flush())
        .context("printing the feedback; none was marked pulled")?;
    if pull {
        let ids: Vec<i64> = items.iter().map(|f| f.id).collect();
        feedback_pull(&mut conn, &ids)?;
    }
    Ok(())
}

/// WARN when the newest backup copy is over 48 hours old (or there is
/// none): the backup job failing is otherwise silent.
fn warn_on_old_backups(dir: &std::path::Path) {
    match newest_backup(dir) {
        Ok(Some(at)) if !stale_backup(Some(at), jiff::Timestamp::now().as_millisecond()) => {}
        Ok(Some(at)) => tracing::warn!(
            dir = %dir.display(),
            newest = %jiff::Timestamp::from_millisecond(at).unwrap_or_default(),
            "the newest backup copy is over 48 hours old; check the backup job"
        ),
        Ok(None) => tracing::warn!(dir = %dir.display(), "no backup copy yet"),
        Err(e) => tracing::warn!(dir = %dir.display(), error = %e, "backup dir unreadable"),
    }
}

/// How long a stop waits for open requests before it drops them (`SQLite`
/// rolls back what they hadn't committed).
const DRAIN_MAX: std::time::Duration = std::time::Duration::from_secs(10);

/// Resolve on Ctrl-C or SIGTERM (systemd stop), letting requests finish.
async fn shutdown() {
    let mut term = signal(SignalKind::terminate()).expect("SIGTERM handler installs");
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {}
        _ = term.recv() => {}
    }
    tracing::info!("shutting down");
}

/// `kaloriina serve`: open (and migrate) the database, then answer until
/// stopped.
async fn serve(
    db: PathBuf,
    address: IpAddr,
    port: u16,
    off_url: String,
    allowed_hosts: Vec<String>,
    time_zone: Option<String>,
    backup_dir: Option<PathBuf>,
) -> anyhow::Result<()> {
    // Before the database: a typo must not migrate or create one.
    let tz = resolve_time_zone(time_zone.as_deref())?;
    let conn = open_current(&db, Some(&tz), time_zone.is_some())?;
    let addr = SocketAddr::new(address, port);
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .with_context(|| format!("binding {addr}"))?;
    tracing::info!(%addr, db = %db.display(), "listening");
    let mut state = AppState::new(conn, off_url);
    state.allowed_hosts = allowed_hosts;
    state.tz = tz;
    if let Some(dir) = &backup_dir {
        warn_on_old_backups(dir);
    }
    state.backup_dir = backup_dir;
    let stopping = std::sync::Arc::new(tokio::sync::Notify::new());
    let server = axum::serve(listener, router(state)).with_graceful_shutdown({
        let stopping = stopping.clone();
        async move {
            shutdown().await;
            stopping.notify_one();
        }
    });
    // A stalled upload must not hold a deploy: the drain has a deadline.
    tokio::select! {
        result = std::future::IntoFuture::into_future(server) => result?,
        () = async {
            stopping.notified().await;
            tokio::time::sleep(DRAIN_MAX).await;
        } => tracing::warn!("requests still open {DRAIN_MAX:?} after the stop; dropping them"),
    }
    Ok(())
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Logs go to stderr (stdout carries command output), coloured only on a
    // terminal so the journal stays plain text.
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .with_writer(std::io::stderr)
        .with_ansi(std::io::stderr().is_terminal())
        .init();

    match Cli::parse().command {
        Command::Serve {
            db,
            address,
            port,
            off_url,
            allowed_hosts,
            time_zone,
            backup_dir,
        } => {
            serve(
                db,
                address,
                port,
                off_url,
                allowed_hosts,
                time_zone,
                backup_dir,
            )
            .await?;
        }
        Command::Import {
            db,
            create,
            servings,
            summary,
            profile,
        } => {
            anyhow::ensure!(
                servings.is_some() || summary.is_some(),
                "give --servings and/or --summary"
            );
            // Open inputs first so a typo never creates an empty database.
            let input = |path: Option<PathBuf>| {
                path.map(|p| {
                    File::open(&p)
                        .map(|f| (p.clone(), f))
                        .with_context(|| format!("opening {}", p.display()))
                })
                .transpose()
            };
            let (servings, summary) = (input(servings)?, input(summary)?);
            existing(&db, Some(create))?;
            let mut conn = open_current(&db, None, false)?;
            let profile = import::profile_for(&conn, profile.as_deref())?;
            let has_servings = servings.is_some();
            let report = import::import(
                &mut conn,
                profile,
                servings.map(|(_, f)| f),
                summary.map(|(_, f)| f),
            )
            .context("importing; nothing was written")?;
            if has_servings {
                println!("servings: {} entries", report.entries);
            }
            if let Some(r) = report.summary {
                println!("summary: {} days, {} group totals", r.days, r.groups);
                if !r.mismatched_days.is_empty() {
                    eprintln!(
                        "warning: group totals differ from the export's Total on: {}",
                        r.mismatched_days.join(", ")
                    );
                }
            }
        }
        Command::ImportGoogleHealth(args) => import_google_health(&args)?,
        Command::Fineli {
            classes: true, dir, ..
        } => {
            for c in fineli::classes(&dir).with_context(|| format!("reading {}", dir.display()))? {
                println!(
                    "{}\t{}\t{}\t{}\t{}",
                    c.kind,
                    c.code,
                    c.foods,
                    c.category.map_or("-", |c| c.as_str()),
                    c.name.as_deref().unwrap_or("")
                );
            }
        }
        Command::Fineli {
            db, create, dir, ..
        } => fineli_import(&db, create, &dir)?,
        Command::Feedback { db, pull, .. } => feedback(&db, pull)?,
    }
    Ok(())
}
