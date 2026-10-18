//! The CLI as an operator runs it.

use std::path::Path;
use std::process::Command;

fn kaloriina(args: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_kaloriina"))
        .args(args)
        .output()
        .expect("binary runs")
}

#[test]
fn importers_refuse_to_create_a_database_by_typo() {
    let dir = std::env::temp_dir().join(format!("kaloriina-cli-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let db = dir.join("kaloriana.db");
    let fineli = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fineli");
    let (db_arg, fineli_arg) = (db.to_str().unwrap(), fineli.to_str().unwrap());

    let out = kaloriina(&["fineli", "--db", db_arg, fineli_arg]);
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("--create"));
    assert!(!db.exists(), "no empty database left behind");

    let out = kaloriina(&["fineli", "--db", db_arg, "--create", fineli_arg]);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(
        String::from_utf8_lossy(&out.stdout).trim(),
        "fineli: 4 foods, 4 new"
    );
    // Each with its ingredient class, for All time's beef and potatoes.
    let class: String = kaloriina::open(&db)
        .unwrap()
        .query_row(
            "SELECT fineli_class FROM food WHERE fineli_id = 101",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(class, "SAUSAGE");
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn serve_refuses_an_unknown_time_zone_before_touching_the_database() {
    let dir = std::env::temp_dir().join(format!("kaloriina-tz-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let db = dir.join("kaloriina.db");
    let out = kaloriina(&[
        "serve",
        "--db",
        db.to_str().unwrap(),
        "--port",
        "0",
        "--time-zone",
        "Atlantis/Lost",
    ]);
    assert!(!out.status.success());
    assert!(
        String::from_utf8_lossy(&out.stderr).contains("unknown time zone \"Atlantis/Lost\""),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(!db.exists(), "no database created");
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn import_needs_a_profile_name_when_there_are_several() {
    let dir = std::env::temp_dir().join(format!("kaloriina-profiles-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let db = dir.join("kaloriina.db");
    let conn = kaloriina::open(&db).unwrap();
    conn.execute("INSERT INTO profile (name) VALUES ('B')", [])
        .unwrap();
    let b: i64 = conn
        .query_row("SELECT id FROM profile WHERE name = 'B'", [], |r| r.get(0))
        .unwrap();
    let servings = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/servings.csv");
    let import = |profile: Option<&str>| {
        let mut args = vec![
            "import",
            "--db",
            db.to_str().unwrap(),
            "--servings",
            servings.to_str().unwrap(),
        ];
        args.extend(profile.iter().flat_map(|p| ["--profile", p]));
        kaloriina(&args)
    };
    let entries = |profile: i64| -> i64 {
        conn.query_row(
            "SELECT count(*) FROM entry WHERE profile_id = ?",
            [profile],
            |r| r.get(0),
        )
        .unwrap()
    };

    let out = import(None);
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(!out.status.success());
    assert!(
        ["--profile", "\"Me\"", "\"B\""]
            .iter()
            .all(|s| stderr.contains(s)),
        "{stderr}"
    );
    assert_eq!(entries(1) + entries(b), 0, "nothing imported");

    let out = import(Some("B"));
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(entries(b) > 0, "the entries land in B");
    assert_eq!(entries(1), 0, "and not in Me");
    drop(conn);
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn fineli_classes_lists_the_packages_classes_and_touches_no_database() {
    // What the owner runs on their copy to fill the class table.
    let fineli = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fineli");
    let dir = std::env::temp_dir().join(format!("kaloriina-classes-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let db = dir.join("kaloriina.db");
    let out = kaloriina(&[
        "fineli",
        "--classes",
        "--db",
        db.to_str().unwrap(),
        fineli.to_str().unwrap(),
    ]);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(
        String::from_utf8_lossy(&out.stdout),
        "FUCLASS\tDRINKSO\t1\tsugary_drinks\t\nFUCLASS\tMEATDISH\t1\t-\t\nFUCLASS\tMILK\t1\t-\t\nFUCLASS\tSAUSAGE\t1\tprocessed_meat\t\nIGCLASS\tMILKNONF\t1\t-\t\nIGCLASS\tMIXMEAT\t1\t-\t\nIGCLASS\tSAUSAGE\t1\tprocessed_meat\t\nIGCLASS\tSDRINK\t1\tsugary_drinks\t\n"
    );
    assert!(!db.exists());
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn feedback_pull_prints_markdown_once_and_list_reads_only() {
    let dir = std::env::temp_dir().join(format!("kaloriina-feedback-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let db = dir.join("kaloriina.db");
    let conn = kaloriina::open(&db).unwrap();
    conn.execute_batch(
        "INSERT INTO feedback (kind, text, created_at) VALUES
             ('bug', 'The scale row wraps.', '2026-10-12T08:00:00Z'),
             ('feature', 'Photos of meals', '2026-10-12T09:00:00Z');",
    )
    .unwrap();
    drop(conn);
    let db_arg = db.to_str().unwrap();
    let run = |args: &[&str]| {
        let out = kaloriina(args);
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8(out.stdout).unwrap()
    };
    let expected = "## Bug #1 · 2026-10-12T08:00:00Z\n\n> The scale row wraps.\n\n\
                    ## Idea #2 · 2026-10-12T09:00:00Z\n\n> Photos of meals\n\n";
    assert_eq!(run(&["feedback", "--list", "--db", db_arg]), expected);
    assert_eq!(
        run(&["feedback", "--list", "--db", db_arg]),
        expected,
        "list marks nothing"
    );
    assert_eq!(run(&["feedback", "--pull", "--db", db_arg]), expected);
    assert_eq!(
        run(&["feedback", "--pull", "--db", db_arg]),
        "",
        "pulled once"
    );
    assert_eq!(run(&["feedback", "--list", "--db", db_arg]), "");
    std::fs::remove_dir_all(&dir).unwrap();
}

fn temp(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("kaloriina-{name}-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn stderr(out: &std::process::Output) -> String {
    String::from_utf8_lossy(&out.stderr).into_owned()
}

#[test]
fn cli_folder_only_and_tz_required() {
    let dir = temp("gh-cli");
    let db = dir.join("kaloriina.db");
    drop(kaloriina::open(&db).unwrap());
    // Two extracted parts of one export.
    let (one, two) = (dir.join("takeout-1"), dir.join("takeout-2"));
    for (part, rows) in [
        (&one, "2026-09-02T10:00:00Z,300,x\n"),
        (&two, "2026-09-03T10:00:00Z,40,x\n"),
    ] {
        let at = part.join("Takeout/Google Health/Steps");
        std::fs::create_dir_all(&at).unwrap();
        let name = if part == &one {
            "steps_2026-09-01.csv"
        } else {
            "steps_2026-09-02.csv"
        };
        std::fs::write(
            at.join(name),
            format!("timestamp,steps,data source\n{rows}"),
        )
        .unwrap();
    }
    let zip = dir.join("takeout.zip");
    std::fs::write(&zip, "PK").unwrap();
    let (db_arg, one_arg, two_arg) = (
        db.to_str().unwrap(),
        one.to_str().unwrap(),
        two.to_str().unwrap(),
    );

    let out = kaloriina(&["import-google-health", "--db", db_arg, one_arg]);
    assert!(!out.status.success());
    assert!(stderr(&out).contains("--time-zone"), "{}", stderr(&out));
    let out = kaloriina(&[
        "import-google-health",
        "--db",
        db_arg,
        "--time-zone",
        "UTC",
        zip.to_str().unwrap(),
    ]);
    assert!(!out.status.success());
    assert!(stderr(&out).contains("not a folder"), "{}", stderr(&out));

    let out = kaloriina(&[
        "import-google-health",
        "--db",
        db_arg,
        "--time-zone",
        "UTC",
        one_arg,
        two_arg,
    ]);
    assert!(out.status.success(), "{}", stderr(&out));
    assert!(
        String::from_utf8_lossy(&out.stdout).contains("2 days filled"),
        "{}",
        String::from_utf8_lossy(&out.stdout)
    );
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn cli_hint_names_no_create_flag() {
    // Only the commands with --create suggest it.
    let dir = temp("hint");
    let db = dir.join("typo.db");
    let db_arg = db.to_str().unwrap();
    for args in [
        vec!["feedback", "--list", "--db", db_arg],
        vec![
            "import-google-health",
            "--db",
            db_arg,
            "--time-zone",
            "UTC",
            dir.to_str().unwrap(),
        ],
    ] {
        let out = kaloriina(&args);
        assert!(!out.status.success());
        let err = stderr(&out);
        assert!(
            err.contains("does not exist") && err.contains("--db"),
            "{err}"
        );
        assert!(!err.contains("--create"), "{err}");
    }
    assert!(!db.exists());
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn feedback_list_on_old_db_says_serve_once() {
    // A database the new server hasn't started on yet: read-only, so not
    // upgraded.
    let dir = temp("old-db");
    let db = dir.join("kaloriina.db");
    let conn = kaloriina::Connection::open(&db).unwrap();
    conn.execute_batch("CREATE TABLE food (id INTEGER PRIMARY KEY); PRAGMA user_version = 40;")
        .unwrap();
    drop(conn);
    let out = kaloriina(&["feedback", "--list", "--db", db.to_str().unwrap()]);
    assert!(!out.status.success());
    assert!(stderr(&out).contains("kaloriina serve"), "{}", stderr(&out));
    assert!(!stderr(&out).contains("no such table"), "{}", stderr(&out));
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn pull_marks_only_printed_ids() {
    // stdout closed before anything is printed (`| head -c0`, a dropped SSH
    // session): nothing is marked pulled.
    let dir = temp("pull-pipe");
    let db = dir.join("kaloriina.db");
    let conn = kaloriina::open(&db).unwrap();
    conn.execute(
        "INSERT INTO feedback (kind, text) VALUES ('bug', 'Wraps')",
        [],
    )
    .unwrap();
    let (reader, writer) = std::io::pipe().unwrap();
    drop(reader);
    let out = Command::new(env!("CARGO_BIN_EXE_kaloriina"))
        .args(["feedback", "--pull", "--db", db.to_str().unwrap()])
        .stdout(writer)
        .output()
        .unwrap();
    assert!(!out.status.success());
    let open: i64 = conn
        .query_row(
            "SELECT count(*) FROM feedback WHERE status = 'open'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(open, 1, "{}", stderr(&out));
    drop(conn);
    std::fs::remove_dir_all(&dir).unwrap();
}

/// A command runs the derived families that need no zone; nights
/// and weights wait for `serve`, which has the server's.
#[test]
fn a_command_leaves_nights_and_weights_to_serve() {
    let dir = temp("derived");
    let db = dir.join("kaloriina.db");
    let fineli = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fineli");
    let out = kaloriina(&[
        "fineli",
        "--db",
        db.to_str().unwrap(),
        "--create",
        fineli.to_str().unwrap(),
    ]);
    assert!(out.status.success(), "{}", stderr(&out));
    let stamped = |key: &str| -> Option<i64> {
        let conn =
            kaloriina::Connection::open_with_flags(&db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
                .unwrap();
        conn.query_row("SELECT value FROM meta WHERE key = ?", [key], |r| r.get(0))
            .ok()
    };
    assert_eq!(stamped("resting_rule_version"), Some(1));
    assert_eq!(stamped("night_rule_version"), None);
    assert_eq!(stamped("weight_rule_version"), None);
    let mut serve = Command::new(env!("CARGO_BIN_EXE_kaloriina"))
        .args(["serve", "--db", db.to_str().unwrap(), "--port", "0"])
        .args(["--time-zone", "Europe/Helsinki"])
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();
    let started = std::time::Instant::now();
    while stamped("weight_rule_version").is_none()
        && started.elapsed() < std::time::Duration::from_secs(20)
    {
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    serve.kill().unwrap();
    serve.wait().unwrap();
    assert!(stamped("night_rule_version").is_some());
    assert!(stamped("weight_rule_version").is_some());
    std::fs::remove_dir_all(&dir).unwrap();
}
