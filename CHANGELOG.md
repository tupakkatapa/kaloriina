# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Breaking: meals are gone, each one becomes a recipe (database 70 → 75; from 0.2.0, 69 → 75). Update the server before the APK: a new APK on an old page waits 30 s on a pull.

### Added

- Match an imported Cronometer row to a food, on every day it was logged, so its nutrients (creatine, say) count
- `kaloriina import-loop-habits` for a Loop Habit Tracker backup
- Every other Google Health CSV in a Takeout is kept as sent
- Rating filter in food search: Healthy, OK or Unhealthy
- Suggestions in food search: up to 10 foods you're likely to want now, each with a one-tap + that logs your last amount
  - Ranked by how often, at what time, on which weekday or at weekends, how recently and what with you had them
  - Never anything with alcohol; a suggested recipe leaves out its ingredients
  - "?" says why, with Not today or Never suggest (Undo); Profile lists the never suggested
- Logging a food starts at the amount and serving you logged it with last time
- Log again today, in the editor of an entry on another day
- Activity offers the workout to start again: today's planned one, else the last one done
- AMOLED theme; the system bars follow the theme, black under AMOLED
- Space is Done on a workout run
- An evening check-in prompt and a weigh-in reminder, with Settings → Reminders to turn them off
- `--db` reads `KALORIINA_DB`; on NixOS, `kaloriina` uses the service's database as the service user
- One-off items: "One-off item" on a group's Add screen (or "Add … as a one-off" after a search)
  - Logs a name, a time, an optional kcal estimate (≈; Snack, Meal or Big meal fill one) and optional protein, carbs and fat, never saved as a food
  - "Find the food" makes it that food's entry in place
  - One without kcal reads "Estimate kcal" and leaves its day out of averages, charts, the energy balance and learned maintenance; its habits read as unknown, and the food calendar shows its amount unjudged
  - A file holding one-off items doesn't import on an older release
- Summary → Food says what your goal date needs a day ("deficit ≈ 450 kcal"), the number Targets plans
- Wins in the Highlights: Energy or Protein on target, a logging streak, a new best from Records; one always among the three shown
- Summary tiles say their change from the period before past the Highlights' bars: activities, time active, steps, active energy, sleep, RHR, HRV and the picked habit's mean
- Food quality on Summary → Food: the period's energy by rating (Healthy, OK, Unhealthy, Not rated) as one bar, and Healthy's change in points
- `kaloriina mcp`: the diary's tools for an agent (Model Context Protocol on stdio), calling a running instance's API
- Drafts: a food or recipe left unsaved is kept on this device and comes back when its editor opens, marked Draft, with Discard; Foods lists them
- "New food “…”" in a recipe's ingredient search: after its Save the recipe is back as typed, with the new food as an ingredient
- Food search reads letters without their marks (`creme fraiche` finds Crème fraîche, `ayri` Äyriäiset) and, when nothing matches, forgives one wrong, missing or extra letter in a word of 4 letters or more
- API:
  - `GET /api/now`: the diary day and time in the server's zone
  - `GET /api/feedback/open` (the open feedback with its texts) and `POST /api/feedback/pull` (`ids`), with the `feedback_list` and `feedback_pull` tools of `kaloriina mcp`
  - `GET …/trends?from&to&by=week|month`: per week or month, mean energy, protein and alcohol over the counted days, the weight trend and the daily items' adherence
  - `incomplete` on a day and a summary day; a summary day's `ratings` (its eaten kcal by `healthy`, `ok`, `unhealthy`, `unrated`)
  - `GET …/foods/suggestions?day&time` and `GET …/foods/{id}/last`
  - `GET …/suggestions/hidden`, `PUT`/`DELETE …/suggestions/hidden/{food_id}` (`until` or for good); the export's `hidden_suggestions`
  - `POST …/entries` with `name`, `energy`, `protein`, `carbs` and `fat` (without `food_id`, `entry_ids` or `repeat_of`); `PATCH …/entries/{id}` with `name`, `energy`, `protein`, `carbs`, `fat`, or a text entry's `food_id`
  - An own entry's `food_id` and `grams` may be null and its `amount` "" (one-off items); `limits.entry_energy` and `limits.entry_macro`
  - A habit's `days` (how many days it has logged); `/records`' `days` (the best step day, the longest night, the most sleep in a day)

### Changed

