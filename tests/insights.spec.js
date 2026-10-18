// Insights: the weight trend, a goal weight's line and projection, the
// adaptive energy target, and where a nutrient comes from.

import { expect, test } from "@playwright/test";
import {
  answer,
  entry,
  exerciseIds,
  expectFits,
  fixedToday,
  food,
  ownProfile,
  setTarget,
  todayInApp,
  unique,
  workout,
} from "./helpers.js";

// One today for the whole test, in the page and here.
test.beforeEach(({ page }) => fixedToday(page));

// `n` days before today as the page sees it.
const ago = (n) => {
  const d = new Date(`${todayInApp()}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};

async function weigh(request, pid, day, kg) {
  const res = await request.put(`/api/profiles/${pid}/weights/${day}`, {
    data: { kg },
  });
  expect(res.ok()).toBeTruthy();
}

async function setTargets(request, pid, targets) {
  const me = await (await request.get(`/api/profiles/${pid}`)).json();
  const res = await request.put(`/api/profiles/${pid}/targets`, {
    data: { rev: me.rev, targets },
  });
  expect(res.ok()).toBeTruthy();
}

const energyTarget = async (request, pid) =>
  (await (await request.get(`/api/profiles/${pid}/targets`)).json()).find(
    (t) => t.metric === "energy",
  )?.value;

test("the weight section charts weigh-ins and states the trend", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(400, testInfo);
  const pid = await ownProfile(page, request, `Trend ${tag}`);
  // Monday to Friday of one past week: down 0.1 kg a day.
  await weigh(request, pid, "2025-01-06", 80);
  await weigh(request, pid, "2025-01-08", 79.8);
  await weigh(request, pid, "2025-01-10", 79.6);
  await page.goto("/#/summary/body/week/2025-01-06");
  const weight = page.locator("section.finder-section", {
    has: page.getByRole("heading", { name: "Weight" }),
  });
  await expect(weight.getByRole("img", { name: /the trend/u })).toBeVisible();
  const tiles = weight.getByRole("list", { name: "Weight" }).locator(".tile");
  // Three weigh-ins are too few for a rate: a day's water would read as one.
  await expect(tiles).toHaveText([
    /^79\.8\skg weight trend, Jan 10$/u,
    // The trend's change, not two readings'.
    /^−0\.2\skg change over 3 weigh-ins$/u,
  ]);
  // A fourth, a week after the first: still no rate under two weeks.
  await weigh(request, pid, "2025-01-12", 79.4);
  await page.reload();
  await expect(tiles).toHaveText([
    /^79\.7\skg weight trend, Jan 12$/u,
    /^−0\.3\skg change over 4 weigh-ins$/u,
  ]);
  // Over two weeks the month gives the rate a week with its margin.
  await weigh(request, pid, "2025-01-15", 79.15);
  await weigh(request, pid, "2025-01-18", 78.75);
  await weigh(request, pid, "2025-01-21", 78.5);
  await page.goto("/#/summary/body/month/2025-01-01");
  await expect(tiles).toHaveText([
    // A margin under 0.1 kg to two decimals, never "± 0".
    /^−0\.7\skg a week, ±\s0\.03\skg$/u,
    /^78\.8\skg weight trend, Jan 21$/u,
    /^−1\.2\skg change over 7 weigh-ins$/u,
  ]);
  // Water swings around a flat line: no clear change, the margin said.
  await weigh(request, pid, "2025-01-15", 80.2);
  await weigh(request, pid, "2025-01-18", 79.3);
  await weigh(request, pid, "2025-01-21", 80.1);
  await page.reload();
  await expect(tiles.first()).toHaveText(
    /^No clear change a week, ±\s0\.4\skg$/u,
  );
});

test("a goal weight: set on Targets, a dashed line (hidden when far) and where the trend gets you (item 20)", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(615, testInfo);
  const pid = await ownProfile(page, request, `Goal ${tag}`);
  const today = todayInApp();
  // Losing 0.1 kg a day for three weeks, to 78 kg today.
  for (let n = 20; n >= 0; n -= 1)
    await request.put(`/api/profiles/${pid}/weights/${ago(n)}`, {
      data: { kg: Math.round((78 + n * 0.1) * 10) / 10 },
    });

  await page.goto("/#/targets");
  const goal = page.getByLabel("Goal weight target");
  await expect(goal).toHaveValue("");
  await goal.fill("76");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator("#toast")).toContainText("Saved targets");
  expect(
    (await (await request.get(`/api/profiles/${pid}/targets`)).json()).find(
      (t) => t.metric === "goal_weight",
    ).value,
  ).toBe(76);

  await page.goto(`/#/summary/body/month/${today}`);
  const line = page.locator(".goal-projection .tile");
  await expect(line).toHaveText(/^76\skg goal, around \w{3}, \w{3} \d{1,2}$/u);

  // Moving away from it, and no goal at all.
  const set = (goalKg) => setTarget(request, pid, "goal_weight", goalKg);
  await set(90);
  // It fits a narrow phone.
  await page.setViewportSize({ width: 320, height: 640 });
  await page.reload();
  await expect(line).toHaveText(/^90\skg goal, trend moving away$/u);
  const canvas = page.locator(".weight canvas");
  await expect(canvas).toBeVisible();
  // Too far to chart without flattening the weigh-ins: in the legend,
  // struck through until tapped; said in the list; nothing written under
  // the chart.
  const goalShown = () =>
    canvas.evaluate((c) => {
      const item = window.Chart?.getChart(c)?.legend.legendItems.find(
        (i) => i.text === "Goal",
      );
      return item && !item.hidden;
    });
  await expect.poll(goalShown).toBe(false);
  await expect(page.locator(".weight ul.sr-only li").last()).toHaveText(
    /^Goal: 90\skg$/u,
  );
  await expect(
    page.locator(".weight .chart-goal, .weight .chart-note"),
  ).toHaveCount(0);
  await expectFits(page);
  await set(null);
  await page.reload();
  await expect(page.locator(".weight canvas")).toBeVisible();
  await expect(line).toHaveCount(0);

  // A goal near the weigh-ins is a dashed line on the chart, named to the
  // tenth as its tile says it.
  await set(77.9);
  await page.reload();
  await expect(line).toHaveText(/^77\.9\skg goal, /u);
  await expect(page.locator(".weight ul.sr-only li").last()).toHaveText(
    /^Goal: 77\.9\skg$/u,
  );
  await expect.poll(goalShown).toBe(true);
});

