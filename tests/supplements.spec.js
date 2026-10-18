// A supplement that wants a meal with fat (vitamin D here) reads a quiet
// note on its Diary row when none came within the hour; one with a meal,
// one without a time and a planned one read none.

import { expect, test } from "@playwright/test";
import { entry, expectFits, food, ownProfile, unique } from "./helpers.js";

test("a vitamin D taken with no meal with fat within the hour says so on its row, and only there", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(793, testInfo);
  // A past day (the profile is the test's): a day still to come is no
  // judgement yet.
  const day = "2026-09-02";
  const pid = await ownProfile(page, request, `Vit ${tag}`);
  const d = await food(request, {
    name: `D-vitamiini ${tag}`,
    per100: { energy: 0, vitamin_d: 25_000 },
  });
  const cheese = await food(request, {
    name: `Juusto ${tag}`,
    per100: { energy: 350, fat: 27 },
  });
  const log = (data) => entry(request, { day, ...data }, pid);
  // 08:00 alone (cheese only at 12:00): the note. 12:10 with the cheese:
  // none. No time: none. Planned: none.
  await log({ group: "Eaten", food_id: d.id, grams: 0.2, time: "08:00" });
  await log({ group: "Eaten", food_id: cheese.id, grams: 30, time: "12:00" });
  await log({ group: "Eaten", food_id: d.id, grams: 0.2, time: "12:10" });
  await log({ group: "Eaten", food_id: d.id, grams: 0.2 });
  await log({ group: "Planned", food_id: d.id, grams: 0.2, time: "20:00" });
  await page.goto(`/#/day/${day}`);
  const notes = page.locator(".entry-note");
  await expect(notes).toHaveText([
    "Vitamin D works best with a meal that has fat: none within an hour",
  ]);
  const row = page.locator(".group li.entry").filter({ has: notes });
  await expect(row).toContainText(/08:00/u);
  await expect(notes).toHaveCSS("color", await mutedColour(page));
  await expectFits(page);
});

// The colour of the app's muted text, as drawn.
const mutedColour = (page) =>
  page.evaluate(() => {
    const el = document.createElement("span");
    el.className = "muted";
    document.body.append(el);
    const c = getComputedStyle(el).color;
    el.remove();
    return c;
  });
