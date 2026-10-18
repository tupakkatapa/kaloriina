// Google Health from a Takeout zip, imported (and removed) in Profile →
// Connections: the zip is built here, synthetic, in the export's shape.

import { setTimeout as delay } from "node:timers/promises";
import { expect, test } from "@playwright/test";
import {
  answer,
  importsTakeTurns,
  ownProfile,
  starts,
  unique,
} from "./helpers.js";
import { makeZip } from "./zip.mjs";

const GH = "Takeout/Google Health";

// Each test imports into a profile of its own, so the days can be fixed
// ones; in the past, as the server takes no day after tomorrow.
const DAY = "2026-01-15";

// A walk at noon UTC and the day's steps: the same day in any zone.
const takeout = (day) =>
  makeZip([
    { name: `${GH}/Paired Devices/Devices.csv`, text: "unrelated\n" },
    {
      name: `${GH}/Health Fitness Data_GoogleData/UserExercises_2026-05-31.csv`,
      text:
        "exercise_id,exercise_start,exercise_end,utc_offset,activity_name,deletion_reason,manually_logged_total_calories,tracker_total_calories,manually_logged_total_distance_mm,tracker_total_distance_mm\n" +
        `930,${day}T12:00:00Z,${day}T12:40:00Z,+00:00,Outdoor Walk,UNSPECIFIED,180,,3200000,\n`,
    },
    {
      name: `${GH}/Physical Activity_GoogleData/Steps/steps_${day}.csv`,
      text: `timestamp,steps,data source\n${day}T12:10:00Z,4200,Google Fitbit Air\n`,
    },
  ]);

test.beforeEach(({ page }) => importsTakeTurns(page));

test("a Takeout zip fills the profile's activity, once", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(202, testInfo);
  const day = DAY;
  await ownProfile(page, request, `Google Health ${tag}`);
  const zip = {
    name: "takeout-1-001.zip",
    mimeType: "application/zip",
    buffer: takeout(day),
  };
  const open = async () => {
    await page.goto("/#/connections");
    await page
      .getByRole("button", { name: starts("Import from Google Health") })
      .click();
    return page.getByRole("dialog");
  };

  let dialog = await open();
  await expect(dialog).toContainText("stays as it is");
  // Nothing chosen, then not a zip: the dialog says so and stays open.
  await dialog.getByRole("button", { name: "Import" }).click();
  await expect(dialog.getByRole("alert")).toContainText(
    "Choose the Takeout zip",
  );
  await dialog.getByLabel("Takeout zip").setInputFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("not a zip"),
  });
  await dialog.getByRole("button", { name: "Import" }).click();
  await expect(dialog.getByRole("alert")).toContainText("isn't a zip");

  await dialog.getByLabel("Takeout zip").setInputFiles(zip);
  await dialog.getByRole("button", { name: "Import" }).click();
  await expect(dialog).toBeHidden();
  // Every count: the workout, the day, the raw rows kept.
  await expect(page.locator("#toast")).toHaveText(
    /^Added 1 activity; filled 1 day; kept \d+ raw rows?$/u,
  );
  await page.goto(`/#/day/${day}`);
  await expect(page.locator(".activity-card")).toContainText("Outdoor Walk");

  // Again: already here, nothing added.
  dialog = await open();
  await dialog.getByLabel("Takeout zip").setInputFiles(zip);
  await dialog.getByRole("button", { name: "Import" }).click();
  await expect(page.locator("#toast")).toHaveText("1 already here");
});

const importZip = async (page, buffer) => {
  await page.goto("/#/connections");
  await page
    .getByRole("button", { name: starts("Import from Google Health") })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Takeout zip").setInputFiles({
    name: "takeout-1-001.zip",
    mimeType: "application/zip",
    buffer,
  });
  await dialog.getByRole("button", { name: "Import" }).click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });
};

const activity = async (request, pid, day) => {
  const res = await request.get(
    `/api/profiles/${pid}/device-days?from=${day}&to=${day}`,
  );
  expect(res.ok()).toBeTruthy();
  return (await res.json()).days[0];
};

