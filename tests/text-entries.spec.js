// One-off items (text entries): logged from the finder's "One-off item"
// or "Add … as a one-off" with a name, a time and maybe kcal; shown as
// text, edited, logged again, left out of a recipe; and "Find the food",
// which makes one that food's entry.

import { expect, test } from "@playwright/test";
import {
  entry,
  fixedToday,
  food,
  ownProfile,
  todayInApp,
  unique,
} from "./helpers.js";

test.beforeEach(({ page }) => fixedToday(page));

const shift = (day, n) =>
  new Date(Date.parse(day) + n * 864e5).toISOString().slice(0, 10);

const section = (page, name) =>
  page.locator(".group", {
    has: page.getByRole("heading", { name, exact: true }),
  });

const row = (page, name) =>
  section(page, "Eaten").locator("li.entry", { hasText: name });

// A text entry eaten on `day`: the entry.
async function textEntry(request, pid, day, name, energy = null) {
  const [made] = (
    await entry(request, { day, group: "Eaten", name, energy }, pid)
  ).entries;
  return made;
}

test("a text entry from the finder: name, kcal and time; without kcal the day is a floor", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(1213, testInfo);
  await ownProfile(page, request, `Text ${tag}`);
  const day = shift(todayInApp(), -1);
  await page.goto(`/#/add/${day}/Eaten`);
  await page
    .getByRole("searchbox", { name: "Search foods" })
    .fill(`Lunch ${tag}`);
  await page
    .getByRole("button", { name: `Add “Lunch ${tag}” as a one-off` })
    .click();
  const dialog = page.getByRole("dialog", { name: "One-off item" });
  await expect(dialog.getByRole("textbox", { name: "Name" })).toHaveValue(
    `Lunch ${tag}`,
  );
  await dialog.getByRole("textbox", { name: /^Energy/u }).fill("600");
  await dialog.getByRole("textbox", { name: "Time eaten" }).fill("12:30");
  await dialog.getByRole("button", { name: "Add to Eaten" }).click();
  await expect(page).toHaveURL(new RegExp(`#/day/${day}$`, "u"));
  const lunch = row(page, `Lunch ${tag}`);
  await expect(lunch.locator(".kcal")).toHaveText(/^≈\s600\skcal$/u);
  await expect(lunch).toContainText("One-off");
  await expect(lunch).toContainText("12:30");
  await expect(page.locator(".headline strong")).toHaveText(/^600\skcal$/u);

  await page.goto(`/#/add/${day}/Eaten`);
  await page
    .getByRole("searchbox", { name: "Search foods" })
    .fill(`Cake ${tag}`);
  await page
    .getByRole("button", { name: `Add “Cake ${tag}” as a one-off` })
    .click();
  await dialog.getByRole("button", { name: "Add to Eaten" }).click();
  await expect(row(page, `Cake ${tag}`).locator(".kcal")).toHaveText(
    "Estimate kcal",
  );
  await expect(page.locator(".headline strong")).toHaveText(/^≥\s600\skcal/u);
  await expect(page.locator(".headline")).toContainText(
    "a one-off item without kcal",
  );
});

test("an Add screen offers a one-off item before anything is searched", async ({
  page,
}, testInfo) => {
  const { day, tag } = unique(1216, testInfo);
  await ownProfile(page, page.request, `Unknown ${tag}`);
  await page.goto(`/#/add/${day}/Eaten`);
  await page.getByRole("button", { name: "One-off item" }).click();
  const dialog = page.getByRole("dialog", { name: "One-off item" });
  await expect(dialog.getByRole("textbox", { name: "Name" })).toHaveValue("");
  await dialog.getByRole("textbox", { name: "Name" }).fill(`Mystery ${tag}`);
  await dialog.getByRole("button", { name: "Add to Eaten" }).click();
  await expect(row(page, `Mystery ${tag}`).locator(".kcal")).toHaveText(
    "Estimate kcal",
  );
});

test("a text entry is edited, logged again and left out of a recipe", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(1214, testInfo);
  const pid = await ownProfile(page, request, `Edit ${tag}`);
  const day = shift(todayInApp(), -1);
  const made = await textEntry(request, pid, day, `Lunch ${tag}`, 600);
  await page.goto(`/#/entry/${made.id}`);
  // A text entry repeats no food daily.
  await expect(
    page.getByRole("checkbox", { name: "Repeat daily" }),
  ).toHaveCount(0);
  await page.getByRole("textbox", { name: "Name" }).fill(`Pizza ${tag}`);
  await page.getByRole("textbox", { name: /^Energy/u }).fill("900");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#/day/${day}$`, "u"));
  await expect(row(page, `Pizza ${tag}`).locator(".kcal")).toHaveText(
    /^≈\s900\skcal$/u,
  );

  // A recipe is of foods: a text entry is left out, and says so.
  const oats = await food(request, {
    name: `Oats ${tag}`,
    per100: { energy: 400 },
  });
  await entry(
    request,
    { day, group: "Eaten", food_id: oats.id, grams: 50 },
    pid,
  );
  await page.reload();
  const eaten = section(page, "Eaten");
  await eaten.getByRole("button", { name: "Select from Eaten" }).click();
  await eaten.getByRole("checkbox", { name: `Pizza ${tag}` }).check();
  await expect(
    eaten.getByRole("button", { name: "Save as recipe…" }),
  ).toBeDisabled();
  await eaten.getByRole("checkbox", { name: `Oats ${tag}` }).check();
  await eaten.getByRole("button", { name: "Save as recipe…" }).click();
  const dialog = page.getByRole("dialog", { name: "Save as recipe" });
  await dialog.getByRole("textbox", { name: "Name" }).fill(`Bowl ${tag}`);
  await dialog.getByRole("button", { name: "Save as recipe" }).click();
  await expect(page.locator("#toast .toast-text")).toHaveText(
    `Saved recipe Bowl ${tag} · 1 one-off item left out`,
  );

  // Log again keeps it text.
  await page.goto(`/#/entry/${made.id}`);
  await page.getByRole("button", { name: "Log again today" }).click();
  await expect(page.locator("#toast .toast-text")).toHaveText("Added to today");
  const days = await (
    await request.get(`/api/profiles/${pid}/day/${todayInApp()}`)
  ).json();
  const copy = days.groups.flatMap((g) => g.entries)[0];
  expect([copy.name, copy.food_id, copy.nutrients]).toEqual([
    `Pizza ${tag}`,
    null,
    { energy: 900 },
  ]);
});

