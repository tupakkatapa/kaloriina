// Profile export and import, and energy in kJ on this device.

import { readFile } from "node:fs/promises";

import { test, expect } from "@playwright/test";
import {
  unique,
  starts,
  entry,
  food,
  ownProfile,
  headline,
} from "./helpers.js";

test("a profile exports to a file and imports back as a new one", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag } = unique(441, testInfo);
  const name = `Export ${tag}`;
  const pid = await ownProfile(page, request, name);
  const oats = await food(request, {
    name: `Oats ${tag}`,
    per100: { energy: 380 },
  });
  await entry(
    request,
    { day, group: "Consumed", food_id: oats.id, grams: 50, time: "07:45" },
    pid,
  );

  await page.goto("/#/profile");
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("link", { name: starts(`Export ${name}`) }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(
    // Browsers take the UTF-8 name (`filename*`): the profile as spelt.
    new RegExp(`^kaloriina-Export ${tag}-\\d{4}-\\d{2}-\\d{2}\\.json$`),
  );
  const path = await download.path();
  const file = JSON.parse(await readFile(path, "utf8"));
  expect(file.format).toBe("kaloriina-profile");
  expect(file.entries).toHaveLength(1);

  // The file's name is taken: the dialog says so and stays open.
  await page.getByRole("button", { name: starts("Import a profile") }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Export file").setInputFiles(path);
  await expect(dialog.getByLabel("Name")).toHaveValue(name);
  await dialog.getByRole("button", { name: "Import" }).click();
  await expect(dialog.getByRole("alert")).toContainText("already exists");

  await dialog.getByLabel("Name").fill(`Copy ${tag}`);
  await dialog.getByRole("button", { name: "Import" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("status")).toContainText(`Imported Copy ${tag}`);
  await expect(
    page.getByRole("button", { name: `Use Copy ${tag}` }),
  ).toBeVisible();
  await page.getByRole("status").getByRole("button", { name: "Use" }).click();
  await expect(page).toHaveURL(/#\/$/);
  await page.goto(`/#/day/${day}`);
  // The copy, in use: its own diary holds the entry.
  await expect(
    page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: `Profile: Copy ${tag}` }),
  ).toBeVisible();
  await expect(page.getByText(`Oats ${tag}`)).toBeVisible();
  await expect(page.getByText("07:45 · 50 g")).toBeVisible();
  await expect(headline(page)).toHaveText("190 kcal");
});

test("energy in kJ changes the diary's headline and bars", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag } = unique(440, testInfo);
  const pid = await ownProfile(page, request, `Kilojoules ${tag}`);
  const bread = await food(request, {
    name: `Bread ${tag}`,
    per100: { energy: 100 },
  });
  await entry(
    request,
    { day, group: "Consumed", food_id: bread.id, grams: 200 },
    pid,
  );
  const energyBar = page.locator(".target.k-energy .target-label").first();

  await page.goto(`/#/day/${day}`);
  await expect(headline(page)).toHaveText("200 kcal");
  await expect(energyBar).toContainText("200 kcal / ");
  await expect(energyBar).toHaveText(/ kcal$/);

  await page.goto("/#/profile");
  await expect(
    page.getByRole("heading", { name: "This device" }),
  ).toBeVisible();
  const unit = page.getByRole("radiogroup", { name: "Energy in" });
  await unit.getByRole("radio", { name: "kJ" }).click();
  await expect(page.getByRole("link", { name: /^Targets/ })).toContainText(
    " kJ",
  );

  await page.goto(`/#/day/${day}`);
  await expect(headline(page)).toHaveText("837 kJ");
  // The aside gives the other unit, not the same one again.
  await expect(page.locator(".headline .muted").first()).toHaveText(
    / \(200\skcal\) eaten/,
  );
  await expect(energyBar).toContainText("837 kJ / ");
  await expect(energyBar).toHaveText(/ kJ$/);
  // Kept on this device across loads; inputs keep saying their unit.
  await page.reload();
  await expect(headline(page)).toHaveText("837 kJ");
  await page.goto(`/#/food/${bread.id}`);
  await expect(page.getByLabel("Energy (kJ)")).toHaveValue("418.4");
  await expect(page.getByLabel("Energy (kcal)")).toHaveValue("100");
  // The Summary's charts and list too.
  await page.goto(`/#/summary/week/${day}`);
  await expect(
    page.getByRole("img", { name: /^Energy by day/ }),
  ).toHaveAttribute(
    "aria-label",
    /average kJ per logged day, target [\d,]+ kJ/,
  );
  await expect(page.locator(".days li").first()).toContainText("837 kJ");

  await page.goto("/#/profile");
  await unit.getByRole("radio", { name: "kcal" }).click();
  await page.goto(`/#/day/${day}`);
  await expect(headline(page)).toHaveText("200 kcal");
});
