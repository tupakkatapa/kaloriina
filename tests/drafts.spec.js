// A food or recipe left unsaved is kept on this device as a draft: its
// editor opens with it, Foods lists it, and Save or Discard drops it. A
// recipe's ingredient search makes a new food that comes back as an item.

import { expect, test } from "@playwright/test";
import { answer, food, save, settled, starts, unique } from "./helpers.js";

const foodsTab = (page) =>
  page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Foods" });

// Foods' Drafts section, and the row of the draft named `name`.
const draftsSection = (page) =>
  page.locator(".finder-section", {
    has: page.getByRole("heading", { name: "Drafts" }),
  });
const draftRow = (page, name) =>
  draftsSection(page).getByRole("link", { name: starts(name) });

// Leave the editor shown for Foods: no question, the draft kept.
async function leaveForFoods(page) {
  await foodsTab(page).click();
  await expect(page).toHaveURL(/#\/foods$/u);
  await expect(page.locator("#toast")).toContainText("Saved as a draft");
  await expect(page.getByRole("dialog")).toHaveCount(0);
}

test("a new food left unsaved comes back as a draft until Discard", async ({
  page,
}, testInfo) => {
  const { tag } = unique(1290, testInfo);
  const name = page.getByLabel("Name", { exact: true });
  const energy = page.getByLabel("Energy (kcal)");
  await page.goto("/#/food/new");
  await name.fill(`Draft soup ${tag}`);
  await energy.fill("120");
  await leaveForFoods(page);

  const row = draftRow(page, `Draft soup ${tag}`);
  await expect(row).toContainText("Draft");
  await row.click();
  await expect(page).toHaveURL(/#\/food\/new$/u);
  await expect(name).toHaveValue(`Draft soup ${tag}`);
  await expect(energy).toHaveValue("120");
  const note = page.locator(".note", { hasText: /^Draft · /u });
  await expect(note).toBeVisible();

  // Typed and reloaded at once: kept too.
  await page.getByLabel("Brand").fill(`Kitchen ${tag}`);
  await page.reload();
  await expect(name).toHaveValue(`Draft soup ${tag}`);
  await expect(page.getByLabel("Brand")).toHaveValue(`Kitchen ${tag}`);

  // Search never finds it: it is not a food yet.
  await page.goto("/#/foods");
  await page.getByLabel("Search foods").fill(`Draft soup ${tag}`);
  await expect(page.getByText("No matches.")).toBeVisible();

  await page.goto("/#/food/new");
  await note.getByRole("button", { name: "Discard" }).click();
  await settled(page);
  await expect(name).toHaveValue("");
  await expect(note).toHaveCount(0);
  await foodsTab(page).click();
  await expect(page).toHaveURL(/#\/foods$/u);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(draftsSection(page)).toHaveCount(0);
});

test("a food's draft opens on that food only, and its Save drops it", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(1291, testInfo);
  const jam = await food(request, {
    name: `Jam ${tag}`,
    per100: { energy: 250 },
  });
  const tea = await food(request, { name: `Tea ${tag}`, per100: {} });
  const name = page.getByLabel("Name", { exact: true });
  const note = page.locator(".note", { hasText: /^Draft/u });
  await page.goto(`/#/food/${jam.id}`);
  await name.fill(`Jam ${tag} light`);
  await leaveForFoods(page);
  await expect(draftRow(page, `Jam ${tag} light`)).toBeVisible();
  const saved = await (await request.get(`/api/foods/${jam.id}`)).json();
  expect(saved.name).toBe(`Jam ${tag}`);

  await page.goto(`/#/food/${tea.id}`);
  await expect(name).toHaveValue(`Tea ${tag}`);
  await expect(note).toHaveCount(0);

  await page.goto(`/#/food/${jam.id}`);
  await expect(name).toHaveValue(`Jam ${tag} light`);
  await expect(note).toHaveText("Draft · Discard");
  await save(page, `Saved Jam ${tag} light`);
  await expect(note).toHaveCount(0);
  await page.goto("/#/foods");
  await expect(page.locator(".finder")).toBeVisible();
  await expect(draftsSection(page)).toHaveCount(0);

  // Changed elsewhere since the draft: it says so, and Save is refused.
  await page.goto(`/#/food/${jam.id}`);
  await name.fill(`Jam ${tag} extra`);
  await leaveForFoods(page);
  const now = await (await request.get(`/api/foods/${jam.id}`)).json();
  const put = await request.put(`/api/foods/${jam.id}`, {
    data: { ...now, name: `Jam ${tag} fresh` },
  });
  expect(put.ok()).toBeTruthy();
  await page.goto(`/#/food/${jam.id}`);
  await expect(name).toHaveValue(`Jam ${tag} extra`);
  await expect(note).toContainText("has changed since");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "changed elsewhere" }),
  ).toBeVisible();
  await note.getByRole("button", { name: "Discard" }).click();
  await settled(page);
  await expect(name).toHaveValue(`Jam ${tag} fresh`);
  await expect(note).toHaveCount(0);
});

