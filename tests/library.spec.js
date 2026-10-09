// The food library: recipe portions and instructions, merging duplicates,
// the Open Food Facts link and the best-fit sort.

import { test, expect } from "@playwright/test";
import {
  unique,
  starts,
  food,
  entry,
  answer,
  headline,
  ownProfile,
} from "./helpers.js";

test("a recipe that makes portions logs one portion", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag } = unique(360, testInfo);
  await food(request, { name: `Lentils ${tag}`, per100: { energy: 120 } });

  await page.goto("/#/recipe/new");
  await page.getByLabel("Name").fill(`Dal ${tag}`);
  await page.getByLabel("Search foods to add").fill(`Lentils ${tag}`);
  await page.getByRole("button", { name: starts(`Lentils ${tag}`) }).click();
  await page.getByLabel(`Lentils ${tag} grams`).fill("800");
  await page.getByLabel("Makes (portions)").fill("4");
  // The portion follows the weight, live, after the whole recipe.
  const portion = page.locator(".servings .serving").nth(1);
  await expect(portion).toContainText(/Portion\s*200\s*g/);
  await page.getByRole("button", { name: "Make Portion the default" }).click();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.locator("#toast")).toContainText(`Saved Dal ${tag}`);
  await expect(page.locator(".servings .serving").first()).toContainText(
    /Portion\s*200\s*g/,
  );

  await page.goto(`/#/add/${day}/Consumed`);
  await page.getByLabel("Search foods", { exact: true }).fill(`Dal ${tag}`);
  await page.getByRole("button", { name: starts(`Dal ${tag}`) }).click();
  await expect(page.getByLabel("Unit").locator("option:checked")).toHaveText(
    /^Portion/,
  );
  await page.getByRole("button", { name: "Add to Eaten" }).click();
  // 960 kcal over 4 portions.
  await expect(headline(page)).toHaveText("240 kcal");
});

test("a recipe's instructions: typed in its editor, shown as written when logging it", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag } = unique(614, testInfo);
  await ownProfile(page, request, `Cook ${tag}`);
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
  const recipe = await res.json();
  await page.goto(`/#/recipe/${recipe.id}`);
  const box = page.getByLabel("Instructions");
  await expect(box).toHaveValue("");
  await expect(box).toHaveAttribute("maxlength", "10000");
  const before = (await box.boundingBox()).height;
  const text = "1. Boil 3 dl water.\n2. Stir in the <b>oats</b>.\n\n3. Eat.";
  await box.fill(`${text}\n\n\n\n\n\n\n\nMore.`);
  // It grows with what's typed.
  expect((await box.boundingBox()).height).toBeGreaterThan(before);
  await box.fill(text);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator("#toast")).toContainText(`Saved Porridge ${tag}`);
  await page.reload();
  await expect(page.getByLabel("Instructions")).toHaveValue(text);

  await page.goto(`/#/log/${day}/Consumed/${recipe.id}`);
  const shown = page.locator(".instructions");
  await expect(
    shown.getByRole("heading", { name: "Instructions" }),
  ).toBeVisible();
  // Line breaks kept; markup shown as text, never made into HTML.
  expect(await shown.locator(".instructions-text").innerText()).toBe(text);
  await expect(shown.locator("b")).toHaveCount(0);

  // A plain food shows none.
  await page.goto(`/#/log/${day}/Consumed/${oats.id}`);
  await expect(
    page.getByRole("heading", { name: `Oats ${tag}` }),
  ).toBeVisible();
  await expect(page.locator(".instructions")).toHaveCount(0);
});

test("merge a duplicate food into the one kept", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag } = unique(361, testInfo);
  const keep = await food(request, {
    name: `Skyr ${tag}`,
    per100: { energy: 60 },
  });
  const dup = await food(request, {
    name: `Skyr dup ${tag}`,
    per100: { energy: 65 },
    servings: [{ label: "Cup", grams: 150 }],
  });
  await entry(request, {
    day,
    group: "Consumed",
    food_id: dup.id,
    grams: 150,
  });

  await page.goto(`/#/food/${keep.id}`);
  await page.getByRole("link", { name: "Merge…" }).click();
  await expect(
    page.getByRole("heading", { name: `Merge into Skyr ${tag}` }),
  ).toBeVisible();
  await page.getByLabel("Search the duplicate").fill(`Skyr ${tag}`);
  // The kept food itself can't be picked.
  await expect(
    page.getByRole("button", { name: starts(`Skyr ${tag}`) }),
  ).toBeDisabled();
  await page.getByLabel("Search the duplicate").fill(`Skyr dup ${tag}`);
  await page.getByRole("button", { name: starts(`Skyr dup ${tag}`) }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText(
    `1 diary entry, 0 recipes, 0 meals and 0 favourites move to Skyr ${tag}.`,
  );
  await expect(dialog).toContainText("This can't be undone.");
  expect(await answer(page, "Merge")).toBe(
    `Merge Skyr dup ${tag} into Skyr ${tag}?`,
  );
  await expect(page.locator("#toast")).toContainText(
    `Merged Skyr dup ${tag} into Skyr ${tag}`,
  );
  // Back on the kept food, which took the duplicate's serving.
  await expect(page).toHaveURL(new RegExp(`#/food/${keep.id}$`));
  await expect(page.getByLabel("Serving name").first()).toHaveValue("Cup");
  expect((await request.get(`/api/foods/${dup.id}`)).status()).toBe(404);
  // The diary entry now opens the kept food.
  const dayView = await (
    await request.get(`/api/profiles/1/day/${day}`)
  ).json();
  expect(dayView.groups[1].entries[0].food_id).toBe(keep.id);
});

