// The Diary tab: logging, moving and editing entries, a day's targets.

import { setTimeout as delay } from "node:timers/promises";
import { expect, test } from "@playwright/test";
import {
  answer,
  entry,
  fixedToday,
  food,
  headline,
  ownProfile,
  postImport,
  realDay,
  settled,
  starts,
  todayInApp,
  unique,
} from "./helpers.js";

// What a mocked day changes in the real one: its groups, totals and targets.
const dayPatch = (groups, { total = {}, eaten = {}, targets = [] } = {}) => ({
  groups,
  total,
  eaten,
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

// An imported diary row: no food behind it, no nutrients of its own; it
// names the group it was imported into (`src_group`, null: your own) and
// says what it is (`kind`).
const importedRow = (day, fields) => {
  const row = {
    id: 1,
    day,
    group: "Other",
    food_id: null,
    grams: null,
    serving: null,
    quantity: null,
    nutrients: null,
    src_group: fields.group ?? "Other",
    kind: fields.src_group === null ? "own" : "imported",
    created_at: "",
    uid: "x",
    source: null,
    ...fields,
  };
  return { ...row, key: String(row.id) };
};

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
  await expect(page).toHaveURL(/#\/food\/\d+$/u);

  await page.goto(`/#/day/${day}`);
  const planned = section(page, "Planned");
  await planned.getByRole("link", { name: "Add to Planned" }).click();
  await page.getByLabel("Search foods").fill(name);
  await page.getByRole("button", { name: starts(name) }).click();
  await page.getByLabel("Quantity").fill("50");
  await page.getByRole("button", { name: "Add to Planned" }).click();

  await expect(planned.getByText(name)).toBeVisible();
  await expect(page.getByText(/190\skcal with planned/u)).toBeVisible();
  await page.getByRole("button", { name: `Mark ${name} eaten` }).click();

  await expect(section(page, "Eaten").getByText(name)).toBeVisible();
  await expect(headline(page)).toHaveText(/^190\skcal$/u);
});

test("edit grams and delete an entry", async ({ page, request }, testInfo) => {
  const { day, tag } = unique(2, testInfo);
  const f = await food(request, {
    name: `Rice ${tag}`,
    per100: { energy: 100 },
  });
  await entry(request, { day, group: "Eaten", food_id: f.id, grams: 100 });

  await page.goto(`/#/day/${day}`);
  await page.getByRole("link", { name: starts(`Rice ${tag}`) }).click();
  await page.getByLabel("Quantity").fill("250");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(headline(page)).toHaveText(/^250\skcal$/u);

  await page.getByRole("link", { name: starts(`Rice ${tag}`) }).click();
  await page.getByRole("button", { name: "Delete" }).click();
  expect(await answer(page, "Delete")).toBe(`Delete Rice ${tag}?`);
  await expect(page).toHaveURL(new RegExp(`#/day/${day}$`, "u"));
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
  await entry(request, { day, group: "Eaten", food_id: f.id, grams: 50 });

  await page.goto(`/#/day/${day}`);
  await page.getByRole("link", { name: starts(`Kale ${tag}`) }).click();
  await page.getByRole("button", { name: "Delete" }).click();
  expect(await answer(page, "Cancel")).toBe(`Delete Kale ${tag}?`);
  await expect(page).toHaveURL(/#\/entry\/\d+$/u);
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
    // Salt known as none: an unknown amount would read "–" (ADR 0030).
    per100: { energy: 250, protein: 10, sodium: 0 },
  });
  await entry(request, { day, group: "Eaten", food_id: f.id, grams: 100 }, pid);
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
    /110\sg to go · 100\sg after planned/u,
  );
  // The fold's (Highlighted's page is hidden).
  await expect(
    page.locator(".all-targets .target", { hasText: "Salt" }),
  ).toContainText(/5\sg left/u);
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
  await expect(page).toHaveURL(/#\/meal\/\d+$/u);

  await page.goto(`/#/add/${day}/Eaten`);
  await page.getByRole("link", { name: starts(`Breakfast ${tag}`) }).click();
  await page.getByRole("button", { name: "Add to Eaten" }).click();
  await expect(page.getByText(`Egg ${tag}`)).toBeVisible();
  await expect(page.getByText(`Toast ${tag}`)).toBeVisible();
  await expect(headline(page)).toHaveText(/^400\skcal$/u);
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
    await delay(400);
    await route.continue();
  });
  await page.goto(`/#/log/${day}/Eaten/${f.id}`);
  await page.getByRole("button", { name: "Add to Eaten" }).dblclick();
  await expect(headline(page)).toHaveText(/^50\skcal$/u);
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
        { name: "Eaten", entries: [], totals: {} },
        { name: "Planned", entries: [], totals: { energy: 200 } },
        { name: "Other", entries: [], totals: { energy: 1500 } },
      ],
      { total: { energy: 1700 }, eaten: { energy: 1500 } },
    ),
  );
  await page.goto(`/#/day/${day}`);
  await expect(headline(page)).toHaveText(/^1,500\skcal$/u);
  await expect(page.getByText(/1,700\skcal with planned/u)).toBeVisible();
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
        { name: "Eaten", entries: [], totals: {} },
        { name: "Planned", entries: [], totals: {} },
        { name: "Other", entries: [imported], totals: { energy: 300 } },
      ],
      { total: { energy: 300 }, eaten: { energy: 300 } },
    ),
    [imported],
  );
  await page.goto(`/#/day/${day}`);
  await page.getByRole("link", { name: starts("Old soup") }).click();
  await expect(
    page.getByText(/^Imported from your previous diary, without nutrients/u),
  ).toBeVisible();
  // Nothing to delete: it can only move.
  await expect(page.getByRole("button", { name: "Delete" })).toHaveCount(0);
  // No food behind it: nothing to star or edit.
  await expect(page.locator(".star")).toHaveCount(0);
  await expect(page.getByRole("link", { name: /^Edit /u })).toHaveCount(0);
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

  await page.goto(`/#/add/${day}/Eaten`);
  await page.getByRole("link", { name: starts(`Snack ${tag}`) }).click();
  await page.getByRole("button", { name: "Add to Eaten" }).click();
  await expect(headline(page)).toHaveText(/^100\skcal$/u);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.locator(".headline")).toHaveText("Nothing logged");
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
    dayPatch([{ name: "Eaten", entries: [], totals: total }], {
      total,
      eaten: total,
      targets: [
        target("energy", 2200),
        target("protein", 120),
        target("iron", 11),
      ],
    }),
  );
  await page.goto(`/#/day/${day}`);
  // The card's page shown (Highlighted's waits, inert, beneath it).
  const main = page.locator(".targets.main .targets-page:not([inert]) .target");
  await expect(main).toHaveCount(4);
  await expect(main.nth(0)).toContainText("Energy");
  await expect(main.nth(1)).toContainText("Protein");
  await expect(main.nth(2)).toContainText("Carbs");
  await expect(main.nth(3)).toContainText("Fat");
  // Fat has no target: an empty track, so every row looks the same.
  await expect(main.nth(3).locator(".bar.unfilled")).toHaveCount(1);
  await expect(main.nth(3)).toContainText("No target");

  const rest = page.locator("details.all-targets");
  await expect(rest.locator(".target", { hasText: "Iron" })).toBeHidden();
  await rest.locator("summary").first().click();
  await expect(rest.locator(".target", { hasText: "Iron" })).toBeVisible();
  // What no food carried and no target asks for folds away, named:
  // no screen of dashes.
  await expect(rest.locator(".target", { hasText: "Vitamin C" })).toHaveCount(
    0,
  );
  const untracked = rest.locator("details.untracked");
  await expect(untracked.locator("summary")).toHaveText(/^\d+ not tracked$/u);
  await untracked.locator("summary").click();
  await expect(untracked).toContainText("Vitamin C");
  await expect(untracked).toContainText("Saturated fat");
});

// A target bar's segments: where each starts and ends, as shares of the bar.
async function barSegments(row) {
  const bar = await row.locator(".bar").boundingBox();
  const at = async (sel) => {
    const seg = row.locator(`.bar ${sel}`);
    if (!(await seg.count())) return null;
    const b = await seg.boundingBox();
    return {
      start: (b.x - bar.x) / bar.width,
      end: (b.x + b.width - bar.x) / bar.width,
    };
  };
  return { eaten: await at(".eaten"), planned: await at(".planned") };
}

// An "about" energy target of 2,000 kcal (over past 2,200), as the API answers.
const energyTarget = { metric: "energy", value: 2000, min: 1800, max: 2200 };

const DANGER = "rgb(180, 35, 24)";
const bg = (loc) => loc.evaluate((el) => getComputedStyle(el).backgroundColor);
const ghostHue = (loc) =>
  loc.evaluate((el) => getComputedStyle(el).getPropertyValue("--c").trim());

