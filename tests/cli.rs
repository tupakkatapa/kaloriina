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
        "fineli: 1 foods, 1 new"
    );
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
        "FUCLASS\tMILK\t1\t-\t\nIGCLASS\tMILKNONF\t1\t-\t\n"
    );
    assert!(!db.exists());
    std::fs::remove_dir_all(&dir).unwrap();
}
