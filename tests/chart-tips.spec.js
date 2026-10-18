// A chart's tooltip on a phone sits clear of the finger: above the point
// touched (the highest of the series there), or beside it with no room
// above; never under the thumb. One config for every chart (Food's energy
// and macros, Body's, Heart's).

import { expect, test } from "@playwright/test";
import { entry, food, ownProfile, syncHealth, unique } from "./helpers.js";

const WEEK = "2026-09-07";
const days = ["2026-09-07", "2026-09-08", "2026-09-09", "2026-09-10"];

test.skip(
  ({ isMobile }) => !isMobile,
  "The thumb is a phone's: a desktop's pointer is no cover",
);

// A profile eating little (so what it burned charts far above what it
// ate), weighing in daily, with resting heart rate.
async function seeded(page, request, tag) {
  const pid = await ownProfile(page, request, `Tips ${tag}`);
  const f = await food(request, {
    name: `Soup ${tag}`,
    per100: { energy: 100, protein: 6, carbs: 10, fat: 3 },
  });
  for (const [i, day] of days.entries()) {
    await entry(
      request,
      { day, group: "Eaten", food_id: f.id, grams: 600 + i * 150 },
      pid,
    );
    await request.put(`/api/profiles/${pid}/weights/${day}`, {
      data: { kg: 60 - i * 0.3 },
    });
  }
  const res = await syncHealth(request, pid, {
    from: days[0],
    to: days.at(-1),
    device: "Pixel 9",
    days: days.map((day, i) => ({ day, resting_hr: 52 + i * 3 })),
  });
  expect(res.status()).toBe(200);
}

// Tap the highest point of day `i` on the chart named `name`, and the
// tooltip's box against the finger, in page px.
async function tapHighest(page, name, i) {
  const canvas = page.getByRole("img", { name });
  await expect
    .poll(() => canvas.evaluate((c) => Boolean(window.Chart?.getChart(c))))
    .toBe(true);
  await canvas.scrollIntoViewIfNeeded();
  const at = await canvas.evaluate((c, index) => {
    const chart = window.Chart.getChart(c);
    const box = c.getBoundingClientRect();
    const ys = chart.data.datasets
      .map((d, k) => chart.getDatasetMeta(k))
      .filter((m) => !m.hidden && m.data[index] && m.type === "line")
      .map((m) => m.data[index])
      .filter((p) => Number.isFinite(p.y) && !p.skip);
    const top = ys.reduce((a, p) => (p.y < a.y ? p : a));
    return { x: box.left + top.x, y: box.top + top.y };
  }, i);
  await page.touchscreen.tap(at.x, at.y);
  // The app's one tooltip (web/tips.mjs), drawn for the chart.
  const shown = canvas.locator("xpath=..").locator(".chart-tip");
  await expect(shown).toBeVisible();
  const box = await shown.boundingBox();
  const tip = {
    left: box.x,
    top: box.y,
    right: box.x + box.width,
    bottom: box.y + box.height,
  };
  return { at, tip };
}

// Above the finger, or wholly beside it.
const clear = ({ at, tip }) =>
  tip.bottom <= at.y - 8 || tip.left >= at.x + 8 || tip.right <= at.x - 8;

test("Food's energy and macro tooltips sit clear of the finger", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(74, testInfo);
  await seeded(page, request, tag);
  await page.goto(`/#/summary/food/week/${WEEK}`);
  // Burned charts far above eaten: the finger on burned's point.
  const energy = await tapHighest(page, /^Energy by day/u, 1);
  expect(clear(energy), JSON.stringify(energy)).toBe(true);
  await page
    .getByRole("radiogroup", { name: "Chart and calendar" })
    .getByRole("radio", { name: "Protein", exact: true })
    .tap();
  const protein = await tapHighest(page, /^Protein by day/u, 2);
  expect(clear(protein), JSON.stringify(protein)).toBe(true);
});

test("Body's weight and heart tooltips sit clear of the finger", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(75, testInfo);
  await seeded(page, request, tag);
  await page.goto(`/#/summary/body/week/${WEEK}`);
  const weight = await tapHighest(page, /^Weight by day/u, 1);
  expect(clear(weight), JSON.stringify(weight)).toBe(true);
  const heart = await tapHighest(page, /^RHR by day/u, 3);
  expect(clear(heart), JSON.stringify(heart)).toBe(true);
});
