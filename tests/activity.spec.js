// Health Connect activity from the Android companion: the diary's Log card,
// the session editor, Summary → Activity and Profile → Connections, fed through
// `sync/health` as the app posts it.
// Every test uses a profile of its own; days are in August–September 2026,
// before any server's today.

import { expect, test } from "@playwright/test";
import {
  answer,
  exerciseIds,
  expectFits,
  fixedToday,
  mockJson,
  newProfile,
  ownProfile,
  setTarget,
  starts,
  syncHealth,
  todayInApp,
  unique,
  workout,
} from "./helpers.js";

const health = (pid) => `/api/profiles/${pid}/sync/health`;

const running = (day, key = `run-${day}`, at = "14:02", until = "14:48") => ({
  key,
  day,
  start_at: `${day}T${at}:00Z`,
  end_at: `${day}T${until}:00Z`,
  type: 33,
  name: "Running",
  kcal: 410,
  distance_m: 8200,
  recording_method: 1,
});

// A week, 2026-08-31 (Mon) .. 2026-09-06: two days (the first with the
// night that ended it) and two runs.
async function sync(request, pid, device = "Pixel 9", sessions = null) {
  const res = await syncHealth(request, pid, {
    from: "2026-08-31",
    to: "2026-09-06",
    device,
    days: [
      {
        day: "2026-09-02",
        active_kcal: 512,
        steps: 9120,
        resting_hr: 54,
        hrv_ms: 48,
        asleep_min: 440,
        in_bed_min: 475,
        bedtime: "23:40",
        wake_time: "07:05",
      },
      { day: "2026-09-03", active_kcal: 400, steps: 8000 },
    ],
    sessions: sessions ?? [running("2026-09-02"), running("2026-09-03")],
  });
  expect(res.status()).toBe(200);
  return res.json();
}

async function logged(request, pid, day) {
  const res = await request.post(`/api/profiles/${pid}/activities`, {
    data: { day, name: "Pull day", minutes: 30, kcal: 100, sets: [] },
  });
  expect(res.ok()).toBeTruthy();
}

const card = (page) => page.locator(".connections .health");
// The Diary's Activity card.
const logCard = (page) => page.locator(".activity-card");

test("the Activity card shows the movement and device runs as activities; the night is the Sleep card's", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(550, testInfo);
  const pid = await ownProfile(page, request, `Device ${tag}`);
  await sync(request, pid);
  await logged(request, pid, "2026-09-02");
  await page.goto("/#/day/2026-09-02");
  const log = logCard(page);
  // The device's run's distance leads; its active energy is measured: no
  // "≈".
  await expect(log.locator("header .total > span")).toHaveText([
    "8.2 km in activities",
    "9,120 steps of 10,000",
    "active 512 kcal",
  ]);
  const sleep = page.locator(".sleep-card");
  // Asleep all the time in bed: the night has no stages.
  await expect(sleep.locator(".sleep-total")).toHaveText("7 h 25 min");
  await expect(sleep.locator(".night-ends > span")).toHaveText([
    "23:40",
    "07:05",
  ]);
  // Heart is Summary → Body's.
  await expect(log.locator(":is(.night, .heart)")).toHaveCount(0);
  // The device's run is a workout done like any other: it opens its
  // view (pace and source are there, activity-view.spec.js).
  const run = log.getByRole("link", { name: /^Running/u });
  await expect(run).toContainText("46 min · 8.2 km · active 410 kcal");
  await expect(run).not.toContainText("Health Connect");
  await expect(log.locator(".log-row .kind")).toHaveText(["Run", "Workout"]);
  // Nothing waits in auto mode.
  await expect(log.getByRole("button", { name: /^Add /u })).toHaveCount(0);
});

test("the Activity card's movement: its headline never split inside a part; the night is the Sleep card's", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(557, testInfo);
  const pid = await ownProfile(page, request, `Night ${tag}`);
  const res = await syncHealth(request, pid, {
    from: "2026-09-02",
    to: "2026-09-02",
    device: "Pixel 9",
    days: [
      {
        day: "2026-09-02",
        active_kcal: 512,
        steps: 9120,
        resting_hr: 54,
        hrv_ms: 48,
        asleep_min: 460,
        in_bed_min: 475,
        bedtime: "23:10",
        wake_time: "07:05",
        deep_min: 110,
        rem_min: 90,
        light_min: 260,
      },
    ],
    sessions: [],
  });
  expect(res.ok()).toBeTruthy();
  await page.setViewportSize({ width: 393, height: 800 });
  await page.goto("/#/day/2026-09-02");
  const log = logCard(page);
  // Its headline (toHaveText reads no-break spaces as spaces).
  const headline = log.locator("header .total > span");
  await expect(headline).toHaveText([
    "9,120 steps of 10,000",
    "active 512 kcal",
  ]);
  const sleep = page.locator(".sleep-card");
  await expect(sleep.locator(".sleep-total")).toHaveText("7 h 40 min");
  await expect(
    sleep.getByRole("img", { name: /^Sleep stages/u }),
  ).toHaveAccessibleName(
    "Sleep stages from 23:10 to 07:05: awake 15 min, REM 1 h 30 min, light 4 h 20 min, deep 1 h 50 min.",
  );
  await expect(sleep.locator(".night-ends > span")).toHaveText([
    "23:10",
    "07:05",
  ]);
  await expect(log.locator(".log-row")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("night-393.png") });
  // On the narrowest phone the headline breaks only between its parts.
  await page.setViewportSize({ width: 320, height: 800 });
  for (const part of await headline.allTextContents())
    expect(part, `"${part}" never splits`).not.toContain(" ");
  await page.screenshot({ path: testInfo.outputPath("night-320.png") });
});

