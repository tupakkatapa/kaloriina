// Health Connect activity from the Android companion: the diary's Log card,
// the session editor, Summary → Training and Profile → Connections, fed through
// `sync/health` as the app posts it.
// Every test uses a profile of its own; days are in August–September 2026,
// before any server's today.

import { test, expect } from "@playwright/test";
import { answer, ownProfile, unique } from "./helpers.js";

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
  const res = await request.post(health(pid), {
    data: {
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
    },
  });
  expect(res.status()).toBe(200);
  return res.json();
}

async function logged(request, pid, day) {
  const res = await request.post(`/api/profiles/${pid}/sessions`, {
    data: { day, name: "Pull day", minutes: 30, kcal: 100, sets: [] },
  });
  expect(res.ok()).toBeTruthy();
}

const card = (page) => page.locator(".connections .health");
const logCard = (page) => page.locator(".log-card");

test("the Log card shows the night, the activity and watch runs as workouts", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(550, testInfo);
  const pid = await ownProfile(page, request, `Watch ${tag}`);
  await sync(request, pid);
  await logged(request, pid, "2026-09-02");
  await page.goto("/#/day/2026-09-02");
  const log = logCard(page);
  await expect(log.locator(".activity-line")).toHaveText(
    "Active ≈ 512 kcal · 9,120 steps",
  );
  await expect(log.locator(".night-line")).toHaveText(
    "7 h 20 min asleep · 23:40–07:05 · RHR 54 · HRV 48 ms",
  );
  // The watch's run is a workout done like any other: it opens.
  const run = log.getByRole("link", { name: /^Running/ });
  await expect(run).toContainText(
    "46 min · 8.2 km · 5:37 /km · 410 kcal · Health Connect",
  );
  await expect(log.locator(".log-row .kind")).toHaveText([
    "Workout",
    "Workout",
    "Activity",
    "Night",
  ]);
  // Nothing waits in auto mode.
  await expect(log.getByRole("button", { name: /^Add / })).toHaveCount(0);
});

test("a watch workout keeps the watch's fields, and stays deleted", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(650, testInfo);
  const pid = await ownProfile(page, request, `Edit ${tag}`);
  await sync(request, pid);
  await page.goto("/#/day/2026-09-02");
  await logCard(page)
    .getByRole("link", { name: /^Running/ })
    .click();
  await expect(
    page.getByText("From your watch (Health Connect)"),
  ).toBeVisible();
  for (const label of [
    "Day",
    "Duration (min)",
    /^Energy \(kcal\)/,
    "Distance (km)",
    "Start time",
  ])
    await expect(page.getByLabel(label, { exact: true })).toBeDisabled();
  const type = page.getByRole("combobox", { name: "Type", exact: true });
  await expect(type).toBeDisabled();
  await expect(type).toHaveValue("run");
  await expect(page.getByLabel("Distance (km)")).toHaveValue("8.2");
  // 14:02 UTC is 17:02 in Helsinki.
  await expect(page.getByLabel("Start time", { exact: true })).toHaveValue(
    "17:02",
  );
  // The name is yours.
  await page.getByLabel("Name", { exact: true }).fill("Tempo run");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(
    logCard(page).getByRole("link", { name: /^Tempo run/ }),
  ).toBeVisible();

  await logCard(page)
    .getByRole("link", { name: /^Tempo run/ })
    .click();
  await page.getByRole("button", { name: "Delete" }).click();
  expect(await answer(page, "Delete")).toBe(
    "Delete Tempo run on Wed, Sep 2? It won't come back on the next sync.",
  );
  await sync(request, pid);
  await page.goto("/#/day/2026-09-02");
  await expect(logCard(page).locator(".night-line")).toBeVisible();
  await expect(logCard(page)).not.toContainText("Running");
  await expect(logCard(page)).not.toContainText("Tempo run");
});

