//! A Google Health export filling the profile's gaps: what Health Connect
//! synced and what was logged by hand stays; again adds nothing. Synthetic
//! files in the export's shape; days in September 2026, the app's zone UTC.

use super::*;

const IMPORT: &str = "/api/profiles/1/import/google-health";

fn file(name: &str, header: &str, rows: &[&str]) -> Value {
    json!({ "name": format!("Takeout/Google Health/{name}"),
            "text": format!("{header}\n{}\n", rows.join("\n")) })
}

fn exercises(rows: &[&str]) -> Value {
    file(
        "Health Fitness Data_GoogleData/UserExercises_2026-05-31.csv",
        "exercise_id,exercise_start,exercise_end,utc_offset,activity_name,log_type,\
         deletion_reason,manually_logged_total_calories,tracker_total_calories,\
         manually_logged_total_distance_mm,tracker_total_distance_mm",
        rows,
    )
}

/// One night of 2026-09-05/06 (wake day the 6th) and one ending the 3rd.
fn sleep() -> [Value; 2] {
    [
        file(
            "Health Fitness Data_GoogleData/UserSleeps_2026-05-31.csv",
            "sleep_id,sleep_type,sleep_start,sleep_end,start_utc_offset,end_utc_offset,\
             data_source,algorithm_version",
            &[
                "1,STAGES,2026-09-02T22:00:00Z,2026-09-03T06:00:00Z,+03:00,+03:00,DERIVED,sleep_session_v2",
                "2,STAGES,2026-09-05T21:00:00Z,2026-09-06T05:00:00Z,+03:00,+03:00,DERIVED,sleep_session_v2",
            ],
        ),
        file(
            "Health Fitness Data_GoogleData/UserSleepStages_2026-05-31.csv",
            "sleep_id,sleep_stage_id,sleep_stage_type,sleep_stage_start,sleep_stage_end",
            &["2,9,AWAKE,2026-09-05T21:00:00Z,2026-09-05T21:20:00Z"],
        ),
    ]
}

fn series() -> [Value; 4] {
    [
        file(
            "Physical Activity_GoogleData/Steps/steps_2026-09-01.csv",
            "timestamp,steps,data source",
            &[
                "2026-09-02T10:00:00Z,300,Google Fitbit Air",
                "2026-09-06T10:00:00Z,500,Phone Health Connect",
                "2026-09-06T10:00:02.5Z,500,Phone Health Connect",
                "2026-09-06T10:01:00Z,800,Google Fitbit Air",
            ],
        ),
        file(
            "Physical Activity_GoogleData/Active Energy Burned/active_energy_burned_2026-09-01.csv",
            "timestamp,Kilocalories,data source",
            &[
                "2026-09-02T10:00:00Z,1.5,Google Health App",
                "2026-09-02T10:01:00Z,2.6,Google Health App",
            ],
        ),
        file(
            "Physical Activity_GoogleData/Daily Resting Heart Rate/daily_resting_heart_rate.csv",
            "timestamp,beats per minute,data source",
            &["2026-09-02T00:00:00Z,56.6,Google Health App"],
        ),
        file(
            "Physical Activity_GoogleData/Daily Heart Rate Variability/daily_heart_rate_variability.csv",
            "timestamp,average heart rate variability milliseconds,data source",
            &["2026-09-03T00:00:00Z,64.7,Google Health App"],
        ),
    ]
}

fn workouts() -> Value {
    exercises(&[
        // Health Connect's run, a few minutes off: already there.
        "101,2026-09-02T14:05:00Z,2026-09-02T14:50:00Z,+03:00,Outdoor Run,TRACKER,UNSPECIFIED,,410,,8100000",
        // The hand log's session, typed differently: already there.
        "102,2026-09-04T17:05:00Z,2026-09-04T17:45:00Z,+03:00,Calisthenics,MANUAL,UNSPECIFIED,240,,,",
        // New.
        "103,2026-09-05T07:00:00Z,2026-09-05T07:30:00Z,+03:00,Outdoor Walk,MANUAL,UNSPECIFIED,120,,2400000,",
        // Deleted, and too short.
        "104,2026-09-05T09:00:00Z,2026-09-05T09:30:00Z,+03:00,Zumba,AUTO_DETECTED,USER_DELETED,,,,",
        "105,2026-09-05T10:00:00Z,2026-09-05T10:00:40Z,+03:00,Activity,AUTO_DETECTED,,,,,",
    ])
}