test("a device workout keeps the device's fields, and stays deleted", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(650, testInfo);
  const pid = await ownProfile(page, request, `Edit ${tag}`);
  await sync(request, pid);
  await page.goto("/#/day/2026-09-02");
  await logCard(page)
    .getByRole("link", { name: /^Running/u })
    .click();
  await page.getByRole("link", { name: "Edit activity" }).click();
  await expect(page.getByText("From Health Connect")).toBeVisible();
  for (const label of [
    "Day",
    "Duration (min)",
    /^Energy \(kcal\)/u,
    "Distance (km)",
    "Start time",
  ])
    await expect(page.getByLabel(label, { exact: true })).toBeDisabled();
  const type = page.getByRole("combobox", { name: "Type", exact: true });
  await expect(type).toBeDisabled();
  await expect(type).toHaveValue("run");
  await expect(page.getByLabel("Distance (km)")).toHaveValue("8.2");
  // A device's run has no sets, nor can it take any: no empty Sets card.
  await expect(page.locator("fieldset.sets-editor")).toHaveCount(0);
  // 14:02 UTC is 17:02 in Helsinki.
  await expect(page.getByLabel("Start time", { exact: true })).toHaveValue(
    "17:02",
  );
  // The name is yours.
  await page.getByLabel("Name", { exact: true }).fill("Tempo run");
  await page.getByRole("button", { name: "Save" }).click();
  // Back on its view, renamed; its Back is the day.
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tempo run");
  await page.getByRole("link", { name: "Back" }).click();
  await expect(
    logCard(page).getByRole("link", { name: /^Tempo run/u }),
  ).toBeVisible();

  await logCard(page)
    .getByRole("link", { name: /^Tempo run/u })
    .click();
  await page.getByRole("link", { name: "Edit activity" }).click();
  await page.getByRole("button", { name: "Delete" }).click();
  expect(await answer(page, "Delete")).toBe(
    "Delete Tempo run on Wed, Sep 2? It won't come back on the next sync.",
  );
  await sync(request, pid);
  await page.goto("/#/day/2026-09-02");
  await expect(page.locator(".sleep-card")).toBeVisible();
  await expect(logCard(page)).not.toContainText("Running");
  await expect(logCard(page)).not.toContainText("Tempo run");
});

test("a matched hand log says so and keeps its minutes; the device's read-only energy has no hint", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(369, testInfo);
  const pid = await ownProfile(page, request, `Matched ${tag}`);
  const log = await request.post(`/api/profiles/${pid}/activities`, {
    data: {
      day: "2026-09-02",
      name: "Tempo",
      type: "run",
      minutes: 55,
      kcal: null,
      sets: [],
    },
  });
  expect(log.ok()).toBeTruthy();
  const { id } = await log.json();
  // The device's run that day: the untimed hand log claims it.
  await sync(request, pid, "Pixel 9", [running("2026-09-02")]);
  await page.goto(`/#/activity/${id}/edit`);
  await expect(page.getByText("Matched with Health Connect")).toBeVisible();
  await expect(
    page.getByLabel("Duration (min)", { exact: true }),
  ).toBeEnabled();

  // A device session: its energy is shown, not estimated, so no hint.
  await sync(request, pid, "Pixel 9", [running("2026-09-03")]);
  await page.goto("/#/day/2026-09-03");
  await logCard(page)
    .getByRole("link", { name: /^Running/u })
    .click();
  await page.getByRole("link", { name: "Edit activity" }).click();
  await expect(page.getByText("From Health Connect")).toBeVisible();
  await expect(
    page.locator(".field small", { hasText: "estimated" }),
  ).toHaveCount(0);
  await expect(page.getByText(/Empty: estimated/u)).toHaveCount(0);
});

