// The Summary tab: averages, targets over a period, charts.

import { test, expect } from "@playwright/test";
import {
  unique,
  food,
  entry,
  dayTotal,
  ownProfile,
  todayInApp,
  mockJson,
} from "./helpers.js";

test("weekly summary averages logged days", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag } = unique(12, testInfo);
  const f = await food(request, {
    name: `Pasta ${tag}`,
    per100: { energy: 350 },
  });
  await entry(request, { day, group: "Consumed", food_id: f.id, grams: 200 });

  await page.goto(`/#/summary/week/${day}`);
  await expect(page.getByText("1 day logged")).toBeVisible();
  await expect(page.locator("tr", { hasText: "Energy" }).first()).toContainText(
    /700\skcal/,
  );
  await page.getByRole("link", { name: "Month", exact: true }).click();
  await expect(page.getByText("1 day logged")).toBeVisible();
});

test("summary shows the target range and flags averages over max", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag } = unique(17, testInfo);
  const f = await food(request, {
    name: `Salt ${tag}`,
    per100: { sodium: 4000 },
  });
  await entry(request, { day, group: "Consumed", food_id: f.id, grams: 100 });
  await page.route("**/api/profiles/*/targets", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({
          json: [
            { metric: "energy", value: 2000, min: 2000, max: 2200 },
            { metric: "sodium", value: 2300, min: null, max: 2300 },
          ],
        })
      : route.continue(),
  );
  await page.goto(`/#/summary/week/${day}`);
  await expect(
    page.locator("tr", { hasText: "Energy" }).first().locator("td.range"),
  ).toHaveText("2,000");
  const salt = page.locator("tr", { hasText: "Salt" }).first();
  // The target is the number alone; the per-day cell carries the unit.
  await expect(salt.locator("td.range")).toHaveText(/^≤\s5.8$/);
  // 4000 mg against 2300 mg: 174 % of the target, shown red, nothing more.
  await expect(salt).toContainText("174 %");
  await expect(salt.locator(".over")).toHaveText("174 %");
  await expect(salt).not.toContainText("over");

  // At 320 px every value cell is one line ("2,000" never over its unit).
  await page.setViewportSize({ width: 320, height: 800 });
  const lines = await page.locator("table.grid tbody td").evaluateAll((cells) =>
    cells
      .filter((td) => td.textContent)
      .map((td) => {
        const r = document.createRange();
        r.selectNodeContents(td);
        const tops = new Set([...r.getClientRects()].map((x) => x.top));
        return [td.textContent, tops.size];
      })
      .filter(([, n]) => n > 1),
  );
  expect(lines).toEqual([]);
});

test("summary charts a week by day, a month by week and a year by month", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag } = unique(25, testInfo);
  // A year spans other tests' days, so use a profile of its own.
  const id = await ownProfile(page, request, `Year ${tag}`);
  const f = await food(request, {
    name: `Rice ${tag}`,
    per100: { energy: 100 },
  });
  await entry(
    request,
    { day, group: "Consumed", food_id: f.id, grams: 500 },
    id,
  );

  await page.goto(`/#/summary/week/${day}`);
  await expect(
    page.getByRole("heading", { name: "Energy by day" }),
  ).toBeVisible();
  // A week is by day only: no "… by" pick (the calendar's metric is one).
  await expect(page.getByRole("radiogroup", { name: / by$/ })).toHaveCount(0);
  await page.getByRole("link", { name: "Month", exact: true }).click();
  await expect(page).toHaveURL(/\/month\//);
  await expect(
    page.getByRole("heading", { name: "Energy by week" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Year", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Energy by month" }),
  ).toBeVisible();
  await expect(page.getByText("1 day logged")).toBeVisible();
  await expect(page.locator("ul.days li").first()).toContainText(/500\skcal/);
});

