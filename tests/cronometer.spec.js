// Cronometer history imported from the Profile tab.

import { expect, test } from "@playwright/test";
import {
  food,
  importsTakeTurns,
  ownProfile,
  postImport,
  starts,
  unique,
} from "./helpers.js";

test.beforeEach(({ page }) => importsTakeTurns(page));

// Relative to the repo root, where Playwright runs.
const fixture = (name) => `tests/fixtures/${name}`;

test("Cronometer's export imports into the profile in use", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(460, testInfo);
  await ownProfile(page, request, `Cronometer ${tag}`);
  await page.goto("/#/profile");
  await page
    .getByRole("button", { name: starts("Import from Cronometer") })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("never touched");

  // Nothing chosen: the dialog says so and stays open.
  await dialog.getByRole("button", { name: "Import" }).click();
  await expect(dialog.getByRole("alert")).toContainText("at least one file");

  // The files swapped: the server names the file it wanted.
  await dialog
    .getByLabel("Servings")
    .setInputFiles(fixture("dailysummary.csv"));
  await dialog.getByRole("button", { name: "Import" }).click();
  await expect(dialog.getByRole("alert")).toContainText("servings.csv");

  await dialog.getByLabel("Servings").setInputFiles(fixture("servings.csv"));
  await dialog
    .getByLabel("Daily summary")
    .setInputFiles(fixture("dailysummary.csv"));
  await dialog.getByRole("button", { name: "Import" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("status")).toContainText(
    "Imported 5 entries over 3 days",
  );

  await page.goto("/#/day/2026-06-02");
  await expect(page.getByText("Oat Porridge")).toBeVisible();
  await expect(page.getByText("Rye Bread, Sliced")).toBeVisible();
});

test("an imported row is matched to a food", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(273, testInfo);
  const pid = await ownProfile(page, request, `Matched ${tag}`);
  const servings =
    "Day,Group,Food Name,Amount\n" +
    "2026-06-02,Consumed,Creatine,5.00 g\n" +
    "2026-06-03,Consumed,Creatine,1.00 x 5.0 ml\n";
  const res = await postImport(
    request,
    `/api/profiles/${pid}/import/cronometer`,
    { servings },
  );
  expect(res.ok()).toBeTruthy();
  await food(request, {
    name: `Kreatiini ${tag}`,
    per100: { creatine: 100, energy: 0 },
  });

  await page.goto("/#/day/2026-06-02");
  await page.getByRole("link", { name: starts("Creatine") }).click();
  await page.getByLabel("Match to a food").fill(`Kreatiini ${tag}`);
  await page.getByRole("button", { name: starts(`Kreatiini ${tag}`) }).click();
  await expect(page.getByRole("status")).toContainText(
    `Matched 1 row of Creatine to Kreatiini ${tag} · 1 row not matched: amount not in grams`,
  );
  await page.getByRole("link", { name: starts("Creatine") }).click();
  await expect(
    page.getByText(`counted as Kreatiini ${tag}`, { exact: false }),
  ).toBeVisible();
});
