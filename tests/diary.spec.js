// The Diary tab: logging, moving and editing entries, a day's targets.

import { test, expect } from "@playwright/test";
import {
  unique,
  starts,
  food,
  answer,
  entry,
  ownProfile,
  headline,
  todayInApp,
  realDay,
} from "./helpers.js";

// What a mocked day changes in the real one: its groups, totals and targets.
const dayPatch = (
  groups,
  { total = {}, consumed = {}, targets = [] } = {},
) => ({
  groups,
  total,
  consumed,
  targets,
});

// An "at least" target, as the API answers it.
const target = (nutrient, value) => ({
  nutrient,
  value,
  min: value,
  max: null,
});

// A diary section by its heading ("Planned", "Eaten", "Log").
const section = (page, name) =>
  page.locator("section.group", {
    has: page.getByRole("heading", { name, exact: true }),
  });

// An imported diary row: no food behind it, no nutrients of its own.
const importedRow = (day, fields) => ({
  id: 1,
  day,
  group: "Other",
  food_id: null,
  grams: null,
  serving: null,
  quantity: null,
  nutrients: null,
  imported: true,
  created_at: "",
  uid: "x",
  source: null,
  ...fields,
});

// Answer a mocked day, and its entries by id for the entry editor.
async function mockDay(page, day, patch, entries = []) {
  await realDay(page, day, patch);
  for (const e of entries)
    await page.route(`**/api/profiles/*/entries/${e.id}`, (route) =>
      route.request().method() === "GET"
        ? route.fulfill({ json: e })
        : route.fallback(),
    );
}

test("log a food to Planned, then move it to Eaten", async ({
  page,
}, testInfo) => {
  const { day, tag } = unique(1, testInfo);
  const name = `Oats ${tag}`;

  await page.goto("/#/food/new");
  await page.getByLabel("Name").fill(name);
  await page.getByLabel("Energy (kcal)").fill("380");
  await page.getByLabel("Protein (g)").fill("13");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page).toHaveURL(/#\/food\/\d+$/);

  await page.goto(`/#/day/${day}`);
  const planned = section(page, "Planned");
  await planned.getByRole("link", { name: "Add to Planned" }).click();
  await page.getByLabel("Search foods").fill(name);
  await page.getByRole("button", { name: starts(name) }).click();
  await page.getByLabel("Quantity").fill("50");
  await page.getByRole("button", { name: "Add to Planned" }).click();

  await expect(planned.getByText(name)).toBeVisible();
  await expect(page.getByText(/190\skcal with planned/)).toBeVisible();
  await page.getByRole("button", { name: `Mark ${name} eaten` }).click();

  await expect(section(page, "Eaten").getByText(name)).toBeVisible();
  await expect(headline(page)).toHaveText(/^190\skcal$/);
});

test("edit grams and delete an entry", async ({ page, request }, testInfo) => {
  const { day, tag } = unique(2, testInfo);
  const f = await food(request, {
    name: `Rice ${tag}`,
    per100: { energy: 100 },
  });
  await entry(request, { day, group: "Consumed", food_id: f.id, grams: 100 });

  await page.goto(`/#/day/${day}`);
  await page.getByRole("link", { name: starts(`Rice ${tag}`) }).click();
  await page.getByLabel("Quantity").fill("250");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(headline(page)).toHaveText(/^250\skcal$/);

  await page.getByRole("link", { name: starts(`Rice ${tag}`) }).click();
  await page.getByRole("button", { name: "Delete" }).click();
  expect(await answer(page, "Delete")).toBe(`Delete Rice ${tag}?`);
  await expect(page).toHaveURL(new RegExp(`#/day/${day}$`));
  await expect(page.locator(".entry", { hasText: `Rice ${tag}` })).toHaveCount(
    0,
  );
});

test("delete asks first and can be cancelled", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag } = unique(3, testInfo);
  const f = await food(request, { name: `Kale ${tag}` });
  await entry(request, { day, group: "Consumed", food_id: f.id, grams: 50 });

  await page.goto(`/#/day/${day}`);
  await page.getByRole("link", { name: starts(`Kale ${tag}`) }).click();
  await page.getByRole("button", { name: "Delete" }).click();
  expect(await answer(page, "Cancel")).toBe(`Delete Kale ${tag}?`);
  await expect(page).toHaveURL(/#\/entry\/\d+$/);
  const res = await request.get(`/api/profiles/1/day/${day}`);
  const names = (await res.json()).groups.flatMap((g) =>
    g.entries.map((e) => e.name),
  );
  expect(names).toContain(`Kale ${tag}`);
});