test("summary charts energy against the target", async ({ page }) => {
  await page.route("**/api/profiles/*/summary?*", (route) =>
    route.fulfill({
      json: {
        from: "2031-03-03",
        to: "2031-03-09",
        days_logged: 3,
        average: { energy: 2000 },
        days: [
          dayTotal("2031-03-03", 1500),
          dayTotal("2031-03-04", 2000),
          dayTotal("2031-03-05", 2500),
        ],
      },
    }),
  );
  await page.route("**/api/profiles/*/targets", (route) =>
    route.fulfill({
      json: [{ metric: "energy", value: 2000, min: 2000, max: 2200 }],
    }),
  );
  await page.goto("/#/summary/week/2031-03-05");
  const energy = page.getByRole("img", { name: /^Energy by day/ });
  await expect(energy).toHaveAccessibleName(/target 2,000\skcal/);
  // The target is a flat line drawn across the whole plot (a plugin), with
  // a legend entry of its own.
  await expect
    .poll(() =>
      energy.evaluate((canvas) => {
        const chart = window.Chart?.getChart(canvas);
        return (
          chart && {
            data: chart.data.datasets.map((d) => d.data),
            legend: chart.data.datasets.map((d) => d.label),
            plugins: chart.config.plugins.map((pl) => pl.id),
          }
        );
      }),
    )
    .toEqual({
      data: [[1500, 2000, 2500], []],
      legend: ["Energy (kcal)", "Target"],
      plugins: ["target"],
    });
  await expect(page.getByRole("img", { name: /^Macros by day/ })).toBeVisible();
});

test("the energy target line stays inside the chart when every day is under it", async ({
  page,
}) => {
  await page.route("**/api/profiles/*/summary?*", (route) =>
    route.fulfill({
      json: {
        from: "2031-03-03",
        to: "2031-03-09",
        days_logged: 2,
        average: { energy: 1550 },
        days: [dayTotal("2031-03-03", 1500), dayTotal("2031-03-04", 1600)],
      },
    }),
  );
  await page.route("**/api/profiles/*/targets", (route) =>
    route.fulfill({
      json: [{ metric: "energy", value: 2000, min: 2000, max: 2200 }],
    }),
  );
  await page.goto("/#/summary/week/2031-03-05");
  const scales = (name) =>
    page.getByRole("img", { name }).evaluate((canvas) => {
      const chart = window.Chart?.getChart(canvas);
      if (!chart) return null;
      const { top, bottom } = chart.chartArea;
      const y = chart.scales.y.getPixelForValue(2000);
      return {
        min: chart.scales.y.min,
        roomForTarget: chart.scales.y.max >= 2200,
        targetInside: y >= top && y <= bottom,
        tension: chart.data.datasets.map((d) => d.tension ?? 0),
      };
    });
  // The axis starts at zero, so day-to-day noise isn't magnified, and
  // reaches past the target; daily values aren't continuous, so no curves.
  await expect
    .poll(() => scales(/^Energy by day/))
    .toEqual({
      min: 0,
      roomForTarget: true,
      targetInside: true,
      tension: [0, 0],
    });
  await expect.poll(async () => (await scales(/^Macros by day/))?.min).toBe(0);
  expect((await scales(/^Macros by day/)).tension).toEqual([0, 0, 0]);
});

