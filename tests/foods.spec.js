// The Foods tab and search: foods, recipes, meals, barcodes, favourites.

import { expect, test } from "@playwright/test";
import {
  answer,
  answered,
  entry,
  expectFits,
  food,
  headline,
  loseFirstAnswer,
  mockJson,
  newProfile,
  ownProfile,
  save,
  settled,
  starts,
  unique,
} from "./helpers.js";

test("create a recipe and log it", async ({ page, request }, testInfo) => {
  const { day, tag } = unique(5, testInfo);
  await food(request, { name: `Flour ${tag}`, per100: { energy: 360 } });

  await page.goto("/#/recipe/new");
  await page.getByLabel("Name").fill(`Flatbread ${tag}`);
  await page.getByLabel("Search foods to add").fill(`Flour ${tag}`);
  await page.getByRole("button", { name: starts(`Flour ${tag}`) }).click();
  await page.getByLabel(`Flour ${tag} quantity`).fill("200");
  // Weighs its ingredients until weighed after cooking.
  await expect(page.getByText("Weighs 200 g (its ingredients).")).toBeVisible();
  await page.getByText("Weighed it after cooking?").click();
  await page.getByLabel("Weight after cooking (g)").fill("300");
  // The whole recipe is a serving, the default, at its weight.
  const whole = page.locator(".servings .serving").first();
  await expect(whole).toContainText(/Whole recipe\s*300\s*g/u);
  await expect(whole).toContainText("Default");
  await page.getByRole("button", { name: "Save" }).click();
  const energy = page.locator(".nutrition-panel tr", { hasText: "Energy" });
  // 720 kcal of flour over 300 g cooked: 240 per 100 g.
  await expect(energy).toContainText("240 kcal");
  await expect(energy).toContainText("720 kcal");
  await expect(page.locator("#toast")).toContainText(`Saved Flatbread ${tag}`);

  await page.goto(`/#/add/${day}/Eaten`);
  // Exact: the recipe editor just left has "Search foods to add".
  await page
    .getByLabel("Search foods", { exact: true })
    .fill(`Flatbread ${tag}`);
  await page.getByRole("button", { name: starts(`Flatbread ${tag}`) }).click();
  // The whole recipe is the default; grams are one pick away.
  const unit = page.getByLabel("Unit");
  await expect(unit.locator("option:checked")).toHaveText(/^Whole recipe/u);
  await unit.selectOption({ label: "g" });
  await page.getByLabel("quantity").fill("100");
  await page.getByRole("button", { name: "Add to Eaten" }).click();
  await expect(headline(page)).toHaveText("240 kcal");
});

test("barcode lookup logs a known food", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag, barcode } = unique(7, testInfo);
  await food(request, {
    name: `Yoghurt ${tag}`,
    barcode,
    per100: { energy: 60 },
  });

  await page.goto(`/#/add/${day}/Eaten`);
  await page.getByLabel("Search foods").fill(barcode);
  await page
    .getByRole("button", { name: `Look up barcode ${barcode}` })
    .click();
  await expect(
    page.getByRole("heading", { name: `Yoghurt ${tag}` }),
  ).toBeVisible();
  await page.getByLabel("quantity").fill("200");
  await page.getByRole("button", { name: "Add to Eaten" }).click();
  await expect(headline(page)).toHaveText("120 kcal");
});

test("barcode lookup with Open Food Facts down offers manual entry", async ({
  page,
}, testInfo) => {
  const { day } = unique(8, testInfo);
  // The test server points Open Food Facts at a closed port.
  await page.goto(`/#/add/${day}/Eaten`);
  await page.getByLabel("Search foods").fill("4999999999999");
  await page
    .getByRole("button", { name: "Look up barcode 4999999999999" })
    .click();
  await expect(page.getByRole("alert").first()).toContainText("unreachable");
  await page.getByRole("link", { name: "Enter it by hand" }).click();
  await expect(page.getByRole("heading", { name: "New food" })).toBeVisible();
  await expect(page.getByLabel("Barcode", { exact: true })).toHaveValue(
    "4999999999999",
  );
});

test("archived foods can be found again", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(11, testInfo);
  const oats = await food(request, { name: `Old Oats ${tag}` });
  // In a recipe: kept, so archived (with nothing using it, it's deleted).
  await request.post("/api/recipes", {
    data: { name: `Jar ${tag}`, items: [{ food_id: oats.id, grams: 40 }] },
  });
  const result = page.getByRole("button", { name: starts(`Old Oats ${tag}`) });

  // Archived from its editor: it stays, hidden from search.
  await page.goto(`/#/food/${oats.id}`);
  await page.getByRole("button", { name: "Archive", exact: true }).click();
  await answer(page, "Archive");
  await expect(page.locator("#toast")).toContainText(
    `Archived Old Oats ${tag}`,
  );
  await expect(page.getByText("Archived: hidden from search.")).toBeVisible();
  expect(
    (await (await request.get(`/api/foods/${oats.id}`)).json()).archived,
  ).toBe(true);

  await page.goto("/#/foods");
  await page.getByLabel("Search foods").fill(`Old Oats ${tag}`);
  await expect(page.getByText("No matches.")).toBeVisible();
  await page.getByRole("button", { name: /^Filters/u }).click();
  await page.getByLabel("Show archived").check();
  await page.getByLabel("Search foods").fill(`Old Oats ${tag}`);
  await expect(result).toBeVisible();
  await page.getByRole("button", { name: "Clear filters" }).click();

  // Unarchived: back in the plain search.
  await page.goto(`/#/food/${oats.id}`);
  await page.getByRole("button", { name: "Unarchive", exact: true }).click();
  await expect(page.locator("#toast")).toContainText(
    `Unarchived Old Oats ${tag}`,
  );
  await expect(
    page.getByRole("button", { name: "Archive", exact: true }),
  ).toBeVisible();
  await page.goto("/#/foods");
  await page.getByLabel("Search foods").fill(`Old Oats ${tag}`);
  await expect(result).toBeVisible();
});

test("unknown barcode leads to a prefilled new food, then back to logging", async ({
  page,
}, testInfo) => {
  const { day, tag, barcode } = unique(14, testInfo);
  await page.route("**/api/foods/barcode/*", (route) =>
    route.request().method() === "POST"
      ? route.fulfill({ status: 404, json: { error: "not found" } })
      : route.continue(),
  );
  await page.goto(`/#/add/${day}/Eaten`);
  await page.getByLabel("Search foods").fill(barcode);
  await page
    .getByRole("button", { name: `Look up barcode ${barcode}` })
    .click();
  await expect(
    page.getByText("Not in your foods or Open Food Facts"),
  ).toBeVisible();
  await expect(page.getByLabel("Barcode", { exact: true })).toHaveValue(
    barcode,
  );
  await page.getByLabel("Name").fill(`Crisps ${tag}`);
  await page.getByLabel("Energy (kcal)").fill("540");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page).toHaveURL(new RegExp(`#/log/${day}/Eaten/\\d+$`, "u"));
  await expect(
    page.getByRole("button", { name: "Add to Eaten" }),
  ).toBeVisible();
});

test("editing a food while logging returns to the log screen", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag } = unique(15, testInfo);
  const f = await food(request, {
    name: `Bun ${tag}`,
    per100: { energy: 100 },
  });
  await page.goto(`/#/log/${day}/Eaten/${f.id}`);
  await page.getByRole("link", { name: "Edit food" }).click();
  await page.getByLabel("Energy (kcal)").fill("300");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page).toHaveURL(new RegExp(`#/log/${day}/Eaten/${f.id}$`, "u"));
  await expect(
    page.locator(".nutrition-panel tr", { hasText: "Energy" }),
  ).toContainText(/300\skcal/u);
});

test("foods are entered as on an EU label", async ({ page }, testInfo) => {
  const { tag } = unique(22, testInfo);
  await page.goto("/#/food/new");
  await page.getByLabel("Name").fill(`Rye crisp ${tag}`);
  // Energy in this device's unit only (kcal): no second kJ field.
  await expect(page.getByLabel("Energy (kJ)")).toHaveCount(0);
  await page.getByLabel("Energy (kcal)").fill("359");
  await page.getByLabel("Carbs (g)", { exact: true }).fill("60");
  await page.getByLabel("Fibre (g)", { exact: true }).fill("15");
  await page.getByLabel("Salt (g)").fill("1.25");
  await page.locator("form summary", { hasText: "Other nutrients" }).click();
  await page.getByLabel("Vitamin D (µg)").fill("5");
  await page.getByRole("button", { name: "Save" }).click();
  // Saved: the editor moves to the new food's own address.
  await expect(page).toHaveURL(/#\/food\/\d+$/u);

  const foods = await (
    await page.request.get(
      `/api/profiles/1/foods?q=${encodeURIComponent(`Rye crisp ${tag}`)}`,
    )
  ).json();
  const per100 = foods[0].per100;
  expect(per100.net_carbs).toBe(60);
  expect(per100.carbs).toBe(75);
  expect(per100.sodium).toBe(500);
  expect(per100.vitamin_d).toBe(200);
  expect(per100.energy).toBe(359);

  await page.goto(`/#/food/${foods[0].id}`);
  await expect(page.getByLabel("Salt (g)")).toHaveValue("1.25");
});

const background = (locator) =>
  locator.evaluate((el) => getComputedStyle(el).backgroundColor);

test("a Fineli food credits its source", async ({ page }) => {
  await page.route("**/api/foods/990001", (route) =>
    route.fulfill({
      json: {
        id: 990001,
        name: "Maito, rasvaton",
        brand: "Fineli",
        barcode: null,
        source: "fineli",
        // Converted from kJ: not a round number.
        per100: { energy: 33.748 },
        cooked_g: null,
        archived: false,
        servings: [],
      },
    }),
  );
  await page.goto("/#/food/990001");
  await expect(page.getByRole("link", { name: "Fineli" })).toHaveAttribute(
    "href",
    "https://fineli.fi",
  );
  await expect(page.getByText("CC BY 4.0")).toBeVisible();
  // Its values are shown, not edited: rounded, and not styled as a field
  // to type in (Barcode, yours, is).
  const energy = page.getByLabel("Energy (kcal)");
  await expect(energy).toHaveValue("33.7");
  // A name with brackets takes its unit inside them.
  await expect(page.getByLabel("B1 (thiamine, mg)")).toBeAttached();
  await expect(energy).toBeDisabled();
  expect(await background(energy)).not.toBe(
    await background(page.getByLabel("Barcode")),
  );
});

// The server's /api/meta, offering `sources` to search.
const withSources = (page, sources) =>
  mockJson(page, "**/api/meta", { food_sources: sources });

test("only the databases the server has are offered", async ({ page }) => {
  await withSources(page, ["custom", "recipe"]);
  await page.goto("/#/foods");
  await page.getByRole("button", { name: /^Filters/u }).click();
  const databases = page.getByRole("group", { name: "Databases" });
  await expect(databases.getByRole("checkbox")).toHaveCount(2);
  await expect(databases.getByLabel("Your foods")).toBeChecked();
  await expect(databases.getByLabel("Your recipes")).toBeChecked();
  await expect(databases.getByLabel("Fineli")).toHaveCount(0);
  await expect(databases.getByLabel("Open Food Facts")).toHaveCount(0);
});

test("a database imported later is offered and searched", async ({ page }) => {
  // Saved when only your own foods and recipes were offered, Recipes off.
  await page.addInitScript(() => {
    localStorage.setItem(
      "food-filters",
      JSON.stringify({ hidden: ["recipe"], rules: [], sort: "relevance" }),
    );
  });
  await withSources(page, ["custom", "recipe", "fineli"]);
  await page.goto("/#/foods");
  await page.getByRole("button", { name: /^Filters/u }).click();
  const databases = page.getByRole("group", { name: "Databases" });
  await expect(databases.getByLabel("Fineli")).toBeChecked();
  await expect(databases.getByLabel("Your recipes")).not.toBeChecked();
  const search = page.waitForRequest(/\/api\/profiles\/\d+\/foods\?/u);
  await page.getByLabel("Search foods").fill("maito");
  const sources = new URL((await search).url()).searchParams.get("sources");
  expect(sources.split(",")).toEqual(["custom", "fineli"]);
});

test("a saved filter of a database no longer offered hides nothing", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(970, testInfo);
  await food(request, { name: `Kept ${tag}` });
  await page.addInitScript(() => {
    localStorage.setItem(
      "food-filters",
      JSON.stringify({ sources: ["fineli"], rules: [], sort: "relevance" }),
    );
  });
  await withSources(page, ["custom", "recipe"]);
  await page.goto("/#/foods");
  await expect(
    page.getByRole("button", { name: "Filters", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Search foods").fill(`Kept ${tag}`);
  await expect(
    page.getByRole("button", { name: starts(`Kept ${tag}`) }),
  ).toBeVisible();
});

test("search filters choose databases and are remembered", async ({ page }) => {
  await withSources(page, ["custom", "recipe", "fineli"]);
  await page.goto("/#/foods");
  await page.getByRole("button", { name: /^Filters/u }).click();
  await page.getByLabel("Fineli").uncheck();
  await expect(page.getByRole("button", { name: "Filters · 1" })).toBeVisible();
  const search = page.waitForRequest(/\/api\/profiles\/\d+\/foods\?/u);
  await page.getByLabel("Search foods").fill("maito");
  const sources = new URL((await search).url()).searchParams.get("sources");
  expect(sources.split(",")).not.toContain("fineli");

  await page.reload();
  await expect(page.getByRole("button", { name: "Filters · 1" })).toBeVisible();
  await page.getByRole("button", { name: /^Filters/u }).click();
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(
    page.getByRole("button", { name: "Filters", exact: true }),
  ).toBeVisible();
});

test("a nutrient rule narrows the search", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(33, testInfo);
  await food(request, { name: `Rule rich ${tag}`, per100: { protein: 30 } });
  await food(request, { name: `Rule poor ${tag}`, per100: { protein: 2 } });
  await page.goto("/#/foods");
  await page.getByRole("button", { name: /^Filters/u }).click();
  await page.getByRole("button", { name: "+ Rule" }).click();
  await page.getByLabel("Rule nutrient").selectOption("protein");
  await page.getByLabel("Rule amount").fill("20");
  await page.getByLabel("Search foods").fill(`rule ${tag}`);
  await expect(
    page.getByRole("button", { name: starts(`Rule rich ${tag}`) }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: starts(`Rule poor ${tag}`) }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Clear filters" }).click();
});

test("the foods tab lists favorites until you search", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(31, testInfo);
  const liked = await food(request, { name: `Liked ${tag}` });
  await food(request, { name: `Other ${tag}` });
  await request.post("/api/profiles/1/foods/favorites", {
    data: { food_id: liked.id },
  });

  await page.goto("/#/foods");
  const favourites = page.locator(".finder-section", {
    has: page.getByRole("heading", { name: "Favourites" }),
  });
  await expect(
    favourites.getByRole("button", { name: starts(`Liked ${tag}`) }),
  ).toBeVisible();
  await expect(
    favourites.getByRole("button", { name: starts(`Other ${tag}`) }),
  ).toHaveCount(0);
  await page.getByLabel("Search foods").fill(`Other ${tag}`);
  await expect(
    page.getByRole("button", { name: starts(`Other ${tag}`) }),
  ).toBeVisible();
});

test("a food from the foods tab is added, not edited", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(32, testInfo);
  const f = await food(request, {
    name: `Snack ${tag}`,
    per100: { energy: 200 },
  });
  await page.goto("/#/foods");
  await page.getByLabel("Search foods").fill(`Snack ${tag}`);
  await page.getByRole("button", { name: starts(`Snack ${tag}`) }).click();

  await expect(
    page.getByRole("button", { name: "Add to Eaten" }),
  ).toBeVisible();
  const star = page.getByRole("button", { name: "Favourite" });
  await expect(star).toHaveAttribute("aria-pressed", "false");
  await star.click();
  await expect(star).toHaveAttribute("aria-pressed", "true");
  const favs = await (
    await request.get("/api/profiles/1/foods/favorites")
  ).json();
  expect(favs.map((x) => x.id)).toContain(f.id);
  // Un-starring takes it off the list again.
  await star.click();
  await expect(star).toHaveAttribute("aria-pressed", "false");
  await expect
    .poll(async () =>
      (await (await request.get("/api/profiles/1/foods/favorites")).json()).map(
        (x) => x.id,
      ),
    )
    .not.toContain(f.id);

  await page.getByRole("button", { name: "Add to Planned" }).click();
  await expect(page).toHaveURL(/#\/day\/\d{4}-\d{2}-\d{2}$/u);
  const planned = page.locator("section.group", {
    has: page.getByRole("heading", { name: "Planned" }),
  });
  await expect(planned.getByText(`Snack ${tag}`)).toBeVisible();
});

test("an empty search shows favourites, recent and meals", async ({ page }) => {
  await page.goto("/#/foods");
  for (const name of ["Favourites", "Recent", "Meals"])
    await expect(page.getByRole("heading", { name })).toBeVisible();
});

test("a new food saved from Foods stays in its editor", async ({
  page,
}, testInfo) => {
  const { tag } = unique(36, testInfo);
  await page.goto("/#/foods");
  await page.getByRole("link", { name: "New food" }).click();
  // The Foods list stays shown while the editor loads: under load a fill
  // found its Sort and a food's Favourite instead.
  await expect(page.getByRole("heading", { name: "New food" })).toBeVisible();
  await page.getByLabel("Name", { exact: true }).fill(`Fresh ${tag}`);
  await page.getByRole("button", { name: "Save" }).click();
  // No energy: a soft warning first.
  expect(await answer(page, "Save")).toBe("Save without energy?");
  await expect(page).toHaveURL(/#\/food\/\d+$/u);
  await expect(
    page.getByRole("heading", { name: `Fresh ${tag}` }),
  ).toBeVisible();
  await expect(page.locator("#toast")).toContainText(`Saved Fresh ${tag}`);
});

// The full suite's one flake (failed once under load): the save's toast
// timed out while the next screen still loaded, so it was gone when the
// screen showed. Its time counts from the screen shown.
test("a save's toast outlasts a slow next screen", async ({
  page,
}, testInfo) => {
  const { tag } = unique(1059, testInfo);
  await page.clock.install();
  let release;
  const held = new Promise((r) => {
    release = r;
  });
  await page.route(/\/api\/foods\/\d+$/u, async (route) => {
    if (route.request().method() === "GET") await held;
    await route.continue();
  });
  await page.goto("/#/foods");
  await page.getByRole("link", { name: "New food" }).click();
  // The Foods list stays shown while the editor loads: under load a fill
  // found its Sort and a food's Favourite instead.
  await expect(page.getByRole("heading", { name: "New food" })).toBeVisible();
  await page.getByLabel("Name", { exact: true }).fill(`Slow ${tag}`);
  await page.getByRole("button", { name: "Save" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Save", exact: true })
    .click();
  await expect(page).toHaveURL(/#\/food\/\d+$/u);
  // The food takes longer to load than a toast lasts.
  await page.clock.runFor(7_000);
  release();
  await expect(
    page.getByRole("heading", { name: `Slow ${tag}` }),
  ).toBeVisible();
  await expect(page.locator("#toast")).toContainText(`Saved Slow ${tag}`);
});

test("without a camera the scan screen still takes digits", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag, barcode } = unique(39, testInfo);
  await food(request, { name: `Scanned ${tag}`, barcode });
  await page.addInitScript(() => {
    delete window.BarcodeDetector;
  });
  await page.goto(`/#/scan/${day}/Eaten`);
  await page.getByLabel("Barcode digits").fill(barcode);
  await page.getByRole("button", { name: "Look up" }).click();
  await expect(
    page.getByRole("heading", { name: `Scanned ${tag}` }),
  ).toBeVisible();
});

test("filters saved by an older version reset instead of breaking search", async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      "food-filters",
      JSON.stringify({ rules: [{ key: "protein", dir: "min", amount: -1 }] }),
    );
  });
  await page.goto("/#/foods");
  await page.getByLabel("Search foods").fill("a");
  await expect(page.locator("#toast")).toContainText(
    "Reset the search filters",
  );
  await expect(
    page.getByRole("button", { name: "Filters", exact: true }),
  ).toBeVisible();
});

