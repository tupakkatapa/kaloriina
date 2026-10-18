// Activity → Records and All time: bests and totals worked out from what
// was logged, and the new-record toast when a run beats them.

import { expect, test } from "@playwright/test";
import { ownProfile, unbounded, unique } from "./helpers.js";

const run = (day, minutes, distance_m) => ({
  day,
  name: "Run",
  type: "run",
  minutes,
  kcal: null,
  sets: [],
  distance_m,
});

test("a run that beats the bests says so, and Records lists them", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag } = unique(304, testInfo);
  const pid = await ownProfile(page, request, `Records ${tag}`);
  const res = await request.post(`/api/profiles/${pid}/activities`, {
    data: run(day, 30, 5000),
  });
  expect(res.status()).toBe(201);

  await page.goto(`/#/activity/new?day=${day}`);
  await page
    .getByRole("combobox", { name: "Workout", exact: true })
    .selectOption({ label: "Something else (a run, a ride…)" });
  await page
    .getByRole("combobox", { name: "Type", exact: true })
    .selectOption({ label: "Run" });
  await page.getByRole("textbox", { name: "Name" }).fill("Long run");
  await page.getByLabel("Duration (min)").fill("60");
  await page.getByLabel("Distance (km)").fill("12");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("status").last()).toContainText(
    "Saved Long run · new record: longest distance, longest time, fastest pace",
  );

  // Read from the server's records, not every activity.
  const reads = unbounded(page);
  await page.goto("/#/activity");
  await page.getByRole("link", { name: /^Records/u }).click();
  const runs = page.locator("section.finder-section").filter({
    has: page.getByRole("heading", { name: "Run" }),
  });
  await expect(runs.locator(".result .name")).toHaveText([
    "Longest distance",
    "Longest time",
    "Fastest pace",
  ]);
  await expect(runs.locator(".result").first()).toContainText("12 km");
  // 5:00 /km beat the 5 km run's 6:00.
  await expect(runs.locator(".result").nth(2)).toContainText("5:00 /km");
  expect(reads).toEqual([]);
});

test("All time sums the profile and says it in coffee cups", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag } = unique(305, testInfo);
  const pid = await ownProfile(page, request, `All time ${tag}`);
  await request.post(`/api/profiles/${pid}/activities`, {
    data: run(day, 200, 42_195),
  });
  const food = await (
    await request.post("/api/foods", {
      data: { name: `Coffee ${tag}`, per100: { energy: 2, caffeine: 40 } },
    })
  ).json();
  await request.post(`/api/profiles/${pid}/entries`, {
    data: { day, group: "Eaten", food_id: food.id, grams: 475 },
  });
  // An activity 3 days before the first food: its total says
  // where it starts, earlier than the page's "Since".
  const before = new Date(Date.parse(`${day}T12:00:00Z`) - 3 * 864e5);
  await request.post(`/api/profiles/${pid}/activities`, {
    data: run(before.toISOString().slice(0, 10), 30, null),
  });
  await page.goto("/#/profile");
  await page.getByRole("link", { name: /^All time/u }).click();
  await expect(page.getByRole("heading", { name: "All time" })).toBeVisible();
  const since = before.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
  await expect(page.getByRole("list", { name: "Activity" })).toContainText(
    new RegExp(`^2\\sactivities\\ssince\\s${since.replace(" ", "\\s")}`, "u"),
  );
  const totals = page.getByRole("list", { name: "Food" });
  await expect(totals).toContainText("1 day logged");
  await expect(totals).toContainText("190 mg caffeine");
  const words = page.getByRole("list", { name: "In other words" });
  await expect(words).toContainText("2 cups of coffee, in caffeine");
  await expect(
    words.locator(".tile").filter({ hasText: "marathon" }),
  ).toHaveText(/^1\smarathon$/u);
  // 42 km is 0.001 times around the Earth: under 1, left out.
  await expect(words).not.toContainText("Earth");
  // The About line names the constants of what's shown only: no potato
  // before a Fineli run tells which foods are potatoes.
  const about = page.getByText(/^About: /u);
  await expect(about).toContainText("a cup of coffee 95");
  await expect(about).not.toContainText("potato");
});