test("planned shows as a ghost after the eaten fill, up to where it lands", async ({
  page,
}, testInfo) => {
  const { day } = unique(773, testInfo);
  await mockDay(
    page,
    day,
    dayPatch(
      [
        { name: "Eaten", entries: [], totals: { energy: 1240 } },
        { name: "Planned", entries: [], totals: { energy: 340 } },
      ],
      {
        total: { energy: 1580 },
        eaten: { energy: 1240 },
        targets: [energyTarget],
      },
    ),
  );
  await page.goto(`/#/day/${day}`);
  const energy = page.locator(".targets.main .target.k-energy");
  await expect(energy.getByRole("img")).toHaveAccessibleName(
    "Energy: 1,240 of 2,000 kcal eaten, 1,580 with planned",
  );
  const { eaten, planned } = await barSegments(energy);
  expect(eaten.end).toBeCloseTo(0.62, 2);
  // The ghost picks up where the eaten fill stops, ends at 1,580 / 2,000.
  expect(planned.start).toBeCloseTo(eaten.end, 2);
  expect(planned.end).toBeCloseTo(0.79, 2);
  await expect(energy).not.toHaveClass(/\bover\b/u);
});

test("nothing planned: no ghost, and the bar says only what's eaten", async ({
  page,
}, testInfo) => {
  const { day } = unique(774, testInfo);
  await mockDay(
    page,
    day,
    dayPatch([{ name: "Eaten", entries: [], totals: { energy: 1240 } }], {
      total: { energy: 1240 },
      eaten: { energy: 1240 },
      targets: [energyTarget],
    }),
  );
  await page.goto(`/#/day/${day}`);
  const energy = page.locator(".targets.main .target.k-energy");
  await expect(energy.getByRole("img")).toHaveAccessibleName(
    "Energy: 1,240 of 2,000 kcal eaten",
  );
  await expect(energy.locator(".bar .planned")).toHaveCount(0);
  expect((await barSegments(energy)).eaten.end).toBeCloseTo(0.62, 2);
});

// Eaten carried no protein (creatine and a vitamin drink): unknown, but
// what's planned still shows as its ghost, from the bar's start; each
// segment says its amount on hover.
test("eaten unknown: planned still shows as a ghost, segments say their amounts", async ({
  page,
}, testInfo) => {
  const { day } = unique(1063, testInfo);
  await mockDay(
    page,
    day,
    dayPatch(
      [
        { name: "Eaten", entries: [], totals: {} },
        { name: "Planned", entries: [], totals: { protein: 45 } },
      ],
      {
        total: { protein: 45 },
        eaten: {},
        targets: [{ metric: "protein", value: 120, min: 120, max: null }],
      },
    ),
  );
  await page.goto(`/#/day/${day}`);
  const protein = page.locator(".targets.main .target.k-protein");
  await expect(protein.getByRole("img")).toHaveAccessibleName(
    /^Protein: not known, of 120 g eaten, at least 45 with planned/u,
  );
  const { planned } = await barSegments(protein);
  // Drawn, not only laid out: the ghost fills the track's height.
  const tall = async (sel) => (await protein.locator(sel).boundingBox()).height;
  expect(await tall(".bar .planned")).toBeCloseTo(await tall(".bar"), 0);
  expect(planned.start).toBeCloseTo(0, 2);
  expect(planned.end).toBeCloseTo(45 / 120, 2);
  // The segments' amounts are the bar's tooltip (web/tips.mjs).
  await expect(protein.getByRole("img")).toHaveAccessibleDescription(
    /^Planned 45\sg · ≥\s45\sg with planned$/u,
  );
});

test("planned crossing the limit: the ghost turns red and stops at the bar's end", async ({
  page,
}, testInfo) => {
  const { day } = unique(775, testInfo);
  await mockDay(
    page,
    day,
    dayPatch(
      [
        { name: "Eaten", entries: [], totals: { energy: 1500 } },
        { name: "Planned", entries: [], totals: { energy: 1000 } },
      ],
      {
        total: { energy: 2500 },
        eaten: { energy: 1500 },
        targets: [energyTarget],
      },
    ),
  );
  await page.goto(`/#/day/${day}`);
  const energy = page.locator(".targets.main .target.k-energy");
  await expect(energy).toHaveClass(/\bover\b/u);
  // Over counts from the range's top: 2,500 − 2,200.
  await expect(energy).toContainText("300 kcal over the range with planned");
  const { eaten, planned } = await barSegments(energy);
  expect(eaten.end).toBeCloseTo(0.75, 2);
  expect(planned.start).toBeCloseTo(0.75, 2);
  expect(planned.end).toBeCloseTo(1, 2);
  // What's eaten is still within the limit: only the ghost reads as over.
  expect(await bg(energy.locator(".eaten"))).not.toBe(DANGER);
  expect(await ghostHue(energy.locator(".planned"))).toBe("#b42318");
});

test("eaten past the limit: a full red bar", async ({ page }, testInfo) => {
  const { day } = unique(776, testInfo);
  await mockDay(
    page,
    day,
    dayPatch(
      [
        { name: "Eaten", entries: [], totals: { energy: 2500 } },
        { name: "Planned", entries: [], totals: { energy: 300 } },
      ],
      {
        total: { energy: 2800 },
        eaten: { energy: 2500 },
        targets: [energyTarget],
      },
    ),
  );
  await page.goto(`/#/day/${day}`);
  const energy = page.locator(".targets.main .target.k-energy");
  await expect(energy).toContainText("600 kcal over the range");
  const { eaten } = await barSegments(energy);
  expect(eaten.end).toBeCloseTo(1, 2);
  expect(await bg(energy.locator(".eaten"))).toBe(DANGER);
});

test("the ghost reads at phone widths in both themes", async ({
  page,
}, testInfo) => {
  const { day } = unique(777, testInfo);
  await mockDay(
    page,
    day,
    dayPatch(
      [
        { name: "Eaten", entries: [], totals: { energy: 1240 } },
        { name: "Planned", entries: [], totals: { energy: 340 } },
      ],
      {
        total: { energy: 1580 },
        eaten: { energy: 1240 },
        targets: [energyTarget],
      },
    ),
  );
  for (const width of [320, 393]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(`/#/day/${day}`);
    const energy = page.locator(".targets.main .target.k-energy");
    for (const dark of [false, true]) {
      await page.evaluate(
        (on) => document.documentElement.classList.toggle("dark", on),
        dark,
      );
      const { eaten, planned } = await barSegments(energy);
      expect(planned.start).toBeCloseTo(eaten.end, 2);
      expect(planned.end).toBeCloseTo(0.79, 2);
      // The ghost carries the bar's hue, unlike the empty track.
      const ghost = energy.locator(".planned");
      expect(
        await ghost.evaluate((el) => getComputedStyle(el).backgroundImage),
      ).toContain("gradient");
      await energy.screenshot({
        path: testInfo.outputPath(
          `ghost-${width}-${dark ? "dark" : "light"}.png`,
        ),
      });
    }
  }
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
  await entry(request, { day, group: "Eaten", food_id: f.id, grams: 100 });
  await page.goto(`/#/day/${day}`);
  const names = page.locator("section.group h2");
  await expect(names.first()).toHaveText("Planned");
  // Eaten rows have no move control.
  await expect(
    section(page, "Eaten").getByRole("button", { name: /^(Mark|Move) /u }),
  ).toHaveCount(0);

  await page.getByRole("link", { name: starts(`Kiwi ${tag}`) }).click();
  await page.getByRole("radio", { name: "Planned" }).click();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(section(page, "Planned").getByText(`Kiwi ${tag}`)).toBeVisible();
  const tick = page.getByRole("button", { name: `Mark Kiwi ${tag} eaten` });
  // Right of the name, a full tap target: a rounded square whose ✓ shows
  // without hovering, in the square's own colour.
  const box = await tick.boundingBox();
  const name = await section(page, "Planned")
    .getByRole("link", { name: starts(`Kiwi ${tag}`) })
    .boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(name.x + name.width);
  expect(box.width).toBeGreaterThanOrEqual(44);
  expect(box.height).toBeGreaterThanOrEqual(44);
  const look = await tick.evaluate((b) => {
    const s = getComputedStyle(b);
    return {
      mark: s.color,
      edge: s.borderTopColor,
      radius: s.borderTopLeftRadius,
    };
  });
  expect(look.mark).toBe(look.edge);
  expect(look.radius).not.toBe("50%");
  expect(parseFloat(look.radius)).toBeLessThan(box.width / 2);
  await tick.click();
  await expect(headline(page)).toHaveText(/^60\skcal$/u);
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
        { name: "Eaten", entries: [], totals: {} },
      ],
      { total: { energy: 500 } },
    ),
  );
  const patches = [];
  await page.route("**/api/profiles/*/entries/*", (route) => {
    patches.push([route.request().url(), route.request().postDataJSON()]);
    return route.fulfill({
      json: { ...imported(1, "Soup"), group: "Eaten" },
    });
  });
  await page.goto(`/#/day/${day}`);
  await expect(page.getByRole("button", { name: /^Mark all/u })).toHaveCount(0);
  await page.getByRole("button", { name: "Mark Soup eaten" }).click();
  await expect.poll(() => patches.length).toBe(1);
  expect(patches[0][0]).toMatch(/\/entries\/1$/u);
  expect(patches[0][1]).toEqual({ group: "Eaten" });
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
    group: "Eaten",
    food_id: 5,
    name: "Maito, rasvaton",
    grams: 200,
    serving: null,
    quantity: null,
    amount: "200 g",
    nutrients: { energy: 68 },
    key: "1",
    src_group: null,
    created_at: "",
    uid: "x",
    source: "fineli",
  };
  await mockDay(
    page,
    day,
    dayPatch([{ name: "Eaten", entries: [logged], totals: {} }]),
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

test("all nutrients are grouped by kind", async ({ page }, testInfo) => {
  // A day with nothing logged lists every nutrient (none folds away).
  const { day } = unique(61, testInfo);
  await page.goto(`/#/day/${day}`);
  await page.getByText("Other nutrients").click();
  const diary = page.locator("details.all-targets");
  for (const name of ["Carbs", "Fats", "Vitamins", "Minerals"])
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
  await page.goto(`/#/log/${day}/Eaten/${f.id}`);
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
  await page.goto(`/#/add/${day}/Eaten`);
  await page.getByRole("link", { name: starts(`Breakfast ${tag}`) }).click();
  await page.getByRole("button", { name: "Add to Eaten" }).click();
  await expect(headline(page)).toHaveText(/^200\skcal$/u);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.locator(".headline")).toHaveText("Nothing logged");
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
    group: "Eaten",
    food_id: f.id,
    serving: "bowl",
    quantity: 2,
  });

  await page.goto(`/#/day/${day}`);
  await page.getByRole("link", { name: starts(`Muesli ${tag}`) }).click();
  await expect(page).toHaveURL(new RegExp(`#/entry/${logged.id}$`, "u"));
  await expect(page.getByLabel("Quantity")).toHaveValue("2");
  await expect(page.getByLabel("Unit").locator("option:checked")).toHaveText(
    /^bowl \(60\sg\)$/u,
  );
  // Per 100 g is the food's own; the entry's column is the amount.
  const energy = page.getByRole("row", { name: starts("Energy") });
  await expect(energy.getByRole("cell").nth(0)).toHaveText(/^380\skcal$/u);
  await expect(energy.getByRole("cell").nth(1)).toHaveText(/^456\skcal$/u);

  await page.getByLabel("Quantity").fill("3");
  await expect(energy.getByRole("cell").nth(0)).toHaveText(/^380\skcal$/u);
  await expect(energy.getByRole("cell").nth(1)).toHaveText(/^684\skcal$/u);
  await page.getByRole("button", { name: "Save" }).click();

  await expect(page).toHaveURL(new RegExp(`#/day/${day}$`, "u"));
  const row = page.locator(".entry", { hasText: `Muesli ${tag}` });
  await expect(row).toContainText(/3 × bowl \(180\sg\)/u);
  await expect(row).toContainText(/684\skcal/u);
  await expect(headline(page)).toHaveText(/^684\skcal$/u);
  const saved = await (
    await request.get(`/api/profiles/1/entries/${logged.id}`)
  ).json();
  expect(saved).toMatchObject({ serving: "bowl", quantity: 3, grams: 180 });
});

