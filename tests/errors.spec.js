// Screens that can't be built from their address: the error screen has the
// Not found shell (back and the tab's way home), and a nutrient's sources
// without a range show this month instead of failing.

import { expect, test } from "@playwright/test";

test("a bad address shows why, with a way back", async ({ page }) => {
  await page.goto("/#/day/2026-13-45");
  await expect(
    page.getByRole("heading", { name: "Something went wrong" }),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByRole("link", { name: "Back" })).toBeVisible();
  await page.getByRole("link", { name: "Go to today" }).click();
  await expect(page.getByRole("heading", { name: "Today" })).toBeVisible();
});

test("a nutrient's sources without a range show this month", async ({
  page,
}) => {
  await page.goto("/#/sources/protein");
  await expect(
    page.getByRole("heading", { name: "Where protein comes from" }),
  ).toBeVisible();
  const month = await page.evaluate(() =>
    new Date().toLocaleDateString(undefined, { month: "short" }),
  );
  await expect(page.locator("section > p.muted").first()).toHaveText(
    new RegExp(`^${month} 1 – ${month} \\d+ · `, "u"),
  );
});
