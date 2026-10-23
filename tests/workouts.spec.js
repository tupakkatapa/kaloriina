// The Workouts tab: workouts, exercises, runs and sessions.

import { setTimeout as delay } from "node:timers/promises";
import { expect, test } from "@playwright/test";
import {
  answer,
  exerciseIds,
  fixedToday,
  ownProfile,
  pickExercise,
  setTarget,
  starts,
  stepTitle,
  todayInApp,
  unbounded,
  unique,
  workout,
} from "./helpers.js";

// The diary's Activity card (workouts planned and done).
const logCard = (page) =>
  page.locator("section.group", {
    has: page.getByRole("heading", { name: "Activity", exact: true }),
  });

// A record on an exercise page ("Most reps", "Heaviest"): its set and day.
const record = (page, label) =>
  page
    .locator(".records dt", { hasText: label })
    .locator("xpath=following-sibling::dd[1]");

test("a workout is built from searched steps, saved and run step by step", async ({
  page,
}, testInfo) => {
  const { tag } = unique(46, testInfo);
  const name = `Legs ${tag}`;
  await page.clock.install();
  await page.goto("/#/activity");
  await page.getByRole("link", { name: "New workout" }).click();
  await page.getByLabel("Name", { exact: true }).fill(name);

  // A repeat of weighted one-sided squats and rests, then a plank.
  await page.getByRole("button", { name: "Add repeat to the workout" }).click();
  await page.getByLabel("Step 1 name").fill("main");
  await page.getByRole("button", { name: "Add exercise to repeat 1" }).click();
  await pickExercise(page, "bulgarian", "Bulgarian split squat");
  // Only what fits the move is offered: reps, weight, a side.
  await expect(page.getByLabel("Step 1.1 seconds")).toHaveCount(0);
  await page.getByLabel("Step 1.1 reps").fill("5");
  await page.getByLabel("Step 1.1 weight").fill("12.5");
  await page
    .getByRole("radiogroup", { name: "Step 1.1 side" })
    .getByRole("radio", { name: "Left" })
    .click();
  await page.getByRole("button", { name: "Add rest to repeat 1" }).click();
  await page.getByLabel("Step 1.2 rest seconds").fill("10");
  await page
    .getByRole("button", { name: "Add exercise to the workout" })
    .click();
  await pickExercise(page, "low plank", "Low plank");
  await page.getByLabel("Step 2 seconds").fill("20");
  // Each step reads as one line; the time is estimated.
  await expect(
    page.locator('[data-path="0.0"] > .step-head summary'),
  ).toHaveText("Bulgarian split squat× 5 · left · 12.5 kg");
  await expect(page.getByText(/^3\ssets · ≈\s\d+\smin/u)).toBeVisible();
  await page.getByText("Duration and energy").click();
  await page.getByLabel("Duration (min)").fill("20");
  await page.getByLabel("Energy (kcal, total)").fill("150");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(
    page.getByRole("status").getByText(`Saved ${name}`),
  ).toBeVisible();

  await page.goto("/#/activity");
  await expect(page.getByRole("link", { name: starts(name) })).toContainText(
    "3 sets · 20 min · 150 kcal",
  );
  // The row opens the workout; Start is there.
  await page.getByRole("link", { name: starts(name) }).click();
  await page.getByRole("link", { name: `Start ${name}` }).click();
  const what = page.locator(".run-what");
  const extra = page.locator(".run-extra");
  const amount = page.locator(".run-amount");
  const where = page.locator(".run-where");
  // Reps wait for Done; the side and weight show with them.
  await expect(what).toHaveText("Bulgarian split squat");
  await expect(extra).toHaveText("Left · 12.5 kg");
  await expect(amount).toHaveText("× 5");
  await expect(where).toHaveText("Step 1 of 5 · main · round 1 of 2");
  await page.getByRole("button", { name: "Done" }).click();
  // Rests count down and move on by themselves.
  await expect(what).toHaveText("Rest");
  await expect(amount).toHaveText("0:10");
  await page.clock.runFor(11_000);
  await expect(where).toHaveText("Step 3 of 5 · main · round 2 of 2");
  // A reload resumes where you were.
  await page.reload();
  await expect(where).toHaveText("Step 3 of 5 · main · round 2 of 2");
  await page.getByRole("button", { name: "Done" }).click();
  await page.getByRole("button", { name: "Skip", exact: true }).click();
  // A timed step pauses and resumes.
  await expect(what).toHaveText("Low plank");
  await page.getByRole("button", { name: "Pause" }).click();
  await expect(page.getByRole("button", { name: "Resume" })).toBeVisible();
  const held = await amount.textContent();
  expect(held).toMatch(/^0:[12]\d$/u);
  await page.clock.runFor(5_000);
  await expect(amount).toHaveText(held);
  await page.getByRole("button", { name: "Resume" }).click();
  await page.clock.runFor(21_000);
  await expect(
    page.getByRole("heading", { name: "Workout done" }),
  ).toBeVisible();
});

test("steps move by keyboard and by dragging, into and out of repeats", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(49, testInfo);
  const id = await exerciseIds(request);
  const w = await workout(request, {
    name: `Moves ${tag}`,
    steps: [
      {
        kind: "repeat",
        times: 2,
        steps: [{ kind: "exercise", exercise_id: id("Pull-up"), reps: 5 }],
      },
      { kind: "exercise", exercise_id: id("Burpee"), reps: 10 },
    ],
  });
  await page.goto(`/#/workout/${w.id}/edit`);
  const names = () =>
    page.locator("li.step > .step-head summary .name").allTextContents();
  // Keyboard: pick up, up into the repeat, drop.
  const burpee = page.getByRole("button", { name: "Move Burpee (step 2)" });
  await burpee.focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("ArrowUp");
  await expect(stepTitle(page, "0.1")).toHaveText("Burpee");
  // Escape puts it back.
  await page.keyboard.press("Escape");
  await expect(stepTitle(page, "1")).toHaveText("Burpee");
  await page.keyboard.press("Space");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Space");
  expect(await names()).toEqual(["Repeat", "Burpee", "Pull-up"]);
  await expect(stepTitle(page, "0.0")).toHaveText("Burpee");
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(stepTitle(page, "1")).toHaveText("Burpee");

  // Pointer: drag the pull-up out, above the repeat.
  const handle = page.getByRole("button", { name: "Move Pull-up (step 1.1)" });
  const target = await page
    .locator('[data-path="0"] > .step-head')
    .boundingBox();
  const from = await handle.boundingBox();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + 40, target.y + 4, { steps: 5 });
  await page.mouse.up();
  await expect(stepTitle(page, "0")).toHaveText("Pull-up");
  await expect(page.locator('[data-path="1"] .step-empty')).toBeVisible();
});

test("steps wrap into a repeat after the fact, and unwrap", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(50, testInfo);
  const id = await exerciseIds(request);
  const w = await workout(request, {
    name: `Wrap ${tag}`,
    steps: [
      { kind: "exercise", exercise_id: id("Pull-up"), reps: 5 },
      { kind: "rest", seconds: 30 },
      { kind: "exercise", exercise_id: id("Burpee"), reps: 10 },
    ],
  });
  await page.goto(`/#/workout/${w.id}/edit`);
  await page.getByRole("button", { name: "Select" }).click();
  await page.getByLabel("Select step 1").check();
  await page.getByLabel("Select step 2").check();
  await page.getByRole("button", { name: "Wrap steps 1–2 in repeat" }).click();
  await expect(stepTitle(page, "0")).toHaveText("Repeat");
  await expect(stepTitle(page, "0.1")).toHaveText("Rest");
  await expect(page.getByText(/^3\ssets/u)).toBeVisible();
  await page.getByLabel("Step 1 rounds").fill("3");
  await expect(page.getByText(/^4\ssets/u)).toBeVisible();
  // Unwrap puts the steps back in place.
  await page.getByRole("button", { name: "Unwrap" }).click();
  await expect(stepTitle(page, "1")).toHaveText("Rest");
  await expect(page.locator(".step-repeat")).toHaveCount(0);
  // A single step's "Repeat this".
  await stepTitle(page, "2").click();
  await page.getByRole("button", { name: "Wrap in repeat" }).click();
  await expect(stepTitle(page, "2.0")).toHaveText("Burpee");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(`Saved Wrap ${tag}`)).toBeVisible();
  const saved = await (await request.get(`/api/workouts/${w.id}`)).json();
  expect(saved.steps.map((s) => s.kind)).toEqual([
    "exercise",
    "rest",
    "repeat",
  ]);
});