test("a day's weight is logged, changed and removed", async ({
  page,
  request,
}, testInfo) => {
  await fixedToday(page);
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
  await card.getByRole("button", { name: /^Log on /u }).click();
  await dialog.getByRole("button", { name: starts("Weight") }).click();
  await dialog.getByLabel("Weight (kg)").fill("72.4");
  await dialog.getByRole("button", { name: "Save" }).click();
  const row = card.getByRole("button", { name: /^Change weight, 72\.4\skg/u });
  await expect(row).toBeVisible();
  await expect.poll(weights).toEqual([{ day, kg: 72.4 }]);

  await row.click();
  await dialog.getByLabel("Weight (kg)").fill("73.6");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(
    card.getByRole("button", { name: /^Change weight, 73\.6\skg/u }),
  ).toBeVisible();
  await expect.poll(weights).toEqual([{ day, kg: 73.6 }]);

  await card.getByRole("button", { name: "Remove weight" }).click();
  await expect(
    card.getByRole("button", { name: /^Change weight/u }),
  ).toHaveCount(0);
  await expect.poll(weights).toEqual([]);
  await page
    .locator("#toast")
    .getByRole("button", { name: "Undo", exact: true })
    .click();
  await expect.poll(weights).toEqual([{ day, kg: 73.6 }]);
  await expect(
    card.getByRole("button", { name: /^Change weight, 73\.6\skg/u }),
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
  await expect(eaten.getByRole("button", { name: /^Mark /u })).toHaveCount(0);
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
  await entry(request, { day, group: "Eaten", food_id: f.id, grams: 100 });
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

  await page.goto(`/#/log-meal/${day}/Eaten/${meal.id}`);
  await expect(page.getByText(/^2 items · 200\skcal$/u)).toBeVisible();
  await page.getByLabel("Portions").fill("2");
  await expect(page.getByText(/^2 items · 400\skcal$/u)).toBeVisible();
  await page.getByRole("button", { name: "Add to Eaten" }).click();

  await expect(page).toHaveURL(new RegExp(`#/day/${day}$`, "u"));
  await expect(headline(page)).toHaveText(/^400\skcal$/u);
  await expect(page.locator(".entry", { hasText: `Bun ${tag}` })).toContainText(
    /200\sg/u,
  );
  await expect(page.locator(".entry", { hasText: `Ham ${tag}` })).toContainText(
    /100\sg/u,
  );
});

test("empty groups say so; nothing planned, no planned total", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag } = unique(104, testInfo);
  await page.goto(`/#/day/${day}`);
  await expect(section(page, "Planned")).toContainText("Nothing planned.");
  await expect(section(page, "Eaten")).toContainText("Nothing logged.");
  // Nothing logged says so, not "0 kcal eaten".
  await expect(page.locator(".headline")).toHaveText("Nothing logged");

  const f = await food(request, {
    name: `Apple ${tag}`,
    per100: { energy: 50 },
  });
  await entry(request, { day, group: "Eaten", food_id: f.id, grams: 100 });
  await page.reload();
  await expect(headline(page)).toHaveText(/^50\skcal$/u);
  await expect(section(page, "Planned")).toContainText("Nothing planned.");
  await expect(section(page, "Eaten")).not.toContainText("Nothing logged.");
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
const KEPT = "Saved in this browser; it's sent when you're back online";

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
  await page.goto(`/#/log/${day}/Eaten/${f.id}`);
  const add = page.getByRole("button", { name: "Add to Eaten" });
  await add.click();
  await expect(page).toHaveURL(new RegExp(`#/day/${day}$`, "u"));
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
  await page.goto(`/#/log/${day}/Eaten/${f.id}`);
  await add.click();
  await expect(page).toHaveURL(new RegExp(`#/day/${day}$`, "u"));
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
  await page.goto(`/#/log-meal/${day}/Eaten/${meal.id}`);
  await page.getByRole("button", { name: "Add to Eaten" }).click();
  await expect(page).toHaveURL(new RegExp(`#/day/${day}$`, "u"));
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
  const sent = await loseFirstAnswer(page, "activities");
  await page.goto(`/#/activity/new?day=${day}`);
  await page
    .getByRole("combobox", { name: "Workout", exact: true })
    .selectOption({ label: "Something else (a run, a ride…)" });
  await page.getByLabel("Name", { exact: true }).fill(`Run ${tag}`);
  await page.getByLabel("Duration (min)").fill("30");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#/day/${day}$`, "u"));
  await expect(page.locator("#toast")).toHaveText(KEPT);
  // Sent again, answered: nothing waits.
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("outbox")))
    .toBe("[]");
  expect(sent).toHaveLength(2);
  expect(sent[1]).toBe(sent[0]);
  const sessions = await (
    await request.get(`/api/profiles/${pid}/activities`)
  ).json();
  expect(sessions.filter((s) => s.name === `Run ${tag}`)).toHaveLength(1);
});

