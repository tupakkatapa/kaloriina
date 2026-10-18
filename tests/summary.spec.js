// The Summary tab: averages, targets over a period, charts.

import { setTimeout as delay } from "node:timers/promises";
import { expect, test } from "@playwright/test";
import {
  dayTotal,
  entry,
  expectFits,
  fixedToday,
  food,
  mockJson,
  ownProfile,
  setTarget,
  syncHealth,
  todayInApp,
  unique,
} from "./helpers.js";

// One today for the whole test, in the page and here.
test.beforeEach(({ page }) => fixedToday(page));

// Open the title's period popover and pick `name` (Week, Month, Year).
async function pickPeriod(page, name) {
  await page.locator(".period-title").click();
  await page
    .getByRole("navigation", { name: "Period" })
    .getByRole("link", { name, exact: true })
    .click();
}

// A daily average's bar (the Diary's) by its nutrient's name: on the
// targets card's page shown, else in the fold.
const averageBar = (page, name) =>
  page
    .locator(".daily-averages :not([inert]) > .target", {
      has: page.locator(".target-label > span:first-child", {
        hasText: new RegExp(`^${name}$`, "u"),
      }),
    })
    .first();

// Daily averages' page of Highlighted nutrients (the Diary's card).
const showHighlighted = (page) =>
  page
    .locator(".daily-averages")
    .getByRole("button", { name: "Highlighted" })
    .click();

// The energy chart's numbers, a list for screen readers.
const energyList = (page) =>
  page.locator(".chart-section").first().locator("ul.sr-only li");

// Energy balance's one line: eaten, burned and the gap a day.
const balanceLine = (page) => page.locator(".balance-line");

test("weekly summary averages logged days", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag } = unique(12, testInfo);
  const f = await food(request, {
    name: `Pasta ${tag}`,
    per100: { energy: 350 },
  });
  await entry(request, { day, group: "Eaten", food_id: f.id, grams: 200 });

  await page.goto(`/#/summary/week/${day}`);
  await expect(
    page.getByRole("heading", { name: /^Daily averages/u }),
  ).toBeVisible();
  await expect(averageBar(page, "Energy").locator(".target-label")).toHaveText(
    /^Energy\s*700\skcal/u,
  );
  await pickPeriod(page, "Month");
  await expect(
    page.getByRole("heading", { name: /^Daily averages/u }),
  ).toBeVisible();
});

test("summary shows the target range and flags averages over max", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag } = unique(17, testInfo);
  const f = await food(request, {
    name: `Salt ${tag}`,
    per100: { energy: 100, sodium: 4000 },
  });
  await entry(request, { day, group: "Eaten", food_id: f.id, grams: 100 });
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
  // The energy target is the chart's: a min–max range, one field, said
  // once for screen readers.
  await expect(
    energyList(page).filter({ hasText: /^Eaten target/u }),
  ).toHaveText([/^Eaten target: 2,000\skcal–2,200\skcal$/u]);
  // Salt's bar (Highlighted): its mean against the range, over. 4000 mg of
  // sodium against 2300 mg is over.
  await showHighlighted(page);
  const salt = averageBar(page, "Salt");
  await expect(salt.locator(".target-label")).toHaveText(
    // The target without its goal sign: "≥" on a bar is a floor only;
    // the status line says over or under.
    /^Salt\s*10\sg \/ 5.8\sg$/u,
  );
  await expect(salt).toHaveClass(/\bover\b/u);
  // A compact bar's status is its tooltip (web/tips.mjs), a phone's too.
  await expect(salt.getByRole("img")).toHaveAccessibleDescription(
    /over target$/u,
  );

  // At 320 px everything stays on screen.
  await page.setViewportSize({ width: 320, height: 800 });
  await expectFits(page);
});

test("at 320 px a 4-digit mg average fits Other nutrients", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag } = unique(316, testInfo);
  const f = await food(request, {
    name: `Bran ${tag}`,
    per100: {
      energy: 100,
      phosphorus: 2000,
      monounsaturated: 5,
      phenylalanine: 1,
    },
  });
  await entry(request, { day, group: "Eaten", food_id: f.id, grams: 100 });
  await page.route("**/api/profiles/*/targets", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({
          json: [{ metric: "phosphorus", value: 550, min: 550, max: null }],
        })
      : route.continue(),
  );
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto(`/#/summary/week/${day}`);
  await page.getByText("Other nutrients").click();
  const bar = averageBar(page, "Phosphorus");
  await expect(bar.locator(".target-label")).toHaveText(
    /^Phosphorus\s*2,000\smg \/ 550\smg$/u,
  );
  // The fold as the Diary's: the status under the bar.
  await expect(bar.locator("small")).toHaveText("Target met");
  const spill = await page.locator("details.all-targets").evaluate((fold) => ({
    widest: Math.max(
      ...[...fold.querySelectorAll("*")].map(
        (n) => n.getBoundingClientRect().right,
      ),
    ),
    fold: fold.getBoundingClientRect().right,
  }));
  expect(spill.widest).toBeLessThanOrEqual(spill.fold + 0.5);
  await expectFits(page);
});