test("a step offers only what its exercise takes, and its variants as a choice", async ({
  page,
}) => {
  await page.goto("/#/workout/new");
  await page
    .getByRole("button", { name: "Add exercise to the workout" })
    .click();
  await pickExercise(page, "burpee", "Burpee");
  await expect(page.getByLabel("Step 1 weight")).toHaveCount(0);
  await expect(
    page.getByRole("radiogroup", { name: "Step 1 side" }),
  ).toHaveCount(0);
  // Change… swaps the exercise in place.
  await page.getByRole("button", { name: "Change exercise…" }).click();
  await pickExercise(page, "bench press", "Bench press");
  await expect(page.getByLabel("Step 1 weight")).toHaveAttribute(
    "required",
    "",
  );
  await page.getByRole("button", { name: "Change exercise…" }).click();
  await pickExercise(page, "push-up", "Push-up");
  await expect(page.getByLabel("Step 1 weight")).not.toHaveAttribute(
    "required",
  );
  // The variant is a choice on the step, not a separate search: a select
  // when there are many, focus kept on it.
  const variant = page.getByRole("combobox", { name: "Step 1 variant" });
  await variant.selectOption({ label: "Diamond" });
  await expect(stepTitle(page, "0")).toHaveText("Diamond push-up");
  await expect(variant).toBeFocused();
  await expect(variant).toHaveValue(/./u);
  // Alternating reps are counted a side, with no side to pick.
  await page.getByRole("button", { name: "Change exercise…" }).click();
  await pickExercise(page, "cossack", "Cossack squat");
  await expect(
    page.getByRole("radiogroup", { name: "Step 1 side" }),
  ).toHaveCount(0);
  await expect(page.locator('[data-path="0"] > .step-head summary')).toHaveText(
    "Cossack squat× 10 · each side, alternating",
  );
  // Leaving with unsaved steps asks first.
  await page.getByRole("link", { name: "Back" }).click();
  expect(await answer(page, "Stay")).toBe("Leave without saving?");
  await expect(page.getByLabel("Step 1 reps")).toBeVisible();
});

test("leaving a workout while it loads starts no timer", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(48, testInfo);
  const res = await request.post("/api/workouts", {
    data: { name: `Short ${tag}`, steps: [{ kind: "rest", seconds: 2 }] },
  });
  const { id } = await res.json();
  await page.clock.install();
  await page.addInitScript(() => {
    window.vibrations = 0;
    navigator.vibrate = () => {
      window.vibrations += 1;
      return true;
    };
  });
  // The workout loads slowly; we're gone before it arrives.
  let answered;
  const arrived = new Promise((r) => {
    answered = r;
  });
  await page.route(`**/api/workouts/${id}`, async (route) => {
    await delay(500);
    await route.continue();
    answered();
  });
  await page.goto("/#/activity");
  // Leave only once the run screen is loading (else it never starts).
  const requested = page.waitForRequest(`**/api/workouts/${id}`);
  await page.goto(`/#/workout/${id}/run`);
  await requested;
  await page.evaluate(() => {
    location.hash = "#/activity";
  });
  // The slow load arrives (and the page has a turn to handle it) before the
  // clock runs.
  await arrived;
  await page.evaluate(() => 0);
  await page.clock.runFor(5_000);
  await expect(
    page.getByRole("heading", { name: "Activity", level: 1 }),
  ).toBeVisible();
  expect(await page.evaluate(() => window.vibrations)).toBe(0);
});

test("the exercise library searches every trait; base ones are reference", async ({
  page,
}) => {
  await page.goto("/#/exercises");
  const search = page.getByLabel("Search exercises");
  // Words match anywhere: a muscle and a piece of equipment.
  await search.fill("hamstrings barbell");
  await expect(
    page.getByRole("button", { name: /^Romanian deadlift/u }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /^Pull-up/u })).toHaveCount(0);
  // A variant is found by its own name, under its root.
  await search.fill("diamond");
  await expect(
    page.getByRole("button", { name: /^Diamond push-up/u }),
  ).toBeVisible();
  await search.fill("");
  await page.getByRole("button", { name: "Filters" }).click();
  await page.getByLabel("Equipment").selectOption("rings");
  await page.getByLabel("Difficulty").selectOption("advanced");
  await expect(
    page.getByRole("button", { name: /^Ring muscle-up/u }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /^Ring row/u })).toHaveCount(0);

  // A base exercise reads as reference.
  await page.getByRole("button", { name: /^Ring muscle-up/u }).click();
  await expect(page.getByText("From the base set")).toBeVisible();
  await expect(page.getByText("latissimus dorsi")).toBeVisible();
  await expect(page.getByText("Takes no weight")).toBeVisible();
  await expect(page.getByRole("link", { name: "Edit exercise" })).toHaveCount(
    0,
  );
});

test("`?q=` opens the exercise library on that search", async ({ page }) => {
  await page.goto("/#/exercises?q=hamstrings%20barbell");
  await expect(page.getByLabel("Search exercises")).toHaveValue(
    "hamstrings barbell",
  );
  await expect(
    page.getByRole("button", { name: /^Romanian deadlift/u }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /^Pull-up/u })).toHaveCount(0);
});

test("Log a set: picked on Records, saved as its own activity, a record on both Records and the exercise", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(670, testInfo);
  const id = await exerciseIds(request);
  await ownProfile(page, request, `Setter ${tag}`);
  await page.goto("/#/records");
  await page.getByPlaceholder("Log a set").fill("pull-up");
  await page
    .getByRole("button", { name: /^Pull-up/u })
    .first()
    .click();
  await expect(page).toHaveURL(
    new RegExp(`#/activity/new\\?exercise=${id("Pull-up")}&back=`, "u"),
  );
  await expect(
    page.getByRole("heading", { name: "Log a set", level: 1 }),
  ).toBeVisible();
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
    "Pull-up attempt",
  );
  await page.getByLabel("Pull-up reps").fill("12");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  // Back where it was picked, a record of its own.
  await expect(page).toHaveURL(/#\/records$/u);
  await expect(
    page
      .locator(".finder-section", {
        has: page.getByRole("heading", { name: "Exercises" }),
      })
      .getByRole("link", { name: /^Pull-up/u }),
  ).toContainText("12");
  await page.goto(`/#/exercise/${id("Pull-up")}`);
  await expect(record(page, "Most reps")).toHaveText(/^12\b/u);
  // The exercise's own Log a set comes back to it.
  await page.getByRole("link", { name: "Log a set" }).click();
  await expect(
    page.getByRole("heading", { name: "Log a set", level: 1 }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Back" }).first().click();
  await expect(page).toHaveURL(new RegExp(`#/exercise/${id("Pull-up")}$`, "u"));
});

test("exercises of your own carry traits; ones in use stay", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(47, testInfo);
  const name = `Towel row ${tag}`;
  await page.goto("/#/exercise/new");
  await page.getByLabel("Name").fill(name);
  await page
    .getByRole("radiogroup", { name: "Measured by" })
    .getByRole("radio", { name: "Timed" })
    .click();
  await page.getByText("Details for search and filters").click();
  await page.getByRole("checkbox", { name: "bodyweight" }).check();
  await page.getByLabel("Muscle group").selectOption("back");
  // The details fit a phone: no control widens the page.
  expect(await page.evaluate(() => innerWidth)).toBe(page.viewportSize().width);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page).toHaveURL(/#\/exercise\/\d+$/u);
  await page.goto("/#/exercises");
  await page.getByLabel("Search exercises").fill(name);
  await expect(
    page.getByRole("button", {
      name: `${name} Timed · back · bodyweight · yours`,
    }),
  ).toBeVisible();

  // Used by a workout, it can't be deleted.
  const exercise = (await (await request.get("/api/exercises")).json()).find(
    (e) => e.name === name,
  );
  await workout(request, {
    name: `Uses ${tag}`,
    steps: [{ kind: "exercise", exercise_id: exercise.id, seconds: 30 }],
  });
  await page.goto(`/#/exercise/${exercise.id}`);
  await expect(page.getByRole("link", { name: `Uses ${tag}` })).toBeVisible();
  await page.getByRole("link", { name: "Edit exercise" }).click();
  await page.getByRole("button", { name: "Delete" }).click();
  expect(await answer(page, "Delete")).toBe(`Delete ${name}?`);
  await expect(page.getByRole("alert")).toHaveText(
    `${name} is used by Uses ${tag}`,
  );
});