test("a weight logged in the diary updates its energy estimates", async ({
  page,
  request,
}, testInfo) => {
  await fixedToday(page);
  const { tag } = unique(185, testInfo);
  const pid = await ownProfile(page, request, `Scale ${tag}`);
  const day = todayInApp();
  const res = await request.post(`/api/profiles/${pid}/activities`, {
    data: { day, name: `Walk ${tag}`, minutes: 60 },
  });
  expect(res.ok()).toBeTruthy();
  await page.goto(`/#/day/${day}`);
  const walk = page.getByRole("link", { name: starts(`Walk ${tag}`) });
  await expect(walk).toContainText("≈");
  const before = await walk.textContent();
  await section(page, "Log")
    .getByRole("button", { name: /^Log on /u })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: starts("Weight") }).click();
  // The new profile logged today's weight already (in UTC's today).
  await dialog.getByLabel("Weight (kg)").fill("90");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(page.locator("#toast")).toContainText(/Logged weight 90\skg/u);
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
      group: "Eaten",
      src_group: null,
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
          name: "Eaten",
          entries: [
            row(1, "Known", { energy: 110 }),
            row(2, "Mystery", { protein: 5 }),
          ],
          totals: { energy: 110, protein: 5 },
        },
      ],
      { total: { energy: 110 }, eaten: { energy: 110 } },
    ),
  );
  await page.goto(`/#/day/${day}`);
  await expect(
    page.locator(".entry", { hasText: "Mystery" }).locator(".kcal"),
  ).toHaveText(/^–\skcal$/u);
  const total = section(page, "Eaten").locator("header .total");
  await expect(total).toHaveText(/^≥\s110\skcal/u);
  await expect(total).toContainText("some energy unknown");
  await expect(headline(page)).toHaveText(/^≥\s110\skcal/u);
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
  await expect(page).toHaveURL(/#\/day\/2031-03-15$/u);
  expect((await adds()).every((a) => a.includes("/2031-03-15/"))).toBe(true);
});

test("imported food is removed a group at a time (its src_group), with its total", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag } = unique(476, testInfo);
  const pid = await ownProfile(page, request, `Imported ${tag}`);
  const res = await postImport(
    request,
    `/api/profiles/${pid}/import/cronometer`,
    {
      servings:
        "Day,Group,Food Name,Amount\n" +
        `${day},Consumed,Soup ${tag},300.00 g\n` +
        `${day},Consumed,Bread ${tag},70.00 g\n`,
      summary: `Date,Group,Energy (kcal)\n${day},Consumed,650\n`,
    },
  );
  expect(res.ok(), await res.text()).toBeTruthy();
  const f = await food(request, {
    name: `Apple ${tag}`,
    per100: { energy: 50 },
  });
  await entry(request, { day, group: "Eaten", food_id: f.id, grams: 200 }, pid);

  await page.goto(`/#/day/${day}`);
  await expect(headline(page)).toHaveText(/^750\skcal$/u);
  // Imported rows say where they came from; your own don't.
  await expect(
    page.getByRole("link", { name: starts(`Soup ${tag}`) }),
  ).toContainText("From Cronometer");
  await expect(
    page.getByRole("link", { name: starts(`Apple ${tag}`) }),
  ).not.toContainText("From Cronometer");
  await page.getByRole("link", { name: starts(`Soup ${tag}`) }).click();
  await page
    .getByRole("button", {
      name: "Remove imported Eaten (2 items)",
    })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Your own entries stay");
  await dialog.getByRole("button", { name: starts("Remove imported") }).click();
  await expect(page).toHaveURL(new RegExp(`#/day/${day}$`, "u"));
  await expect(headline(page)).toHaveText(/^100\skcal$/u);
  const eaten = section(page, "Eaten");
  await expect(eaten.getByText(`Soup ${tag}`)).toHaveCount(0);
  await expect(eaten.getByText(`Bread ${tag}`)).toHaveCount(0);

  // Your own entry keeps its single Delete.
  await eaten.getByRole("link", { name: starts(`Apple ${tag}`) }).click();
  await expect(page.getByRole("button", { name: "Delete" })).toBeVisible();
});

test("the targets card pages: Macros, then Highlighted, remembered on the device", async ({
  page,
  request,
}, testInfo) => {
  const { day } = unique(765, testInfo);
  await ownProfile(page, request, `Pages ${unique(765, testInfo).tag}`);
  await page.goto(`/#/day/${day}`);
  const card = page.locator(".targets.main");
  const pager = card.getByRole("group", { name: "Targets page" });
  const macros = pager.getByRole("button", { name: "Macros" });
  const highlighted = pager.getByRole("button", { name: "Highlighted" });
  await expect(macros).toHaveAttribute("aria-pressed", "true");
  // The page shown (the other is inert, invisible beneath it).
  const shown = card.locator(".targets-page:not([inert])");
  await expect(shown.locator(".target-label > span:first-child")).toHaveText([
    "Energy",
    "Protein",
    "Carbs",
    "Fat",
  ]);
  // Taps only, each dot a full tap target.
  for (const dot of [macros, highlighted]) {
    const box = await dot.boundingBox();
    expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(44);
  }

  await highlighted.click();
  await expect(highlighted).toHaveAttribute("aria-pressed", "true");
  const labels = shown.locator(".target-label > span:first-child");
  await expect(labels).toHaveText([
    "Fibre",
    "Saturated fat",
    // Sodium reads as salt.
    "Salt",
    "Added sugars",
    "Vitamin D",
    "Iron",
    "Magnesium",
    "EPA+DHA",
  ]);
  // Compact, two columns.
  const lefts = await shown
    .locator(".target")
    .evaluateAll((els) => [
      ...new Set(els.map((e) => Math.round(e.getBoundingClientRect().left))),
    ]);
  expect(lefts).toHaveLength(2);
  await expect(shown.locator(".target small")).toHaveCount(0);

  await page.reload();
  await expect(
    page.locator(".targets.main").getByRole("button", { name: "Highlighted" }),
  ).toHaveAttribute("aria-pressed", "true");
});

test("the targets card keeps its size across Macros and Highlighted", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag } = unique(867, testInfo);
  await ownProfile(page, request, `Size ${tag}`);
  for (const width of [320, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/#/day/${day}`);
    const card = page.locator(".targets.main");
    const pager = card.getByRole("group", { name: "Targets page" });
    await pager.getByRole("button", { name: "Macros" }).click();
    const before = await card.boundingBox();
    await pager.getByRole("button", { name: "Highlighted" }).click();
    await expect(
      pager.getByRole("button", { name: "Highlighted" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(await card.boundingBox(), `${width}`).toEqual(before);
  }
});

test("added or moved to Eaten today, an entry takes the time; other days stay without one", async ({
  page,
  request,
}, testInfo) => {
  await fixedToday(page);
  const { tag } = unique(976, testInfo);
  const pid = await ownProfile(page, request, `Clock ${tag}`);
  const f = await food(request, {
    name: `Rye ${tag}`,
    per100: { energy: 250 },
  });
  const now = todayInApp();
  const yesterday = new Date(Date.parse(now) - 864e5)
    .toISOString()
    .slice(0, 10);
  const times = async (day, group) =>
    (await (await request.get(`/api/profiles/${pid}/day/${day}`)).json()).groups
      .find((g) => g.name === group)
      .entries.map((e) => e.time);
  const clock = /^\d{2}:\d{2}$/u;

  // Logged today: the time field starts at now, and the entry keeps it.
  await page.goto(`/#/log/${now}/Eaten/${f.id}`);
  await expect(page.getByLabel("Time eaten")).toHaveValue(clock);
  await page.getByRole("button", { name: "Add to Eaten" }).click();
  await expect(page).toHaveURL(new RegExp(`#/day/${now}$`, "u"));
  await expect(
    page.locator(".entry", { hasText: `Rye ${tag}` }).locator(".muted"),
  ).toHaveText(/^\d{2}:\d{2} · /u);

  // A planned entry ticked today takes the time it was ticked.
  await entry(
    request,
    { day: now, group: "Planned", food_id: f.id, grams: 50 },
    pid,
  );
  await page.reload();
  await page.getByRole("button", { name: `Mark Rye ${tag} eaten` }).click();
  await expect(
    page.getByRole("button", { name: `Mark Rye ${tag} eaten` }),
  ).toHaveCount(0);
  expect(await times(now, "Eaten")).toEqual([
    expect.stringMatching(clock),
    expect.stringMatching(clock),
  ]);

  // Yesterday: no time unless one is chosen.
  await page.goto(`/#/log/${yesterday}/Eaten/${f.id}`);
  await expect(page.getByLabel("Time eaten")).toHaveValue("");
  await page.getByRole("button", { name: "Add to Eaten" }).click();
  await expect(page).toHaveURL(new RegExp(`#/day/${yesterday}$`, "u"));
  await entry(
    request,
    { day: yesterday, group: "Planned", food_id: f.id, grams: 50 },
    pid,
  );
  await page.reload();
  await page.getByRole("button", { name: `Mark Rye ${tag} eaten` }).click();
  await expect(
    page.getByRole("button", { name: `Mark Rye ${tag} eaten` }),
  ).toHaveCount(0);
  expect(await times(yesterday, "Eaten")).toEqual([null, null]);
});

test("a new screen opens at its top; the same screen re-rendered keeps its scroll", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag } = unique(977, testInfo);
  const f = await food(request, { name: `Pea ${tag}`, per100: { energy: 80 } });
  for (let i = 0; i < 30; i += 1)
    await entry(request, { day, group: "Eaten", food_id: f.id, grams: 10 });
  await page.goto(`/#/day/${day}`);
  await expect(page.locator(".entry")).toHaveCount(30);
  // Room below every screen, so a short one can't hide a kept offset.
  await page.evaluate(() => {
    document.body.style.paddingBottom = "200vh";
  });

  // Re-rendered in place (a save, a tick): the scroll stays.
  await page.evaluate(() => window.scrollTo(0, 400));
  await page.evaluate(() =>
    window.dispatchEvent(new HashChangeEvent("hashchange")),
  );
  await settled(page);
  expect(await page.evaluate(() => window.scrollY)).toBe(400);

  await page.getByRole("link", { name: "Add to Eaten" }).click();
  await expect(
    page.getByRole("heading", { name: "Add to Eaten" }),
  ).toBeVisible();
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
});

