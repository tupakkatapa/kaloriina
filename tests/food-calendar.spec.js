// Summary → Food's calendar: each day against the picked key target
// (amounts, labels, shades, the stats line), the metric kept on the device,
// drill-down, kJ; and the bottom tabs' order. The period's data is mocked,
// so the days and targets are exact.

import { expect, test } from "@playwright/test";
import { dayTotal } from "./helpers.js";

// Monday 3 – Sunday 9 March 2025 (past, so every day is shaded): the 7th
// and 8th unlogged.
const DAYS = [
  ["2025-03-03", 2100, 120, 50],
  ["2025-03-04", 1620, 40, 60],
  ["2025-03-05", 2500, 70, 70],
  ["2025-03-06", 900, 100, 80],
  ["2025-03-09", 2000, 105, 90],
].map(([day, energy, protein, fat]) => ({
  ...dayTotal(day, energy),
  total: { energy, protein, fat },
}));

// Energy "about" 2000 (up to 10 % over), protein "at least" 100; fat none.
const TARGETS = [
  { metric: "energy", value: 2000, min: 2000, max: 2200 },
  { metric: "protein", value: 100, min: 100, max: null },
];

async function mock(page) {
  await page.route("**/api/profiles/*/summary?*", (route) =>
    route.fulfill({
      json: {
        from: "2025-03-03",
        to: "2025-03-09",
        days_logged: DAYS.length,
        average: {},
        days: DAYS,
      },
    }),
  );
  await page.route("**/api/profiles/*/targets", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({ json: TARGETS })
      : route.continue(),
  );
}

const cell = (page, day) => page.locator(`.food-cal td[data-day="${day}"]`);
const metric = (page, name) =>
  page
    .getByRole("radiogroup", { name: "Chart and calendar" })
    .getByRole("radio", { name, exact: true });
const stats = (page) => page.locator(".food-calendar .tiles .tile");
const legend = (page) => page.locator(".food-calendar .cal-legend");
// A label as the app writes it (no-break spaces between number and unit).
const label = (text) =>
  new RegExp(
    `^${text.replaceAll(/[().]/gu, "\\$&").replaceAll(" ", "\\s")}$`,
    "u",
  );