test("adding a rest while the exercise search is open closes the search", async ({
  page,
}) => {
  await page.goto("/#/workout/new");
  await page
    .getByRole("button", { name: "Add exercise to the workout" })
    .click();
  await page.getByRole("button", { name: "Add rest to the workout" }).click();
  await expect(page.getByLabel("Step 1 rest seconds")).toBeFocused();
  await expect(page.getByLabel("Search exercises")).toHaveCount(0);
  // The estimate reads as words, with a working link when kcal needs a weight.
  await expect(page.locator(".steps-fieldset > p.muted")).not.toContainText(
    "http",
  );
});

test("a finished run is saved to the diary, with records and the weekly count", async ({
  page,
  request,
}, testInfo) => {
  const { tag, day } = unique(51, testInfo);
  const id = await exerciseIds(request);
  const w = await workout(request, {
    name: `Log ${tag}`,
    steps: [
      { kind: "exercise", exercise_id: id("Pull-up"), reps: 5, kg: 10 },
      { kind: "exercise", exercise_id: id("Low plank"), seconds: 20 },
    ],
  });
  await ownProfile(page, request, `Lifter ${tag}`);
  await page.clock.install();
  await page.goto(`/#/workout/${w.id}/run`);
  // Two more reps than planned; the plank stopped after 5 s.
  await page.getByRole("button", { name: "One rep more" }).click();
  await page.getByRole("button", { name: "One rep more" }).click();
  await expect(page.locator(".run-amount")).toHaveText("× 7");
  // Paused for the timed step: a clock flowing in real time steps back when
  // it fires a late timer, and 5 s run then hold under 5 s by the app's
  // clock (the plank read 4).
  await page.clock.pauseAt(Date.now() + 1_000);
  await page.getByRole("button", { name: "Done" }).click();
  await page.clock.runFor(5_000);
  await page.getByRole("button", { name: "Skip", exact: true }).click();
  await page.clock.resume();
  await expect(
    page.getByRole("heading", { name: "Workout done" }),
  ).toBeVisible();
  await page.getByLabel("Day").fill(day);
  await page.getByLabel("Energy (kcal, total)").fill("90");
  await page.getByRole("button", { name: "Save to diary" }).click();

  // The diary shows it apart from food, with what it burned.
  await expect(page).toHaveURL(new RegExp(`#/day/${day}$`, "u"));
  const workouts = logCard(page);
  const done = workouts.getByRole("link", { name: starts(`Log ${tag}`) });
  // A typed total reads active, resting taken off, measured.
  await expect(done).toContainText(/active\s\d+\skcal$/u);
  await done.click();
  await page.getByRole("link", { name: "Edit activity" }).click();
  await expect(page.getByLabel("Pull-up reps")).toHaveValue("7");
  await expect(page.getByLabel("Pull-up weight (kg)")).toHaveValue("10");
  await expect(page.getByLabel("Low plank seconds")).toHaveValue("5");

  // The exercise keeps the record.
  await page.goto(`/#/exercise/${id("Pull-up")}`);
  await expect(record(page, "Most reps")).toHaveText(/^7 reps · 10\skg · /u);

  // The summary counts it against the weekly target.
  await page.goto(`/#/summary/activity/week/${day}`);
  const tiles = page.getByRole("list", { name: "Activities" });
  await expect(tiles).toContainText("1 activity");
  // Typed energy is gross: netted of a minute's resting energy once the
  // shared profile's weigh-ins give one (web/expenditure.mjs activeEnergy).
  await expect(tiles).toContainText(/(89|90)\skcal from activities/u);
});

// How many lines `re`'s match in the element's text takes.
const linesOf = (locator, re) =>
  locator.evaluate((el, source) => {
    const node = el.firstChild;
    const m = new RegExp(source, "u").exec(node.textContent);
    const range = document.createRange();
    range.setStart(node, m.index);
    range.setEnd(node, m.index + m[0].length);
    return new Set([...range.getClientRects()].map((r) => Math.round(r.top)))
      .size;
  }, re.source);

// A session done by profile `pid`, made through the API.
async function session(request, pid, data) {
  const res = await request.post(`/api/profiles/${pid}/activities`, { data });
  expect(res.ok()).toBeTruthy();
  return res.json();
}

// "2030-01-02" `n` days on.
const shift = (day, n) =>
  new Date(Date.parse(day) + n * 864e5).toISOString().slice(0, 10);

test("an activity opens from the diary, takes edited and added sets, and deletes", async ({
  page,
  request,
}, testInfo) => {
  const { tag, day } = unique(140, testInfo);
  const id = await exerciseIds(request);
  const pid = await ownProfile(page, request, `Editor ${tag}`);
  const name = `Session ${tag}`;
  // Sets go in without names: the server names them.
  const s = await session(request, pid, {
    day,
    name,
    minutes: 30,
    kcal: 200,
    sets: [{ exercise_id: id("Pull-up"), reps: 5 }],
  });
  await page.goto(`/#/day/${day}`);
  await logCard(page)
    .getByRole("link", { name: starts(name) })
    .click();
  // Its view, back to the day; the pencil edits it.
  const view = `#/activity/${s.id}?back=${encodeURIComponent(`#/day/${day}`)}`;
  await expect(page).toHaveURL(new RegExp(`${view.replace("?", "\\?")}$`, "u"));
  await page.getByRole("link", { name: "Edit activity" }).click();
  // Its exercises, each with its sets under it.
  const exercises = page.locator(".set-group > h3");
  await expect(exercises).toHaveText(["Pull-up"]);
  await expect(page.locator(".set-group .set .name")).toHaveText(["Set 1"]);
  await page.getByLabel("Pull-up reps").fill("8");
  await page.getByLabel("Add an exercise").fill("burpee");
  await page
    .locator(".sets-editor")
    .getByRole("button", { name: starts("Burpee") })
    .click();
  await expect(page.getByLabel("Burpee reps")).toBeVisible();
  await expect(exercises).toHaveText(["Pull-up", "Burpee"]);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(
    page.getByRole("status").getByText(`Saved ${name}`),
  ).toBeVisible();
  // Saved, back to its view.
  await expect(page).toHaveURL(new RegExp(`${view.replace("?", "\\?")}$`, "u"));
  const url = `/api/profiles/${pid}/activities/${s.id}`;
  const saved = await (await request.get(url)).json();
  expect(saved.sets.map((x) => x.name)).toEqual(["Pull-up", "Burpee"]);
  expect(saved.sets[0].reps).toBe(8);

  // Delete asks first, then it's gone from the day (the view's Back).
  await page.getByRole("link", { name: "Edit activity" }).click();
  await page.getByRole("button", { name: "Delete" }).click();
  expect(await answer(page, "Delete")).toMatch(
    new RegExp(`^Delete ${name} on .+\\?$`, "u"),
  );
  await expect(page).toHaveURL(new RegExp(`#/day/${day}$`, "u"));
  // `unique()` days lie ahead.
  await expect(logCard(page)).toContainText("Nothing planned.");
  await expect(
    logCard(page).getByRole("link", { name: starts(name) }),
  ).toHaveCount(0);
  expect((await request.get(url)).status()).toBe(404);
});

test("something else is logged without a saved workout, its energy estimated", async ({
  page,
  request,
}, testInfo) => {
  const { tag, day } = unique(141, testInfo);
  const pid = await ownProfile(page, request, `Rider ${tag}`);
  const name = `Ride ${tag}`;
  await page.goto(`/#/activity/new?day=${day}`);
  await page
    .getByRole("combobox", { name: "Workout", exact: true })
    .selectOption({ label: "Something else (a run, a ride…)" });
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByLabel("Duration (min)").fill("45");
  // Empty energy shows what it will be estimated as.
  const energy = page.getByLabel("Energy (kcal, total)");
  await expect(energy).toHaveValue("");
  const line = page.locator(".energy-active");
  await expect(line).toHaveText(/^active\s≈\s\d+\skcal$/u);
  const estimate = (await line.textContent()).match(/\d+/u)[0];
  await page.getByRole("button", { name: "Save" }).click();

  await expect(page).toHaveURL(new RegExp(`#/day/${day}$`, "u"));
  await expect(
    logCard(page).getByRole("link", { name: starts(name) }),
  ).toContainText(`45 min · active ≈ ${estimate} kcal`);
  // "≈" stays with its number when the line wraps.
  expect(
    await logCard(page)
      .getByRole("link", { name: starts(name) })
      .textContent(),
  ).toContain(`≈\u00A0${estimate}`);
  const [saved] = await (
    await request.get(`/api/profiles/${pid}/activities?from=${day}&to=${day}`)
  ).json();
  expect(saved).toMatchObject({ name, workout_id: null, kcal: null });
});

