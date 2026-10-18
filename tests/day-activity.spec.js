// The Diary's Activity card: its headline's distance, steps and active
// energy, and a planned workout's Start sized as the row's other controls.

import { expect, test } from "@playwright/test";
import {
  ownProfile,
  setTarget,
  syncHealth,
  todayInApp,
  unique,
} from "./helpers.js";

const DAY = "2026-09-08";

const card = (page) =>
  page.locator("section.group").filter({
    has: page.getByRole("heading", { name: "Activity", exact: true }),
  });
const parts = (page) => card(page).locator(".headline > span");

async function activity(request, pid, data) {
  const res = await request.post(`/api/profiles/${pid}/activities`, {
    data: { day: DAY, sets: [], ...data },
  });
  expect(res.status()).toBe(201);
}

test("the Activity headline leads with the day's distance in activities, each part whole", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(69, testInfo);
  const pid = await ownProfile(page, request, `Distance ${tag}`);
  await setTarget(request, pid, "steps", 10_000);
  const synced = await syncHealth(request, pid, {
    from: DAY,
    to: DAY,
    device: "Pixel 9",
    days: [{ day: DAY, steps: 8554, active_kcal: 642 }],
  });
  expect(synced.status()).toBe(200);
  await page.goto(`/#/day/${DAY}`);
  // Steps but no activity: no distance, never "0 km".
  await expect(parts(page).first()).toHaveText(/^8,554\ssteps\sof\s10,000$/u);
  await expect(card(page).locator(".headline")).not.toContainText("km");
  // The device sends no day distance: the activities' is the day's, each
  // once; a phone's "other" step metres are no route.
  await activity(request, pid, {
    type: "run",
    name: "Run",
    minutes: 25,
    distance_m: 4200,
  });
  await activity(request, pid, {
    type: "walk",
    name: "Walk",
    minutes: 15,
    distance_m: 1000,
  });
  await page.reload();
  await expect(parts(page)).toHaveText([
    /^5\.2\skm\sin\sactivities$/u,
    /^8,554\ssteps\sof\s10,000$/u,
    /^active\s/u,
  ]);
  // Each part on one line at every phone width.
  for (const width of [320, 360, 393]) {
    await page.setViewportSize({ width, height: 800 });
    const lines = await parts(page).evaluateAll((spans) =>
      spans.map(
        (s) =>
          new Set([...s.getClientRects()].map((r) => Math.round(r.top))).size,
      ),
    );
    expect(lines, `${width}`).toEqual(lines.map(() => 1));
  }
  // US units: miles.
  await page.evaluate(() => localStorage.setItem("units", "us"));
  await page.reload();
  await expect(parts(page).first()).toHaveText(/^3\.2\smi\sin\sactivities$/u);
});

test("a planned workout's Start is a compact pill, a full tap tall", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(70, testInfo);
  const pid = await ownProfile(page, request, `Start ${tag}`);
  const all = await (await request.get("/api/exercises")).json();
  const w = await (
    await request.post("/api/workouts", {
      data: {
        name: `Legs ${tag}`,
        steps: [
          {
            kind: "exercise",
            exercise_id: all.find((e) => e.name === "Push-up").id,
            reps: 10,
          },
        ],
      },
    })
  ).json();
  const day = todayInApp();
  const res = await request.post(`/api/profiles/${pid}/plans`, {
    data: { day, workout_id: w.id },
  });
  expect(res.status()).toBe(201);
  for (const width of [393, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/#/day/${day}`);
    const row = card(page).locator(".log-row.planned");
    const start = row.getByRole("link", { name: `Start Legs ${tag}` });
    await expect(start).toBeVisible();
    const look = await start.evaluate((el) => {
      const pill = getComputedStyle(el, "::before");
      const tick = getComputedStyle(
        el.parentElement.querySelector(".tick"),
        "::before",
      );
      return {
        tap: el.getBoundingClientRect().height,
        pill: pill.height,
        tick: tick.height,
        fill: getComputedStyle(el).backgroundColor,
      };
    });
    // The pill as tall as the ✓ box beside it; the tap still 44 px.
    expect(look.pill, `${width}`).toBe(look.tick);
    expect(look.tap, `${width}`).toBeGreaterThanOrEqual(44);
    expect(look.fill, `${width}`).toBe("rgba(0, 0, 0, 0)");
  }
});