test("food calendar: energy against its target, shaded and labelled", async ({
  page,
}) => {
  await mock(page);
  await page.goto("/#/summary/food/week/2025-03-03");
  await expect(metric(page, "Energy")).toHaveAttribute("aria-checked", "true");
  // Not the chart's heading again.
  await expect(page.locator(".food-cal caption")).toHaveText(
    "Energy: days against the target",
  );
  await expect(stats(page)).toHaveText(
    ["2 of 5 days on target", "1 day over"].map((x) => label(x)),
  );
  // The chart cards lead; the calendar follows them.
  const order = await page
    .locator(".food-calendar, .chart-section")
    .evaluateAll((list) => list.map((n) => n.className));
  expect(order[0]).toContain("chart-section");
  expect(order.at(-1)).toContain("food-calendar");
  for (const [day, amount, shade, words] of [
    ["2025-03-03", "2,100", "shade-4", "Mon, Mar 3: 2,100 kcal, on target"],
    [
      "2025-03-04",
      "1,620",
      "shade-3",
      "Tue, Mar 4: 1,620 kcal, 380 kcal under",
    ],
    ["2025-03-05", "2,500", "shade-0", "Wed, Mar 5: 2,500 kcal, over"],
    ["2025-03-06", "900", "shade-1", "Thu, Mar 6: 900 kcal, 1,100 kcal under"],
    ["2025-03-09", "2,000", "shade-4", "Sun, Mar 9: 2,000 kcal, on target"],
  ]) {
    await expect(cell(page, day).locator(".cal-amount")).toHaveText(amount);
    await expect(cell(page, day)).toHaveClass(
      new RegExp(`\\b${shade}\\b`, "u"),
    );
    await expect(cell(page, day).getByRole("link")).toHaveAttribute(
      "aria-label",
      label(words),
    );
  }
  await expect(cell(page, "2025-03-05")).toHaveClass(/\bover\b/u);
  await expect(cell(page, "2025-03-03")).not.toHaveClass(/\bover\b/u);
  await expect(cell(page, "2025-03-07")).toHaveClass(/\bnone\b/u);
  await expect(cell(page, "2025-03-07").getByRole("link")).toHaveAttribute(
    "aria-label",
    "Fri, Mar 7: nothing logged",
  );
  await expect(cell(page, "2025-03-07").locator(".cal-amount")).toHaveText("");
  await expect(legend(page)).toContainText("on target");
  await expect(legend(page)).toContainText("over");
  await expect(legend(page)).not.toContainText("No target");
  // Tap → the Diary's day.
  await cell(page, "2025-03-03").getByRole("link").click();
  await expect(page).toHaveURL(/#\/day\/2025-03-03$/u);
});

test("food calendar: the metric is kept on the device; no target shades by amount", async ({
  page,
}) => {
  await mock(page);
  await page.goto("/#/summary/food/week/2025-03-03");
  await metric(page, "Protein").click();
  await expect(page.locator(".food-cal caption")).toHaveText(
    "Protein: days against the target",
  );
  // One switch drives the chart too.
  await expect(
    page.getByRole("img", { name: /^Protein by day/u }),
  ).toBeVisible();
  await expect(page.getByRole("radiogroup")).toHaveCount(1);
  await expect(cell(page, "2025-03-03").locator(".cal-amount")).toHaveText(
    "120",
  );
  await expect(cell(page, "2025-03-04")).toHaveClass(/\bshade-1\b/u);
  await expect(cell(page, "2025-03-05")).toHaveClass(/\bshade-2\b/u);
  await expect(cell(page, "2025-03-04").getByRole("link")).toHaveAttribute(
    "aria-label",
    label("Tue, Mar 4: 40 g, 60 g under"),
  );
  await expect(stats(page)).toHaveText(
    ["3 of 5 days on target"].map((x) => label(x)),
  );
  // "At least" is never over: no over mark in the key.
  await expect(legend(page).getByRole("list", { name: "Marks" })).toHaveText(
    "Nothing logged",
  );
  await page.reload();
  await expect(metric(page, "Protein")).toHaveAttribute("aria-checked", "true");
  await expect(cell(page, "2025-03-03").locator(".cal-amount")).toHaveText(
    "120",
  );
  // Fat has no target: quartiles of the period's amounts.
  await metric(page, "Fat").click();
  for (const [day, shade] of [
    ["2025-03-03", "shade-1"],
    ["2025-03-05", "shade-2"],
    ["2025-03-06", "shade-3"],
    ["2025-03-09", "shade-4"],
  ])
    await expect(cell(page, day)).toHaveClass(
      new RegExp(`\\b${shade}\\b`, "u"),
    );
  await expect(cell(page, "2025-03-03").getByRole("link")).toHaveAttribute(
    "aria-label",
    label("Mon, Mar 3: 50 g"),
  );
  // 2031 is in the future: no comparison with the week before.
  await expect(stats(page)).toHaveText(
    ["5 logged days", "350 g in total"].map((x) => label(x)),
  );
  await expect(page.locator(".food-cal caption")).toHaveText(
    "Fat: days by amount",
  );
  await expect(legend(page)).toContainText("No target: shaded by amount");
  // Only the four key targets, as one quiet switch.
  await expect(
    page
      .getByRole("radiogroup", { name: "Chart and calendar" })
      .getByRole("radio"),
  ).toHaveText(["Energy", "Protein", "Carbs", "Fat"]);
});

test("food calendar: kJ on a kJ device, and fits a phone", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("energy-unit", "kJ"));
  await page.setViewportSize({ width: 320, height: 700 });
  await mock(page);
  await page.goto("/#/summary/food/week/2025-03-03");
  await expect(cell(page, "2025-03-05").locator(".cal-amount")).toHaveText(
    "10.5K",
  );
  await expect(cell(page, "2025-03-04").getByRole("link")).toHaveAttribute(
    "aria-label",
    label("Tue, Mar 4: 6,778 kJ, 1,590 kJ under"),
  );
  // Every amount fits its cell.
  const spill = await page
    .locator(".food-cal td.cal-cell")
    .evaluateAll((cells) =>
      cells
        .filter((c) => c.scrollWidth > c.clientWidth)
        .map((c) => c.dataset.day),
    );
  expect(spill).toEqual([]);
});

test("food calendar: a year's mini months open the month on Food", async ({
  page,
}) => {
  await mock(page);
  await page.goto("/#/summary/food/year/2025-03-03");
  await expect(page.locator(".food-calendar .cal.mini")).toHaveCount(12);
  await expect(cell(page, "2025-03-05")).toHaveClass(/\bover\b/u);
  await page
    .locator(".food-calendar .cal.mini caption")
    .getByRole("link", { name: "Mar" })
    .click();
  await expect(page).toHaveURL(/#\/summary\/food\/month\/2025-03-01$/u);
  await expect(page.locator(".food-cal td.cal-cell")).toHaveCount(31);
});

test("the tabs: Activity · Foods · Diary · Summary · Profile; a desktop starts with Diary", async ({
  page,
}) => {
  await page.goto("/#/");
  const tabs = page
    .getByRole("navigation", { name: "Main" })
    .locator("a[data-tab]");
  const keys = () => tabs.evaluateAll((list) => list.map((a) => a.dataset.tab));
  const layout = (value) =>
    page.evaluate((v) => {
      localStorage.setItem("layout", v);
      document.dispatchEvent(new Event("layoutchange"));
    }, value);
  await layout("phone");
  expect(await keys()).toEqual([
    "activity",
    "foods",
    "diary",
    "summary",
    "profile",
  ]);
  await expect(tabs).toContainText([
    "Activity",
    "Foods",
    "Diary",
    "Summary",
    "Profile",
  ]);
  // The sidebar moves Diary first in the page itself: focus follows it.
  await layout("desktop");
  expect(await keys()).toEqual([
    "diary",
    "activity",
    "foods",
    "summary",
    "profile",
  ]);
  await page.reload();
  expect(await keys()).toEqual([
    "diary",
    "activity",
    "foods",
    "summary",
    "profile",
  ]);
  await layout("phone");
  expect((await keys())[2]).toBe("diary");
});
