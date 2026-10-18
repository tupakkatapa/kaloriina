// What the Diary, the finder, a food's view and Summary →
// Food say of what isn't known, a floor, an unfinished day or a drink's
// basis. Every test uses a profile of its own, or mocks its data.

import { expect, test } from "@playwright/test";
import {
  dayTotal,
  fixedToday,
  food,
  ownProfile,
  todayInApp,
  unique,
} from "./helpers.js";

test.beforeEach(({ page }) => fixedToday(page));

const shift = (day, n) =>
  new Date(Date.parse(day) + n * 864e5).toISOString().slice(0, 10);

const put = async (request, path, data) =>
  expect((await request.put(path, { data })).ok()).toBeTruthy();

async function targets(request, pid, list) {
  const base = `/api/profiles/${pid}`;
  const { rev } = await (await request.get(base)).json();
  await put(request, `${base}/targets`, { rev, targets: list });
}

async function eat(request, pid, day, foodId, grams) {
  const res = await request.post(`/api/profiles/${pid}/entries`, {
    data: { day, group: "Eaten", food_id: foodId, grams },
  });
  expect(res.ok()).toBeTruthy();
}

const hydrationRow = (page) =>
  page.locator(".log-row", { has: page.locator(".hydration") });

test("hydration: under its goal it never rounds up to it; a drink of unknown water makes it a floor; no water bar beside it (T2N-2, T2N-5, T2N-6)", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(1055, testInfo);
  const pid = await ownProfile(page, request, `Hydration ${tag}`);
  const day = shift(todayInApp(), -1);
  await targets(request, pid, [{ metric: "water", value: 2500 }]);
  const tap = await food(request, {
    name: `Tap ${tag}`,
    per100: { water: 100 },
  });
  // 2,459 ml of 2.5 L read "2.5 L of 2.5 L".
  await eat(request, pid, day, tap.id, 2459);
  await page.goto(`/#/day/${day}`);
  await expect(hydrationRow(page).locator(".name")).toHaveText(
    /^2\.4\sL\sof\s2\.5\sL$/u,
  );
  // One water figure on the screen: the nutrient card has no Water bar.
  await page.locator("summary", { hasText: "Other nutrients" }).click();
  await expect(
    page.locator(".all-targets .target-label", { hasText: /^Water/u }),
  ).toHaveCount(0);

  // A soft drink served "330 ml" is a drink that counts; one with nothing
  // known leaves the day's hydration a floor.
  const mystery = await food(request, {
    name: `Mystery soda ${tag}`,
    per100: {},
    servings: [{ label: "330 ml", grams: 330 }],
  });
  expect(mystery.drink).toBe(true);
  await eat(request, pid, day, mystery.id, 330);
  await page.reload();
  await expect(hydrationRow(page).locator(".name")).toHaveText(
    /^≥\s2\.4\sL\sof\s2\.5\sL$/u,
  );
});

test("energy: a floor says how much is left only as an upper bound (≤); a nutrient short of all its energy reads ≥ (T2N-7, T2N-9)", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag } = unique(1056, testInfo);
  const pid = await ownProfile(page, request, `Floor ${tag}`);
  await targets(request, pid, [
    { metric: "energy", value: 1900 },
    { metric: "iron", value: 10 },
  ]);
  const bread = await food(request, {
    name: `Bread ${tag}`,
    per100: { energy: 369.6, iron: 1.8 },
  });
  const rice = await food(request, {
    name: `Rice ${tag}`,
    per100: { energy: 100 },
  });
  // A tablet without an energy value: the day's energy is a floor.
  const tablet = await food(request, {
    name: `Multivitamin ${tag}`,
    per100: { iron: 100 },
  });
  await eat(request, pid, day, bread.id, 500);
  await eat(request, pid, day, rice.id, 10);
  await eat(request, pid, day, tablet.id, 4.3);
  await page.goto(`/#/day/${day}`);
  const energy = page.locator(".targets-page .target.k-energy");
  await expect(energy.locator(".target-label")).toContainText(
    /≥\s1,858\skcal/u,
  );
  await expect(energy.locator("small")).toHaveText(/^≤\s137\skcal to go$/u);
  // Iron from 1,848 of 1,858 kcal: judged, but a floor all the same.
  await page.locator("summary", { hasText: "Other nutrients" }).click();
  const iron = page.locator(".all-targets .target", { hasText: "Iron" });
  await expect(iron.locator(".target-label")).toContainText(/≥\s13\smg/u);
  await expect(iron.locator("small")).toHaveText("Target met");
});