test("targets show progress bars", async ({ page, request }, testInfo) => {
  const { day, tag } = unique(4, testInfo);
  const pid = await ownProfile(page, request, `Bars ${tag}`);
  const f = await food(request, {
    name: `Bread ${tag}`,
    per100: { energy: 250, protein: 10 },
  });
  await entry(
    request,
    { day, group: "Consumed", food_id: f.id, grams: 100 },
    pid,
  );
  await entry(
    request,
    { day, group: "Planned", food_id: f.id, grams: 100 },
    pid,
  );

  await page.goto("/#/targets");
  await page.getByLabel("Protein target").fill("120");
  await page.locator("summary", { hasText: "Other nutrients" }).click();
  await page.getByLabel("Salt target").fill("5");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved targets")).toBeVisible();

  await page.goto(`/#/day/${day}`);
  await expect(page.locator(".target", { hasText: "Protein" })).toContainText(
    /110\sg to go · 100\sg after planned/,
  );
  await expect(page.locator(".target", { hasText: "Salt" })).toContainText(
    /5\sg under target/,
  );
});

test("log a meal as several entries", async ({ page, request }, testInfo) => {
  const { day, tag } = unique(6, testInfo);
  const a = await food(request, {
    name: `Egg ${tag}`,
    per100: { energy: 150 },
  });
  const b = await food(request, {
    name: `Toast ${tag}`,
    per100: { energy: 250 },
  });

  await page.goto("/#/meal/new");
  await page.getByLabel("Name").fill(`Breakfast ${tag}`);
  for (const f of [a, b]) {
    await page.getByLabel("Search foods to add").fill(f.name);
    await page.getByRole("button", { name: starts(f.name) }).click();
  }
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page).toHaveURL(/#\/meal\/\d+$/);

  await page.goto(`/#/add/${day}/Consumed`);
  await page.getByRole("link", { name: starts(`Breakfast ${tag}`) }).click();
  await page.getByRole("button", { name: "Add to Eaten" }).click();
  await expect(page.getByText(`Egg ${tag}`)).toBeVisible();
  await expect(page.getByText(`Toast ${tag}`)).toBeVisible();
  await expect(headline(page)).toHaveText(/^400\skcal$/);
});

test("a double tap logs the food once", async ({ page, request }, testInfo) => {
  const { day, tag } = unique(10, testInfo);
  const f = await food(request, {
    name: `Pear ${tag}`,
    per100: { energy: 50 },
  });

  let posts = 0;
  await page.route("**/api/profiles/*/entries", async (route) => {
    if (route.request().method() === "POST") posts += 1;
    await new Promise((r) => setTimeout(r, 400));
    await route.continue();
  });
  await page.goto(`/#/log/${day}/Consumed/${f.id}`);
  await page.getByRole("button", { name: "Add to Eaten" }).dblclick();
  await expect(headline(page)).toHaveText(/^50\skcal$/);
  expect(posts).toBe(1);
  // One diary row; the toast names it too.
  await expect(page.locator(".entry", { hasText: `Pear ${tag}` })).toHaveCount(
    1,
  );
});

test("imported history in old groups counts as eaten", async ({
  page,
}, testInfo) => {
  const { day } = unique(13, testInfo);
  // Imported history can carry groups like "Other"; only Planned is planned.
  // The server counts what's eaten; the headline shows it and the total.
  await mockDay(
    page,
    day,
    dayPatch(
      [
        { name: "Consumed", entries: [], totals: {} },
        { name: "Planned", entries: [], totals: { energy: 200 } },
        { name: "Other", entries: [], totals: { energy: 1500 } },
      ],
      { total: { energy: 1700 }, consumed: { energy: 1500 } },
    ),
  );
  await page.goto(`/#/day/${day}`);
  await expect(headline(page)).toHaveText(/^1,500\skcal$/);
  await expect(page.getByText(/1,700\skcal with planned/)).toBeVisible();
});

test("imported rows say they have no nutrients per entry", async ({
  page,
}, testInfo) => {
  const { day } = unique(16, testInfo);
  const imported = importedRow(day, { name: "Old soup", amount: "1 bowl" });
  await mockDay(
    page,
    day,
    dayPatch(
      [
        { name: "Consumed", entries: [], totals: {} },
        { name: "Planned", entries: [], totals: {} },
        { name: "Other", entries: [imported], totals: { energy: 300 } },
      ],
      { total: { energy: 300 }, consumed: { energy: 300 } },
    ),
    [imported],
  );
  await page.goto(`/#/day/${day}`);
  await page.getByRole("link", { name: starts("Old soup") }).click();
  await expect(
    page.getByText(/^Imported from your previous diary, without nutrients/),
  ).toBeVisible();
  // Nothing to delete: it can only move.
  await expect(page.getByRole("button", { name: "Delete" })).toHaveCount(0);
});

