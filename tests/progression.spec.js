// Progression and planning: last time and new records on a run,
// next-harder swaps, the mute toggle, EMOM rounds, planned workouts.

import { expect, test } from "@playwright/test";
import {
  answer,
  exerciseIds,
  expectFits,
  fixedToday,
  ownProfile,
  starts,
  todayInApp,
  unbounded,
  unique,
  workout,
} from "./helpers.js";

// "2030-01-02" `n` days on.
const shift = (day, n) =>
  new Date(Date.parse(day) + n * 864e5).toISOString().slice(0, 10);

const toast = (page) => page.locator("#toast");

// A session of profile `pid` through the API.
async function session(request, pid, data) {
  const res = await request.post(`/api/profiles/${pid}/activities`, { data });
  expect(res.ok()).toBeTruthy();
  return res.json();
}

const getJson = async (request, path) => (await request.get(path)).json();

// A run of a one-step Push-up workout, done to its finish screen with
// `reps` (5 planned), after a session of 8, 8, 7 reps two days ago.
// `extra` goes into the workout as made.
async function runToFinish(
  page,
  request,
  testInfo,
  slot,
  reps = 5,
  extra = {},
) {
  await fixedToday(page);
  const { tag } = unique(slot, testInfo);
  const id = await exerciseIds(request);
  const w = await workout(request, {
    name: `Push ${tag}`,
    notes: "Elbows in.",
    steps: [{ kind: "exercise", exercise_id: id("Push-up"), reps: 5 }],
    ...extra,
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
  // Last time and the bests from each exercise's history.
  const reads = unbounded(page);
  await page.goto(`/#/workout/${w.id}/run`);
  await expect(page.locator(".run-last")).toHaveText(
    /^Last time \(.+\): 8, 8, 7 reps · 20\skg$/u,
  );
  for (let i = 5; i < reps; i += 1)
    await page.getByRole("button", { name: "One rep more" }).click();
  await page.getByRole("button", { name: "Done" }).click();
  await expect(
    page.getByRole("heading", { name: "Workout done" }),
  ).toBeVisible();
  expect(reads).toEqual([]);
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
  await expect(toast(page)).toContainText("New record: Push-up · 9 reps");
  let now = await getJson(request, `/api/workouts/${w.id}`);
  expect(now.steps).toEqual([
    { kind: "exercise", exercise_id: id("Diamond push-up"), reps: 5 },
  ]);
  // The swap and its Undo keep the workout's notes.
  expect(now.notes).toBe("Elbows in.");
  await toast(page).getByRole("button", { name: "Undo" }).click();
  await expect
    .poll(async () => (await getJson(request, `/api/workouts/${w.id}`)).steps)
    .toEqual(w.steps);
  now = await getJson(request, `/api/workouts/${w.id}`);
  expect(now.notes).toBe("Elbows in.");

  // The session page badges the set that beat the best.
  const [, done] = await getJson(request, `/api/profiles/${pid}/activities`);
  await page.goto(`/#/activity/${done.id}/edit`);
  await expect(page.locator(".set .badge")).toHaveText(["Record"]);
  // The older session had nothing to beat.
  now = await getJson(request, `/api/profiles/${pid}/activities`);
  await page.goto(`/#/activity/${now[0].id}/edit`);
  await expect(page.getByRole("heading", { name: w.name })).toBeVisible();
  await expect(page.locator(".set .badge")).toHaveCount(0);
});

// The finish screen is the session form: a run as long as a session can be
// (`activity_minutes`, a day) saves from it, not only by hand.
test("an 11-hour run saves from Run's finish screen", async ({
  page,
  request,
}, testInfo) => {
  const { pid } = await runToFinish(page, request, testInfo, 246);
  await page.getByLabel("Duration (min)").fill("660");
  await page.getByRole("button", { name: "Save to diary" }).click();
  await expect(toast(page)).toContainText("Saved Push");
  const sessions = await getJson(request, `/api/profiles/${pid}/activities`);
  expect(sessions.map((s) => s.minutes)).toContain(660);
});

// The swap and its Undo send the workout back whole: an archived one (run
// from an old plan) stays archived.
test("a harder swap keeps the workout archived", async ({
  page,
  request,
}, testInfo) => {
  const { w, id } = await runToFinish(page, request, testInfo, 240, 9, {
    archived: true,
  });
  expect(w.archived).toBe(true);
  await harderPick(page).selectOption({ label: "Diamond push-up" });
  await page.getByRole("button", { name: "Save to diary" }).click();
  await expect(toast(page)).toContainText("next time: Diamond push-up");
  let now = await getJson(request, `/api/workouts/${w.id}`);
  expect(now.steps[0].exercise_id).toBe(id("Diamond push-up"));
  expect(now.archived).toBe(true);
  await toast(page).getByRole("button", { name: "Undo" }).click();
  await expect
    .poll(async () => (await getJson(request, `/api/workouts/${w.id}`)).steps)
    .toEqual(w.steps);
  now = await getJson(request, `/api/workouts/${w.id}`);
  expect(now.archived).toBe(true);
  expect(now.notes).toBe("Elbows in.");
});

// A two-step run of profile `pid`'s own Push-up workout, at its first step.
async function twoStepRun(page, request, testInfo, slot) {
  const { tag } = unique(slot, testInfo);
  const id = await exerciseIds(request);
  const w = await workout(request, {
    name: `Twice ${tag}`,
    steps: [
      { kind: "exercise", exercise_id: id("Push-up"), reps: 5 },
      { kind: "exercise", exercise_id: id("Pull-up"), reps: 5 },
    ],
  });
  await ownProfile(page, request, `Twice ${tag}`);
  await page.goto(`/#/workout/${w.id}/run`);
  await expect(page.locator(".run-where")).toHaveText("Step 1 of 2");
  return w;
}

// The app killed mid-run (a phone does it to a backgrounded PWA): a new tab
// has no session storage, the run is still there.
test("a run resumes after a new context", async ({
  page,
  context,
  request,
}, testInfo) => {
  const w = await twoStepRun(page, request, testInfo, 241);
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.locator(".run-where")).toHaveText("Step 2 of 2");
  await page.close();
  const again = await context.newPage();
  await again.goto(`/#/workout/${w.id}/run`);
  await expect(again.locator(".run-where")).toHaveText("Step 2 of 2");
});