- Nutrient bars, averages and food calendars count to the target itself; an "about" target is met within 5 % either way (was up to 10 % over). API: an about-target's `min`/`max` is now 0.95–1.05 × `value`
- The day starts at 03:00: food, water and habits logged after midnight go on the evening's day, which also opens by default
- Energy reads Cal in US units
- Pull to refresh takes a longer pull, shows as a thin line at the top, and reads only from the server; the phone syncs Health Connect on opening and from its Settings → Sync now
- Food search lists Suggestions first; Favourites, Recent, Your recipes and Your foods fold away, each remembered open or closed on this device
- "≥" marks a total only when under 80 % of the food behind it has a value; every bar's tooltip says how much did
- Diary select mode saves the selected entries as a recipe (was a meal)
- Summary → Food leads with the energy balance
- Series without a trend line (heart rate, water, BMI, maintenance) join their days
- Backups are zstd-compressed (`kaloriina-<time>.db.zst`, about a tenth of the size); earlier `.db` copies age out as before
- Database 69 → 70: the raw Health Connect archive is rebuilt to about half its size, and the file is compacted once on the first start (minutes on a large file)
- Database 72 → 73: hidden suggestions
- Database 73 → 74: days marked not fully logged become a one-off item
- Database 74 → 75: a profile import finds its foods by index (seconds less under the lock on a large library)
- A day with a one-off item reads its nutrients other than energy as floors ("≥"); one without kcal is left out as a day not fully logged
- Sources: one-off items' share reads with imported history's
- Highlights no longer repeat a change a tile shows: activities' count (now on its tile), and the picked habit's
- The Diary says when backups need looking at
- `kaloriina import` is `kaloriina import-cronometer`; the old name still works
- `kaloriina import-google-health` follows the server's time zone; `--time-zone` is needed only before the server has run, and one other than the server's is refused
- A changed `services.kaloriina.timeZone` remakes nights and the day totals that depend on it on the next start
- `services.kaloriina.address` takes an IP address (`localhost` fails at evaluation); the service reaches no link-local address, a Home Assistant hook included
- A screen that failed to load, and the outbox, offer Retry; an error toast stays until closed; a server restarting behind the proxy says so
- Error messages name fields as the screen does ("Webhook ID", "Distance"), and the Home Assistant card marks the field at fault
- Android: a page that won't load shows why, with Retry and Settings; a failed check or sync says why the server couldn't be reached
- Summary's subtabs share one read of the period; Records and Summary → Activity read the day bests from the server instead of every device day
- API: a PUT missing several fields names them all in one 400 ("Brand, servings and category are required"; `field` is the first)
- Food search ranks an exact name first, then a name starting with the search, then one with a word starting with each word searched; favourites, your own foods and recent ones still come first
- The food and recipe editors no longer ask before leaving unsaved changes: they are kept as a draft ("Saved as a draft")

### Removed

- Meals: `/api/meals*`, the meal editor and log screen, the Meals section in food search, `#/meal/…` and `#/log-meal/…`
  - Database 70 → 71 makes each meal with items a recipe of your own with the same items and amounts
  - Meals without items, and meals identical to an unarchived recipe of the same name (made by "Recipe from this meal"), are dropped
  - A converted recipe logs as one entry and is never a drink; to log several foods at once, select them and use Log again
- `meal_id` and `portions` on `POST /api/profiles/{pid}/entries` (400 naming the field), `usage.meals`, `meals` in profile stats and `limits.portions` in `/api/meta`. A meal write still waiting in a device's outbox fails and can be discarded
- "Same as yesterday" in Planned's Add screen

### Fixed

- A chart's tooltip stayed on screen after scrolling
- A walk logged by hand late at night and its synced copy on the next day stayed two activities
- A failed upgrade's snapshot was reused after the old release wrote to the database again
- Two short sleeps before a night didn't both start it
- A profile export could mix two moments of a database being written
- Archive saved a food with a value it couldn't read
- An imported diary group moved to Planned still counted in the day's food ratings
- A merged food lost its hidden suggestion
- Skip to content did nothing after a save
- A refused search, or two rules on one nutrient, emptied the food filters
- Editing an ingredient of a recipe opened from elsewhere lost the way back
- A timed set of 0 s read as reps
- A double tap on Save could save a workout twice
- A broken Takeout zip failed with an internal error
- A phone sync rewrote every record it resent, so the database grew scattered on disk and the first screen after a while opened slowly
- An openScale user name padded with spaces past the length limit lost its text

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
- Google Health import from a Takeout export: Profile → Connections, or `kaloriina import-google-health`
- Home Assistant hook: a `POST` when a workout starts or finishes
- Photos on a diary day's groups
- Profile → Feedback: a bug or an idea for whoever runs the server, read with `kaloriina feedback --pull`
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
