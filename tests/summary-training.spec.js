// The Summary's subtabs (Food · Body · Training · Habits): addresses, the
// links that keep the subtab, what each loads, and Training's calendar and
// target weeks. Every test that writes uses a profile of its own.

import { test, expect } from "@playwright/test";
import {
  dayTotal,
  exerciseIds,
  ownProfile,
  todayInApp,
  unique,
  workout,
} from "./helpers.js";

// A number and its unit as the app writes them (a no-break space).
const words = (text) =>
  new RegExp(`^${text.replace(/[().]/g, "\\$&").replaceAll(" ", "\\s")}$`);

const sections = (page) => page.getByRole("navigation", { name: "Section" });
const periods = (page) => page.getByRole("navigation", { name: "Period" });
const subtab = (page, name) =>
  sections(page).getByRole("link", { name, exact: true });
const cellOf = (page, day) => page.locator(`.cal td[data-day="${day}"]`);
// The Workouts tiles' texts.
const workoutTiles = (page) =>
  page.getByRole("list", { name: "Workouts" }).getByRole("listitem");
// Habits' default pick.
const water = (page) =>
  page
    .getByRole("radiogroup", { name: "Habit" })
    .getByRole("radio", { name: "Water" });
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
  const res = await request.post(`/api/profiles/${pid}/sessions`, {
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
    "Training",
    "Habits",
  ]);
  await expect(
    periods(page).getByRole("link", { name: "Month" }),
  ).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "October 2026",
  );
  // Section row, then ‹ title ›, then the period row.
  const top = await y(sections(page));
  const title = await y(page.getByRole("heading", { level: 1 }));
  expect(top).toBeLessThan(title);
  expect(title).toBeLessThan(await y(periods(page)));

  // Another subtab keeps the period and day; another period keeps the subtab.
  await subtab(page, "Training").click();
  await expect(page).toHaveURL(/#\/summary\/training\/month\/2026-10-08$/);
  await expect(page.locator(".workout-summary")).toBeVisible();
  await periods(page).getByRole("link", { name: "Week" }).click();
  await expect(page).toHaveURL(/#\/summary\/training\/week\/2026-10-08$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    /Oct 5 – Oct 11/,
  );
  await page.getByRole("link", { name: "Previous period" }).click();
  await expect(page).toHaveURL(/#\/summary\/training\/week\/2026-09-28$/);
  await page.reload();
  await expect(subtab(page, "Training")).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Sep 28 – Oct 4",
  );

  // Tabless addresses (the tab bar, old links) open the last subtab used.
  await page.goto("/#/summary/month/2026-10-08");
  await expect(subtab(page, "Training")).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "October 2026",
  );
  // The tab bar's `#/summary`: that subtab on this month.
  await page.goto("/#/summary");
  await expect(subtab(page, "Training")).toHaveAttribute(
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
  await expect(
    periods(page).getByRole("link", { name: "Month" }),
  ).toHaveAttribute("aria-current", "page");
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
    page.getByRole("heading", { name: "Energy by month" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "September", exact: true }).click();
  await expect(page).toHaveURL(/#\/summary\/food\/month\/2026-09-01$/);
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
  // subtab reads the shared /targets, /activity and /check-ins once
  // (web/series.mjs).
  const all = [
    ".energy-balance",
    "section.weight",
    ".workout-summary",
    ".habits-summary",
  ];
  const subtabs = [
    [
      "Food",
      ".energy-balance",
      [
        "/activity",
        "/check-ins",
        "/summary",
        "/summary",
        "/summary",
        "/targets",
        "/weights",
      ],
    ],
    [
      "Body",
      "section.weight",
      [
        "/activity",
        "/check-ins",
        "/measurements",
        "/notes",
        "/scale",
        "/targets",
        "/weights",
      ],
    ],
    [
      "Training",
      ".workout-summary",
      [
        "/activity",
        "/check-ins",
        "/plans",
        "/sessions",
        "/sessions",
        "/targets",
      ],
    ],
    [
      "Habits",
      ".habits-summary",
      [
        "/activity",
        "/check-ins",
        "/habits",
        "/habits/days",
        "/habits/days",
        "/targets",
      ],
    ],
  ];
  // Two weigh-ins, so Body shows its weight section.
  for (const [day, kg] of [
    ["2025-01-06", 70],
    ["2025-01-08", 69.8],
  ])
    await request.put(`${prefix}/weights/${day}`, { data: { kg } });
  await page.goto("/#/summary/habits/week/2025-01-06");
  await expect(water(page)).toBeChecked();
  await page.waitForLoadState("networkidle");
  for (const [name, marker, expected] of subtabs) {
    asked.length = 0;
    await subtab(page, name).click();
    await expect(page.locator(marker)).toBeVisible();
    if (name === "Habits") await expect(water(page)).toBeChecked();
    await page.waitForLoadState("networkidle");
    expect(asked.toSorted(), name).toEqual(expected);
    for (const other of all.filter((m) => m !== marker))
      await expect(page.locator(other), `${other} on ${name}`).toHaveCount(0);
  }
  // The nutrient table and "N days logged" are Food's and Habits' alone.
  await subtab(page, "Body").click();
  await expect(page.locator("section.weight")).toBeVisible();
  await expect(page.getByText(/^\d+ days? logged$/)).toHaveCount(0);
  await expect(page.locator("table.grid")).toHaveCount(0);
});