test("a scanned barcode opens the food", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag, barcode } = unique(43, testInfo);
  await food(request, { name: `Scan me ${tag}`, barcode });
  await page.addInitScript((code) => {
    window.BarcodeDetector = class {
      detect() {
        return Promise.resolve([{ rawValue: code }]);
      }
    };
    navigator.mediaDevices.getUserMedia = () =>
      Promise.resolve(new MediaStream());
  }, barcode);
  await page.goto(`/#/scan/${day}/Eaten`);
  await expect(
    page.getByRole("heading", { name: `Scan me ${tag}` }),
  ).toBeVisible();
});

test("nutrition shows in every food view and follows the amounts", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag } = unique(44, testInfo);
  const oats = await food(request, {
    name: `Panel oats ${tag}`,
    per100: { energy: 380, protein: 13, sodium: 400 },
  });
  await food(request, {
    name: `Panel milk ${tag}`,
    per100: { energy: 40, protein: 3.5 },
  });
  // A row by its label (a hint like "of the energy" names Energy too).
  const row = (label) =>
    page.getByRole("row", {
      name: new RegExp(`^${label}\\b`, "u"),
      includeHidden: true,
    });

  // Logging: per 100 g and the amount chosen; salt in EU units.
  await page.goto(`/#/log/${oats.id}`);
  await expect(row("Energy")).toContainText("380 kcal");
  await page.getByLabel("quantity").fill("50");
  await expect(row("Energy")).toContainText("190 kcal");
  await expect(row("Salt")).toContainText("1 g");
  await expect(row("Salt")).toContainText("0.5 g");

  // The diary's entry editor: what was eaten, with the log screen's health
  // cues (one view).
  const {
    entries: [logged],
  } = await entry(request, {
    day,
    group: "Eaten",
    food_id: oats.id,
    grams: 50,
  });
  await page.goto(`/#/entry/${logged.id}`);
  await expect(row("Energy")).toContainText("190 kcal");
  await expect(page.locator(".nutrition-panel .health")).toHaveCount(1);

  // Editing a food: live as typed, plus the first serving.
  await page.goto(`/#/food/${oats.id}`);
  await page.getByLabel("Energy (kcal)").fill("200");
  await page.getByRole("button", { name: "+ Serving" }).click();
  await page.getByLabel("Serving name").fill("bowl");
  await page.getByLabel("Serving grams").fill("50");
  // Per 100 g is the form itself; the panel adds the serving only.
  await expect(row("Energy")).toContainText("100 kcal");
  await expect(
    page.getByRole("columnheader", { name: "Per 100 g" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("columnheader", { name: /^bowl \(50\sg\)$/u }),
  ).toBeVisible();

  // A meal: the total of its items, updated as items change.
  await page.goto("/#/meal/new");
  await answer(page, "Leave");
  await page.getByLabel("Search foods to add").fill(`Panel oats ${tag}`);
  await page.getByRole("button", { name: starts(`Panel oats ${tag}`) }).click();
  await page.getByLabel("Search foods to add").fill(`Panel milk ${tag}`);
  await page.getByRole("button", { name: starts(`Panel milk ${tag}`) }).click();
  // 100 g each: 380 + 40 kcal.
  await expect(row("Energy")).toContainText("420 kcal");
  await page.getByLabel(`Panel milk ${tag} quantity`).fill("200");
  await expect(row("Energy")).toContainText("460 kcal");
  await page.getByRole("button", { name: `Remove Panel oats ${tag}` }).click();
  await expect(row("Energy")).toContainText("80 kcal");
});

test("a meal's and recipe's totals say how much of their food carries a nutrient", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(640, testInfo);
  await food(request, {
    name: `Cover oats ${tag}`,
    per100: { energy: 380, protein: 13, sodium: 400, water: 10 },
  });
  await food(request, {
    name: `Cover milk ${tag}`,
    per100: { energy: 40, protein: 3.5, water: 90 },
  });
  // Salt's cell in the column `nth` (0 the first amount).
  const salt = (nth) =>
    page
      .getByRole("row", { name: /^Salt\b/u, includeHidden: true })
      .locator("td")
      .nth(nth);
  const add = async (name) => {
    await page.getByLabel("Search foods to add").fill(name);
    await page.getByRole("button", { name: starts(name) }).click();
  };
  // 100 g each: the salt's oats are 90 of the 100 g of dry matter, 90 %:
  // judged, a floor all the same (ADR 0030, by dry matter).
  for (const [screen, columns] of [
    ["meal", [0]],
    ["recipe", [0, 1]],
  ]) {
    await page.goto(`/#/${screen}/new`);
    // Leaving the meal just built asks first.
    if (screen === "recipe") await answer(page, "Leave");
    await add(`Cover oats ${tag}`);
    await add(`Cover milk ${tag}`);
    for (const nth of columns) {
      await expect(salt(nth)).toContainText(/^≥\s/u);
      await expect(salt(nth)).toContainText(/from 9\d\s%/u);
    }
  }
});

test("a food can be starred right from the list", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(45, testInfo);
  await ownProfile(page, request, `Stars ${tag}`);
  const name = `Star kale ${tag}`;
  await food(request, { name, per100: { energy: 50 } });
  await page.goto("/#/foods");
  const favourites = page.locator(".finder-section", {
    has: page.getByRole("heading", { name: "Favourites" }),
  });
  await expect(favourites).toContainText("Star a food");

  await page.getByLabel("Search foods").fill(name);
  const star = page.getByRole("button", { name: `Favourite ${name}` });
  await star.click();
  await expect(star).toHaveAttribute("aria-pressed", "true");

  await page.getByLabel("Search foods").fill("");
  await expect(favourites.getByText(name)).toBeVisible();
  await favourites.getByRole("button", { name: `Favourite ${name}` }).click();
  await expect(favourites.getByText(name)).toHaveCount(0);
});

test("an ingredient starts at its food's default serving and opens the food, keeping the recipe", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(52, testInfo);
  const whey = await food(request, {
    name: `Whey ${tag}`,
    per100: { energy: 380, protein: 80 },
    servings: [{ label: "Scoop", grams: 37 }],
  });
  await page.goto("/#/recipe/new");
  await page.getByLabel("Name").fill(`Shake ${tag}`);
  await page.getByLabel("Search foods to add").fill(`Whey ${tag}`);
  await page.getByRole("button", { name: starts(`Whey ${tag}`) }).click();
  await expect(page.getByLabel(`Whey ${tag} quantity`)).toHaveValue("1");
  await expect(
    page.getByLabel(`Whey ${tag} unit`).locator("option:checked"),
  ).toHaveText("Scoop (37\u00A0g)");

  // Off to the food: a new default serving, then back to the same recipe.
  await page.getByRole("button", { name: `Edit Whey ${tag}` }).click();
  await expect(page).toHaveURL(new RegExp(`#/food/${whey.id}\\?back=`, "u"));
  await page.getByRole("button", { name: "+ Serving" }).click();
  await page.getByLabel("Serving name").last().fill("Big scoop");
  await page.getByLabel("Serving grams").last().fill("45");
  await page
    .getByRole("button", { name: "Make Big scoop the default" })
    .click();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page).toHaveURL(/#\/recipe\/new\?draft=1$/u);
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
    `Shake ${tag}`,
  );
  await expect(page.getByLabel(`Whey ${tag} quantity`)).toHaveValue("1");
  await expect(
    page.getByLabel(`Whey ${tag} unit`).locator("option:checked"),
  ).toHaveText("Scoop (37\u00A0g)");
  const saved = await (await request.get(`/api/foods/${whey.id}`)).json();
  expect(saved.servings.map((s) => s.label)).toEqual(["Big scoop", "Scoop"]);
});

