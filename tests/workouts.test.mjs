// Workouts without the DOM (`node --test`): tree edits, step rules,
// estimates, unrolling and search.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  amount,
  at,
  clock,
  countdown,
  describe,
  details,
  effort,
  estimate,
  exerciseIds,
  fingerprint,
  exerciseText,
  fit,
  kcalFor,
  insert,
  matches,
  move,
  records,
  remove,
  stepError,
  unroll,
  unwrap,
  wrap,
  harder,
  lastTime,
  lastTimeText,
  newRecords,
  recordSets,
  repeatText,
  swapExercise,
  targetWeeks,
  distanceText,
  pace,
} from "../web/workouts.mjs";
import { activityLine, nightLine, sleepStats } from "../web/activity.mjs";
import { duration } from "../web/dates.mjs";
import { setRegistry } from "../web/nutrients.mjs";

const exercises = new Map(
  [
    {
      id: 1,
      name: "Pull-up",
      measure: "reps",
      load: "optional",
      laterality: "bilateral",
    },
    {
      id: 2,
      name: "Bulgarian split squat",
      measure: "reps",
      load: "optional",
      laterality: "unilateral",
    },
    {
      id: 3,
      name: "Side plank",
      measure: "time",
      load: "optional",
      laterality: "unilateral",
    },
    {
      id: 4,
      name: "Burpee",
      measure: "reps",
      load: "none",
      laterality: "bilateral",
    },
  ].map((e) => [e.id, e]),
);
const ex = (id, more = {}) => ({ kind: "exercise", exercise_id: id, ...more });
const rest = (seconds) => ({ kind: "rest", seconds });
const repeat = (times, steps, name) => ({
  kind: "repeat",
  times,
  steps,
  ...(name ? { name } : {}),
});

// pull-up, [main ×2: split squat, rest], side plank
const sample = () => [
  ex(1, { reps: 3 }),
  repeat(2, [ex(2, { reps: 10, kg: 12.5, side: "right" }), rest(15)], "main"),
  ex(3, { seconds: 30 }),
];

// Steps in a tree, repeats counted by what they hold.
const count = (steps) =>
  steps.reduce((n, s) => n + (s.kind === "repeat" ? count(s.steps) : 1), 0);
// A set done of an exercise.
const setOf = (exercise_id, more) => ({ exercise_id, name: "x", ...more });

// The server's nesting limit (/api/meta `limits.depth`).
const DEPTH = 4;

test("tree edits address steps by path and leave their input alone", () => {
  const steps = sample();
  const before = structuredClone(steps);
  assert.deepEqual(at(steps, [1, 0]).exercise_id, 2);

  const added = insert(steps, [1], 1, rest(60), DEPTH);
  assert.deepEqual(added.path, [1, 1]);
  assert.equal(at(added.steps, [1, 2]).seconds, 15);
  assert.deepEqual(remove(steps, [1, 1])[1].steps.length, 1);
  assert.deepEqual(steps, before, "inputs unchanged");
});

test("moves cross repeats and correct for the gap they leave", () => {
  const steps = sample();
  // Into the repeat, which sits one earlier once the first step leaves.
  let r = move(steps, [0], [1], 0, DEPTH);
  assert.deepEqual(r.path, [0, 0]);
  assert.equal(r.steps[0].kind, "repeat");
  assert.equal(at(r.steps, [0, 0]).exercise_id, 1);
  // Out of the repeat, to the end of the workout.
  r = move(steps, [1, 0], [], 3, DEPTH);
  assert.deepEqual(r.path, [3]);
  assert.equal(r.steps[3].exercise_id, 2);
  assert.equal(r.steps[1].steps.length, 1);
  // Down its own list: index counts positions before the move.
  r = move(steps, [0], [], 3, DEPTH);
  assert.deepEqual(
    r.steps.map((s) => s.kind),
    ["repeat", "exercise", "exercise"],
  );
  assert.deepEqual(r.path, [2]);
  // Never into itself.
  assert.equal(move(steps, [1], [1], 0, DEPTH), null);
});