test("food calendar: today shows what's eaten so far, unjudged; the energy chart names its target range (T2N-10, T2N-20)", async ({
  page,
}) => {
  const today = todayInApp();
  const monday = shift(
    today,
    -((new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7),
  );
  const days = [dayTotal(shift(today, -1), 1500), dayTotal(today, 667)].filter(
    (d) => d.day >= monday,
  );
  await page.route("**/api/profiles/*/summary?*", (route) =>
    route.fulfill({
      json: { from: monday, to: shift(monday, 6), average: {}, days },
    }),
  );
  await page.route("**/api/profiles/*/targets", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({
          json: [{ metric: "energy", value: 2000, min: 2000, max: 2200 }],
        })
      : route.continue(),
  );
  await page.goto(`/#/summary/food/week/${monday}`);
  const cell = page.locator(`.food-cal td[data-day="${today}"]`);
  await expect(cell.getByRole("link")).toHaveAccessibleName(
    /:\s667\skcal so far$/u,
  );
  await expect(cell).not.toHaveClass(/over|shade-[1-4]/u);
  await expect(
    page.getByRole("img", { name: /^Energy by day/u }),
  ).toHaveAccessibleName(/and your eaten target range shaded\./u);
});

test("rows: a recipe's partial energy reads ≥, a drink's basis per 100 ml, a meal's partial energy ≥ (T2N-12, T2N-13)", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag } = unique(1057, testInfo);
  await ownProfile(page, request, `Rows ${tag}`);
  const pie = await food(request, {
    name: `Pie ${tag}`,
    per100: { energy: 240 },
  });
  const sauce = await food(request, {
    name: `Sauce ${tag}`,
    per100: { protein: 1 },
  });
  const soda = await food(request, {
    name: `Soda ${tag}`,
    per100: { energy: 42 },
    servings: [{ label: "33 cl", grams: 330 }],
  });
  expect(soda.drink).toBe(true);
  const recipe = await (
    await request.post("/api/recipes", {
      data: {
        name: `Pie and sauce ${tag}`,
        cooked_g: null,
        items: [
          { food_id: pie.id, grams: 100 },
          { food_id: sauce.id, grams: 100 },
        ],
      },
    })
  ).json();
  const meal = await request.post("/api/meals", {
    data: {
      name: `Pie meal ${tag}`,
      items: [
        { food_id: pie.id, grams: 100 },
        { food_id: sauce.id, grams: 50 },
      ],
    },
  });
  expect(meal.ok()).toBeTruthy();

  await page.goto(`/#/add/${day}/Eaten`);
  const search = page.getByLabel("Search foods", { exact: true });
  await search.fill(tag);
  await expect(
    page.getByRole("button", { name: new RegExp(`^${recipe.name}`, "u") }),
  ).toContainText(/≥\s120\skcal per 100\sg/u);
  await expect(
    page.getByRole("button", { name: new RegExp(`^Soda ${tag}`, "u") }),
  ).toContainText(/42\skcal per 100\sml/u);
  await search.fill("");
  await expect(
    page.getByRole("link", { name: new RegExp(`^Pie meal ${tag}`, "u") }),
  ).toContainText(/2 items · ≥\s240\skcal/u);
});

test("a food's view: no verdict while a light isn't known, said why; the US label gives no protein %DV and a floor's %DV as one (T2N-4, T2N-18)", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(1058, testInfo);
  await ownProfile(page, request, `Labels ${tag}`);
  // Mexicana pizza (Fineli 4544): saturates, sugars and salt not given.
  const pizza = await food(request, {
    name: `Pizza ${tag}`,
    per100: { energy: 249.5, protein: 11.9, fat: 10 },
  });
  expect(pizza.labels.verdict).toBeNull();
  await page.goto(`/#/log/${todayInApp()}/Eaten/${pizza.id}`);
  const labels = page.locator(".lights.labels");
  await expect(labels).toHaveText(
    "No verdict: sat. fat, sugars and salt not known",
  );

  // A recipe whose fat only half its energy carries: its %DV a floor.
  const oil = await food(request, {
    name: `Oil ${tag}`,
    per100: { energy: 100, fat: 11 },
  });
  const rice = await food(request, {
    name: `Plain rice ${tag}`,
    per100: { energy: 100, protein: 2 },
  });
  const bowl = await (
    await request.post("/api/recipes", {
      data: {
        name: `Bowl ${tag}`,
        cooked_g: null,
        items: [
          { food_id: oil.id, grams: 100 },
          { food_id: rice.id, grams: 100 },
        ],
      },
    })
  ).json();
  await page.addInitScript(() => localStorage.setItem("label-style", "us"));
  await page.goto(`/#/log/${todayInApp()}/Eaten/${bowl.id}`);
  await page.reload();
  const row = (name) =>
    page.locator(".nutrition-panel tr", {
      has: page.getByRole("rowheader", { name, exact: true }),
    });
  await expect(row("Protein").locator(".dv")).toHaveCount(0);
  await expect(row("Fat").locator(".dv").first()).toHaveText(/≥\s\d+\s%/u);
});