test("a logged food's entry stars and edits its food; a recipe's lists its ingredients", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag } = unique(841, testInfo);
  const oats = await food(request, {
    name: `Oats ${tag}`,
    per100: { energy: 380 },
  });
  const res = await request.post("/api/recipes", {
    data: {
      name: `Porridge ${tag}`,
      items: [{ food_id: oats.id, grams: 60 }],
    },
  });
  expect(res.ok()).toBeTruthy();
  const recipe = await res.json();
  const logged = async (f) =>
    (await entry(request, { day, group: "Eaten", food_id: f.id, grams: 100 }))
      .entries[0];

  // A plain food: ☆ and Edit food, no ingredients.
  const plain = await logged(oats);
  await page.goto(`/#/entry/${plain.id}`);
  const star = page.getByRole("button", { name: `Favourite Oats ${tag}` });
  await expect(star).toHaveAttribute("aria-pressed", "false");
  await star.click();
  await expect(star).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("link", { name: "Edit food" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Ingredients" })).toHaveCount(
    0,
  );

  // A recipe: ☆, Edit recipe and its ingredients.
  const cooked = await logged(recipe);
  await page.goto(`/#/entry/${cooked.id}`);
  await expect(
    page.getByRole("button", { name: `Favourite Porridge ${tag}` }),
  ).toHaveAttribute("aria-pressed", "false");
  await expect(
    page.getByRole("heading", { name: "Ingredients" }),
  ).toBeVisible();
  await expect(page.locator(".recipe-items li")).toHaveText([
    new RegExp(`^Oats ${tag}\\s*60\\sg$`, "u"),
  ]);
  await page.getByRole("link", { name: "Edit recipe" }).click();
  await expect(page).toHaveURL(new RegExp(`#/recipe/${recipe.id}`, "u"));
});

// The food's verdict under the editor's title: an entry's, and a due daily
// item's (ADR 0023), at its own entry address.
test("the entry editor shows its food's verdict, a due item's too", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag } = unique(915, testInfo);
  const pid = await ownProfile(page, request, `Tags ${tag}`);
  const f = await food(request, {
    name: `Tagged chicken ${tag}`,
    per100: {
      energy: 110,
      protein: 23,
      fat: 1.5,
      saturated: 0.4,
      sugars: 0,
      sodium: 60,
    },
  });
  const {
    entries: [e],
  } = await entry(
    request,
    { day, group: "Eaten", food_id: f.id, grams: 100 },
    pid,
  );
  // Healthy, alone: its sublabels aren't repeated.
  const tags = page.locator("form.editor > .muted + .labels .light");
  const all = ["Healthy"];
  await page.goto(`/#/entry/${e.id}`);
  await expect(tags).toHaveText(all);

  const res = await request.patch(`/api/profiles/${pid}/entries/${e.id}`, {
    data: { repeat: { start: day } },
  });
  expect(res.ok()).toBeTruthy();
  const { repeat } = await res.json();
  const next = new Date(Date.parse(day) + 864e5).toISOString().slice(0, 10);
  await page.goto(`/#/day/${next}`);
  await page.locator(".entry .entry-main").click();
  await expect(page).toHaveURL(
    new RegExp(`#/entry/daily-${repeat.id}-${next}$`, "u"),
  );
  await expect(page.getByLabel("Quantity")).toBeVisible();
  await expect(tags).toHaveText(all);
});

test("an empty Planned shows no total", async ({ page, request }, testInfo) => {
  const { day, tag } = unique(263, testInfo);
  const f = await food(request, {
    name: `Toast ${tag}`,
    per100: { energy: 300 },
  });
  await entry(request, { day, group: "Eaten", food_id: f.id, grams: 100 });
  await page.goto(`/#/day/${day}`);
  // Eaten's 300 kcal says something; Planned's "0 kcal" over nothing doesn't.
  await expect(section(page, "Eaten").locator("header .total")).toHaveText(
    /^300\skcal$/u,
  );
  await expect(section(page, "Planned").locator(".empty")).toBeVisible();
  await expect(section(page, "Planned").locator("header .total")).toHaveCount(
    0,
  );
});

// One period header: the Diary's day reads ‹ [title ▾] ›,
// the title opening a popover anchored under it with a day to jump to and
// Today; one kind, so no switch.
test("the Diary's title opens a day picker under it", async ({
  page,
  request,
}, testInfo) => {
  const { tag, day } = unique(943, testInfo);
  await ownProfile(page, request, `Picker ${tag}`);
  await page.goto(`/#/day/${day}`);
  await expect(page.locator('input[type="date"]:visible')).toHaveCount(0);
  const title = page.locator(".period-title");
  await title.click();
  const popover = page.locator("#period-pick");
  await expect(popover).toBeVisible();
  const t = await title.boundingBox();
  const p = await popover.boundingBox();
  expect(p.y).toBeGreaterThanOrEqual(t.y + t.height - 1);
  expect(p.y).toBeLessThan(t.y + t.height + 24);
  expect(p.x).toBeLessThan(t.x + t.width);
  expect(p.x + p.width).toBeGreaterThan(t.x);
  await expect(popover.getByRole("navigation", { name: "Period" })).toHaveCount(
    0,
  );
  await popover.getByLabel("Go to day").fill("2031-05-02");
  await expect(page).toHaveURL(/#\/day\/2031-05-02$/u);
  await page.locator(".period-title").click();
  await page
    .locator("#period-pick")
    .getByRole("link", { name: "Today" })
    .click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Today");
  await expect(page.getByRole("link", { name: "Previous day" })).toBeVisible();
});

// The planned row's check sits in the middle of its square on
// every platform: drawn (an svg centred by its viewBox), not a font glyph.
// Owner (2026-10-14): within half a pixel, the square as painted.
test("the tick's check is centred in its square", async ({
  page,
  request,
}, testInfo) => {
  const { tag, day } = unique(944, testInfo);
  const pid = await ownProfile(page, request, `Tick ${tag}`);
  const f = await food(request, {
    name: `Tick food ${tag}`,
    per100: { energy: 100 },
  });
  await entry(
    request,
    { day, group: "Planned", food_id: f.id, grams: 100 },
    pid,
  );
  await page.goto(`/#/day/${day}`);
  const tick = page.getByRole("button", {
    name: `Mark Tick food ${tag} eaten`,
  });
  await expect(tick.locator("svg")).toHaveCount(1);
  // The square as painted (its border box, whatever its box-sizing)
  // against the check's ink: the path's own box (getBBox) on screen. The
  // ✓'s strokes and round caps reach out alike on every side, so its
  // geometry's centre is its ink's.
  const off = await tick.evaluate((b) => {
    const r = b.getBoundingClientRect();
    const s = getComputedStyle(b, "::before");
    const px = (k) => parseFloat(s[k]);
    const extra = (a, z) =>
      s.boxSizing === "border-box"
        ? 0
        : px(`border${a}Width`) +
          px(`border${z}Width`) +
          px(`padding${a}`) +
          px(`padding${z}`);
    const square = {
      x:
        r.left +
        b.clientLeft +
        px("left") +
        (px("width") + extra("Left", "Right")) / 2,
      y:
        r.top +
        b.clientTop +
        px("top") +
        (px("height") + extra("Top", "Bottom")) / 2,
    };
    const path = b.querySelector("svg path");
    const g = path.getBBox();
    const m = path.getScreenCTM();
    const cx = g.x + g.width / 2;
    const cy = g.y + g.height / 2;
    return [
      m.a * cx + m.c * cy + m.e - square.x,
      m.b * cx + m.d * cy + m.f - square.y,
    ];
  });
  expect(Math.abs(off[0])).toBeLessThanOrEqual(0.5);
  expect(Math.abs(off[1])).toBeLessThanOrEqual(0.5);
});

// Bulk delete says how far it got, as Mark eaten does.
test("Delete failing midway says how many were deleted", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag } = unique(945, testInfo);
  const pid = await ownProfile(page, request, `Partial ${tag}`);
  for (const name of [`Plum ${tag}`, `Date ${tag}`]) {
    const f = await food(request, { name, per100: { energy: 50 } });
    await entry(
      request,
      { day, group: "Eaten", food_id: f.id, grams: 100 },
      pid,
    );
  }
  // The second delete fails, whichever entry it is.
  let deletes = 0;
  await page.route("**/api/profiles/*/entries/*", (route) =>
    route.request().method() === "DELETE" && ++deletes === 2
      ? route.fulfill({ status: 500, json: { error: "server on fire" } })
      : route.fallback(),
  );
  const eaten = section(page, "Eaten");
  await page.goto(`/#/day/${day}`);
  await eaten.getByRole("button", { name: "Select from Eaten" }).click();
  await eaten.getByRole("checkbox", { name: "Select all" }).check();
  await eaten.getByRole("button", { name: "Delete…" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "Deleted 1 of 2: server on fire",
  );
  await expect(eaten.locator(".entry")).toHaveCount(1);
});

