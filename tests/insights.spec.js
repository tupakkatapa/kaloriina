// Insights: the weight trend, a goal weight's line and projection, the
// adaptive energy target, and where a nutrient comes from.

import { test, expect } from "@playwright/test";
import {
  answer,
  entry,
  exerciseIds,
  food,
  ownProfile,
  setTarget,
  todayInApp,
  unique,
  workout,
} from "./helpers.js";

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
  await expect(weight.getByRole("img", { name: /7-day trend/ })).toBeVisible();
  const tiles = weight
    .getByRole("list", { name: "Weight" })
    .getByRole("listitem");
  await expect(tiles).toContainText([
    "−0.7 kg a week",
    "79.8 kg trend on Jan 10",
  ]);
});

test("a goal weight: set on Targets, a dashed line and where the trend gets you", async ({
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
  const line = page.locator(".goal-projection");
  await expect(line).toHaveText(/^76\skg goal, around \w{3}, \w{3} \d{1,2}$/);
  await expect(page.locator(".weight canvas")).toHaveAccessibleName(
    /Dashed: your goal, 76\skg\.$/,
  );

  // Moving away from it, and no goal at all.
  const set = (goalKg) => setTarget(request, pid, "goal_weight", goalKg);
  await set(90);
  // It fits a narrow phone.
  await page.setViewportSize({ width: 320, height: 640 });
  await page.reload();
  await expect(line).toHaveText(/^90\skg goal, trend moving away$/);
  await expect(page.locator(".weight canvas")).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(320);
  await set(null);
  await page.reload();
  await expect(page.locator(".weight canvas")).toBeVisible();
  await expect(line).toHaveCount(0);
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
  await expect(page.locator(".goal-projection")).toHaveText(
    /^70\skg goal, no clear trend yet$/,
  );
});
test("too little data says what the energy balance still needs", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(401, testInfo);
  await ownProfile(page, request, `Balance ${tag}`);
  await page.goto("/#/summary/food/week");
  await expect(
    page.getByText(
      "Not enough data yet: needs 14 days with food logged and two weigh-ins 10 or more days apart. So far: 0 days with food; weigh-ins span 0 days.",
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Energy target →/ }),
  ).toHaveCount(0);
});

test("the energy balance sets the energy target, and Undo restores it", async ({
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
  // 2,000 kcal a day for 14 days while losing 0.1 kg a day: you use
  // 2,000 + 0.1 × 7,700 = 2,770 a day; the goal is to keep weight.
  for (let i = 1; i <= 14; i++)
    await entry(
      request,
      { day: ago(i), group: "Consumed", food_id: f.id, grams: 400 },
      pid,
    );
  await weigh(request, pid, ago(15), 80);
  await weigh(request, pid, ago(1), 78.6);

  await page.goto("/#/summary/food/week");
  const section = page.locator(".energy-balance");
  await expect(section).toContainText(
    "You ate 2,000 kcal a day and your trend fell 0.7 kg a week: you use about 2,770 kcal a day. For your goal: 2,770 kcal.",
  );
  await section
    .getByRole("button", { name: "Energy target → 2,770 kcal" })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText(
    "Protein stays 100 g; carbohydrate 296 g and fat 104 g scale with the energy.",
  );
  expect(await answer(page, "Set target")).toBe(
    // kcal() joins number and unit with a no-break space.
    "Set energy target to 2,770\u00a0kcal?",
  );
  const toast = page.locator(".toast");
  await expect(toast).toContainText("Energy target 2,000 kcal → 2,770 kcal");
  await expect.poll(() => energyTarget(request, pid)).toBe(2770);
  // At the new target, nothing more to offer.
  await expect(section.getByRole("button")).toHaveCount(0);

  await toast.getByRole("button", { name: "Undo" }).click();
  await expect.poll(() => energyTarget(request, pid)).toBe(2000);
  await expect(
    section.getByRole("button", { name: "Energy target → 2,770 kcal" }),
  ).toBeVisible();
});

test("a Summary nutrient opens the foods it came from", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag } = unique(403, testInfo);
  const salty = await food(request, {
    name: `Salty ${tag}`,
    per100: { sodium: 1000 },
  });
  const mild = await food(request, {
    name: `Mild ${tag}`,
    per100: { sodium: 1000 },
  });
  await entry(request, {
    day,
    group: "Consumed",
    food_id: salty.id,
    grams: 300,
  });
  await entry(request, {
    day,
    group: "Consumed",
    food_id: mild.id,
    grams: 100,
  });
  // Planned isn't eaten: not counted.
  await entry(request, { day, group: "Planned", food_id: mild.id, grams: 900 });

  await page.goto(`/#/summary/food/week/${day}`);
  await page.getByText("Other nutrients").click();
  await page.getByRole("link", { name: "Salt", exact: true }).click();
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
  await expect(page).toHaveURL(new RegExp(`#/summary/food/week/${day}$`));
});

test("the Summary lists the period's notes, measurements and plans", async ({
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

  await page.goto("/#/summary/training/week/2025-01-06");
  await expect(
    page.getByRole("list", { name: "Workouts" }).getByRole("listitem"),
  ).toHaveText(["0 workouts", "1 planned"]);
  await page.goto("/#/summary/body/week/2025-01-06");
  const measures = page.locator("ul.measurements li");
  await expect(measures).toHaveText([
    "Waist82 cm → 80.5 cm (−1.5 cm)",
    "Hips98 cm on Jan 8",
  ]);
  const note = page.locator("ul.notes li");
  await expect(note).toContainText(`Slept badly ${tag}`);
  await note.getByRole("link").click();
  await expect(page).toHaveURL(/#\/day\/2025-01-07$/);
});