test("a recipe left unsaved comes back with its items, and a prefilled new food keeps the older draft aside", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(1292, testInfo);
  await food(request, { name: `Draft rice ${tag}`, per100: { energy: 350 } });
  const name = page.getByLabel("Name", { exact: true });
  const grams = page.getByLabel(`Draft rice ${tag} quantity`);
  await page.goto("/#/recipe/new");
  await name.fill(`Pilaf ${tag}`);
  await page.getByLabel("Search foods to add").fill(`Draft rice ${tag}`);
  await page.getByRole("button", { name: starts(`Draft rice ${tag}`) }).click();
  await grams.fill("150");
  await leaveForFoods(page);
  const row = draftRow(page, `Pilaf ${tag}`);
  await expect(row).toContainText("recipe");
  await page.reload();
  await row.click();
  await expect(page).toHaveURL(/#\/recipe\/new$/u);
  await expect(name).toHaveValue(`Pilaf ${tag}`);
  await expect(grams).toHaveValue("150");

  // An older new food's draft, then a new food opened with a name.
  await page.goto("/#/food/new");
  await name.fill(`Old draft ${tag}`);
  await leaveForFoods(page);
  await page.goto(`/#/food/new?name=${encodeURIComponent(`Fresh ${tag}`)}`);
  await expect(name).toHaveValue(`Fresh ${tag}`);
  const aside = page.locator(".note", {
    hasText: `Draft “Old draft ${tag}”`,
  });
  await expect(aside).toBeVisible();
  // Left untouched, the older draft stays.
  await foodsTab(page).click();
  await expect(draftRow(page, `Old draft ${tag}`)).toBeVisible();
  await page.goBack();
  await aside.getByRole("link", { name: "Open" }).click();
  await expect(name).toHaveValue(`Old draft ${tag}`);
});

test("a recipe's ingredient search makes a new food that comes back as its item", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(1293, testInfo);
  await food(request, { name: `Base oats ${tag}`, per100: { energy: 370 } });
  const name = page.getByLabel("Name", { exact: true });
  await page.goto("/#/recipe/new");
  await name.fill(`Porridge ${tag}`);
  const search = page.getByLabel("Search foods to add");
  await search.fill(`Base oats ${tag}`);
  await page.getByRole("button", { name: starts(`Base oats ${tag}`) }).click();
  await page.getByLabel(`Base oats ${tag} quantity`).fill("60");

  const q = `Quince ${tag}`;
  await search.fill(q);
  await page.getByRole("link", { name: `New food “${q}”` }).click();
  await expect(page.getByRole("heading", { name: "New food" })).toBeVisible();
  await expect(name).toHaveValue(q);
  await page.getByLabel("Energy (kcal)").fill("280");
  await page.getByRole("button", { name: "Save", exact: true }).click();

  await expect(page).toHaveURL(/#\/recipe\/new$/u);
  await expect(name).toHaveValue(`Porridge ${tag}`);
  await expect(page.getByLabel(`Base oats ${tag} quantity`)).toHaveValue("60");
  const quince = page.getByLabel(`${q} quantity`);
  await expect(quince).toHaveCount(1);
  // Added once: a reload reads the draft, not the address again.
  await page.reload();
  await expect(name).toHaveValue(`Porridge ${tag}`);
  await expect(quince).toHaveCount(1);
  await save(page, `Saved Porridge ${tag}`);
  await expect(page).toHaveURL(/#\/recipe\/\d+$/u);
});

test("without storage a food editor still works and asks before leaving", async ({
  page,
}, testInfo) => {
  const { tag } = unique(1294, testInfo);
  await page.addInitScript(() => {
    const { setItem } = Storage.prototype;
    Storage.prototype.setItem = function setOnly(key, value) {
      if (key === "drafts")
        throw new DOMException("quota", "QuotaExceededError");
      return setItem.call(this, key, value);
    };
  });
  const name = page.getByLabel("Name", { exact: true });
  await page.goto("/#/food/new");
  await name.fill(`Nowhere ${tag}`);
  await page.getByLabel("Energy (kcal)").fill("90");
  await foodsTab(page).click();
  expect(await answer(page, "Stay")).toBe("Leave without saving?");
  await expect(name).toHaveValue(`Nowhere ${tag}`);
  await save(page, `Saved Nowhere ${tag}`);
});

// This device's drafts as stored, by key.
const stored = (page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem("drafts") ?? "{}"));

