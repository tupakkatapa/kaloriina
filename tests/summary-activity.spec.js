// The Summary's subtabs (Food · Body · Activity · Habits): addresses, the
// links that keep the subtab, what each loads, and Activity's calendar and
// target weeks. Every test that writes uses a profile of its own.

import { expect, test } from "@playwright/test";
import {
  dayTotal,
  exerciseIds,
  fixedToday,
  ownProfile,
  setTarget,
  syncHealth,
  todayInApp,
  unique,
  workout,
} from "./helpers.js";

// One today for the whole test, in the page and here.
test.beforeEach(({ page }) => fixedToday(page));

// A number and its unit as the app writes them (a no-break space).
const words = (text) =>
  new RegExp(
    `^${text.replaceAll(/[().]/gu, "\\$&").replaceAll(" ", "\\s")}$`,
    "u",
  );

const sections = (page) => page.getByRole("navigation", { name: "Section" });
const periods = (page) => page.getByRole("navigation", { name: "Period" });
// The period picked, as the title's popover marks it (shown or not).
const picked = (page) => page.locator('#period-pick a[aria-current="page"]');
// Open the title's popover and pick period `name`.
async function pickPeriod(page, name) {
  await page.locator(".period-title").click();
  await periods(page).getByRole("link", { name }).click();
}
const subtab = (page, name) =>
  sections(page).getByRole("link", { name, exact: true });
const cellOf = (page, day) => page.locator(`.cal td[data-day="${day}"]`);
// The Activities tiles' texts.
const workoutTiles = (page) =>
  page.getByRole("list", { name: "Activities" }).locator(".tile");
// Habits' default pick.
const hydration = (page) =>
  page
    .getByRole("radiogroup", { name: "Habit" })
    .getByRole("radio", { name: "Hydration" });
// The month today is in, as the Summary titles it.
const thisMonth = () =>
  new Date(`${todayInApp()}T12:00:00Z`).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
// An element's top on the page.
const y = async (locator) => (await locator.boundingBox()).y;

async function session(request, pid, data) {
  const res = await request.post(`/api/profiles/${pid}/activities`, {
    data: { sets: [], ...data },
  });
  expect(res.status()).toBe(201);
  return res.json();
}

async function plan(request, pid, day, workoutId) {
  const res = await request.post(`/api/profiles/${pid}/plans`, {
    data: { day, workout_id: workoutId },
  });
  expect(res.status()).toBe(201);
}

async function legs(request, tag) {
  const id = await exerciseIds(request);
  return workout(request, {
    name: `Legs ${tag}`,
    steps: [{ kind: "exercise", exercise_id: id("Burpee"), reps: 10 }],
  });
}

test("the section row sits on top; subtab and period carry across", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(530, testInfo);
  await ownProfile(page, request, `Tabs ${tag}`);
  await page.goto("/#/summary/body/month/2026-10-08");
  await expect(subtab(page, "Body")).toHaveAttribute("aria-current", "page");
  await expect(sections(page).getByRole("link")).toHaveText([
    "Food",
    "Body",
    "Activity",
    "Habits",
  ]);
  await expect(picked(page)).toHaveText("Month");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "October 2026",
  );
  // Section row, then ‹ title ›; the periods open from the title.
  const top = await y(sections(page));
  const title = await y(page.getByRole("heading", { level: 1 }));
  expect(top).toBeLessThan(title);
  await expect(periods(page)).toBeHidden();

  // Another subtab keeps the period and day; another period keeps the subtab.
  await subtab(page, "Activity").click();
  await expect(page).toHaveURL(/#\/summary\/activity\/month\/2026-10-08$/u);
  await expect(page.locator(".activity-summary")).toBeVisible();
  await pickPeriod(page, "Week");
  await expect(page).toHaveURL(/#\/summary\/activity\/week\/2026-10-08$/u);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    /^10\/5\s–\s10\/11$/u,
  );
  await page.getByRole("link", { name: "Previous week" }).click();
  await expect(page).toHaveURL(/#\/summary\/activity\/week\/2026-09-28$/u);
  await page.reload();
  await expect(subtab(page, "Activity")).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    /^9\/28\s–\s10\/4$/u,
  );

  // Tabless addresses (the tab bar, old links) open the last subtab used.
  await page.goto("/#/summary/month/2026-10-08");
  await expect(subtab(page, "Activity")).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "October 2026",
  );
  // The tab bar's `#/summary`: that subtab on this month.
  await page.goto("/#/summary");
  await expect(subtab(page, "Activity")).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(subtab(page, "Body")).not.toHaveAttribute("aria-current");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(thisMonth());
});