test("your own foods and meals come first in search", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(53, testInfo);
  const mine = await food(request, {
    name: `Rahka ${tag} z`,
    per100: { energy: 60 },
  });
  await request.post("/api/meals", {
    data: {
      name: `Rahka ${tag} breakfast`,
      items: [{ food_id: mine.id, grams: 200 }],
    },
  });
  await page.goto("/#/foods");
  await page.getByLabel("Search foods").fill(`rahka ${tag}`);
  const rows = page.locator(".results .result .name");
  await expect(rows.first()).toHaveText(`Rahka ${tag} breakfast`);
});

test("the food editor saves in place and asks before losing changes", async ({
  page,
  request,
}, testInfo) => {
  const { tag, barcode } = unique(120, testInfo);
  const f = await food(request, {
    name: `Shell bread ${tag}`,
    per100: { energy: 250 },
  });
  await page.goto(`/#/food/${f.id}`);
  const name = page.getByLabel("Name", { exact: true });
  await expect(name).toHaveValue(`Shell bread ${tag}`);

  // Save stays on the editor and says so.
  await page.getByLabel("Energy (kcal)").fill("260");
  await save(page, `Saved Shell bread ${tag}`);
  await expect(page).toHaveURL(new RegExp(`#/food/${f.id}$`, "u"));
  await expect(page.getByLabel("Energy (kcal)")).toHaveValue("260");

  // Unsaved changes: leaving asks; Cancel keeps them, Leave goes.
  await name.fill(`Shell loaf ${tag}`);
  const foodsTab = page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Foods" });
  await foodsTab.click();
  expect(await answer(page, "Stay")).toBe("Leave without saving?");
  await expect(page).toHaveURL(new RegExp(`#/food/${f.id}$`, "u"));
  await expect(name).toHaveValue(`Shell loaf ${tag}`);
  await foodsTab.click();
  await answer(page, "Leave");
  await expect(page).toHaveURL(/#\/foods$/u);
  const kept = await (await request.get(`/api/foods/${f.id}`)).json();
  expect(kept.name).toBe(`Shell bread ${tag}`);

  // A server error says why at the bar and marks the field it names.
  await page.goto(`/#/food/${f.id}`);
  await expect(name).toHaveValue(`Shell bread ${tag}`);
  await page.getByLabel("Barcode", { exact: true }).fill("12");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Barcode must be 4–32 digits" }),
  ).toBeVisible();
  await expect(page.getByLabel("Barcode", { exact: true })).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  // A food's serving can't take the recipes' name.
  await page.getByLabel("Barcode", { exact: true }).fill(barcode);
  await page.getByRole("button", { name: "+ Serving" }).click();
  await page.getByLabel("Serving name").fill("Whole recipe");
  await page.getByLabel("Serving grams").fill("100");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "is kept for recipes" }),
  ).toBeVisible();
  await expect(page.getByLabel("Barcode", { exact: true })).not.toHaveAttribute(
    "aria-invalid",
  );
});

test("saving a food changed elsewhere offers to reload", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(121, testInfo);
  const f = await food(request, {
    name: `Stale jam ${tag}`,
    per100: { energy: 250 },
  });
  await page.goto(`/#/food/${f.id}`);
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
    `Stale jam ${tag}`,
  );
  const put = await request.put(`/api/foods/${f.id}`, {
    data: { ...f, name: `Fresh jam ${tag}`, per100: { energy: 200 } },
  });
  expect(put.ok()).toBeTruthy();

  await page.getByLabel("Energy (kcal)").fill("300");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const status = page
    .getByRole("status")
    .filter({ hasText: "changed elsewhere" });
  await expect(status).toBeVisible();
  await status.getByRole("button", { name: "Reload" }).click();
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
    `Fresh jam ${tag}`,
  );
  await expect(page.getByLabel("Energy (kcal)")).toHaveValue("200");
  await expect(status).toHaveCount(0);
});

test("servings: a new default goes first, and a recipe keeps its whole", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(122, testInfo);
  const f = await food(request, {
    name: `Loaf ${tag}`,
    per100: { energy: 250 },
    servings: [{ label: "Slice", grams: 40 }],
  });
  await page.goto(`/#/food/${f.id}`);
  const servings = page.getByRole("group", { name: "Servings" });
  const rows = servings.locator(".serving");
  await page.getByRole("button", { name: "+ Serving" }).click();
  await page.getByLabel("Serving name").last().fill("Half loaf");
  await page.getByLabel("Serving grams").last().fill("400");
  await expect(rows.first()).toContainText("Default");
  await page
    .getByRole("button", { name: "Make Half loaf the default" })
    .click();
  await expect(rows.first().getByLabel("Serving name")).toHaveValue(
    "Half loaf",
  );
  await expect(rows.first()).toContainText("Default");
  await expect(
    rows.nth(1).getByRole("button", { name: "Make Slice the default" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator("#toast")).toContainText(`Saved Loaf ${tag}`);
  const saved = await (await request.get(`/api/foods/${f.id}`)).json();
  expect(saved.servings.map((s) => s.label)).toEqual(["Half loaf", "Slice"]);

  // A recipe's "Whole recipe" row weighs its ingredients as they change.
  const res = await request.post("/api/recipes", {
    data: {
      name: `Toast ${tag}`,
      cooked_g: null,
      items: [{ food_id: f.id, grams: 200 }],
    },
  });
  expect(res.ok()).toBeTruthy();
  const recipe = await res.json();
  await page.goto(`/#/recipe/${recipe.id}`);
  const whole = rows.filter({ hasText: "Whole recipe" });
  await expect(whole).toHaveCount(1);
  await expect(whole).toContainText(/200\s*g/u);
  await page.getByLabel(`Loaf ${tag} quantity`).fill("300");
  await expect(whole).toContainText(/300\s*g/u);
  // Its name is fixed: no field to rename or remove it.
  await expect(whole.getByRole("textbox")).toHaveCount(0);
  await expect(
    whole.getByRole("button", { name: "Remove serving" }),
  ).toHaveCount(0);
});

test("a search with no match offers the new food, then back to logging", async ({
  page,
}, testInfo) => {
  const { day, tag } = unique(123, testInfo);
  const q = `Quince paste ${tag}`;
  await page.goto(`/#/add/${day}/Planned`);
  await page.getByLabel("Search foods").fill(q);
  await page.getByRole("link", { name: `New food “${q}”` }).click();
  await expect(page.getByRole("heading", { name: "New food" })).toBeVisible();
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue(q);
  await page.getByLabel("Energy (kcal)").fill("280");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#/log/${day}/Planned/\\d+$`, "u"));
  await expect(page.getByRole("heading", { name: q })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Add to Planned" }),
  ).toBeVisible();
});

test("a recipe draft comes back only on the return from its ingredient", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(124, testInfo);
  await food(request, { name: `Draft rice ${tag}`, per100: { energy: 350 } });
  const name = page.getByLabel("Name", { exact: true });
  const grams = page.getByLabel(`Draft rice ${tag} quantity`);
  const start = async () => {
    await page.goto("/#/recipe/new");
    // Not the restored draft still showing from before.
    await expect(page.getByText("Your unsaved changes are back")).toHaveCount(
      0,
    );
    await name.fill(`Pilaf ${tag}`);
    await page.getByLabel("Search foods to add").fill(`Draft rice ${tag}`);
    await page
      .getByRole("button", { name: starts(`Draft rice ${tag}`) })
      .click();
    await grams.fill("150");
    await page.getByRole("button", { name: `Edit Draft rice ${tag}` }).click();
    await expect(
      page.getByRole("heading", { name: `Draft rice ${tag}` }),
    ).toBeVisible();
  };

  // Back from the food: the unsaved recipe is restored.
  await start();
  await page.getByRole("link", { name: "Back" }).click();
  await expect(page).toHaveURL(/#\/recipe\/new\?draft=1$/u);
  await expect(page.getByText("Your unsaved changes are back")).toBeVisible();
  await expect(name).toHaveValue(`Pilaf ${tag}`);
  await expect(grams).toHaveValue("150");
  // Restored but still unsaved: leaving asks, as it did before.
  const foodsTab = page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Foods" });
  await foodsTab.click();
  expect(await answer(page, "Stay")).toBe("Leave without saving?");
  await expect(name).toHaveValue(`Pilaf ${tag}`);
  await foodsTab.click();
  await answer(page, "Leave");
  await expect(page).toHaveURL(/#\/foods$/u);

  // Opening a new recipe afresh (not that return) starts empty.
  await start();
  await page.goto("/#/recipe/new");
  await expect(page.getByRole("heading", { name: "New recipe" })).toBeVisible();
  await expect(name).toHaveValue("");
  await expect(grams).toHaveCount(0);
  await expect(page.getByText("Your unsaved changes are back")).toHaveCount(0);
});

test("editing what you log is a header action", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag } = unique(190, testInfo);
  const f = await food(request, { name: `Bun ${tag}` });
  const meal = await (
    await request.post("/api/meals", {
      data: { name: `Lunch ${tag}`, items: [{ food_id: f.id, grams: 100 }] },
    })
  ).json();
  for (const [url, name] of [
    [`/#/log/${day}/Eaten/${f.id}`, "Edit food"],
    [`/#/log-meal/${day}/Eaten/${meal.id}`, "Edit meal"],
    [`/#/log/${f.id}`, "Edit food"],
    [`/#/log-meal/${meal.id}`, "Edit meal"],
  ]) {
    await page.goto(url);
    const edit = page.locator("header.title").getByRole("link", { name });
    await expect(edit).toBeVisible();
    const box = await edit.boundingBox();
    expect(box.height).toBeGreaterThanOrEqual(44);
    // A pencil in the title's row, not a word on a row of its own.
    await expect(edit).toHaveText("");
    const back = await page
      .locator("header.title")
      .getByRole("link", { name: "Back" })
      .boundingBox();
    expect(Math.abs(box.y - back.y)).toBeLessThan(2);
  }
});

test("the foods tab lists your recipes and foods, never logged ones too", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(803, testInfo);
  // "0 …": first by name among every test's foods.
  const rice = await food(request, {
    name: `0 Rice ${tag}`,
    per100: { energy: 130 },
  });
  const res = await request.post("/api/recipes", {
    data: {
      name: `0 Bowl ${tag}`,
      items: [{ food_id: rice.id, grams: 200 }],
    },
  });
  expect(res.ok()).toBeTruthy();
  const archived = await food(request, { name: `0 Old ${tag}` });
  await request.put(`/api/foods/${archived.id}`, {
    data: { ...archived, archived: true },
  });
  await page.goto("/#/foods");
  const section = (name) =>
    page.locator(".finder-section", {
      has: page.getByRole("heading", { name, exact: true }),
    });
  await expect(page.locator(".finder-section h2")).toHaveText([
    "Favourites",
    "Recent",
    "Meals",
    "Your recipes",
    "Your foods",
  ]);
  await expect(
    section("Your recipes").getByRole("button", {
      name: starts(`0 Bowl ${tag}`),
    }),
  ).toBeVisible();
  const foods = section("Your foods");
  await expect(
    foods.getByRole("button", { name: starts(`0 Rice ${tag}`) }),
  ).toBeVisible();
  await expect(
    foods.getByRole("button", { name: starts(`0 Old ${tag}`) }),
  ).toHaveCount(0);
  // Water is the app's, not a food you made.
  const { food: water } = await (
    await request.get("/api/profiles/1/water-food")
  ).json();
  await expect(
    foods
      .locator(".name")
      .filter({ hasText: new RegExp(`^${water.name}$`, "u") }),
    "the water food isn't listed",
  ).toHaveCount(0);
  // The same row as Recent: it opens the log screen.
  await foods.getByRole("button", { name: starts(`0 Rice ${tag}`) }).click();
  await expect(
    page.getByRole("heading", { name: `0 Rice ${tag}` }),
  ).toBeVisible();
});

test("logging a food or meal: an Amount, a time, one context line", async ({
  page,
  request,
}, testInfo) => {
  const { tag, day } = unique(805, testInfo);
  const pid = await ownProfile(page, request, `Context ${tag}`);
  const bread = await food(request, {
    name: `Rye ${tag}`,
    brand: `Fazer ${tag}`,
    per100: { energy: 220 },
    servings: [{ label: "Slice", grams: 35 }],
  });
  const made = await request.post("/api/meals", {
    data: {
      name: `Lunch ${tag}`,
      items: [{ food_id: bread.id, grams: 70 }],
    },
  });
  expect(made.ok()).toBeTruthy();
  const logged = async () =>
    (await (await request.get(`/api/profiles/${pid}/day/${day}`)).json()).groups
      .flatMap((g) => g.entries)
      .map((e) => [e.name, e.time]);

  await page.goto(`/#/add/${day}/Eaten`);
  await page.getByLabel("Search foods").fill(`Rye ${tag}`);
  await page.getByRole("button", { name: starts(`Rye ${tag}`) }).click();
  await expect(
    page.locator("form.log").getByText("Amount", { exact: true }),
  ).toBeVisible();
  await expect(page.locator("main p.muted").first()).toHaveText(
    new RegExp(` · Eaten · Fazer ${tag}$`, "u"),
  );
  await page.getByLabel("Time eaten").fill("07:30");
  await page.getByRole("button", { name: "Add to Eaten" }).click();
  await expect(page).toHaveURL(new RegExp(`#/day/${day}$`, "u"));
  expect(await logged()).toEqual([[`Rye ${tag}`, "07:30"]]);

  await page.goto(`/#/add/${day}/Eaten`);
  await page.getByLabel("Search foods").fill(`Lunch ${tag}`);
  await page.getByRole("link", { name: starts(`Lunch ${tag}`) }).click();
  await expect(
    page.locator("form.log").getByText("Amount", { exact: true }),
  ).toBeVisible();
  await expect(page.locator("section > p.muted").first()).toHaveText(
    / · Eaten$/u,
  );
  await page.getByRole("button", { name: "Add to Eaten" }).click();
  await expect(page).toHaveURL(new RegExp(`#/day/${day}$`, "u"));
  // Without a time, none is sent.
  expect(await logged()).toContainEqual([`Rye ${tag}`, null]);
});