test("logging a meal can be undone", async ({ page, request }, testInfo) => {
  const { day, tag } = unique(18, testInfo);
  const f = await food(request, {
    name: `Fig ${tag}`,
    per100: { energy: 100 },
  });
  const res = await request.post("/api/meals", {
    data: { name: `Snack ${tag}`, items: [{ food_id: f.id, grams: 100 }] },
  });
  expect(res.ok()).toBeTruthy();

  await page.goto(`/#/add/${day}/Consumed`);
  await page.getByRole("link", { name: starts(`Snack ${tag}`) }).click();
  await page.getByRole("button", { name: "Add to Eaten" }).click();
  await expect(headline(page)).toHaveText(/^100\skcal$/);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(headline(page)).toHaveText(/^0\skcal$/);
});

test("an imported row offers to create the food", async ({
  page,
}, testInfo) => {
  const { day } = unique(23, testInfo);
  const imported = importedRow(day, {
    name: "Rye Guac Pickle",
    amount: "2 Slice",
  });
  await mockDay(
    page,
    day,
    dayPatch([{ name: "Other", entries: [imported], totals: {} }]),
    [imported],
  );
  await page.goto(`/#/day/${day}`);
  await page.getByRole("link", { name: starts("Rye Guac Pickle") }).click();
  await page.getByRole("link", { name: "Create this food" }).click();
  await expect(page.getByLabel("Name")).toHaveValue("Rye Guac Pickle");
});

test("diary shows energy and macros first, the rest folded", async ({
  page,
}, testInfo) => {
  const { day } = unique(24, testInfo);
  const total = {
    energy: 2000,
    protein: 100,
    net_carbs: 150,
    fat: 100,
    iron: 5,
  };
  await mockDay(
    page,
    day,
    dayPatch([{ name: "Consumed", entries: [], totals: total }], {
      total,
      consumed: total,
      targets: [
        target("energy", 2200),
        target("protein", 120),
        target("iron", 11),
      ],
    }),
  );
  await page.goto(`/#/day/${day}`);
  const main = page.locator(".targets.main .target");
  await expect(main).toHaveCount(4);
  await expect(main.nth(0)).toContainText("Energy");
  await expect(main.nth(1)).toContainText("Protein");
  await expect(main.nth(2)).toContainText("Carbohydrate");
  await expect(main.nth(3)).toContainText("Fat");
  // Fat has no target: an empty track, so every row looks the same.
  await expect(main.nth(3).locator(".bar.empty")).toHaveCount(1);
  await expect(main.nth(3)).toContainText("No target");

  const rest = page.locator("details.all-targets");
  await expect(rest.locator(".target", { hasText: "Iron" })).toBeHidden();
  await rest.locator("summary").click();
  await expect(rest.locator(".target", { hasText: "Iron" })).toBeVisible();
  // Every nutrient is listed, targeted or not (like the Targets page).
  await expect(rest.locator(".target", { hasText: "Vitamin C" })).toBeVisible();
  await expect(
    rest.locator(".target", { hasText: /^Saturated fat/ }),
  ).toBeVisible();
});

test("a planned entry ticks to Eaten; an eaten one moves back in its editor", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag } = unique(26, testInfo);
  const f = await food(request, {
    name: `Kiwi ${tag}`,
    per100: { energy: 60 },
  });
  await entry(request, { day, group: "Consumed", food_id: f.id, grams: 100 });
  await page.goto(`/#/day/${day}`);
  const names = page.locator("section.group h2");
  await expect(names.first()).toHaveText("Planned");
  // Eaten rows have no move control.
  await expect(
    section(page, "Eaten").getByRole("button", { name: /^(Mark|Move) / }),
  ).toHaveCount(0);

  await page.getByRole("link", { name: starts(`Kiwi ${tag}`) }).click();
  await page.getByRole("radio", { name: "Planned" }).click();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(section(page, "Planned").getByText(`Kiwi ${tag}`)).toBeVisible();
  const tick = page.getByRole("button", { name: `Mark Kiwi ${tag} eaten` });
  // Left of the name, a full tap target.
  const box = await tick.boundingBox();
  const name = await section(page, "Planned")
    .getByRole("link", { name: starts(`Kiwi ${tag}`) })
    .boundingBox();
  expect(box.x + box.width).toBeLessThanOrEqual(name.x);
  expect(box.width).toBeGreaterThanOrEqual(44);
  expect(box.height).toBeGreaterThanOrEqual(44);
  await tick.click();
  await expect(headline(page)).toHaveText(/^60\skcal$/);
});