test("in ask mode device workouts wait with Add and Dismiss", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(651, testInfo);
  const pid = await ownProfile(page, request, `Ask ${tag}`);
  const mode = await request.put(`${health(pid)}/workouts`, {
    data: { mode: "ask" },
  });
  expect(mode.ok()).toBeTruthy();
  const runs = [
    running("2026-09-02", "am-1", "05:00", "05:30"),
    running("2026-09-02", "pm-1", "15:00", "15:45"),
  ];
  await sync(request, pid, "Pixel 9", runs);
  await page.goto("/#/day/2026-09-02");
  const log = logCard(page);
  await expect(log.locator(".log-row.pending")).toHaveCount(2);
  await expect(log.locator(".log-row.pending").first()).toContainText(
    "08:00 · 30 min · 8.2 km",
  );
  await log.getByRole("button", { name: "Add Running at 08:00" }).click();
  await expect(log.getByRole("link", { name: /^Running/u })).toHaveCount(1);
  await expect(log.locator(".log-row.pending")).toHaveCount(1);
  await log.getByRole("button", { name: "Dismiss Running at 18:00" }).click();
  // Irreversible (no Undo): asked first; Cancel keeps it waiting.
  const ask = page.getByRole("dialog");
  await expect(ask).toContainText("Dismiss Running at 18:00?");
  await ask.getByRole("button", { name: "Cancel" }).click();
  await expect(log.locator(".log-row.pending")).toHaveCount(1);
  await log.getByRole("button", { name: "Dismiss Running at 18:00" }).click();
  await ask.getByRole("button", { name: "Dismiss" }).click();
  await expect(log.locator(".log-row.pending")).toHaveCount(0);
  // The next sync brings neither back.
  await sync(request, pid, "Pixel 9", runs);
  await page.reload();
  await expect(log.getByRole("link", { name: /^Running/u })).toHaveCount(1);
  await expect(log.locator(".log-row.pending")).toHaveCount(0);
});

test("Summary → Activity counts device workouts and their distance", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(551, testInfo);
  const pid = await ownProfile(page, request, `Steps ${tag}`);
  await sync(request, pid);
  await logged(request, pid, "2026-09-02");
  await page.goto("/#/summary/activity/week/2026-08-31");
  // Each day the larger of the device's active energy and its activities'
  // (activeKcal): 512 on the 2nd (over its run and Pull day), the run's 410
  // over the device's 400 on the 3rd; over the 2 of the week's days that
  // have any. The distance is the activities'.
  await expect(
    page.getByRole("list", { name: "Daily movement" }).locator(".tile"),
  ).toHaveText([
    // The device's days, measured: no "≈"; a mean over the 2 days.
    "461 kcal active a day",
    "8,560 steps a day",
    // No steps target set: the default 10,000.
    "0 of 2 days at steps target",
    "16.4 km in activities",
  ]);
  // The profile's data starts on the 2nd.
  await expect(
    page.getByRole("list", { name: "Daily movement" }).locator(".tile").first(),
  ).toHaveAccessibleDescription(
    /over the 2 days it's known since Sep 2 \(of 5 days\)/u,
  );
  await expect(page.locator("ul.movement-summary")).toBeVisible();
  // The device's runs are workouts done; active energy stays apart.
  const workouts = page.getByRole("list", { name: "Activities" });
  await expect(workouts).toContainText("3 activities");
  // The runs' 410 each; Pull day's typed 100 is a total with no weigh-in
  // to net its resting by: no active energy to add.
  await expect(workouts).toContainText("820 kcal from activities");
});