test("a recipe that makes portions logs one portion by default", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(806, testInfo);
  const rice = await food(request, {
    name: `Portion rice ${tag}`,
    per100: { energy: 130 },
  });
  const recipe = await (
    await request.post("/api/recipes", {
      data: {
        name: `Pilaf ${tag}`,
        makes: 2,
        items: [{ food_id: rice.id, grams: 600 }],
      },
    })
  ).json();
  await page.goto("/#/foods");
  await page.getByLabel("Search foods").fill(`Pilaf ${tag}`);
  await page.getByRole("button", { name: starts(`Pilaf ${tag}`) }).click();
  const unit = page.getByLabel("Unit");
  await expect(unit.locator("option:checked")).toHaveText(
    /^Portion \(300\sg\)/u,
  );
  expect(recipe.servings.map((s) => s.label)).toContain("Portion");
});

test("entry amounts are written like every other number", async ({
  page,
  request,
}, testInfo) => {
  const { tag, day } = unique(807, testInfo);
  const pid = await ownProfile(page, request, `Amounts ${tag}`);
  const milk = await food(request, {
    name: `Amount milk ${tag}`,
    per100: { energy: 40 },
    servings: [{ label: "Cup", grams: 150 }],
  });
  for (const body of [{ grams: 1000 }, { serving: "Cup", quantity: 1.5 }])
    expect(
      (
        await request.post(`/api/profiles/${pid}/entries`, {
          data: { day, group: "Eaten", food_id: milk.id, ...body },
        })
      ).ok(),
    ).toBeTruthy();
  await page.goto(`/#/day/${day}`);
  // Grouped digits and a no-break space before the unit, as this device
  // writes numbers (the server's text says "1000 g").
  await expect(page.locator(".entry .muted")).toHaveText([
    "1,000 g",
    "1.5 × Cup (225 g)",
  ]);
});

test("the search field's placeholder fits at 320 px", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto("/#/foods");
  const [text, room] = await page.getByLabel("Search foods").evaluate((el) => {
    const css = getComputedStyle(el);
    const ctx = document.createElement("canvas").getContext("2d");
    ctx.font = `${css.fontWeight} ${css.fontSize} ${css.fontFamily}`;
    return [
      ctx.measureText(el.placeholder).width,
      el.clientWidth -
        parseFloat(css.paddingLeft) -
        parseFloat(css.paddingRight),
    ];
  });
  // Beside the room a search field keeps for its clear button (about 1.5em).
  expect(text + 24).toBeLessThanOrEqual(room);
});

// A food taken by the tablet, as the owner's multivitamin is.
const tablet = (request, tag) =>
  food(request, {
    name: `Monivitamiini appelsiini poretabletti ${tag}`,
    per100: { energy: 20 },
    servings: [{ label: "poretabletti", grams: 4.3 }],
  });

// The item row of `name` in a recipe or meal editor: its quantity, unit and
// weight.
const itemRow = (page, name) => ({
  row: page.locator(".items li", { hasText: name }),
  quantity: page.getByLabel(`${name} quantity`),
  unit: page.getByLabel(`${name} unit`).locator("option:checked"),
  weight: page.locator(".items li", { hasText: name }).locator(".weight"),
});

for (const [kind, slot] of [
  ["recipe", 870],
  ["meal", 871],
]) {
  test(`a ${kind} item is a count of its food's serving, kept as chosen`, async ({
    page,
    request,
  }, testInfo) => {
    const { tag } = unique(slot, testInfo);
    const f = await tablet(request, tag);
    await page.goto(`/#/${kind}/new`);
    await page.getByLabel("Name", { exact: true }).fill(`Morning ${tag}`);
    await page.getByLabel("Search foods to add").fill(f.name);
    await page.getByRole("button", { name: starts(f.name) }).click();
    const item = itemRow(page, f.name);
    await expect(item.quantity).toHaveValue("1");
    await expect(item.unit).toHaveText("poretabletti (4.3 g)");
    await expect(item.weight).toHaveText("4.3 g");

    // Two: the weight and the totals follow.
    await item.quantity.fill("2");
    await expect(item.weight).toHaveText("8.6 g");
    await expect(page.locator(".nutrition-panel")).toContainText(/8\.6\sg/u);
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.locator("#toast")).toContainText(`Saved Morning ${tag}`);

    // Stored as chosen, and shown so again.
    await expect(page).toHaveURL(new RegExp(`#/${kind}/\\d+$`, "u"));
    const id = page.url().split("/").pop();
    const one = await (await request.get(`/api/${kind}s/${id}`)).json();
    expect(one.items[0]).toMatchObject({
      grams: 8.6,
      serving: "poretabletti",
      quantity: 2,
    });
    await page.reload();
    await expect(item.quantity).toHaveValue("2");
    await expect(item.unit).toHaveText("poretabletti (4.3 g)");
    await expect(item.weight).toHaveText("8.6 g");
  });
}

test("item rows fit 320 px", async ({ page, request }, testInfo) => {
  const { tag } = unique(872, testInfo);
  const f = await tablet(request, tag);
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto("/#/recipe/new");
  await page.getByLabel("Search foods to add").fill(f.name);
  await page.getByRole("button", { name: starts(f.name) }).click();
  const { row } = itemRow(page, f.name);
  await expect(row).toBeVisible();
  for (const el of await row.locator("input, select, button").all()) {
    const box = await el.boundingBox();
    expect(box.x + box.width).toBeLessThanOrEqual(320);
  }
  await expectFits(page);
  await page.screenshot({ path: testInfo.outputPath("item-320.png") });
});

// Back from an ingredient's food, its new serving is offered, and every
// unsaved edit is still there: in a recipe and in a meal.
for (const [kind, slot] of [
  ["recipe", 931],
  ["meal", 932],
])
  test(`a ${kind}'s ingredient offers the serving just added to its food`, async ({
    page,
    request,
  }, testInfo) => {
    const { tag } = unique(slot, testInfo);
    const whey = await food(request, {
      name: `Fresh whey ${tag}`,
      per100: { energy: 380 },
      servings: [{ label: "Scoop", grams: 37 }],
    });
    await food(request, { name: `Fresh oats ${tag}`, per100: { energy: 370 } });
    await page.goto(`/#/${kind}/new`);
    await page.getByLabel("Name").fill(`Fresh ${kind} ${tag}`);
    for (const f of [`Fresh whey ${tag}`, `Fresh oats ${tag}`]) {
      await page.getByLabel("Search foods to add").fill(f);
      await page.getByRole("button", { name: starts(f) }).click();
    }
    await page.getByLabel(`Fresh whey ${tag} quantity`).fill("2");
    await page.getByLabel(`Fresh oats ${tag} quantity`).fill("150");

    await page.getByRole("button", { name: `Edit Fresh whey ${tag}` }).click();
    await expect(page).toHaveURL(new RegExp(`#/food/${whey.id}\\?back=`, "u"));
    await page.getByRole("button", { name: "+ Serving" }).click();
    await page.getByLabel("Serving name").last().fill("Big scoop");
    await page.getByLabel("Serving grams").last().fill("45");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page).toHaveURL(new RegExp(`#/${kind}/new\\?draft=1$`, "u"));

    const unit = page.getByLabel(`Fresh whey ${tag} unit`);
    await expect(unit.locator("option")).toHaveText([
      "Scoop (37 g)",
      "Big scoop (45 g)",
      "g",
    ]);
    // Unsaved edits kept: name, each row's quantity and unit.
    await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
      `Fresh ${kind} ${tag}`,
    );
    await expect(unit.locator("option:checked")).toHaveText("Scoop (37 g)");
    await expect(page.getByLabel(`Fresh whey ${tag} quantity`)).toHaveValue(
      "2",
    );
    await expect(page.getByLabel(`Fresh oats ${tag} quantity`)).toHaveValue(
      "150",
    );
    await unit.selectOption({ label: "Big scoop (45 g)" });
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.locator("#toast")).toContainText(`Saved Fresh ${kind}`);
    await expect(page).toHaveURL(new RegExp(`#/${kind}/\\d+$`, "u"));
    const id = page.url().split("/").at(-1);
    const { items } = await (await request.get(`/api/${kind}s/${id}`)).json();
    expect(items.find((i) => i.food_id === whey.id)).toMatchObject({
      serving: "Big scoop",
      quantity: 2,
    });
  });

// While a recipe makes portions, one Portion is its default (unless a
// serving of your own leads): its editor says so, and picking it as an
// ingredient of a recipe or a meal starts there, as logging it does.
test("a recipe with portions defaults to one portion everywhere", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(933, testInfo);
  const rice = await food(request, {
    name: `Portion base ${tag}`,
    per100: { energy: 130 },
  });
  const items = [{ food_id: rice.id, grams: 600 }];
  const pilaf = await (
    await request.post("/api/recipes", {
      data: { name: `Portioned pilaf ${tag}`, makes: 3, items },
    })
  ).json();
  await request.post("/api/recipes", {
    data: {
      name: `Bowled stew ${tag}`,
      makes: 3,
      items,
      servings: [
        { label: "Bowl", grams: 250 },
        { label: "Whole recipe", grams: 1 },
      ],
    },
  });
  const servingRows = page.locator(".servings .serving:visible");

  await page.goto(`/#/recipe/${pilaf.id}`);
  await expect(servingRows.first()).toContainText(
    /Portion\s*200\s*g\s*Default/u,
  );
  await expect(
    page.getByRole("button", { name: "Make Whole recipe the default" }),
  ).toHaveCount(0);

  // A new recipe: its Portion leads as soon as it makes some.
  await page.goto("/#/recipe/new");
  await page.getByLabel("Search foods to add").fill(`Portion base ${tag}`);
  await page
    .getByRole("button", { name: starts(`Portion base ${tag}`) })
    .click();
  await page.getByLabel(`Portion base ${tag} quantity`).fill("400");
  await page.getByLabel("Makes (portions)").fill("2");
  await expect(servingRows.first()).toContainText(
    /Portion\s*200\s*g\s*Default/u,
  );
  await page.getByLabel("Makes (portions)").fill("");
  await expect(servingRows.first()).toContainText(
    /Whole recipe\s*400\s*g\s*Default/u,
  );
  await page
    .getByRole("button", { name: `Remove Portion base ${tag}` })
    .click();

  for (const kind of ["recipe", "meal"]) {
    if (kind === "meal") {
      await page.goto(`/#/${kind}/new`);
      await answer(page, "Leave");
    }
    const unit = (name) =>
      page.getByLabel(`${name} ${tag} unit`).locator("option:checked");
    for (const name of ["Portioned pilaf", "Bowled stew"]) {
      await page.getByLabel("Search foods to add").fill(`${name} ${tag}`);
      await page
        .getByRole("button", { name: starts(`${name} ${tag}`) })
        .click();
      await expect(page.getByLabel(`${name} ${tag} quantity`)).toHaveValue("1");
    }
    await expect(unit("Portioned pilaf")).toHaveText(/^Portion \(200\sg\)/u);
    // Your own default leads.
    await expect(unit("Bowled stew")).toHaveText(/^Bowl \(250\sg\)/u);
  }
});

// What a recipe copy shares: everything but its id, name and revision.
const shared = ({ id: _id, name: _name, rev: _rev, ...rest }) => rest;

// Copy: a new recipe like this one, opened to be altered; the original
// stays as it was.
test("a recipe can be copied and the copy changed on its own", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(935, testInfo);
  const oats = await food(request, {
    name: `Copy oats ${tag}`,
    per100: { energy: 370 },
    servings: [{ label: "Cup", grams: 80 }],
  });
  const milk = await food(request, {
    name: `Copy milk ${tag}`,
    per100: { energy: 40 },
  });
  const original = await (
    await request.post("/api/recipes", {
      data: {
        name: `Copy porridge ${tag}`,
        cooked_g: 500,
        makes: 2,
        items: [
          { food_id: oats.id, serving: "Cup", quantity: 1.5 },
          { food_id: milk.id, grams: 300 },
        ],
        servings: [
          { label: "Bowl", grams: 250 },
          { label: "Whole recipe", grams: 1 },
        ],
        notes: "Boil.\nStir.",
        category: "sweets_snacks",
      },
    })
  ).json();

  await page.goto(`/#/recipe/${original.id}`);
  await page.getByRole("button", { name: "Copy", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: `Copy porridge ${tag} (copy)` }),
  ).toBeVisible();
  await expect(page).not.toHaveURL(new RegExp(`#/recipe/${original.id}$`, "u"));
  const copyId = page.url().split("/").at(-1);
  const copy = await (await request.get(`/api/recipes/${copyId}`)).json();
  expect(copy.name).toBe(`Copy porridge ${tag} (copy)`);
  expect(shared(copy)).toEqual(shared(original));

  // The copy changed: the original isn't.
  await page.getByLabel("Name", { exact: true }).fill(`Copy gruel ${tag}`);
  await page.getByLabel(`Copy oats ${tag} quantity`).fill("2");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.locator("#toast")).toContainText(`Saved Copy gruel ${tag}`);
  const changed = await (await request.get(`/api/recipes/${copyId}`)).json();
  expect(changed.items[0]).toMatchObject({ serving: "Cup", quantity: 2 });
  expect(
    await (await request.get(`/api/recipes/${original.id}`)).json(),
  ).toEqual(original);
});

// Changing what's logged or used asks first, saying what changes and what
// doesn't; Cancel keeps it as it was. Saved, the past diary follows.
test("changing a logged food's values asks first, then the diary follows", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag } = unique(936, testInfo);
  const f = await food(request, {
    name: `Used jam ${tag}`,
    per100: { energy: 250 },
  });
  for (const grams of [20, 30])
    await entry(request, { day, group: "Eaten", food_id: f.id, grams });
  await request.post("/api/recipes", {
    data: { name: `Jam tart ${tag}`, items: [{ food_id: f.id, grams: 100 }] },
  });
  const energy = async () =>
    (await (await request.get(`/api/foods/${f.id}`)).json()).per100.energy;

  await page.goto(`/#/day/${day}`);
  await expect(headline(page)).toHaveText(/^125\skcal$/u);
  await page.goto(`/#/food/${f.id}`);
  await page.getByLabel("Energy (kcal)").fill("260");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("dialog")).toContainText(
    "Logged 2 times and used in 1 recipe. Diary entries with this food follow its values. The 1 recipe will use the new values.",
  );
  expect(await answer(page, "Cancel")).toBe(`Save changes to Used jam ${tag}?`);
  expect(await energy()).toBe(250);

  await page.getByRole("button", { name: "Save" }).click();
  await answer(page, "Save");
  await expect(page.locator("#toast")).toContainText(
    `Saved Used jam ${tag} · 2 diary entries updated`,
  );
  expect(await energy()).toBe(260);
  await page.goto(`/#/day/${day}`);
  await expect(headline(page)).toHaveText(/^130\skcal$/u);
});