test("an imported entry moves on its own", async ({ page }, testInfo) => {
  const { day } = unique(27, testInfo);
  const imported = (id, name) =>
    importedRow(day, { id, name, group: "Planned", amount: "1 bowl" });
  await mockDay(
    page,
    day,
    dayPatch(
      [
        {
          name: "Planned",
          entries: [imported(1, "Soup"), imported(2, "Bread")],
          totals: { energy: 500 },
        },
        { name: "Consumed", entries: [], totals: {} },
      ],
      { total: { energy: 500 } },
    ),
  );
  const patches = [];
  await page.route("**/api/profiles/*/entries/*", (route) => {
    patches.push([route.request().url(), route.request().postDataJSON()]);
    return route.fulfill({
      json: { ...imported(1, "Soup"), group: "Consumed" },
    });
  });
  await page.goto(`/#/day/${day}`);
  await expect(page.getByRole("button", { name: /^Mark all/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Mark Soup eaten" }).click();
  await expect.poll(() => patches.length).toBe(1);
  expect(patches[0][0]).toMatch(/\/entries\/1$/);
  expect(patches[0][1]).toEqual({ group: "Consumed" });
  // Moving never asks.
  await expect(page.getByRole("status").getByText("Moved Soup")).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("an entry names the database its food came from", async ({
  page,
}, testInfo) => {
  const { day } = unique(29, testInfo);
  const logged = {
    id: 1,
    day,
    group: "Consumed",
    food_id: 5,
    name: "Maito, rasvaton",
    grams: 200,
    serving: null,
    quantity: null,
    amount: "200 g",
    nutrients: { energy: 68 },
    imported: false,
    created_at: "",
    uid: "x",
    source: "fineli",
  };
  await mockDay(
    page,
    day,
    dayPatch([{ name: "Consumed", entries: [logged], totals: {} }]),
    [logged],
  );
  await page.route("**/api/foods/5", (route) =>
    route.fulfill({
      json: {
        id: 5,
        name: "Maito, rasvaton",
        brand: null,
        barcode: null,
        per100: { energy: 34 },
        servings: [],
        source: "fineli",
        archived: false,
        rev: 1,
      },
    }),
  );
  await page.goto(`/#/day/${day}`);
  await page.getByRole("link", { name: starts("Maito, rasvaton") }).click();
  await expect(page.getByText("From Fineli")).toBeVisible();
});

test("all nutrients are grouped by kind", async ({ page }) => {
  await page.goto("/#/");
  await page.getByText("Other nutrients").click();
  const diary = page.locator("details.all-targets");
  for (const name of ["Carbohydrates", "Fats", "Vitamins", "Minerals"])
    await expect(diary.getByRole("heading", { name })).toBeVisible();
  // A nutrient sits under its own heading.
  const vitamins = await diary
    .getByRole("heading", { name: "Vitamins" })
    .boundingBox();
  const minerals = await diary
    .getByRole("heading", { name: "Minerals" })
    .boundingBox();
  const vitaminC = await diary.getByText("Vitamin C").boundingBox();
  expect(vitaminC.y).toBeGreaterThan(vitamins.y);
  expect(vitaminC.y).toBeLessThan(minerals.y);

  await page.goto("/#/targets");
  await page.getByText("Other nutrients").click();
  await expect(
    page.getByRole("row", { name: "Minerals", exact: true }),
  ).toBeVisible();
});

test("logging can be undone from the toast", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag } = unique(34, testInfo);
  const f = await food(request, {
    name: `Undo me ${tag}`,
    per100: { energy: 100 },
  });
  await page.goto(`/#/log/${day}/Consumed/${f.id}`);
  await page.getByRole("button", { name: "Add to Eaten" }).click();
  await expect(page.locator("#toast")).toContainText(`Added Undo me ${tag}`);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(
    page.locator(".entry", { hasText: `Undo me ${tag}` }),
  ).toHaveCount(0);
});

test("undoing a meal removes every item it logged", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag } = unique(42, testInfo);
  const a = await food(request, {
    name: `Toast ${tag}`,
    per100: { energy: 100 },
  });
  const b = await food(request, {
    name: `Jam ${tag}`,
    per100: { energy: 200 },
  });
  await request.post("/api/meals", {
    data: {
      name: `Breakfast ${tag}`,
      items: [
        { food_id: a.id, grams: 100 },
        { food_id: b.id, grams: 50 },
      ],
    },
  });
  await page.goto(`/#/add/${day}/Consumed`);
  await page.getByRole("link", { name: starts(`Breakfast ${tag}`) }).click();
  await page.getByRole("button", { name: "Add to Eaten" }).click();
  await expect(headline(page)).toHaveText(/^200\skcal$/);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(headline(page)).toHaveText(/^0\skcal$/);
});

test("an entry logged by serving edits by serving", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag } = unique(100, testInfo);
  const f = await food(request, {
    name: `Muesli ${tag}`,
    per100: { energy: 380 },
    servings: [{ label: "bowl", grams: 60 }],
  });
  const {
    entries: [logged],
  } = await entry(request, {
    day,
    group: "Consumed",
    food_id: f.id,
    serving: "bowl",
    quantity: 2,
  });

  await page.goto(`/#/day/${day}`);
  await page.getByRole("link", { name: starts(`Muesli ${tag}`) }).click();
  await expect(page).toHaveURL(new RegExp(`#/entry/${logged.id}$`));
  await expect(page.getByLabel("Quantity")).toHaveValue("2");
  await expect(page.getByLabel("Unit").locator("option:checked")).toHaveText(
    /^bowl \(60\sg\)$/,
  );
  // Per 100 g is the food's own; the entry's column is the amount.
  const energy = page.getByRole("row", { name: starts("Energy") });
  await expect(energy.getByRole("cell").nth(0)).toHaveText(/^380\skcal$/);
  await expect(energy.getByRole("cell").nth(1)).toHaveText(/^456\skcal$/);

  await page.getByLabel("Quantity").fill("3");
  await expect(energy.getByRole("cell").nth(0)).toHaveText(/^380\skcal$/);
  await expect(energy.getByRole("cell").nth(1)).toHaveText(/^684\skcal$/);
  await page.getByRole("button", { name: "Save" }).click();

  await expect(page).toHaveURL(new RegExp(`#/day/${day}$`));
  const row = page.locator(".entry", { hasText: `Muesli ${tag}` });
  await expect(row).toContainText(/3 × bowl \(180\sg\)/);
  await expect(row).toContainText(/684\skcal/);
  await expect(headline(page)).toHaveText(/^684\skcal$/);
  const saved = await (
    await request.get(`/api/profiles/1/entries/${logged.id}`)
  ).json();
  expect(saved).toMatchObject({ serving: "bowl", quantity: 3, grams: 180 });
});

