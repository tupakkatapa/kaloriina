// Progression and planning: last time and new records on a run,
// next-harder swaps, the mute toggle, EMOM rounds, planned workouts.

import { test, expect } from "@playwright/test";
import {
  unique,
  ownProfile,
  exerciseIds,
  workout,
  todayInApp,
  starts,
} from "./helpers.js";

// "2030-01-02" `n` days on.
const shift = (day, n) =>
  new Date(Date.parse(day) + n * 864e5).toISOString().slice(0, 10);

const toast = (page) => page.locator("#toast");

// A session of profile `pid` through the API.
async function session(request, pid, data) {
  const res = await request.post(`/api/profiles/${pid}/sessions`, { data });
  expect(res.ok()).toBeTruthy();
  return res.json();
}

const getJson = async (request, path) => (await request.get(path)).json();

// A run of a one-step Push-up workout, done to its finish screen with
// `reps` (5 planned), after a session of × 8, × 8, × 7 two days ago.
async function runToFinish(page, request, testInfo, slot, reps = 5) {
  const { tag } = unique(slot, testInfo);
  const id = await exerciseIds(request);
  const w = await workout(request, {
    name: `Push ${tag}`,
    steps: [{ kind: "exercise", exercise_id: id("Push-up"), reps: 5 }],
  });
  const pid = await ownProfile(page, request, `Pusher ${tag}`);
  const push = { exercise_id: id("Push-up"), name: "Push-up" };
  await session(request, pid, {
    day: shift(todayInApp(), -2),
    workout_id: w.id,
    name: w.name,
    minutes: 10,
    sets: [
      { ...push, reps: 8, kg: 20 },
      { ...push, reps: 8 },
      { ...push, reps: 7 },
    ],
  });
  await page.goto(`/#/workout/${w.id}/run`);
  await expect(page.locator(".run-last")).toHaveText(
    /^Last time \(.+\): × 8, × 8, × 7 · 20\skg$/,
  );
  for (let i = 5; i < reps; i += 1)
    await page.getByRole("button", { name: "One rep more" }).click();
  await page.getByRole("button", { name: "Done" }).click();
  await expect(
    page.getByRole("heading", { name: "Workout done" }),
  ).toBeVisible();
  return { w, pid, id };
}

const harderPick = (page) => page.getByLabel("Next time, instead of Push-up");

test("a run shows last time, swaps in a harder variant with Undo, and names the record", async ({
  page,
  request,
}, testInfo) => {
  const { w, pid, id } = await runToFinish(page, request, testInfo, 330, 9);
  // Every set hit its target: the next level up, bodyweight only.
  await expect(
    page.getByRole("group", { name: "Ready for harder" }),
  ).toBeVisible();
  await expect(harderPick(page).locator("option")).toHaveText([
    "Keep",
    "Archer push-up",
    "Clap push-up",
    "Diamond push-up",
  ]);
  await harderPick(page).selectOption({ label: "Diamond push-up" });
  await page.getByRole("button", { name: "Save to diary" }).click();

  await expect(toast(page)).toContainText(`Saved ${w.name} to`);
  await expect(toast(page)).toContainText("next time: Diamond push-up");
  await expect(toast(page)).toContainText("New record: Push-up × 9");
  let now = await getJson(request, `/api/workouts/${w.id}`);
  expect(now.steps).toEqual([
    { kind: "exercise", exercise_id: id("Diamond push-up"), reps: 5 },
  ]);
  await toast(page).getByRole("button", { name: "Undo" }).click();
  await expect
    .poll(async () => (await getJson(request, `/api/workouts/${w.id}`)).steps)
    .toEqual(w.steps);

  // The session page badges the set that beat the best.
  const [, done] = await getJson(request, `/api/profiles/${pid}/sessions`);
  await page.goto(`/#/session/${done.id}`);
  await expect(page.locator(".set .badge")).toHaveText(["Record"]);
  // The older session had nothing to beat.
  now = await getJson(request, `/api/profiles/${pid}/sessions`);
  await page.goto(`/#/session/${now[0].id}`);
  await expect(page.getByRole("heading", { name: w.name })).toBeVisible();
  await expect(page.locator(".set .badge")).toHaveCount(0);
});