test("repeats wrap and unwrap, and never nest past the limit", () => {
  const steps = sample();
  const wrapped = wrap(steps, [], 0, 1, DEPTH, 3);
  assert.deepEqual(wrapped.path, [0]);
  assert.equal(wrapped.steps[0].times, 3);
  assert.equal(wrapped.steps[0].steps.length, 2);
  assert.deepEqual(unwrap(wrapped.steps, [0]), steps);

  let deep = [ex(1, { reps: 1 })];
  for (let i = 0; i < DEPTH; i += 1) deep = wrap(deep, [], 0, 0, DEPTH).steps;
  assert.equal(wrap(deep, [], 0, 0, DEPTH), null, "one more is too deep");
  // The innermost list is 4 repeats deep: no room for another.
  assert.equal(
    insert(deep, [0, 0, 0, 0], 0, repeat(2, [rest(5)]), DEPTH),
    null,
  );
  assert.ok(insert(deep, [0, 0, 0, 0], 0, rest(5), DEPTH));
  assert.equal(move(sample(), [1], [1, 0], 0, DEPTH), null);
});

test("random edits keep every step and undo exactly", () => {
  let seed = 7;
  const random = (n) => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed % n;
  };
  for (let round = 0; round < 200; round += 1) {
    const steps = sample();
    const first = random(3);
    const last = first + random(3 - first);
    const w = wrap(steps, [], first, last, DEPTH);
    if (w) assert.deepEqual(unwrap(w.steps, w.path), steps);
    const m = move(steps, [random(3)], [], random(4), DEPTH);
    if (m) assert.equal(count(m.steps), count(steps));
  }
});

test("step rules: the cases the server shares", () => {
  const cases = JSON.parse(
    readFileSync(new URL("step-rules.json", import.meta.url)),
  );
  for (const { exercise, step, error } of cases)
    assert.equal(stepError(exercise, step), error, JSON.stringify(step));
});

test("fitting a step keeps what it can and says what it dropped", () => {
  const burpee = exercises.get(4);
  const plank = exercises.get(3);
  assert.deepEqual(fit(burpee, { reps: 8, kg: 10, side: "left" }), {
    step: { kind: "exercise", exercise_id: 4, reps: 8 },
    dropped: ["weight", "side"],
  });
  assert.deepEqual(fit(plank, { reps: 8, side: "left" }).step, {
    kind: "exercise",
    exercise_id: 3,
    seconds: 30,
    side: "left",
  });
  assert.equal(stepError(plank, fit(plank).step), null);
});

const N = "\u00a0";

test("steps read as one line, numbers never apart from their units", () => {
  assert.equal(clock(45), `45${N}s`);
  assert.equal(clock(60), `1${N}min`);
  assert.equal(clock(90), `1${N}min 30${N}s`);
  assert.equal(clock(120), `2${N}min`);
  // The time trained in a period: minutes, whole hours, or both.
  assert.equal(duration(45), `45${N}min`);
  assert.equal(duration(60), `1${N}h`);
  assert.equal(duration(75), `1${N}h 15${N}min`);
  assert.equal(duration(380), `6${N}h 20${N}min`);
  assert.equal(countdown(90), "1:30");
  assert.equal(countdown(45), "0:45");
  assert.equal(amount({ reps: 8 }), "× 8");
  assert.equal(details({ seconds: 30 }, exercises.get(3)), "each side");
  assert.equal(details({ side: "left", kg: 20 }), `left · 20${N}kg`);
  const [, main] = sample();
  assert.equal(describe(main, exercises), "main · 2 rounds");
  assert.equal(describe(repeat(1, [])), "1 round");
  assert.equal(
    describe(main.steps[0], exercises),
    `Bulgarian split squat × 10 · right · 12.5${N}kg`,
  );
  assert.equal(describe(rest(60), exercises), `Rest 1${N}min`);
  assert.equal(describe(ex(9, { reps: 1 }), exercises), "exercise 9 × 1");
});

test("unrolling repeats rounds and splits timed holds done on each side", () => {
  const run = unroll(sample(), exercises);
  assert.deepEqual(
    run.map((s) => `${s.exercise_id ?? "rest"}${s.side ? `:${s.side}` : ""}`),
    ["1", "2:right", "rest", "2:right", "rest", "3:left", "3:right"],
  );
  assert.equal(run[1].round, "main · round 1 of 2");
  assert.equal(run[3].round, "main · round 2 of 2");
  assert.equal(run[0].round, "");
});