test("a goal with too few weigh-ins says there's no clear trend yet", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(616, testInfo);
  const pid = await ownProfile(page, request, `Fresh ${tag}`);
  const today = todayInApp();
  for (const [n, kg] of [
    [5, 80],
    [0, 79],
  ])
    await request.put(`/api/profiles/${pid}/weights/${ago(n)}`, {
      data: { kg },
    });
  await setTarget(request, pid, "goal_weight", 70);
  await page.goto(`/#/summary/body/month/${today}`);
  await expect(page.locator(".goal-projection .tile")).toHaveText(
    /^70\skg goal, no clear trend yet$/u,
  );
});
test("Summary sets no energy target: no Last 4 weeks; Targets says why its maintenance isn't the balance (item 18)", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(401, testInfo);
  await ownProfile(page, request, `Balance ${tag}`);
  await page.goto("/#/summary/food/week");
  // No food day: no balance, not a heading on its own.
  await expect(page.locator(".energy-balance")).toHaveCount(0);
  await expect(page.getByText("Last 4 weeks")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /Energy target →/u }),
  ).toHaveCount(0);
  // Targets is the one home: the uncertainty worded as its reason.
  await page.goto("/#/targets");
  await expect(page.locator(".needed-energy")).toContainText(
    "Your weight trend is too short to say: about 2 more weeks of food and weigh-ins.",
  );
});

test("Targets offers the energy the balance needs, and Undo restores it", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(402, testInfo);
  const pid = await ownProfile(page, request, `Adapt ${tag}`);
  await setTargets(request, pid, [
    { metric: "energy", value: 2000 },
    { metric: "protein", value: 100 },
    { metric: "net_carbs", value: 200 },
    { metric: "fat", value: 70 },
  ]);
  const f = await food(request, {
    name: `Diet ${tag}`,
    per100: { energy: 500 },
  });
  // 2,000 kcal a day for 14 days while losing 0.1 kg a day; the 7-day
  // trend, warming up over the window, falls 0.6 kg a week: maintenance is
  // about 2,000 + 0.6 / 7 × 7,700 ≈ 2,616 a day, sure (the weigh-ins on
  // one line); the goal is to keep weight, so needed() plans 2,620.
  for (let i = 1; i <= 14; i++)
    await entry(
      request,
      { day: ago(i), group: "Eaten", food_id: f.id, grams: 400 },
      pid,
    );
  for (let n = 15; n >= 1; n -= 1)
    await weigh(
      request,
      pid,
      ago(n),
      Math.round((78.6 + (n - 1) * 0.1) * 10) / 10,
    );

  await page.goto("/#/targets");
  const section = page.locator(".needed-energy");
  // Maintenance, needed and resting as tiles.
  await expect(
    section.getByRole("list", { name: "Needed energy" }).locator(".tile"),
  ).toHaveText([
    /^≈ 2,620\skcal \(± 0\)\s*maintenance a day$/u,
    /^2,620\skcal\s*needed a day$/u,
    /^≈ [\d,]+\skcal\s*resting a day$/u,
  ]);
  await expect(
    section
      .getByRole("list", { name: "Needed energy" })
      .locator(".tile")
      .first(),
  ).toHaveAccessibleDescription(
    "What keeps your weight where it is, a day: from what you ate and how your weight moved.",
  );
  await expect(section.locator(".needed-pace")).toHaveText(
    "No goal set: planned to keep your weight.",
  );
  // Sure: no reason to give.
  await expect(section).not.toContainText("too short");
  await section
    .getByRole("button", { name: "Energy target → 2,620 kcal" })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText(
    "Protein stays 100 g; carbs 278 g and fat 97 g scale with the energy.",
  );
  expect(await answer(page, "Set target")).toBe(
    "Set energy target to 2,620\u00A0kcal?",
  );
  const toast = page.locator(".toast");
  await expect(toast).toContainText("Energy target 2,000 kcal → 2,620 kcal");
  await expect.poll(() => energyTarget(request, pid)).toBe(2620);
  await toast.getByRole("button", { name: "Undo" }).click();
  await expect.poll(() => energyTarget(request, pid)).toBe(2000);
});