test("Connections shows the last sync, both phones, the mode, and removes it", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(552, testInfo);
  const pid = await ownProfile(page, request, `Sync ${tag}`);
  await page.goto("/#/connections");
  await expect(card(page)).toContainText("Nothing synced yet");
  await expect(
    card(page).getByRole("button", { name: "Remove synced data" }),
  ).toHaveCount(0);

  await sync(request, pid);
  await page.reload();
  await expect(card(page).locator(".last-sync")).toHaveText(
    "Last sync just now: 2 days, 1 night, 2 activities (Pixel 9)",
  );
  await expect(card(page)).not.toContainText("Synced from");
  await sync(request, pid, "Pixel 7");
  await page.reload();
  await expect(card(page)).toContainText(
    "Synced from Pixel 7 and Pixel 9. Activities aren't removed while two phones sync.",
  );

  // Its options are too long for a segmented row: a select.
  const mode = card(page).getByRole("combobox", { name: "Synced activities" });
  await expect(mode).toHaveValue("auto");
  await expect(card(page)).toContainText(
    "Walks your device noticed on its own wait here until you add them.",
  );
  await mode.selectOption("ask");
  await expect
    .poll(async () => (await (await request.get(health(pid))).json()).workouts)
    .toBe("ask");

  await card(page).getByRole("button", { name: "Remove synced data" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText(
    "Removes synced days, sleep and the activities the app added. Activities you logged keep the synced details. The raw records kept from Health Connect go too.",
  );
  expect(await answer(page, "Remove")).toBe("Remove synced data?");
  await expect(card(page)).toContainText("Nothing synced yet");
  const left = await (
    await request.get(`/api/profiles/${pid}/device-days`)
  ).json();
  expect(left).toEqual({ days: [], sessions: [], resting: [] });
  const sessions = await (
    await request.get(`/api/profiles/${pid}/activities`)
  ).json();
  expect(sessions).toEqual([]);
});

test("a sync over a day old says so", async ({ page, request }, testInfo) => {
  const { tag } = unique(553, testInfo);
  const pid = await ownProfile(page, request, `Stale ${tag}`);
  await sync(request, pid);
  await page.clock.setFixedTime(Date.now() + 3 * 864e5 + 60e3);
  await page.goto("/#/connections");
  await expect(card(page).locator(".last-sync")).toHaveText(
    "Last sync 3 days ago: 2 days, 1 night, 2 activities (Pixel 9)",
  );
  await expect(card(page)).toContainText(
    "No sync for 3 days. Open the app's Settings to see why.",
  );
});

test("outside the app, Connections links the how-to", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(554, testInfo);
  await ownProfile(page, request, `Web ${tag}`);
  await page.goto("/#/connections");
  await expect(
    card(page).getByRole("link", { name: "Install the Android app" }),
  ).toHaveAttribute("href", /kaloriina#android$/u);
  await expect(
    card(page).getByRole("link", { name: "App settings" }),
  ).toHaveCount(0);
});

test.describe("inside the app", () => {
  test.use({
    userAgent:
      "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36 KaloriinaAndroid/1",
  });

  test("Connections links the app's settings with this profile", async ({
    page,
    request,
  }, testInfo) => {
    const { tag } = unique(555, testInfo);
    const pid = await ownProfile(page, request, `App ${tag}`);
    await page.goto("/#/connections");
    await expect(
      card(page).getByRole("link", { name: "App settings" }),
    ).toHaveAttribute("href", `kaloriina-app://settings?profile=${pid}`);
    await expect(
      card(page).getByRole("link", { name: "Install the Android app" }),
    ).toHaveCount(0);
  });
});

test("Connections says how many synced items were skipped", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(802, testInfo);
  const pid = await ownProfile(page, request, `Skipped ${tag}`);
  // Two workouts the server can't read (no key) among the good ones.
  const bad = { day: "2026-09-02", name: "Broken" };
  const result = await sync(request, pid, "Pixel 9", [
    running("2026-09-02"),
    bad,
    bad,
  ]);
  expect(result.skipped).toBe(2);
  await page.goto("/#/connections");
  await expect(card(page).locator(".last-sync")).toHaveText(
    "Last sync just now: 2 days, 1 night, 1 activity (Pixel 9) · 2 items skipped (invalid)",
  );
});

test("a pending walk shows on Activity", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(900, testInfo);
  const pid = await ownProfile(page, request, `Waiting ${tag}`);
  // Walks the device detected by itself wait, on any day, in auto mode too.
  const walk = (day, key) => ({
    ...running(day, key, "08:00", "08:40"),
    type: 53,
    name: "Walking",
    recording_method: 2,
  });
  await sync(request, pid, "Pixel 9", [
    walk("2026-09-02", "walk-1"),
    walk("2026-09-05", "walk-2"),
  ]);
  await page.goto("/#/connections");
  await card(page)
    .getByRole("link", {
      name: "2 activities from Health Connect wait: see Activity",
    })
    .click();
  const waiting = page.locator(".finder-section").filter({
    has: page.getByRole("heading", { name: "Waiting from Health Connect (2)" }),
  });
  await expect(waiting.locator(".log-row.pending")).toHaveText([
    /Wed, Sep 2.*Walking11:00 · 40\smin/u,
    /Sat, Sep 5.*Walking11:00 · 40\smin/u,
  ]);
  // Above what was done, then the workouts (workouts are shared: another
  // test's archived ones may be listed apart).
  await expect(
    page.locator(".finder-section h2", { hasNotText: "Archived workouts" }),
  ).toHaveText([
    "Waiting from Health Connect (2)",
    "Activities",
    "Workouts",
    "Exercises",
  ]);
  // The rows fit a narrow phone.
  await page.setViewportSize({ width: 320, height: 640 });
  await expectFits(page);
  await page.screenshot({ path: testInfo.outputPath("waiting-320.png") });
  await waiting
    .getByRole("button", { name: "Dismiss Walking on Sat, Sep 5 at 11:00" })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Dismiss" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Waiting from Health Connect (1)" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Add Walking on Wed, Sep 2 at 11:00" })
    .click();
  await expect(page.getByRole("heading", { name: /^Waiting/u })).toHaveCount(0);
  // Among the tab's latest, however old.
  await expect(page.getByRole("link", { name: /^Walk/u })).toContainText(
    "Sep 2",
  );
  await page.goto("/#/connections");
  await expect(card(page).locator(".last-sync")).toBeVisible();
  await expect(card(page).locator(".waiting")).toHaveCount(0);
});