test("a run's fingerprint changes with its steps, not with their order of keys", () => {
  const run = unroll(sample(), exercises);
  assert.equal(fingerprint(run), fingerprint(unroll(sample(), exercises)));
  // Same length, other exercise: another run.
  const other = unroll(sample(), exercises).map((s, i) =>
    i === 0 ? { ...s, exercise_id: 4 } : s,
  );
  assert.notEqual(fingerprint(other), fingerprint(run));
});

test("estimates count sets, reps, holds on each side and rests", () => {
  // 3 reps (9 s) + 2 × (10 reps one side, 30 s, + 15 s rest) + 30 s × 2 sides
  const e = estimate(sample(), exercises);
  const seconds = 9 + 2 * (30 + 15) + 60;
  assert.equal(e.sets, 4);
  assert.equal(e.minutes, Math.round(seconds / 60));
  const more = estimate([...sample(), ex(1, { reps: 50 })], exercises);
  assert.ok(more.minutes >= e.minutes && more.sets === 5);
});

test("a field being edited (empty) counts as nothing, never NaN", () => {
  const editing = [
    rest(""),
    repeat("", [ex(1, { reps: 5 })]),
    ex(1, { reps: "" }),
  ];
  const e = estimate(editing, exercises);
  assert.equal(e.sets, 1);
  assert.equal(e.minutes, 1);
  assert.ok(Number.isFinite(effort({ steps: editing }, exercises, 80).kcal));
});

test("time and energy: as set on the workout, else estimated from one rule", () => {
  const w = { steps: sample() };
  const est = effort(w, exercises, 80);
  assert.equal(est.minutesEstimated, true);
  assert.equal(est.kcal, kcalFor(est.minutes, 80));
  assert.equal(effort(w, exercises).kcal, null, "no weight, no estimate");
  const set = effort({ ...w, minutes: 30 }, exercises, 80);
  assert.equal(set.kcal, kcalFor(30, 80), "energy follows the time set");
  assert.deepEqual(
    [
      effort({ ...w, kcal: 99 }, exercises).kcal,
      effort({ ...w, kcal: 99 }, exercises).kcalEstimated,
    ],
    [99, false],
  );
  // A session has no steps: its own numbers, or energy from its minutes.
  assert.equal(effort({ minutes: 30, sets: [] }, exercises, 80).kcal, 200);
});

test("search matches every word anywhere", () => {
  const text = exerciseText({
    name: "Romanian deadlift",
    measure: "reps",
    equipment: ["barbell"],
    primary: ["hamstrings", "glutes"],
  });
  assert.ok(matches(text, "hamstrings barbell"));
  assert.ok(matches(text, "  ROMANIAN "));
  assert.ok(!matches(text, "hamstrings rings dip"));
  assert.ok(matches(text, ""));
});

test("a workout's exercises, each once", () => {
  assert.deepEqual([...exerciseIds(sample())], [1, 2, 3]);
});

test("records are sets actually done, with their day", () => {
  const sessions = [
    {
      id: 1,
      day: "2030-01-01",
      sets: [setOf(1, { reps: 8 }), setOf(1, { reps: 6, kg: 40 })],
    },
    { id: 2, day: "2030-01-03", sets: [setOf(2, { seconds: 30 })] },
    {
      id: 3,
      day: "2030-01-05",
      sets: [setOf(1, { reps: 10 }), setOf(3, { seconds: 45 })],
    },
  ];
  const r = records(sessions, 1);
  assert.deepEqual(r.reps, { set: setOf(1, { reps: 10 }), day: "2030-01-05" });
  assert.deepEqual(r.kg, {
    set: setOf(1, { reps: 6, kg: 40 }),
    day: "2030-01-01",
  });
  assert.equal(r.seconds, null);
  // Each session's best set is one of its sets, never a mix of two.
  assert.deepEqual(
    r.history.map((h) => [h.day, h.set.reps, h.set.kg ?? 0]),
    [
      ["2030-01-05", 10, 0],
      ["2030-01-01", 6, 40],
    ],
  );
  assert.deepEqual(records(sessions, 9), {
    reps: null,
    seconds: null,
    kg: null,
    history: [],
  });
  assert.equal(kcalFor(30, 80), 200);
  assert.equal(kcalFor(30, null), null);
});