test("a first visit opens Food on this month; a year's months stay on Food", async ({
  page,
}) => {
  await page.goto("/#/summary");
  await expect(subtab(page, "Food")).toHaveAttribute("aria-current", "page");
  await expect(picked(page)).toHaveText("Month");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(thisMonth());

  await page.route("**/api/profiles/*/summary?*", (route) =>
    route.fulfill({
      json: {
        from: "2026-01-01",
        to: "2026-12-31",
        days_logged: 2,
        average: { energy: 2000 },
        days: [dayTotal("2026-09-01", 1800), dayTotal("2026-09-08", 2200)],
      },
    }),
  );
  await page.goto("/#/summary/year/2026-09-15");
  await expect(
    page.getByRole("heading", { name: "Energy by week" }),
  ).toBeVisible();
  // The calendar's month opens it (the chart's points too).
  await page
    .locator(".food-calendar")
    .getByRole("link", { name: "Sep", exact: true })
    .click();
  await expect(page).toHaveURL(/#\/summary\/food\/month\/2026-09-01$/u);
  await expect(subtab(page, "Food")).toHaveAttribute("aria-current", "page");
});

test("each subtab shows and loads only its own", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(532, testInfo);
  const pid = await ownProfile(page, request, `Load ${tag}`);
  const asked = [];
  const prefix = `/api/profiles/${pid}`;
  page.on("request", (r) => {
    const { pathname } = new URL(r.url());
    if (pathname.startsWith(prefix)) asked.push(pathname.slice(prefix.length));
  });
  // The marker each subtab's content shows, and what's never on it. Every
  // subtab reads the shared sources once, over one union range each
  // (web/series.mjs: /targets, /device-days, /check-ins, /summary, /activities,
  // /weights, /scale, /habits/days for caffeine, and the hidden or pinned
  // /insights/prefs), and slices
  // the period's reads from them, the energy burned and maintenance
  // included: Food sets no energy target, so reads nothing about today.
  // Food without food: its empty line (no balance heading alone).
  const all = [
    ".food-nothing",
    "section.weight",
    ".activity-summary",
    ".habits-summary",
  ];
  const shared = [
    "/activities",
    "/check-ins",
    "/device-days",
    "/habits/days",
    "/insights/prefs",
    "/scale",
    "/summary",
    "/targets",
    "/weights",
  ];
  const subtabs = [
    ["Food", ".food-nothing", shared],
    [
      "Body",
      "section.weight",
      [...shared, "/measurements", "/notes"].toSorted(),
    ],
    ["Activity", ".activity-summary", [...shared, "/plans"].toSorted()],
    [
      "Habits",
      ".habits-summary",
      [...shared, "/habits", "/habits/days", "/habits/days"].toSorted(),
    ],
  ];
  // Two weigh-ins, so Body shows its weight section.
  for (const [day, kg] of [
    ["2025-01-06", 70],
    ["2025-01-08", 69.8],
  ])
    await request.put(`${prefix}/weights/${day}`, { data: { kg } });
  await page.goto("/#/summary/habits/week/2025-01-06");
  await expect(hydration(page)).toBeChecked();
  await page.waitForLoadState("networkidle");
  for (const [name, marker, expected] of subtabs) {
    asked.length = 0;
    await subtab(page, name).click();
    await expect(page.locator(marker)).toBeVisible();
    if (name === "Habits") await expect(hydration(page)).toBeChecked();
    await page.waitForLoadState("networkidle");
    expect(asked.toSorted(), name).toEqual(expected);
    for (const other of all.filter((m) => m !== marker))
      await expect(page.locator(other), `${other} on ${name}`).toHaveCount(0);
  }
  // The nutrient table and "N days logged" are Food's and Habits' alone.
  await subtab(page, "Body").click();
  await expect(page.locator("section.weight")).toBeVisible();
  await expect(page.getByText(/^\d+ days? logged$/u)).toHaveCount(0);
  await expect(page.locator("table.grid")).toHaveCount(0);
});

// March 2025 (Sat 1 – Mon 31) on a profile of its own: minutes on four
// days, a plan missed on its own day and one left beside a session.
async function activitySetup(page, request, slot, testInfo) {
  const { tag } = unique(slot, testInfo);
  const pid = await ownProfile(page, request, `Train ${tag}`);
  const w = await legs(request, tag);
  for (const [day, name, minutes] of [
    ["2025-03-03", "Run", 15],
    ["2025-03-04", "Pull day", 40],
    ["2025-03-04", "Run", 35],
    ["2025-03-05", "Swim", 45],
    ["2025-03-06", "Hike", 120],
  ])
    await session(request, pid, { day, name, minutes, kcal: 100 });
  await plan(request, pid, "2025-03-06", w.id);
  await plan(request, pid, "2025-03-10", w.id);
  return { pid, tag, w };
}