fn export(files: &[Value]) -> Value {
    json!({ "files": files })
}

fn everything() -> Value {
    let mut files = vec![workouts()];
    files.extend(sleep());
    files.extend(series());
    export(&files)
}

async fn import(app: &Router, body: Value) -> Value {
    let (status, res) = call(app, "POST", IMPORT, Some(body)).await;
    assert_eq!(status, StatusCode::OK, "{res}");
    res
}

async fn get(app: &Router, path: &str) -> Value {
    let (status, res) = call(app, "GET", path, None).await;
    assert_eq!(status, StatusCode::OK, "{res}");
    res
}

/// Health Connect's 2026-09-02 (steps, a run) and 2026-09-03 (a night),
/// and a timed hand log on 2026-09-04.
async fn synced_and_logged(app: &Router) {
    // The night's raw session (the phone posts its pages first): 00:30–07:30,
    // the first 20 minutes awake.
    hc_records(
        app,
        1,
        json!([hc_sleep(
            "s-3",
            "2026-09-03T00:30:00Z",
            "2026-09-03T07:30:00Z",
            &[("2026-09-03T00:30:00Z", "2026-09-03T00:50:00Z", 1)]
        )]),
    )
    .await;
    let (status, res) = call(
        app,
        "POST",
        "/api/profiles/1/sync/health",
        Some(
            json!({ "from": "2026-09-01", "to": "2026-09-07", "device": "Pixel 9",
            "days": [{ "day": "2026-09-02", "steps": 8000 }],
            "sessions": [{ "key": "hc-1", "day": "2026-09-02",
                "start_at": "2026-09-02T14:02:00Z", "end_at": "2026-09-02T14:48:00Z",
                "type": 33, "name": "Running", "recording_method": 1 }] }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{res}");
    let (status, res) = call(
        app,
        "POST",
        "/api/profiles/1/activities",
        Some(
            json!({ "day": "2026-09-04", "name": "Push day", "minutes": 40,
            "start_at": "2026-09-04T17:00:00Z" }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{res}");
}

#[tokio::test]
async fn an_export_fills_gaps_and_again_adds_nothing() {
    let app = app();
    synced_and_logged(&app).await;
    let before = get(
        &app,
        "/api/profiles/1/device-days?from=2026-09-01&to=2026-09-07",
    )
    .await;

    assert_eq!(
        import(&app, everything()).await,
        json!({ "days": 3, "nights": 1, "naps": 0, "activities": 1, "kept": 2, "records": 10,
                "skipped": 0 })
    );
    let after = get(
        &app,
        "/api/profiles/1/device-days?from=2026-09-01&to=2026-09-07",
    )
    .await;
    let days = after["days"].as_array().unwrap();
    let day = |d: &str| days.iter().find(|x| x["day"] == d).unwrap().clone();
    // 09-02: Health Connect's steps stay; energy and heart fill in.
    assert_eq!(
        (
            &day("2026-09-02")["steps"],
            &day("2026-09-02")["active_kcal"],
            &day("2026-09-02")["resting_hr"]
        ),
        (&json!(8000), &json!(4), &json!(57))
    );
    // 09-03: the synced night stays (not the export's), HRV fills in.
    assert_eq!(
        (
            &day("2026-09-03")["in_bed_min"],
            &day("2026-09-03")["bedtime"],
            &day("2026-09-03")["hrv_ms"]
        ),
        (&json!(420), &json!("00:30"), &json!(65))
    );
    // 09-06: new, the device that counted most and the night in local time.
    let new = day("2026-09-06");
    assert_eq!(
        (
            &new["steps"],
            &new["in_bed_min"],
            &new["asleep_min"],
            &new["bedtime"],
            &new["wake_time"]
        ),
        (
            &json!(1000),
            &json!(480),
            &json!(460),
            &json!("00:00"),
            &json!("08:00")
        )
    );
    // The raw device copy is untouched.
    assert_eq!(after["sessions"], before["sessions"]);

    let sessions = get(&app, "/api/profiles/1/activities").await;
    let walk = sessions
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["source_key"] == "gh-103")
        .unwrap();
    assert_eq!(
        (
            &walk["day"],
            &walk["type"],
            &walk["minutes"],
            &walk["kcal"],
            &walk["distance_m"],
            &walk["source"],
            &walk["start_at"]
        ),
        (
            &json!("2026-09-05"),
            &json!("walk"),
            &json!(30),
            &json!(120),
            &json!(2400),
            &json!("import"),
            &json!("2026-09-05T07:00:00Z")
        )
    );
    assert_eq!(sessions.as_array().unwrap().len(), 3);

    // Again: nothing changes.
    assert_eq!(
        import(&app, everything()).await,
        json!({ "days": 0, "nights": 0, "naps": 0, "activities": 0, "kept": 3, "records": 0,
                "skipped": 0 })
    );
    assert_eq!(
        get(
            &app,
            "/api/profiles/1/device-days?from=2026-09-01&to=2026-09-07"
        )
        .await,
        after
    );
    assert_eq!(get(&app, "/api/profiles/1/activities").await, sessions);
}

#[tokio::test]
async fn an_imported_workout_outlives_syncs_and_stays_deleted() {
    let app = app();
    import(&app, export(&[workouts()])).await;
    let walk = || async {
        get(&app, "/api/profiles/1/activities")
            .await
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["name"] == "Outdoor Walk")
            .cloned()
    };
    // The same phone syncs its day twice: the walk keeps its key.
    for _ in 0..2 {
        let (status, res) = call(
            &app,
            "POST",
            "/api/profiles/1/sync/health",
            Some(json!({ "from": "2026-09-01", "to": "2026-09-07", "device": "Pixel 9" })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{res}");
    }
    let kept = walk().await.unwrap();
    assert_eq!(kept["source_key"], "gh-103");

    // Deleted, it stays deleted.
    let (status, _) = call(
        &app,
        "DELETE",
        &format!("/api/profiles/1/activities/{}", kept["id"]),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(import(&app, export(&[workouts()])).await["kept"], 3);
    assert!(walk().await.is_none());
}

#[tokio::test]
async fn an_export_without_its_files_is_refused() {
    let app = app();
    for (body, says) in [
        (export(&[]), "Google Health data found"),
        (
            export(&[json!({ "name": "Takeout/Fit/x.json", "text": "{}" })]),
            "Google Health data found",
        ),
        (
            export(&[file("UserExercises_2026-05-31.csv", "exercise_id", &["1"])]),
            "UserExercises_2026-05-31.csv: no exercise_start column",
        ),
    ] {
        let (status, res) = call(&app, "POST", IMPORT, Some(body)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{res}");
        assert_eq!(res["field"], "files");
        assert!(res["error"].as_str().unwrap().contains(says), "{res}");
    }
    let (status, _) = call(
        &app,
        "POST",
        "/api/profiles/9/import/google-health",
        Some(everything()),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn a_synced_copy_whole_hours_off_is_the_same_walk() {
    let app = app();
    let (status, res) = call(
        &app,
        "POST",
        "/api/profiles/1/sync/health",
        Some(
            json!({ "from": "2026-09-06", "to": "2026-09-06", "device": "Pixel 9",
            "sessions": [{ "key": "hc-w", "day": "2026-09-06",
                "start_at": "2026-09-06T10:00:00.4Z", "end_at": "2026-09-06T10:28:00Z",
                "type": 53, "name": "Walking", "recording_method": 1 }] }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{res}");
    let counts = import(
        &app,
        export(&[exercises(&[
            // An hour earlier, as long: the synced copy's clock slipped.
            "201,2026-09-06T09:00:00Z,2026-09-06T09:28:00Z,+03:00,Outdoor Walk,AUTO_DETECTED,,,,,",
            // Not whole hours apart, or not a walk: workouts of their own.
            "202,2026-09-06T07:30:00Z,2026-09-06T07:58:00Z,+03:00,Outdoor Walk,AUTO_DETECTED,,,,,",
            "203,2026-09-06T11:00:00Z,2026-09-06T11:28:00Z,+03:00,Outdoor Run,TRACKER,,,,,",
        ])]),
    )
    .await;
    assert_eq!(
        (&counts["activities"], &counts["kept"]),
        (&json!(2), &json!(1))
    );
}

#[tokio::test]
async fn a_sync_without_a_value_keeps_the_imported_one() {
    let app = app();
    import(&app, export(&series())).await;
    let sync = |days: Value| {
        let app = app.clone();
        async move {
            let (status, res) = call(
                &app,
                "POST",
                "/api/profiles/1/sync/health",
                Some(
                    json!({ "from": "2026-09-01", "to": "2026-09-07", "device": "Pixel 9",
                    "days": days }),
                ),
            )
            .await;
            assert_eq!(status, StatusCode::OK, "{res}");
        }
    };
    let day = |d: &'static str| {
        let app = app.clone();
        async move {
            get(
                &app,
                "/api/profiles/1/device-days?from=2026-09-01&to=2026-09-07",
            )
            .await["days"]
                .as_array()
                .unwrap()
                .iter()
                .find(|x| x["day"] == d)
                .cloned()
        }
    };
    // Health Connect has steps but no energy on 09-02, and nothing on 09-06.
    sync(json!([{ "day": "2026-09-02", "steps": 8000, "active_kcal": null }])).await;
    let d = day("2026-09-02").await.unwrap();
    assert_eq!(
        (&d["steps"], &d["active_kcal"], &d["resting_hr"]),
        (&json!(8000), &json!(4), &json!(57))
    );
    assert_eq!(day("2026-09-06").await.unwrap()["steps"], 1000);
    // A value of its own wins; what it stops reporting goes back to the
    // import's.
    sync(json!([{ "day": "2026-09-02", "steps": 8000, "active_kcal": 512 }])).await;
    assert_eq!(day("2026-09-02").await.unwrap()["active_kcal"], 512);
    sync(json!([{ "day": "2026-09-03", "steps": 10 }])).await;
    let d = day("2026-09-02").await.unwrap();
    assert_eq!((&d["steps"], &d["active_kcal"]), (&json!(300), &json!(4)));
    // Removing the synced data leaves the imported.
    let (status, _) = call(&app, "DELETE", "/api/profiles/1/sync/health", None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(day("2026-09-03").await.unwrap()["hrv_ms"], 65);
    assert_eq!(day("2026-09-03").await.unwrap()["steps"], Value::Null);
}

#[tokio::test]
async fn a_restored_profile_keeps_what_was_imported() {
    let app = app();
    import(&app, export(&series())).await;
    let file = get(&app, "/api/profiles/1/export").await;
    assert_eq!(file["import_days"][0]["active_kcal"], 4);
    let mut file = file;
    file["profile"]["name"] = json!("Restored");
    let (status, restored) = call(&app, "POST", "/api/profiles/import", Some(file)).await;
    assert_eq!(status, StatusCode::CREATED, "{restored}");
    let pid = &restored["id"];
    let (status, res) = call(
        &app,
        "POST",
        &format!("/api/profiles/{pid}/sync/health"),
        Some(
            json!({ "from": "2026-09-02", "to": "2026-09-02", "device": "Pixel 9",
            "days": [{ "day": "2026-09-02", "steps": 8000 }] }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{res}");
    let shown = get(
        &app,
        &format!("/api/profiles/{pid}/device-days?from=2026-09-02&to=2026-09-02"),
    )
    .await;
    assert_eq!(
        (&shown["days"][0]["steps"], &shown["days"][0]["active_kcal"]),
        (&json!(8000), &json!(4))
    );
}

#[tokio::test]
async fn non_series_rows_are_kept_raw() {
    // Exercises (deleted and too short ones too), sleeps, stages, resting
    // heart rate and HRV: every row, once; the per-sample series aren't.
    let app = app();
    let res = import(&app, everything()).await;
    assert_eq!(res["records"], 10, "{res}");
    assert_eq!(import(&app, everything()).await["records"], 0);
    // A short sleep away from the night is a nap of its wake day.
    let mut files = vec![file(
        "Health Fitness Data_GoogleData/UserSleeps_2026-06-30.csv",
        "sleep_id,sleep_type,sleep_start,sleep_end,start_utc_offset,end_utc_offset,\
         data_source,algorithm_version",
        &[
            "7,CLASSIC,2026-09-06T12:00:00Z,2026-09-06T12:45:00Z,+03:00,+03:00,DERIVED,sleep_session_v1",
        ],
    )];
    files.extend(sleep());
    let res = import(&app, export(&files)).await;
    assert_eq!(
        (&res["naps"], &res["records"]),
        (&json!(1), &json!(1)),
        "{res}"
    );
    let d = get(&app, "/api/profiles/1/day/2026-09-06").await;
    let naps = d["naps"].as_array().unwrap();
    assert_eq!(
        naps.iter()
            .map(|n| (
                n["start_at"].clone(),
                n["in_bed_min"].clone(),
                n["source"].clone()
            ))
            .collect::<Vec<_>>(),
        [(json!("2026-09-06T12:00:00Z"), json!(45), json!("import"))]
    );
    // Without stages its time asleep isn't known: in bed, not asleep.
    assert_eq!(
        (
            &d["device_day"]["total_asleep_min"],
            &d["device_day"]["nap_in_bed_min"]
        ),
        (&d["device_day"]["asleep_min"], &json!(45))
    );
    // Again: the same nap, not a second.
    assert_eq!(import(&app, export(&files)).await["naps"], 0);
}

#[tokio::test]
async fn days_take_the_device_before_the_import() {
    // device_day: Health Connect's value where it has one, the import's
    // where it has none, per field.
    let app = app();
    synced_and_logged(&app).await;
    import(&app, everything()).await;
    let a = get(
        &app,
        "/api/profiles/1/device-days?from=2026-09-02&to=2026-09-02",
    )
    .await;
    let d = &a["days"][0];
    assert_eq!(
        (&d["steps"], &d["active_kcal"], &d["resting_hr"]),
        (&json!(8000), &json!(4), &json!(57)),
        "{d}"
    );
}

#[tokio::test]
async fn an_import_projects_stages_and_heart_rate_and_the_device_beats_it() {
    let app = app();
    let mut files = sleep().to_vec();
    files.push(file(
        "Physical Activity_GoogleData/Heart Rate/heart_rate_2026-09-01.csv",
        "timestamp,beats per minute,data source",
        &[
            "2026-09-05T22:00:00Z,52,Google Fitbit Air",
            "2026-09-06T12:00:00Z,96,Google Fitbit Air",
        ],
    ));
    import(&app, export(&files)).await;
    let d = get(&app, "/api/profiles/1/day/2026-09-06").await;
    assert_eq!(
        d["stages"],
        json!([{ "day": "2026-09-06", "start_at": "2026-09-05T21:00:00Z",
                 "end_at": "2026-09-05T21:20:00Z", "stage": "awake", "source": "import" }]),
        "{d}"
    );
    assert_eq!(
        (
            &d["device_day"]["max_hr"],
            &d["device_day"]["min_hr"],
            &d["device_day"]["sleep_avg_hr"]
        ),
        (&json!(96), &json!(96), &json!(52)),
        "{d}"
    );
    // The same night synced with its own spans: those show.
    hc_records(
        &app,
        1,
        json!([hc_sleep(
            "s-6",
            "2026-09-05T21:00:00Z",
            "2026-09-06T05:00:00Z",
            &[("2026-09-05T21:00:00Z", "2026-09-05T22:00:00Z", 4)]
        )]),
    )
    .await;
    let (status, res) = call(
        &app,
        "POST",
        "/api/profiles/1/sync/health",
        Some(json!({ "from": "2026-09-06", "to": "2026-09-06", "days": [
            { "day": "2026-09-06", "steps": 10 }] })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{res}");
    let d = get(&app, "/api/profiles/1/day/2026-09-06").await;
    assert_eq!(d["stages"].as_array().unwrap().len(), 1, "{d}");
    assert_eq!(d["stages"][0]["source"], "health_connect");
    // Again changes nothing.
    import(&app, export(&files)).await;
    let (_, file) = call(&app, "GET", "/api/profiles/1/export", None).await;
    assert_eq!(file["sleep_stages"].as_array().unwrap().len(), 2);
}

fn steps(rows: &[&str]) -> Value {
    file(
        "Physical Activity_GoogleData/Steps/steps_2026-09-01.csv",
        "timestamp,steps,data source",
        rows,
    )
}

async fn day_of(app: &Router, day: &str) -> Value {
    get(
        app,
        &format!("/api/profiles/1/device-days?from={day}&to={day}"),
    )
    .await["days"][0]
        .clone()
}

#[tokio::test]
async fn same_series_twice_counts_once() {
    // Two parts of one export (or two exports) holding the same samples.
    let app = app();
    let rows = [
        "2026-09-02T10:00:00Z,300,Google Fitbit Air",
        "2026-09-02T11:00:00Z,200,Google Fitbit Air",
    ];
    import(&app, export(&[steps(&rows), steps(&rows)])).await;
    assert_eq!(day_of(&app, "2026-09-02").await["steps"], 500);
}

#[tokio::test]
async fn negative_year_row_is_skipped_and_export_restores() {
    let app = app();
    let res = import(
        &app,
        export(&[
            steps(&[
                "-000001-06-01T12:00:00Z,500,x",
                "2026-09-02T10:00:00Z,300,x",
            ]),
            file(
                "daily_resting_heart_rate.csv",
                "timestamp,beats per minute,data source",
                &["2099-01-01T00:00:00Z,60,x", "9999-12-31T00:00:00Z,60,x"],
            ),
            exercises(&[
                "301,-000001-06-01T12:00:00Z,-000001-06-01T12:30:00Z,+00:00,Walk,MANUAL,,,,,",
            ]),
        ]),
    )
    .await;
    assert_eq!(
        (&res["days"], &res["skipped"]),
        (&json!(1), &json!(4)),
        "{res}"
    );
    let mut file = get(&app, "/api/profiles/1/export").await;
    let days: Vec<&str> = file["import_days"]
        .as_array()
        .unwrap()
        .iter()
        .map(|d| d["day"].as_str().unwrap())
        .collect();
    assert_eq!(days, ["2026-09-02"]);
    file["profile"]["name"] = json!("Restored");
    let (status, res) = call(&app, "POST", "/api/profiles/import", Some(file)).await;
    assert_eq!(status, StatusCode::CREATED, "{res}");
}

#[tokio::test]
async fn overflowing_values_are_skipped() {
    let app = app();
    let res = import(
        &app,
        export(&[
            steps(&[
                "2026-09-02T10:00:00Z,9000000000000000,x",
                "2026-09-02T10:01:00Z,9000000000000000,x",
                "2026-09-03T10:00:00Z,40,x",
            ]),
            file(
                "Health Fitness Data_GoogleData/UserSleeps_2026-05-31.csv",
                "sleep_id,sleep_type,sleep_start,sleep_end,start_utc_offset,end_utc_offset,\
                 data_source,algorithm_version",
                &[
                    "1,STAGES,2026-09-02T22:00:00Z,2026-09-03T06:00:00Z,+999999999:00,+03:00,DERIVED,sleep_session_v2",
                ],
            ),
        ]),
    )
    .await;
    // The day whose steps overflow; an offset that overflows reads as
    // none (the zone's, UTC here).
    assert_eq!(res["skipped"], 1, "{res}");
    let d = day_of(&app, "2026-09-03").await;
    assert_eq!(
        (&d["steps"], &d["bedtime"]),
        (&json!(40), &json!("22:00")),
        "{d}"
    );
    assert_eq!(day_of(&app, "2026-09-02").await, Value::Null);
}

/// An export of `n` resting heart rate rows, each its own raw row.
fn raw_rows(n: usize) -> Value {
    let rows: Vec<String> = (0..n)
        .map(|i| format!("2026-09-02T00:00:{:02}.{i:06}Z,{},x", i % 60, 50 + i % 20))
        .collect();
    let rows: Vec<&str> = rows.iter().map(String::as_str).collect();
    export(&[file(
        "daily_resting_heart_rate.csv",
        "timestamp,beats per minute,data source",
        &rows,
    )])
}

#[tokio::test]
async fn dropped_request_still_keeps_every_raw_row() {
    // The client gives up (a timeout, a closed tab) while the import waits
    // or runs: it still finishes, every raw batch.
    let state = kaloriina::AppState::new(open(FsPath::new(":memory:")).unwrap(), NO_OFF.into());
    let app = kaloriina::router(state.clone());
    let rows = kaloriina::google_health::RAW_BATCH * 2 + 5;
    let held = super::security::hold_db(&state);
    let dropped = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        call(&app, "POST", IMPORT, Some(raw_rows(rows))),
    )
    .await;
    assert!(
        dropped.is_err(),
        "the import ran while the database was held"
    );
    drop(held);
    // Once its work ends, the next import finds every row there.
    drop(state.imports.acquire().await.unwrap());
    assert_eq!(import(&app, raw_rows(rows)).await["records"], 0);
}

#[tokio::test]
async fn removing_the_import_clears_every_store() {
    let app = app();
    synced_and_logged(&app).await;
    let mut files = vec![
        workouts(),
        file(
            "Health Fitness Data_GoogleData/UserSleeps_2026-06-30.csv",
            "sleep_id,sleep_type,sleep_start,sleep_end,start_utc_offset,end_utc_offset,\
         data_source,algorithm_version",
            &[
                "7,CLASSIC,2026-09-06T12:00:00Z,2026-09-06T12:45:00Z,+03:00,+03:00,DERIVED,sleep_session_v1",
            ],
        ),
    ];
    files.extend(sleep());
    files.extend(series());
    let first = import(&app, export(&files)).await;
    let (status, res) = call(&app, "DELETE", IMPORT, None).await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{res}");
    // The device's and the hand's stay; nothing of the import shows.
    let sessions = get(&app, "/api/profiles/1/activities").await;
    assert!(
        sessions
            .as_array()
            .unwrap()
            .iter()
            .all(|s| !s["source_key"].as_str().unwrap_or("").starts_with("gh-")),
        "{sessions}"
    );
    assert_eq!(sessions.as_array().unwrap().len(), 2);
    let d = get(&app, "/api/profiles/1/day/2026-09-06").await;
    assert_eq!((&d["naps"], &d["stages"]), (&json!([]), &json!([])), "{d}");
    assert_eq!(day_of(&app, "2026-09-02").await["active_kcal"], Value::Null);
    assert_eq!(day_of(&app, "2026-09-02").await["steps"], 8000);
    // Gone for good, raw rows too: importing again is a first import.
    let again = import(&app, export(&files)).await;
    assert_eq!(
        (&again["activities"], &again["records"], &again["naps"]),
        (&first["activities"], &first["records"], &first["naps"]),
        "{again}"
    );
    let (status, _) = call(&app, "DELETE", "/api/profiles/9/import/google-health", None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[test]
fn takeout_names_follow_the_shared_list() {
    // tests/fixtures/takeout-names.json: what the server reads, what the
    // browser sends in heart-rate batches, what nobody reads; takeout.test.mjs
    // checks the browser against the same list.
    let names: Value = serde_json::from_str(
        &std::fs::read_to_string(
            FsPath::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/takeout-names.json"),
        )
        .unwrap(),
    )
    .unwrap();
    let list = |k: &str| names[k].as_array().unwrap().clone();
    for name in list("read").iter().chain(&list("heart_rate")) {
        let name = name.as_str().unwrap();
        assert!(kaloriina::google_health::wanted(name), "{name}");
    }
    for name in list("ignored") {
        let name = name.as_str().unwrap();
        assert!(!kaloriina::google_health::wanted(name), "{name}");
    }
}