test("an exercise's records are its best sets, with their days", async ({
  page,
  request,
}, testInfo) => {
  const { tag, day } = unique(142, testInfo);
  const id = await exerciseIds(request);
  const pid = await ownProfile(page, request, `Records ${tag}`);
  const pullUp = (reps, kg) => ({
    exercise_id: id("Pull-up"),
    reps,
    ...(kg ? { kg } : {}),
  });
  const days = [day, shift(day, 1), shift(day, 2)];
  for (const [i, sets] of [
    [pullUp(8), pullUp(6, 5)],
    [pullUp(5, 20)],
    [pullUp(6, 10)],
  ].entries())
    await session(request, pid, {
      day: days[i],
      name: `Pulls ${tag}`,
      minutes: 20,
      sets,
    });
  const pretty = (d) =>
    page.evaluate(
      (x) =>
        new Date(`${x}T12:00`).toLocaleDateString(undefined, {
          weekday: "short",
          month: "short",
          day: "numeric",
        }),
      d,
    );
  // Its history and bests come from the server, not every activity.
  const reads = unbounded(page);
  const history = page.waitForResponse((r) =>
    r.url().endsWith(`/exercises/${id("Pull-up")}/history`),
  );
  await page.goto(`/#/exercise/${id("Pull-up")}`);
  await history;
  await expect(
    page.getByRole("heading", { name: "Your records" }),
  ).toBeVisible();
  // On the exercise's own page its name isn't repeated.
  await expect(record(page, "Most reps")).toHaveText(
    `8 reps · ${await pretty(days[0])}`,
  );
  await expect(record(page, "Heaviest")).toHaveText(
    `5 reps · 20 kg · ${await pretty(days[1])}`,
  );
  await expect(record(page, "Longest")).toHaveCount(0);
  // Every time it was done, newest first, all its sets.
  await expect(page.locator("h3:text-is('History') + ul .muted")).toHaveText([
    "6 reps · 10 kg",
    "5 reps · 20 kg",
    "8 reps, 6 reps · 5 kg",
  ]);
  expect(reads).toEqual([]);
  // Trait values read capitalised, like their labels.
  await expect(page.locator("dl.traits:not(.records) dd").first()).toHaveText(
    /^[A-Z]/u,
  );
});

test("a run finishes early, survives a reload, resumes, and discards on ask", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(143, testInfo);
  const id = await exerciseIds(request);
  const pid = await ownProfile(page, request, `Runner ${tag}`);
  const name = `Early ${tag}`;
  const w = await workout(request, {
    name,
    steps: [
      { kind: "exercise", exercise_id: id("Pull-up"), reps: 5 },
      { kind: "rest", seconds: 300 },
      { kind: "exercise", exercise_id: id("Burpee"), reps: 10 },
    ],
  });
  await page.goto(`/#/workout/${w.id}/run`);
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.locator(".run-what")).toHaveText("Rest");

  // Left mid-run (nothing asked), Activity offers to resume it.
  await page.goto("/#/activity");
  await page
    .locator(".run-banner")
    .getByRole("link", { name: "Resume" })
    .click();
  await expect(page.locator(".run-what")).toHaveText("Rest");

  // Finish early keeps what was done: the pull-ups.
  await page.getByRole("button", { name: "Finish", exact: true }).click();
  expect(await answer(page, "Finish")).toBe("Finish now?");
  const doneHeading = page.getByRole("heading", { name: "Workout done" });
  await expect(doneHeading).toBeVisible();
  await expect(page.getByText(/^1 set in /u)).toBeVisible();
  await page.reload();
  await expect(doneHeading).toBeVisible();
  await expect(page.getByText(/^1 set in /u)).toBeVisible();

  // "Don't save" asks first; Cancel keeps it, Discard drops it.
  const dontSave = page.getByRole("button", { name: "Don't save" });
  await dontSave.click();
  expect(await answer(page, "Cancel")).toBe("Discard this workout?");
  await expect(doneHeading).toBeVisible();
  await dontSave.click();
  expect(await answer(page, "Discard")).toBe("Discard this workout?");
  await expect(page).toHaveURL(/#\/activity$/u);
  await expect(page.getByRole("link", { name: starts(name) })).toBeVisible();
  const sessions = await (
    await request.get(`/api/profiles/${pid}/activities`)
  ).json();
  expect(sessions).toEqual([]);
});

test("the week's summary counts workouts against the weekly target", async ({
  page,
  request,
}, testInfo) => {
  const { tag, day } = unique(144, testInfo);
  const pid = await ownProfile(page, request, `Weekly ${tag}`);
  await setTarget(request, pid, "workouts_per_week", 3);
  await session(request, pid, {
    day,
    name: `Swim ${tag}`,
    minutes: 40,
    kcal: 300,
  });
  await page.goto(`/#/summary/activity/week/${day}`);
  await expect(page.getByText(/^1 of 3 activities this week/u)).toBeVisible();
  const bar = page.getByRole("progressbar", {
    name: "1 of 3 activities this week",
  });
  await expect(bar).toHaveAttribute("value", "1");
  await expect(bar).toHaveAttribute("max", "3");
});

