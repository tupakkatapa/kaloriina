// The Profile tab says when the newest backup copy was taken, and when the
// backup job or the disk needs looking at. The scratch server runs without
// --backup-dir, so it answers `configured: false`; the rest comes from a
// mock over that real answer.

import { expect, test } from "@playwright/test";
import { mockJson, ownProfile, unique } from "./helpers.js";

const HOUR = 3600 * 1000;
const GB = 1e9;
const row = (page) =>
  page.getByRole("listitem").filter({ hasText: /^Backups/u });
// A server backing up, its disk half free; `patch` over that.
const backingUp = (page, patch) =>
  mockJson(page, "**/api/backups", (real) => ({
    ...real,
    configured: true,
    free_bytes: 50 * GB,
    total_bytes: 100 * GB,
    ...patch,
  }));

test("without backups the Profile tab says nothing of them", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(940, testInfo);
  await ownProfile(page, request, `Nobackup ${tag}`);
  const answer = page.waitForResponse("**/api/backups");
  await page.goto("/#/profile");
  expect(await (await answer).json()).toMatchObject({
    configured: false,
    newest: null,
    stale: false,
  });
  await expect(page.getByRole("link", { name: /^Connections/u })).toBeVisible();
  await expect(row(page)).toHaveCount(0);
});

test("a fresh copy shows its age", async ({ page, request }, testInfo) => {
  const { tag } = unique(941, testInfo);
  await ownProfile(page, request, `Fresh ${tag}`);
  await backingUp(page, { newest: Date.now() - 3 * HOUR, stale: false });
  await page.goto("/#/profile");
  await expect(row(page)).toHaveText("BackupsLast copy 3 hours ago");
  await expect(row(page).locator(".error")).toHaveCount(0);
});

test("a stale copy is a warning", async ({ page, request }, testInfo) => {
  const { tag } = unique(942, testInfo);
  await ownProfile(page, request, `Stale ${tag}`);
  await backingUp(page, { newest: Date.now() - 49 * HOUR, stale: true });
  await page.goto("/#/profile");
  await expect(row(page).locator(".error")).toHaveText(
    "Last copy 2 days ago: check the backup job",
  );
});

test("a backup job that never made a copy is an error", async ({
  page,
  request,
}, testInfo) => {
  // The job can fail from its first night (a wrong dir, a full disk):
  // the row shows before any copy exists.
  const { tag } = unique(1064, testInfo);
  await ownProfile(page, request, `Nocopy ${tag}`);
  await backingUp(page, { newest: null, stale: true });
  await page.goto("/#/profile");
  await expect(row(page).locator(".error")).toHaveText(
    "No backup copy yet: check the backup job",
  );
});

test("a disk under 10 % free is a warning", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(1065, testInfo);
  await ownProfile(page, request, `Lowdisk ${tag}`);
  await backingUp(page, {
    newest: Date.now() - 3 * HOUR,
    stale: false,
    free_bytes: 7 * GB,
  });
  await page.goto("/#/profile");
  await expect(row(page)).toHaveText(
    "BackupsLast copy 3 hours ago · Disk space low: 7 % free",
  );
  await expect(row(page).locator(".error")).toHaveText(
    "Disk space low: 7 % free",
  );
});
