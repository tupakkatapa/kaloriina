// Cardio load (ADR 0034): an activity's Banister TRIMP on its view, a
// week's on Summary → Activity beside the 4 weeks before it, and its
// Highlights card.

import { expect, test } from "@playwright/test";
import {
  expectFits,
  newProfile,
  ownProfile,
  syncHealth,
  unique,
} from "./helpers.js";

// A Health Connect session on `day` with a heart rate.
const session = (key, day, minutes, avg_hr, max_hr) => ({
  key,
  day,
  start_at: `${day}T14:00:00Z`,
  end_at: new Date(Date.parse(`${day}T14:00:00Z`) + minutes * 60_000)
    .toISOString()
    .replace(/\.000Z$/u, "Z"),
  type: 33,
  name: "Running",
  kcal: 400,
  distance_m: 8000,
  recording_method: 1,
  avg_hr,
  max_hr,
});

// The profile (female, born 1990: 36 in Sep 2026, maximum ≈ 182.8) synced
// with `sessions` and resting heart rates `rests` ({day: bpm}).
async function synced(request, pid, sessions, rests) {
  const days = Object.entries(rests).map(([day, resting_hr]) => ({
    day,
    resting_hr,
    steps: 5000,
  }));
  const res = await syncHealth(request, pid, {
    from: "2026-08-01",
    to: "2026-09-30",
    device: "Pixel 9",
    days,
    sessions,
  });
  expect(res.ok()).toBeTruthy();
}

test("an activity's view shows its cardio load, from the resting heart rate the day before", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(791, testInfo);
  const pid = await ownProfile(page, request, `Load ${tag}`);
  // 46 min at 142 avg, 171 max; rest 54 the day before (no reading that
  // day). HRr = 88 / 128.8; 46 × HRr × 0.86 × e^(1.67 × HRr) = 84.6.
  await synced(
    request,
    pid,
    [session(`load-${tag}`, "2026-09-02", 46, 142, 171)],
    { "2026-09-01": 54 },
  );
  const [run] = await (
    await request.get(`/api/profiles/${pid}/activities?from=2026-09-02`)
  ).json();
  await page.goto(`/#/activity/${run.id}`);
  const facts = page.locator("dl.traits").first();
  await expect(facts.locator("dt")).toHaveText([
    "Duration",
    "Distance",
    "Pace",
    "Energy",
    "Heart rate",
    "Cardio load",
    "Source",
  ]);
  await expect(facts.locator("dd").nth(5)).toHaveText(
    /^≈\s85 · resting 54, max ≈\s183\sbpm$/u,
  );
  await expectFits(page);
});

test("Summary → Activity: a week's cardio load, a floor with an activity without heart rate, beside the 4 weeks before", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(792, testInfo);
  const pid = await ownProfile(page, request, `Week load ${tag}`);
  await synced(
    request,
    pid,
    [
      session(`wk-${tag}`, "2026-09-02", 46, 142, 171),
      // 40 min at 130 avg, rest 56: 53.2, 13.3 a week over the 4 before.
      session(`before-${tag}`, "2026-08-20", 40, 130, 160),
    ],
    { "2026-09-01": 54, "2026-08-20": 56 },
  );
  // Logged by hand, no heart rate: the week's load is a floor.
  const hand = await request.post(`/api/profiles/${pid}/activities`, {
    data: { day: "2026-09-03", name: `Yoga ${tag}`, minutes: 30 },
  });
  expect(hand.ok()).toBeTruthy();
  await page.goto("/#/summary/activity/week/2026-09-02");
  const tiles = page
    .getByRole("list", { name: "Cardio load" })
    .locator(".tile");
  await expect(tiles).toHaveText([
    /^≥\s85\s+cardio load$/u,
    /^≈\s13\s+a week, the 4 weeks before$/u,
  ]);
  // The floor's reason and the before's days are each tile's long text.
  await expect(tiles.first()).toHaveAccessibleDescription(
    /^Banister's TRIMP .*an estimate\. ≥: 1 activity without a load \(no heart rate, or no resting heart rate that week\)\.$/u,
  );
  await expect(tiles.last()).toHaveAccessibleDescription(
    "The 28 days before this week ÷ 4.",
  );
  await expectFits(page);
});

test("Summary → Activity's Highlights say a month's cardio load against the 4 weeks before", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(794, testInfo);
  const pid = await ownProfile(page, request, `Load up ${tag}`);
  const sep = ["2026-09-03", "2026-09-10", "2026-09-17"];
  const aug = ["2026-08-06", "2026-08-13", "2026-08-20"];
  await synced(
    request,
    pid,
    [
      ...sep.map((d, i) => session(`up-${tag}-${i}`, d, 60, 150, 165)),
      ...aug.map((d, i) => session(`was-${tag}-${i}`, d, 40, 120, 135)),
    ],
    Object.fromEntries([...sep, ...aug].map((d) => [d, 55])),
  );
  await page.goto("/#/summary/activity/month/2026-09-01");
  await expect(
    page
      .locator("section.highlight-stack > ul.highlights > li")
      .filter({ hasText: "Cardio load up" }),
  ).toContainText(/≈\s93 vs 31 a week · Sep 1\s–\s30 vs the 4 weeks before/u);
});

test("an activity's load without the profile's sex says so, and leads to the profile to set it", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(795, testInfo);
  const { id: pid } = await newProfile(request, {
    name: `No sex ${tag}`,
    sex: null,
  });
  await page.addInitScript(
    (id) => localStorage.setItem("profile", String(id)),
    pid,
  );
  await synced(
    request,
    pid,
    [session(`nosex-${tag}`, "2026-09-02", 46, 142, 171)],
    { "2026-09-02": 54 },
  );
  const [run] = await (
    await request.get(`/api/profiles/${pid}/activities?from=2026-09-02`)
  ).json();
  await page.goto(`/#/activity/${run.id}`);
  const load = page.locator("dl.traits dd").filter({ hasText: /^–/u });
  await expect(load).toHaveText("– · needs your sex and birth date");
  await load
    .getByRole("link", { name: "needs your sex and birth date" })
    .click();
  await expect(page).toHaveURL(new RegExp(`#/profile/${pid}$`, "u"));
  await expect(page.getByLabel("Sex")).toBeVisible();
});