// The tab reads activity >
// workout > exercise. One Start a workout, the library's search only on
// its own screen; reads bounded by days, not every activity.
test("the Activity tab reads activity > workout > exercise", async ({
  page,
  request,
}, testInfo) => {
  await fixedToday(page);
  const { tag } = unique(1021, testInfo);
  const pid = await ownProfile(page, request, `Plain ${tag}`);
  const id = await exerciseIds(request);
  const w = await workout(request, {
    name: `Plain ${tag}`,
    steps: [{ kind: "exercise", exercise_id: id("Burpee"), reps: 10 }],
  });
  const today = todayInApp();
  await session(request, pid, {
    day: today,
    name: `Did ${tag}`,
    workout_id: w.id,
    minutes: 20,
    kcal: 100,
    sets: [],
  });
  await session(request, pid, {
    day: shift(today, -40),
    name: `Old ${tag}`,
    minutes: 30,
    kcal: 50,
    sets: [],
  });
  const reads = unbounded(page);
  await page.goto("/#/activity");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Activity");
  await expect(page.locator(".week")).toHaveText(
    /^This week · 1 activity · 20\smin · active\s\d+\skcal$/u,
  );
  await expect(
    page.locator(".finder-section h2", { hasNotText: "Archived workouts" }),
  ).toHaveText(["Activities", "Workouts", "Exercises"]);
  // The latest, however old, each row its type and name; no more than
  // these two, so no "All activities".
  await expect(
    page.getByRole("link", { name: starts(`Did ${tag}`) }),
  ).toBeVisible();
  await expect(page.getByText(`Old ${tag}`)).toBeVisible();
  await expect(page.getByRole("link", { name: "All activities" })).toHaveCount(
    0,
  );
  // Each workout: its name over one line (and when it was last done),
  // opening its view; no Start on the row (the view and + start one).
  const row = page.getByRole("link", { name: starts(`Plain ${tag}`) });
  await expect(row).toHaveAttribute("href", `#/workout/${w.id}`);
  await expect(row.locator(".muted")).toHaveText(
    /^1\sset · .* · Last\sdone\s\w{3},\s\w{3}\s\d+$/u,
  );
  // Each part whole: a phone's line wraps between parts only.
  const parts = (await row.locator(".muted").textContent()).split(" · ");
  expect(parts.filter((x) => / /u.test(x))).toEqual([]);
  await expect(
    page.getByRole("link", { name: `Start Plain ${tag}` }),
  ).toHaveCount(0);
  const workouts = page.locator(".finder-section", {
    has: page.getByRole("heading", { name: "Workouts", exact: true }),
  });
  await expect(workouts.locator("li").last()).toHaveText("New workout");
  // The library is a row; its search, filters and New exercise live there.
  for (const gone of [
    page.getByRole("searchbox"),
    page.getByRole("button", { name: /^Filters/u }),
    page.getByRole("link", { name: "New exercise" }),
    page.getByRole("link", { name: "Start a workout" }),
  ])
    await expect(gone).toHaveCount(0);
  expect(reads).toEqual([]);
  await page
    .getByRole("link", { name: /^Exercise library · [\d,]+$/u })
    .click();
  await expect(page).toHaveURL(/#\/exercises$/u);
  await expect(page.getByLabel("Search exercises")).toBeVisible();
  await expect(page.getByRole("link", { name: "New exercise" })).toBeVisible();
  // All activities lists every one (its way in, past 5, is
  // activity-view.spec.js's).
  await page.goto("/#/activities");
  await expect(page.getByText(`Old ${tag}`)).toBeVisible();
});

// A plan's back link is its day, whoever linked it.
test("a plan's back link is its day", async ({ page }) => {
  await page.goto("/#/plan/2030-01-02?start=1&back=%23%2Factivity");
  await page.getByRole("link", { name: "Back" }).click();
  await expect(page).toHaveURL(/#\/day\/2030-01-02$/u);
});

test("Start shows only on a saved workout with steps", async ({
  page,
}, testInfo) => {
  const { tag } = unique(201, testInfo);
  const start = page.getByRole("button", { name: "Start", exact: true });
  await page.goto("/#/workout/new");
  await page
    .getByRole("button", { name: "Add exercise to the workout" })
    .click();
  await pickExercise(page, "burpee", "Burpee");
  await expect(stepTitle(page, "0")).toHaveText(/^Burpee/u);
  await expect(start).toBeHidden();
  // Saved, it can run.
  await page.getByLabel("Name", { exact: true }).fill(`Start ${tag}`);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(
    page.getByRole("heading", { name: `Start ${tag}` }),
  ).toBeVisible();
  await expect(start).toBeVisible();
  // Emptied, there is nothing to run.
  await page.getByRole("button", { name: "Select" }).click();
  await page.getByLabel("Select step 1").check();
  // On a phone the count takes a line of its own, above the buttons.
  if (testInfo.project.name === "mobile-chromium") {
    const count = await page.getByText("1 step selected").boundingBox();
    const cancel = await page
      .locator(".select-bar")
      .getByRole("button", { name: "Cancel" })
      .boundingBox();
    expect(count.y + count.height).toBeLessThanOrEqual(cancel.y);
  }
  await page
    .locator(".select-bar")
    .getByRole("button", { name: "Remove" })
    .click();
  await expect(start).toBeHidden();
});

test("a run logged by hand shows its distance and pace", async ({
  page,
  request,
}, testInfo) => {
  const { tag, day } = unique(654, testInfo);
  const pid = await ownProfile(page, request, `Runner ${tag}`);
  await page.goto(`/#/activity/new?day=${day}`);
  const type = page.getByRole("combobox", { name: "Type", exact: true });
  await expect(type).toBeHidden();
  await page
    .getByRole("combobox", { name: "Workout", exact: true })
    .selectOption({ label: "Something else (a run, a ride…)" });
  await expect(page.getByLabel("Distance (km)")).toBeHidden();
  await type.selectOption({ label: "Run" });
  await page.getByLabel("Name", { exact: true }).fill(`5 k ${tag}`);
  await page.getByLabel("Duration (min)").fill("25");
  await page.getByLabel("Distance (km)").fill("5");
  await page.getByLabel("Start time", { exact: true }).fill("07:30");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page).toHaveURL(new RegExp(`#/day/${day}$`, "u"));
  await expect(
    logCard(page).getByRole("link", { name: starts(`5 k ${tag}`) }),
  ).toContainText("25 min · 5 km · active");
  const [saved] = await (
    await request.get(`/api/profiles/${pid}/activities?from=${day}&to=${day}`)
  ).json();
  expect(saved).toMatchObject({
    type: "run",
    distance_m: 5000,
    source: "hand",
  });
  // 07:30 on the day where the browser is, stored in UTC.
  const local = await page.evaluate((d) => Date.parse(`${d}T07:30`), day);
  expect(Date.parse(saved.start_at)).toBe(local);
});

test("a device distance in metres saves", async ({
  page,
  request,
}, testInfo) => {
  const { tag, day } = unique(801, testInfo);
  const pid = await ownProfile(page, request, `Metres ${tag}`);
  // A hand-logged run whose distance a device filled in: 8,234 m.
  const res = await request.post(`/api/profiles/${pid}/activities`, {
    data: {
      day,
      name: `Run ${tag}`,
      minutes: 45,
      type: "run",
      distance_m: 8234,
    },
  });
  expect(res.ok()).toBeTruthy();
  const { id } = await res.json();
  await page.goto(`/#/activity/${id}/edit`);
  await expect(page.getByLabel("Distance (km)")).toHaveValue("8.234");
  await page.getByLabel("Name", { exact: true }).fill(`Long run ${tag}`);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator("#toast")).toContainText(`Saved Long run ${tag}`);
  const saved = await (
    await request.get(`/api/profiles/${pid}/activities/${id}`)
  ).json();
  expect(saved).toMatchObject({ name: `Long run ${tag}`, distance_m: 8234 });
});

test("a past activity's estimate ignores today's weigh-in", async ({
  page,
  request,
}, testInfo) => {
  const today = await fixedToday(page);
  const { tag } = unique(863, testInfo);
  const pid = await ownProfile(page, request, `Est ${tag}`);
  const ago = (n) =>
    new Date(Date.parse(`${today}T12:00:00Z`) - n * 864e5)
      .toISOString()
      .slice(0, 10);
  const weights = `/api/profiles/${pid}/weights`;
  // No weigh-in at all: no estimate, and the editor says why.
  await request.delete(`${weights}/${today}`);
  const res = await request.post(`/api/profiles/${pid}/activities`, {
    data: { day: ago(5), name: `Walk ${tag}`, minutes: 60 },
  });
  expect(res.ok()).toBeTruthy();
  const { id } = await res.json();
  await page.goto(`/#/day/${ago(5)}`);
  const row = logCard(page).locator(".log-row", { hasText: `Walk ${tag}` });
  await expect(row).toContainText("60 min");
  await expect(row).not.toContainText("kcal");
  await page.goto(`/#/activity/${id}/edit`);
  await expect(page.getByText("Log a weight to estimate it.")).toBeVisible();

  // 60 kg on its day, 90 kg today: the session keeps its net (5 − 1) MET
  // × 60 kg × 1 h.
  for (const [day, kg] of [
    [ago(10), 60],
    [today, 90],
  ])
    expect(
      (await request.put(`${weights}/${day}`, { data: { kg } })).ok(),
    ).toBeTruthy();
  await page.goto(`/#/day/${ago(5)}`);
  await expect(row).toContainText("≈ 240 kcal");
  await page.goto(`/#/activity/${id}/edit`);
  await expect(page.locator(".energy-active")).toHaveText(
    /^active\s≈\s240\skcal$/u,
  );
});

test("an activity reads the same on Activity and All activities", async ({
  page,
  request,
}, testInfo) => {
  await fixedToday(page);
  const { tag } = unique(966, testInfo);
  const day = todayInApp();
  const pid = await ownProfile(page, request, `Same ${tag}`);
  await session(request, pid, {
    day,
    name: `Ride ${tag}`,
    minutes: 40,
    kcal: 420,
  });
  const row = () =>
    page.getByRole("link", { name: starts(`Ride ${tag}`) }).locator(".muted");
  await page.goto("/#/activity");
  const recent = await row().textContent();
  expect(recent).toMatch(/· active\s\d+\skcal$/u);
  await page.goto("/#/activities");
  await expect(row()).toHaveText(recent);
});

