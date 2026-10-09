// The Foods tab and search: foods, recipes, meals, barcodes, favourites.

import { test, expect } from "@playwright/test";
import {
  unique,
  starts,
  food,
  ownProfile,
  headline,
  answer,
} from "./helpers.js";

test("create a recipe and log it", async ({ page, request }, testInfo) => {
  const { day, tag } = unique(5, testInfo);
  await food(request, { name: `Flour ${tag}`, per100: { energy: 360 } });

  await page.goto("/#/recipe/new");
  await page.getByLabel("Name").fill(`Flatbread ${tag}`);
  await page.getByLabel("Search foods to add").fill(`Flour ${tag}`);
  await page.getByRole("button", { name: starts(`Flour ${tag}`) }).click();
  await page.getByLabel(`Flour ${tag} grams`).fill("200");
  // Weighs its ingredients until weighed after cooking.
  await expect(page.getByText("Weighs 200 g (its ingredients).")).toBeVisible();
  await page.getByText("Weighed it after cooking?").click();
  await page.getByLabel("Weight after cooking (g)").fill("300");
  // The whole recipe is a serving, the default, at its weight.
  const whole = page.locator(".servings .serving").first();
  await expect(whole).toContainText(/Whole recipe\s*300\s*g/);
  await expect(whole).toContainText("Default");
  await page.getByRole("button", { name: "Save" }).click();
  const energy = page.locator(".nutrition-panel tr", { hasText: "Energy" });
  // 720 kcal of flour over 300 g cooked: 240 per 100 g.
  await expect(energy).toContainText("240 kcal");
  await expect(energy).toContainText("720 kcal");
  await expect(page.locator("#toast")).toContainText(`Saved Flatbread ${tag}`);

  await page.goto(`/#/add/${day}/Consumed`);
  // Exact: the recipe editor just left has "Search foods to add".
  await page
    .getByLabel("Search foods", { exact: true })
    .fill(`Flatbread ${tag}`);
  await page.getByRole("button", { name: starts(`Flatbread ${tag}`) }).click();
  // The whole recipe is the default; grams are one pick away.
  const unit = page.getByLabel("Unit");
  await expect(unit.locator("option:checked")).toHaveText(/^Whole recipe/);
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

  await page.goto(`/#/add/${day}/Consumed`);
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
  await page.goto(`/#/add/${day}/Consumed`);
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
  const result = page.getByRole("button", { name: starts(`Old Oats ${tag}`) });

  // Archived from its editor: it stays, hidden from search.
  await page.goto(`/#/food/${oats.id}`);
  await page.getByRole("button", { name: "Archive", exact: true }).click();
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
  await page.getByRole("button", { name: /^Filters/ }).click();
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
  await page.goto(`/#/add/${day}/Consumed`);
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
  await expect(page).toHaveURL(new RegExp(`#/log/${day}/Consumed/\\d+$`));
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
  await page.goto(`/#/log/${day}/Consumed/${f.id}`);
  await page.getByRole("link", { name: "Edit food" }).click();
  await page.getByLabel("Energy (kcal)").fill("300");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page).toHaveURL(new RegExp(`#/log/${day}/Consumed/${f.id}$`));
  await expect(page.getByText("100 g · 300 kcal")).toBeVisible();
});