test("charts follow the period: a week and a month by day, a year by week, no pick (item 11)", async ({
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
  await entry(request, { day, group: "Eaten", food_id: f.id, grams: 500 }, id);

  await page.goto(`/#/summary/week/${day}`);
  await expect(
    page.getByRole("heading", { name: "Energy by day" }),
  ).toBeVisible();
  // No "… by" pick anywhere: the period is the one choice.
  await expect(page.getByRole("radiogroup", { name: / by$/u })).toHaveCount(0);
  await pickPeriod(page, "Month");
  await expect(page).toHaveURL(/\/month\//u);
  await expect(
    page.getByRole("heading", { name: "Energy by day" }),
  ).toBeVisible();
  await expect(page.getByRole("radiogroup", { name: / by$/u })).toHaveCount(0);
  await pickPeriod(page, "Year");
  await expect(
    page.getByRole("heading", { name: "Energy by week" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: /^Daily averages/u }),
  ).toBeVisible();
  await expect(energyList(page).first()).toHaveText(
    /^Week of Mon, \w{3} \d+: eaten 500\skcal/u,
  );
});

// A drawn chart's legend, as it reads.
const legendOf = (img) =>
  img.evaluate((c) =>
    window.Chart?.getChart(c)?.legend.legendItems.map((i) => i.text),
  );

test("one chart, its tabs Energy · Protein · Carbs · Fat; each target the eaten one's (items 13, 17, 21)", async ({
  page,
}) => {
  await page.route("**/api/profiles/*/summary?*", (route) =>
    route.fulfill({
      json: {
        from: "2031-03-03",
        to: "2031-03-09",
        // Every food carries protein: no day of it is a floor.
        days: [1500, 2000, 2500].map((kcal, i) => ({
          day: `2031-03-0${i + 3}`,
          total: { energy: kcal, protein: kcal / 20 },
        })),
      },
    }),
  );
  await page.route("**/api/profiles/*/targets", (route) =>
    route.fulfill({
      json: [
        { metric: "energy", value: 2000 },
        { metric: "protein", value: 120 },
      ],
    }),
  );
  await page.goto("/#/summary/week/2031-03-05");
  // Owner (2026-10-14): one chart card, its tabs the four.
  await expect(page.locator(".chart-section")).toHaveCount(1);
  const tabs = page.getByRole("radiogroup", { name: "Chart" });
  await expect(tabs.getByRole("radio")).toHaveText([
    "Energy",
    "Protein",
    "Carbs",
    "Fat",
  ]);
  await expect(tabs.getByRole("radio", { name: "Energy" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  const energy = page.getByRole("img", { name: /^Energy by day/u });
  await expect(energy).toHaveAccessibleName(
    "Energy by day, kcal: what you ate and an estimate of what you burned, each day's, faint, and each one's trend, and your eaten target dashed. The list below has the numbers.",
  );
  await expect(energyList(page)).toHaveText([
    /^Mon, Mar 3: eaten 1,500\skcal$/u,
    /^Tue, Mar 4: eaten 2,000\skcal$/u,
    /^Wed, Mar 5: eaten 2,500\skcal$/u,
    /^Eaten target: 2,000\skcal$/u,
  ]);
  // The legend: Eaten · Burned · Eaten target; the target in eaten's
  // colour, dashed; burned its own colour, solid.
  await expect
    .poll(() => legendOf(energy))
    .toEqual(["Eaten", "Burned ≈", "Eaten target"]);
  const looks = await energy.evaluate((c) =>
    Object.fromEntries(
      window.Chart.getChart(c).data.datasets.map((d) => [
        `${d.group} ${d.kind}`,
        [d.borderColor, (d.borderDash ?? []).length > 0],
      ]),
    ),
  );
  // Owner (2026-10-14): a target is neutral and faint, dashed; every
  // series' points the same neutral; each trend its own colour.
  expect(looks["target line"][1]).toBe(true);
  expect(looks["target line"][0]).not.toBe(looks["eaten trend"][0]);
  expect(looks["burned trend"][1]).toBe(false);
  expect(looks["burned trend"][0]).not.toBe(looks["eaten trend"][0]);
  expect(looks["eaten points"][0]).toBe(looks["burned points"][0]);
  // Protein: its chart in the same card, its target named for it.
  await tabs.getByRole("radio", { name: "Protein" }).click();
  const protein = page.getByRole("img", { name: /^Protein by day/u });
  await expect(protein).toBeVisible();
  await expect(page.getByRole("img", { name: /^Energy by day/u })).toHaveCount(
    0,
  );
  await expect(energyList(page).last()).toHaveText(/^Protein target: 120\sg$/u);
  await expect
    .poll(() => legendOf(protein))
    .toEqual(["Protein", "Protein target"]);
  // Kept on this device.
  await page.reload();
  await expect(
    page.getByRole("img", { name: /^Protein by day/u }),
  ).toBeVisible();
  for (const name of ["Carbs", "Fat"]) {
    await tabs.getByRole("radio", { name }).click();
    await expect(
      page.getByRole("img", { name: new RegExp(`^${name} by day`, "u") }),
    ).toBeVisible();
  }
});

test("the energy chart: one legend every period, a shape per series, a floor hollow, a field seen, round ticks (E3-6, U3-5, U3-6, E3-12)", async ({
  page,
}) => {
  await page.route("**/api/profiles/*/summary?*", (route) =>
    route.fulfill({
      json: {
        from: "2025-03-03",
        to: "2025-03-09",
        days: [
          dayTotal("2025-03-03", 1503),
          { ...dayTotal("2025-03-04", 2500), energy_unknown: true },
          dayTotal("2025-03-05", 2000),
        ],
      },
    }),
  );
  await page.route("**/api/profiles/*/targets", (route) =>
    route.fulfill({
      json: [{ metric: "energy", value: 2000, min: 2000, max: 2200 }],
    }),
  );
  for (const period of ["week", "month"]) {
    await page.goto(`/#/summary/food/${period}/2025-03-04`);
    const energy = page.getByRole("img", { name: /^Energy by day/u });
    // One entry a series, whatever the days hold.
    await expect
      .poll(() => legendOf(energy))
      .toEqual(["Eaten", "Burned ≈", "Eaten target"]);
    const drawn = await energy.evaluate((c) => {
      const chart = window.Chart.getChart(c);
      const sets = chart.data.datasets.map((d, i) => ({
        key: `${d.group} ${d.kind}`,
        style: d.pointStyle,
        fill: chart
          .getDatasetMeta(i)
          .data.map((p) => p.options.backgroundColor),
        background: d.backgroundColor,
        border: d.borderWidth,
      }));
      return {
        sets: Object.fromEntries(sets.map((x) => [x.key, x])),
        legend: chart.legend.legendItems.map((i) => [i.text, i.pointStyle]),
        ticks: chart.scales.y.ticks.map((t) => t.value),
        pixels: chart.scales.y.ticks.map((t) =>
          chart.scales.y.getPixelForValue(t.value),
        ),
      };
    });
    // Points neutral, told apart by shape; the legend shows the shape.
    expect(drawn.sets["eaten points"].style).toBe("circle");
    expect(drawn.sets["burned points"].style).toBe("triangle");
    expect(drawn.legend.slice(0, 2)).toEqual([
      ["Eaten", "circle"],
      ["Burned ≈", "triangle"],
    ]);
    // The floor's point is hollow; the whole days' filled.
    const fill = drawn.sets["eaten points"].fill;
    expect(fill.filter((f) => f === "transparent")).toHaveLength(1);
    // The target field: a muted fill of 25–30 % and a hairline edge.
    const alpha = Number(
      drawn.sets["target high"].background.match(/[\d.]+\)$/u)[0].slice(0, -1),
    );
    expect(alpha).toBeGreaterThanOrEqual(0.25);
    expect(alpha).toBeLessThanOrEqual(0.3);
    expect(drawn.sets["target high"].border).toBe(1);
    // Ticks round (an edge only when clear of them), never closer than a
    // label's height.
    const round = drawn.ticks.filter((v) => v % 100 === 0);
    expect(round.length).toBeGreaterThanOrEqual(drawn.ticks.length - 2);
    const gaps = drawn.pixels.slice(1).map((y, i) => drawn.pixels[i] - y);
    for (const g of gaps) expect(Math.abs(g)).toBeGreaterThanOrEqual(14);
  }
  // The list says the number, then why it's a floor.
  await expect(energyList(page).nth(1)).toHaveText(
    /^Tue, Mar 4: eaten ≥\s2,500\skcal \(some energy unknown\)$/u,
  );
});

test("a month charts each logged day, and fits a phone", async ({ page }) => {
  // Every day of September 2026 logged: 30 points, 30 days in the screen
  // readers' list.
  const days = Array.from({ length: 30 }, (_, i) =>
    dayTotal(`2026-09-${String(i + 1).padStart(2, "0")}`, 1800 + i * 10),
  );
  await page.route("**/api/profiles/*/summary?*", (route) =>
    route.fulfill({
      json: {
        from: "2026-09-01",
        to: "2026-09-30",
        days,
      },
    }),
  );
  await page.setViewportSize({ width: 393, height: 800 });
  await page.goto("/#/summary/food/month/2026-09-15");
  const list = energyList(page);
  await expect(list.filter({ hasText: /^\w{3}, Sep/u })).toHaveCount(30);
  await expect(list.first()).toHaveText(/^Tue, Sep 1: eaten 1,800\skcal/u);
  await expectFits(page);
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
        days: [{ day: "2031-03-03", total: { energy: 1500 } }],
      },
    }),
  );
  await page.goto("/#/summary/week/2031-03-05");
  // The daily average, and the screen readers' list.
  await expect(page.locator(".daily-averages")).toContainText(/1,500\skcal/u);
  await expect(energyList(page).first()).toHaveText(
    /^Mon, Mar 3: eaten 1,500\skcal$/u,
  );
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
  await entry(request, { day, group: "Eaten", food_id: f.id, grams: 100 }, id);
  const targets = await (
    await request.get(`/api/profiles/${id}/targets`)
  ).json();
  const goal = targets.find((t) => t.metric === "energy").value;
  await page.goto(`/#/summary/week/${day}`);
  await expect(
    energyList(page)
      .filter({ hasText: /^Eaten target/u })
      .first(),
  ).toHaveText(
    new RegExp(
      `^Eaten target: ${goal.toLocaleString("en-US")}\\skcal(–|$)`,
      "u",
    ),
  );
  await expect(averageBar(page, "Energy").locator(".target-label")).toHaveText(
    /^Energy\s*400\skcal/u,
  );
});

