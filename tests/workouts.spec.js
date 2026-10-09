// The Workouts tab: workouts, exercises, runs and sessions.

import { test, expect } from "@playwright/test";
import {
  unique,
  starts,
  answer,
  ownProfile,
  exerciseIds,
  workout,
  stepTitle,
  pickExercise,
  setTarget,
} from "./helpers.js";

// The diary's Log card (workouts planned and done).
const logCard = (page) =>
  page.locator("section.group", {
    has: page.getByRole("heading", { name: "Log", exact: true }),
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
  await page.goto("/#/workouts");
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
  await expect(page.getByText(/^3 sets · ≈ \d+\smin/)).toBeVisible();
  await page.getByText("Duration and energy").click();
  await page.getByLabel("Duration (min)").fill("20");
  await page.getByLabel("Energy (kcal)").fill("150");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(
    page.getByRole("status").getByText(`Saved ${name}`),
  ).toBeVisible();

  await page.goto("/#/workouts");
  await expect(page.getByRole("link", { name: starts(name) })).toContainText(
    "3 sets · 20 min · 150 kcal",
  );
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
  expect(held).toMatch(/^0:[12]\d$/);
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
  await page.goto(`/#/workout/${w.id}`);
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
  await page.goto(`/#/workout/${w.id}`);
  await page.getByRole("button", { name: "Select" }).click();
  await page.getByLabel("Select step 1").check();
  await page.getByLabel("Select step 2").check();
  await page.getByRole("button", { name: "Wrap steps 1–2 in repeat" }).click();
  await expect(stepTitle(page, "0")).toHaveText("Repeat");
  await expect(stepTitle(page, "0.1")).toHaveText("Rest");
  await expect(page.getByText(/^3 sets/)).toBeVisible();
  await page.getByLabel("Step 1 rounds").fill("3");
  await expect(page.getByText(/^4 sets/)).toBeVisible();
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
  await expect(variant).toHaveValue(/./);
  // Leaving with unsaved steps asks first.
  await page.getByRole("link", { name: "Back" }).click();
  expect(await answer(page, "Cancel")).toBe("Leave without saving?");
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
  const arrived = new Promise((resolve) => (answered = resolve));
  await page.route(`**/api/workouts/${id}`, async (route) => {
    await new Promise((r) => setTimeout(r, 500));
    await route.continue();
    answered();
  });
  await page.goto("/#/workouts");
  // Leave only once the run screen is loading (else it never starts).
  const requested = page.waitForRequest(`**/api/workouts/${id}`);
  await page.goto(`/#/workout/${id}/run`);
  await requested;
  await page.evaluate(() => {
    location.hash = "#/workouts";
  });
  // The slow load arrives (and the page has a turn to handle it) before the
  // clock runs.
  await arrived;
  await page.evaluate(() => 0);
  await page.clock.runFor(5_000);
  await expect(
    page.getByRole("heading", { name: "Workouts", level: 1 }),
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
    page.getByRole("button", { name: /^Romanian deadlift/ }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /^Pull-up/ })).toHaveCount(0);
  // A variant is found by its own name, under its root.
  await search.fill("diamond");
  await expect(
    page.getByRole("button", { name: /^Diamond push-up/ }),
  ).toBeVisible();
  await search.fill("");
  await page.getByRole("button", { name: "Filters" }).click();
  await page.getByLabel("Equipment").selectOption("rings");
  await page.getByLabel("Difficulty").selectOption("advanced");
  await expect(
    page.getByRole("button", { name: /^Ring muscle-up/ }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /^Ring row/ })).toHaveCount(0);

  // A base exercise reads as reference.
  await page.getByRole("button", { name: /^Ring muscle-up/ }).click();
  await expect(page.getByText("From the base set")).toBeVisible();
  await expect(page.getByText("latissimus dorsi")).toBeVisible();
  await expect(page.getByText("Takes no weight")).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Edit", exact: true }),
  ).toHaveCount(0);
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
  await expect(page).toHaveURL(/#\/exercise\/\d+$/);
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
  await page.getByRole("link", { name: "Edit", exact: true }).click();
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
  await page.getByRole("button", { name: "Done" }).click();
  await page.clock.runFor(5_000);
  await page.getByRole("button", { name: "Skip", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Workout done" }),
  ).toBeVisible();
  await page.getByLabel("Day").fill(day);
  await page.getByLabel("Energy (kcal)").fill("90");
  await page.getByRole("button", { name: "Save to diary" }).click();

  // The diary shows it apart from food, with what it burned.
  await expect(page).toHaveURL(new RegExp(`#/day/${day}$`));
  const workouts = logCard(page);
  const done = workouts.getByRole("link", { name: starts(`Log ${tag}`) });
  await expect(done).toContainText("90 kcal");
  await done.click();
  await expect(page.getByLabel("Pull-up reps")).toHaveValue("7");
  await expect(page.getByLabel("Pull-up weight (kg)")).toHaveValue("10");
  await expect(page.getByLabel("Low plank seconds")).toHaveValue("5");

  // The exercise keeps the record.
  await page.goto(`/#/exercise/${id("Pull-up")}`);
  await expect(record(page, "Most reps")).toHaveText(/^7 × 10\skg · /);

  // The summary counts it against the weekly target.
  await page.goto(`/#/summary/training/week/${day}`);
  const tiles = page.getByRole("list", { name: "Workouts" });
  await expect(tiles).toContainText("1 workout");
  await expect(tiles).toContainText("90 kcal burned");
});