test("every step fit() makes passes the step rules, but a required weight", () => {
  const cases = JSON.parse(
    readFileSync(new URL("step-rules.json", import.meta.url)),
  );
  for (const { exercise, step } of cases) {
    const e = { id: 1, ...exercise };
    const err = stepError(e, fit(e, step).step);
    assert.ok(
      err === null || err.endsWith("needs a weight (kg)"),
      `${JSON.stringify(step)}: ${err}`,
    );
  }
});

test("an EMOM repeat pads each round and counts its time", () => {
  const steps = [
    {
      kind: "repeat",
      times: 2,
      every: 60,
      steps: [{ kind: "exercise", exercise_id: 1, reps: 5 }],
    },
  ];
  const run = unroll(steps, exercises);
  assert.deepEqual(
    run.map((s) => [s.kind, s.steps ?? null, s.round]),
    [
      ["exercise", null, "round 1 of 2"],
      ["pad", 1, "round 1 of 2"],
      ["exercise", null, "round 2 of 2"],
      ["pad", 1, "round 2 of 2"],
    ],
  );
  assert.equal(describe(run[1], exercises), "Next round");
  assert.equal(repeatText(steps[0]), "2 rounds · every 1 min");
  assert.deepEqual(estimate(steps, exercises), { sets: 2, minutes: 2 });
  // Work longer than the round counts as it is.
  steps[0].every = 5;
  assert.deepEqual(estimate(steps, exercises), { sets: 2, minutes: 1 });
  assert.equal(unroll([{ ...steps[0], every: undefined }]).length, 2);
});

test("harder: the next difficulty up in the family, done the same way", () => {
  const lib = [
    {
      id: 1,
      name: "Push-up",
      measure: "reps",
      difficulty: "beginner",
      equipment: ["bodyweight"],
    },
    {
      id: 2,
      name: "Wide",
      measure: "reps",
      difficulty: "beginner",
      equipment: ["bodyweight"],
      variant_of: 1,
    },
    {
      id: 3,
      name: "Diamond",
      measure: "reps",
      difficulty: "intermediate",
      equipment: ["bodyweight"],
      variant_of: 1,
    },
    {
      id: 4,
      name: "Clap",
      measure: "reps",
      difficulty: "intermediate",
      equipment: [],
      variant_of: 1,
    },
    {
      id: 5,
      name: "Decline",
      measure: "reps",
      difficulty: "intermediate",
      equipment: ["bench"],
      variant_of: 1,
    },
    {
      id: 6,
      name: "Hold",
      measure: "time",
      difficulty: "intermediate",
      equipment: [],
      variant_of: 1,
    },
    {
      id: 7,
      name: "Archer",
      measure: "reps",
      difficulty: "advanced",
      equipment: [],
      variant_of: 1,
    },
    {
      id: 8,
      name: "Mystery",
      measure: "reps",
      difficulty: null,
      variant_of: 1,
    },
    {
      id: 9,
      name: "Hindu",
      measure: "reps",
      difficulty: "intermediate",
      variant_of: 1,
    },
    {
      id: 10,
      name: "Pike",
      measure: "reps",
      difficulty: "intermediate",
      variant_of: 1,
    },
    { id: 11, name: "Other", measure: "reps", difficulty: "intermediate" },
  ];
  const names = (e) => harder(e, lib).map((x) => x.name);
  // At most 3, by name; no bench, no timed holds, no strangers.
  assert.deepEqual(names(lib[0]), ["Clap", "Diamond", "Hindu"]);
  // From a variant too, via the root; the lowest level above wins.
  assert.deepEqual(names(lib[1]), ["Clap", "Diamond", "Hindu"]);
  assert.deepEqual(names(lib[2]), ["Archer"]);
  assert.deepEqual(names(lib[6]), []);
  assert.deepEqual(names(lib[7]), [], "unknown difficulty");
  // Equipment it already uses is fine.
  assert.deepEqual(names({ ...lib[0], equipment: ["bench"] }), [
    "Clap",
    "Decline",
    "Diamond",
  ]);
});