test("workout energy left unset counts as an estimate", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(164, testInfo);
  const id = await ownProfile(page, request, `Est ${tag}`);
  const day = todayInApp();
  const res = await request.post(`/api/profiles/${id}/activities`, {
    data: { day, name: `Walk ${tag}`, minutes: 30, sets: [] },
  });
  expect(res.ok()).toBeTruthy();
  await page.goto(`/#/summary/activity/week/${day}`);
  const line = page
    .getByRole("list", { name: "Activities" })
    .locator(".tile")
    .filter({ hasText: "from activities" });
  // Net of resting: (5 − 1) MET × 60 kg × ½ h. One marker: ≈, named for
  // screen readers.
  await expect(line).toHaveText(/^≈\s120\s*kcal from activities$/u);
  await expect(
    line.getByRole("img", { name: "includes estimates" }),
  ).toHaveText("≈");

  // With the energy set, it is no estimate.
  const session = await res.json();
  await request.put(`/api/profiles/${id}/activities/${session.id}`, {
    data: { ...session, kcal: 200 },
  });
  await page.reload();
  // Typed energy is gross: less the resting energy of its half hour
  // (Mifflin–St Jeor about 1,290 kcal a day: 27 kcal).
  await expect(line).toHaveText(/^173\s*kcal from activities$/u);
  await expect(line).not.toContainText("≈");
  await expect(line.getByRole("img")).toHaveCount(0);
});

// -------------------------------------------------- what charts are by

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

// Open the `i`th point of a drawn chart: a click; on a phone a tap shows
// its tooltip and the "Open …" link under the chart goes.
async function openPoint(img, i, name) {
  await clickPoint(img, i);
  if (img.page().viewportSize().width < 600) {
    const open = img
      .locator("xpath=ancestor::*[contains(@class,'chart-box')]/..")
      .getByRole("link", { name: `Open ${name}` });
    await expect(open).toBeVisible();
    await open.click();
  }
}

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

  // A year by week: each week's mean and the trend at its last day; a
  // week opens on the same subtab.
  await page.goto("/#/summary/body/year/2025-01-10");
  const weekly = section.getByRole("img", {
    name: "Weight by week: each week's mean, faint, and the trend, in kg.",
  });
  await plotted(weekly).toEqual({
    labels: ["Jan 6", "Jan 13", "Feb 3"],
    data: [
      [79.5, 77.5, 76],
      [79.5, 77.5, 76],
    ],
  });
  await openPoint(weekly, 1, "Week of Mon, Jan 13");
  await expect(page).toHaveURL(/#\/summary\/body\/week\/2025-01-13$/u);
  await expect(
    section.getByRole("heading", { name: "Weight by day" }),
  ).toBeVisible();

  // A month by day: a weigh-in opens its diary.
  await page.goto("/#/summary/body/month/2025-01-10");
  const daily = section.getByRole("img", { name: /^Weight by day/u });
  await plotted(daily).toEqual({
    labels: ["Jan 6", "Jan 8", "Jan 13", "Jan 15"],
    data: [
      [80, 79, 78, 77],
      [80, 79.5, 78.5, 77.5],
    ],
  });
  await openPoint(daily, 1, "Wed, Jan 8");
  await expect(page).toHaveURL(/#\/day\/2025-01-08$/u);
});

// The owner's missing trend: weigh-ins that fall in one bucket (a year by
// week, all in one week) made one point, and the chart hid with its trend;
// and the faint points were drawn over the trend line.
test("weigh-ins in one bucket still chart by day, the trend drawn on top", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(571, testInfo);
  const pid = await ownProfile(page, request, `One month ${tag}`);
  for (const [day, kg] of [
    ["2025-01-06", 80],
    ["2025-01-08", 79],
    ["2025-01-10", 78],
  ])
    await request.put(`/api/profiles/${pid}/weights/${day}`, { data: { kg } });
  await page.goto("/#/summary/body/year/2025-01-10");
  const section = page.locator("section.weight");
  const daily = section.getByRole("img", { name: /^Weight by day/u });
  await plotted(daily).toEqual({
    labels: ["Jan 6", "Jan 8", "Jan 10"],
    data: [
      [80, 79, 78],
      [80, 79.5, 79],
    ],
  });
  // Chart.js draws the first of its sorted datasets last: the trend.
  expect(
    await daily.evaluate(
      (c) => window.Chart.getChart(c).getSortedVisibleDatasetMetas()[0].label,
    ),
  ).toBe("Weight trend");
  // The legend names the series once: never "7-day".
  expect(
    await daily.evaluate((c) =>
      window.Chart.getChart(c).legend.legendItems.map((i) => i.text),
    ),
  ).toEqual(["Weight"]);
});

// -------------------------------------------- one window, plain future

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
      average: days.length > 0 ? { energy: mean } : {},
      days,
    };
  });
  await mockJson(page, "**/api/profiles/*/targets", (real) => [
    ...real,
    { metric: "energy", value: 2000, min: 2000, max: 2200 },
  ]);
  await mockJson(page, "**/api/profiles/*/device-days?*", (real) => ({
    ...real,
    days: SEP_DAYS.map(({ day }) => ({
      day,
      asleep_min: 450,
      bedtime: "23:00",
      wake_time: "07:00",
    })),
  }));
  await mockJson(page, "**/api/profiles/*/check-ins?*", () =>
    SEP_DAYS.map(({ day }) => ({ day, mood: 4, tags: ["work"] })),
  );
}