// The tabs stay live during a run: leaving goes at once (nothing is lost:
// the run waits, `runWaiting()`, the Resume banner's source).
test("leaving a run goes without asking; the run waits", async ({
  page,
  request,
}, testInfo) => {
  const w = await twoStepRun(page, request, testInfo, 242);
  const run = `#/workout/${w.id}/run`;
  await page.locator('.tabs a[data-tab="diary"]').click();
  await expect(page).toHaveURL(/#\/$/u);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const waiting = await page.evaluate(async () =>
    (await import("/screens/run.mjs")).runWaiting(),
  );
  expect(waiting).toMatchObject({ id: w.id, name: w.name, finished: false });
  // Done with it: nothing waits.
  await page.goto(`/${run}`);
  await expect(page.locator(".run-where")).toHaveText("Step 1 of 2");
  await page.getByRole("button", { name: "Finish" }).click();
  await answer(page, "Finish");
  await page.getByRole("button", { name: "Don't save" }).click();
  await answer(page, "Discard");
  await expect(page).toHaveURL(/#\/activity$/u);
  expect(
    await page.evaluate(async () =>
      (await import("/screens/run.mjs")).runWaiting(),
    ),
  ).toBeNull();
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
  const sessions = await getJson(request, `/api/profiles/${pid}/activities`);
  expect(sessions).toHaveLength(2);
});

test("an activity kept on the device skips the swap and says so", async ({
  page,
  request,
}, testInfo) => {
  const { w } = await runToFinish(page, request, testInfo, 332);
  await harderPick(page).selectOption({ label: "Archer push-up" });
  await page.route("**/api/profiles/*/activities", (route) =>
    route.request().method() === "POST" ? route.abort() : route.fallback(),
  );
  await page.getByRole("button", { name: "Save to diary" }).click();
  await expect(toast(page)).toContainText(
    "Saved in this browser; change the workout when online",
  );
  const now = await getJson(request, `/api/workouts/${w.id}`);
  expect(now.steps).toEqual(w.steps);
});

test("the Sound toggle stops the beeps, stays off, and keeps the vibration", async ({
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
  // An icon in the header row, pressed while sound is on.
  const sound = page.getByRole("button", { name: "Sound", exact: true });
  await expect(sound).toHaveAttribute("aria-pressed", "true");
  await expect(sound).toHaveText("");
  const [title, toggle] = await Promise.all([
    page.locator("header.title h1").boundingBox(),
    sound.boundingBox(),
  ]);
  expect(
    Math.abs(title.y + title.height / 2 - (toggle.y + toggle.height / 2)),
  ).toBeLessThan(2);
  await sound.click();
  await expect(sound).toHaveAttribute("aria-pressed", "false");
  expect(await rest()).toEqual([0, 1]);
  // The finish screen has no toggle.
  await expect(
    page.getByRole("button", { name: "Sound", exact: true }),
  ).toHaveCount(0);
  // Kept on the device.
  await page.reload();
  await page.goto(`/#/workout/${w.id}/run?fresh=1`);
  await expect(
    page.getByRole("button", { name: "Sound", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
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
  await page.goto(`/#/workout/${w.id}/edit`);
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
  await fixedToday(page);
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
  await expect(page).toHaveURL(new RegExp(`#/day/${day}$`, "u"));
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
  await fixedToday(page);
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
    has: page.getByRole("heading", { name: "Activity", exact: true }),
  });
  const row = card.locator("li.log-row.planned");
  await expect(row).toHaveText(new RegExp(`^PlannedDue ${tag}`, "u"));
  // A day ahead: its + plans.
  await expect(
    card.getByRole("link", { name: /^Plan a workout on /u }),
  ).toHaveAttribute("href", `#/plan/${day}`);
  // A planned day fits a phone.
  await expectFits(page);

  // ✕ drops it; Undo brings it back.
  await row
    .getByRole("button", { name: `Remove the plan for ${w.name}` })
    .click();
  await expect(row).toHaveCount(0);
  await expect(card).toContainText("Nothing planned.");
  await toast(page).getByRole("button", { name: "Undo" }).click();
  await expect(row).toHaveCount(1);
  expect(await plans()).toHaveLength(1);

  // Start shows only today; a run for that day, saved, takes the plan away.
  await expect(row.getByRole("link", { name: /^Start /u })).toHaveCount(0);
  await page.goto(`/#/workout/${w.id}/run?day=${day}`);
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByLabel("Day")).toHaveValue(day);
  await page.getByRole("button", { name: "Save to diary" }).click();
  await expect(page).toHaveURL(new RegExp(`#/day/${day}$`, "u"));
  await expect(row).toHaveCount(0);
  await expect(card.getByRole("link", { name: starts(w.name) })).toBeVisible();
  expect(await plans()).toEqual([]);
});

// The run kept on this device for workout `id` (run.mjs keptRunOf).
const kept = (page, id) =>
  page.evaluate(
    async (w) => (await import("/screens/run.mjs")).keptRunOf(w),
    id,
  );

test("a finished run keeps its time: reopened 10 hours later it still took 1 minute", async ({
  page,
  request,
}, testInfo) => {
  const { w } = await runToFinish(page, request, testInfo, 1097);
  const minutes = page.locator("[name=minutes]");
  await expect(minutes).toHaveValue("1");
  // Left unsaved overnight, then opened from the Resume banner's Save.
  await page.clock.fastForward("10:00:00");
  await page.goto("/#/");
  await page.goto(`/#/workout/${w.id}/run`);
  await expect(
    page.getByRole("heading", { name: "Workout done" }),
  ).toBeVisible();
  await expect(minutes).toHaveValue("1");
  await expect(page.getByText(/^1 set in 1 minute\.$/u)).toBeVisible();
});

test("Skip on a timed step records nothing held, and never lowers a time held", async ({
  page,
  request,
}, testInfo) => {
  await fixedToday(page);
  const { tag } = unique(1098, testInfo);
  const id = await exerciseIds(request);
  const w = await workout(request, {
    name: `Hold ${tag}`,
    steps: [
      { kind: "exercise", exercise_id: id("Plank"), seconds: 30 },
      { kind: "exercise", exercise_id: id("Push-up"), reps: 5 },
    ],
  });
  await ownProfile(page, request, `Hold ${tag}`);
  await page.goto(`/#/workout/${w.id}/run`);
  const skip = page.getByRole("button", { name: "Skip", exact: true });
  // Skipped at once: nothing held, nothing recorded.
  await skip.click();
  await expect(page.locator(".run-where")).toHaveText("Step 2 of 2");
  expect((await kept(page, w.id)).done[0]).toEqual({});
  // Held 10 s, skipped: 10 s kept.
  await page.getByRole("button", { name: "Back" }).click();
  await page.clock.runFor(10_000);
  await skip.click();
  await expect(page.locator(".run-where")).toHaveText("Step 2 of 2");
  expect((await kept(page, w.id)).done[0]).toMatchObject({
    seconds: 10,
    reached: true,
  });
  // Back onto it and Skip at once: the 10 s stay.
  await page.getByRole("button", { name: "Back" }).click();
  await skip.click();
  await expect(page.locator(".run-where")).toHaveText("Step 2 of 2");
  expect((await kept(page, w.id)).done[0]).toMatchObject({ seconds: 10 });
});

test("a weight cleared during a run stays cleared", async ({
  page,
  request,
}, testInfo) => {
  await fixedToday(page);
  const { tag } = unique(1099, testInfo);
  const id = await exerciseIds(request);
  const w = await workout(request, {
    name: `Bare ${tag}`,
    steps: [
      { kind: "exercise", exercise_id: id("Goblet squat"), reps: 5, kg: 20 },
      { kind: "exercise", exercise_id: id("Push-up"), reps: 5 },
    ],
  });
  await ownProfile(page, request, `Bare ${tag}`);
  await page.goto(`/#/workout/${w.id}/run`);
  const weight = page.getByLabel(/^Weight used/u);
  await expect(weight).toHaveValue("20");
  await weight.fill("");
  await page.getByRole("button", { name: "Done" }).click();
  await page.getByRole("button", { name: "Back" }).click();
  await expect(weight).toHaveValue("");
  await page.getByRole("button", { name: "Done" }).click();
  await page.getByRole("button", { name: "Done" }).click();
  await expect(
    page.getByRole("heading", { name: "Workout done" }),
  ).toBeVisible();
  await expect(page.getByLabel("Goblet squat weight (kg)")).toHaveValue("");
});

test("a workout's notes show above the step after them, and in Next", async ({
  page,
  request,
}, testInfo) => {
  await fixedToday(page);
  const { tag } = unique(1100, testInfo);
  const id = await exerciseIds(request);
  const w = await workout(request, {
    name: `Noted ${tag}`,
    steps: [
      { kind: "note", name: "Warm-up", text: "5 min easy rowing" },
      { kind: "exercise", exercise_id: id("Push-up"), reps: 5 },
      { kind: "note", text: "Slow on the way down" },
      { kind: "exercise", exercise_id: id("Pull-up"), reps: 5 },
    ],
  });
  await ownProfile(page, request, `Noted ${tag}`);
  await page.goto(`/#/workout/${w.id}/run`);
  // Notes count toward no step.
  await expect(page.locator(".run-where")).toHaveText("Step 1 of 2");
  await expect(page.locator(".run-note")).toHaveText(
    "Warm-up · 5 min easy rowing",
  );
  await expect(page.locator(".run-what")).toHaveText("Push-up");
  await expect(page.getByText(/^Next: /u)).toHaveText(
    "Next: Slow on the way down · Pull-up × 5",
  );
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.locator(".run-note")).toHaveText("Slow on the way down");
  await expect(page.locator(".run-what")).toHaveText("Pull-up");
});

test("a run opens offline once its workout was read: no last time, no error", async ({
  page,
  request,
}, testInfo) => {
  await fixedToday(page);
  const { tag } = unique(1103, testInfo);
  const id = await exerciseIds(request);
  const w = await workout(request, {
    name: `Away ${tag}`,
    steps: [{ kind: "exercise", exercise_id: id("Push-up"), reps: 5 }],
  });
  await ownProfile(page, request, `Away ${tag}`);
  // The exercises' history can't be read (offline, the worker answers
  // the workout and the exercises from its cache).
  await page.route("**/api/profiles/*/exercises/*/history", (route) =>
    route.abort(),
  );
  await page.goto(`/#/workout/${w.id}/run`);
  await expect(page.locator(".run-where")).toHaveText("Step 1 of 1");
  await expect(page.locator(".run-last")).toHaveText("");
});