test("foods are entered as on an EU label", async ({ page }, testInfo) => {
  const { tag } = unique(22, testInfo);
  await page.goto("/#/food/new");
  await page.getByLabel("Name").fill(`Rye crisp ${tag}`);
  await page.getByLabel("Energy (kJ)").fill("1500");
  await expect(page.getByLabel("Energy (kcal)")).toHaveValue("359");
  await page.getByLabel("Carbohydrate (g)", { exact: true }).fill("60");
  await page.getByLabel("Fibre (g)", { exact: true }).fill("15");
  await page.getByLabel("Salt (g)").fill("1.25");
  await page.locator("form summary", { hasText: "Other nutrients" }).click();
  await page.getByLabel("Vitamin D (µg)").fill("5");
  await page.getByRole("button", { name: "Save" }).click();
  // Saved: the editor moves to the new food's own address.
  await expect(page).toHaveURL(/#\/food\/\d+$/);

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
  await expect(page.getByLabel("Sugars (carbs, g)")).toBeAttached();
  await expect(energy).toBeDisabled();
  expect(await background(energy)).not.toBe(
    await background(page.getByLabel("Barcode")),
  );
});

test("search filters choose databases and are remembered", async ({ page }) => {
  await page.goto("/#/foods");
  await page.getByRole("button", { name: /^Filters/ }).click();
  await page.getByLabel("Fineli").uncheck();
  await expect(page.getByRole("button", { name: "Filters · 1" })).toBeVisible();
  const search = page.waitForRequest(/\/api\/profiles\/\d+\/foods\?/);
  await page.getByLabel("Search foods").fill("maito");
  const sources = new URL((await search).url()).searchParams.get("sources");
  expect(sources.split(",")).not.toContain("fineli");

  await page.reload();
  await expect(page.getByRole("button", { name: "Filters · 1" })).toBeVisible();
  await page.getByRole("button", { name: /^Filters/ }).click();
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
  await page.getByRole("button", { name: /^Filters/ }).click();
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
  await expect(page).toHaveURL(/#\/day\/\d{4}-\d{2}-\d{2}$/);
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
  await page.getByLabel("Name").fill(`Fresh ${tag}`);
  await page.getByRole("button", { name: "Save" }).click();
  // No energy: a soft warning first.
  expect(await answer(page, "Save")).toBe("Save without energy?");
  await expect(page).toHaveURL(/#\/food\/\d+$/);
  await expect(
    page.getByRole("heading", { name: `Fresh ${tag}` }),
  ).toBeVisible();
  await expect(page.locator("#toast")).toContainText(`Saved Fresh ${tag}`);
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
  await page.goto(`/#/scan/${day}/Consumed`);
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
      JSON.stringify({ rules: [{ key: "protein", dir: "min", value: "-1" }] }),
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
      async detect() {
        return [{ rawValue: code }];
      }
    };
    navigator.mediaDevices.getUserMedia = async () => new MediaStream();
  }, barcode);
  await page.goto(`/#/scan/${day}/Consumed`);
  await expect(
    page.getByRole("heading", { name: `Scan me ${tag}` }),
  ).toBeVisible();
});