test("a recipe merges only with a recipe", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(362, testInfo);
  const plain = await food(request, {
    name: `Broth ${tag}`,
    per100: { energy: 10 },
  });
  const res = await request.post("/api/recipes", {
    data: {
      name: `Broth soup ${tag}`,
      items: [{ food_id: plain.id, grams: 500 }],
    },
  });
  expect(res.ok()).toBeTruthy();

  await page.goto(`/#/food/${plain.id}/merge`);
  await page.getByLabel("Search the duplicate").fill(`Broth soup ${tag}`);
  const row = page.getByRole("button", { name: starts(`Broth soup ${tag}`) });
  await expect(row).toBeDisabled();
  await expect(row).toContainText("a recipe");
});

test("a barcode Open Food Facts lacks links to adding it there", async ({
  page,
}, testInfo) => {
  const { barcode } = unique(363, testInfo);
  await page.goto(`/#/food/new?barcode=${barcode}&notfound=1`);
  const note = page.locator(".note");
  await expect(note).toContainText(
    "Not in your foods or Open Food Facts. Enter it from its label. · Add it on Open Food Facts",
  );
  const link = note.getByRole("link", { name: "Add it on Open Food Facts" });
  await expect(link).toHaveAttribute(
    "href",
    `https://world.openfoodfacts.org/cgi/product.pl?type=add&code=${barcode}`,
  );
  // No Referer leaves: the server sends Referrer-Policy: no-referrer.
  await expect(link).toHaveAttribute("rel", "noopener");
});

// A profile of the test's own with these targets (`{metric: value}`).
async function targeted(page, request, name, targets) {
  const pid = await ownProfile(page, request, name);
  const profile = await (await request.get(`/api/profiles/${pid}`)).json();
  const res = await request.put(`/api/profiles/${pid}/targets`, {
    data: {
      rev: profile.rev,
      targets: Object.entries(targets).map(([metric, value]) => ({
        metric,
        value,
      })),
    },
  });
  expect(res.ok()).toBeTruthy();
}

test("best fit ranks by what's left, for this visit only", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag } = unique(364, testInfo);
  // Only protein is left to eat.
  await targeted(page, request, `Fit ${tag}`, {
    energy: 2000,
    protein: 150,
    net_carbs: 0,
    fat: 0,
  });
  await food(request, {
    name: `Fudge ${tag}`,
    per100: { energy: 450, net_carbs: 70, fat: 18 },
  });
  await food(request, {
    name: `Tuna ${tag}`,
    per100: { energy: 110, protein: 25, fat: 1 },
  });

  await page.goto(`/#/add/${day}/Consumed`);
  await page.getByRole("button", { name: "Filters" }).click();
  await page.getByLabel("Sort").selectOption("Best fit for today");
  await expect(
    page.getByText(
      "Closest to the protein, carbs and fat you have left, with a serving that fits the energy left.",
    ),
  ).toBeVisible();
  await page.getByLabel("Search foods", { exact: true }).fill(tag);
  const results = page.locator(".finder-results .result .name");
  await expect(results).toHaveText([`Tuna ${tag}`, `Fudge ${tag}`]);

  // Never remembered: the finder opens on Favourites again.
  const saved = await page.evaluate(() => localStorage.getItem("food-filters"));
  expect(saved ?? "").not.toContain("fit");
  await page.reload();
  await expect(page.getByRole("heading", { name: "Favourites" })).toBeVisible();
  await page.getByRole("button", { name: "Filters" }).click();
  await expect(page.getByLabel("Sort")).toHaveValue("relevance");
});

test("best fit isn't offered without an energy target", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag } = unique(365, testInfo);
  await targeted(page, request, `No fit ${tag}`, { protein: 100 });
  await page.goto(`/#/add/${day}/Consumed`);
  await page.getByRole("button", { name: "Filters" }).click();
  await expect(page.getByLabel("Sort").locator("option")).toHaveText([
    "Best match",
    "Name",
    "Lowest energy",
    "Most protein",
    "Most protein per kcal",
  ]);
});