test("a month picked by day charts each logged day, and fits a phone", async ({
  page,
}) => {
  // Every day of September 2026 logged: 30 points, 30 days in the list,
  // each opening its diary.
  const days = Array.from({ length: 30 }, (_, i) =>
    dayTotal(`2026-09-${String(i + 1).padStart(2, "0")}`, 1800 + i * 10),
  );
  await page.route("**/api/profiles/*/summary?*", (route) =>
    route.fulfill({
      json: {
        from: "2026-09-01",
        to: "2026-09-30",
        days_logged: 30,
        average: { energy: 1945 },
        days,
      },
    }),
  );
  await page.setViewportSize({ width: 393, height: 800 });
  await page.goto("/#/summary/food/month/2026-09-15");
  await page
    .getByRole("radiogroup", { name: "Energy by" })
    .getByRole("radio", { name: "Day" })
    .click();
  const energy = page.getByRole("img", { name: /^Energy by day/ });
  await expect(page.getByRole("img", { name: /^Macros by day/ })).toBeVisible();
  await expect
    .poll(() =>
      energy.evaluate((canvas) => {
        const chart = window.Chart?.getChart(canvas);
        return chart && [chart.data.labels.length, chart.data.labels[0]];
      }),
    )
    .toEqual([30, "Sep 1"]);
  const list = page.locator("ul.days li");
  await expect(list).toHaveCount(30);
  await expect(list.first()).toHaveText(/^Tue, Sep 1\s*1,800\skcal$/);
  expect(
    await page.evaluate(
      () => document.scrollingElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await list.first().getByRole("link").click();
  await expect(page).toHaveURL(/#\/day\/2026-09-01$/);
});

test("the summary keeps its numbers when charts can't load", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/vendor/chart.umd.min.js", (route) => route.abort());
  await page.route("**/api/profiles/*/summary?*", (route) =>
    route.fulfill({
      json: {
        from: "2031-03-03",
        to: "2031-03-09",
        days_logged: 1,
        average: { energy: 1500 },
        days: [{ day: "2031-03-03", total: { energy: 1500 } }],
      },
    }),
  );
  await page.goto("/#/summary/week/2031-03-05");
  await expect(page.locator(".days")).toContainText(/1,500\skcal/);
  expect(errors).toEqual([]);
});

test("the energy target line spans a period of one logged day", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag } = unique(163, testInfo);
  const id = await ownProfile(page, request, `Line ${tag}`);
  const f = await food(request, {
    name: `Oats ${tag}`,
    per100: { energy: 400 },
  });
  await entry(
    request,
    { day, group: "Consumed", food_id: f.id, grams: 100 },
    id,
  );
  const targets = await (
    await request.get(`/api/profiles/${id}/targets`)
  ).json();
  const goal = targets.find((t) => t.metric === "energy").value;
  await page.goto(`/#/summary/week/${day}`);
  const energy = page.getByRole("img", { name: /^Energy by day/ });
  await expect(energy).toHaveAccessibleName(
    new RegExp(`target ${goal.toLocaleString("en-US")}\\skcal`),
  );
  await expect
    .poll(() =>
      energy.evaluate((canvas) => {
        const chart = window.Chart?.getChart(canvas);
        return chart && chart.config.plugins.map((pl) => pl.id);
      }),
    )
    .toEqual(["target"]);
  await expect(
    page.locator("tr", { hasText: "Energy" }).first().locator("td.range"),
  ).toHaveText(goal.toLocaleString("en-US"));
});

test("workout energy left unset counts as an estimate", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(164, testInfo);
  const id = await ownProfile(page, request, `Est ${tag}`);
  const day = todayInApp();
  const res = await request.post(`/api/profiles/${id}/sessions`, {
    data: { day, name: `Walk ${tag}`, minutes: 30, sets: [] },
  });
  expect(res.ok()).toBeTruthy();
  await page.goto(`/#/summary/training/week/${day}`);
  const line = page
    .getByRole("list", { name: "Workouts" })
    .getByRole("listitem")
    .filter({ hasText: "burned" });
  // 5 MET × 60 kg × ½ h. One marker: ≈, named for screen readers.
  await expect(line).toHaveText(/≈\s150\skcal burned$/);
  await expect(
    line.getByRole("img", { name: "includes estimates" }),
  ).toHaveText("≈");

  // With the energy set, it is no estimate.
  const session = await res.json();
  await request.put(`/api/profiles/${id}/sessions/${session.id}`, {
    data: { ...session, kcal: 200 },
  });
  await page.reload();
  await expect(line).toContainText(/200\skcal burned/);
  await expect(line).not.toContainText("≈");
  await expect(line.getByRole("img")).toHaveCount(0);
});

// ------------------------------------------------- what charts are by

// A chart card's pick of what its points are ("Energy by": Day | Week).
const byPick = (page, name) =>
  page.getByRole("radiogroup", { name: `${name} by`, exact: true });

// Every day of September 2026 (Tue 1 – Wed 30), 1,800 kcal up 10 a day,
// and Mon 5 and Tue 6 October at 2,000: each period gets its own days.
async function autumn(page) {
  const days = [
    ...Array.from({ length: 30 }, (_, i) =>
      dayTotal(`2026-09-${String(i + 1).padStart(2, "0")}`, 1800 + i * 10),
    ),
    dayTotal("2026-10-05", 2000),
    dayTotal("2026-10-06", 2000),
  ];
  await page.route("**/api/profiles/*/summary?*", (route) => {
    const q = new URL(route.request().url()).searchParams;
    const from = q.get("from");
    const to = q.get("to");
    const inside = days.filter((d) => d.day >= from && d.day <= to);
    return route.fulfill({
      json: {
        from,
        to,
        days_logged: inside.length,
        average: { energy: 1900 },
        days: inside,
      },
    });
  });
}