test("lastTime: the newest session's sets of an exercise", () => {
  const sessions = [
    {
      id: 1,
      day: "2026-10-01",
      sets: [{ exercise_id: 1, name: "Pull-up", reps: 5 }],
    },
    {
      id: 2,
      day: "2026-10-03",
      sets: [
        { exercise_id: 1, name: "Pull-up", reps: 8, kg: 20 },
        { exercise_id: 2, name: "Plank", seconds: 60 },
        { exercise_id: 1, name: "Pull-up", reps: 8 },
        { exercise_id: 1, name: "Pull-up", reps: 7, kg: 10 },
      ],
    },
    {
      id: 3,
      day: "2026-10-05",
      sets: [{ exercise_id: 2, name: "Plank", seconds: 90 }],
    },
  ];
  const last = lastTime(sessions, 1);
  assert.equal(last.day, "2026-10-03");
  assert.equal(lastTimeText(last), "× 8, × 8, × 7 · 20 kg");
  assert.equal(lastTimeText(lastTime(sessions, 2)), "1 min 30 s");
  assert.equal(lastTime(sessions, 9), null);
});

test("swapExercise swaps every step of one exercise, fitted, in a copy", () => {
  const lib = new Map([
    [1, { id: 1, name: "Pull-up", measure: "reps", load: "optional" }],
    [3, { id: 3, name: "L-sit pull-up", measure: "reps", load: "none" }],
  ]);
  const steps = [
    { kind: "exercise", exercise_id: 1, reps: 8, kg: 10 },
    { kind: "rest", seconds: 60 },
    {
      kind: "repeat",
      times: 3,
      steps: [
        { kind: "exercise", exercise_id: 1, reps: 6 },
        { kind: "exercise", exercise_id: 2, reps: 6 },
      ],
    },
  ];
  const before = structuredClone(steps);
  const next = swapExercise(steps, 1, lib.get(3));
  assert.deepEqual(steps, before);
  assert.deepEqual(next[0], { kind: "exercise", exercise_id: 3, reps: 8 });
  assert.deepEqual(next[1], steps[1]);
  assert.deepEqual(next[2].steps, [
    { kind: "exercise", exercise_id: 3, reps: 6 },
    { kind: "exercise", exercise_id: 2, reps: 6 },
  ]);
  assert.equal(next[2].times, 3);
});

test("newRecords and recordSets: sets beating an earlier best", () => {
  const s1 = {
    id: 1,
    day: "2026-10-01",
    sets: [
      { exercise_id: 1, name: "Pull-up", reps: 10 },
      { exercise_id: 2, name: "Squat", reps: 5, kg: 80 },
    ],
  };
  const s2 = {
    id: 2,
    day: "2026-10-03",
    sets: [
      { exercise_id: 1, name: "Pull-up", reps: 12 },
      { exercise_id: 1, name: "Pull-up", reps: 10 },
      { exercise_id: 2, name: "Squat", reps: 5, kg: 80 },
      { exercise_id: 3, name: "Plank", seconds: 60 },
    ],
  };
  // Pull-up beat 10; Squat only tied; Plank had nothing to beat.
  assert.deepEqual(newRecords([s1], s2), [s2.sets[0]]);
  assert.deepEqual(newRecords([], s2), []);
  assert.deepEqual([...recordSets([s1, s2], s2)], [0]);
  assert.deepEqual([...recordSets([s1, s2], s1)], []);
  // A later session doesn't take an earlier one's record away.
  const s3 = { ...s2, id: 3, day: "2026-10-04" };
  assert.deepEqual([...recordSets([s1, s2, s3], s2)], [0]);
  assert.deepEqual([...recordSets([s1, s2, s3], s3)], []);
});

// A session on each of `days`.
const on = (...days) => days.map((day) => ({ day, minutes: 30 }));