test("a day's weight is logged, changed and removed", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(101, testInfo);
  // Weights can't be logged for days ahead, and a new profile logs today's:
  // two days back, in a profile of the test's own.
  const day = new Date(Date.parse(todayInApp()) - 2 * 864e5)
    .toISOString()
    .slice(0, 10);
  const pid = await ownProfile(page, request, `Scale ${tag}`);
  const weights = async () =>
    (
      await request.get(`/api/profiles/${pid}/weights?from=${day}&to=${day}`)
    ).json();

  await page.goto(`/#/day/${day}`);
  const card = section(page, "Log");
  const dialog = page.getByRole("dialog");
  await card.getByRole("button", { name: "+ Log" }).click();
  await dialog.getByRole("button", { name: starts("Weight") }).click();
  await dialog.getByLabel("Weight (kg)").fill("72.4");
  await dialog.getByRole("button", { name: "Save" }).click();
  const row = card.getByRole("button", { name: /^Change weight, 72\.4\skg/ });
  await expect(row).toBeVisible();
  await expect.poll(weights).toEqual([{ day, kg: 72.4 }]);

  await row.click();
  await dialog.getByLabel("Weight (kg)").fill("73.6");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(
    card.getByRole("button", { name: /^Change weight, 73\.6\skg/ }),
  ).toBeVisible();
  await expect.poll(weights).toEqual([{ day, kg: 73.6 }]);

  await card.getByRole("button", { name: "Remove weight" }).click();
  await expect(
    card.getByRole("button", { name: /^Change weight/ }),
  ).toHaveCount(0);
  await expect.poll(weights).toEqual([]);
  await page
    .locator("#toast")
    .getByRole("button", { name: "Undo", exact: true })
    .click();
  await expect.poll(weights).toEqual([{ day, kg: 73.6 }]);
  await expect(
    card.getByRole("button", { name: /^Change weight, 73\.6\skg/ }),
  ).toBeVisible();
});

test("moving an entry toasts and can be undone", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag } = unique(102, testInfo);
  const name = `Plum ${tag}`;
  const f = await food(request, { name, per100: { energy: 40 } });
  await entry(request, { day, group: "Planned", food_id: f.id, grams: 100 });
  const planned = section(page, "Planned");
  const eaten = section(page, "Eaten");
  const toast = page.locator("#toast");

  await page.goto(`/#/day/${day}`);
  await planned.getByRole("button", { name: `Mark ${name} eaten` }).click();
  await expect(toast).toContainText(`Moved ${name} to Eaten`);
  await expect(eaten.getByText(name)).toBeVisible();
  await toast.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(planned.getByText(name)).toBeVisible();
  await expect(eaten.getByText(name)).toHaveCount(0);

  await planned.getByRole("button", { name: `Mark ${name} eaten` }).click();
  await expect(eaten.getByText(name)).toBeVisible();
  await expect(eaten.getByRole("button", { name: /^Mark / })).toHaveCount(0);
});