test("Connections says once that nothing came from openScale yet", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(967, testInfo);
  await ownProfile(page, request, `Quiet ${tag}`);
  await page.goto("/#/connections");
  await expect(page.locator(".last-received")).toHaveText(
    "Nothing received yet: set up openScale sync below, then weigh yourself.",
  );
  await expect(page.getByText(/No readings yet/u)).toHaveCount(0);
});

test("synced naps without stages leave the night's time asleep, Summary says them, and a run shows the device's heart rate", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(992, testInfo);
  const pid = await ownProfile(page, request, `Nap ${tag}`);
  const res = await syncHealth(request, pid, {
    from: "2026-09-02",
    to: "2026-09-02",
    device: "Pixel 9",
    days: [
      {
        day: "2026-09-02",
        asleep_min: 440,
        in_bed_min: 475,
        bedtime: "23:40",
        wake_time: "07:05",
        naps: [
          {
            key: "nap-1",
            start_at: "2026-09-02T11:00:00Z",
            end_at: "2026-09-02T11:20:00Z",
          },
          {
            key: "nap-2",
            start_at: "2026-09-02T15:00:00Z",
            end_at: "2026-09-02T15:20:00Z",
          },
        ],
      },
    ],
    sessions: [{ ...running("2026-09-02"), avg_hr: 142, max_hr: 171 }],
  });
  expect(res.status()).toBe(200);
  await page.goto("/#/day/2026-09-02");
  const log = logCard(page);
  // The naps have no stages: only their time in bed, never counted asleep.
  const sleep = page.locator(".sleep-card");
  await expect(sleep.locator(".sleep-total")).toHaveText("7 h 25 min");
  await expect(sleep.locator(".night-ends > span")).toHaveText([
    "23:40",
    "07:05",
  ]);
  // The device's heart rate is the run's view's.
  await log.getByRole("link", { name: /^Running/u }).click();
  await expect(page.locator("dl.traits")).toContainText("142 bpm avg, 171 max");
  // Summary → Body says the night and its naps.
  await page.goto("/#/summary/body/week/2026-08-31");
  await expect(
    page.locator("section.sleep-summary").getByRole("link", {
      name: "Wed, Sep 2: 7 h 25 min asleep, 23:40–07:05 · 7 h 25 min in bed · 100 % efficiency · + 2 naps, 40 min in bed",
    }),
  ).toBeVisible();
});