test("table and tiles agree", async ({ page }) => {
  await openSeptember(page);
  await page.goto("/#/summary/food/month/2025-09-10");
  // Through yesterday: Sep 1–9, 1,800 + 20·i, mean 1,880 (today's 3,000
  // left out everywhere).
  await expect(
    page.getByRole("heading", { name: "Daily averages through yesterday" }),
  ).toBeVisible();
  await expect(averageBar(page, "Energy").locator(".target-label")).toHaveText(
    /^Energy\s*1,880\skcal/u,
  );
  const tiles = page
    .getByRole("list", { name: "Energy", exact: true })
    .locator(".tile");
  await expect(tiles.first()).toHaveText(/^0 of 9\s*days on target$/u);
  // The mean a day is the Daily averages bar's: not again as a tile.
  await expect(tiles.filter({ hasText: /a day$/u })).toHaveCount(0);
});

test("future days are plain everywhere", async ({ page }) => {
  await openSeptember(page);
  const calendars = [
    ["food", ".food-cal"],
    ["body", ".sleep-cal"],
    ["body", ".check-in-cal"],
    ["activity", ".activity-cal"],
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

test("calendars: today outlined, one empty word, the legend under the grid; check-in tiles carry their extremes (item 15)", async ({
  page,
}) => {
  await openSeptember(page);
  for (const [tab, cal] of [
    ["food", ".food-cal"],
    ["body", ".sleep-cal"],
    ["body", ".check-in-cal"],
    ["activity", ".activity-cal"],
  ]) {
    await page.goto(`/#/summary/${tab}/month/2025-09-10`);
    const table = page.locator(cal);
    // Today is still going: outlined, not shaded; but a night that ended
    // today, or a check-in made, is final: shaded too.
    await expect(table.locator('td[data-day="2025-09-10"]')).toHaveClass(
      [".sleep-cal", ".check-in-cal"].includes(cal)
        ? /^cal-cell shade-\d today$/u
        : "cal-cell today",
    );
    // The legend a step under its grid.
    const legend = table.locator("xpath=following-sibling::div[1]");
    await expect(legend).toHaveClass(/\bcal-legend\b/u);
    const gap = await legend.evaluate(
      (l) =>
        l.getBoundingClientRect().top -
        l.previousElementSibling.getBoundingClientRect().bottom,
    );
    expect(gap, cal).toBeGreaterThanOrEqual(7);
    if (tab !== "activity")
      await expect(legend, cal).toContainText("Nothing logged");
  }
  await page.goto("/#/summary/body/month/2025-09-10");
  // Mood 4 at every check-in: its tile says "always 4"; tags under
  // their heading.
  await expect(
    page.getByRole("list", { name: "Check-ins" }).locator(".tile"),
  ).toHaveText([/^4\.0\s*average mood\s*always 4$/u, /^\d+\s*check-ins$/u]);
  await expect(page.locator(".check-ins h3")).toHaveText("Tags");
});

test("Daily averages are the Diary's nutrient card, each bar linking where it came from (item 14)", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag } = unique(982, testInfo);
  const pid = await ownProfile(page, request, `Rows ${tag}`);
  const f = await food(request, {
    name: `Bread ${tag}`,
    per100: { energy: 250, protein: 9, fat: 3 },
  });
  await entry(request, { day, group: "Eaten", food_id: f.id, grams: 100 }, pid);
  await page.goto(`/#/summary/food/week/${day}`);
  // The macros first, the tiles gone.
  await expect(
    page.locator(
      ".daily-averages .targets-page:not([inert]) > .target .target-label > span:first-child",
    ),
  ).toHaveText(["Energy", "Protein", "Carbs", "Fat"]);
  await expect(page.locator(".tiles .verdict")).toHaveCount(0);
  await expect(
    averageBar(page, "Protein").getByRole("link", { name: "Protein" }),
  ).toHaveAttribute("href", /^#\/sources\/protein\?/u);
  await showHighlighted(page);
  await expect(averageBar(page, "Fibre")).toBeVisible();
});

// ADR 0030: "–" is not known at all, so it has no verdict.
test("a nutrient no food carried is – without a verdict", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag } = unique(700, testInfo);
  const pid = await ownProfile(page, request, `Unknown ${tag}`);
  const f = await food(request, {
    name: `Broth ${tag}`,
    per100: { energy: 250, protein: 9, fat: 3 },
  });
  await entry(request, { day, group: "Eaten", food_id: f.id, grams: 100 }, pid);
  await page.goto(`/#/summary/food/week/${day}`);
  const carbs = averageBar(page, "Carbs");
  await expect(carbs.locator(".target-label")).toHaveText(/^Carbs\s*–/u);
  await expect(carbs.getByRole("link")).toHaveCount(0);
  await expect(carbs).not.toHaveClass(/\bover\b/u);
  await expect(carbs.locator("small")).toHaveText("Not known");
  await expect(carbs.locator(".bar")).toHaveAttribute(
    "aria-label",
    /^Carbs: not known, of [\d,]+ g a day on average$/u,
  );
});

test("every chart expands into a full-screen dialog; Esc closes it", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(865, testInfo);
  const pid = await ownProfile(page, request, `Expand ${tag}`);
  const f = await food(request, {
    name: `Rice ${tag}`,
    per100: { energy: 350 },
  });
  for (const day of ["2025-03-04", "2025-03-05", "2025-03-06"])
    await entry(
      request,
      { day, group: "Eaten", food_id: f.id, grams: 400 },
      pid,
    );
  await page.setViewportSize({ width: 320, height: 700 });
  // Chart.js arrives late: Expand tapped before the card's chart is drawn
  // still opens it, once drawn.
  await page.route("**/chart.umd.min.js", async (route) => {
    await delay(1000);
    await route.continue();
  });
  await page.goto("/#/summary/food/week/2025-03-04");
  const expand = page.getByRole("button", { name: "Expand chart" });
  // One card: Energy, the macros its tabs.
  await expect(expand).toHaveCount(1);
  await expectFits(page);
  await expand.first().click();
  const dialog = page.getByRole("dialog", { name: /^Energy by day/u });
  await expect(dialog).toBeVisible();
  const big = dialog.locator("canvas");
  await expect
    .poll(() => big.evaluate((c) => Boolean(window.Chart?.getChart(c))))
    .toBe(true);
  // Larger than the card's, filling the screen.
  const box = await big.boundingBox();
  expect(box.width).toBeGreaterThan(260);
  expect(box.height).toBeGreaterThan(400);
  // The shared theme: quiet x grid, the tooltip the app's one (web/tips.mjs,
  // in the app's surface), not Chart.js's canvas one.
  const theme = await big.evaluate((c) => {
    const chart = window.Chart.getChart(c);
    return [
      chart.options.scales.x.grid.display,
      chart.options.plugins.tooltip.enabled,
      typeof chart.options.plugins.tooltip.external,
    ];
  });
  expect(theme).toEqual([false, false, "function"]);
  await expectFits(page);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(expand.first()).toBeFocused();
});

// -------------------------------------------------- the period popover