test("Select → Mark eaten moves the picked planned entries, with one Undo", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag } = unique(510, testInfo);
  const make = async (name) => {
    const f = await food(request, { name, per100: { energy: 50 } });
    await entry(request, { day, group: "Planned", food_id: f.id, grams: 100 });
  };
  await make(`Pear ${tag}`);
  await make(`Fig ${tag}`);
  const f = await food(request, { name: `Tea ${tag}`, per100: { energy: 1 } });
  await entry(request, { day, group: "Consumed", food_id: f.id, grams: 100 });
  const planned = section(page, "Planned");
  const eaten = section(page, "Eaten");
  const toast = page.locator("#toast");
  await page.goto(`/#/day/${day}`);

  // Eaten's select bar has no Mark eaten.
  await eaten.getByRole("button", { name: "Select from Eaten" }).click();
  await expect(eaten.getByRole("button", { name: "Log again…" })).toBeVisible();
  await expect(eaten.getByRole("button", { name: "Mark eaten" })).toHaveCount(
    0,
  );
  await eaten.getByRole("button", { name: "Done" }).click();

  await planned.getByRole("button", { name: "Select from Planned" }).click();
  const mark = planned.getByRole("button", { name: "Mark eaten" });
  await expect(mark).toBeDisabled();
  await planned.getByRole("checkbox", { name: `Pear ${tag}` }).check();
  await planned.getByRole("checkbox", { name: `Fig ${tag}` }).check();
  await mark.click();
  await expect(toast).toContainText("Moved 2 foods to Eaten");
  await expect(eaten.getByText(`Pear ${tag}`)).toBeVisible();
  await expect(eaten.getByText(`Fig ${tag}`)).toBeVisible();
  await expect(planned.locator(".entry")).toHaveCount(0);

  await toast.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(planned.getByText(`Pear ${tag}`)).toBeVisible();
  await expect(planned.getByText(`Fig ${tag}`)).toBeVisible();
  await expect(eaten.locator(".entry")).toHaveCount(1);
});

test("Mark eaten failing midway says how many moved, and Undo returns them", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag } = unique(511, testInfo);
  const ids = [];
  for (const name of [`Apple ${tag}`, `Melon ${tag}`]) {
    const f = await food(request, { name, per100: { energy: 50 } });
    ids.push(
      (
        await entry(request, {
          day,
          group: "Planned",
          food_id: f.id,
          grams: 100,
        })
      ).entries[0].id,
    );
  }
  // The second move fails; everything else goes through.
  await page.route(`**/api/profiles/*/entries/${ids[1]}`, (route) =>
    route.request().method() === "PATCH"
      ? route.fulfill({ status: 500, json: { error: "server on fire" } })
      : route.fallback(),
  );
  const planned = section(page, "Planned");
  const eaten = section(page, "Eaten");
  await page.goto(`/#/day/${day}`);
  await planned.getByRole("button", { name: "Select from Planned" }).click();
  await planned.getByRole("checkbox", { name: `Apple ${tag}` }).check();
  await planned.getByRole("checkbox", { name: `Melon ${tag}` }).check();
  await planned.getByRole("button", { name: "Mark eaten" }).click();
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("Moved 1 of 2: server on fire");
  await expect(eaten.getByText(`Apple ${tag}`)).toBeVisible();
  await expect(planned.getByText(`Melon ${tag}`)).toBeVisible();

  await alert.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(planned.getByText(`Apple ${tag}`)).toBeVisible();
  await expect(eaten.locator(".entry")).toHaveCount(0);
});

test("a meal logs its items times the portions", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag } = unique(103, testInfo);
  const a = await food(request, {
    name: `Bun ${tag}`,
    per100: { energy: 100 },
  });
  const b = await food(request, {
    name: `Ham ${tag}`,
    per100: { energy: 200 },
  });
  const res = await request.post("/api/meals", {
    data: {
      name: `Lunch ${tag}`,
      items: [
        { food_id: a.id, grams: 100 },
        { food_id: b.id, grams: 50 },
      ],
    },
  });
  expect(res.ok()).toBeTruthy();
  const meal = await res.json();

  await page.goto(`/#/log-meal/${day}/Consumed/${meal.id}`);
  await expect(page.getByText(/^2 items · 200\skcal$/)).toBeVisible();
  await page.getByLabel("Portions").fill("2");
  await expect(page.getByText(/^2 items · 400\skcal$/)).toBeVisible();
  await page.getByRole("button", { name: "Add to Eaten" }).click();

  await expect(page).toHaveURL(new RegExp(`#/day/${day}$`));
  await expect(headline(page)).toHaveText(/^400\skcal$/);
  await expect(page.locator(".entry", { hasText: `Bun ${tag}` })).toContainText(
    /200\sg/,
  );
  await expect(page.locator(".entry", { hasText: `Ham ${tag}` })).toContainText(
    /100\sg/,
  );
});