test("a new food for an unknown barcode comes back as typed after a reload", async ({
  page,
}, testInfo) => {
  const { tag, barcode } = unique(1295, testInfo);
  const name = page.getByLabel("Name", { exact: true });
  const energy = page.getByLabel("Energy (kcal)");
  await page.goto(`/#/food/new?barcode=${barcode}&notfound=1`);
  await name.fill(`Crisps ${tag}`);
  await energy.fill("520");
  await page.reload();
  await expect(name).toHaveValue(`Crisps ${tag}`);
  await expect(energy).toHaveValue("520");
  await expect(page.getByLabel("Barcode")).toHaveValue(barcode);

  // Listed under Drafts, it opens as left.
  await leaveForFoods(page);
  await draftRow(page, `Crisps ${tag}`).click();
  await expect(name).toHaveValue(`Crisps ${tag}`);
  await expect(page.getByLabel("Barcode")).toHaveValue(barcode);
});

test("a prefilled new food leaves an older draft whole, typed into or saved", async ({
  page,
}, testInfo) => {
  const { tag } = unique(1296, testInfo);
  const name = page.getByLabel("Name", { exact: true });
  await page.goto("/#/food/new");
  await name.fill(`Soup ${tag}`);
  await leaveForFoods(page);

  const bread = `Bread ${tag}`;
  const own = `food:new?name=${encodeURIComponent(bread).replaceAll("%20", "+")}`;
  await page.goto(`/#/food/new?name=${encodeURIComponent(bread)}`);
  await expect(name).toHaveValue(bread);
  const aside = page.locator(".note", { hasText: `Draft “Soup ${tag}”` });
  await expect(aside).toBeVisible();
  await name.fill(`${bread}x`);
  await expect
    .poll(async () => (await stored(page))[own]?.name)
    .toBe(`${bread}x`);
  expect((await stored(page))["food:new"].name).toBe(`Soup ${tag}`);
  // Clean again: its own draft goes, the older one stays.
  await name.fill(bread);
  await expect.poll(async () => own in (await stored(page))).toBe(false);
  expect((await stored(page))["food:new"].name).toBe(`Soup ${tag}`);
  await expect(aside).toBeVisible();

  await page.getByLabel("Energy (kcal)").fill("250");
  await save(page, `Saved ${bread}`);
  await foodsTab(page).click();
  await expect(draftRow(page, `Soup ${tag}`)).toBeVisible();
});

test("Merge from an editor with unsaved changes asks before leaving them", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(1297, testInfo);
  const jam = await food(request, {
    name: `Merge jam ${tag}`,
    per100: { energy: 250 },
  });
  const name = page.getByLabel("Name", { exact: true });
  const merge = page.getByRole("link", { name: "Merge…" });
  await page.goto(`/#/food/${jam.id}`);
  await name.fill(`Merge jam ${tag} light`);
  await merge.click();
  expect(await answer(page, "Stay")).toBe("Leave without saving?");
  await expect(name).toHaveValue(`Merge jam ${tag} light`);
  await merge.click();
  expect(await answer(page, "Leave")).toBe("Leave without saving?");
  await expect(
    page.getByRole("heading", { name: `Merge into Merge jam ${tag}` }),
  ).toBeVisible();
  // Left, the changes go: no draft to save at an old rev.
  await foodsTab(page).click();
  await expect(page.locator(".finder")).toBeVisible();
  await expect(draftsSection(page)).toHaveCount(0);
});