test("a change that touches nothing used saves without asking", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag } = unique(937, testInfo);
  const unused = await food(request, {
    name: `Fresh jam ${tag}`,
    per100: { energy: 250 },
  });
  const logged = await food(request, {
    name: `Logged jam ${tag}`,
    per100: { energy: 250 },
  });
  await entry(request, {
    day,
    group: "Eaten",
    food_id: logged.id,
    grams: 20,
  });

  // Unused: its values change without a word.
  await page.goto(`/#/food/${unused.id}`);
  await page.getByLabel("Energy (kcal)").fill("260");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.locator("#toast")).toContainText(`Saved Fresh jam ${tag}`);

  // Logged, but only a new name and a serving added: diary entries take
  // the new name (ADR 0006), their values stay, and nothing uses the new
  // serving.
  await page.goto(`/#/food/${logged.id}`);
  // Same screen, another food: until it has loaded, the jam just saved is
  // still shown (inert, but a fill reaches it), so wait for this one.
  const name = page.getByLabel("Name", { exact: true });
  await expect(name).toHaveValue(`Logged jam ${tag}`);
  await name.fill(`Logged jam 2 ${tag}`);
  await page.getByRole("button", { name: "+ Serving" }).click();
  await page.getByLabel("Serving name").fill("Spoon");
  await page.getByLabel("Serving grams").fill("15");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.locator("#toast")).toContainText(
    `Saved Logged jam 2 ${tag}`,
  );
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("archiving a logged food asks first", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag } = unique(938, testInfo);
  const f = await food(request, { name: `Old jam ${tag}` });
  await entry(request, { day, group: "Eaten", food_id: f.id, grams: 20 });

  await page.goto(`/#/food/${f.id}`);
  await page.getByRole("button", { name: "Archive", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText(
    "Logged 1 time. Archiving hides it from search; your diary, recipes and meals keep it.",
  );
  expect(await answer(page, "Cancel")).toBe(`Archive Old jam ${tag}?`);
  await page.getByRole("button", { name: "Archive", exact: true }).click();
  await answer(page, "Archive");
  await expect(page.getByText("Archived: hidden from search.")).toBeVisible();
  // Unarchiving asks nothing.
  await page.getByRole("button", { name: "Unarchive", exact: true }).click();
  await expect(page.locator("#toast")).toContainText(
    `Unarchived Old jam ${tag}`,
  );
});

test("changing a recipe a meal uses says the meal follows", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(939, testInfo);
  const oats = await food(request, {
    name: `Meal oats ${tag}`,
    per100: { energy: 370 },
  });
  const porridge = await (
    await request.post("/api/recipes", {
      data: {
        name: `Meal porridge ${tag}`,
        items: [{ food_id: oats.id, grams: 100 }],
      },
    })
  ).json();
  await request.post("/api/meals", {
    data: {
      name: `Breakfast ${tag}`,
      items: [{ food_id: porridge.id, grams: 200 }],
    },
  });

  await page.goto(`/#/recipe/${porridge.id}`);
  await page.getByLabel(`Meal oats ${tag} quantity`).fill("150");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("dialog")).toContainText(
    "Used in 1 meal. The 1 meal will use the new values. To leave it as it is, Cancel and use Copy: it saves your changes as a new recipe.",
  );
  await answer(page, "Save");
  await expect(page.locator("#toast")).toContainText(
    `Saved Meal porridge ${tag}`,
  );
});

// --------------------------------------------------------- health cues

// The health cues of the nutrition panel on screen.
const health = (page) => page.locator(".nutrition-panel .health");
// Open the "What 100 kcal gives" fold.
const openDensity = (page) =>
  page.locator(".density summary", { hasText: "What 100 kcal gives" }).click();

test("health cues follow the food editor's values", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(560, testInfo);
  await ownProfile(page, request, `Cues food ${tag}`);
  await page.goto("/#/food/new");
  await page.getByLabel("Name").fill(`Cue crisps ${tag}`);
  await page.getByLabel("Energy (kcal)", { exact: true }).fill("50");
  await page.getByLabel("Fat (g)", { exact: true }).fill("20");
  await page.getByLabel("Saturated fat (g)", { exact: true }).fill("2");
  await page.getByLabel("Protein (g)", { exact: true }).fill("2");
  await page.getByLabel("Carbs (g)", { exact: true }).fill("5");
  await page.locator("form summary", { hasText: "Other nutrients" }).click();
  await page.getByLabel("Vitamin C (mg)", { exact: true }).fill("50");
  await page.getByLabel("Salt (g)", { exact: true }).fill("1");
  // No serving yet: the cues show, the table doesn't.
  await expect(health(page)).toContainText("Per 100 g");
  await expect(health(page)).toContainText("Fat high");
  await expect(health(page)).toContainText("Sat. fat medium");
  await expect(health(page)).toContainText("Sugars –");
  await expect(health(page)).toContainText("Salt medium");
  await expect(health(page).locator(".sr-only")).toHaveText(
    "Per 100 g: fat high, sat. fat medium, sugars not given, salt medium",
  );
  await expect(page.locator(".nutrition-panel table").first()).toBeHidden();
  // 8 + 20 + 180 kcal: the split of what the parts add up to.
  await expect(health(page)).toContainText(
    /Protein\s4\s%\s·\sCarbs\s10\s%\s·\sFat\s87\s%/u,
  );
  // Repaints as typed.
  await page.getByLabel("Fat (g)", { exact: true }).fill("1");
  await expect(health(page)).toContainText("Fat low");
  // Per 100 kcal against the profile's targets: vitamin C 100 mg of 95 mg,
  // and salt (2.5 g of 5 g) as a caution.
  await expect(page.locator(".nutrition-panel")).toContainText(
    /Per 100\skcal: 40\s% of your salt limit/u,
  );
  await openDensity(page);
  await expect(page.locator(".density .tiles")).toContainText(
    /105\s%\s*of your vitamin C/u,
  );
});

test("recipe health cues follow its ingredients", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(561, testInfo);
  await food(request, {
    name: `Cue syrup ${tag}`,
    per100: { energy: 400, net_carbs: 100, sugars: 100, fat: 0 },
  });
  await food(request, {
    name: `Cue water ${tag}`,
    per100: { energy: 0, fat: 0, sugars: 0, sodium: 0 },
  });
  await page.goto("/#/recipe/new");
  await page.getByLabel("Name").fill(`Cue squash ${tag}`);
  const add = async (name, grams) => {
    await page.getByLabel("Search foods to add").fill(name);
    await page.getByRole("button", { name: starts(name) }).click();
    await page.getByLabel(`${name} quantity`).fill(grams);
  };
  await add(`Cue syrup ${tag}`, "100");
  await expect(health(page)).toContainText("Sugars high");
  await add(`Cue water ${tag}`, "100");
  // 100 g sugars in 200 g: still high; in 2000 g, 5 g per 100 g: low.
  await expect(health(page)).toContainText("Sugars high");
  await page.getByLabel(`Cue water ${tag} quantity`).fill("1900");
  await expect(health(page)).toContainText("Sugars low");
  await expect(health(page)).toContainText("Per 100 g");
  // A sugary drink goes by the drinks' table: 5 g is medium. A recipe is
  // weighed: its values stay per 100 g.
  await page.getByLabel("Category").selectOption("sugary_drinks");
  await expect(health(page)).toContainText("Per 100 g");
  await expect(health(page)).toContainText("Sugars medium");
});

test("meal health cues come from its items", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(562, testInfo);
  // Fat 17 g per 100 g is medium; 124 g of it holds 21.08 g, past a
  // portion's 21 g.
  const fatty = await food(request, {
    name: `Cue pastry ${tag}`,
    per100: { energy: 400, fat: 17, protein: 5, net_carbs: 40 },
  });
  const made = await request.post("/api/meals", {
    data: {
      name: `Cue brunch ${tag}`,
      items: [{ food_id: fatty.id, grams: 124 }],
    },
  });
  expect(made.ok()).toBeTruthy();
  const meal = await made.json();

  await page.goto(`/#/meal/${meal.id}`);
  await expect(health(page)).toContainText("Fat high in this amount");
  await page.getByLabel(`Cue pastry ${tag} quantity`).fill("100");
  await expect(health(page)).toContainText("Fat medium");
  await page.getByLabel(`Cue pastry ${tag} quantity`).fill("124");
  await expect(health(page)).toContainText("Fat high in this amount");

  // The finder's meal row: tagged per 100 g, no portion, so no "High fat".
  await page.goto("/#/foods");
  await page.getByLabel("Search foods").fill(`Cue brunch ${tag}`);
  const row = page.getByRole("link", { name: starts(`Cue brunch ${tag}`) });
  await expect(row).toBeVisible();
  await expect(row.locator(".light")).toHaveCount(0);

  // Logging: the portions field sets the amount.
  await page.goto(`/#/log-meal/${meal.id}`);
  await expect(health(page)).toContainText("Fat high in this amount");
  await page.getByLabel("Portions").fill("0.9");
  await expect(health(page)).toContainText("Fat medium");
});

test("log screen shows health cues and density against the profile's targets", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(563, testInfo);
  await ownProfile(page, request, `Cues log ${tag}`);
  const orange = await food(request, {
    name: `Cue orange ${tag}`,
    per100: {
      energy: 50,
      protein: 1,
      net_carbs: 10,
      fat: 0.1,
      sugars: 9,
      saturated: 0,
      sodium: 0,
      vitamin_c: 50,
    },
  });
  await page.goto(`/#/log/${orange.id}`);
  await expect(health(page)).toContainText("Sugars medium");
  await expect(health(page)).toContainText("Salt low");
  await expect(health(page)).toContainText(/Carbs\s89\s%/u);
  await openDensity(page);
  await expect(page.locator(".density")).toContainText(
    /A day's share of 100\skcal is \d+(\.\d+)?\s%/u,
  );
  await expect(page.locator(".density .tiles")).toContainText(
    /105\s%\s*of your vitamin C/u,
  );

  // A profile without targets is offered them instead.
  const bare = await newProfile(request, {
    name: `Cues bare ${tag}`,
    weight_kg: null,
  });
  await page.addInitScript(
    (pid) => localStorage.setItem("profile", String(pid)),
    bare.id,
  );
  await page.goto(`/#/log/${orange.id}`);
  await page.reload();
  await expect(health(page)).toContainText("Sugars medium");
  await expect(page.locator(".nutrition-panel")).toContainText(
    "Set targets to see what this gives you",
  );
  await expect(page.locator(".density .tiles")).toHaveCount(0);
});

test("search rows show only the verdict; positive sublabels filter the search from the Filters panel", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(564, testInfo);
  // Every red and high protein: Unhealthy, its negatives first.
  await food(request, {
    name: `Cue bacon ${tag}`,
    per100: {
      energy: 500,
      protein: 30,
      fat: 30,
      saturated: 10,
      sugars: 30,
      sodium: 800,
    },
  });
  // Healthy: high protein, low fat, saturates, sugar and salt.
  await food(request, {
    name: `Cue chicken ${tag}`,
    per100: {
      energy: 110,
      protein: 23,
      fat: 1.5,
      saturated: 0.4,
      sugars: 0,
      sodium: 60,
    },
  });
  // Healthy: high protein and fibre, and the lows.
  await food(request, {
    name: `Cue lentils ${tag}`,
    per100: {
      energy: 116,
      protein: 9,
      fiber: 8,
      fat: 0.4,
      saturated: 0.1,
      sugars: 1.8,
      sodium: 2,
    },
  });
  // Neither: no label.
  await food(request, {
    name: `Cue plain ${tag}`,
    per100: { energy: 200, protein: 5, fat: 10 },
  });
  await page.goto("/#/foods");
  await page.getByLabel("Search foods").fill(`Cue ${tag}`);
  const row = (name) =>
    page.getByRole("button", { name: starts(`Cue ${name} ${tag}`) });
  // Owner (2026-10-14): a row shows the verdict only; sublabels filter.
  await expect(row("bacon").locator(".light")).toHaveText(["Unhealthy"]);
  await expect(row("chicken").locator(".light")).toHaveText(["Healthy"]);
  await expect(row("lentils").locator(".light")).toHaveText(["Healthy"]);
  await expect(row("plain")).toBeVisible();
  await expect(row("plain").locator(".light")).toHaveCount(0);

  // The filters: every positive sublabel in the Filters panel, none on
  // the search's own view; vitamins and minerals behind a chip of their
  // own.
  const labels = page.getByRole("group", { name: "Labels" });
  await expect(labels).toBeHidden();
  await expect(page.locator(".finder > .chips")).toHaveCount(0);
  await page.getByRole("button", { name: /^Filters/u }).click();
  await expect(
    page.locator(".filters.card").getByRole("group", { name: "Labels" }),
  ).toBeVisible();
  await expect(labels.getByRole("button")).toHaveText([
    "High protein",
    "Source of protein",
    "High fibre",
    "Source of fibre",
    "Low calorie",
    "Low fat",
    "Low sat. fat",
    "Low sugar",
    "Low salt",
    "Source of omega-3",
    "Vitamins & minerals",
  ]);
  const vitamins = page.getByRole("button", { name: "Vitamins & minerals" });
  await expect(vitamins).toHaveAttribute("aria-expanded", "false");
  await vitamins.click();
  await expect(vitamins).toHaveAttribute("aria-expanded", "true");
  const more = page.getByRole("group", { name: "Vitamins & minerals" });
  await expect(more.getByRole("button").first()).toHaveText("High vitamin A");
  await expect(
    more.getByRole("button", { name: "Source of vitamin C", exact: true }),
  ).toBeVisible();
  await vitamins.click();
  await expect(more).toBeHidden();

  // "High protein" keeps the foods that are, a red or not.
  const chip = page.getByRole("button", { name: "High protein", exact: true });
  await expect(chip).toHaveAttribute("aria-pressed", "false");
  await chip.click();
  await expect(chip).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("button", { name: /^Filters · 1/u }),
  ).toBeVisible();
  await expect(row("bacon")).toBeVisible();
  await expect(row("chicken")).toBeVisible();
  await expect(row("lentils")).toBeVisible();
  await expect(row("plain")).toHaveCount(0);
  // With "High fibre" too: both must hold.
  await page.getByRole("button", { name: "High fibre", exact: true }).click();
  await expect(row("lentils")).toBeVisible();
  await expect(row("chicken")).toHaveCount(0);
  await expect(row("bacon")).toHaveCount(0);
  // Kept across visits, cleared with the other filters.
  await page.reload();
  await page.getByLabel("Search foods").fill(`Cue ${tag}`);
  await expect(row("lentils")).toBeVisible();
  await expect(row("chicken")).toHaveCount(0);
  await page.getByRole("button", { name: /^Filters/u }).click();
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(chip).toHaveAttribute("aria-pressed", "false");
  await expect(row("plain")).toBeVisible();

  // A saved filter of a label that isn't a filter is dropped on load.
  await page.evaluate(() =>
    localStorage.setItem(
      "food-filters",
      JSON.stringify({ tags: ["healthy", "high_fat", "high_protein"] }),
    ),
  );
  await page.reload();
  await page.getByLabel("Search foods").fill(`Cue ${tag}`);
  await page.getByRole("button", { name: /^Filters/u }).click();
  await expect(chip).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("button", { name: /^Filters · 1/u }),
  ).toBeVisible();
  await expect(row("chicken")).toBeVisible();
  await expect(row("plain")).toHaveCount(0);

  // The food's own view: the verdict alone (the panel's
  // lights and split say the rest).
  await row("chicken").click();
  const own = page.locator(".lights.labels .light");
  await expect(own).toHaveText(["Healthy"]);
  await page.goBack();
  await page.getByLabel("Search foods").fill(`Cue ${tag}`);
  await row("bacon").click();
  await expect(own).toHaveText(["Unhealthy"]);
});

