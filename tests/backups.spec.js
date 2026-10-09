// The Profile tab says when the newest backup copy was taken.
// The scratch server runs without --backup-dir, so its answer is
// `{newest: null}`; a time comes from a mock over that real answer.

import { test, expect } from "@playwright/test";
import { unique, mockJson, ownProfile } from "./helpers.js";

const HOUR = 3600 * 1000;
const row = (page) =>
  page.getByRole("listitem").filter({ hasText: /^Backups/ });

test("without backups the Profile tab says nothing of them", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(940, testInfo);
  await ownProfile(page, request, `Nobackup ${tag}`);
  const answer = page.waitForResponse("**/api/backups");
  await page.goto("/#/profile");
  expect(await (await answer).json()).toEqual({ newest: null });
  await expect(page.getByRole("link", { name: /^Connections/ })).toBeVisible();
  await expect(row(page)).toHaveCount(0);
});

test("a fresh copy shows its age", async ({ page, request }, testInfo) => {
  const { tag } = unique(941, testInfo);
  await ownProfile(page, request, `Fresh ${tag}`);
  await mockJson(page, "**/api/backups", () => ({
    newest: Date.now() - 3 * HOUR,
  }));
  await page.goto("/#/profile");
  await expect(row(page)).toHaveText("BackupsLast copy 3 hours ago");
  await expect(row(page).locator(".error")).toHaveCount(0);
});

test("a copy over 48 hours old is a warning", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(942, testInfo);
  await ownProfile(page, request, `Stale ${tag}`);
  await mockJson(page, "**/api/backups", () => ({
    newest: Date.now() - 49 * HOUR,
  }));
  await page.goto("/#/profile");
  await expect(row(page).locator(".error")).toHaveText(
    "Last copy 2 days ago: check the backup job",
  );
});