test("empty groups say so; nothing planned, no planned total", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag } = unique(104, testInfo);
  await page.goto(`/#/day/${day}`);
  await expect(section(page, "Planned")).toContainText("Nothing planned.");
  await expect(section(page, "Eaten")).toContainText("Nothing eaten yet.");
  await expect(page.locator(".headline")).not.toContainText("with planned");

  const f = await food(request, {
    name: `Apple ${tag}`,
    per100: { energy: 50 },
  });
  await entry(request, { day, group: "Consumed", food_id: f.id, grams: 100 });
  await page.reload();
  await expect(headline(page)).toHaveText(/^50\skcal$/);
  await expect(section(page, "Planned")).toContainText("Nothing planned.");
  await expect(section(page, "Eaten")).not.toContainText("Nothing eaten yet.");
  await expect(page.locator(".headline")).not.toContainText("with planned");
});

// Count a create's POSTs; the first reaches the server, but its answer is
// lost on the way back.
async function loseFirstAnswer(page, path) {
  const sent = [];
  await page.route(`**/api/profiles/*/${path}`, async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    sent.push(route.request().postDataJSON().uid);
    if (sent.length > 1) return route.continue();
    await route.fetch();
    return route.abort();
  });
  return sent;
}

// A create whose answer is lost is kept on the device and sent
// again with the same uid: the server stores it once.
const KEPT = "Saved on this device; it's sent when you're back online";

test("a food log whose answer was lost is replayed and saves once", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag } = unique(182, testInfo);
  const pid = await ownProfile(page, request, `Retry ${tag}`);
  const f = await food(request, {
    name: `Plum ${tag}`,
    per100: { energy: 50 },
  });
  const sent = await loseFirstAnswer(page, "entries");
  await page.goto(`/#/log/${day}/Consumed/${f.id}`);
  const add = page.getByRole("button", { name: "Add to Eaten" });
  await add.click();
  await expect(page).toHaveURL(new RegExp(`#/day/${day}$`));
  await expect(page.locator("#toast")).toHaveText(KEPT);
  // Sent again, answered: nothing waits.
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("outbox")))
    .toBe("[]");
  expect(sent).toHaveLength(2);
  expect(sent[1]).toBe(sent[0]);
  const logged = await (
    await request.get(`/api/profiles/${pid}/day/${day}`)
  ).json();
  expect(logged.groups.flatMap((g) => g.entries)).toHaveLength(1);
  // A new log is a new entry.
  await page.goto(`/#/log/${day}/Consumed/${f.id}`);
  await add.click();
  await expect(page).toHaveURL(new RegExp(`#/day/${day}$`));
  await expect(page.locator(".entry", { hasText: `Plum ${tag}` })).toHaveCount(
    2,
  );
});

test("a meal log whose answer was lost is replayed and saves once", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag } = unique(183, testInfo);
  const pid = await ownProfile(page, request, `Retry ${tag}`);
  const a = await food(request, { name: `Bun ${tag}` });
  const b = await food(request, { name: `Ham ${tag}` });
  const meal = await (
    await request.post("/api/meals", {
      data: {
        name: `Lunch ${tag}`,
        items: [
          { food_id: a.id, grams: 100 },
          { food_id: b.id, grams: 50 },
        ],
      },
    })
  ).json();
  const sent = await loseFirstAnswer(page, "entries");
  await page.goto(`/#/log-meal/${day}/Consumed/${meal.id}`);
  await page.getByRole("button", { name: "Add to Eaten" }).click();
  await expect(page).toHaveURL(new RegExp(`#/day/${day}$`));
  await expect(page.locator("#toast")).toHaveText(KEPT);
  // Sent again, answered: nothing waits.
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("outbox")))
    .toBe("[]");
  expect(sent).toHaveLength(2);
  expect(sent[1]).toBe(sent[0]);
  const logged = await (
    await request.get(`/api/profiles/${pid}/day/${day}`)
  ).json();
  expect(logged.groups.flatMap((g) => g.entries)).toHaveLength(2);
});

test("a new workout done whose answer was lost is replayed and saves once", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag } = unique(184, testInfo);
  const pid = await ownProfile(page, request, `Retry ${tag}`);
  const sent = await loseFirstAnswer(page, "sessions");
  await page.goto(`/#/session/new?day=${day}`);
  await page
    .getByRole("combobox", { name: "Workout", exact: true })
    .selectOption({ label: "Something else (a run, a ride…)" });
  await page.getByLabel("Name", { exact: true }).fill(`Run ${tag}`);
  await page.getByLabel("Duration (min)").fill("30");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#/day/${day}$`));
  await expect(page.locator("#toast")).toHaveText(KEPT);
  // Sent again, answered: nothing waits.
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("outbox")))
    .toBe("[]");
  expect(sent).toHaveLength(2);
  expect(sent[1]).toBe(sent[0]);
  const sessions = await (
    await request.get(`/api/profiles/${pid}/sessions`)
  ).json();
  expect(sessions.filter((s) => s.name === `Run ${tag}`)).toHaveLength(1);
});