test("find the food: a text entry becomes that food's entry in place", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(1215, testInfo);
  const pid = await ownProfile(page, request, `Find ${tag}`);
  const day = shift(todayInApp(), -1);
  const oats = await food(request, {
    name: `Porridge ${tag}`,
    per100: { energy: 70 },
  });
  const [made] = (
    await entry(
      request,
      {
        day,
        group: "Eaten",
        name: `Porridge ${tag}`,
        energy: 300,
        time: "08:00",
      },
      pid,
    )
  ).entries;
  await page.goto(`/#/entry/${made.id}`);
  await page.getByRole("link", { name: "Find the food" }).click();
  // The finder, searched by its name; nothing here but finding the food.
  await expect(
    page.getByRole("searchbox", { name: "Search foods" }),
  ).toHaveValue(`Porridge ${tag}`);
  await expect(page.getByRole("link", { name: "Scan barcode" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Water" })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /as a one-off$/u }),
  ).toHaveCount(0);
  const result = page.getByRole("button", {
    name: new RegExp(`^Porridge ${tag} \\d`, "u"),
  });
  await result.click();
  // Back returns to the search.
  await page.getByRole("link", { name: "Back" }).click();
  await expect(
    page.getByRole("searchbox", { name: "Search foods" }),
  ).toHaveValue(`Porridge ${tag}`);
  await result.click();
  await page.getByRole("textbox", { name: "Quantity" }).fill("300");
  await page.getByRole("button", { name: "Use this food" }).click();
  await expect(page).toHaveURL(new RegExp(`#/day/${day}$`, "u"));
  const toast = page.locator("#toast");
  await expect(toast.locator(".toast-text")).toHaveText(
    `Matched to Porridge ${tag}`,
  );
  await expect(toast.getByRole("button", { name: "Undo" })).toHaveCount(0);
  const after = await (
    await request.get(`/api/profiles/${pid}/entries/${made.id}`)
  ).json();
  expect([
    after.uid,
    after.time,
    after.food_id,
    after.nutrients.energy,
  ]).toEqual([made.uid, "08:00", oats.id, 210]);
});

test("a one-off item: a size chip fills its kcal, its macros fold open", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(1222, testInfo);
  const pid = await ownProfile(page, request, `Chips ${tag}`);
  const day = shift(todayInApp(), -1);
  await page.goto(`/#/add/${day}/Eaten`);
  await page.getByRole("button", { name: "One-off item" }).click();
  const dialog = page.getByRole("dialog", { name: "One-off item" });
  const kcal = dialog.getByRole("textbox", { name: /^Energy/u });
  await expect(dialog.locator(".chips .chip")).toHaveText([
    /^Snack\s≈\s200$/u,
    /^Meal\s≈\s600$/u,
    /^Big meal\s≈\s1,000$/u,
  ]);
  await dialog.getByRole("button", { name: /^Meal/u }).click();
  await expect(kcal).toHaveValue("600");
  const protein = dialog.getByRole("textbox", { name: /^Protein/u });
  await expect(protein).toBeHidden();
  await dialog.getByText("Protein, carbs and fat").click();
  await dialog.getByRole("textbox", { name: "Name" }).fill(`Burrito ${tag}`);
  await protein.fill("30");
  await dialog.getByRole("textbox", { name: /^Carbs/u }).fill("60");
  await dialog.getByRole("textbox", { name: /^Fat/u }).fill("20");
  await dialog.getByRole("button", { name: "Add to Eaten" }).click();
  const burrito = row(page, `Burrito ${tag}`);
  await expect(burrito.locator(".kcal")).toHaveText(/^≈\s600\skcal$/u);
  await expect(burrito).toContainText(/P\s30 · C\s60 · F\s20\sg/u);
  const d = await (await request.get(`/api/profiles/${pid}/day/${day}`)).json();
  expect(d.groups[1].entries[0].nutrients).toEqual({
    energy: 600,
    protein: 30,
    carbs: 60,
    fat: 20,
  });
});

test("a one-off item without kcal: Estimate kcal opens its editor, which takes macros", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(1223, testInfo);
  const pid = await ownProfile(page, request, `Estimate ${tag}`);
  const day = shift(todayInApp(), -1);
  await textEntry(request, pid, day, `Cake ${tag}`);
  await page.goto(`/#/day/${day}`);
  await row(page, `Cake ${tag}`).getByText("Estimate kcal").click();
  await expect(page.locator(".chips .chip")).toHaveCount(0);
  await page.getByRole("textbox", { name: /^Energy/u }).fill("400");
  await page.getByText("Protein, carbs and fat").click();
  await page.getByRole("textbox", { name: /^Fat/u }).fill("25");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#/day/${day}$`, "u"));
  const cake = row(page, `Cake ${tag}`);
  await expect(cake.locator(".kcal")).toHaveText(/^≈\s400\skcal$/u);
  await expect(cake).toContainText(/F\s25\sg/u);
  await expect(cake).not.toContainText(/P\s/u);
});
