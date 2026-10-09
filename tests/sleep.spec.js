// Summary → Body with Health Connect's nights and heart: the Sleep tiles and
// calendar, and resting heart rate and HRV in the body chart.
// Every test uses a profile of its own; the week is 2026-08-31 (Mon) ..
// 2026-09-06.

import { test, expect } from "@playwright/test";
import { ownProfile, unique } from "./helpers.js";

const night = (day, bedtime) => ({
  day,
  asleep_min: 420,
  in_bed_min: 450,
  bedtime,
  wake_time: "07:00",
  resting_hr: 54,
  hrv_ms: 48,
});

async function sync(request, pid, days) {
  const res = await request.post(`/api/profiles/${pid}/sync/health`, {
    data: { from: "2026-08-31", to: "2026-09-06", device: "Pixel 9", days },
  });
  expect(res.status()).toBe(200);
}

test("Body shows the week's sleep after the chart, and heart in its switch", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(652, testInfo);
  const pid = await ownProfile(page, request, `Sleep ${tag}`);
  for (const [day, kg] of [
    ["2026-09-01", 61],
    ["2026-09-03", 60.6],
  ])
    await request.put(`/api/profiles/${pid}/weights/${day}`, { data: { kg } });
  // Bedtimes either side of midnight average midnight, ± 8 min.
  await sync(request, pid, [
    night("2026-09-01", "23:50"),
    night("2026-09-02", "00:00"),
    night("2026-09-03", "00:10"),
  ]);
  await page.goto("/#/summary/body/week/2026-08-31");
  const sleep = page.locator("section.sleep-summary");
  await expect(
    sleep.getByRole("list", { name: "Sleep" }).getByRole("listitem"),
  ).toHaveText([
    "7 h asleep a night",
    "00:00 average bedtime",
    "± 8 min bedtime spread",
    "07:00 average wake-up",
  ]);
  // After the weight chart.
  const order = await page
    .locator("section.weight, section.sleep-summary")
    .evaluateAll((list) => list.map((s) => s.className));
  expect(order[0]).toContain("weight");
  expect(order[1]).toContain("sleep-summary");
  // Each night on the day it ended; a day without one hatched.
  await expect(
    sleep.getByRole("link", { name: "Wed, Sep 2: 7 h asleep, 00:00–07:00" }),
  ).toBeVisible();
  await expect(sleep.locator('td[data-day="2026-09-04"]')).toHaveClass(
    /\bnone\b/,
  );
  await expect(sleep.locator('td[data-day="2026-09-02"]')).toHaveClass(
    /\bshade-2\b/,
  );

  const chart = page
    .locator("section.weight")
    .getByRole("radiogroup", { name: "Chart", exact: true });
  await expect(chart.getByRole("radio")).toHaveText([
    "Weight",
    "Resting HR",
    "HRV",
  ]);
  await chart.getByRole("radio", { name: "HRV" }).click();
  await expect(page.getByRole("heading", { name: "HRV by day" })).toBeVisible();
  await expect(
    page.getByRole("img", { name: "HRV by day: each day's value, in ms." }),
  ).toBeVisible();
});

test("HRV without weigh-ins still charts", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(653, testInfo);
  const pid = await ownProfile(page, request, `Heart ${tag}`);
  await sync(request, pid, [
    { day: "2026-09-01", hrv_ms: 45 },
    { day: "2026-09-02", hrv_ms: 51 },
  ]);
  await page.goto("/#/summary/body/week/2026-08-31");
  await expect(page.getByRole("heading", { name: "HRV by day" })).toBeVisible();
  await expect(
    page.getByRole("img", { name: "HRV by day: each day's value, in ms." }),
  ).toBeVisible();
  await expect(page.getByText(/No weigh-ins/)).toHaveCount(0);
  // Nothing else to switch to; no nights: Sleep says where they come from.
  await expect(page.getByRole("radiogroup", { name: "Chart" })).toHaveCount(0);
  await expect(page.locator("section.sleep-summary")).toHaveText(
    "SleepSleep comes from the Android app: set it up in Connections.",
  );
  await expect(
    page
      .locator("section.sleep-summary")
      .getByRole("link", { name: "Connections" }),
  ).toHaveAttribute("href", "#/connections");
});

// Every calendar is shaded from `--hue`; Body's had none, so its
// darkest cells were transparent (white text on the page).
const filled = (cell) =>
  cell.evaluate((td) => getComputedStyle(td).backgroundColor);

test("an s4 cell has a colour", async ({ page, request }, testInfo) => {
  const { tag } = unique(880, testInfo);
  const pid = await ownProfile(page, request, `Long night ${tag}`);
  await sync(request, pid, [
    {
      ...night("2026-09-01", "22:00"),
      asleep_min: 540,
      in_bed_min: 560,
    },
  ]);
  await request.put(`/api/profiles/${pid}/check-ins/2026-09-01`, {
    data: { mood: 5 },
  });
  await page.goto("/#/summary/body/week/2026-08-31");
  for (const section of ["section.sleep-summary", "section.check-ins"]) {
    const cell = page.locator(`${section} td[data-day="2026-09-01"]`);
    await expect(cell).toHaveClass(/\bshade-4\b/);
    expect(await filled(cell)).not.toBe("rgba(0, 0, 0, 0)");
  }
});

// On Stress the calm day is the dark one, and the legend says so.
test("stress shades calm days darkest", async ({ page, request }, testInfo) => {
  const { tag } = unique(881, testInfo);
  const pid = await ownProfile(page, request, `Calm ${tag}`);
  for (const [day, stress] of [
    ["2026-09-01", 1],
    ["2026-09-02", 5],
  ])
    await request.put(`/api/profiles/${pid}/check-ins/${day}`, {
      data: { stress },
    });
  await page.goto("/#/summary/body/week/2026-08-31");
  const section = page.locator("section.check-ins");
  await expect(section.locator('td[data-day="2026-09-01"]')).toHaveClass(
    /\bshade-4\b/,
  );
  await expect(section.locator('td[data-day="2026-09-02"]')).toHaveClass(
    /\bshade-1\b/,
  );
  await expect(section.locator(".cal-legend")).toHaveText(
    "No check-in4–5 stressed321 calm",
  );
});

// An empty Body keeps every section's heading with its way in.
test("an empty Body says where each section comes from", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(882, testInfo);
  await ownProfile(page, request, `Empty ${tag}`);
  await page.goto("/#/summary/body/week/2026-08-31");
  for (const [section, hint] of [
    [
      "sleep-summary",
      "Sleep comes from the Android app: set it up in Connections.",
    ],
    ["check-ins", "Log a check-in from the Diary's + Log."],
    ["measurements", "Log a measurement from the Diary's + Log."],
    ["notes", "Write a note from the Diary's + Log."],
  ])
    await expect(page.locator(`section.${section} p`)).toHaveText(hint);
});