// The owner's fermented pickles (ADR 0033): salty, but vegetables, so
// OK, not Unhealthy; the food view says why and what a slice holds.
test("pickles read OK, and the food view says why", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(1157, testInfo);
  const res = await request.post("/api/foods", {
    data: {
      name: `Pickles ${tag}`,
      category: "fruit_veg",
      per100: {
        energy: 12,
        sugars: 0,
        fat: 0.1,
        saturated: 0,
        protein: 1,
        sodium: 1200,
      },
      servings: [{ label: "Slice", grams: 5 }],
    },
  });
  expect(res.ok()).toBeTruthy();
  const f = await res.json();
  await page.goto("/#/foods");
  await page.getByLabel("Search foods").fill(`Pickles ${tag}`);
  const row = page.getByRole("button", { name: starts(`Pickles ${tag}`) });
  await expect(row.locator(".light")).toHaveText(["OK"]);
  await expect(row.locator(".light.l-medium")).toHaveCount(1);
  await page.goto(`/#/log/${f.id}`);
  const labels = page.locator(".lights.labels");
  await expect(labels.locator(".light")).toHaveText(["OK"]);
  await expect(labels.locator(".why")).toHaveText(
    "OK: salt, but fruit & veg · Slice (5\u00A0g): 3\u00A0% of a day's salt",
  );
});

test("the food view says which light value keeps it from a verdict", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(87, testInfo);
  // Chicken without sugars: no verdict (they could be the red), and
  // why.
  const f = await food(request, {
    name: `Partial chicken ${tag}`,
    per100: { energy: 110, protein: 23, fat: 1.5, saturated: 0.4, sodium: 60 },
  });
  await page.goto(`/#/log/${f.id}`);
  const labels = page.locator(".lights.labels");
  await expect(labels.locator(".light")).toHaveCount(0);
  await expect(labels).toHaveText("No verdict: sugars not known");
});

// A filter is the server's: a match past the first page of name
// hits is still found.
test("a sublabel filter finds a food past the first 50 hits", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(85, testInfo);
  for (let i = 0; i < 59; i += 1)
    await food(request, {
      name: `Deep ${tag} ${String(i).padStart(2, "0")}`,
      per100: { energy: 300, protein: 5, fat: 10 },
    });
  await food(request, {
    name: `Deep ${tag} zz lean pick`,
    per100: { energy: 300, protein: 30, fat: 10 },
  });
  await page.goto("/#/foods");
  await page.getByLabel("Search foods").fill(`Deep ${tag}`);
  const lean = page.getByRole("button", {
    name: starts(`Deep ${tag} zz lean pick`),
  });
  const rows = page.locator(".finder-results .result");
  await expect(rows).toHaveCount(50);
  await expect(lean).toHaveCount(0);
  await page.getByRole("button", { name: /^Filters/u }).click();
  await page.getByRole("button", { name: "High protein", exact: true }).click();
  await expect(lean).toBeVisible();
  await expect(rows).toHaveCount(1);
});

// Values per a serving.
const panelRow = (page, label) =>
  page.locator(".nutrition-panel tr", { hasText: label });
const foodNamed = async (request, name) =>
  (
    await (
      await request.get(`/api/profiles/1/foods?q=${encodeURIComponent(name)}`)
    ).json()
  )[0];

test("values entered per serving read back as typed", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(912, testInfo);
  await page.goto("/#/food/new");
  await page.getByLabel("Name").fill(`Burger ${tag}`);
  await page.getByRole("button", { name: "+ Serving" }).click();
  await page.getByLabel("Serving name").fill("Burger");
  await page.getByLabel("Serving grams").fill("210");
  await page
    .getByLabel("Values per", { exact: true })
    .selectOption({ index: 1 });
  await page.getByLabel("Energy (kcal)").fill("540");
  // The aside shows the other view: per 100 g.
  await expect(panelRow(page, "Energy")).toContainText("257 kcal");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page).toHaveURL(/#\/food\/\d+$/u);

  const saved = await foodNamed(request, `Burger ${tag}`);
  expect(saved.per100.energy).toBeCloseTo((540 * 100) / 210, 6);
  expect(saved.basis).toEqual({ serving: "Burger", estimated: false });
  await page.goto(`/#/food/${saved.id}`);
  await expect(
    page.getByLabel("Values per", { exact: true }).locator("option:checked"),
  ).toHaveText(/^Burger/u);
  await expect(page.getByLabel("Energy (kcal)")).toHaveValue("540");
});

test("switching the basis never changes the food", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag } = unique(913, testInfo);
  const bread = await food(request, {
    name: `Basis bread ${tag}`,
    per100: { energy: 250, protein: 10 },
    servings: [{ label: "Slice", grams: 40 }],
  });
  // Logged, so changed values would ask first.
  await entry(request, {
    day,
    group: "Eaten",
    food_id: bread.id,
    grams: 40,
  });
  await page.goto(`/#/food/${bread.id}`);
  const per = page.getByLabel("Values per", { exact: true });
  const energy = page.getByLabel("Energy (kcal)");
  await expect(per.locator("option:checked")).toHaveText("100 g");
  await per.selectOption({ index: 1 });
  await expect(energy).toHaveValue("100");
  await expect(page.getByLabel("Protein (g)")).toHaveValue("4");
  await per.selectOption({ index: 0 });
  await expect(energy).toHaveValue("250");
  await per.selectOption({ index: 1 });
  // Only a switch: saved without a question, per 100 g as it was.
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.locator("#toast")).toContainText(
    `Saved Basis bread ${tag}`,
  );
  let saved = await foodNamed(request, `Basis bread ${tag}`);
  expect(saved.per100).toEqual(bread.per100);
  expect(saved.basis).toEqual({ serving: "Slice", estimated: false });
  // Saving re-renders the editor (same address): typing before it lands
  // would go to the form it replaces.
  await settled(page);

  // A new weight keeps the values per slice; per 100 g follows.
  await page.goto(`/#/food/${bread.id}`);
  await page.getByLabel("Serving grams").fill("50");
  await expect(energy).toHaveValue("100");
  await expect(panelRow(page, "Energy")).toContainText("200 kcal");
  // The first save's toast reads the same and may still show.
  const put = answered(page, "PUT", `/api/foods/${bread.id}`);
  await page.getByRole("button", { name: "Save" }).click();
  expect(await answer(page, "Save")).toBe(
    `Save changes to Basis bread ${tag}?`,
  );
  await put;
  saved = await foodNamed(request, `Basis bread ${tag}`);
  expect(saved.per100.energy).toBe(200);
  expect(saved.per100.protein).toBe(8);
});

test("a food known only per item logs exact nutrients", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag } = unique(914, testInfo);
  const burger = await food(request, {
    name: `Drive-in burger ${tag}`,
    per100: { energy: (540 * 100) / 210, fat: (30 * 100) / 210 },
    servings: [{ label: "Burger", grams: 210 }],
    basis: { serving: "Burger", estimated: false },
  });
  await page.goto(`/#/food/${burger.id}`);
  await expect(page.locator(".nutrition-panel .lights")).not.toHaveCount(0);
  await page.getByLabel("Weight is a guess").check();
  await expect(
    page.getByRole("columnheader", { name: "Per 100 g (≈ estimated weight)" }),
  ).toBeVisible();
  await expect(page.locator(".nutrition-panel")).toContainText(
    "Lights need a known weight.",
  );
  await expect(page.locator(".nutrition-panel .lights")).toHaveCount(0);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.locator("#toast")).toContainText(
    `Saved Drive-in burger ${tag}`,
  );

  await page.goto(`/#/add/${day}/Eaten`);
  await page
    .getByLabel("Search foods", { exact: true })
    .fill(`Drive-in burger ${tag}`);
  await page
    .getByRole("button", { name: starts(`Drive-in burger ${tag}`) })
    .click();
  await expect(page.getByLabel("Unit").locator("option:checked")).toHaveText(
    /^Burger \(≈210\sg\)$/u,
  );
  await page.getByLabel("quantity").fill("2");
  await page.getByRole("button", { name: "Add to Eaten" }).click();
  await expect(headline(page)).toHaveText("1,080 kcal");
  await page.goto(`/#/day/${day}`);
  await expect(page.getByText(/2 × Burger \(≈420\sg\)/u)).toBeVisible();
});

test("a food typed from a US label stores what the EU label would", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(975, testInfo);
  const servings = [{ label: "Bar", grams: 50 }];
  const eu = await food(request, { name: `EU bar ${tag}`, servings });
  const us = await food(request, { name: `US bar ${tag}`, servings });

  // EU: per 100 g, net carbs, salt.
  await page.goto(`/#/food/${eu.id}`);
  await expect(page.getByLabel("Values per", { exact: true })).toHaveValue("");
  await page.getByLabel("Energy (kcal)").fill("400");
  await page.getByLabel("Fat (g)", { exact: true }).fill("20");
  await page.getByLabel("Carbs (g)", { exact: true }).fill("40");
  await page.getByLabel("Fibre (g)", { exact: true }).fill("6");
  await page.getByLabel("Salt (g)").fill("1");
  await save(page, "Saved");

  // US: per its serving, total carbs with fiber (spelt so), sodium; %DV
  // beside it.
  await page.addInitScript(() => localStorage.setItem("label-style", "us"));
  await page.goto(`/#/food/${us.id}`);
  await page.reload();
  await expect(
    page.getByLabel("Values per", { exact: true }).locator("option:checked"),
  ).toHaveText(/^Bar/u);
  await page.getByLabel("Energy (kcal)").fill("200");
  await page.getByLabel("Fat (g)", { exact: true }).fill("10");
  await page.getByLabel("Total carbs (g)").fill("23");
  await page.getByLabel("Fiber (g)", { exact: true }).fill("3");
  await page.getByLabel("Sodium (mg)").fill("200");
  const sodium = page.locator(".nutrition-panel tr", { hasText: "Sodium" });
  // Per 100 g: 400 mg of 2,300 mg.
  await expect(sodium).toContainText("17 %");
  await save(page, "Saved");

  const per100 = async (id) =>
    (await (await request.get(`/api/foods/${id}`)).json()).per100;
  const [a, b] = [await per100(eu.id), await per100(us.id)];
  for (const k of ["energy", "fat", "net_carbs", "carbs", "fiber", "sodium"])
    expect(b[k], k).toBeCloseTo(a[k], 6);
  expect(b).toMatchObject({ net_carbs: 40, carbs: 46, sodium: 400 });
});

test("carbs known one way only: the other's field is empty and stays unknown after an edit; a total under the net is refused", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(641, testInfo);
  // An EU label's net carbs alone, a US label's total alone (no fibre).
  const net = await food(request, {
    name: `Net only ${tag}`,
    per100: { energy: 200, net_carbs: 30 },
  });
  const total = await food(request, {
    name: `Total only ${tag}`,
    per100: { energy: 200, carbs: 30 },
  });
  const per100 = async (id) =>
    (await (await request.get(`/api/foods/${id}`)).json()).per100;

  // EU label: the total-only food's Carbs (net) field is empty: unknown.
  await page.goto(`/#/food/${total.id}`);
  await expect(page.getByLabel("Carbs (g)", { exact: true })).toHaveValue("");
  await page.getByLabel("Energy (kcal)").fill("210");
  await save(page, "Saved");
  expect(await per100(total.id)).toMatchObject({ energy: 210, carbs: 30 });

  // US label: the net-only food's Total carbs field is empty: unknown.
  await page.addInitScript(() => localStorage.setItem("label-style", "us"));
  await page.goto(`/#/food/${net.id}`);
  await page.reload();
  await expect(page.getByLabel("Total carbs (g)", { exact: true })).toHaveValue(
    "",
  );
  await page.getByLabel("Energy (kcal)").fill("210");
  await save(page, "Saved");
  expect(await per100(net.id)).toMatchObject({ energy: 210, net_carbs: 30 });
  expect((await per100(net.id)).carbs).toBeUndefined();

  // A total under the net with fibre unsaid: the server says why (sent
  // here as an older client might).
  await page.route(`**/api/foods/${net.id}`, (route) =>
    route.request().method() === "PUT"
      ? route.continue({
          postData: JSON.stringify({
            ...route.request().postDataJSON(),
            per100: { energy: 210, carbs: 20, net_carbs: 30 },
          }),
        })
      : route.continue(),
  );
  await page.getByLabel("Energy (kcal)").fill("220");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page.getByText(/total carbohydrate must be carbohydrate plus fibre/iu),
  ).toBeVisible();
  expect(await per100(net.id)).toMatchObject({ energy: 210, net_carbs: 30 });
});