test("nutrition shows in every food view and follows the amounts", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(44, testInfo);
  const oats = await food(request, {
    name: `Panel oats ${tag}`,
    per100: { energy: 380, protein: 13, sodium: 400 },
  });
  await food(request, {
    name: `Panel milk ${tag}`,
    per100: { energy: 40, protein: 3.5 },
  });
  const row = (label) =>
    page.locator(".nutrition-panel tr", { hasText: label });

  // Logging: per 100 g and the amount chosen; salt in EU units.
  await page.goto(`/#/log/${oats.id}`);
  await expect(row("Energy")).toContainText("380 kcal");
  await page.getByLabel("quantity").fill("50");
  await expect(row("Energy")).toContainText("190 kcal");
  await expect(row("Salt")).toContainText("1 g");
  await expect(row("Salt")).toContainText("0.5 g");

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
    page.getByRole("columnheader", { name: /^bowl \(50\sg\)$/ }),
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
  await page.getByLabel(`Panel milk ${tag} grams`).fill("200");
  await expect(row("Energy")).toContainText("460 kcal");
  await page.getByRole("button", { name: `Remove Panel oats ${tag}` }).click();
  await expect(row("Energy")).toContainText("80 kcal");
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
  await expect(page.getByLabel(`Whey ${tag} grams`)).toHaveValue("37");

  // Off to the food: a new default serving, then back to the same recipe.
  await page.getByRole("button", { name: `Edit Whey ${tag}` }).click();
  await expect(page).toHaveURL(new RegExp(`#/food/${whey.id}\\?back=`));
  await page.getByRole("button", { name: "+ Serving" }).click();
  await page.getByLabel("Serving name").last().fill("Big scoop");
  await page.getByLabel("Serving grams").last().fill("45");
  await page
    .getByRole("button", { name: "Make Big scoop the default" })
    .click();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page).toHaveURL(/#\/recipe\/new\?draft=1$/);
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
    `Shake ${tag}`,
  );
  await expect(page.getByLabel(`Whey ${tag} grams`)).toHaveValue("37");
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
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator("#toast")).toContainText(
    `Saved Shell bread ${tag}`,
  );
  await expect(page).toHaveURL(new RegExp(`#/food/${f.id}$`));
  await expect(page.getByLabel("Energy (kcal)")).toHaveValue("260");

  // Unsaved changes: leaving asks; Cancel keeps them, Leave goes.
  await name.fill(`Shell loaf ${tag}`);
  const foodsTab = page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Foods" });
  await foodsTab.click();
  expect(await answer(page, "Cancel")).toBe("Leave without saving?");
  await expect(page).toHaveURL(new RegExp(`#/food/${f.id}$`));
  await expect(name).toHaveValue(`Shell loaf ${tag}`);
  await foodsTab.click();
  await answer(page, "Leave");
  await expect(page).toHaveURL(/#\/foods$/);
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
    data: {
      name: `Fresh jam ${tag}`,
      per100: { energy: 200 },
      rev: f.rev,
    },
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
  await expect(whole).toContainText(/200\s*g/);
  await page.getByLabel(`Loaf ${tag} grams`).fill("300");
  await expect(whole).toContainText(/300\s*g/);
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
  await expect(page).toHaveURL(new RegExp(`#/log/${day}/Planned/\\d+$`));
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
  const grams = page.getByLabel(`Draft rice ${tag} grams`);
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
  await expect(page).toHaveURL(/#\/recipe\/new\?draft=1$/);
  await expect(page.getByText("Your unsaved changes are back")).toBeVisible();
  await expect(name).toHaveValue(`Pilaf ${tag}`);
  await expect(grams).toHaveValue("150");
  // Restored but still unsaved: leaving asks, as it did before.
  const foodsTab = page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Foods" });
  await foodsTab.click();
  expect(await answer(page, "Cancel")).toBe("Leave without saving?");
  await expect(name).toHaveValue(`Pilaf ${tag}`);
  await foodsTab.click();
  await answer(page, "Leave");
  await expect(page).toHaveURL(/#\/foods$/);

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
    [`/#/log/${day}/Consumed/${f.id}`, "Edit food"],
    [`/#/log-meal/${day}/Consumed/${meal.id}`, "Edit meal"],
    [`/#/log/${f.id}`, "Edit food"],
    [`/#/log-meal/${meal.id}`, "Edit meal"],
  ]) {
    await page.goto(url);
    const edit = page.locator("header.title").getByRole("link", { name });
    await expect(edit).toBeVisible();
    expect((await edit.boundingBox()).height).toBeGreaterThanOrEqual(44);
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
    foods.locator(".name").filter({ hasText: new RegExp(`^${water.name}$`) }),
    "the water food isn't listed",
  ).toHaveCount(0);
  // The same row as Recent: it opens the log screen.
  await foods.getByRole("button", { name: starts(`0 Rice ${tag}`) }).click();
  await expect(
    page.getByRole("heading", { name: `0 Rice ${tag}` }),
  ).toBeVisible();
});

test("logging a food or meal: an Amount, an optional time, one context line", async ({
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

  await page.goto(`/#/add/${day}/Consumed`);
  await page.getByLabel("Search foods").fill(`Rye ${tag}`);
  await page.getByRole("button", { name: starts(`Rye ${tag}`) }).click();
  await expect(
    page.locator("form.log").getByText("Amount", { exact: true }),
  ).toBeVisible();
  await expect(page.locator("section > p.muted").first()).toHaveText(
    new RegExp(` · Eaten · Fazer ${tag}$`),
  );
  await page.getByLabel("Time eaten").fill("07:30");
  await page.getByRole("button", { name: "Add to Eaten" }).click();
  await expect(page).toHaveURL(new RegExp(`#/day/${day}$`));
  expect(await logged()).toEqual([[`Rye ${tag}`, "07:30"]]);

  await page.goto(`/#/add/${day}/Consumed`);
  await page.getByLabel("Search foods").fill(`Lunch ${tag}`);
  await page.getByRole("link", { name: starts(`Lunch ${tag}`) }).click();
  await expect(
    page.locator("form.log").getByText("Amount", { exact: true }),
  ).toBeVisible();
  await expect(page.locator("section > p.muted").first()).toHaveText(
    / · Eaten$/,
  );
  await page.getByRole("button", { name: "Add to Eaten" }).click();
  await expect(page).toHaveURL(new RegExp(`#/day/${day}$`));
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
    /^Portion \(300\sg\)/,
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
          data: { day, group: "Consumed", food_id: milk.id, ...body },
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
