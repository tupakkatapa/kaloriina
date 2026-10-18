// Profile → All time: eaten and burned over the same days as Summary's
// balance (web/series.mjs periodNumbers), from one read of each
// source.

import { expect, test } from "@playwright/test";
import { entry, food, ownProfile, syncHealth, unique } from "./helpers.js";

test("All time sets eaten against burned on Summary's days, each source read once (SC11-6)", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(1141, testInfo);
  // Female, 165 cm, 60 kg: Mifflin–St Jeor 1,295.25 kcal a day at 35.
  const pid = await ownProfile(page, request, `Ever ${tag}`);
  await request.put(`/api/profiles/${pid}/weights/2025-03-01`, {
    data: { kg: 60 },
  });
  const f = await food(request, {
    name: `Stew ${tag}`,
    per100: { energy: 400 },
  });
  for (const [day, grams] of [
    ["2025-03-04", 500],
    ["2025-03-05", 250],
  ])
    await entry(request, { day, group: "Eaten", food_id: f.id, grams }, pid);
  const reads = [];
  page.on("request", (r) => {
    const path = new URL(r.url()).pathname + new URL(r.url()).search;
    if (/\/(device-days|summary)\?/u.test(path)) reads.push(path);
  });
  await page.goto("/#/stats");
  // Resting × 1.1 each day, plus a tenth of what was eaten: 1,624.8 and
  // 1,524.8.
  const foodTiles = page.getByRole("list", { name: "Food" }).locator(".tile");
  // What was eaten a day on those days: no chart or bar says it.
  await expect(foodTiles.nth(4)).toHaveText(/^1,500\skcal\s*eaten a day$/u);
  await expect(foodTiles.nth(4)).toHaveAccessibleDescription(
    /over the 2 days with food logged through yesterday/u,
  );
  const burned = foodTiles.nth(5);
  await expect(burned).toHaveText(/^≈ 3,150\skcal\s*burned on logged days$/u);
  await expect(burned).toHaveAccessibleDescription(
    /on the 2 days with food logged through yesterday\.$/u,
  );
  expect(reads.filter((r) => r.includes("/device-days?")).length).toBe(1);
  expect(reads.filter((r) => r.includes("/summary?")).length).toBe(1);
});

test("All time says the steps a day over the days the device counted them", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(1159, testInfo);
  const pid = await ownProfile(page, request, `Stepper ${tag}`);
  const res = await syncHealth(request, pid, {
    from: "2025-03-01",
    to: "2025-03-07",
    days: [
      { day: "2025-03-02", steps: 8000 },
      { day: "2025-03-04", steps: 12001 },
    ],
  });
  expect(res.ok()).toBeTruthy();
  // All time starts with a day eaten.
  const f = await food(request, {
    name: `Oats ${tag}`,
    per100: { energy: 380 },
  });
  await entry(
    request,
    { day: "2025-03-02", group: "Eaten", food_id: f.id, grams: 50 },
    pid,
  );
  await page.goto("/#/stats");
  const tile = page
    .getByRole("list", { name: "Activity" })
    .locator(".tile")
    .filter({ hasText: "steps a day" });
  await expect(tile).toHaveText(/^10,001\s+steps a day$/u);
  await expect(tile).toHaveAccessibleDescription(
    "Your average steps a day, over the 2 days your device counted them.",
  );
});