// A session done by profile `pid`, made through the API.
async function session(request, pid, data) {
  const res = await request.post(`/api/profiles/${pid}/sessions`, { data });
  expect(res.ok()).toBeTruthy();
  return res.json();
}

// "2030-01-02" `n` days on.
const shift = (day, n) =>
  new Date(Date.parse(day) + n * 864e5).toISOString().slice(0, 10);

test("a session opens from the diary, takes edited and added sets, and deletes", async ({
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
  await expect(page).toHaveURL(new RegExp(`#/session/${s.id}$`));
  await page.getByLabel("Pull-up reps").fill("8");
  await page.getByLabel("Add an exercise").fill("burpee");
  await page
    .locator(".sets-editor")
    .getByRole("button", { name: starts("Burpee") })
    .click();
  await expect(page.getByLabel("Burpee reps")).toBeVisible();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(
    page.getByRole("status").getByText(`Saved ${name}`),
  ).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`#/day/${day}$`));
  const url = `/api/profiles/${pid}/sessions/${s.id}`;
  const saved = await (await request.get(url)).json();
  expect(saved.sets.map((x) => x.name)).toEqual(["Pull-up", "Burpee"]);
  expect(saved.sets[0].reps).toBe(8);

  // Delete asks first, then it's gone from the day.
  await logCard(page)
    .getByRole("link", { name: starts(name) })
    .click();
  await page.getByRole("button", { name: "Delete" }).click();
  expect(await answer(page, "Delete")).toMatch(
    new RegExp(`^Delete ${name} on .+\\?$`),
  );
  await expect(page).toHaveURL(new RegExp(`#/day/${day}$`));
  await expect(logCard(page)).toContainText("Nothing logged yet. Use + Log.");
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
  await page.goto(`/#/session/new?day=${day}`);
  await page
    .getByRole("combobox", { name: "Workout", exact: true })
    .selectOption({ label: "Something else (a run, a ride…)" });
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByLabel("Duration (min)").fill("45");
  // Empty energy shows what it will be estimated as.
  const energy = page.getByLabel("Energy (kcal)");
  await expect(energy).toHaveValue("");
  await expect(energy).toHaveAttribute("placeholder", /^≈ \d+$/);
  const estimate = (await energy.getAttribute("placeholder")).slice(2);
  await page.getByRole("button", { name: "Save" }).click();

  await expect(page).toHaveURL(new RegExp(`#/day/${day}$`));
  await expect(
    logCard(page).getByRole("link", { name: starts(name) }),
  ).toContainText(`45 min · ≈ ${estimate} kcal`);
  // "≈" stays with its number when the line wraps.
  expect(
    await logCard(page)
      .getByRole("link", { name: starts(name) })
      .textContent(),
  ).toContain(`≈\u00a0${estimate}`);
  const [saved] = await (
    await request.get(`/api/profiles/${pid}/sessions?from=${day}&to=${day}`)
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
  await page.goto(`/#/exercise/${id("Pull-up")}`);
  await expect(
    page.getByRole("heading", { name: "Your records" }),
  ).toBeVisible();
  // On the exercise's own page its name isn't repeated.
  await expect(record(page, "Most reps")).toHaveText(
    `8 reps · ${await pretty(days[0])}`,
  );
  await expect(record(page, "Heaviest")).toHaveText(
    `5 × 20 kg · ${await pretty(days[1])}`,
  );
  await expect(record(page, "Longest")).toHaveCount(0);
  await expect(page.locator("h3:text-is('Recent') + ul .muted")).toHaveText([
    "6 × 10 kg",
    "5 × 20 kg",
    "6 × 5 kg",
  ]);
  // Trait values read capitalised, like their labels.
  await expect(page.locator("dl.traits:not(.records) dd").first()).toHaveText(
    /^[A-Z]/,
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

  // Left mid-run, the list offers to resume it.
  await page.goto("/#/workouts");
  await page.getByRole("link", { name: `Resume ${name}` }).click();
  await expect(page.locator(".run-what")).toHaveText("Rest");

  // Finish early keeps what was done: the pull-ups.
  await page.getByRole("button", { name: "Finish", exact: true }).click();
  expect(await answer(page, "Finish")).toBe("Finish now?");
  const doneHeading = page.getByRole("heading", { name: "Workout done" });
  await expect(doneHeading).toBeVisible();
  await expect(page.getByText(/^1 set in /)).toBeVisible();
  await page.reload();
  await expect(doneHeading).toBeVisible();
  await expect(page.getByText(/^1 set in /)).toBeVisible();

  // "Don't save" asks first; Cancel keeps it, Discard drops it.
  const dontSave = page.getByRole("button", { name: "Don't save" });
  await dontSave.click();
  expect(await answer(page, "Cancel")).toBe("Discard this workout?");
  await expect(doneHeading).toBeVisible();
  await dontSave.click();
  expect(await answer(page, "Discard")).toBe("Discard this workout?");
  await expect(page).toHaveURL(/#\/workouts$/);
  await expect(page.getByRole("link", { name: `Start ${name}` })).toBeVisible();
  const sessions = await (
    await request.get(`/api/profiles/${pid}/sessions`)
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
  await page.goto(`/#/summary/training/week/${day}`);
  await expect(page.getByText(/^1 of 3 workouts this week/)).toBeVisible();
  const bar = page.getByRole("progressbar", {
    name: "1 of 3 workouts this week",
  });
  await expect(bar).toHaveAttribute("value", "1");
  await expect(bar).toHaveAttribute("max", "3");
});

test("the Workouts tab reads plainly, its links tappable buttons", async ({
  page,
  request,
}, testInfo) => {
  const { tag, day } = unique(200, testInfo);
  const pid = await ownProfile(page, request, `Plain ${tag}`);
  const id = await exerciseIds(request);
  const w = await workout(request, {
    name: `Plain ${tag}`,
    steps: [{ kind: "exercise", exercise_id: id("Burpee"), reps: 10 }],
  });
  for (let i = 0; i < 6; i += 1)
    await session(request, pid, {
      day: shift(day, i),
      name: `Did ${tag}`,
      workout_id: w.id,
      minutes: 20,
      sets: [],
    });
  await page.goto("/#/workouts");
  const row = page.getByRole("link", { name: starts(`Plain ${tag}`) });
  await expect(row).toContainText(/ · Last done \w{3}, \w{3} \d+$/);
  await expect(
    page.getByRole("link", { name: /^All exercises/ }).locator(".muted"),
  ).toHaveText(/^[\d,]+ exercises \([\d,]+ with variants\)$/);
  const all = page.getByRole("link", { name: "All workouts done" });
  await expect(all).toHaveClass(/\bbutton\b/);
  expect((await all.boundingBox()).height).toBeGreaterThanOrEqual(44);
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
  await expect(stepTitle(page, "0")).toHaveText(/^Burpee/);
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
  await page.goto(`/#/session/new?day=${day}`);
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
  await expect(page).toHaveURL(new RegExp(`#/day/${day}$`));
  await expect(
    logCard(page).getByRole("link", { name: starts(`5 k ${tag}`) }),
  ).toContainText("25 min · 5 km · 5:00 /km");
  const [saved] = await (
    await request.get(`/api/profiles/${pid}/sessions?from=${day}&to=${day}`)
  ).json();
  expect(saved).toMatchObject({
    type: "run",
    distance_m: 5000,
    source: "manual",
  });
  // 07:30 on the day where the browser is, stored in UTC.
  const local = await page.evaluate((d) => Date.parse(`${d}T07:30`), day);
  expect(Date.parse(saved.start_at)).toBe(local);
});

test("a watch distance in metres saves", async ({
  page,
  request,
}, testInfo) => {
  const { tag, day } = unique(801, testInfo);
  const pid = await ownProfile(page, request, `Metres ${tag}`);
  // A hand-logged run whose distance a watch filled in: 8,234 m.
  const res = await request.post(`/api/profiles/${pid}/sessions`, {
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
  await page.goto(`/#/session/${id}`);
  await expect(page.getByLabel("Distance (km)")).toHaveValue("8.234");
  await page.getByLabel("Name", { exact: true }).fill(`Long run ${tag}`);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator("#toast")).toContainText(`Saved Long run ${tag}`);
  const saved = await (
    await request.get(`/api/profiles/${pid}/sessions/${id}`)
  ).json();
  expect(saved).toMatchObject({ name: `Long run ${tag}`, distance_m: 8234 });
});

test("a past session's estimate ignores today's weigh-in", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(863, testInfo);
  const pid = await ownProfile(page, request, `Est ${tag}`);
  const today = new Date().toLocaleDateString("sv-SE", {
    timeZone: "Europe/Helsinki",
  });
  const ago = (n) =>
    new Date(Date.parse(`${today}T12:00:00Z`) - n * 864e5)
      .toISOString()
      .slice(0, 10);
  const weights = `/api/profiles/${pid}/weights`;
  // No weigh-in at all: no estimate, and the editor says why.
  await request.delete(`${weights}/${today}`);
  const res = await request.post(`/api/profiles/${pid}/sessions`, {
    data: { day: ago(5), name: `Walk ${tag}`, minutes: 60 },
  });
  expect(res.ok()).toBeTruthy();
  const { id } = await res.json();
  await page.goto(`/#/day/${ago(5)}`);
  const row = logCard(page).locator(".log-row", { hasText: `Walk ${tag}` });
  await expect(row).toContainText("60 min");
  await expect(row).not.toContainText("kcal");
  await page.goto(`/#/session/${id}`);
  await expect(
    page.getByText("Log a weight to estimate energy."),
  ).toBeVisible();

  // 60 kg on its day, 90 kg today: the session keeps 5 × 60 kg × 1 h.
  for (const [day, kg] of [
    [ago(10), 60],
    [today, 90],
  ])
    expect(
      (await request.put(`${weights}/${day}`, { data: { kg } })).ok(),
    ).toBeTruthy();
  await page.goto(`/#/day/${ago(5)}`);
  await expect(row).toContainText("≈ 300 kcal");
  await page.goto(`/#/session/${id}`);
  await expect(page.getByLabel("Energy (kcal)")).toHaveAttribute(
    "placeholder",
    /^≈\s300$/,
  );
});

test("a workout done reads the same in Recently done and Workouts done", async ({
  page,
  request,
}, testInfo) => {
  const { tag, day } = unique(966, testInfo);
  const pid = await ownProfile(page, request, `Same ${tag}`);
  await session(request, pid, {
    day,
    name: `Ride ${tag}`,
    minutes: 40,
    kcal: 420,
  });
  const row = () =>
    page.getByRole("link", { name: starts(`Ride ${tag}`) }).locator(".muted");
  await page.goto("/#/workouts");
  const recent = await row().textContent();
  expect(recent).toMatch(/·\s420\skcal$/);
  await page.goto("/#/sessions");
  await expect(row()).toHaveText(recent);
});