test("a used workout archives instead of deleting, and warns its activities keep their sets; Copy copies", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag } = unique(763, testInfo);
  const pid = await ownProfile(page, request, `Archive ${tag}`);
  const id = await exerciseIds(request);
  const steps = [{ kind: "exercise", exercise_id: id("Push-up"), reps: 5 }];
  const spare = await workout(request, { name: `Spare ${tag}`, steps });
  const used = await workout(request, { name: `Used ${tag}`, steps });
  const done = await request.post(`/api/profiles/${pid}/activities`, {
    data: { day, workout_id: used.id, name: used.name, minutes: 10 },
  });
  expect(done.ok()).toBeTruthy();

  // Unused: Delete.
  await page.goto(`/#/workout/${spare.id}/edit`);
  await expect(page.getByRole("button", { name: "Delete" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Archive" })).toHaveCount(0);

  // Used: Archive, and a warning.
  await page.goto(`/#/workout/${used.id}/edit`);
  await expect(page.getByText("Past activities keep their sets")).toBeVisible();
  await expect(page.getByRole("button", { name: "Delete" })).toHaveCount(0);
  await page.getByRole("button", { name: "Archive" }).click();
  await expect(page.locator("#toast")).toContainText(`Archived Used ${tag}`);
  await expect(page.getByRole("button", { name: "Unarchive" })).toBeVisible();
  // Hidden where one is picked to plan; listed apart in Activity.
  await page.goto(`/#/plan/${day}`);
  await expect(page.getByText(`Spare ${tag}`)).toBeVisible();
  await expect(page.getByText(`Used ${tag}`)).toHaveCount(0);
  await page.goto("/#/activity");
  await expect(
    page.locator(".finder-section", { hasText: "Archived workouts" }),
  ).toContainText(`Used ${tag}`);

  // Copy: a new workout "(copy)", opened.
  await page.goto(`/#/workout/${spare.id}/edit`);
  await page.getByRole("button", { name: "Copy" }).click();
  await expect(page.locator("#toast")).toContainText(
    `Copied as Spare ${tag} (copy)`,
  );
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
    `Spare ${tag} (copy)`,
  );
  // The copy's editor, saving back to the copy's view.
  await expect(page).toHaveURL(/#\/workout\/\d+\/edit\?back=/u);
  await expect(page).not.toHaveURL(new RegExp(`#/workout/${spare.id}/`, "u"));
});

test("Copy on a meal makes “name (copy)” and opens it", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(764, testInfo);
  const oats = await (
    await request.post("/api/foods", {
      data: { name: `Oats ${tag}`, per100: { energy: 380 } },
    })
  ).json();
  const meal = await (
    await request.post("/api/meals", {
      data: {
        name: `Breakfast ${tag}`,
        items: [{ food_id: oats.id, grams: 60 }],
      },
    })
  ).json();
  await page.goto(`/#/meal/${meal.id}`);
  await page.getByRole("button", { name: "Copy" }).click();
  await expect(page.locator("#toast")).toContainText(
    `Copied as Breakfast ${tag} (copy)`,
  );
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
    `Breakfast ${tag} (copy)`,
  );
  await expect(page.locator(".items")).toContainText(`Oats ${tag}`);
});

test("a workout's notes and note blocks save, copy and read on each run step, never as steps", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(993, testInfo);
  const id = await exerciseIds(request);
  const w = await workout(request, {
    name: `Noted ${tag}`,
    steps: [
      { kind: "exercise", exercise_id: id("Push-up"), reps: 5 },
      { kind: "rest", seconds: 30 },
    ],
  });
  await page.goto(`/#/workout/${w.id}/edit`);
  const notes = page.getByRole("textbox", { name: /^Notes/u });
  await expect(page.getByText("Shown on each step of a run.")).toBeVisible();
  await notes.fill("Warm up first.\nShoulders down.");
  // A note block, read where it stands.
  await page.getByRole("button", { name: "Add note to the workout" }).click();
  await page
    .getByLabel("Step 3 note", { exact: true })
    .fill("Then stretch.\nSlowly.");
  // Named, it heads the block by that name.
  await page.getByLabel("Step 3 note name").fill("Cool-down");
  await expect(stepTitle(page, "2")).toHaveText("Cool-down");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.locator("#toast")).toContainText(`Saved Noted ${tag}`);
  await page.reload();
  await expect(notes).toHaveValue("Warm up first.\nShoulders down.");
  // Closed, it reads its name alone, never its text.
  await expect(page.locator('[data-path="2"] > .step-head summary')).toHaveText(
    "Cool-down",
  );
  await stepTitle(page, "2").click();
  await expect(page.getByLabel("Step 3 note", { exact: true })).toHaveValue(
    "Then stretch.\nSlowly.",
  );
  // Moved first, it is still no step of the run.
  await page.getByRole("button", { name: "Move Cool-down (step 3)" }).focus();
  for (const key of ["Space", "ArrowUp", "ArrowUp", "Space"])
    await page.keyboard.press(key);
  await expect(stepTitle(page, "0")).toHaveText("Cool-down");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.locator("#toast")).toContainText(`Saved Noted ${tag}`);

  // Copy copies them.
  await page.getByRole("button", { name: "Copy" }).click();
  await expect(page.locator("#toast")).toContainText(
    `Copied as Noted ${tag} (copy)`,
  );
  await expect(notes).toHaveValue("Warm up first.\nShoulders down.");
  await expect(stepTitle(page, "0")).toHaveText("Cool-down");

  // The run: two steps, the notes folded on each.
  await page.goto(`/#/workout/${w.id}/run`);
  await expect(page.locator(".run-where")).toHaveText("Step 1 of 2");
  const fold = page.locator(".run .notes-block");
  await expect(fold.locator("summary")).toHaveText("Notes");
  await expect(fold).not.toHaveAttribute("open");
  await fold.locator("summary").click();
  expect(await fold.locator(".notes-text").innerText()).toBe(
    "Warm up first.\nShoulders down.",
  );
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.locator(".run-where")).toHaveText("Step 2 of 2");
  await expect(fold.locator("summary")).toBeVisible();
});

// A note block's name is a note itself: closed, the row reads the name (or,
// unnamed, the text's first line, cut to one line); open, the name spans
// the width of the text under it, unlabelled but for its placeholder.
test("a note block reads its name closed, and its name field spans the text", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(902, testInfo);
  const id = await exerciseIds(request);
  const long = "Keep the hips level and breathe out on the way up. ".repeat(4);
  const w = await workout(request, {
    name: `Named note ${tag}`,
    steps: [
      { kind: "exercise", exercise_id: id("Push-up"), reps: 5 },
      { kind: "note", name: "Breathe out" },
      { kind: "note", text: `${long}\nSecond line.` },
    ],
  });
  for (const width of [320, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(`/#/workout/${w.id}/edit`);
    // A name alone saved, and reads as the row.
    await expect(stepTitle(page, "1")).toHaveText("Breathe out");
    // Unnamed: the first line, on one line, cut with an ellipsis.
    const first = stepTitle(page, "2");
    await expect(first).toHaveText(long.trim());
    const row = page.locator('[data-path="2"] > .step-head summary');
    await expect(row).not.toContainText("Second line.");
    const cut = await first.evaluate((el) => ({
      overflow: el.scrollWidth > el.clientWidth,
      ellipsis: getComputedStyle(el).textOverflow,
    }));
    expect(cut).toEqual({ overflow: true, ellipsis: "ellipsis" });
    // As tall as the one-line name above it.
    const [h1, h2] = [
      await stepTitle(page, "1").boundingBox(),
      await first.boundingBox(),
    ];
    expect(Math.abs(h1.height - h2.height)).toBeLessThanOrEqual(1);
    // Open: no "Name" label; the name spans the text's width.
    await stepTitle(page, "1").click();
    const panel = page.locator('[data-path="1"] .step-panel');
    const name = panel.getByRole("textbox", { name: "Step 2 note name" });
    await expect(name).toHaveAttribute(
      "placeholder",
      "Name (shown when closed)",
    );
    await expect(panel.getByText("Name", { exact: true })).toHaveCount(0);
    const text = panel.getByLabel("Step 2 note", { exact: true });
    const [a, b] = [await name.boundingBox(), await text.boundingBox()];
    expect(Math.abs(a.width - b.width), `at ${width} px`).toBeLessThanOrEqual(
      2,
    );
    expect(Math.abs(a.x - b.x), `at ${width} px`).toBeLessThanOrEqual(2);
    // Closed again for the next width.
    await stepTitle(page, "1").click();
  }
});

// A run left waiting shows atop the Diary and Activity until it's done; a
// run kept for a workout deleted since is dropped, never linked.
test("a waiting run is a Resume banner on the Diary and Activity", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(371, testInfo);
  const id = await exerciseIds(request);
  const w = await workout(request, {
    name: `Banner ${tag}`,
    steps: [
      { kind: "exercise", exercise_id: id("Push-up"), reps: 5 },
      { kind: "exercise", exercise_id: id("Pull-up"), reps: 5 },
    ],
  });
  await ownProfile(page, request, `Banner ${tag}`);
  const banner = page.locator(".run-banner");
  await page.goto("/#/");
  await expect(page.locator(".headline")).toBeVisible();
  await expect(banner).toHaveCount(0);

  await page.goto(`/#/workout/${w.id}/run`);
  await expect(page.locator(".run-where")).toHaveText("Step 1 of 2");
  await page.locator('.tabs a[data-tab="diary"]').click();
  await expect(banner).toHaveText(`Banner ${tag} in progressResume`);
  await page.locator('.tabs a[data-tab="activity"]').click();
  await expect(banner).toHaveText(`Banner ${tag} in progressResume`);
  await banner.getByRole("link", { name: "Resume" }).click();
  await expect(page).toHaveURL(new RegExp(`#/workout/${w.id}/run$`, "u"));
  await expect(page.locator(".run-where")).toHaveText("Step 1 of 2");

  // Deleted elsewhere: the Diary drops the run instead of linking to it.
  expect((await request.delete(`/api/workouts/${w.id}`)).ok()).toBeTruthy();
  await page.locator('.tabs a[data-tab="diary"]').click();
  await expect(page.locator(".headline")).toBeVisible();
  await expect(banner).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      Object.keys(localStorage).filter((k) => k.startsWith("run:")),
    ),
  ).toEqual([]);
});