// The popover hangs under its title (anchored), not in the window's middle.
async function expectUnder(popover, title) {
  const t = await title.boundingBox();
  const p = await popover.boundingBox();
  expect(p.y).toBeGreaterThanOrEqual(t.y + t.height - 1);
  expect(p.y).toBeLessThan(t.y + t.height + 24);
  expect(p.x).toBeLessThan(t.x + t.width);
  expect(p.x + p.width).toBeGreaterThan(t.x);
}

test("the title's ▾ opens Week · Month · Year and a day; Esc and outside close it", async ({
  page,
}) => {
  await page.goto("/#/summary/food/month/2025-09-15");
  const title = page.locator(".period-title");
  await expect(title).toHaveText("September 2025");
  // The ▾ is drawn, not read.
  expect(
    await title.evaluate((b) => getComputedStyle(b, "::after").content),
  ).toBe('" ▾" / ""');
  const popover = page.locator("#period-pick");
  await expect(popover).toBeHidden();
  // ‹ › stay beside it.
  await expect(
    page.getByRole("link", { name: "Previous month" }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Next month" })).toBeVisible();
  await title.click();
  await expect(popover).toBeVisible();
  await expectUnder(popover, title);
  await expect(
    page.getByRole("navigation", { name: "Period" }).getByRole("link"),
  ).toHaveText(["Week", "Month", "Year"]);
  await page.keyboard.press("Escape");
  await expect(popover).toBeHidden();
  await title.click();
  // A tap outside, on the page's margin.
  await page.mouse.click(2, 250);
  await expect(popover).toBeHidden();
  // A day jumps to its period, the kind kept.
  await title.click();
  await page.getByLabel("Go to day").fill("2025-03-20");
  await expect(page).toHaveURL(/#\/summary\/food\/month\/2025-03-20$/u);
  await expect(page.locator(".period-title")).toHaveText("March 2025");
});

// -------------------------------------------------- burned and balance

test("Energy by day draws what each day burned; the balance breaks it down", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(572, testInfo);
  // Female, born 1990-01-01, 165 cm, 60 kg: Mifflin–St Jeor 1,295 kcal at 35.
  const pid = await ownProfile(page, request, `Burned ${tag}`);
  // The model reads the weigh-ins of the 90 days before the period on.
  await request.put(`/api/profiles/${pid}/weights/2025-03-01`, {
    data: { kg: 60 },
  });
  const f = await food(request, {
    name: `Stew ${tag}`,
    per100: { energy: 400 },
  });
  for (const [day, grams] of [
    ["2025-03-04", 500],
    ["2025-03-05", 250],
  ])
    await entry(request, { day, group: "Eaten", food_id: f.id, grams }, pid);
  await page.goto("/#/summary/food/week/2025-03-04");
  // No device, no sessions: resting + 10 % everyday movement (an
  // estimate), + 10 % of what was eaten: about 1,425 + 200 and + 100;
  // from the first food day on, each day over has its burned point, to
  // 10 kcal as everywhere burned is said.
  const numbers = page.locator(".chart-section").first().locator("ul");
  await expect(numbers).toHaveClass("sr-only");
  await expect(numbers.getByRole("link")).toHaveCount(0);
  await expect(numbers.getByRole("listitem").first()).toHaveText(
    /^Tue, Mar 4: eaten 2,000\skcal · burned ≈ 1,620\skcal$/u,
  );
  await expect(numbers.getByRole("listitem").nth(1)).toHaveText(
    /^Wed, Mar 5: eaten 1,000\skcal · burned ≈ 1,520\skcal$/u,
  );
  await expect(numbers.getByRole("listitem").nth(2)).toHaveText(
    /^Thu, Mar 6: burned ≈ [\d,]+\skcal$/u,
  );
  // Energy balance: eaten, burned (an estimate, to 10) and the gap a day,
  // one line; a gap of 75 is inside burned's error, about even.
  await expect(balanceLine(page)).toHaveText(
    /^Eaten\s1,500 · Burned\s≈\s1,570 · About\seven\s\(within\s100\skcal\sa\sday\)$/u,
  );
  // The balance breaks burned down; everyday movement is named an estimate.
  const balance = page
    .getByRole("list", { name: "Energy balance over 2 food-logged days" })
    .locator(".tile");
  await expect(balance).toHaveText([
    /^≈\s1,295\skcal\s*resting \(BMR\) a day$/u,
    /^≈\s150\skcal\s*digesting \(TEF\) a day$/u,
    /^≈\s130\skcal\s*everyday movement a day$/u,
    /^≈\s0\skcal\s*more active a day$/u,
  ]);
  // Maintenance (no history: resting × activity level, about 2,060) is
  // over 15 % from what those days burned: both are named, and which one
  // targets use.
  await expect(page.locator(".energy-sources")).toHaveText(
    /^Burned ≈ 1,570\skcal a day \(from resting energy, digesting, an estimate of everyday movement and your activities \(no active energy from a device\)\) against maintenance of ≈ [\d,]+\skcal \(from your measurements and activity level \(PAL 1\.6\)\)\.$/u,
  );
});

test("a day's workout counts toward burned beside the device's smaller active energy", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(866, testInfo);
  // Mifflin–St Jeor 1,295 kcal (see above).
  const pid = await ownProfile(page, request, `Workout ${tag}`);
  await request.put(`/api/profiles/${pid}/weights/2025-03-01`, {
    data: { kg: 60 },
  });
  const f = await food(request, {
    name: `Oats ${tag}`,
    per100: { energy: 400 },
  });
  await entry(
    request,
    { day: "2025-03-04", group: "Eaten", food_id: f.id, grams: 500 },
    pid,
  );
  // The device counted 100 kcal active; an hour's run typed at 600 kcal
  // (gross: 546 net of its resting share) it didn't track.
  const sync = await syncHealth(request, pid, {
    from: "2025-03-03",
    to: "2025-03-09",
    days: [{ day: "2025-03-04", active_kcal: 100 }],
  });
  expect(sync.ok()).toBeTruthy();
  const run = await request.post(`/api/profiles/${pid}/activities`, {
    data: {
      day: "2025-03-04",
      name: `Run ${tag}`,
      minutes: 60,
      kcal: 600,
      sets: [],
    },
  });
  expect(run.ok()).toBeTruthy();
  await page.goto("/#/summary/food/week/2025-03-04");
  const balance = page
    .getByRole("list", { name: "Energy balance" })
    .locator(".tile");
  // Movement is the larger of the device's active energy and everyday
  // movement plus the run it missed: 130 + 546.
  await expect(balance).toHaveText([
    /resting \(BMR\) a day$/u,
    /digesting \(TEF\) a day$/u,
    /^≈\s130\skcal\s*everyday movement a day$/u,
    /^≈\s546\skcal\s*more active a day$/u,
  ]);
  await expect(balanceLine(page)).toContainText("Burned ≈ 2,170");
  // Activity's tile counts it too: a typed total netted, measured (no
  // "≈"), with the device's value that day (no floor).
  await page.goto("/#/summary/activity/week/2025-03-04");
  await expect(page.locator(".movement-summary .tile").first()).toHaveText(
    /^546\skcal active a day$/u,
  );
});

test("a day eaten with a food without energy reads ≥ in Summary, as in the Diary", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(1053, testInfo);
  const pid = await ownProfile(page, request, `Partial ${tag}`);
  await request.put(`/api/profiles/${pid}/weights/2025-03-01`, {
    data: { kg: 60 },
  });
  const stew = await food(request, {
    name: `Stew ${tag}`,
    per100: { energy: 400 },
  });
  const mystery = await food(request, {
    name: `Mystery ${tag}`,
    per100: { protein: 10 },
  });
  for (const f of [stew, mystery])
    await entry(
      request,
      { day: "2025-03-04", group: "Eaten", food_id: f.id, grams: 500 },
      pid,
    );
  await page.goto("/#/summary/food/week/2025-03-04");
  await expect(balanceLine(page)).toHaveText(/^Eaten\s≥\s2,000 · /u);
  // The daily average too: one rule, a mean over a partial day is a floor.
  await expect(
    averageBar(page, "Energy").locator(".target-label"),
  ).toContainText(/≥\s2,000\skcal/u);
  const cell = page.locator('.food-cal td[data-day="2025-03-04"]');
  await expect(cell.locator(".cal-amount")).toHaveText("≥\u00A02,000");
  await expect(cell.getByRole("link")).toHaveAttribute(
    "aria-label",
    /^Tue, Mar 4: ≥\s2,000\skcal/u,
  );
});

