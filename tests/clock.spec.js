// The clock follows the Units setting: Metric reads and types 24-hour,
// US (imperial) 12-hour, whatever the browser locale (en-US here). Times
// are typed in one text field that takes either way and saves "HH:MM".

import { expect, test } from "@playwright/test";
import { entry, food, ownProfile, save, unique } from "./helpers.js";

const us = (page) =>
  page.addInitScript(() => localStorage.setItem("units", "us"));

const eaten = (page) =>
  page.locator("section.group", {
    has: page.getByRole("heading", { name: "Eaten", exact: true }),
  });

// An Eaten entry at 14:30 on the test's own profile.
async function lunch(page, request, slot, testInfo) {
  const { day, tag } = unique(slot, testInfo);
  const pid = await ownProfile(page, request, `Clock ${tag}`);
  const oats = await food(request, {
    name: `Oats ${tag}`,
    per100: { energy: 380 },
  });
  const {
    entries: [e],
  } = await entry(
    request,
    { day, group: "Eaten", food_id: oats.id, grams: 50, time: "14:30" },
    pid,
  );
  return { day, e, pid };
}

const savedTime = async (request, pid, id) =>
  (await (await request.get(`/api/profiles/${pid}/entries/${id}`)).json()).time;

test("US units: 12-hour times shown and typed, saved as data", async ({
  page,
  request,
}, testInfo) => {
  await us(page);
  const { day, e, pid } = await lunch(page, request, 950, testInfo);
  await page.goto(`/#/day/${day}`);
  await expect(eaten(page).locator(".entry")).toContainText("2:30 PM · 1.8 oz");

  await page.goto(`/#/entry/${e.id}`);
  const time = page.getByLabel("Time eaten");
  await expect(time).toHaveValue(/^2:30\sPM$/u);
  // Invalid: says how a time reads here.
  await time.fill("25:00");
  expect(await time.evaluate((el) => el.validationMessage)).toMatch(
    /^Enter a time like 2:30\sPM$/u,
  );
  await time.fill("7:05 pm");
  await save(page, "Saved Oats");
  expect(await savedTime(request, pid, e.id)).toBe("19:05");
  await page.goto(`/#/day/${day}`);
  await expect(eaten(page).locator(".entry")).toContainText("7:05 PM · 1.8 oz");
});

test("Metric units: 24-hour in an en-US browser", async ({
  page,
  request,
}, testInfo) => {
  const { day, e, pid } = await lunch(page, request, 951, testInfo);
  await page.goto(`/#/day/${day}`);
  await expect(eaten(page).locator(".entry")).toContainText("14:30 · 50 g");

  await page.goto(`/#/entry/${e.id}`);
  const time = page.getByLabel("Time eaten");
  await expect(time).toHaveValue("14:30");
  await time.fill("25:00");
  expect(await time.evaluate((el) => el.validationMessage)).toBe(
    "Enter a time like 14:30",
  );
  // Either way types: "7:05 pm" reads back 24-hour once left.
  await time.fill("7:05 pm");
  await time.blur();
  await expect(time).toHaveValue("19:05");
  await save(page, "Saved Oats");
  expect(await savedTime(request, pid, e.id)).toBe("19:05");
  await page.goto(`/#/day/${day}`);
  await expect(eaten(page).locator(".entry")).toContainText("19:05 · 50 g");
});

test("US units: a bedtime target typed 12-hour", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(952, testInfo);
  await us(page);
  const pid = await ownProfile(page, request, `Bedtime ${tag}`);
  await page.goto("/#/targets");
  const bedtime = page.getByLabel("Bedtime target");
  await bedtime.fill("11:30 pm");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.locator("#toast")).toHaveText(/Saved/u);
  const targets = await (
    await request.get(`/api/profiles/${pid}/targets`)
  ).json();
  // Minutes after midnight.
  expect(targets.find((t) => t.metric === "bedtime").value).toBe(23 * 60 + 30);
  await page.reload();
  await expect(page.getByLabel("Bedtime target")).toHaveValue(/^11:30\sPM$/u);
});