test("a draft of a food since deleted or merged away goes with it", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(1298, testInfo);
  const gone = await food(request, { name: `Gone ${tag}`, per100: {} });
  const dup = await food(request, { name: `Dup ${tag}`, per100: {} });
  const kept = await food(request, { name: `Kept ${tag}`, per100: {} });
  const name = page.getByLabel("Name", { exact: true });
  for (const f of [gone, dup]) {
    await page.goto(`/#/food/${f.id}`);
    await expect(name).toHaveValue(f.name);
    await name.fill(`${f.name} edited`);
    await leaveForFoods(page);
  }
  expect((await request.delete(`/api/foods/${gone.id}`)).ok()).toBeTruthy();
  await draftRow(page, `Gone ${tag} edited`).click();
  await expect(page.getByRole("heading", { name: "Not found" })).toBeVisible();
  await foodsTab(page).click();
  await expect(draftRow(page, `Dup ${tag} edited`)).toBeVisible();
  await expect(draftRow(page, `Gone ${tag} edited`)).toHaveCount(0);

  await page.goto(`/#/food/${kept.id}/merge`);
  await page.getByLabel("Search the duplicate").fill(`Dup ${tag}`);
  await page.getByRole("button", { name: starts(`Dup ${tag}`) }).click();
  await answer(page, "Merge");
  await expect(page).toHaveURL(new RegExp(`#/food/${kept.id}$`, "u"));
  await foodsTab(page).click();
  await expect(page.locator(".finder")).toBeVisible();
  await expect(draftsSection(page)).toHaveCount(0);
});

test("adding or removing a recipe's item keeps its draft", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(1299, testInfo);
  await food(request, { name: `Lentils ${tag}`, per100: { energy: 350 } });
  const items = async () => (await stored(page))["recipe:new"]?.items.length;
  await page.goto("/#/recipe/new");
  await page.getByLabel("Name", { exact: true }).fill(`Dal ${tag}`);
  await page.getByLabel("Search foods to add").fill(`Lentils ${tag}`);
  await page.getByRole("button", { name: starts(`Lentils ${tag}`) }).click();
  await page.getByLabel(`Lentils ${tag} quantity`).fill("200");
  await expect.poll(items).toBe(1);
  await page.getByRole("button", { name: `Remove Lentils ${tag}` }).click();
  await expect.poll(items).toBe(0);
});

test("a recipe told of a new food it can't read says so", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(1300, testInfo);
  const oats = await food(request, { name: `Oats ${tag}`, per100: {} });
  await page.route(`**/api/foods/${oats.id}`, (route) =>
    route.fulfill({ status: 500, body: "down" }),
  );
  await page.goto(`/#/recipe/new?add=${oats.id}`);
  await expect(page.getByRole("heading", { name: "New recipe" })).toBeVisible();
  await expect(page.locator("#toast")).toContainText(
    "Couldn't add the new food",
  );
});

test("a recipe adding a new food leaves the address alone once left", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(1301, testInfo);
  const oats = await food(request, { name: `Slow oats ${tag}`, per100: {} });
  let release = null;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  await page.route(`**/api/foods/${oats.id}`, async (route) => {
    await held;
    await route.continue();
  });
  const asked = page.waitForRequest(`**/api/foods/${oats.id}`);
  await page.goto(`/#/recipe/new?back=%23%2Fsummary&add=${oats.id}`);
  await asked;
  await foodsTab(page).click();
  await expect(page.locator(".finder")).toBeVisible();
  release();
  // The superseded editor ran on: it kept the food in the recipe's draft.
  await expect
    .poll(async () => (await stored(page))["recipe:new"]?.items.length)
    .toBe(1);
  await expect(page).toHaveURL(/#\/foods$/u);
});