// ---------------------------------------------------- the workout view

// A saved workout reads like a food: its steps, estimates
// and history, with Edit, Copy and Start.
test("a workout opens read-only: steps with notes and rounds, its line, History with sets, pencil to edit, Start", async ({
  page,
  request,
}, testInfo) => {
  const { tag, day } = unique(1122, testInfo);
  const id = await exerciseIds(request);
  const pid = await ownProfile(page, request, `View ${tag}`);
  const w = await workout(request, {
    name: `Circuit ${tag}`,
    notes: "Keep it steady.",
    steps: [
      { kind: "note", name: "Warm-up", text: "5 min easy rowing" },
      {
        kind: "repeat",
        times: 3,
        steps: [
          { kind: "exercise", exercise_id: id("Push-up"), reps: 8 },
          { kind: "rest", seconds: 60 },
        ],
      },
      { kind: "exercise", exercise_id: id("Low plank"), seconds: 30 },
    ],
  });
  // Six done: History shows the latest five, each with its sets.
  for (let n = 0; n < 6; n++)
    await session(request, pid, {
      day: shift(day, -n),
      name: w.name,
      workout_id: w.id,
      minutes: 20,
      sets: [{ exercise_id: id("Push-up"), reps: 8 + n }],
    });
  await page.goto(`/#/workout/${w.id}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(w.name);
  // Read-only: nothing to type, no Save.
  await expect(page.getByRole("button", { name: "Save" })).toHaveCount(0);
  await expect(page.getByRole("textbox")).toHaveCount(0);
  await expect(page.locator(".workout-line")).toHaveText(
    /^4\ssets · ≈\s\d+\smin/u,
  );
  // The steps in order: the note as text, the repeat's rounds, its steps
  // under it, the rest, the timed hold.
  const steps = page.locator(".workout-steps").first();
  await expect(steps).toContainText("Warm-up");
  await expect(steps).toContainText("5 min easy rowing");
  await expect(steps.locator(".step-repeat > .result")).toHaveText(
    "Repeat3 rounds",
  );
  const inner = steps.locator(".step-repeat .workout-steps > li");
  await expect(inner).toHaveText([/^Push-up\s*× 8/u, /^Rest\s*1\smin/u]);
  await expect(
    steps.getByRole("link", { name: starts("Push-up") }),
  ).toHaveAttribute("href", `#/exercise/${id("Push-up")}`);
  await expect(steps).toContainText("Low plank");
  await expect(page.locator(".notes-block .notes-text")).toHaveText(
    "Keep it steady.",
  );
  // History: the latest five, newest first, each its day over its line
  // (its sets are its view's), then All activities of it.
  const history = page.locator(".workout-history li");
  await expect(history).toHaveCount(6);
  await expect(history.first().locator(".muted")).toHaveText(/^20\smin/u);
  await expect(history.last()).toHaveText("All activities");
  const back = encodeURIComponent(`#/workout/${w.id}`);
  await expect(history.first().getByRole("link")).toHaveAttribute(
    "href",
    new RegExp(`^#/activity/\\d+\\?back=${back}$`, "u"),
  );
  // Start runs it; the pencil edits it, saving back to the view.
  await expect(
    page.getByRole("link", { name: `Start ${w.name}` }),
  ).toHaveAttribute("href", `#/workout/${w.id}/run`);
  await page.getByRole("link", { name: "Edit workout" }).click();
  await expect(page).toHaveURL(
    new RegExp(`#/workout/${w.id}/edit\\?back=${back}$`, "u"),
  );
  await page.getByLabel("Name", { exact: true }).fill(`Circuit ${tag} B`);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page).toHaveURL(new RegExp(`#/workout/${w.id}$`, "u"));
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    `Circuit ${tag} B`,
  );
  // Back leads to Activity.
  await page.getByRole("link", { name: "Back" }).click();
  await expect(page).toHaveURL(/#\/activity$/u);
});

test("Copy workout makes “name (copy)” on the server and opens its editor", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(1123, testInfo);
  const id = await exerciseIds(request);
  const w = await workout(request, {
    name: `Copied ${tag}`,
    steps: [{ kind: "exercise", exercise_id: id("Burpee"), reps: 10 }],
  });
  await page.goto(`/#/workout/${w.id}`);
  const copy = page.getByRole("button", { name: "Copy workout" });
  // Secondary, left of Start.
  await expect(copy).not.toHaveClass(/\bprimary\b/u);
  const start = page.getByRole("link", { name: `Start ${w.name}` });
  expect((await copy.boundingBox()).x).toBeLessThan(
    (await start.boundingBox()).x,
  );
  const posted = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" &&
      r.url().endsWith(`/api/workouts/${w.id}/copy`),
  );
  await copy.click();
  const made = await (await posted).json();
  expect(made.name).toBe(`Copied ${tag} (copy)`);
  await expect(page).toHaveURL(
    new RegExp(
      `#/workout/${made.id}/edit\\?back=${encodeURIComponent(`#/workout/${made.id}`)}$`,
      "u",
    ),
  );
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
    `Copied ${tag} (copy)`,
  );
  await expect(page.locator("#toast")).toContainText(`Copied ${tag} (copy)`);
  // Back from the copy's editor: the copy's view.
  await page.getByRole("link", { name: "Back" }).click();
  await expect(page).toHaveURL(new RegExp(`#/workout/${made.id}$`, "u"));
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    `Copied ${tag} (copy)`,
  );
});

test("a planned workout opens its view from the Diary, and Back returns to the day", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(1124, testInfo);
  // Plans go at most a few days ahead; the profile is the test's own.
  const day = shift(todayInApp(), -1);
  const id = await exerciseIds(request);
  const pid = await ownProfile(page, request, `Planned ${tag}`);
  const w = await workout(request, {
    name: `Planned ${tag}`,
    steps: [{ kind: "exercise", exercise_id: id("Burpee"), reps: 10 }],
  });
  const plan = await request.post(`/api/profiles/${pid}/plans`, {
    data: { day, workout_id: w.id },
  });
  expect(plan.ok()).toBeTruthy();
  await page.goto(`/#/day/${day}`);
  await logCard(page).getByRole("link", { name: w.name }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(w.name);
  await expect(page.getByRole("button", { name: "Save" })).toHaveCount(0);
  await expect(page.locator('.tabs a[data-tab="diary"]')).toHaveAttribute(
    "aria-current",
    "page",
  );
  await page.getByRole("link", { name: "Back" }).click();
  await expect(page).toHaveURL(new RegExp(`#/day/${day}$`, "u"));
  await expect(page.locator('.tabs a[data-tab="diary"]')).toHaveAttribute(
    "aria-current",
    "page",
  );
});