test("the activity calendar shades minutes, marks plans and opens the day", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = await activitySetup(page, request, 533, testInfo);
  await page.goto("/#/summary/activity/month/2025-03-15");
  const section = page.locator(".activity-calendar");
  const table = section.getByRole("table");
  await expect(table.getByRole("columnheader")).toHaveText([
    "Mon",
    "Tue",
    "Wed",
    "Thu",
    "Fri",
    "Sat",
    "Sun",
  ]);
  for (const [day, label, shade, amount] of [
    ["2025-03-03", "Mon, Mar 3: 1 activity, 15 min (Run)", "shade-1", "15"],
    [
      "2025-03-04",
      "Tue, Mar 4: 2 activities, 75 min (Pull day, Run)",
      "shade-3",
      "75",
    ],
    ["2025-03-05", "Wed, Mar 5: 1 activity, 45 min (Swim)", "shade-2", "45"],
    [
      "2025-03-06",
      `Thu, Mar 6: 1 activity, 120 min (Hike) · planned Legs ${tag}, missed`,
      "shade-4",
      "120",
    ],
    ["2025-03-10", `Mon, Mar 10: planned Legs ${tag}, missed`, "shade-0", ""],
    ["2025-03-11", "Tue, Mar 11: no activity", "shade-0", ""],
  ]) {
    const c = cellOf(page, day);
    await expect(c.getByRole("link")).toHaveAccessibleName(words(label));
    await expect(c).toHaveClass(new RegExp(`\\b${shade}\\b`, "u"));
    await expect(c.locator(".cal-amount")).toHaveText(amount);
  }
  // A missed plan: a hollow dot; a rest day is never hatched.
  await expect(cellOf(page, "2025-03-10").locator(".cal-mark")).toHaveText("○");
  await expect(cellOf(page, "2025-03-06").locator(".cal-mark")).toHaveText("○");
  await expect(cellOf(page, "2025-03-04").locator(".cal-mark")).toHaveCount(0);
  // Only the days before anything was tracked (Mar 1–2) are.
  await expect(section.locator("td.none")).toHaveCount(2);
  await expect(
    cellOf(page, "2025-03-02").getByRole("link"),
  ).toHaveAccessibleName(words("Sun, Mar 2: not tracked"));
  await expect(section.locator(".cal-legend")).toContainText(
    "0≤\u00A020\u00A0min20–45\u00A0min45–90\u00A0min>\u00A090\u00A0min",
  );
  await expect(section.locator(".cal-legend")).toContainText("●planned○missed");

  // A day opens the Diary.
  await cellOf(page, "2025-03-04").getByRole("link").click();
  await expect(page).toHaveURL(/#\/day\/2025-03-04$/u);
});

test("a plan today or later is a filled dot", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(534, testInfo);
  const pid = await ownProfile(page, request, `Ahead ${tag}`);
  const w = await legs(request, tag);
  const day = todayInApp();
  await plan(request, pid, day, w.id);
  await page.goto(`/#/summary/activity/week/${day}`);
  const c = cellOf(page, day);
  const pretty = new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
  await expect(c.getByRole("link")).toHaveAccessibleName(
    `${pretty}: planned Legs ${tag}`,
  );
  await expect(c.locator(".cal-mark")).toHaveText("●");
  await expect(workoutTiles(page)).toHaveText([
    words("0 activities"),
    words("1 planned"),
  ]);
});