// The Diary's adds are a "+" each, named by what they add to.
test("the adds are + icons named Add to Planned, Add to Eaten and Log on the day", async ({
  page,
  request,
}, testInfo) => {
  const { tag, day } = unique(67, testInfo);
  await ownProfile(page, request, `Plus ${tag}`);
  await page.goto(`/#/day/${day}`);
  const on = new Date(`${day}T12:00:00`).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  for (const add of [
    section(page, "Planned").getByRole("link", { name: "Add to Planned" }),
    section(page, "Eaten").getByRole("link", { name: "Add to Eaten" }),
    section(page, "Log").getByRole("button", { name: `Log on ${on}` }),
  ]) {
    await expect(add).toHaveText("");
    await expect(add.locator("svg")).toHaveCount(1);
    const { width, height } = await add.boundingBox();
    expect(Math.min(width, height)).toBeGreaterThanOrEqual(44);
  }
});

// The hint says what's missing: targets, or the profile they need.
test("no targets: the hint offers Targets, and the profile only when it's missing a measurement", async ({
  page,
  request,
}, testInfo) => {
  const { tag, day } = unique(68, testInfo);
  const pid = await ownProfile(page, request, `Hint ${tag}`);
  const base = `/api/profiles/${pid}`;
  const { rev } = await (await request.get(base)).json();
  await request.put(`${base}/targets`, { data: { rev, targets: [] } });
  await page.goto(`/#/day/${day}`);
  const hint = page.locator("p.targets-hint");
  await expect(hint).toHaveText("No targets yet: set targets.");
  await expect(hint.getByRole("link", { name: "set targets" })).toHaveAttribute(
    "href",
    "#/targets",
  );

  const res = await request.post("/api/profiles", {
    data: { name: `Bare ${tag}` },
  });
  const bare = await res.json();
  // Run after ownProfile's, so it wins.
  await page.addInitScript(
    (id) => localStorage.setItem("profile", String(id)),
    bare.id,
  );
  await page.reload();
  await expect(hint).toHaveText(
    "No targets yet: fill in your profile or set targets.",
  );
});

// ---------------------------------------------------------------------
// The Activity card: the day's movement, planned workouts,
// activities and Health Connect workouts waiting, above the Log card.

const activityCard = (page) => section(page, "Activity");

const shiftDay = (day, n) =>
  new Date(Date.parse(day) + n * 864e5).toISOString().slice(0, 10);

const prettyDay = (day) =>
  new Date(`${day}T12:00:00`).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });

// A workout of one step, saved through the API.
async function oneStep(request, name) {
  const all = await (await request.get("/api/exercises")).json();
  const res = await request.post("/api/workouts", {
    data: {
      name,
      steps: [
        {
          kind: "exercise",
          exercise_id: all.find((e) => e.name === "Push-up").id,
          reps: 5,
        },
      ],
    },
  });
  expect(res.ok()).toBeTruthy();
  return res.json();
}

const post = async (request, path, data) => {
  const res = await request.post(path, { data });
  expect(res.ok(), `${path}: ${res.status()}`).toBeTruthy();
  return res.json();
};

// Writes fail as if offline; reads go through.
const offlineWrites = (route) =>
  route.request().method() === "GET" ? route.fallback() : route.abort();

test("the Activity card sits between Sleep and Log: planned, done and waiting rows", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(1081, testInfo);
  const pid = await ownProfile(page, request, `Card ${tag}`);
  // Plans go no further ahead than a few weeks.
  const day = shiftDay(todayInApp(), -3);
  const base = `/api/profiles/${pid}`;
  const w = await oneStep(request, `Legs ${tag}`);
  await post(request, `${base}/plans`, { day, workout_id: w.id });
  // One named as its type, one of its own name.
  await post(request, `${base}/activities`, {
    day,
    type: "run",
    name: "Run",
    minutes: 30,
    sets: [],
  });
  await post(request, `${base}/activities`, {
    day,
    type: "walk",
    name: `Dog walk ${tag}`,
    minutes: 20,
    sets: [],
  });
  await realDay(page, day, (real) => ({
    ...real,
    pending_activities: [
      {
        key: `hc-${tag}`,
        day,
        name: "Cycling",
        start_at: `${day}T07:00:00Z`,
        minutes: 40,
        distance_m: 12000,
      },
    ],
  }));
  await page.goto(`/#/day/${day}`);
  const card = activityCard(page);
  await expect(card.locator(".log-row .kind")).toHaveText([
    "Planned",
    "Run",
    "Walk",
    "Waiting",
  ]);
  // Food groups, then Sleep (when any), Activity, then Log.
  const order = await page
    .locator(".stack > section.group > header h2")
    .allTextContents();
  expect(order.slice(-2)).toEqual(["Activity", "Log"]);
  // The planned name opens the workout, back to this day.
  await expect(
    card.locator(".log-row.planned").getByRole("link", { name: w.name }),
  ).toHaveAttribute(
    "href",
    `#/workout/${w.id}?back=${encodeURIComponent(`#/day/${day}`)}`,
  );
  // A day before today: no Start on the plan.
  await expect(card.getByRole("link", { name: /^Start /u })).toHaveCount(0);
  // The name is left out where it repeats the type.
  const run = card.locator(".log-row", { hasText: /^Run/u });
  await expect(run.locator(".result .name")).not.toHaveText("Run");
  await expect(run.locator(".result .name")).toHaveText(/^30\smin/u);
  await expect(
    card.locator(".log-row", { hasText: /^Walk/u }).locator(".result .name"),
  ).toHaveText(`Dog walk ${tag}`);
  // Each activity opens.
  await expect(
    card.getByRole("link", { name: starts(`Dog walk ${tag}`) }),
  ).toHaveAttribute("href", /^#\/activity\/\d+/u);
  // The Health Connect one waits with Add and Dismiss.
  const waiting = card.locator(".log-row.pending");
  await expect(waiting.getByRole("button", { name: /^Add /u })).toBeVisible();
  await expect(
    waiting.getByRole("button", { name: /^Dismiss /u }),
  ).toBeVisible();
  // No movement row: the headline says it (none on this day).
  await expect(
    card.locator(".log-row .kind", { hasText: "Movement" }),
  ).toHaveCount(0);

  // The Log card holds no activity section.
  const log = section(page, "Log");
  await expect(log).not.toContainText(`Legs ${tag}`);
  await expect(log).not.toContainText(`Dog walk ${tag}`);
  await expect(log.locator(".log-row .kind")).not.toContainText([
    "Planned",
    "Activity",
    "Movement",
  ]);
  // Nor does its sheet.
  await log.getByRole("button", { name: /^Log on /u }).click();
  const sheet = page.getByRole("dialog", { name: "Log" });
  await expect(sheet).toBeVisible();
  for (const name of [
    "Log an activity",
    "Plan a workout",
    "Start a saved workout",
  ])
    await expect(sheet.getByRole("link", { name: starts(name) })).toHaveCount(
      0,
    );
});

test("an activity with a device total reads active and total, no ≈", async ({
  page,
  request,
}, testInfo) => {
  const { tag, day } = unique(1082, testInfo);
  await ownProfile(page, request, `Total ${tag}`);
  // 355 kcal in 60 min, resting 1,560 kcal a day: 65 of it is resting.
  await realDay(page, day, (real) => ({
    ...real,
    activities: [
      {
        id: 990_000 + 1082,
        uid: `u-${tag}`,
        day,
        type: "run",
        name: `Evening ${tag}`,
        minutes: 60,
        kcal: 355,
        kcal_source: "health_connect_total",
        bmr_kcal: 1560,
        weight_kg: 60,
        source_key: `hc-${tag}`,
        distance_m: null,
        sets: [],
      },
    ],
  }));
  await page.goto(`/#/day/${day}`);
  const row = activityCard(page).locator(".log-row", {
    hasText: `Evening ${tag}`,
  });
  // Measured: the active part without ≈ (the total is its view's).
  await expect(row).toContainText(/active\s290\skcal$/u);
  await expect(row).not.toContainText("≈");
});