test("targetWeeks: no target, nothing to count", () => {
  assert.equal(
    targetWeeks(
      on("2026-09-08"),
      "2026-09-01",
      "2026-09-30",
      null,
      "2027-01-01",
    ),
    null,
  );
  assert.equal(
    targetWeeks(on("2026-09-08"), "2026-09-01", "2026-09-30", 0, "2027-01-01"),
    null,
  );
});

test("targetWeeks counts only Monday-first weeks wholly inside the period", () => {
  // September 2026: Tue 1 – Wed 30. Its full weeks: 7–13, 14–20, 21–27; the
  // edge weeks (from Mon Aug 31, to Sun Oct 4) don't count, sessions or not.
  const sessions = on(
    "2026-09-01",
    "2026-09-02",
    "2026-09-03",
    "2026-09-08",
    "2026-09-13",
    "2026-09-15",
    "2026-09-21",
    "2026-09-27",
    "2026-09-28",
    "2026-09-29",
  );
  assert.deepEqual(
    targetWeeks(sessions, "2026-09-01", "2026-09-30", 2, "2027-01-01"),
    { met: 2, total: 3 },
  );
});

test("targetWeeks leaves out the current week and weeks to come", () => {
  const sessions = on("2026-09-08", "2026-09-09", "2026-09-21", "2026-09-22");
  // Wednesday 23rd: the week of the 21st is still going.
  assert.deepEqual(
    targetWeeks(sessions, "2026-09-01", "2026-09-30", 2, "2026-09-23"),
    { met: 1, total: 2 },
  );
  // Monday 21st: the week before ended yesterday, so it counts.
  assert.deepEqual(
    targetWeeks(sessions, "2026-09-01", "2026-09-30", 2, "2026-09-21"),
    { met: 1, total: 2 },
  );
  // A month still to come has no week to judge.
  assert.deepEqual(
    targetWeeks([], "2026-10-01", "2026-10-31", 2, "2026-09-23"),
    { met: 0, total: 0 },
  );
});

test("targetWeeks over a year, in progress and across its ends", () => {
  // 2026 starts on a Thursday: on Wed Jan 14 only Jan 5–11 is over.
  assert.deepEqual(
    targetWeeks(on("2026-01-05"), "2026-01-01", "2026-12-31", 1, "2026-01-14"),
    { met: 1, total: 1 },
  );
  // 2025: Wed Jan 1 – Wed Dec 31; full weeks Jan 6 – Dec 28 (51). The days
  // outside them (Jan 1–5, Dec 29–31) don't count.
  assert.deepEqual(
    targetWeeks(
      on("2025-01-01", "2025-01-06", "2025-12-22", "2025-12-29"),
      "2025-01-01",
      "2025-12-31",
      1,
      "2026-06-01",
    ),
    { met: 2, total: 51 },
  );
});

test("activityLine: a day's Health Connect totals, in this device's unit", () => {
  const energy = {
    key: "energy",
    label: "Energy",
    unit: "kcal",
    goal: "about",
    category: "General",
  };
  setRegistry([energy], "kcal");
  assert.equal(activityLine({ active_kcal: null, steps: null }), null);
  assert.equal(activityLine(), null);
  assert.equal(
    activityLine({ active_kcal: 0, steps: 0 }),
    "Active ≈ 0 kcal · 0 steps",
  );
  assert.equal(
    activityLine({ active_kcal: 512, steps: 9120 }),
    "Active ≈ 512 kcal · 9,120 steps",
  );
  assert.equal(activityLine({ active_kcal: null, steps: 1 }), "1 step");
  setRegistry([energy], "kJ");
  assert.equal(
    activityLine({ active_kcal: 512, steps: null }),
    "Active ≈ 2,142 kJ",
  );
  setRegistry([], "kcal");
});

// ------------------------------------------------- Health Connect 2

// Text as read: the no-break spaces between numbers and units as spaces.
const read = (text) => text?.replaceAll("\u00a0", " ") ?? null;