test("the activity year is 12 mini months that open the Activity month", async ({
  page,
  request,
}, testInfo) => {
  await activitySetup(page, request, 535, testInfo);
  await page.goto("/#/summary/activity/year/2025-03-15");
  const section = page.locator(".activity-calendar");
  await expect(section.getByRole("table")).toHaveCount(12);
  // Colour only on screen, words for readers; no links per day, no marks.
  const tue = cellOf(page, "2025-03-04");
  await expect(tue).toHaveText(
    words("Tue, Mar 4: 2 activities, 75 min (Pull day, Run)"),
  );
  await expect(tue).toHaveClass(/\bshade-3\b/u);
  await expect(tue.getByRole("link")).toHaveCount(0);
  await expect(section.locator(".cal-mark")).toHaveCount(0);
  await section.getByRole("link", { name: "Mar", exact: true }).click();
  await expect(page).toHaveURL(/#\/summary\/activity\/month\/2025-03-01$/u);
});

test("a month counts the weeks that met the weekly target", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(536, testInfo);
  const pid = await ownProfile(page, request, `Target ${tag}`);
  const { rev } = await (await request.get(`/api/profiles/${pid}`)).json();
  expect(
    (
      await request.put(`/api/profiles/${pid}/targets`, {
        data: { rev, targets: [{ metric: "workouts_per_week", value: 2 }] },
      })
    ).ok(),
  ).toBeTruthy();
  // Weighed before: each run's typed 100 kcal nets of resting (Mifflin at
  // 60 kg, 165 cm, 35: 1,295.25 a day, 27 in 30 min) to 73 active.
  await request.put(`/api/profiles/${pid}/weights/2025-08-31`, {
    data: { kg: 60 },
  });
  // September 2025: Mon 1 – Tue 30; whole weeks from the 1st, 8th, 15th
  // and 22nd. Met: the 1st's and the 15th's. The 29th and 30th are a week
  // the month doesn't hold whole.
  for (const day of [
    "2025-09-01",
    "2025-09-03",
    "2025-09-10",
    "2025-09-15",
    "2025-09-21",
    "2025-09-29",
    "2025-09-30",
  ])
    await session(request, pid, { day, name: "Run", minutes: 30, kcal: 100 });
  await page.goto("/#/summary/activity/month/2025-09-15");
  await expect(workoutTiles(page)).toHaveText(
    [
      "7 activities · 1.6 a week",
      "3 h 30 min active",
      "511 kcal from activities",
      "2 of 4 weeks at your target of 2",
    ].map((x) => words(x)),
  );
  // A week keeps its bar, and judges no weeks.
  await page.goto("/#/summary/activity/week/2025-09-01");
  await expect(workoutTiles(page)).toHaveText(
    [
      "2 of 2 activities this week",
      "1 h active",
      "146 kcal from activities",
    ].map((x) => words(x)),
  );
  await expect(
    page.getByRole("progressbar", { name: "2 of 2 activities this week" }),
  ).toHaveAttribute("value", "2");
});

// A past session's estimate uses the weigh-in in effect on its day, never
// today's; with no weigh-in at all there's no estimate.
test("a past activity's estimate keeps its day's weight", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(883, testInfo);
  const pid = await ownProfile(page, request, `Then ${tag}`);
  const prefix = `/api/profiles/${pid}`;
  await request.post(`${prefix}/activities`, {
    data: { day: "2025-03-04", name: `Walk ${tag}`, minutes: 30, sets: [] },
  });
  const burned = page
    .getByRole("list", { name: "Activities" })
    .locator(".tile")
    .filter({ hasText: "from activities" });
  for (const d of await (await request.get(`${prefix}/weights`)).json())
    await request.delete(`${prefix}/weights/${d.day}`);
  await page.goto("/#/summary/activity/month/2025-03-01");
  await expect(burned).toHaveCount(0);
  await expect(
    page.getByText("Log a weight to estimate energy."),
  ).toBeVisible();

  // Net of resting, (5 − 1) MET × 80 kg × ½ h, whatever is weighed later.
  await request.put(`${prefix}/weights/2025-03-01`, { data: { kg: 80 } });
  await request.put(`${prefix}/weights/2025-06-01`, { data: { kg: 120 } });
  await page.reload();
  await expect(burned).toHaveText(/≈\s160\skcal from activities$/u);
});

test("Daily movement says active energy and steps a day, and the days at the steps target", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(71, testInfo);
  const pid = await ownProfile(page, request, `Moves ${tag}`);
  await setTarget(request, pid, "steps", 10_000);
  const days = ["2026-09-07", "2026-09-08", "2026-09-09"];
  const res = await syncHealth(request, pid, {
    from: days[0],
    to: days.at(-1),
    device: "Pixel 9",
    days: days.map((day, i) => ({
      day,
      steps: [12_000, 8000, 10_500][i],
      active_kcal: [300, 400, 500][i],
    })),
  });
  expect(res.status()).toBe(200);
  await page.goto("/#/summary/activity/week/2026-09-07");
  const tiles = page
    .getByRole("list", { name: "Daily movement" })
    .locator(".tile");
  // A mean a day, as steps are: a total over a varying count of days
  // compares with nothing.
  await expect(tiles).toHaveText([
    words("400 kcal active a day"),
    words("10,167 steps a day"),
    words("2 of 3 days at steps target"),
  ]);
  await expect(tiles.first()).toHaveAccessibleDescription(
    /over the 3 days it's known/u,
  );
});