test("in ask mode watch workouts wait with Add and Dismiss", async ({
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
  await expect(log.getByRole("link", { name: /^Running/ })).toHaveCount(1);
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
  await expect(log.getByRole("link", { name: /^Running/ })).toHaveCount(1);
  await expect(log.locator(".log-row.pending")).toHaveCount(0);
});

test("Summary → Training counts watch workouts and their distance", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(551, testInfo);
  const pid = await ownProfile(page, request, `Steps ${tag}`);
  await sync(request, pid);
  await logged(request, pid, "2026-09-02");
  await page.goto("/#/summary/training/week/2026-08-31");
  await expect(
    page.getByRole("list", { name: "Activity" }).getByRole("listitem"),
  ).toHaveText([
    "≈ 912 kcal active energy",
    "8,560 steps a day",
    "16.4 km covered",
  ]);
  await expect(page.locator("ul.activity-summary")).toBeVisible();
  // The watch's runs are workouts done; active energy stays apart.
  const workouts = page.getByRole("list", { name: "Workouts" });
  await expect(workouts).toContainText("3 workouts");
  await expect(workouts).toContainText("920 kcal burned");
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
    "Last sync just now: 2 days, 1 night, 2 workouts (Pixel 9)",
  );
  await expect(card(page)).not.toContainText("Synced from");
  await sync(request, pid, "Pixel 7");
  await page.reload();
  await expect(card(page)).toContainText(
    "Synced from Pixel 7 and Pixel 9. Workouts aren't removed while two phones sync.",
  );

  // Its options are too long for a segmented row: a select.
  const mode = card(page).getByRole("combobox", { name: "Synced workouts" });
  await expect(mode).toHaveValue("auto");
  await expect(card(page)).toContainText(
    "Walks your watch noticed on its own wait here until you add them.",
  );
  await mode.selectOption("ask");
  await expect
    .poll(async () => (await (await request.get(health(pid))).json()).workouts)
    .toBe("ask");

  await card(page).getByRole("button", { name: "Remove synced data" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText(
    "Removes synced days, sleep and the workouts the app added. Workouts you logged keep the watch's details.",
  );
  expect(await answer(page, "Remove")).toBe("Remove synced data?");
  await expect(card(page)).toContainText("Nothing synced yet");
  const left = await (
    await request.get(`/api/profiles/${pid}/activity`)
  ).json();
  expect(left).toEqual({ days: [], sessions: [] });
  const sessions = await (
    await request.get(`/api/profiles/${pid}/sessions`)
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
    "Last sync 3 days ago: 2 days, 1 night, 2 workouts (Pixel 9)",
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
  ).toHaveAttribute("href", /kaloriina#android$/);
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
    "Last sync just now: 2 days, 1 night, 1 workout (Pixel 9) · 2 items skipped (invalid)",
  );
});

test("a pending walk shows on Workouts", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(900, testInfo);
  const pid = await ownProfile(page, request, `Waiting ${tag}`);
  // Walks the watch detected by itself wait, on any day, in auto mode too.
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
    .getByRole("link", { name: "2 watch workouts wait: see Workouts" })
    .click();
  const waiting = page.locator(".finder-section").filter({
    has: page.getByRole("heading", { name: "Waiting from your watch (2)" }),
  });
  await expect(waiting.locator(".log-row.pending")).toHaveText([
    /Wed, Sep 2.*Walking11:00 · 40\smin/,
    /Sat, Sep 5.*Walking11:00 · 40\smin/,
  ]);
  // Above what was done.
  await expect(page.locator(".finder-section h2")).toHaveText([
    "Workouts",
    "Waiting from your watch (2)",
    "Recently done",
    "Exercises",
  ]);
  // The rows fit a narrow phone.
  await page.setViewportSize({ width: 320, height: 640 });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(320);
  await page.screenshot({ path: testInfo.outputPath("waiting-320.png") });
  await waiting
    .getByRole("button", { name: "Dismiss Walking on Sat, Sep 5 at 11:00" })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Dismiss" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Waiting from your watch (1)" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Add Walking on Wed, Sep 2 at 11:00" })
    .click();
  await expect(page.getByRole("heading", { name: /^Waiting/ })).toHaveCount(0);
  const done = page
    .locator(".finder-section")
    .filter({ has: page.getByRole("heading", { name: "Recently done" }) });
  await expect(done.getByRole("link", { name: /^Walking/ })).toContainText(
    "Wed, Sep 2",
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
  await expect(page.getByText(/No readings yet/)).toHaveCount(0);
});