test("a workout changed meanwhile isn't swapped: pick again, saved once", async ({
  page,
  request,
}, testInfo) => {
  const { w, pid, id } = await runToFinish(page, request, testInfo, 331);
  // Someone edits the workout while this screen is open.
  const edited = { ...w, name: `${w.name} v2` };
  const res = await request.put(`/api/workouts/${w.id}`, { data: edited });
  expect(res.ok()).toBeTruthy();
  await harderPick(page).selectOption({ label: "Clap push-up" });
  await page.getByRole("button", { name: "Save to diary" }).click();
  await expect(toast(page)).toContainText("Workout changed; pick again");
  await expect(
    page.getByRole("heading", { name: "Workout done" }),
  ).toBeVisible();
  let now = await getJson(request, `/api/workouts/${w.id}`);
  expect(now.steps).toEqual(w.steps);

  // Picking again over the new version swaps it; the session saved once.
  await harderPick(page).selectOption({ label: "Clap push-up" });
  await page.getByRole("button", { name: "Save to diary" }).click();
  await expect(toast(page)).toContainText("next time: Clap push-up");
  now = await getJson(request, `/api/workouts/${w.id}`);
  expect(now.steps[0].exercise_id).toBe(id("Clap push-up"));
  expect(now.name).toBe(`${w.name} v2`);
  const sessions = await getJson(request, `/api/profiles/${pid}/sessions`);
  expect(sessions).toHaveLength(2);
});

test("a session kept on the device skips the swap and says so", async ({
  page,
  request,
}, testInfo) => {
  const { w } = await runToFinish(page, request, testInfo, 332);
  await harderPick(page).selectOption({ label: "Archer push-up" });
  await page.route("**/api/profiles/*/sessions", (route) =>
    route.request().method() === "POST" ? route.abort() : route.fallback(),
  );
  await page.getByRole("button", { name: "Save to diary" }).click();
  await expect(toast(page)).toContainText(
    "Saved on this device; change the workout when online",
  );
  const now = await getJson(request, `/api/workouts/${w.id}`);
  expect(now.steps).toEqual(w.steps);
});

test("Sound off stops the beeps, stays off, and keeps the vibration", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(333, testInfo);
  const id = await exerciseIds(request);
  const w = await workout(request, {
    name: `Quiet ${tag}`,
    steps: [
      { kind: "exercise", exercise_id: id("Push-up"), reps: 5 },
      { kind: "rest", seconds: 5 },
    ],
  });
  await ownProfile(page, request, `Quiet ${tag}`);
  await page.addInitScript(() => {
    window.tones = 0;
    window.buzzes = 0;
    const make = AudioContext.prototype.createOscillator;
    AudioContext.prototype.createOscillator = function (...args) {
      window.tones += 1;
      return make.apply(this, args);
    };
    navigator.vibrate = () => {
      window.buzzes += 1;
      return true;
    };
  });
  await page.clock.install();
  // Tones and buzzes during one run through the rest.
  const counts = () => page.evaluate(() => [window.tones, window.buzzes]);
  const rest = async () => {
    await page.goto(`/#/workout/${w.id}/run?fresh=1`);
    const [tones, buzzes] = await counts();
    await page.getByRole("button", { name: "Done" }).click();
    await expect(page.locator(".run-what")).toHaveText("Rest");
    await page.clock.runFor(6_000);
    await expect(
      page.getByRole("heading", { name: "Workout done" }),
    ).toBeVisible();
    const [t, b] = await counts();
    return [t - tones, b - buzzes];
  };
  const [tones, buzzes] = await rest();
  expect(tones).toBeGreaterThan(0);
  expect(buzzes).toBe(1);

  await page.goto(`/#/workout/${w.id}/run?fresh=1`);
  const sound = page.getByRole("button", { name: "Sound off" });
  await expect(sound).toHaveAttribute("aria-pressed", "false");
  await sound.click();
  await expect(sound).toHaveAttribute("aria-pressed", "true");
  expect(await rest()).toEqual([0, 1]);
  await expect(page.getByRole("button", { name: "Sound off" })).toHaveCount(0); // the finish screen has no toggle
  // Kept on the device.
  await page.reload();
  await page.goto(`/#/workout/${w.id}/run?fresh=1`);
  await expect(page.getByRole("button", { name: "Sound off" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

test("an EMOM repeat is set in the editor and each round waits out its minute", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(334, testInfo);
  const id = await exerciseIds(request);
  const w = await workout(request, {
    name: `Emom ${tag}`,
    steps: [
      {
        kind: "repeat",
        times: 2,
        steps: [{ kind: "exercise", exercise_id: id("Push-up"), reps: 5 }],
      },
    ],
  });
  await ownProfile(page, request, `Emom ${tag}`);
  await page.goto(`/#/workout/${w.id}`);
  await page.locator('[data-path="0"] > .step-head summary').click();
  await page.getByLabel("Step 1 every (s)").fill("30");
  await expect(page.locator('[data-path="0"] .muted').first()).toHaveText(
    "2 rounds · every 30 s",
  );
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await getJson(request, `/api/workouts/${w.id}`)).steps[0].every,
    )
    .toBe(30);

  await page.clock.install();
  await page.goto(`/#/workout/${w.id}/run`);
  const what = page.locator(".run-what");
  await expect(what).toHaveText("Push-up");
  await expect(page.locator(".run-where")).toHaveText(
    "Step 1 of 4 · round 1 of 2",
  );
  await page.clock.runFor(10_000);
  await page.getByRole("button", { name: "Done" }).click();
  // The round's 30 s count from its start: 20 s left.
  await expect(what).toHaveText("Next round");
  await expect(page.locator(".run-amount")).toHaveText("0:20");
  await page.clock.runFor(21_000);
  await expect(what).toHaveText("Push-up");
  await expect(page.locator(".run-where")).toHaveText(
    "Step 3 of 4 · round 2 of 2",
  );
});

test("a workout is planned on a day from its picker, with Undo", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(335, testInfo);
  const id = await exerciseIds(request);
  const w = await workout(request, {
    name: `Planned ${tag}`,
    steps: [{ kind: "exercise", exercise_id: id("Push-up"), reps: 5 }],
  });
  const pid = await ownProfile(page, request, `Planner ${tag}`);
  const day = shift(todayInApp(), 1);
  await page.goto(`/#/plan/${day}`);
  await page.getByLabel("Search your workouts").fill(tag);
  await page.getByRole("button", { name: w.name }).click();
  await expect(page).toHaveURL(new RegExp(`#/day/${day}$`));
  await expect(toast(page)).toContainText(`Planned ${w.name}`);
  const plans = () => getJson(request, `/api/profiles/${pid}/plans`);
  expect((await plans()).map((p) => [p.day, p.workout_id])).toEqual([
    [day, w.id],
  ]);
  await toast(page).getByRole("button", { name: "Undo" }).click();
  await expect.poll(plans).toEqual([]);
});