test("a week starting today counts no day yet: no averages, no balance tiles", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag } = unique(220, testInfo);
  const pid = await ownProfile(page, request, `Monday ${tag}`);
  const back = (new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7;
  const monday = new Date(Date.parse(`${day}T12:00:00Z`) - back * 864e5)
    .toISOString()
    .slice(0, 10);
  const f = await food(request, {
    name: `Breakfast ${tag}`,
    per100: { energy: 400 },
  });
  await entry(
    request,
    { day: monday, group: "Eaten", food_id: f.id, grams: 100 },
    pid,
  );
  // Monday morning: breakfast is in, the day is far from over.
  await page.clock.setFixedTime(new Date(`${monday}T07:00:00Z`));
  await page.goto(`/#/summary/food/week/${monday}`);
  // Today is still being logged: the week counts through yesterday,
  // before it, so no average of a partly logged day, no "deficit" of it,
  // no balance heading over nothing.
  await expect(
    page.getByText("Nothing logged through yesterday."),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: /^Daily averages/u }),
  ).toHaveCount(0);
  await expect(page.locator(".energy-balance")).toHaveCount(0);
});

test.describe("in a Finnish browser", () => {
  test.use({ locale: "fi-FI", viewport: { width: 320, height: 700 } });

  test("the week title is a compact range, and › stays on screen", async ({
    page,
    request,
  }, testInfo) => {
    const { tag } = unique(221, testInfo);
    await ownProfile(page, request, `Viikko ${tag}`);
    await page.goto("/#/summary/food/week/2026-10-14");
    await expect(page.locator(".period-title")).toHaveText("12.–18.10.");
    await expect(page.getByRole("link", { name: "Next week" })).toBeInViewport({
      ratio: 1,
    });
  });
});

// -------------------------------------------------------- body metrics

// Energy eaten and burned is Food's chart; maintenance is Body's,
// a moving constant as BMI is.
test("Body charts BMI with the recommended range, maintenance and each measurement (items 12, 20)", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(573, testInfo);
  const pid = await ownProfile(page, request, `Metrics ${tag}`);
  for (const [day, kg] of [
    ["2025-03-03", 70],
    ["2025-03-17", 69],
  ])
    await request.put(`/api/profiles/${pid}/weights/${day}`, { data: { kg } });
  for (const [day, cm] of [
    ["2025-03-05", 80],
    ["2025-03-19", 78.5],
  ])
    await request.put(`/api/profiles/${pid}/measurements/${day}/waist`, {
      data: { value: cm },
    });
  await request.put(`/api/profiles/${pid}/measurements/2025-03-10/hips`, {
    data: { value: 95 },
  });
  await page.goto("/#/summary/body/month/2025-03-10");
  const metrics = page.getByRole("radiogroup", { name: "Chart", exact: true });
  await expect(metrics.getByRole("radio")).toHaveText([
    "Weight",
    "BMI",
    "Maintenance",
    "Waist",
    "Hips",
  ]);
  const section = page.locator("section.weight");
  const list = section.locator("ul.sr-only li");
  // 165 cm: 70 kg is BMI 25.7; born 1990, 18.5–25 is recommended, 18.5
  // too far below to draw (it starts hidden) but said.
  await metrics.getByRole("radio", { name: "BMI" }).click();
  await expect(list).toHaveText([
    /^Mon, Mar 3: BMI 25\.7\skg\/m²$/u,
    /^Mon, Mar 17: BMI 25\.3\skg\/m²$/u,
    /^Recommended BMI: 18\.5–25\skg\/m²$/u,
  ]);
  // Maintenance: each day's, in kcal, an estimate naming its method
  // (resting × activity level here: no history yet).
  await metrics.getByRole("radio", { name: "Maintenance" }).click();
  await expect(
    section.getByRole("img", { name: /^Maintenance ≈ by day/u }),
  ).toBeVisible();
  // The number first, then how it was had.
  await expect(list.first()).toHaveText(
    /^Sat, Mar 1: maintenance ≈ [\d,]+\skcal \(activity level\)$/u,
  );
  await metrics.getByRole("radio", { name: "Waist" }).click();
  await expect(list).toHaveText([
    /^Wed, Mar 5: waist 80\scm$/u,
    /^Wed, Mar 19: waist 78\.5\scm$/u,
  ]);
  // One measurement alone is said in words.
  await metrics.getByRole("radio", { name: "Hips" }).click();
  await expect(section.locator(".chart-card")).toBeHidden();
  await expect(section.getByText(/^Hips: 95\scm on Mar 10$/u)).toBeVisible();
  // The first → last list is gone.
  await expect(page.locator("ul.measurements")).toHaveCount(0);
});

test("Body's period tiles average HRV, RHR and heart rate; heart rate charts with its band", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(722, testInfo);
  const pid = await ownProfile(page, request, `BPM ${tag}`);
  const res = await syncHealth(request, pid, {
    from: "2026-08-31",
    to: "2026-09-06",
    days: [
      {
        day: "2026-09-01",
        resting_hr: 52,
        hrv_ms: 50,
        avg_hr: 66,
        min_hr: 47,
        max_hr: 130,
      },
      {
        day: "2026-09-02",
        resting_hr: 55,
        hrv_ms: 45,
        avg_hr: 71,
        min_hr: 50,
        max_hr: 150,
      },
      // A day without heart rate doesn't count toward its average.
      { day: "2026-09-03", steps: 100 },
    ],
  });
  expect(res.status()).toBe(200);
  await page.goto("/#/summary/body/week/2026-08-31");
  await expect(
    page.getByRole("list", { name: "Heart" }).locator(".tile"),
  ).toHaveText([
    "48 ms average HRV",
    "54 bpm average RHR",
    "69 bpm average heart rate",
  ]);
  const chart = page
    .locator("section.heart")
    .getByRole("radiogroup", { name: "Heart chart", exact: true });
  await expect(chart.getByRole("radio")).toHaveText([
    "RHR",
    "HRV",
    "Heart rate",
  ]);
  await chart.getByRole("radio", { name: "Heart rate" }).click();
  await expect(
    page.getByRole("heading", { name: "Heart rate by day" }),
  ).toBeVisible();
  const img = page.getByRole("img", {
    // No trend: the day's average follows how active it was (RHR is the
    // trend to read).
    name: "Heart rate by day: each day's value, its lowest to highest a band, in bpm.",
  });
  await expect
    .poll(() =>
      img.evaluate((c) =>
        window.Chart?.getChart(c)?.data.datasets.map((d) => [d.label, d.data]),
      ),
    )
    .toEqual([
      ["Heart rate", [66, 71]],
      ["Lowest (bpm)", [47, 50]],
      ["Lowest–highest (bpm)", [130, 150]],
    ]);
  // One chart: no card of its own.
  await expect(page.locator("canvas")).toHaveCount(1);
});