test("a weight logged in the diary updates its energy estimates", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(185, testInfo);
  const pid = await ownProfile(page, request, `Scale ${tag}`);
  const day = todayInApp();
  const res = await request.post(`/api/profiles/${pid}/sessions`, {
    data: { day, name: `Walk ${tag}`, minutes: 60 },
  });
  expect(res.ok()).toBeTruthy();
  await page.goto(`/#/day/${day}`);
  const walk = page.getByRole("link", { name: starts(`Walk ${tag}`) });
  await expect(walk).toContainText("≈");
  const before = await walk.textContent();
  await section(page, "Log").getByRole("button", { name: "+ Log" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: starts("Weight") }).click();
  // The new profile logged today's weight already (in UTC's today).
  await dialog.getByLabel("Weight (kg)").fill("90");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(page.locator("#toast")).toContainText(/Logged weight 90\skg/);
  await expect(walk).not.toHaveText(before);
  // The same as a fresh load says.
  const after = await walk.textContent();
  await page.reload();
  await expect(walk).toHaveText(after);
});

test("unknown energy reads as unknown, and totals say they leave it out", async ({
  page,
}, testInfo) => {
  const { day } = unique(186, testInfo);
  const row = (id, name, nutrients) =>
    importedRow(day, {
      id,
      name,
      group: "Consumed",
      imported: false,
      food_id: id,
      amount: "100 g",
      nutrients,
    });
  await mockDay(
    page,
    day,
    dayPatch(
      [
        { name: "Planned", entries: [], totals: {} },
        {
          name: "Consumed",
          entries: [
            row(1, "Known", { energy: 110 }),
            row(2, "Mystery", { protein: 5 }),
          ],
          totals: { energy: 110, protein: 5 },
        },
      ],
      { total: { energy: 110 }, consumed: { energy: 110 } },
    ),
  );
  await page.goto(`/#/day/${day}`);
  await expect(
    page.locator(".entry", { hasText: "Mystery" }).locator(".kcal"),
  ).toHaveText(/^–\skcal$/);
  const total = section(page, "Eaten").locator("header .total");
  await expect(total).toHaveText(/^≥\s110\skcal/);
  await expect(total).toContainText("some energy unknown");
  await expect(headline(page)).toHaveText(/^≥\s110\skcal/);
});

test("the diary's groups are the ones the server names", async ({
  page,
}, testInfo) => {
  const { day } = unique(693, testInfo);
  // A server that only takes new entries in Planned.
  await page.route("**/api/meta", async (route) => {
    const meta = await (await route.fetch()).json();
    await route.fulfill({ json: { ...meta, groups: ["Planned"] } });
  });
  await page.goto(`/#/day/${day}`);
  await expect(
    section(page, "Planned").getByRole("link", { name: "Add to Planned" }),
  ).toBeVisible();
  await expect(section(page, "Eaten")).toBeVisible();
  await expect(
    section(page, "Eaten").getByRole("link", { name: "Add to Eaten" }),
  ).toHaveCount(0);
});

test("the Diary follows the date after midnight", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(749, testInfo);
  await ownProfile(page, request, `Night ${tag}`);
  await page.clock.install({ time: new Date("2031-03-14T23:50:00+02:00") });
  await page.goto("/#/");
  const heading = page.getByRole("heading", { level: 1 });
  await expect(heading).toHaveText("Today");
  const adds = () =>
    page
      .locator('a[href^="#/add/"]')
      .evaluateAll((list) => list.map((a) => a.getAttribute("href")));
  expect((await adds()).every((a) => a.includes("/2031-03-14/"))).toBe(true);

  // Left open overnight, then looked at again in the morning.
  await page.clock.fastForward("08:00:00");
  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  );
  await expect
    .poll(async () => (await adds()).every((a) => a.includes("/2031-03-15/")))
    .toBe(true);
  await expect(heading).toHaveText("Today");

  // A day opened by its address stays put.
  await page.goto("/#/day/2031-03-15");
  await expect(
    page.locator('a[href^="#/add/2031-03-15/"]').first(),
  ).toBeAttached();
  await page.clock.fastForward("24:00:00");
  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  );
  await expect(page).toHaveURL(/#\/day\/2031-03-15$/);
  expect((await adds()).every((a) => a.includes("/2031-03-15/"))).toBe(true);
});