test("a device day's headline: steps and active energy against their targets, measured without ≈", async ({
  page,
  request,
}, testInfo) => {
  const { tag, day } = unique(1083, testInfo);
  await ownProfile(page, request, `Steps ${tag}`);
  await realDay(page, day, (real) => ({
    ...real,
    device_day: { day, steps: 8412, active_kcal: 420 },
    targets: [
      ...real.targets.filter(
        (t) => !["steps", "active_kcal"].includes(t.metric),
      ),
      { metric: "steps", value: 10000, min: 10000, max: null },
      { metric: "active_kcal", value: 600, min: 600, max: null },
    ],
  }));
  await page.goto(`/#/day/${day}`);
  const card = activityCard(page);
  await expect(card.locator("header .total > span")).toHaveText([
    /^8,412\ssteps\sof\s10,000$/u,
    /^active\s420\sof\s600\skcal$/u,
  ]);
  await expect(card.locator("header")).not.toContainText("≈");
  // Nothing else that day.
  await expect(card.locator(".log-row")).toHaveCount(0);
});

test("today's +: each workout's Start (Resume when kept), types, and Plan", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(1085, testInfo);
  const today = await fixedToday(page);
  const pid = await ownProfile(page, request, `Starts ${tag}`);
  const go = await oneStep(request, `Go ${tag}`);
  const kept = await oneStep(request, `Kept ${tag}`);
  await page.addInitScript(
    ([p, id, name]) =>
      localStorage.setItem(
        `run:${p}:${id}`,
        JSON.stringify({ id, name, at: 0, touched: Date.now() }),
      ),
    [pid, kept.id, kept.name],
  );
  await page.goto("/#/");
  const plus = activityCard(page).getByRole("button", {
    name: `Log an activity on ${prettyDay(today)}`,
  });
  await expect(plus).toHaveAttribute("aria-haspopup", "dialog");
  await plus.click();
  const sheet = page.getByRole("dialog", { name: "Log an activity" });
  const back = encodeURIComponent(`#/day/${today}`);
  await expect(
    sheet.getByRole("link", { name: `Start ${go.name}` }),
  ).toHaveAttribute("href", `#/workout/${go.id}/run?day=${today}`);
  await expect(
    sheet.getByRole("link", { name: `Resume ${kept.name}` }),
  ).toHaveAttribute("href", `#/workout/${kept.id}/run?day=${today}`);
  await expect(
    sheet.getByRole("link", { name: "Empty workout" }),
  ).toHaveAttribute(
    "href",
    `#/activity/new?day=${today}&type=workout&back=${back}`,
  );
  await expect(
    sheet.getByRole("link", { name: "Run", exact: true }),
  ).toHaveAttribute(
    "href",
    `#/activity/new?day=${today}&type=run&back=${back}`,
  );
  await expect(
    sheet.getByRole("link", { name: starts("Plan a workout") }),
  ).toHaveAttribute("href", `#/plan/${today}`);
  // A plan today has the same Start.
  await post(request, `/api/profiles/${pid}/plans`, {
    day: today,
    workout_id: kept.id,
  });
  await page.keyboard.press("Escape");
  await page.reload();
  await expect(
    activityCard(page)
      .locator(".log-row.planned")
      .getByRole("link", { name: `Resume ${kept.name}` }),
  ).toHaveAttribute("href", `#/workout/${kept.id}/run?day=${today}`);
});

test("a past day's +: a workout opens the editor filled in from it, no Start, no Plan", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(1086, testInfo);
  const today = await fixedToday(page);
  await ownProfile(page, request, `Past ${tag}`);
  const w = await oneStep(request, `Yesterday ${tag}`);
  const day = shiftDay(today, -1);
  await page.goto(`/#/day/${day}`);
  await activityCard(page)
    .getByRole("button", { name: `Log an activity on ${prettyDay(day)}` })
    .click();
  const sheet = page.getByRole("dialog", { name: "Log an activity" });
  // No way to run one (workouts are shared: any may be named "Start…").
  await expect(sheet.locator('a[href*="/run"]')).toHaveCount(0);
  await expect(
    sheet.getByRole("link", { name: starts("Plan a workout") }),
  ).toHaveCount(0);
  await expect(
    sheet.getByRole("link", { name: "Empty workout" }),
  ).toBeVisible();
  await sheet.getByRole("link", { name: starts(w.name) }).click();
  await expect(page).toHaveURL(
    new RegExp(`#/activity/new\\?day=${day}&workout=${w.id}&back=`, "u"),
  );
  await expect(page.getByRole("combobox", { name: "Workout" })).toHaveValue(
    String(w.id),
  );
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue(w.name);
});

test("a future day's + plans a workout; its empty card says Nothing planned; the plan screen marks what's planned", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(1087, testInfo);
  const today = await fixedToday(page);
  const pid = await ownProfile(page, request, `Ahead ${tag}`);
  const day = shiftDay(today, 2);
  const w = await oneStep(request, `Ahead ${tag}`);
  await oneStep(request, `Other ${tag}`);
  await page.setViewportSize({ width: 393, height: 800 });
  await page.goto(`/#/day/${day}`);
  const card = activityCard(page);
  await expect(card.locator("p.muted")).toHaveText("Nothing planned.");
  const plus = card.getByRole("link", {
    name: `Plan a workout on ${prettyDay(day)}`,
  });
  await expect(plus).toHaveAttribute("href", `#/plan/${day}`);
  await post(request, `/api/profiles/${pid}/plans`, { day, workout_id: w.id });
  await plus.click();
  // One line on a phone; the day under it.
  const title = page.getByRole("heading", { level: 1 });
  await expect(title).toHaveText("Plan a workout");
  const { height, line } = await title.evaluate((el) => ({
    height: el.getBoundingClientRect().height,
    line: parseFloat(getComputedStyle(el).lineHeight),
  }));
  expect(height).toBeLessThan(line * 1.5);
  await expect(page.locator("section > p.muted").first()).toHaveText(
    prettyDay(day),
  );
  // The workout planned that day says so.
  const picks = page.locator(".picker").getByRole("button");
  await expect(picks.filter({ hasText: `Ahead ${tag}` })).toContainText(
    "Planned",
  );
  await expect(picks.filter({ hasText: `Other ${tag}` })).not.toContainText(
    "Planned",
  );
  // The pick mode to start a workout is gone.
  await page.goto(`/#/plan/${day}?start=1`);
  await expect(title).toHaveText("Plan a workout");
});

test("offline, a logged activity waits in the Activity card", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(1088, testInfo);
  const today = await fixedToday(page);
  await ownProfile(page, request, `Waits ${tag}`);
  await page.goto("/#/");
  await expect(activityCard(page)).toContainText("Nothing logged.");
  await page.route("**/api/**", offlineWrites);
  await activityCard(page)
    .getByRole("button", { name: `Log an activity on ${prettyDay(today)}` })
    .click();
  await page
    .getByRole("dialog", { name: "Log an activity" })
    .getByRole("link", { name: "Run", exact: true })
    .click();
  await page.locator("[name=minutes]").fill("25");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator("#toast")).toContainText("Saved in this browser");
  await expect(page).toHaveURL(new RegExp(`#/day/${today}$`, "u"));
  const row = activityCard(page).locator(".log-row", { hasText: "Run" });
  await expect(row.locator(".kind")).toHaveText("Waiting");
  await expect(row).toContainText("Waiting to send");
  // Shown where it lands, not again at the bottom.
  await expect(section(page, "Waiting to send")).toHaveCount(0);
});

test("offline, a logged food waits in its group, not counted yet", async ({
  page,
  request,
}, testInfo) => {
  const { tag, day } = unique(1089, testInfo);
  await ownProfile(page, request, `Queued ${tag}`);
  const f = await food(request, {
    name: `Apple ${tag}`,
    per100: { energy: 50 },
  });
  await page.goto(`/#/log/${day}/Eaten/${f.id}`);
  await page.route("**/api/**", offlineWrites);
  await page.getByRole("button", { name: "Add to Eaten" }).click();
  await expect(page.locator("#toast")).toContainText("Saved in this browser");
  await expect(page).toHaveURL(new RegExp(`#/day/${day}$`, "u"));
  const eaten = section(page, "Eaten");
  const row = eaten.locator(".entry", { hasText: `Apple ${tag}` });
  await expect(row).toContainText("Waiting to send · not counted yet");
  await expect(section(page, "Waiting to send")).toHaveCount(0);
});

// The Diary's day read starts with meta and profiles, not after.
test("the Diary asks for its day while meta still loads", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(1093, testInfo);
  await ownProfile(page, request, `Early ${tag}`);
  let metaDone = false;
  let dayAsked = null;
  await page.route("**/api/meta", async (route) => {
    await delay(1000);
    const res = await route.fetch();
    metaDone = true;
    await route.fulfill({ response: res });
  });
  page.on("request", (r) => {
    if (dayAsked === null && /\/api\/profiles\/\d+\/day\//u.test(r.url()))
      dayAsked = metaDone;
  });
  await page.goto("/#/");
  await expect(section(page, "Log")).toBeVisible();
  expect(dayAsked).toBe(false);
});

// ------------------------------------------------- Eaten's day totals

