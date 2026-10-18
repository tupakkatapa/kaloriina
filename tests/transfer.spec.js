// Profile export and import, and energy in kJ on this device.

import { readFile } from "node:fs/promises";

import { expect, test } from "@playwright/test";
import {
  entry,
  food,
  headline,
  importsTakeTurns,
  loseFirstAnswer,
  ownProfile,
  starts,
  unique,
} from "./helpers.js";

test.beforeEach(({ page }) => importsTakeTurns(page));

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
    { day, group: "Eaten", food_id: oats.id, grams: 50, time: "07:45" },
    pid,
  );

  await page.goto("/#/profile");
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("link", { name: starts(`Export ${name}`) }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(
    // Browsers take the UTF-8 name (`filename*`): the profile as spelt.
    new RegExp(`^kaloriina-Export ${tag}-\\d{4}-\\d{2}-\\d{2}\\.json$`, "u"),
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
  await expect(page).toHaveURL(/#\/$/u);
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
  const { tag } = unique(440, testInfo);
  // The profile is its own, so its day can be a fixed one, near today:
  // `unique()`'s day lies centuries ahead in later runs, and Summary reads
  // from 90 days before today through the week shown.
  const day = "2026-03-11";
  const pid = await ownProfile(page, request, `Kilojoules ${tag}`);
  const bread = await food(request, {
    name: `Bread ${tag}`,
    per100: { energy: 100 },
  });
  await entry(
    request,
    { day, group: "Eaten", food_id: bread.id, grams: 200 },
    pid,
  );
  const energyBar = page.locator(".target.k-energy .target-label").first();

  await page.goto(`/#/day/${day}`);
  await expect(headline(page)).toHaveText("200 kcal");
  await expect(energyBar).toContainText("200 kcal / ");
  await expect(energyBar).toHaveText(/ kcal$/u);

  await page.goto("/#/profile");
  await expect(
    page.getByRole("heading", { name: "This browser" }),
  ).toBeVisible();
  const unit = page.getByRole("radiogroup", { name: "Energy in" });
  await unit.getByRole("radio", { name: "kJ" }).click();
  await expect(page.getByRole("link", { name: /^Targets/u })).toContainText(
    " kJ",
  );

  await page.goto(`/#/day/${day}`);
  await expect(headline(page)).toHaveText("837 kJ");
  // One unit only: no other unit in brackets.
  await expect(page.locator(".headline .muted").first()).toHaveText(" eaten");
  await expect(energyBar).toContainText("837 kJ / ");
  await expect(energyBar).toHaveText(/ kJ$/u);
  // Kept on this device across loads; inputs keep saying their unit.
  await page.reload();
  await expect(headline(page)).toHaveText("837 kJ");
  await page.goto(`/#/food/${bread.id}`);
  // Whole kJ, as everywhere energy shows.
  await expect(page.getByLabel("Energy (kJ)")).toHaveValue("418");
  await expect(page.getByLabel("Energy (kcal)")).toHaveCount(0);
  // A session's energy follows the unit too.
  await page.goto(`/#/activity/new?day=${day}&type=run`);
  await expect(page.getByLabel("Energy (kJ, total)")).toBeVisible();
  // The Summary's charts and list too.
  await page.goto(`/#/summary/week/${day}`);
  await expect(
    page.getByRole("img", { name: /^Energy by day/u }),
  ).toHaveAttribute("aria-label", /^Energy by day, kJ: /u);
  const list = page.locator(".chart-section").first().locator("ul.sr-only li");
  await expect(list.first()).toContainText("eaten 837 kJ");
  await expect(
    list.filter({ hasText: /^Eaten target: [\d,]+\skJ(–[\d,]+\skJ)?$/u }),
  ).not.toHaveCount(0);

  await page.goto("/#/profile");
  await unit.getByRole("radio", { name: "kcal" }).click();
  await page.goto(`/#/day/${day}`);
  await expect(headline(page)).toHaveText("200 kcal");
});

// An import whose answer was lost, sent again, makes one profile.
test("a profile import retried after a lost answer makes one profile", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(442, testInfo);
  const name = `Lost import ${tag}`;
  await ownProfile(page, request, `Source ${tag}`);
  await page.goto("/#/profile");
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("link", { name: starts(`Export Source ${tag}`) }).click(),
  ]);
  await loseFirstAnswer(page, "POST", "**/api/profiles/import*");
  await page.getByRole("button", { name: starts("Import a profile") }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Export file").setInputFiles(await download.path());
  await dialog.getByLabel("Name").fill(name);
  await dialog.getByRole("button", { name: "Import" }).click();
  await expect(dialog.getByRole("alert")).not.toBeEmpty();
  await dialog.getByRole("button", { name: "Import" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("status")).toContainText(`Imported ${name}`);
  const all = await (await request.get("/api/profiles")).json();
  expect(all.filter((p) => p.name === name)).toHaveLength(1);
});