test("a Summary nutrient opens the foods it came from", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag } = unique(403, testInfo);
  const salty = await food(request, {
    name: `Salty ${tag}`,
    per100: { energy: 100, sodium: 1000 },
  });
  const mild = await food(request, {
    name: `Mild ${tag}`,
    per100: { energy: 100, sodium: 1000 },
  });
  await entry(request, {
    day,
    group: "Eaten",
    food_id: salty.id,
    grams: 300,
  });
  await entry(request, {
    day,
    group: "Eaten",
    food_id: mild.id,
    grams: 100,
  });
  // Planned isn't eaten: not counted.
  await entry(request, { day, group: "Planned", food_id: mild.id, grams: 900 });

  await page.goto(`/#/summary/food/week/${day}`);
  // Salt is one of the highlighted averages, its name a link to where it
  // came from.
  await page
    .locator(".daily-averages")
    .getByRole("button", { name: "Highlighted" })
    .click();
  await page
    .locator(".daily-averages :not([inert]) > .target")
    .getByRole("link", { name: "Salt" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Where salt comes from" }),
  ).toBeVisible();
  const rows = page.locator("ul.sources li");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText(`Salty ${tag}`);
  await expect(rows.nth(0)).toContainText("75 %");
  await expect(rows.nth(1)).toContainText(`Mild ${tag}`);
  await expect(rows.nth(1)).toContainText("25 %");
  await page.getByRole("link", { name: "Back" }).click();
  await expect(page).toHaveURL(new RegExp(`#/summary/food/week/${day}$`, "u"));
});

test("the Summary lists the period's notes and plans, and charts its measurements", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(405, testInfo);
  const pid = await ownProfile(page, request, `Week ${tag}`);
  const put = async (path, data) =>
    expect(
      (await request.put(`/api/profiles/${pid}${path}`, { data })).ok(),
    ).toBeTruthy();
  await put("/notes/2025-01-07", { text: `Slept badly ${tag}` });
  await put("/measurements/2025-01-06/waist", { value: 82 });
  await put("/measurements/2025-01-10/waist", { value: 80.5 });
  await put("/measurements/2025-01-08/hips", { value: 98 });
  const id = await exerciseIds(request);
  const w = await workout(request, {
    name: `Legs ${tag}`,
    steps: [{ kind: "exercise", exercise_id: id("Burpee"), reps: 10 }],
  });
  const plan = await request.post(`/api/profiles/${pid}/plans`, {
    data: { day: "2025-01-09", workout_id: w.id },
  });
  expect(plan.ok()).toBeTruthy();

  await page.goto("/#/summary/activity/week/2025-01-06");
  await expect(
    page.getByRole("list", { name: "Activities" }).locator(".tile"),
  ).toHaveText(["0 activities", "1 planned"]);
  await page.goto("/#/summary/body/week/2025-01-06");
  // Measurements chart in the body switch: waist's two, hips' one in words.
  const section = page.locator("section.weight");
  await expect(
    section.getByRole("heading", { name: "Waist by day" }),
  ).toBeVisible();
  await expect(
    page.getByRole("radiogroup", { name: "Chart" }).getByRole("radio"),
  ).toHaveText(["Waist", "Hips"]);
  await page
    .getByRole("radiogroup", { name: "Chart" })
    .getByRole("radio", { name: "Hips" })
    .click();
  await expect(section.getByText(/^Hips: 98\scm on Jan 8$/u)).toBeVisible();
  const note = page.locator("ul.notes li");
  await expect(note).toContainText(`Slept badly ${tag}`);
  await note.getByRole("link").click();
  await expect(page).toHaveURL(/#\/day\/2025-01-07$/u);
});

// A rate is judged as it reads. A steady +0.035 kg a week
// with no scatter is "clear" in kg, but reads ±0.0: no clear change, its
// margin never "± 0".
test("a clear rate that rounds to ±0 reads No clear change; a tiny margin < 0.01", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(1144, testInfo);
  const pid = await ownProfile(page, request, `Steady ${tag}`);
  // Every second day of March 2025: +0.01 kg each, a straight line.
  for (let i = 0; i < 15; i += 1)
    await weigh(
      request,
      pid,
      `2025-03-${String(1 + 2 * i).padStart(2, "0")}`,
      Math.round((80 + 0.01 * i) * 100) / 100,
    );
  await page.goto("/#/summary/body/month/2025-03-10");
  const tiles = page
    .locator("section.finder-section", {
      has: page.getByRole("heading", { name: "Weight" }),
    })
    .getByRole("list", { name: "Weight" })
    .locator(".tile");
  await expect(tiles.first()).toHaveText(
    /^No clear change a week, ±\s<\s0\.01\skg$/u,
  );
});