// March 2025 (Sat 1 – Mon 31) on a profile of its own: minutes on four
// days, a plan missed on its own day and one left beside a session.
async function trainingSetup(page, request, slot, testInfo) {
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

test("the training calendar shades minutes, marks plans and opens the day", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = await trainingSetup(page, request, 533, testInfo);
  await page.goto("/#/summary/training/month/2025-03-15");
  const section = page.locator(".training-summary");
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
    ["2025-03-03", "Mon, Mar 3: 1 workout, 15 min (Run)", "shade-1", "15"],
    [
      "2025-03-04",
      "Tue, Mar 4: 2 workouts, 75 min (Pull day, Run)",
      "shade-3",
      "75",
    ],
    ["2025-03-05", "Wed, Mar 5: 1 workout, 45 min (Swim)", "shade-2", "45"],
    [
      "2025-03-06",
      `Thu, Mar 6: 1 workout, 120 min (Hike) · planned Legs ${tag}, missed`,
      "shade-4",
      "120",
    ],
    ["2025-03-10", `Mon, Mar 10: planned Legs ${tag}, missed`, "shade-0", ""],
    ["2025-03-11", "Tue, Mar 11: no workout", "shade-0", ""],
  ]) {
    const c = cellOf(page, day);
    await expect(c.getByRole("link")).toHaveAccessibleName(words(label));
    await expect(c).toHaveClass(new RegExp(`\\b${shade}\\b`));
    await expect(c.locator(".cal-amount")).toHaveText(amount);
  }
  // A missed plan: a hollow dot; a rest day is never hatched.
  await expect(cellOf(page, "2025-03-10").locator(".cal-mark")).toHaveText("○");
  await expect(cellOf(page, "2025-03-06").locator(".cal-mark")).toHaveText("○");
  await expect(cellOf(page, "2025-03-04").locator(".cal-mark")).toHaveCount(0);
  await expect(section.locator("td.none")).toHaveCount(0);
  await expect(section.locator(".cal-legend")).toContainText(
    "None≤\u00a020\u00a0min20–45\u00a0min45–90\u00a0min>\u00a090\u00a0min",
  );
  await expect(section.locator(".cal-legend")).toContainText("●planned○missed");

  await cellOf(page, "2025-03-04").getByRole("link").click();
  await expect(page).toHaveURL(/#\/day\/2025-03-04$/);
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
  await page.goto(`/#/summary/training/week/${day}`);
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
    words("0 workouts"),
    words("1 planned"),
  ]);
});

test("the training year is 12 mini months that open the Training month", async ({
  page,
  request,
}, testInfo) => {
  await trainingSetup(page, request, 535, testInfo);
  await page.goto("/#/summary/training/year/2025-03-15");
  const section = page.locator(".training-summary");
  await expect(section.getByRole("table")).toHaveCount(12);
  // Colour only on screen, words for readers; no links per day, no marks.
  const tue = cellOf(page, "2025-03-04");
  await expect(tue).toHaveText(
    words("Tue, Mar 4: 2 workouts, 75 min (Pull day, Run)"),
  );
  await expect(tue).toHaveClass(/\bshade-3\b/);
  await expect(tue.getByRole("link")).toHaveCount(0);
  await expect(section.locator(".cal-mark")).toHaveCount(0);
  await section.getByRole("link", { name: "Mar", exact: true }).click();
  await expect(page).toHaveURL(/#\/summary\/training\/month\/2025-03-01$/);
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
  await page.goto("/#/summary/training/month/2025-09-15");
  await expect(workoutTiles(page)).toHaveText(
    [
      "7 workouts · 1.6 a week",
      "3 h 30 min trained",
      "700 kcal burned",
      "2 of 4 weeks at your target of 2",
    ].map(words),
  );
  // A week keeps its bar, and judges no weeks.
  await page.goto("/#/summary/training/week/2025-09-01");
  await expect(workoutTiles(page)).toHaveText(
    ["2 of 2 workouts this week", "1 h trained", "200 kcal burned"].map(words),
  );
  await expect(
    page.getByRole("progressbar", { name: "2 of 2 workouts this week" }),
  ).toHaveAttribute("value", "2");
});

// A past session's estimate uses the weigh-in in effect on its day, never
// today's; with no weigh-in at all there's no estimate.
test("a past session's estimate keeps its day's weight", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(883, testInfo);
  const pid = await ownProfile(page, request, `Then ${tag}`);
  const prefix = `/api/profiles/${pid}`;
  await request.post(`${prefix}/sessions`, {
    data: { day: "2025-03-04", name: `Walk ${tag}`, minutes: 30, sets: [] },
  });
  const burned = page
    .getByRole("list", { name: "Workouts" })
    .getByRole("listitem")
    .filter({ hasText: "burned" });
  for (const d of await (await request.get(`${prefix}/weights`)).json())
    await request.delete(`${prefix}/weights/${d.day}`);
  await page.goto("/#/summary/training/month/2025-03-01");
  await expect(burned).toHaveCount(0);
  await expect(
    page.getByText("Log a weight to estimate energy."),
  ).toBeVisible();

  // 5 MET × 80 kg × ½ h, whatever is weighed later.
  await request.put(`${prefix}/weights/2025-03-01`, { data: { kg: 80 } });
  await request.put(`${prefix}/weights/2025-06-01`, { data: { kg: 120 } });
  await page.reload();
  await expect(burned).toHaveText(/≈\s200\skcal burned$/);
});
