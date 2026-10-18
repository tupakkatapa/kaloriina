# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-10-17

Breaking: database 58 → 69, export format v3 and a pinned APK signer. To upgrade:

- Empty each device's outbox (`#/outbox`), then deploy the server; it snapshots the database before migrating
- Then install the new APK, grant everything and run Resync a year
- Re-export any profile you keep as a file: only v3 files import

### Added

- Activity card in the Diary: the day's distance, steps and active energy, planned workouts and device workouts
- Activity and workout views, records, and each exercise's history and bests
- Cardio load (Banister's TRIMP) per activity, and per week in Summary
- Resting energy and each day's distance from Health Connect
- Healthy, OK or Unhealthy from a Nutri-Score, with its reasons, plus High, Low and Source-of labels
- Drinks per 100 ml, and hydration from every food's water
- Every number tile explains itself on hover, focus or tap
- Suggested steps target, steps a day in All time, and a note on a fat-soluble supplement eaten without fat
- Pull to refresh on a phone
- `services.kaloriina.hooks` and `services.kaloriina.fineli`

### Changed

- Every number says how sure it is: `≈` an estimate, `≥` a floor, `–` unknown
- Energy burned and targets planned from maintenance learned from what you ate and your weight trend
- Past diary entries follow their food
- Nights, naps, HRV and the day's weight made by the server from raw Health Connect records
- Nutrient bars count to the middle of a target range
- Tooltips sit above your finger, and trend lines show only where they help
- Diary, Summary and Activity layouts reworked, and screens load faster
- API: `/sessions` is `/activities`, `/activity` is `/device-days`, and more renamed fields and error codes

### Removed

- Summary's "Last 4 weeks" energy target and per-chart Day/Week/Month picks
- The "Water below recommended" food warning

### Fixed

- A retried save no longer creates a duplicate
- A second tab could edit or delete the wrong entry
- "1,000" typed into a number field read as 1
- An entry moved back to Planned keeps no time eaten
- Many truthfulness fixes in Summary and insights

## [0.1.0] - 2026-10-09

Initial release.

### Added

- Diary with Planned and Eaten, nutrient targets and a log for weight, water, habits and sleep
- Foods from Fineli, Open Food Facts and your own, with recipes, meals and a Cronometer import
- Workouts with a guided run and an exercise library
- Summary of Food, Body, Training and Habits
- Profiles with one-file export, an offline outbox and nightly backups
- NixOS module, and an Android app that syncs Health Connect