test("a planned workout shows on its day: Start runs it there, ✕ drops it with Undo", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(336, testInfo);
  const id = await exerciseIds(request);
  const w = await workout(request, {
    name: `Due ${tag}`,
    steps: [{ kind: "exercise", exercise_id: id("Push-up"), reps: 5 }],
  });
  const pid = await ownProfile(page, request, `Due ${tag}`);
  const day = shift(todayInApp(), 2);
  const plans = () => getJson(request, `/api/profiles/${pid}/plans`);
  const plan = async () => {
    const res = await request.post(`/api/profiles/${pid}/plans`, {
      data: { day, workout_id: w.id },
    });
    expect(res.status()).toBe(201);
  };
  await plan();
  await page.goto(`/#/day/${day}`);
  const card = page.locator("section.group", {
    has: page.getByRole("heading", { name: "Log", exact: true }),
  });
  const row = card.locator("li.log-row.planned");
  await expect(row).toHaveText(new RegExp(`^Planned workoutDue ${tag}`));
  await card.getByRole("button", { name: "+ Log" }).click();
  await expect(
    page.getByRole("dialog").getByRole("link", { name: /^Plan a workout/ }),
  ).toHaveAttribute("href", `#/plan/${day}`);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  // A planned day fits a phone.
  expect(
    await page.evaluate(
      () => document.scrollingElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);

  // ✕ drops it; Undo brings it back.
  await row
    .getByRole("button", { name: `Remove the plan for ${w.name}` })
    .click();
  await expect(row).toHaveCount(0);
  await expect(card).toContainText("Nothing logged yet. Use + Log.");
  await toast(page).getByRole("button", { name: "Undo" }).click();
  await expect(row).toHaveCount(1);
  expect(await plans()).toHaveLength(1);

  // Start runs it for that day; saving takes the plan away.
  await row.getByRole("link", { name: `Start ${w.name}` }).click();
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByLabel("Day")).toHaveValue(day);
  await page.getByRole("button", { name: "Save to diary" }).click();
  await expect(page).toHaveURL(new RegExp(`#/day/${day}$`));
  await expect(row).toHaveCount(0);
  await expect(card.getByRole("link", { name: starts(w.name) })).toBeVisible();
  expect(await plans()).toEqual([]);
});