// The Eaten card's foot: what the day's food held (Hydration, then the
// other built-in habits read from food), under its entries.
const dayTotals = (page) =>
  section(page, "Eaten").getByRole("list", { name: "Day's totals from food" });

const putJson = async (request, path, data) =>
  expect((await request.put(path, { data })).ok()).toBeTruthy();

async function waterTargets(request, pid, list) {
  const base = `/api/profiles/${pid}`;
  const { rev } = await (await request.get(base)).json();
  await putJson(request, `${base}/targets`, { rev, targets: list });
}

const eatOn = (request, pid, day, foodId, grams, group = "Eaten") =>
  entry(request, { day, group, food_id: foodId, grams }, pid);

test("Eaten ends with the day's totals from food; the Log card is for logging", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(1152, testInfo);
  const pid = await ownProfile(page, request, `Totals ${tag}`);
  const day = shiftDay(todayInApp(), -2);
  await waterTargets(request, pid, [
    { metric: "water", value: 2000 },
    { metric: "sodium", value: 2000 },
  ]);
  // Beer: 450 ml of water less 10 ml a gram of its 20 g alcohol.
  const beer = await food(request, {
    name: `Beer ${tag}`,
    per100: { water: 90, alcohol: 4, sodium: 40 },
  });
  await eatOn(request, pid, day, beer.id, 500);
  // An hour's run: the goal shows 0.5 L more, and says why.
  expect(
    (
      await request.post(`/api/profiles/${pid}/activities`, {
        data: { day, name: "Run", minutes: 60, type: "run" },
      })
    ).ok(),
  ).toBeTruthy();
  await page.goto(`/#/day/${day}`);
  const totals = dayTotals(page);
  await expect(totals.locator(".log-row .kind")).toHaveText([
    "Hydration",
    "From food",
  ]);
  await expect(totals.locator(".hydration .name")).toHaveText(
    /^250\sml\sof\s2\.5\sL\s\(2\sL\s\+\sactivity\)$/u,
  );
  await expect(totals.locator(".habit-builtins")).toHaveText(
    /^Alcohol\s1\.7\sdrinks · Salt\s0\.5\sg$/u,
  );
  // The card's foot, after its entries.
  expect(
    await section(page, "Eaten").evaluate((s) =>
      s.lastElementChild.getAttribute("aria-label"),
    ),
  ).toBe("Day's totals from food");
  // The Log card holds what is logged, none of it.
  const log = section(page, "Log");
  await expect(log.locator(".hydration, .habit-builtins")).toHaveCount(0);
  await expect(log.getByText("From food")).toHaveCount(0);
  // Selecting entries, the day's totals step aside.
  await section(page, "Eaten")
    .getByRole("button", { name: "Select from Eaten" })
    .click();
  await expect(totals).toHaveCount(0);
  await section(page, "Eaten").getByRole("button", { name: "Done" }).click();
  await expect(totals).toBeVisible();
});

test("Eaten's hydration: a drink of unknown water makes it a floor", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(1153, testInfo);
  const pid = await ownProfile(page, request, `Floor ${tag}`);
  const day = shiftDay(todayInApp(), -2);
  await waterTargets(request, pid, [{ metric: "water", value: 2500 }]);
  const tap = await food(request, {
    name: `Tap ${tag}`,
    per100: { water: 100 },
  });
  const mystery = await food(request, {
    name: `Mystery soda ${tag}`,
    per100: {},
    servings: [{ label: "330 ml", grams: 330 }],
  });
  await eatOn(request, pid, day, tap.id, 2459);
  await eatOn(request, pid, day, mystery.id, 330);
  await page.goto(`/#/day/${day}`);
  // Never rounded up to the goal, and a floor.
  await expect(dayTotals(page).locator(".hydration .name")).toHaveText(
    /^≥\s2\.4\sL\sof\s2\.5\sL$/u,
  );
});

test("Eaten's totals: none on a day with nothing eaten, planned food not counted; today's goal from 0 ml", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(1154, testInfo);
  const today = await fixedToday(page);
  const pid = await ownProfile(page, request, `Empty ${tag}`);
  await waterTargets(request, pid, [{ metric: "water", value: 2000 }]);
  // A past day with only a drink planned: nothing eaten, no totals.
  const day = shiftDay(today, -2);
  const juice = await food(request, {
    name: `Juice ${tag}`,
    per100: { water: 88, alcohol: 1 },
  });
  await eatOn(request, pid, day, juice.id, 300, "Planned");
  await page.goto(`/#/day/${day}`);
  await expect(section(page, "Planned").locator(".entry")).toHaveCount(1);
  await expect(dayTotals(page)).toHaveCount(0);
  // Today with a goal and nothing yet: where the day starts.
  await page.goto(`/#/day/${today}`);
  await expect(dayTotals(page).locator(".log-row")).toHaveCount(1);
  await expect(dayTotals(page).locator(".hydration .name")).toHaveText(
    /^0\sml\sof\s2\sL$/u,
  );
  await expect(section(page, "Log").locator(".hydration")).toHaveCount(0);
  // Today without a goal and nothing eaten: no totals.
  await waterTargets(request, pid, []);
  await page.reload();
  await expect(section(page, "Eaten").locator(".empty")).toBeVisible();
  await expect(dayTotals(page)).toHaveCount(0);
});

// One left edge: the totals' values where the Log card's are.
test("Eaten's totals share the Log card's value edge at 393 and 1280 px", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(1155, testInfo);
  const pid = await ownProfile(page, request, `Edge ${tag}`);
  const day = shiftDay(todayInApp(), -2);
  const beer = await food(request, {
    name: `Beer ${tag}`,
    per100: { water: 90, alcohol: 4, sodium: 40 },
  });
  await eatOn(request, pid, day, beer.id, 500);
  await putJson(request, `/api/profiles/${pid}/weights/${day}`, { kg: 72.4 });
  for (const width of [393, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/#/day/${day}`);
    await expect(dayTotals(page).locator(".log-row")).toHaveCount(2);
    const lefts = await page.evaluate(() =>
      [
        ...document.querySelectorAll(
          ":is(.day-totals, .log-card) .log-row > .result > :first-child",
        ),
      ].map((el) => [el.textContent, el.getBoundingClientRect().left]),
    );
    expect(lefts.length, `${width}px`).toBe(3);
    const xs = lefts.map(([, x]) => x);
    expect(
      Math.max(...xs) - Math.min(...xs),
      `${width}px: ${JSON.stringify(lefts)}`,
    ).toBeLessThanOrEqual(1);
  }
});

test("moved from Eaten back to Planned, an entry loses its time eaten", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag } = unique(1066, testInfo);
  const oats = await food(request, {
    name: `Oats ${tag}`,
    per100: { energy: 400 },
  });
  const {
    entries: [e],
  } = await entry(request, {
    day,
    group: "Eaten",
    food_id: oats.id,
    grams: 50,
    time: "08:15",
  });
  await page.goto(`/#/entry/${e.id}`);
  await expect(page.getByLabel("Time eaten")).toHaveValue("08:15");
  await page
    .getByRole("radiogroup", { name: "Group" })
    .getByRole("radio", { name: "Planned" })
    .click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator("#toast")).toContainText(`Saved Oats ${tag}`);
  await expect
    .poll(
      async () =>
        (await (await request.get(`/api/profiles/1/entries/${e.id}`)).json())
          .time,
    )
    .toBeNull();
  await page.goto(`/#/entry/${e.id}`);
  await expect(page.getByLabel("Time eaten")).toHaveValue("");
});

test("a planned entry's editor has no time eaten until its group is Eaten", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag } = unique(1067, testInfo);
  const oats = await food(request, {
    name: `Oats ${tag}`,
    per100: { energy: 400 },
  });
  const {
    entries: [e],
  } = await entry(request, {
    day,
    group: "Planned",
    food_id: oats.id,
    grams: 50,
  });
  await page.goto(`/#/entry/${e.id}`);
  const group = page.getByRole("radiogroup", { name: "Group" });
  const time = page.getByLabel("Time eaten");
  await expect(group.getByRole("radio", { name: "Planned" })).toBeChecked();
  await expect(time).toBeHidden();
  await group.getByRole("radio", { name: "Eaten" }).click();
  await expect(time).toBeVisible();
  await time.fill("12:30");
  await group.getByRole("radio", { name: "Planned" }).click();
  await expect(time).toBeHidden();
  await group.getByRole("radio", { name: "Eaten" }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator("#toast")).toContainText(`Saved Oats ${tag}`);
  await expect
    .poll(
      async () =>
        (await (await request.get(`/api/profiles/1/entries/${e.id}`)).json())
          .time,
    )
    .toBe("12:30");

  // Logging into Planned asks no time either.
  await page.goto(`/#/log/${day}/Planned/${oats.id}`);
  await expect(
    page.getByRole("button", { name: "Add to Planned" }),
  ).toBeVisible();
  await expect(page.getByLabel("Time eaten")).toBeHidden();
});