test("pace: per km on foot, km/h on a bike, per 100 m swimming", () => {
  assert.equal(read(pace("run", 5000, 25)), "5:00 /km");
  assert.equal(read(pace("run", 8200, 46)), "5:37 /km");
  assert.equal(read(pace("walk", 3000, 30)), "10:00 /km");
  assert.equal(read(pace("hike", 10_000, 150)), "15:00 /km");
  assert.equal(read(pace("cycling", 20_250, 50)), "24.3 km/h");
  assert.equal(read(pace("swim", 1200, 25)), "2:05 /100 m");
  // Nothing to say: no distance, no time, or a type without one.
  assert.equal(pace("run", null, 25), null);
  assert.equal(pace("run", 0, 25), null);
  assert.equal(pace("other", 5000, 25), null);
  assert.equal(pace(null, 5000, 25), null);
  assert.equal(pace("run", 5000, 0), null);
});

test("distanceText: km to two decimals at most", () => {
  assert.equal(read(distanceText(8200)), "8.2 km");
  assert.equal(read(distanceText(5000)), "5 km");
  assert.equal(read(distanceText(42_195)), "42.2 km");
  assert.equal(read(distanceText(1250)), "1.25 km");
  assert.equal(distanceText(null), null);
});

test("nightLine: the night that ended the day, its parts as there", () => {
  assert.equal(
    read(
      nightLine({
        asleep_min: 440,
        bedtime: "23:40",
        wake_time: "07:05",
        resting_hr: 54,
        hrv_ms: 48,
      }),
    ),
    "7 h 20 min asleep · 23:40–07:05 · RHR 54 · HRV 48 ms",
  );
  assert.equal(
    read(
      nightLine({
        asleep_min: 440,
        bedtime: "23:40",
        wake_time: "07:05",
        deep_min: 70,
        rem_min: 90,
        light_min: 280,
      }),
    ),
    "7 h 20 min asleep · 23:40–07:05 · deep 1 h 10 min · REM 1 h 30 min",
  );
  assert.equal(read(nightLine({ hrv_ms: 48 })), "HRV 48 ms");
  assert.equal(nightLine({ resting_hr: 54 }), "RHR 54");
  assert.equal(nightLine({ steps: 100 }), null);
  assert.equal(nightLine(), null);
});

const night = (bedtime, asleep_min = 420, wake_time = "07:00") => ({
  bedtime,
  wake_time,
  asleep_min,
});

test("sleepStats: circular means and the spread of bedtimes", () => {
  // Around midnight: no wrap to noon.
  const s = sleepStats([night("23:50"), night("00:00"), night("00:10")]);
  assert.deepEqual(
    [s.bedtime, Math.round(s.spread), s.wake, s.asleep, s.nights],
    // The population SD: √(200 / 3) ≈ 8.2.
    ["00:00", 8, "07:00", 420, 3],
  );
  // Two nights: the mean asleep, no clock averages.
  const two = sleepStats([night("23:00", 400), night("23:30", 440)]);
  assert.deepEqual(
    [two.asleep, two.bedtime, two.spread, two.wake],
    [420, null, null, null],
  );
  // Days without a night don't count; none at all is nothing.
  assert.equal(sleepStats([{ day: "x", steps: 1 }]), null);
  assert.equal(
    sleepStats([night("22:00"), night("22:00"), night("22:00")]).spread,
    0,
  );
});

test("search reads gym shorthand and spelling variants", () => {
  const base = JSON.parse(
    readFileSync(new URL("../src/exercises.json", import.meta.url)),
  );
  const found = (q) =>
    base.filter((e) => matches(exerciseText(e), q)).map((e) => e.name);
  const finds = (q, name) =>
    assert.ok(found(q).includes(name), `"${q}" finds ${name}`);
  finds("SL hip thrust", "Single-leg hip thrust");
  finds("band pull apart", "Band pull-apart");
  finds("pullapart", "Band pull-apart");
  finds("pull-apart", "Band pull-apart");
  finds("single leg rdl", "Single-leg Romanian deadlift");
  finds("singleleg calf", "Single-leg calf raise");
  finds("db row", "Dumbbell row");
  finds("kb swing", "Kettlebell swing");
  finds("ohp", "Overhead press");
  finds("bb row", "Barbell row");
  finds("bw squat", "Bodyweight squat");
  finds("jog", "Running");
  // The shorthand still matches as typed: "sl" is on the way to "sled".
  assert.ok(matches("sled push", "sl"));
  assert.ok(!matches("hip thrust", "sl hip"));
});