// What a chart shows: its labels and each dataset's points.
const plotted = (img) =>
  expect.poll(() =>
    img.evaluate((canvas) => {
      const chart = window.Chart?.getChart(canvas);
      return (
        chart && {
          labels: chart.data.labels,
          data: chart.data.datasets.map((d) => d.data),
        }
      );
    }),
  );

// Click the `i`th point of a drawn chart.
async function clickPoint(img, i) {
  await expect
    .poll(() => img.evaluate((canvas) => !!window.Chart?.getChart(canvas)))
    .toBe(true);
  const position = await img.evaluate((canvas, n) => {
    const { x, y } = window.Chart.getChart(canvas).getDatasetMeta(0).data[n];
    return { x, y };
  }, i);
  await img.click({ position });
}

test("a month charts by week, or by day as picked: in place, kept per period kind", async ({
  page,
}) => {
  await autumn(page);
  await page.route("**/api/profiles/*/weights?*", (route) =>
    route.fulfill({
      json: [
        { day: "2026-09-02", kg: 80 },
        { day: "2026-09-20", kg: 79 },
      ],
    }),
  );
  const asked = [];
  page.on("request", (r) => {
    if (new URL(r.url()).pathname.startsWith("/api/")) asked.push(r.url());
  });
  await page.goto("/#/summary/food/month/2026-09-15");
  const energy = page.getByRole("img", { name: /^Energy by week/ });
  await expect(
    page.getByRole("heading", { name: "Energy by week" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Macros by week" }),
  ).toBeVisible();
  for (const name of ["Energy", "Macros"]) {
    await expect(byPick(page, name).getByRole("radio")).toHaveText([
      "Day",
      "Week",
    ]);
    await expect(
      byPick(page, name).getByRole("radio", { name: "Week" }),
    ).toBeChecked();
  }
  // Weeks from Monday: Aug 31 holds Sep 1–6.
  await plotted(energy).toEqual({
    labels: ["Aug 31", "Sep 7", "Sep 14", "Sep 21", "Sep 28"],
    data: [[1825, 1890, 1960, 2030, 2080]],
  });
  const list = page.locator("ul.days li");
  await expect(list).toHaveCount(5);
  await expect(list.first()).toHaveText(
    /^Week of Mon, Aug 31\s*1,825\skcal · avg of 6 days$/,
  );
  await expect(list.first().getByRole("link")).toHaveAttribute(
    "href",
    "#/summary/food/week/2026-08-31",
  );

  // Day, picked on Macros: both charts and the list, without a reload.
  await page.waitForLoadState("networkidle");
  asked.length = 0;
  await byPick(page, "Macros").getByRole("radio", { name: "Day" }).click();
  await expect(
    page.getByRole("heading", { name: "Energy by day" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Macros by day" }),
  ).toBeVisible();
  await expect(
    byPick(page, "Energy").getByRole("radio", { name: "Day" }),
  ).toBeChecked();
  const daily = page.getByRole("img", { name: /^Energy by day/ });
  await expect
    .poll(() =>
      daily.evaluate((c) => window.Chart?.getChart(c)?.data.labels.length),
    )
    .toBe(30);
  await expect(list).toHaveCount(30);
  await expect(list.first().getByRole("link")).toHaveAttribute(
    "href",
    "#/day/2026-09-01",
  );
  expect(asked).toEqual([]);
  await expect(page).toHaveURL(/#\/summary\/food\/month\/2026-09-15$/);

  // Kept on this device; the same for Body's chart.
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Energy by day" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Body", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Weight by day" }),
  ).toBeVisible();
  await expect(
    byPick(page, "Weight").getByRole("radio", { name: "Day" }),
  ).toBeChecked();

  // A year keeps a pick of its own: by month until picked by week.
  await page.goto("/#/summary/food/year/2026-09-15");
  await expect(
    page.getByRole("heading", { name: "Energy by month" }),
  ).toBeVisible();
  await expect(byPick(page, "Energy").getByRole("radio")).toHaveText([
    "Week",
    "Month",
  ]);
  await byPick(page, "Energy").getByRole("radio", { name: "Week" }).click();
  await expect(
    page.getByRole("heading", { name: "Energy by week" }),
  ).toBeVisible();
  await expect(list).toHaveCount(6);
  await expect(list.last().getByRole("link")).toHaveAttribute(
    "href",
    "#/summary/food/week/2026-10-05",
  );
  await page.goto("/#/summary/food/month/2026-09-15");
  await expect(
    page.getByRole("heading", { name: "Energy by day" }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => [
      localStorage.getItem("summary-chart-by-month"),
      localStorage.getItem("summary-chart-by-year"),
    ]),
  ).toEqual(["day", "week"]);
});

test("a chart's points open their day, week or month", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(570, testInfo);
  const pid = await ownProfile(page, request, `Points ${tag}`);
  // Two weeks of January 2025 (Mon 6, Mon 13) and one weigh-in in February.
  for (const [day, kg] of [
    ["2025-01-06", 80],
    ["2025-01-08", 79],
    ["2025-01-13", 78],
    ["2025-01-15", 77],
    ["2025-02-03", 76],
  ])
    await request.put(`/api/profiles/${pid}/weights/${day}`, { data: { kg } });
  const section = page.locator("section.weight");

  // A month by week: each week's mean, without the daily trend.
  await page.goto("/#/summary/body/month/2025-01-10");
  const weekly = section.getByRole("img", {
    name: "Weight by week: the mean of each week's weigh-ins.",
  });
  await plotted(weekly).toEqual({
    labels: ["Jan 6", "Jan 13"],
    data: [[79.5, 77.5]],
  });
  await clickPoint(weekly, 1);
  await expect(page).toHaveURL(/#\/summary\/body\/week\/2025-01-13$/);
  await expect(
    section.getByRole("heading", { name: "Weight by day" }),
  ).toBeVisible();

  // A year by month: a month opens on the same subtab.
  await page.goto("/#/summary/body/year/2025-01-10");
  const monthly = section.getByRole("img", { name: /^Weight by month/ });
  await plotted(monthly).toEqual({
    labels: ["Jan", "Feb"],
    data: [[78.5, 76]],
  });
  await clickPoint(monthly, 0);
  await expect(page).toHaveURL(/#\/summary\/body\/month\/2025-01-01$/);

  // By day: a weigh-in opens its diary.
  await byPick(page, "Weight").getByRole("radio", { name: "Day" }).click();
  const daily = section.getByRole("img", { name: /^Weight by day/ });
  await plotted(daily).toEqual({
    labels: ["Jan 6", "Jan 8", "Jan 13", "Jan 15"],
    data: [
      [80, 79, 78, 77],
      [80, 79.5, 78.5, 77.5],
    ],
  });
  await clickPoint(daily, 1);
  await expect(page).toHaveURL(/#\/day\/2025-01-08$/);
});

// What a control looks like: its size, colours, type and shape.
const looks = (locator) =>
  locator.evaluate((el) => {
    const s = getComputedStyle(el);
    return [
      s.height,
      s.backgroundColor,
      s.color,
      s.fontSize,
      s.fontWeight,
      s.borderRadius,
      s.paddingTop,
      s.boxShadow,
    ];
  });

test("the chart pick looks like the period switch and fits a 320 px phone", async ({
  page,
}) => {
  await autumn(page);
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto("/#/summary/food/month/2026-09-15");
  const period = page
    .getByRole("navigation", { name: "Period" })
    .locator(".button.active");
  const pick = byPick(page, "Energy");
  const picked = pick.locator(".button.active");
  await expect(picked).toHaveText("Week");
  expect(await looks(picked)).toEqual(await looks(period));
  // The trays alike too.
  expect(await looks(pick)).toEqual(
    await looks(page.getByRole("navigation", { name: "Period" })),
  );
  for (const radio of await pick.getByRole("radio").all()) {
    const box = await radio.boundingBox();
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
  expect(
    await page.evaluate(
      () => document.scrollingElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

// ----------------------------------------------- one window, plain future

// Wednesday 10 September 2025, noon: the month is open.
const NOW = new Date("2025-09-10T12:00:00+03:00");
const SEP_DAYS = Array.from({ length: 10 }, (_, i) => {
  const day = `2025-09-${String(i + 1).padStart(2, "0")}`;
  return { day, total: { energy: i === 9 ? 3000 : 1800 + i * 20 } };
});

// The period's food, a night and a check-in a day through today; the
// summary answers what the server would for its range.
async function openSeptember(page) {
  await page.clock.setFixedTime(NOW);
  await mockJson(page, "**/api/profiles/*/summary?*", (real, url) => {
    const q = new URL(url).searchParams;
    const days = SEP_DAYS.filter(
      (d) => d.day >= q.get("from") && d.day <= q.get("to"),
    );
    const mean = days.reduce((t, d) => t + d.total.energy, 0) / days.length;
    return {
      ...real,
      days_logged: days.length,
      average: days.length ? { energy: mean } : {},
      days,
    };
  });
  await mockJson(page, "**/api/profiles/*/targets", (real) => [
    ...real,
    { metric: "energy", value: 2000, min: 2000, max: 2200 },
  ]);
  await mockJson(page, "**/api/profiles/*/activity?*", (real) => ({
    ...real,
    days: SEP_DAYS.map(({ day }) => ({
      day,
      asleep_min: 450,
      bedtime: "23:00",
      wake_time: "07:00",
    })),
  }));
  await mockJson(page, "**/api/profiles/*/check-ins?*", () =>
    SEP_DAYS.map(({ day }) => ({ day, mood: 4, tags: [] })),
  );
}

test("table and tiles agree", async ({ page }) => {
  await openSeptember(page);
  await page.goto("/#/summary/food/month/2025-09-10");
  // Through yesterday: Sep 1–9, 1,800 + 20·i, mean 1,880 (today's 3,000
  // left out everywhere).
  await expect(page.getByText("9 days logged through yesterday")).toBeVisible();
  await expect(
    page.locator("tr", { hasText: "Energy" }).first().locator("td").first(),
  ).toHaveText(/^1,880\skcal$/);
  const tiles = page
    .getByRole("list", { name: "Energy" })
    .getByRole("listitem");
  await expect(tiles.first()).toHaveText(/^0 of 9\s*days on target$/);
  await expect(tiles.nth(1)).toHaveText(/^1,880\skcal\s*a day$/);
});

test("future days are plain everywhere", async ({ page }) => {
  await openSeptember(page);
  const calendars = [
    ["food", ".food-cal"],
    ["body", ".sleep-cal"],
    ["body", ".check-in-cal"],
    ["training", ".training-cal"],
  ];
  for (const [tab, cal] of calendars) {
    await page.goto(`/#/summary/${tab}/month/2025-09-10`);
    const table = page.locator(cal);
    // Today is a day like any past one; tomorrow has no shade, hatch or
    // link, only its date.
    await expect(table.locator('td[data-day="2025-09-10"] a')).toHaveCount(1);
    const tomorrow = table.locator('td[data-day="2025-09-11"]');
    await expect(tomorrow, cal).toHaveClass("cal-cell future");
    await expect(tomorrow.locator("a")).toHaveCount(0);
    await expect(tomorrow).toHaveText("11");
  }
});

test("the food table's rows are one height, linked or not", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag } = unique(968, testInfo);
  const pid = await ownProfile(page, request, `Rows ${tag}`);
  const f = await food(request, {
    name: `Bread ${tag}`,
    per100: { energy: 250, protein: 9, fat: 3 },
  });
  await entry(
    request,
    { day, group: "Consumed", food_id: f.id, grams: 100 },
    pid,
  );
  await page.goto(`/#/summary/food/week/${day}`);
  const rows = page.locator("table.grid").first().locator("tbody tr");
  // Protein and fat link where they came from; carbohydrate (none) doesn't.
  await expect(rows.locator("th a")).not.toHaveCount(0);
  await expect(rows.filter({ hasNot: page.locator("th a") })).not.toHaveCount(
    0,
  );
  const heights = await rows.evaluateAll((trs) => [
    ...new Set(trs.map((tr) => Math.round(tr.getBoundingClientRect().height))),
  ]);
  expect(heights).toHaveLength(1);
});