test("a workout's History shows when online; an archived one says so", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(1125, testInfo);
  const id = await exerciseIds(request);
  await ownProfile(page, request, `Offline ${tag}`);
  const w = await workout(request, {
    name: `Kept ${tag}`,
    archived: true,
    steps: [{ kind: "exercise", exercise_id: id("Burpee"), reps: 10 }],
  });
  await page.route("**/api/profiles/*/activities?*", (r) =>
    r.abort("internetdisconnected"),
  );
  await page.goto(`/#/workout/${w.id}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(w.name);
  await expect(page.getByText("History shows when online")).toBeVisible();
  // Archived: said, and it still starts.
  await expect(
    page.getByText("Archived: hidden where you plan or start one."),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: `Start ${w.name}` }),
  ).toBeVisible();
});

// A Save whose answer was lost, sent again (edited meanwhile),
// saves one workout, and one exercise, with the edit.
test("a workout or exercise Save retried after a lost answer saves one, with the edit", async ({
  page,
}, testInfo) => {
  const { tag } = unique(1126, testInfo);
  // The first create reaches the server; its answer never comes back.
  const loseFirst = (path) => {
    let lost = false;
    return page.route(`**/api${path}`, async (r) => {
      if (r.request().method() !== "POST" || lost) return r.fallback();
      lost = true;
      await r.fetch();
      await r.abort("internetdisconnected");
    });
  };
  await loseFirst("/workouts");
  await page.goto("/#/workout/new");
  await page.getByLabel("Name", { exact: true }).fill(`Lost ${tag}`);
  await page
    .getByRole("button", { name: "Add exercise to the workout" })
    .click();
  await pickExercise(page, "burpee", "Burpee");
  await page.getByLabel("Step 1 reps").fill("10");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("status")).not.toBeEmpty();
  await page.getByLabel("Name", { exact: true }).fill(`Lost ${tag} B`);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.locator("#toast")).toContainText(`Saved Lost ${tag} B`);
  const workouts = await (await page.request.get("/api/workouts")).json();
  expect(
    workouts.filter((x) => x.name.startsWith(`Lost ${tag}`)).map((x) => x.name),
  ).toEqual([`Lost ${tag} B`]);

  await loseFirst("/exercises");
  await page.goto("/#/exercise/new");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "New exercise",
  );
  await page.getByLabel("Name", { exact: true }).fill(`Lost move ${tag}`);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("status")).not.toBeEmpty();
  await page.getByLabel("Name", { exact: true }).fill(`Lost move ${tag} B`);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.locator("#toast")).toContainText(
    `Saved Lost move ${tag} B`,
  );
  const exercises = await (await page.request.get("/api/exercises")).json();
  expect(
    exercises
      .filter((x) => x.name.startsWith(`Lost move ${tag}`))
      .map((x) => x.name),
  ).toEqual([`Lost move ${tag} B`]);
});

// A workout's energy is the total a device shows, read as active.
test("the workout editor's energy is a total, its active part shown under it", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(1127, testInfo);
  const id = await exerciseIds(request);
  await ownProfile(page, request, `Total ${tag}`);
  const w = await workout(request, {
    name: `Total ${tag}`,
    steps: [{ kind: "exercise", exercise_id: id("Burpee"), reps: 10 }],
  });
  await page.goto(`/#/workout/${w.id}/edit`);
  await page.getByText("Duration and energy").click();
  await expect(
    page.getByText(
      "What your device or machine says, resting included. Empty: estimated from time and weight.",
    ),
  ).toBeVisible();
  const line = page.locator(".energy-active");
  await expect(line).toHaveText(/^active\s≈\s\d+\skcal$/u);
  await page.getByLabel("Duration (min)").fill("30");
  await page.getByLabel("Energy (kcal, total)").fill("300");
  await expect(line).toHaveText(/^active\s\d+\skcal · 300\stotal$/u);
  // The view reads the same.
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.locator("#toast")).toContainText(`Saved Total ${tag}`);
  const shown = (await line.textContent()).trim();
  await page.goto(`/#/workout/${w.id}`);
  await expect(page.locator(".workout-line")).toHaveText(
    `1 set · 30 min · ${shown}`,
  );
});

// A record's badge never breaks the set grid: "Set 3" stays on
// one line, level with its numbers, as the sets without one.
test("a set's Record badge keeps “Set 3” on one line, level with its numbers", async ({
  page,
  request,
}, testInfo) => {
  const { tag, day } = unique(1128, testInfo);
  const id = await exerciseIds(request);
  const pid = await ownProfile(page, request, `Badge ${tag}`);
  const pullUps = (...reps) =>
    reps.map((n) => ({ exercise_id: id("Pull-up"), reps: n }));
  await session(request, pid, {
    day: shift(day, -1),
    name: `Before ${tag}`,
    minutes: 20,
    sets: pullUps(6),
  });
  const s = await session(request, pid, {
    day,
    name: `Badge ${tag}`,
    minutes: 20,
    sets: pullUps(4, 4, 9),
  });
  for (const width of [320, 393, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(`/#/activity/${s.id}/edit`);
    const third = page.locator(".set").nth(2);
    await expect(third.locator(".badge")).toHaveText("Record");
    // The set's label as drawn (its text alone), and its reps input.
    const { label, lines, input } = await third.evaluate((row) => {
      const range = document.createRange();
      range.selectNodeContents(row.querySelector(".name").firstChild);
      const rects = range.getClientRects();
      const box = row.querySelector("input").getBoundingClientRect();
      return {
        label: rects[0].top + rects[0].height / 2,
        lines: rects.length,
        input: box.top + box.height / 2,
      };
    });
    expect(lines, `at ${width} px`).toBe(1);
    expect(Math.abs(label - input), `at ${width} px`).toBeLessThanOrEqual(2);
  }
});

// An energy phrase moves whole: at a phone's widths "active ≈ N kcal" (This
// week) and a row's "active N kcal", "N total" never break inside.
test("activity energy phrases never break inside on a phone", async ({
  page,
  request,
}, testInfo) => {
  await fixedToday(page);
  const { tag } = unique(1130, testInfo);
  const pid = await ownProfile(page, request, `Whole ${tag}`);
  const today = todayInApp();
  await session(request, pid, {
    day: today,
    name: `Estimated ${tag}`,
    minutes: 36,
  });
  await session(request, pid, {
    day: today,
    name: `Typed ${tag}`,
    minutes: 35,
    kcal: 280,
  });
  await page.goto("/#/activity");
  // Every phone width, so some line break falls where a phrase is.
  for (let width = 320; width <= 393; width += 3) {
    await page.setViewportSize({ width, height: 800 });
    const week = page.locator(".week");
    await expect(week).toContainText(/active\s≈\s\d+\skcal$/u);
    expect(await linesOf(week, /active\s≈\s[\d,]+\skcal/u), `at ${width}`).toBe(
      1,
    );
  }
  for (let width = 320; width <= 393; width += 3) {
    await page.setViewportSize({ width, height: 800 });
    const typed = page
      .getByRole("link", { name: starts(`Typed ${tag}`) })
      .locator(".muted");
    const re = /active\s[\d,]+\skcal/u;
    expect(await linesOf(typed, re), `${re} at ${width}`).toBe(1);
  }
});

// An activity not sent yet and a workout's line net a total of today's
// resting energy as served (Health Connect's), as a saved one does
// (`bmr_kcal`): 1,440 kcal a day is 1 a minute.
test("an unsent activity and a workout's line take Health Connect's resting energy", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(1150, testInfo);
  await fixedToday(page);
  const pid = await ownProfile(page, request, `Rested ${tag}`);
  const day = todayInApp();
  const at = `${day}T06:00:00Z`;
  const synced = await request.post(
    `/api/profiles/${pid}/sync/health/records`,
    {
      data: {
        device: "Pixel 9",
        records: [
          {
            kind: "BasalMetabolicRate",
            id: `bmr-${tag}`,
            start: at,
            data: {
              time: at,
              zone_offset: "Z",
              kcal_per_day: 1440,
              metadata: { data_origin: "com.google.android.apps.fitness" },
            },
          },
        ],
      },
    },
  );
  expect(synced.ok()).toBeTruthy();
  const id = await exerciseIds(request);
  const w = await workout(request, {
    name: `Rested ${tag}`,
    minutes: 30,
    kcal: 300,
    steps: [{ kind: "exercise", exercise_id: id("Burpee"), reps: 10 }],
  });
  await page.goto(`/#/workout/${w.id}`);
  await expect(page.locator(".workout-line")).toHaveText(
    /^1\sset · 30\smin · active\s270\skcal · 300\stotal$/u,
  );

  await page.goto(`/#/activity/new?day=${day}`);
  await page
    .getByRole("combobox", { name: "Workout", exact: true })
    .selectOption({ label: "Something else (a run, a ride…)" });
  await page.getByLabel("Duration (min)").fill("30");
  await page.getByLabel("Energy (kcal, total)").fill("300");
  await expect(page.locator(".energy-active")).toHaveText(
    /^active\s270\skcal · 300\stotal$/u,
  );
});

test("Space is Done on a run, but not while typing a weight", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(1168, testInfo);
  const id = await exerciseIds(request);
  await ownProfile(page, request, `Spacebar ${tag}`);
  const w = await workout(request, {
    name: `Space ${tag}`,
    steps: [
      { kind: "exercise", exercise_id: id("Pull-up"), reps: 5, kg: 10 },
      { kind: "exercise", exercise_id: id("Burpee"), reps: 10 },
    ],
  });
  await page.goto(`/#/workout/${w.id}/run`);
  const what = page.locator(".run-what");
  await expect(what).toHaveText(starts("Pull-up"));
  const weight = page.getByLabel("Weight used (kg)");
  await weight.focus();
  await page.keyboard.press("Space");
  await expect(what).toHaveText(starts("Pull-up"));
  await weight.blur();
  await page.keyboard.press("Space");
  await expect(what).toHaveText(starts("Burpee"));
});
