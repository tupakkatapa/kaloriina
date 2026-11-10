// A day not fully logged: a one-off item without kcal ("Not fully
// logged", as migration 74 makes a ticked day). The Diary's headline names
// why; Summary leaves the day out (the calendar's tally, the balance)
// while still showing its amount, unjudged.

import { expect, test } from "@playwright/test";
import {
  dayTotal,
  entry,
  fixedToday,
  food,
  ownProfile,
  todayInApp,
  unique,
} from "./helpers.js";

const shift = (day, n) =>
  new Date(Date.parse(day) + n * 864e5).toISOString().slice(0, 10);

const notFullyLogged = (request, pid, day) =>
  entry(request, { day, group: "Eaten", name: "Not fully logged" }, pid);

test("not fully logged: a one-off item without kcal, named in the headline, no Log record", async ({
  page,
  request,
}, testInfo) => {
  await fixedToday(page);
  const { tag } = unique(1197, testInfo);
  const pid = await ownProfile(page, request, `Partial ${tag}`);
  const day = shift(todayInApp(), -2);
  const oats = await food(request, {
    name: `Oats ${tag}`,
    per100: { energy: 380 },
  });
  await entry(
    request,
    { day, group: "Eaten", food_id: oats.id, grams: 100 },
    pid,
  );
  await notFullyLogged(request, pid, day);
  await page.goto(`/#/day/${day}`);
  await expect(page.locator(".headline")).toContainText(
    "a one-off item without kcal",
  );
  await expect(
    page.locator("li.entry", { hasText: "Not fully logged" }).locator(".kcal"),
  ).toHaveText("Estimate kcal");
  await page
    .locator(".log-card")
    .getByRole("button", { name: /^Log on /u })
    .click();
  const sheet = page.getByRole("dialog", { name: "Log" });
  await expect(
    sheet.getByRole("button", { name: "Note", exact: true }),
  ).toBeVisible();
  await expect(
    sheet.getByRole("button", { name: "Not fully logged" }),
  ).toHaveCount(0);
});

test("food calendar: a day not fully logged shows its amount, unjudged and uncounted", async ({
  page,
}) => {
  const days = [
    ["2025-03-03", 2000],
    ["2025-03-04", 900],
    ["2025-03-05", 2000],
  ].map(([day, energy]) => dayTotal(day, energy));
  days[1].incomplete = true;
  await page.route("**/api/profiles/*/summary?*", (route) =>
    route.fulfill({
      json: { from: "2025-03-03", to: "2025-03-09", days },
    }),
  );
  await page.route("**/api/profiles/*/targets", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({
          json: [{ metric: "energy", value: 2000, min: 1900, max: 2100 }],
        })
      : route.continue(),
  );
  await page.goto("/#/summary/food/week/2025-03-03");
  const cell = page.locator('.food-cal td[data-day="2025-03-04"]');
  await expect(cell.locator(".cal-amount")).toHaveText("900");
  await expect(cell).not.toHaveClass(/\bshade-[1-4]\b/u);
  await expect(cell.getByRole("link")).toHaveAttribute(
    "aria-label",
    /^Tue, Mar 4: 900\skcal, not fully logged$/u,
  );
  await expect(page.locator(".food-calendar .tiles .tile").first()).toHaveText(
    /^2\sof\s2\sdays\son\starget$/u,
  );
});

test("the balance leaves a day not fully logged out of what was eaten", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(1199, testInfo);
  const pid = await ownProfile(page, request, `Balance ${tag}`);
  for (const [day, kg] of [
    ["2025-03-05", 60],
    ["2025-03-15", 59.6],
    ["2025-03-25", 59.2],
  ])
    await request.put(`/api/profiles/${pid}/weights/${day}`, { data: { kg } });
  const stew = await food(request, {
    name: `Stew ${tag}`,
    per100: { energy: 400 },
  });
  const days = Array.from(
    { length: 28 },
    (_, i) => `2025-03-${String(i + 1).padStart(2, "0")}`,
  );
  // 2,000 kcal a day, and one day of 4,000.
  for (const day of [...days, "2025-03-10"])
    await entry(
      request,
      { day, group: "Eaten", food_id: stew.id, grams: 500 },
      pid,
    );
  const line = page.locator(".balance-line");
  await page.goto("/#/summary/food/month/2025-03-15");
  await expect(line).toHaveText(/^Eaten\s2,071 · /u);
  await notFullyLogged(request, pid, "2025-03-10");
  await page.reload();
  await expect(line).toHaveText(/^Eaten\s2,000 · /u);
});