// One "+" logs any activity. Workout lists the
// saved workouts, each with Start, and an empty workout; no second Start.
test("Activity's one + logs an activity: a type, a saved workout's Start, or an empty workout", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(1020, testInfo);
  await ownProfile(page, request, `Runner ${tag}`);
  const id = await exerciseIds(request);
  const w = await workout(request, {
    name: `Sheet ${tag}`,
    steps: [{ kind: "exercise", exercise_id: id("Burpee"), reps: 10 }],
  });
  await page.goto("/#/activity");
  const recent = page.locator(".finder-section").filter({
    has: page.getByRole("heading", { name: "Activities" }),
  });
  await expect(recent).toContainText("Nothing logged");
  await expect(page.getByRole("link", { name: "Start a workout" })).toHaveCount(
    0,
  );
  const plus = page.getByRole("button", { name: "Log an activity" });
  await expect(plus).toHaveCount(1);
  await plus.click();
  const sheet = page.getByRole("dialog");
  await expect(
    sheet.getByRole("link", { name: `Start Sheet ${tag}` }),
  ).toHaveAttribute("href", `#/workout/${w.id}/run`);
  await expect(
    sheet.getByRole("link", { name: "Empty workout" }),
  ).toBeVisible();
  await page.setViewportSize({ width: 320, height: 640 });
  await expectFits(page);
  await sheet.getByRole("link", { name: "Run", exact: true }).click();
  await expect(page).toHaveURL(/#\/activity\/new\?.*type=run/u);
  await expect(sheet).toHaveCount(0);
  await expect(page.locator("[name=type]")).toHaveValue("run");
  await expect(page.locator("[name=name]")).toHaveValue("Run");
  // The type is picked: no second pick of a workout.
  await expect(
    page.getByRole("combobox", { name: "Workout", exact: true }),
  ).toHaveCount(0);
  await page.locator("[name=minutes]").fill("30");
  await page.locator("[name=distance]").fill("6");
  const day = await page.locator("[name=day]").inputValue();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page).toHaveURL(/#\/activity$/u);
  await expect(recent.getByRole("link", { name: /^Run/u })).toContainText(
    /30\smin · 6(\.0)?\skm · active/u,
  );
  // Its pace is its view's.
  await recent.getByRole("link", { name: /^Run/u }).click();
  await expect(page.locator("dl.traits")).toContainText(/5:00\s\/km/u);
  // The Diary's Activity card names it by its type.
  await page.goto(`/#/day/${day}`);
  const row = page.locator(".activity-card .log-row", {
    has: page.locator(".kind", { hasText: /^Run$/u }),
  });
  await expect(row.getByRole("link")).toHaveAttribute(
    "href",
    /^#\/activity\/\d+/u,
  );

  // An empty workout: one of no saved workout, its sets added by hand.
  await page.goto("/#/activity");
  await plus.click();
  await sheet.getByRole("link", { name: "Empty workout" }).click();
  await expect(page).toHaveURL(/#\/activity\/new\?.*type=workout/u);
  await expect(page.locator("[name=type]")).toHaveValue("workout");
  await expect(page.locator("[name=name]")).toHaveValue("Workout");
  await expect(page.getByPlaceholder("Add an exercise")).toBeVisible();
});

test("an activity row reads active energy, real distances and its source (AC2-6, AC2-11, AC2-12)", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(1000, testInfo);
  const pid = await ownProfile(page, request, `Rows ${tag}`);
  const day = todayInApp();
  for (const data of [
    // A Google Health import's total (gross), and a device's 2 m walk.
    { name: `Typed ${tag}`, type: "workout", minutes: 60, kcal: 360 },
    { name: `Blip ${tag}`, type: "walk", minutes: 17, distance_m: 2 },
  ]) {
    const res = await request.post(`/api/profiles/${pid}/activities`, {
      data: { day, sets: [], kcal: null, ...data },
    });
    expect(res.status()).toBe(201);
  }
  const imported = (s) =>
    s.name === `Typed ${tag}`
      ? { ...s, source: "import", source_key: "gh-1", kcal_source: "import" }
      : s;
  await mockJson(page, "**/api/profiles/*/activities?*", (real) =>
    real.map((s) => imported(s)),
  );
  await mockJson(page, "**/api/profiles/*/activities/*", imported);
  await page.goto("/#/activity");
  // 360 kcal less 60 min of resting (Mifflin: 60 kg, 165 cm, female).
  const age = Number(day.slice(0, 4)) - 1990;
  const active = Math.round(360 - (600 + 1031.25 - 5 * age - 161) / 24);
  const typed = page.getByRole("link", {
    name: starts(`Typed ${tag}`),
  });
  // A total is measured: active without "≈"; the row says no more.
  await expect(typed).toContainText(
    new RegExp(`60\\smin · active\\s${active}\\skcal$`, "u"),
  );
  // 2 m is no distance and no pace; its energy the walk's estimate.
  const blip = page.getByRole("link", { name: starts(`Blip ${tag}`) });
  await expect(blip).toContainText(/17\smin · active\s≈\s43\skcal$/u);
  await expect(blip).not.toContainText("km");
  await expect(page.locator(".week")).toHaveText(
    new RegExp(`· active\\s≈\\s${active + 43}\\skcal$`, "u"),
  );
  // Its view: the total beside the active, and where it came from.
  await typed.click();
  await expect(page.locator("dl.traits dd")).toContainText([
    new RegExp(`^active\\s${active}\\skcal · 360\\stotal$`, "u"),
    "Google Health",
  ]);
});

test("Summary → Activity: activities alone are a floor, a leftover no target (AC2-10, AC2-12)", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(1001, testInfo);
  const pid = await ownProfile(page, request, `Floor ${tag}`);
  await setTarget(request, pid, "workouts_per_week", 3);
  // The device's active energy on the 2nd; only steps on the 4th.
  const res = await syncHealth(request, pid, {
    from: "2026-08-31",
    to: "2026-09-06",
    device: "Pixel 9",
    days: [
      { day: "2026-09-02", active_kcal: 512, steps: 9120 },
      { day: "2026-09-04", steps: 3811 },
    ],
    sessions: [],
  });
  expect(res.status()).toBe(200);
  for (const [day, minutes, type] of [
    ["2026-09-04", 44, "workout"],
    ["2026-09-05", 2, "other"],
  ]) {
    const r = await request.post(`/api/profiles/${pid}/activities`, {
      data: {
        day,
        name: `${type} ${tag}`,
        minutes,
        type,
        kcal: null,
        sets: [],
      },
    });
    expect(r.status()).toBe(201);
  }
  await page.goto("/#/summary/activity/week/2026-08-31");
  // 512 + (5 − 1) × 60 kg × 44 min + (4 − 1) × 60 kg × 2 min: the 4th and
  // 5th hold their activities alone, everyday movement not in them.
  await expect(
    page.getByRole("list", { name: "Daily movement" }).locator(".tile"),
  ).toContainText(["≥ 231 kcal active a day"]);
  await expect(
    page.getByRole("list", { name: "Daily movement" }).locator(".tile").first(),
  ).toHaveAccessibleDescription(
    /over the 3 days it's known since Sep 2 \(of 5 days\).*At least: on 2 days only your activities said it\.$/u,
  );
  const workouts = page.getByRole("list", { name: "Activities" });
  await expect(workouts).toContainText("1 of 3");
  // Said as the target tile's small print, not between the tile rows.
  await expect(workouts.locator(".tile-sub")).toHaveText(
    "1 activity under 5 min doesn't count",
  );
});