test("heart rate comes in a batch of its own and fills the day", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(203, testInfo);
  const pid = await ownProfile(page, request, `Google Health HR ${tag}`);
  await importZip(
    page,
    makeZip([
      {
        name: `${GH}/Physical Activity_GoogleData/Steps/steps_${DAY}.csv`,
        text: `timestamp,steps,data source\n${DAY}T12:10:00Z,4200,Google Fitbit Air\n`,
      },
      {
        name: `${GH}/Physical Activity_GoogleData/Heart Rate/heart_rate_${DAY}.csv`,
        text: `timestamp,beats per minute\n${DAY}T10:00:00Z,60\n${DAY}T11:00:00Z,100\n`,
      },
    ]),
  );
  // The steps' upload and the heart rate's both landed on the day.
  const d = await activity(request, pid, DAY);
  expect([d.steps, d.min_hr, d.max_hr, d.avg_hr]).toEqual([4200, 60, 100, 80]);
});

test("a slow upload isn't cut at 15 s", async ({ page, request }, testInfo) => {
  test.setTimeout(60_000);
  const { tag } = unique(204, testInfo);
  const pid = await ownProfile(page, request, `Google Health slow ${tag}`);
  // Over a mebibyte of steps, so the request is a big one.
  const rows = Array.from(
    { length: 30_000 },
    (_, i) =>
      `${DAY}T12:00:${String(i % 60).padStart(2, "0")}.${String(i).padStart(6, "0")}Z,1,Phone`,
  );
  await page.route("**/import/google-health", async (route) => {
    await delay(16_000);
    await route.fallback();
  });
  await importZip(
    page,
    makeZip([
      {
        name: `${GH}/Physical Activity_GoogleData/Steps/steps_${DAY}.csv`,
        text: `timestamp,steps,data source\n${rows.join("\n")}\n`,
      },
    ]),
  );
  await expect(page.locator("#toast")).toContainText(/filled 1 day/iu);
  expect((await activity(request, pid, DAY)).steps).toBe(30_000);
});

test("heart rate batches show their progress", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(280, testInfo);
  await ownProfile(page, request, `Google Health parts ${tag}`);
  // Each upload waits, so the dialog shows which part is on its way.
  await page.route("**/import/google-health", async (route) => {
    await delay(2000);
    await route.fallback();
  });
  await page.goto("/#/connections");
  await page
    .getByRole("button", { name: starts("Import from Google Health") })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Takeout zip").setInputFiles({
    name: "takeout-1-001.zip",
    mimeType: "application/zip",
    buffer: makeZip([
      {
        name: `${GH}/Physical Activity_GoogleData/Steps/steps_${DAY}.csv`,
        text: `timestamp,steps,data source\n${DAY}T12:10:00Z,4200,Google Fitbit Air\n`,
      },
      {
        name: `${GH}/Physical Activity_GoogleData/Heart Rate/heart_rate_${DAY}.csv`,
        text: `timestamp,beats per minute\n${DAY}T10:00:00Z,60\n`,
      },
    ]),
  });
  await dialog.getByRole("button", { name: "Import" }).click();
  await expect(dialog).toContainText("Sending part 1…");
  await expect(dialog).toContainText("Sending part 2…");
  await expect(dialog).toBeHidden({ timeout: 10_000 });
});

test("the import is removed from Connections; the rest stays", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(281, testInfo);
  const pid = await ownProfile(page, request, `Google Health remove ${tag}`);
  await importZip(page, takeout(DAY));
  expect((await activity(request, pid, DAY)).steps).toBe(4200);
  // A nap logged by hand: not the import's.
  const nap = await request.post(`/api/profiles/${pid}/naps`, {
    data: {
      day: DAY,
      start_at: `${DAY}T13:00:00Z`,
      end_at: `${DAY}T13:30:00Z`,
    },
  });
  expect(nap.ok(), await nap.text()).toBeTruthy();

  const card = page.locator(".google-health");
  await expect(
    card.getByRole("link", { name: "How to export from Google Takeout" }),
  ).toHaveAttribute("href", /#google-health$/u);
  await card.getByRole("button", { name: "Remove imported data" }).click();
  await expect(page.getByRole("dialog")).toContainText(
    "What Health Connect synced and what you logged stay.",
  );
  expect(await answer(page, "Remove")).toBe(
    "Remove imported Google Health data?",
  );
  await expect(page.locator("#toast")).toContainText(
    "Removed imported Google Health data",
  );
  const d = await activity(request, pid, DAY);
  expect(d?.steps ?? null).toBeNull();
  const sessions = await (
    await request.get(`/api/profiles/${pid}/activities`)
  ).json();
  expect(sessions).toEqual([]);
  const day = await (
    await request.get(`/api/profiles/${pid}/day/${DAY}`)
  ).json();
  expect(day.naps).toHaveLength(1);
});