test("the period picker offers Week, Month, Year", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(812, testInfo);
  await ownProfile(page, request, `Periods ${tag}`);
  await page.goto("/#/summary/food/week/2026-09-02");
  await page.locator(".period-title").click();
  const periods = page.getByRole("navigation", { name: "Period" });
  await expect(periods.getByRole("link")).toHaveText(["Week", "Month", "Year"]);
  await expect(periods.getByRole("link", { name: "Week" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await periods.getByRole("link", { name: "Month" }).click();
  await expect(page).toHaveURL(/#\/summary\/food\/month\/2026-09-02$/u);
  // A Day is the Diary's: the old address is no screen.
  await page.goto("/#/summary/food/day/2026-09-02");
  await expect(page.getByRole("heading", { name: "Not found" })).toBeVisible();
});

test("a running week says 'through yesterday' only in the averages heading", async ({
  page,
}) => {
  await openSeptember(page);
  // Mon Sep 8 – Sun 14, opened on Wednesday the 10th: Sep 8 and 9 count.
  await page.goto("/#/summary/food/week/2025-09-10");
  await expect(page.locator(".daily-averages > h2:first-child")).toHaveText(
    "Daily averages through yesterday",
  );
  await expect(page.getByText(/through yesterday/u)).toHaveCount(1);
  // The count is the tiles' ("0 of 2 days on target"), not a line of its own.
  await expect(page.getByText(/\d+ days? logged/u)).toHaveCount(0);
  // A week over is plain averages.
  await page.goto("/#/summary/food/week/2025-09-03");
  await expect(page.locator(".daily-averages > h2:first-child")).toHaveText(
    "Daily averages",
  );
});

test("Energy balance has no days line", async ({ page, request }, testInfo) => {
  const { tag } = unique(264, testInfo);
  const pid = await ownProfile(page, request, `Balance ${tag}`);
  await request.put(`/api/profiles/${pid}/weights/2025-03-01`, {
    data: { kg: 60 },
  });
  const f = await food(request, {
    name: `Soup ${tag}`,
    per100: { energy: 400 },
  });
  for (const day of ["2025-03-04", "2025-03-05"])
    await entry(
      request,
      { day, group: "Eaten", food_id: f.id, grams: 400 },
      pid,
    );
  await page.goto("/#/summary/food/week/2025-03-04");
  // Burned's parts: resting, digesting, everyday movement, active.
  await expect(
    page.getByRole("list", { name: "Energy balance" }).locator(".tile"),
  ).toHaveCount(4);
  // The tiles count per day; "This week: 2 days with food logged." said
  // what the averages already do.
  await expect(page.locator(".energy-balance")).not.toContainText("This week");
});

// Full screen, a chart still says what it is (the card's heading,
// unit and period), and a value reads with the pointer near its day, not
// on the dot.
test("an expanded chart names its heading, unit and period; a day's values show off the dot", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(1145, testInfo);
  const pid = await ownProfile(page, request, `Expanded ${tag}`);
  for (const [day, kg] of [
    ["2025-01-06", 80],
    ["2025-01-08", 79],
    ["2025-01-13", 78],
    ["2025-01-15", 77],
  ])
    await request.put(`/api/profiles/${pid}/weights/${day}`, { data: { kg } });
  await page.goto("/#/summary/body/month/2025-01-10");
  const section = page.locator("section.weight");
  const card = section.getByRole("img", { name: /^Weight by day/u });
  await plotted(card).toEqual({
    labels: ["Jan 6", "Jan 8", "Jan 13", "Jan 15"],
    data: [
      [80, 79, 78, 77],
      [80, 79.5, 78.5, 77.5],
    ],
  });
  // Ticks to the step's decimals, a whole one too: "77.0", "77.5".
  const labels = await card.evaluate((c) =>
    window.Chart.getChart(c).scales.y.ticks.map((t) => t.label),
  );
  expect(labels.length).toBeGreaterThan(2);
  for (const label of labels) expect(label).toMatch(/^\d+\.\d$/u);
  await section.getByRole("button", { name: "Expand chart" }).click();
  const dialog = page.getByRole("dialog", { name: /^Weight by day/u });
  await expect(dialog.getByRole("heading")).toHaveText(
    /^Weight by day · kg · January 2025$/u,
  );
  const big = dialog.locator("canvas");
  await expect
    .poll(() => big.evaluate((c) => Boolean(window.Chart?.getChart(c))))
    .toBe(true);
  // The nearest day under the pointer, both its point and its trend.
  const { x, y } = await big.evaluate((c) => {
    const p = window.Chart.getChart(c).getDatasetMeta(0).data[1];
    return { x: p.x, y: p.y };
  });
  if (testInfo.project.name === "chromium") {
    await big.hover({ position: { x: x + 10, y: y + 30 } });
    await expect
      .poll(() =>
        big.evaluate((c) =>
          window.Chart.getChart(c).tooltip.dataPoints?.map(
            (p) => `${p.dataset.label}: ${p.formattedValue}`,
          ),
        ),
      )
      .toEqual(["Weight: 79", "Weight trend: 79.5"]);
  }
});

// On a touch screen a point's tooltip (the app's one, web/tips.mjs) sits
// above the finger, FINGER px clear: at the chart's top too, as it isn't
// held inside the canvas.
test("a touched point's tooltip sits above the finger, at the chart's top too", async ({
  page,
  request,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "mobile-chromium",
    "a coarse pointer only",
  );
  const { tag } = unique(1146, testInfo);
  const pid = await ownProfile(page, request, `Finger ${tag}`);
  for (const [day, kg] of [
    ["2025-01-06", 80],
    ["2025-01-08", 79],
    ["2025-01-13", 78],
    ["2025-01-15", 77],
  ])
    await request.put(`/api/profiles/${pid}/weights/${day}`, { data: { kg } });
  await page.goto("/#/summary/body/month/2025-01-10");
  const img = page
    .locator("section.weight")
    .getByRole("img", { name: /^Weight by day/u });
  const tip = page.locator("section.weight .chart-tip");
  const tipAfterTap = async (i) => {
    await expect
      .poll(() => img.evaluate((c) => Boolean(window.Chart?.getChart(c))))
      .toBe(true);
    const position = await img.evaluate((c, n) => {
      const { x, y } = window.Chart.getChart(c).getDatasetMeta(0).data[n];
      return { x, y };
    }, i);
    await img.tap({ position });
    await expect(tip).toBeVisible();
    const canvas = await img.boundingBox();
    const box = await tip.boundingBox();
    return { bottom: box.y + box.height, finger: canvas.y + position.y };
  };
  // The lowest day and the highest, at the chart's top: above the finger.
  for (const i of [3, 0]) {
    const { bottom, finger } = await tipAfterTap(i);
    expect(bottom, `${i}`).toBeLessThanOrEqual(finger - 16 + 0.5);
  }
  // A tap showed the value; it stayed on the Summary.
  await expect(page).toHaveURL(/#\/summary\/body\/month\/2025-01-10$/u);
});

// Without the server the Summary says so, not "Something went
// wrong".
test("the Summary offline is headed You're offline, and comes back on Retry", async ({
  page,
  request,
  context,
}, testInfo) => {
  const { tag } = unique(1147, testInfo);
  await ownProfile(page, request, `Offline ${tag}`);
  await page.goto("/#/summary/food/month/2025-01-10");
  await expect(page.locator("nav.subtabs")).toBeVisible();
  await context.setOffline(true);
  await page.goto("/#/summary/body/month/2025-01-10");
  await expect(
    page.getByRole("heading", { name: "You're offline" }),
  ).toBeVisible();
  await expect(page.getByText("Something went wrong")).toHaveCount(0);
  await context.setOffline(false);
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(
    page.getByRole("heading", { name: "You're offline" }),
  ).toHaveCount(0);
  await expect(
    page.locator("section.weight, section.finder-section").first(),
  ).toBeVisible();
});

// A day note is prose: it reads from the left edge of its
// column, wrapped or not.
test("Body's notes read left-aligned", async ({ page, request }, testInfo) => {
  const { tag } = unique(1149, testInfo);
  const pid = await ownProfile(page, request, `Notes ${tag}`);
  const res = await request.put(`/api/profiles/${pid}/notes/2025-01-08`, {
    data: {
      text: "Slept badly after the long run, legs heavy all day; ate late and too much",
    },
  });
  expect(res.ok()).toBeTruthy();
  await page.goto("/#/summary/body/month/2025-01-10");
  const note = page.locator(".notes .note-text");
  await expect(note).toBeVisible();
  expect(await note.evaluate((n) => getComputedStyle(n).textAlign)).toBe(
    "start",
  );
});

// ------------------------------------------- a target in a point's tooltip

// The tooltip of the `i`th point of a drawn chart, hovered (tapped on a
// phone): its lines, spaces plain.
async function tipAt(img, i) {
  await expect
    .poll(() => img.evaluate((c) => Boolean(window.Chart?.getChart(c))))
    .toBe(true);
  const position = await img.evaluate((c, n) => {
    const { x, y } = window.Chart.getChart(c).getDatasetMeta(0).data[n];
    return { x, y };
  }, i);
  // Until it shows: a dialog's chart may still be settling.
  await expect
    .poll(async () => {
      await img.page().mouse.move(0, 0);
      if (img.page().viewportSize().width < 600) await img.tap({ position });
      else await img.hover({ position });
      return img.evaluate((c) => window.Chart.getChart(c).tooltip.opacity);
    })
    .toBe(1);
  return img.evaluate((c) => {
    const t = window.Chart.getChart(c).tooltip;
    return [
      ...t.body.flatMap((b) => [...b.before, ...b.lines, ...b.after]),
      ...t.afterBody,
    ].map((l) => l.replaceAll("\u00A0", " "));
  });
}

// What a tooltip says of targets and goals.
const targetsIn = (lines) =>
  lines.filter((l) => /^(?:target|goal)\b/iu.test(l));

// Owner (2026-10-17): every chart names its target in a point's tooltip,
// once, as the bars do: a range, "≥" at least, "≤" at most.
test("a food point's tooltip names its target once: a range, at least, at most", async ({
  page,
}) => {
  await page.route("**/api/profiles/*/summary?*", (route) =>
    route.fulfill({
      json: {
        from: "2031-03-03",
        to: "2031-03-09",
        days: [1500, 2000, 2500].map((kcal, i) => ({
          day: `2031-03-0${i + 3}`,
          total: { energy: kcal, protein: kcal / 20, fat: kcal / 40 },
        })),
      },
    }),
  );
  await page.route("**/api/profiles/*/targets", (route) =>
    route.fulfill({
      json: [
        { metric: "energy", value: 1800, min: 1800, max: 2200 },
        { metric: "protein", value: 50, min: 50, max: null },
        { metric: "fat", value: 60, min: null, max: 60 },
      ],
    }),
  );
  await page.goto("/#/summary/week/2031-03-05");
  const energy = page.getByRole("img", { name: /^Energy by day/u });
  const lines = await tipAt(energy, 1);
  expect(lines[0]).toBe("Eaten: 2,000 kcal");
  expect(targetsIn(lines)).toEqual(["Target 1,800–2,200 kcal"]);
  const tabs = page.getByRole("radiogroup", { name: "Chart" });
  await tabs.getByRole("radio", { name: "Protein" }).click();
  const protein = page.getByRole("img", { name: /^Protein by day/u });
  expect(targetsIn(await tipAt(protein, 0))).toEqual(["Target ≥ 50 g"]);
  await tabs.getByRole("radio", { name: "Fat" }).click();
  const fat = page.getByRole("img", { name: /^Fat by day/u });
  expect(targetsIn(await tipAt(fat, 2))).toEqual(["Target ≤ 60 g"]);
});

test("a weigh-in's tooltip names the goal, not once hidden; the expanded chart too", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(1148, testInfo);
  const pid = await ownProfile(page, request, `Goal tip ${tag}`);
  for (const [day, kg] of [
    ["2025-01-06", 80],
    ["2025-01-08", 79],
    ["2025-01-13", 78],
    ["2025-01-15", 77],
  ])
    await request.put(`/api/profiles/${pid}/weights/${day}`, { data: { kg } });
  await setTarget(request, pid, "goal_weight", 76);
  await page.goto("/#/summary/body/month/2025-01-10");
  const section = page.locator("section.weight");
  const card = section.getByRole("img", { name: /^Weight by day/u });
  expect(targetsIn(await tipAt(card, 1))).toEqual(["Goal 76 kg"]);
  await section.getByRole("button", { name: "Expand chart" }).click();
  const big = page.getByRole("dialog").locator("canvas");
  expect(targetsIn(await tipAt(big, 2))).toEqual(["Goal 76 kg"]);
  // The goal toggled off (its legend entry): not named.
  await big.evaluate((c) => {
    const chart = window.Chart.getChart(c);
    chart.data.datasets.forEach((d, i) => {
      if (d.group === "target") chart.setDatasetVisibility(i, false);
    });
    chart.update();
  });
  expect(targetsIn(await tipAt(big, 2))).toEqual([]);
});