// The profile `ownProfile` makes: resting energy (Mifflin–St Jeor, 60 kg,
// 165 cm, born 1990, female) for `day`, and its share of `minutes`.
const restingOf = (day, minutes) =>
  ((600 + 1031.25 - 5 * (Number(day.slice(0, 4)) - 1990) - 161) * minutes) /
  1440;

test("a typed total reads as measured: Activity's row, This week and Summary's tile have no ≈", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(1102, testInfo);
  const pid = await ownProfile(page, request, `Total ${tag}`);
  const day = todayInApp();
  const res = await request.post(`/api/profiles/${pid}/activities`, {
    data: {
      day,
      name: `Typed ${tag}`,
      type: "run",
      minutes: 60,
      kcal: 355,
      sets: [],
    },
  });
  expect(res.status()).toBe(201);
  const active = Math.round(355 - restingOf(day, 60));
  await page.goto("/#/activity");
  const row = page.getByRole("link", { name: starts(`Typed ${tag}`) });
  await expect(row).toContainText(
    new RegExp(`· active\\s${active}\\skcal$`, "u"),
  );
  await expect(page.locator(".week")).toHaveText(
    new RegExp(
      `^This week · 1 activity · 1\\sh · active\\s${active}\\skcal$`,
      "u",
    ),
  );
  await page.goto(`/#/summary/activity/week/${day}`);
  const tile = page
    .getByRole("list", { name: "Activities" })
    .locator(".tile")
    .filter({ hasText: "from activities" });
  await expect(tile).toHaveText(
    new RegExp(`^${active}\\s?kcal from activities$`, "u"),
  );
});

test("kJ: a workout picked into the activity form reads its energy in kJ", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(1096, testInfo);
  await page.addInitScript(() => localStorage.setItem("energy-unit", "kJ"));
  await ownProfile(page, request, `Joules ${tag}`);
  const id = await exerciseIds(request);
  const w = await workout(request, {
    name: `Ride ${tag}`,
    steps: [{ kind: "exercise", exercise_id: id("Burpee"), reps: 10 }],
    kcal: 300,
  });
  await page.goto(`/#/activity/new?workout=${w.id}`);
  await expect(page.locator("[name=kcal]")).toHaveValue("1255");
});

test("the activity form asks for the total, says what empty does, and shows the active part as typed", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(1104, testInfo);
  await ownProfile(page, request, `Hint ${tag}`);
  await page.goto("/#/activity/new?type=run");
  const energy = page.getByLabel("Energy (kcal, total)");
  await expect(energy).toBeVisible();
  await expect(
    page.getByText(
      "What your device or machine says, resting included. Empty: estimated from time and weight.",
    ),
  ).toBeVisible();
  await page.locator("[name=minutes]").fill("60");
  const day = await page.locator("[name=day]").inputValue();
  await energy.fill("355");
  const active = Math.round(355 - restingOf(day, 60));
  await expect(page.locator(".energy-active")).toHaveText(
    new RegExp(`^active\\s${active}\\skcal · 355\\stotal$`, "u"),
  );
  // Empty again: the estimate, said as one.
  await energy.fill("");
  await expect(page.locator(".energy-active")).toHaveText(
    /^active\s≈\s\d+\skcal$/u,
  );
});