test("in kJ the food editor opens with whole kJ, as everywhere", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(372, testInfo);
  await page.addInitScript(() => localStorage.setItem("energy-unit", "kJ"));
  // 555 kcal is 2,322.12 kJ: shown whole.
  const f = await food(request, {
    name: `Halva ${tag}`,
    per100: { energy: 555, fat: 30 },
  });
  await page.goto(`/#/food/${f.id}`);
  await expect(page.getByLabel("Energy (kJ)")).toHaveValue("2322");
  // Untouched, it saves the kcal it had.
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.locator("#toast")).toContainText("Saved");
  const saved = await (await request.get(`/api/foods/${f.id}`)).json();
  expect(saved.per100.energy).toBe(555);
});

// One Drink tick: ticked as the server derives it,
// yours once changed; what a food hydrates is read from its values and
// said in its panel (ADR 0020).
test("the food editor has one Drink tick; its panel says what it hydrates", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag } = unique(86, testInfo);
  const pid = await ownProfile(page, request, `Drinks ${tag}`);
  const drinkTick = page.getByLabel("Drink (values per 100 ml)");
  const light = page.locator(".nutrition-panel .health");
  const said = page.locator(".nutrition-panel .hydration");

  // A water value hydrates, a drink or not. Ticked, the drink thresholds
  // judge it (12 g of sugars: medium in food, high in a drink).
  const juice = await food(request, {
    name: `Tick juice ${tag}`,
    per100: { energy: 50, water: 87, sugars: 12 },
  });
  await page.goto(`/#/food/${juice.id}`);
  await expect(page.getByLabel("Counts toward hydration")).toHaveCount(0);
  await expect(drinkTick).not.toBeChecked();
  await expect(said).toHaveText(/^Hydration: 87\sml per 100\sg$/u);
  await expect(light).toContainText("Sugars medium");
  await drinkTick.check();
  await expect(light).toContainText("Sugars high");
  await expect(light).toContainText("Per 100 ml");
  await save(page, "Saved");
  const saved = await (await request.get(`/api/foods/${juice.id}`)).json();
  expect(saved.drink).toBe(true);
  expect(saved.hydrates).toBeUndefined();

  // A sugary drink is a drink of itself.
  const soda = await food(request, {
    name: `Tick soda ${tag}`,
    category: "sugary_drinks",
    per100: { energy: 40, sugars: 10 },
  });
  await page.goto(`/#/food/${soda.id}`);
  await expect(drinkTick).toBeChecked();

  // No water value: nothing until it's a drink, then estimated (100 − 10 g
  // carbs = 90 ml a 100 g: 225 ml in 250 g).
  const squash = await food(request, {
    name: `Tick squash ${tag}`,
    per100: { energy: 40, net_carbs: 10 },
  });
  await request.post(`/api/profiles/${pid}/entries`, {
    data: { day, group: "Eaten", food_id: squash.id, grams: 250 },
  });
  await page.goto(`/#/food/${squash.id}`);
  // The squash's editor, not the soda's still on screen.
  await expect(page.getByLabel("Name")).toHaveValue(`Tick squash ${tag}`);
  await expect(said).toHaveText("Hydration: not counted (no water value)");
  await drinkTick.check();
  await expect(said).toHaveText(/^Hydration: 90\sml per 100\sml$/u);
  await save(page, "Saved");
  await page.goto(`/#/day/${day}`);
  await expect(page.locator(".hydration .name")).toHaveText(/^225\sml\b/u);
});

test("an ingredient opens its food from the recipe's views, and Back returns", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag } = unique(1033, testInfo);
  const oats = await food(request, {
    name: `Oats ${tag}`,
    per100: { energy: 380 },
  });
  const inner = await (
    await request.post("/api/recipes", {
      data: { name: `Base ${tag}`, items: [{ food_id: oats.id, grams: 50 }] },
    })
  ).json();
  const recipe = await (
    await request.post("/api/recipes", {
      data: {
        name: `Porridge ${tag}`,
        items: [
          { food_id: oats.id, grams: 60 },
          { food_id: inner.id, grams: 100 },
        ],
      },
    })
  ).json();

  // The log screen: a click (and Enter) opens the food; Back returns.
  const log = `/#/log/${day}/Eaten/${recipe.id}`;
  await page.goto(log);
  const items = page.locator(".recipe-items");
  await items.getByRole("link", { name: starts(`Oats ${tag}`) }).click();
  await expect(page).toHaveURL(new RegExp(`#/food/${oats.id}`, "u"));
  await page.goBack();
  await expect(page).toHaveURL(
    new RegExp(`#/log/${day}/Eaten/${recipe.id}$`, "u"),
  );
  // A nested recipe opens as a recipe, by keyboard.
  await items.getByRole("link", { name: starts(`Base ${tag}`) }).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`#/recipe/${inner.id}`, "u"));
  await page.goBack();

  // The Diary entry's compact list.
  const logged = (
    await entry(request, {
      day,
      group: "Eaten",
      food_id: recipe.id,
      grams: 100,
    })
  ).entries[0];
  await page.goto(`/#/entry/${logged.id}`);
  await page
    .locator(".recipe-items")
    .getByRole("link", { name: starts(`Oats ${tag}`) })
    .click();
  await expect(page).toHaveURL(new RegExp(`#/food/${oats.id}`, "u"));
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`#/entry/${logged.id}$`, "u"));

  // The editor: the name opens the food (grams and remove still work);
  // Back returns to the recipe with its unsaved change.
  await page.goto(`/#/recipe/${recipe.id}`);
  const name = page.getByLabel("Name", { exact: true });
  await expect(name).toHaveValue(`Porridge ${tag}`);
  await name.fill(`Porridge ${tag} v2`);
  await page.getByRole("button", { name: `Edit Oats ${tag}` }).click();
  await expect(page).toHaveURL(new RegExp(`#/food/${oats.id}`, "u"));
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`#/recipe/${recipe.id}`, "u"));
  await expect(name).toHaveValue(`Porridge ${tag} v2`);
  await page.getByRole("button", { name: `Remove Base ${tag}` }).click();
  await expect(
    page.getByRole("button", { name: `Edit Base ${tag}` }),
  ).toHaveCount(0);
});

// ---------------------------------------------------------------- copy

// A copy as it compares with its original: without what a copy resets
// (the server's `COPY_RESET`: id, rev, uid, barcode, Fineli's keys,
// source, archived, the derived category) and its name.
const copyShared = ({
  id: _id,
  rev: _rev,
  uid: _uid,
  name: _name,
  barcode: _barcode,
  fineli_id: _fineliId,
  fineli_class: _fineliClass,
  source: _source,
  archived: _archived,
  category_auto: _categoryAuto,
  ...rest
}) => rest;

// The kind and id of the editor shown: `#/food/12?back=…` → ["food", 12].
const shownEditor = (page) => {
  const [, kind, id] = new URL(page.url()).hash.match(/^#\/(\w+)\/(\d+)/u);
  return [kind, Number(id)];
};

// Copy posts the form as it is when pressed: the name, brand and
// Drink tick edited first are the copy's; the original keeps its own.
test("Copy takes the editor's unsaved changes, the original keeps its own", async ({
  page,
  request,
}, testInfo) => {
  const { tag, barcode } = unique(1060, testInfo);
  const original = await food(request, {
    name: `Copy bar ${tag}`,
    brand: "Old",
    barcode,
    per100: { energy: 40 },
    servings: [{ label: "Bar", grams: 50 }],
  });
  expect(original.drink).toBe(false);
  await page.goto(`/#/food/${original.id}`);
  await page.getByLabel("Name", { exact: true }).fill(`Edited bar ${tag}`);
  await page.getByLabel("Brand", { exact: true }).fill("New");
  await page.getByLabel(/Drink/u).check();
  await page.getByRole("button", { name: "Copy", exact: true }).click();
  await expect(page.locator("#toast")).toContainText(
    `Copied as Edited bar ${tag} (copy)`,
  );
  await expect(
    page.getByRole("heading", { name: `Edited bar ${tag} (copy)` }),
  ).toBeVisible();
  const [, copyId] = shownEditor(page);
  const copy = await (await request.get(`/api/foods/${copyId}`)).json();
  expect(copy).toMatchObject({
    name: `Edited bar ${tag} (copy)`,
    brand: "New",
    barcode: null,
    drink: true,
    per100: original.per100,
    servings: original.servings,
  });
  expect(await (await request.get(`/api/foods/${original.id}`)).json()).toEqual(
    original,
  );
});

// The save dialog's "Cancel and use Copy" does what it says: the
// copy has the changes, the recipe the meal uses stays as it was.
test("Cancel and use Copy keeps the meal's recipe as it was", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(1107, testInfo);
  const oats = await food(request, {
    name: `Kept oats ${tag}`,
    per100: { energy: 370 },
  });
  const porridge = await (
    await request.post("/api/recipes", {
      data: {
        name: `Kept porridge ${tag}`,
        items: [{ food_id: oats.id, grams: 100 }],
      },
    })
  ).json();
  const meal = await (
    await request.post("/api/meals", {
      data: {
        name: `Kept breakfast ${tag}`,
        items: [{ food_id: porridge.id, grams: 200 }],
      },
    })
  ).json();

  await page.goto(`/#/recipe/${porridge.id}`);
  await page.getByLabel("Name", { exact: true }).fill(`Thick porridge ${tag}`);
  await page.getByLabel(`Kept oats ${tag} quantity`).fill("150");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("dialog")).toContainText("Cancel and use Copy");
  await answer(page, "Cancel");
  await page.getByRole("button", { name: "Copy", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: `Thick porridge ${tag} (copy)` }),
  ).toBeVisible();
  await expect(page).toHaveURL(/#\/recipe\/\d+$/u);
  const [, copyId] = shownEditor(page);
  const copy = await (await request.get(`/api/recipes/${copyId}`)).json();
  expect(copy.name).toBe(`Thick porridge ${tag} (copy)`);
  expect(copy.items[0].grams).toBe(150);
  expect(
    await (await request.get(`/api/recipes/${porridge.id}`)).json(),
  ).toEqual(porridge);
  expect(await (await request.get(`/api/meals/${meal.id}`)).json()).toEqual(
    meal,
  );
});

// A saved copy (the Copy of the screen that logs it) keeps
// everything its original saves but what a copy resets: a name at the
// limit still fits, a meal's gram items and a recipe's cooked weight come
// along, an archived original gives a copy in use. A Fineli food's editor
// Copy is yours: your source, no Fineli brand.
test("a copy keeps what its original saves", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(1108, testInfo);
  const limit = (await (await request.get("/api/meta")).json()).limits.name;
  const long = `Long ${tag} ${"x".repeat(limit)}`.slice(0, limit);
  const atLimit = await food(request, {
    name: long,
    brand: "Brand",
    per100: { energy: 120, protein: 3 },
    servings: [{ label: "Bar", grams: 45 }],
  });
  const archived = await food(request, {
    name: `Shelved ${tag}`,
    per100: { energy: 80 },
    archived: true,
  });
  const cooked = await (
    await request.post("/api/recipes", {
      data: {
        name: `Stew ${tag}`,
        cooked_g: 400,
        makes: 2,
        items: [
          { food_id: atLimit.id, serving: "Bar", quantity: 2 },
          { food_id: archived.id, grams: 300 },
        ],
        notes: "Simmer.",
      },
    })
  ).json();
  const meal = await (
    await request.post("/api/meals", {
      data: {
        name: `Lunch ${tag}`,
        items: [
          { food_id: archived.id, grams: 120 },
          { food_id: atLimit.id, serving: "Bar", quantity: 1 },
        ],
      },
    })
  ).json();

  const cases = [
    [`/#/log/${atLimit.id}`, "Copy food", "foods", atLimit],
    [`/#/log/${archived.id}`, "Copy food", "foods", archived],
    [`/#/log/${cooked.id}`, "Copy recipe", "recipes", cooked],
    [`/#/log-meal/${meal.id}`, "Copy meal", "meals", meal],
  ];
  for (const [url, label, kind, original] of cases) {
    await page.goto(url);
    await page.getByRole("button", { name: label, exact: true }).click();
    await expect(page.locator("#toast")).toContainText("Copied as");
    await settled(page);
    const [, id] = shownEditor(page);
    expect(id).not.toBe(original.id);
    const copy = await (await request.get(`/api/${kind}/${id}`)).json();
    expect(copyShared(copy), label).toEqual(copyShared(original));
    expect(copy.name).toBe(
      `${original.name.slice(0, limit - " (copy)".length)} (copy)`,
    );
    expect(copy.name.length).toBeLessThanOrEqual(limit);
    if ("archived" in original) expect(copy.archived).toBe(false);
  }

  // Fineli's name and values are its own; its copy is yours.
  await mockJson(page, `**/api/foods/${archived.id}`, {
    source: "fineli",
    brand: "Fineli",
  });
  await page.goto(`/#/food/${archived.id}`);
  const posted = page.waitForRequest(
    (r) => r.method() === "POST" && r.url().endsWith("/api/foods"),
  );
  await page.getByRole("button", { name: "Copy", exact: true }).click();
  expect((await posted).postDataJSON()).toMatchObject({
    name: `Shelved ${tag} (copy)`,
    brand: null,
    archived: false,
  });
  await expect(page.locator("#toast")).toContainText("Copied as");
  const [, fineliCopy] = shownEditor(page);
  expect(
    await (await request.get(`/api/foods/${fineliCopy}`)).json(),
  ).toMatchObject({ source: "custom", brand: null });
});

