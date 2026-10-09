// Cronometer history imported from the Profile tab.

import { test, expect } from "@playwright/test";
import { unique, starts, ownProfile } from "./helpers.js";

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
