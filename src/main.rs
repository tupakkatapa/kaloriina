use std::fs::File;
use std::io::IsTerminal;
use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;

use anyhow::Context;
use clap::{Parser, Subcommand};
use jiff::tz::TimeZone;
use kaloriina::{AppState, fineli, import, newest_backup, open, router};
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
        /// IANA time zone (e.g. Europe/Helsinki) that decides which day a
        /// scale reading falls on; read from the system's tz database.
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
}

/// A typo in --db must not import into a fresh, empty database.
fn existing(db: &std::path::Path, create: bool) -> anyhow::Result<()> {
    anyhow::ensure!(
        create || db.exists(),
        "{} does not exist; pass --create to start a new database",
        db.display()
    );
    Ok(())
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

/// WARN when the newest backup copy is over 48 hours old (or there is
/// none): the backup job failing is otherwise silent.
fn warn_on_old_backups(dir: &std::path::Path) {
    const STALE_MS: i64 = 48 * 60 * 60 * 1000;
    match newest_backup(dir) {
        Ok(Some(at)) if jiff::Timestamp::now().as_millisecond() - at <= STALE_MS => {}
        Ok(Some(at)) => tracing::warn!(
            dir = %dir.display(),
            newest = %jiff::Timestamp::from_millisecond(at).unwrap_or_default(),
            "the newest backup copy is over 48 hours old; check the backup job"
        ),
        Ok(None) => tracing::warn!(dir = %dir.display(), "no backup copy yet"),
        Err(e) => tracing::warn!(dir = %dir.display(), error = %e, "backup dir unreadable"),
    }
}

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
    let conn = open(&db).with_context(|| format!("opening {}", db.display()))?;
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
    axum::serve(listener, router(state))
        .with_graceful_shutdown(shutdown())
        .await?;
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
            existing(&db, create)?;
            let mut conn = open(&db).with_context(|| format!("opening {}", db.display()))?;
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
        } => {
            // Read the package first so a wrong path never creates a database.
            let foods = fineli::read(&dir).with_context(|| format!("reading {}", dir.display()))?;
            existing(&db, create)?;
            let mut conn = open(&db).with_context(|| format!("opening {}", db.display()))?;
            let added = fineli::store(&mut conn, &foods)?;
            println!("fineli: {} foods, {added} new", foods.len());
        }
    }
    Ok(())
}