// A header holds its title, Back and its star and pencil on one
// row on a phone, for a short name and a 40-character one; the title may
// wrap, never cut.
test("header actions sit on Back's row", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag } = unique(1109, testInfo);
  await page.setViewportSize({ width: 393, height: 851 });
  for (const name of [
    `Kale ${tag}`,
    `${"Long-named wholegrain rye ".repeat(2)}`.slice(0, 31) + ` ${tag}`,
  ]) {
    expect(name.length === 40 || name.length < 20).toBe(true);
    const f = await food(request, {
      name,
      per100: { energy: 50 },
      servings: [{ label: "Bowl", grams: 200 }],
    });
    const recipe = await (
      await request.post("/api/recipes", {
        data: { name, items: [{ food_id: f.id, grams: 100 }] },
      })
    ).json();
    const meal = await (
      await request.post("/api/meals", {
        data: { name, items: [{ food_id: f.id, grams: 100 }] },
      })
    ).json();
    const {
      entries: [e],
    } = await entry(request, { day, group: "Eaten", food_id: f.id, grams: 50 });
    for (const url of [
      `/#/log/${day}/Eaten/${f.id}`,
      `/#/log/${recipe.id}`,
      `/#/log-meal/${day}/Eaten/${meal.id}`,
      `/#/entry/${e.id}`,
      `/#/food/${f.id}`,
      `/#/recipe/${recipe.id}`,
    ]) {
      await page.goto(url);
      const header = page.locator("header.title", { has: page.locator("h1") });
      await expect(header.locator("h1")).toHaveText(name);
      await expect(header.getByRole("link", { name: "Back" })).toBeVisible();
      const row = await header.evaluate((el) => {
        const h1 = el.querySelector("h1");
        const [back, ...actions] = [...el.children].filter((c) => c !== h1);
        return {
          back: back.getBoundingClientRect().top,
          actions: actions.map((a) => a.getBoundingClientRect().top),
          cut: h1.scrollWidth > h1.clientWidth,
        };
      });
      expect(row.actions.length, url).toBeGreaterThan(0);
      for (const top of row.actions) expect(top, url).toBe(row.back);
      expect(row.cut, url).toBe(false);
      await expect(header.getByRole("button", { name: /^Copy/u })).toHaveCount(
        0,
      );
    }
  }
});

// Copy is the log screen's labelled action by
// kind, beside "Add to …" (Enter still adds); its copy's editor saves back
// to logging the copy. Each press is a copy of its own. An entry's screen
// has none: its copy is "Log again".
test("Copy is the log screen's action by kind and saves back to its log", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag } = unique(1061, testInfo);
  const cola = await food(request, {
    name: `Log cola ${tag}`,
    per100: { energy: 40 },
    servings: [{ label: "Can", grams: 330 }],
  });
  const log = `/#/log/${day}/Eaten/${cola.id}`;
  await page.goto(log);
  const copy = page.getByRole("button", { name: "Copy food", exact: true });
  await expect(copy).toHaveAttribute("type", "button");
  // In the action row, left of the primary.
  const order = await page
    .locator("form.log .actions")
    .evaluate((row) => [...row.children].map((b) => b.textContent));
  expect(order).toEqual(["Copy food", "Add to Eaten"]);
  await copy.click();
  await expect(page.locator("#toast")).toContainText(
    `Copied as Log cola ${tag} (copy)`,
  );
  await expect(page).toHaveURL(/#\/food\/\d+\?back=/u);
  const [, copyId] = shownEditor(page);
  await page.getByLabel("Name", { exact: true }).fill(`Log fizz ${tag}`);
  await save(page, `Saved Log fizz ${tag}`);
  await expect(page).toHaveURL(
    new RegExp(`#/log/${day}/Eaten/${copyId}$`, "u"),
  );

  // A recipe's says so; two presses, two copies.
  const punch = await (
    await request.post("/api/recipes", {
      data: {
        name: `Log punch ${tag}`,
        items: [{ food_id: cola.id, grams: 330 }],
      },
    })
  ).json();
  const copies = [];
  for (let i = 0; i < 2; i++) {
    await page.goto(`/#/log/${punch.id}`);
    await page
      .getByRole("button", { name: "Copy recipe", exact: true })
      .click();
    await expect(page).toHaveURL(/#\/recipe\/\d+\?back=/u);
    copies.push(shownEditor(page)[1]);
  }
  expect(new Set(copies).size).toBe(2);

  // Enter still adds.
  await page.goto(log);
  await settled(page);
  await page.getByLabel("Quantity", { exact: true }).press("Enter");
  await expect(page.locator("#toast")).toContainText(
    `Added Log cola ${tag} to Eaten`,
  );

  // An entry copies itself ("Log again"), not its food.
  const {
    entries: [e],
  } = await entry(request, {
    day,
    group: "Eaten",
    food_id: cola.id,
    grams: 330,
  });
  await page.goto(`/#/entry/${e.id}`);
  await expect(
    page.getByRole("heading", { name: `Log cola ${tag}` }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /^Copy/u })).toHaveCount(0);
});

// A food or recipe nothing uses is deleted (a favourite goes with
// it); one in use is archived instead.
test("Delete or Archive follows what uses the food", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag } = unique(1111, testInfo);
  const spare = await food(request, { name: `Spare ${tag}` });
  await request.post(`/api/profiles/1/foods/favorites`, {
    data: { food_id: spare.id },
  });
  await page.goto(`/#/food/${spare.id}`);
  await expect(page.getByRole("button", { name: "Archive" })).toHaveCount(0);
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  expect(await answer(page, "Delete")).toBe(`Delete Spare ${tag}?`);
  await expect(page.locator("#toast")).toContainText(`Deleted Spare ${tag}`);
  await expect(page).toHaveURL(/#\/foods$/u);
  expect((await request.get(`/api/foods/${spare.id}`)).status()).toBe(404);

  const used = await food(request, { name: `Used ${tag}` });
  await entry(request, { day, group: "Eaten", food_id: used.id, grams: 10 });
  const recipe = await (
    await request.post("/api/recipes", {
      data: {
        name: `Spare stew ${tag}`,
        items: [{ food_id: used.id, grams: 10 }],
      },
    })
  ).json();
  await page.goto(`/#/food/${used.id}`);
  await expect(
    page.getByRole("button", { name: "Archive", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Delete" })).toHaveCount(0);

  // A recipe is a food: unused, it's deleted.
  await page.goto(`/#/recipe/${recipe.id}`);
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await answer(page, "Delete");
  await expect(page.locator("#toast")).toContainText(
    `Deleted Spare stew ${tag}`,
  );
  expect((await request.get(`/api/foods/${recipe.id}`)).status()).toBe(404);
});

// The current profile's foods named like `q`.
const named = async (request, q) =>
  (
    await (
      await request.get(
        `/api/profiles/1/foods?${new URLSearchParams({ q, sources: "custom" })}`,
      )
    ).json()
  ).filter((f) => f.name.startsWith(q));

// A Save whose answer was lost, sent again, saves one food; edited
// before it's sent again, one food with the edit.
test("a Save sent again after its answer was lost saves one food", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(1112, testInfo);
  const offline = page.getByText("Can't reach the server");
  for (const [typed, edited] of [
    [`Once ${tag}`, null],
    [`Twice ${tag}`, `Twice ${tag} edited`],
  ]) {
    await page.goto("/#/food/new");
    await page.getByLabel("Name", { exact: true }).fill(typed);
    await page.getByLabel("Energy (kcal)", { exact: true }).fill("100");
    await loseFirstAnswer(page, "POST", "**/api/foods");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(offline).toBeVisible();
    if (edited) await page.getByLabel("Name", { exact: true }).fill(edited);
    await save(page, `Saved ${edited ?? typed}`);
    await page.unrouteAll();
    const found = await named(request, typed);
    expect(found.map((f) => f.name)).toEqual([edited ?? typed]);
  }
});

// An edit whose answer was lost, sent again, finds
// its own revision saved: "Saved", not a conflict.
test("an edit sent again after its answer was lost says Saved", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(1113, testInfo);
  const f = await food(request, {
    name: `Edit ${tag}`,
    per100: { energy: 10 },
  });
  await page.goto(`/#/food/${f.id}`);
  await page.getByLabel("Name", { exact: true }).fill(`Edited ${tag}`);
  await loseFirstAnswer(page, "PUT", `**/api/foods/${f.id}`);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Can't reach the server")).toBeVisible();
  await save(page, `Saved Edited ${tag}`);
  const now = await (await request.get(`/api/foods/${f.id}`)).json();
  expect(now).toMatchObject({ name: `Edited ${tag}`, rev: f.rev + 1 });
});

// An ingredient picked in the editor carries what the server
// knows of it: a sub-recipe's iron known on half its dry matter reads "≥"
// live, as it does saved.
test("a picked sub-recipe's partial iron reads ≥ in the live panel", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(1114, testInfo);
  const liver = await food(request, {
    name: `Iron liver ${tag}`,
    per100: { energy: 130, iron: 6, water: 70 },
  });
  const rice = await food(request, {
    name: `Iron rice ${tag}`,
    per100: { energy: 130, water: 70 },
  });
  const sub = await (
    await request.post("/api/recipes", {
      data: {
        name: `Iron base ${tag}`,
        items: [
          { food_id: liver.id, grams: 100 },
          { food_id: rice.id, grams: 100 },
        ],
      },
    })
  ).json();
  expect(sub.known.iron).toBeCloseTo(0.5);
  const iron = page.locator(".nutrition-panel tr", { hasText: "Iron" }).first();

  await page.goto("/#/recipe/new");
  await page.getByLabel("Name", { exact: true }).fill(`Iron dish ${tag}`);
  await page.getByLabel("Search foods to add").fill(`Iron base ${tag}`);
  await page.getByRole("button", { name: starts(`Iron base ${tag}`) }).click();
  await expect(iron).toContainText("≥");
  const live = await iron.textContent();
  await save(page, `Saved Iron dish ${tag}`);
  await page.reload();
  await expect(iron).toHaveText(live);
});

// Every check the form can make comes before the question about
// what uses the food: a value over its per-100 g cap is refused first.
test("a value over its per-100 g cap is refused before the usage question", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag } = unique(1115, testInfo);
  const f = await food(request, {
    name: `Capped ${tag}`,
    per100: { energy: 165, protein: 31 },
  });
  await entry(request, { day, group: "Eaten", food_id: f.id, grams: 100 });
  await page.goto(`/#/food/${f.id}`);
  await page.getByLabel("Protein (g)", { exact: true }).fill("500");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page.getByText("Protein must be at most 110 g per 100 g"),
  ).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByLabel("Protein (g)", { exact: true })).toHaveAttribute(
    "aria-invalid",
    "true",
  );
});

// A saved search filter means what it meant: Energy ≤ 200 kcal
// is still 200 kcal (837 kJ) after the energy unit changes.
test("a saved energy filter keeps its meaning across energy units", async ({
  page,
}) => {
  await page.goto("/#/foods");
  await page.getByRole("button", { name: /^Filters/u }).click();
  await page.getByRole("button", { name: "+ Rule" }).click();
  await page
    .getByLabel("Rule nutrient")
    .selectOption({ label: "Energy (kcal)" });
  await page.getByLabel("Rule direction").selectOption({ label: "≤" });
  await page.getByLabel("Rule amount").fill("200");
  const query = async () => {
    const search = page.waitForRequest(/\/api\/profiles\/\d+\/foods\?q=/u);
    await page.getByLabel("Search foods").fill(`kale ${Math.random()}`);
    return new URL((await search).url()).searchParams.get("max");
  };
  expect(await query()).toBe("energy:200");

  await page.evaluate(() => localStorage.setItem("energy-unit", "kJ"));
  await page.reload();
  await page.getByRole("button", { name: /^Filters/u }).click();
  await expect(page.getByLabel("Rule amount")).toHaveValue("836.8");
  expect(await query()).toBe("energy:200");
});

// A cooked weight of 0 is refused by the form, as the server
// would.
test("a recipe's cooked weight of 0 is refused", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(1117, testInfo);
  await food(request, { name: `Zero oats ${tag}`, per100: { energy: 370 } });
  await page.goto("/#/recipe/new");
  await page.getByLabel("Name", { exact: true }).fill(`Zero stew ${tag}`);
  await page.getByLabel("Search foods to add").fill(`Zero oats ${tag}`);
  await page.getByRole("button", { name: starts(`Zero oats ${tag}`) }).click();
  await page.getByText("Weighed it after cooking?").click();
  await page.getByLabel("Weight after cooking (g)").fill("0");
  let posted = 0;
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().endsWith("/api/recipes")) posted++;
  });
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByLabel("Weight after cooking (g)")).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  expect(posted).toBe(0);
});

// Recent lists the last few foods, not every one; an item typed
// in grams shows its amount once.
test("Recent shows 8, and a gram item's amount shows once", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag } = unique(1119, testInfo);
  const pid = await ownProfile(page, request, `Recent ${tag}`);
  const foods = [];
  for (let i = 0; i < 10; i++) {
    const f = await food(request, {
      name: `Recent ${i} ${tag}`,
      per100: { energy: 50 },
      servings: [{ label: "Cup", grams: 80 }],
    });
    foods.push(f);
    await entry(
      request,
      { day, group: "Eaten", food_id: f.id, grams: 50 },
      pid,
    );
  }
  await page.goto("/#/foods");
  const recent = page.locator(".finder-section", {
    has: page.getByRole("heading", { name: "Recent" }),
  });
  await expect(recent.locator("li")).toHaveCount(8);

  const stew = await (
    await request.post("/api/recipes", {
      data: {
        name: `Recent stew ${tag}`,
        items: [
          { food_id: foods[0].id, grams: 300 },
          { food_id: foods[1].id, serving: "Cup", quantity: 2 },
        ],
      },
    })
  ).json();
  await page.goto(`/#/recipe/${stew.id}`);
  const weights = page.locator(".items .item .weight");
  await expect(weights.nth(0)).toHaveText("");
  await expect(weights.nth(1)).toHaveText("160 g");
});