test("all activities read 6 months at a time; Show older reads the 6 before", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(1101, testInfo);
  const pid = await ownProfile(page, request, `Pages ${tag}`);
  const day = todayInApp();
  // The month `n` back from this one, as YYYY-MM.
  const month = (n) => {
    const d = new Date(`${day.slice(0, 7)}-15T12:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() - n);
    return d.toISOString().slice(0, 7);
  };
  for (const [when, name] of [
    [day, `Now ${tag}`],
    [`${month(8)}-10`, `Old ${tag}`],
  ]) {
    const res = await request.post(`/api/profiles/${pid}/activities`, {
      data: { day: when, name, minutes: 30, sets: [] },
    });
    expect(res.status()).toBe(201);
  }
  const reads = [];
  page.on("request", (r) => {
    const url = new URL(r.url());
    if (r.method() === "GET" && url.pathname.endsWith("/activities"))
      reads.push(url.search);
  });
  await page.goto("/#/activities");
  await expect(
    page.getByRole("link", { name: starts(`Now ${tag}`) }),
  ).toBeVisible();
  await expect(page.getByText(`Old ${tag}`)).toHaveCount(0);
  expect(reads).toEqual([`?from=${month(5)}-01`]);
  await page.getByRole("button", { name: "Show older" }).click();
  await expect(
    page.getByRole("link", { name: starts(`Old ${tag}`) }),
  ).toBeVisible();
  const before = new Date(`${month(5)}-01T12:00:00Z`);
  before.setUTCDate(0);
  expect(reads).toEqual([
    `?from=${month(5)}-01`,
    `?from=${month(11)}-01&to=${before.toISOString().slice(0, 10)}`,
  ]);
});

// A Diary activity nets a typed total of the day's resting energy as the
// Diary reads it (the day's `resting`, else Mifflin–St Jeor), as its
// headline does: never what another screen loaded for another profile.
test("a Diary activity nets the day's own resting energy, not another profile's", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(1156, testInfo);
  const day = await fixedToday(page);
  // Health Connect's 1,440 kcal a day (1 a minute) for the first profile.
  const rested = await ownProfile(page, request, `Rested ${tag}`);
  const at = `${day}T06:00:00Z`;
  const synced = await request.post(
    `/api/profiles/${rested}/sync/health/records`,
    {
      data: {
        device: "Pixel 9",
        records: [
          {
            kind: "BasalMetabolicRate",
            id: `bmr-${tag}`,
            start: at,
            data: {
              time: at,
              zone_offset: "Z",
              kcal_per_day: 1440,
              metadata: { data_origin: "com.google.android.apps.fitness" },
            },
          },
        ],
      },
    },
  );
  expect(synced.ok()).toBeTruthy();
  // The second has none: Mifflin–St Jeor (60 kg, 165 cm, female).
  const other = await newProfile(request, {
    name: `Mifflin ${tag}`,
    sex: "female",
    birth_date: "1990-01-01",
    height_cm: 165,
    weight_kg: 60,
  });
  const res = await request.post(`/api/profiles/${other.id}/activities`, {
    data: {
      day,
      type: "workout",
      name: `Typed ${tag}`,
      minutes: 30,
      kcal: 300,
      sets: [],
    },
  });
  expect(res.status()).toBe(201);
  // The Activity tab reads the first profile's resting energy; then the
  // second is used, its Diary opened.
  await page.goto("/#/activity");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Activity");
  await page.goto("/#/profile");
  await page.getByRole("button", { name: `Use Mifflin ${tag}` }).click();
  await expect(page).toHaveURL(/#\/$/u);
  const age = Number(day.slice(0, 4)) - 1990;
  const active = Math.round(300 - (600 + 1031.25 - 5 * age - 161) / 48);
  await expect(
    logCard(page).locator(".log-row", { hasText: `Typed ${tag}` }),
  ).toContainText(new RegExp(`active\\s${active}\\skcal$`, "u"));
});

// The device's distance records: one app's a day, `[day, metres]`.
async function walked(request, pid, days) {
  const records = days.map(([day, meters]) => {
    const at = `${day}T09:00:00Z`;
    return {
      kind: "Distance",
      id: `distance-${day}`,
      start: at,
      end: at,
      data: {
        start_time: at,
        start_zone_offset: "Z",
        end_time: at,
        end_zone_offset: "Z",
        meters,
        metadata: { data_origin: "com.google.android.apps.fitness" },
      },
    };
  });
  const res = await request.post(`/api/profiles/${pid}/sync/health/records`, {
    data: { device: "Pixel 9", records },
  });
  expect(res.ok()).toBeTruthy();
}

test("the day's distance is the device's; under its activities' it's a floor; Summary says it a day", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(1158, testInfo);
  const pid = await ownProfile(page, request, `Walked ${tag}`);
  // The 2nd: the device's 9.4 km hold the 8.2 km run. The 3rd: its 5 km
  // missed some of the run, so the day ran at least the run's.
  await walked(request, pid, [
    ["2026-09-02", 9400],
    ["2026-09-03", 5000],
  ]);
  await sync(request, pid);
  await page.goto("/#/day/2026-09-02");
  const total = logCard(page).locator("header .total > span");
  await expect(total).toHaveText([
    "9.4 km",
    "9,120 steps of 10,000",
    "active 512 kcal",
  ]);
  await page.goto("/#/day/2026-09-03");
  await expect(total.first()).toHaveText("≥ 8.2 km");
  await page.goto("/#/summary/activity/week/2026-09-02");
  const tile = page
    .getByRole("list", { name: "Daily movement" })
    .locator(".tile")
    .filter({ hasText: "km a day" });
  await expect(tile).toHaveText("7.2 km a day");
  await expect(tile).toHaveAccessibleDescription(
    "Your average distance a day, over the 2 days your device measured it: walking and the rest it counted.",
  );
});
