//! `/api/backups`: when the newest copy was taken, never where.

use super::*;
use kaloriina::{AppState, router};

fn app_backing_up_to(dir: Option<std::path::PathBuf>) -> Router {
    let mut state = AppState::new(open(FsPath::new(":memory:")).unwrap(), NO_OFF.to_owned());
    state.backup_dir = dir;
    router(state)
}

#[tokio::test]
async fn no_backup_dir_is_unconfigured() {
    let (status, res) = call(&app_backing_up_to(None), "GET", "/api/backups", None).await;
    assert_eq!(
        (status, res),
        (
            StatusCode::OK,
            json!({ "configured": false, "newest": null, "stale": false,
                    "free_bytes": null, "total_bytes": null })
        )
    );
}

#[tokio::test]
async fn a_backup_dir_without_a_copy_is_stale() {
    // The job has never succeeded: the app says so, not just the journal.
    let dir = std::env::temp_dir().join(format!("kaloriina-backups-none-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("kaloriina-20261009T030000Z.db.tmp"), "half").unwrap();
    std::fs::write(dir.join("notes.txt"), "not a copy").unwrap();
    let app = app_backing_up_to(Some(dir.clone()));
    let (_, res) = call(&app, "GET", "/api/backups", None).await;
    assert_eq!(
        (&res["configured"], &res["newest"], &res["stale"]),
        (&json!(true), &Value::Null, &json!(true)),
        "a .tmp is no copy: {res}"
    );
    std::fs::remove_dir_all(&dir).unwrap();
}

#[tokio::test]
async fn free_space_is_the_database_disk_s() {
    let dir = std::env::temp_dir().join(format!("kaloriina-backups-disk-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let mut state = AppState::new(open(&dir.join("db")).unwrap(), NO_OFF.to_owned());
    state.backup_dir = Some(dir.clone());
    let (_, res) = call(&router(state), "GET", "/api/backups", None).await;
    let (free, total) = (
        res["free_bytes"].as_u64().unwrap(),
        res["total_bytes"].as_u64().unwrap(),
    );
    assert!(0 < free && free <= total, "{res}");
    std::fs::remove_dir_all(&dir).unwrap();
}

#[tokio::test]
async fn a_copy_gives_its_time_and_no_path() {
    let dir = std::env::temp_dir().join(format!("kaloriina-backups-one-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("kaloriina-20261009T030000Z.db");
    std::fs::write(&file, "copy").unwrap();
    let written = std::fs::metadata(&file)
        .unwrap()
        .modified()
        .unwrap()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis();
    let app = app_backing_up_to(Some(dir.clone()));
    let (status, res) = call(&app, "GET", "/api/backups", None).await;
    assert_eq!(status, StatusCode::OK, "{res}");
    assert_eq!(res["newest"].as_u64().map(u128::from), Some(written));
    assert_eq!(res["stale"], false, "{res}");
    assert!(!res.to_string().contains("kaloriina-"), "no path: {res}");
    std::fs::remove_dir_all(&dir).unwrap();
}

#[tokio::test]
async fn a_copy_over_48_hours_old_is_stale() {
    // Judged on each request: a server up for weeks still notices.
    let dir = std::env::temp_dir().join(format!("kaloriina-backups-old-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let file = std::fs::File::create(dir.join("kaloriina-20261001T030000Z.db")).unwrap();
    let old = std::time::SystemTime::now() - std::time::Duration::from_hours(49);
    file.set_modified(old).unwrap();
    let (_, res) = call(
        &app_backing_up_to(Some(dir.clone())),
        "GET",
        "/api/backups",
        None,
    )
    .await;
    assert_eq!(res["stale"], true, "{res}");
    std::fs::remove_dir_all(&dir).unwrap();
}

#[tokio::test]
async fn a_compressed_copy_counts() {
    let dir = std::env::temp_dir().join(format!("kaloriina-backups-zst-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("kaloriina-20261009T030000Z.db.zst.tmp"), "half").unwrap();
    std::fs::write(dir.join("kaloriina-20261009T030000Z.db.zst"), "zstd").unwrap();
    let (_, res) = call(
        &app_backing_up_to(Some(dir.clone())),
        "GET",
        "/api/backups",
        None,
    )
    .await;
    assert_eq!(
        (&res["newest"].is_i64(), &res["stale"]),
        (&true, &json!(false)),
        "{res}"
    );
    std::fs::remove_dir_all(&dir).unwrap();
}
