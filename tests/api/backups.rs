//! `/api/backups`: when the newest copy was taken, never where.

use super::*;
use kaloriina::{AppState, router};

fn app_backing_up_to(dir: Option<std::path::PathBuf>) -> Router {
    let mut state = AppState::new(open(FsPath::new(":memory:")).unwrap(), NO_OFF.to_owned());
    state.backup_dir = dir;
    router(state)
}

#[tokio::test]
async fn no_backup_dir_or_no_copy_is_null() {
    let (status, res) = call(&app_backing_up_to(None), "GET", "/api/backups", None).await;
    assert_eq!((status, res), (StatusCode::OK, json!({ "newest": null })));
    let dir = std::env::temp_dir().join(format!("kaloriina-backups-none-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("kaloriina-20261009T030000Z.db.tmp"), "half").unwrap();
    std::fs::write(dir.join("notes.txt"), "not a copy").unwrap();
    let app = app_backing_up_to(Some(dir.clone()));
    let (_, res) = call(&app, "GET", "/api/backups", None).await;
    assert_eq!(res, json!({ "newest": null }), "a .tmp is no copy");
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
    assert_eq!(res.as_object().unwrap().len(), 1, "{res}");
    assert!(!res.to_string().contains("kaloriina-"), "no path: {res}");
    std::fs::remove_dir_all(&dir).unwrap();
}
