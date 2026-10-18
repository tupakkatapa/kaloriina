// Workouts without the DOM (`node --test`): tree edits, step rules,
// estimates, unrolling and search.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  distanceOf,
  kcalFor,
  metOf,
  pace,
  setActivityTypes,
  targetWeeks,
} from "../web/activities.mjs";
import { clockOf, duration } from "../web/dates.mjs";
import {
  activityHeartText,
  hypnogram,
  nightText,
  onSchedule,
  sleepStats,
} from "../web/device.mjs";
import { countdown, NBSP } from "../web/format.mjs";
import { distanceText } from "../web/units.mjs";
import {
  amount,
  at,
  clock,
  describe,
  describeSet,
  details,
  effort,
  estimate,
  exerciseIds,
  exerciseText,
  fingerprint,
  fit,
  harder,
  insert,
  lastTime,
  lastTimeText,
  matches,
  move,
  newRecords,
  pathKey,
  pathLabel,
  pathOf,
  records,
  recordSets,
  remove,
  repeatText,
  replaceAt,
  setsPerGroup,
  setText,
  slots,
  STEP_KINDS,
  stepError,
  stepOver,
  swapExercise,
  SWITCH_SECONDS,
  unroll,
  unwrap,
  wrap,
} from "../web/workouts.mjs";

// METs as /api/meta serves them (`activity_types[].met`).
setActivityTypes([
  { key: "workout", met: 5 },
  { key: "walk", met: 3.5 },
  { key: "other", met: 4 },
]);

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
    {
      id: 5,
      name: "Cossack squat",
      measure: "reps",
      load: "optional",
      laterality: "alternating",
    },
    {
      id: 6,
      name: "High knees",
      measure: "time",
      load: "none",
      laterality: "alternating",
    },
  ].map((e) => [e.id, e]),
);
const ex = (id, more = {}) => ({ kind: "exercise", exercise_id: id, ...more });
const rest = (seconds) => ({ kind: "rest", seconds });
const note = (text) => ({ kind: "note", text });
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
    readFileSync(new URL("fixtures/step-cases.json", import.meta.url)),
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

const N = "\u00A0";

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
    ["1", "2:right", "rest", "2:right", "rest", "3:left", "rest", "3:right"],
  );
  // Between the sides of a hold: a rest to switch, not work.
  assert.deepEqual(
    { ...run[6], round: undefined },
    {
      kind: "rest",
      seconds: SWITCH_SECONDS,
      label: "Switch sides",
      round: undefined,
    },
  );
  assert.equal(SWITCH_SECONDS, 15);
  assert.equal(describe(run[6], exercises), "Switch sides");
  assert.equal(run[1].round, "main · round 1 of 2");
  assert.equal(run[3].round, "main · round 2 of 2");
  assert.equal(run[0].round, "");
});

test("alternating reps count per side; an alternating hold is one block", () => {
  assert.equal(
    details({ reps: 8 }, exercises.get(5)),
    "each side, alternating",
  );
  assert.equal(details({ seconds: 30 }, exercises.get(6)), "");
  assert.deepEqual(
    unroll([ex(6, { seconds: 30 })], exercises).map((s) => s.kind),
    ["exercise"],
  );
  // 20 reps a side: 40 reps of work (2 min); 60 s of high knees: 60 s.
  assert.equal(estimate([ex(5, { reps: 20 })], exercises).minutes, 2);
  assert.equal(estimate([ex(6, { seconds: 60 })], exercises).minutes, 1);
});

test("a run's fingerprint changes with its steps, not with their order of keys", () => {
  const run = unroll(sample(), exercises);
  assert.equal(fingerprint(run), fingerprint(unroll(sample(), exercises)));
  // Same length, other exercise: another run.
  const other = unroll(sample(), exercises).map((s, i) =>
    i === 0 ? { ...s, exercise_id: 4 } : s,
  );
  assert.notEqual(fingerprint(other), fingerprint(run));
  // A resumed run saved by an earlier build still matches: the value is
  // stored, so the hash never changes.
  assert.equal(fingerprint(run), "8:ul74e");
  assert.equal(fingerprint([]), "0:28y");
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

test("note blocks are read, never run or counted, in a repeat too", () => {
  const noted = [
    note("Warm up first."),
    ex(1, { reps: 3 }),
    repeat(
      2,
      [
        note("Hips level."),
        ex(2, { reps: 10, kg: 12.5, side: "right" }),
        rest(15),
      ],
      "main",
    ),
    ex(3, { seconds: 30 }),
  ];
  // Each note rides on the step after it, every round: read above it.
  const run = unroll(noted, exercises);
  assert.deepEqual(
    run.map(({ notes: _notes, ...step }) => step),
    unroll(sample(), exercises),
  );
  assert.deepEqual(
    run.map((step) => step.notes?.map((n) => n.text) ?? null),
    [
      ["Warm up first."],
      ["Hips level."],
      null,
      ["Hips level."],
      null,
      null,
      null,
      null,
    ],
  );
  assert.deepEqual(estimate(noted, exercises), estimate(sample(), exercises));
  assert.deepEqual([...exerciseIds(noted)], [1, 2, 3]);
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
  assert.equal(est.kcal, kcalFor(est.minutes, 80, metOf("workout")));
  assert.equal(effort(w, exercises).kcal, null, "no weight, no estimate");
  const set = effort({ ...w, minutes: 30 }, exercises, 80);
  assert.equal(
    set.kcal,
    kcalFor(30, 80, metOf("workout")),
    "energy follows the time set",
  );
  assert.deepEqual(
    [
      effort({ ...w, kcal: 99 }, exercises).kcal,
      effort({ ...w, kcal: 99 }, exercises).kcalEstimated,
    ],
    [99, false],
  );
  // An activity has no steps: its own numbers, or energy from its minutes.
  // Net of resting: (MET 5 − 1) × 80 kg × ½ h.
  assert.equal(effort({ minutes: 30, sets: [] }, exercises, 80).kcal, 160);
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
  const activities = [
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
  const r = records(activities, 1);
  assert.deepEqual(r.reps, { set: setOf(1, { reps: 10 }), day: "2030-01-05" });
  assert.deepEqual(r.kg, {
    set: setOf(1, { reps: 6, kg: 40 }),
    day: "2030-01-01",
  });
  assert.equal(r.seconds, null);
  // Each activity's best set is one of its sets, never a mix of two.
  assert.deepEqual(
    r.history.map((h) => [h.day, h.set.reps, h.set.kg ?? 0]),
    [
      ["2030-01-05", 10, 0],
      ["2030-01-01", 6, 40],
    ],
  );
  assert.deepEqual(records(activities, 9), {
    reps: null,
    seconds: null,
    kg: null,
    history: [],
  });
  assert.equal(
    kcalFor(30, 80, metOf("workout")),
    160,
    "(MET 5 − 1) × 80 kg × ½ h",
  );
  assert.equal(kcalFor(60, 80, metOf("walk")), 200, "per type: (3.5 − 1) × 80");
  assert.equal(metOf("nope"), metOf("other"));
  assert.equal(kcalFor(30, null, metOf("workout")), null);
});

test("every step fit() makes passes the step rules, but a required weight", () => {
  const cases = JSON.parse(
    readFileSync(new URL("fixtures/step-cases.json", import.meta.url)),
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

test("lastTime: the newest activity's sets of an exercise", () => {
  const activities = [
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
  const last = lastTime(activities, 1);
  assert.equal(last.day, "2026-10-03");
  // One notation for a done set.
  assert.equal(lastTimeText(last), "8, 8, 7 reps · 20 kg");
  assert.equal(lastTimeText(lastTime(activities, 2)), "1 min 30 s");
  assert.equal(lastTime(activities, 9), null);
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
  // A later activity doesn't take an earlier one's record away.
  const s3 = { ...s2, id: 3, day: "2026-10-04" };
  assert.deepEqual([...recordSets([s1, s2, s3], s2)], [0]);
  assert.deepEqual([...recordSets([s1, s2, s3], s3)], []);
});

// An activity on each of `days`.
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
  // edge weeks (from Mon Aug 31, to Sun Oct 4) don't count, activities or not.
  const activities = on(
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
    targetWeeks(activities, "2026-09-01", "2026-09-30", 2, "2027-01-01"),
    { met: 2, total: 3 },
  );
});

test("targetWeeks leaves out the current week and weeks to come", () => {
  const activities = on("2026-09-08", "2026-09-09", "2026-09-21", "2026-09-22");
  // Wednesday 23rd: the week of the 21st is still going.
  assert.deepEqual(
    targetWeeks(activities, "2026-09-01", "2026-09-30", 2, "2026-09-23"),
    { met: 1, total: 2 },
  );
  // Monday 21st: the week before ended yesterday, so it counts.
  assert.deepEqual(
    targetWeeks(activities, "2026-09-01", "2026-09-30", 2, "2026-09-21"),
    { met: 1, total: 2 },
  );
  // A month still to come has no week to judge.
  assert.deepEqual(
    targetWeeks([], "2026-10-01", "2026-10-31", 2, "2026-09-23"),
    { met: 0, total: 0 },
  );
});

test("targetWeeks: no week before tracking began, none for a leftover (AC2-3, AC2-12)", () => {
  // The owner's 2026: the first activity Jun 2. The 21 weeks before it are no
  // weeks missed: counted from the week of Jun 1.
  const activities = on("2026-06-02", "2026-06-09");
  assert.deepEqual(
    targetWeeks(activities, "2026-01-01", "2026-12-31", 1, "2026-06-22"),
    { met: 2, total: 24 },
  );
  assert.deepEqual(
    targetWeeks(
      activities,
      "2026-01-01",
      "2026-12-31",
      1,
      "2026-06-22",
      "2026-06-02",
    ),
    { met: 2, total: 3 },
  );
  // A 2-minute "Activity" on a sync counts toward no target.
  assert.deepEqual(
    targetWeeks(
      [{ day: "2026-09-23", minutes: 2 }],
      "2026-09-21",
      "2026-09-27",
      1,
      "2026-10-01",
    ),
    { met: 0, total: 1 },
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

// A Log row's text as read, and whether any part of it could break inside:
// the value never, the details only between parts (" · ").
const shown = (row) => row && [read(row.value), read(row.detail)];
const breaksInside = (row) =>
  [row.value, ...(row.detail?.split(" · ") ?? [])].some((s) => s.includes(" "));

// ---------------------------------------------------- Health Connect 2

// Text as read: the no-break spaces between numbers and units as spaces.
const read = (text) => text?.replaceAll("\u00A0", " ") ?? null;

test("pace: per km, km/h or per 100 m, as the type reads", () => {
  assert.equal(read(pace("per_km", 5000, 25)), "5:00 /km");
  assert.equal(read(pace("per_km", 8200, 46)), "5:37 /km");
  assert.equal(read(pace("per_km", 3000, 30)), "10:00 /km");
  assert.equal(read(pace("per_km", 10_000, 150)), "15:00 /km");
  assert.equal(read(pace("speed", 20_250, 50)), "24.3 km/h");
  assert.equal(read(pace("per_100m", 1200, 25)), "2:05 /100 m");
  // Nothing to say: no distance, no time, or a type without one.
  assert.equal(pace("per_km", null, 25), null);
  assert.equal(pace("per_km", 0, 25), null);
  assert.equal(pace(undefined, 5000, 25), null);
  assert.equal(pace(null, 5000, 25), null);
  assert.equal(pace("per_km", 5000, 0), null);
  // A device's leftover metres are no pace ("8500:00 /km" for 2 m,
  // "1076:55 /km" for 26 m in 28 min), and no distance under 50 m.
  assert.equal(pace("per_km", 2, 17), null);
  assert.equal(pace("per_km", 26, 28), null);
  assert.equal(pace("per_km", 199, 3), null);
  assert.equal(read(pace("per_km", 200, 2)), "10:00 /km");
  assert.equal(distanceOf({ distance_m: 2 }), null);
  assert.equal(distanceOf({ distance_m: 50 }), 50);
  assert.equal(distanceOf({ distance_m: null }), null);
});

test("distanceText: km to two decimals at most", () => {
  assert.equal(read(distanceText(8200)), "8.2 km");
  assert.equal(read(distanceText(5000)), "5 km");
  assert.equal(read(distanceText(42_195)), "42.2 km");
  assert.equal(read(distanceText(1250)), "1.25 km");
  assert.equal(distanceText(null), null);
});

test("nightText: time asleep the value, the night's facts the detail", () => {
  // Bed–wake in the device's hour cycle.
  const night = `${clockOf("23:40")}–${clockOf("07:05")}`;
  const full = nightText({
    asleep_min: 440,
    bedtime: "23:40",
    wake_time: "07:05",
    deep_min: 70,
    rem_min: 90,
    light_min: 280,
    in_bed_min: 470,
    sleep_avg_hr: 52,
    resting_hr: 54,
    hrv_ms: 48,
  });
  // In bed, efficiency, each stage with its share of the night asleep,
  // heart rate asleep: the facts the Diary's static card leaves out.
  assert.deepEqual(shown(full), [
    "7 h 20 min asleep",
    `${night} · 7 h 50 min in bed · 94 % efficiency · deep 1 h 10 min (16 %) · REM 1 h 30 min (20 %) · light 4 h 40 min (64 %) · heart rate asleep 52 bpm`,
  ]);
  assert.equal(breaksInside(full), false);
  assert.deepEqual(
    shown(nightText({ asleep_min: 440, bedtime: "23:40", wake_time: "07:05" })),
    ["7 h 20 min asleep", night],
  );
  assert.deepEqual(shown(nightText({ asleep_min: 45 })), [
    "45 min asleep",
    null,
  ]);
  // The night's time asleep leads; naps (the server's total_asleep_min
  // less the night's) follow as the addition, as the day counts them.
  assert.deepEqual(
    shown(
      nightText({
        asleep_min: 440,
        total_asleep_min: 480,
        naps: 1,
        bedtime: "23:40",
        wake_time: "07:05",
      }),
    ),
    ["7 h 20 min asleep", `${night} · + 40 min nap`],
  );
  // A day of naps only leads with them.
  assert.deepEqual(shown(nightText({ total_asleep_min: 70, naps: 2 })), [
    "2 naps, 1 h 10 min",
    null,
  ]);
  assert.deepEqual(
    shown(nightText({ asleep_min: 400, total_asleep_min: 440, naps: 2 })),
    ["6 h 40 min asleep", "+ 2 naps, 40 min"],
  );
  // A nap without stages is only time in bed: said so, never counted
  // asleep (ADR 0032, `nap_in_bed_min`).
  assert.deepEqual(
    shown(nightText({ asleep_min: 440, naps: 1, nap_in_bed_min: 30 })),
    ["7 h 20 min asleep", "+ 30 min in bed nap"],
  );
  assert.deepEqual(
    shown(
      nightText({
        asleep_min: 400,
        total_asleep_min: 420,
        naps: 2,
        nap_in_bed_min: 30,
      }),
    ),
    // The time asleep is one nap's, the time in bed another's.
    [
      "6 h 40 min asleep",
      "+ 2 naps: 20 min asleep, 30 min in bed without sleep data",
    ],
  );
  assert.deepEqual(shown(nightText({ naps: 1, nap_in_bed_min: 45 })), [
    "45 min in bed nap",
    null,
  ]);
  // The stage shares sum to 100 % (each rounded alone: 12 + 12 + 77).
  assert.deepEqual(
    shown(
      nightText({ asleep_min: 352, deep_min: 41, rem_min: 41, light_min: 270 }),
    ),
    [
      "5 h 52 min asleep",
      "deep 41 min (12 %) · REM 41 min (11 %) · light 4 h 30 min (77 %)",
    ],
  );
  // The heart is a row of its own; without time asleep there is no night.
  assert.equal(nightText({ resting_hr: 54, hrv_ms: 48 }), null);
  assert.equal(nightText({ steps: 100 }), null);
  assert.equal(nightText(), null);
});

test("activityHeartText: the device's average and peak", () => {
  assert.equal(
    activityHeartText({ avg_hr: 142, max_hr: 171 }),
    `142${NBSP}bpm avg, 171${NBSP}max`,
  );
  assert.equal(
    activityHeartText({ avg_hr: 142, max_hr: null }),
    `142${NBSP}bpm avg`,
  );
  assert.equal(activityHeartText({ avg_hr: null, max_hr: 171 }), null);
  assert.equal(activityHeartText({}), null);
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
  // A night's time asleep is the night's; naps are their own figure.
  const napped = sleepStats([
    { ...night("23:00", 400), total_asleep_min: 460, naps: 1 },
    night("23:00", 440),
    { day: "x", total_asleep_min: 30, naps: 2, nap_in_bed_min: 20 },
  ]);
  assert.deepEqual(
    [napped.asleep, napped.naps],
    [420, { count: 3, asleep: 90, partial: true }],
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

test("onSchedule: bedtime and wake-up within 30 min, mod 1440", () => {
  // Targets 23:45 (1425) and 07:00 (420): across midnight both ways.
  assert.equal(onSchedule(night("00:15"), 1425, 420), true);
  assert.equal(onSchedule(night("23:15"), 1425, 420), true);
  assert.equal(onSchedule(night("00:16"), 1425, 420), false);
  assert.equal(onSchedule(night("23:45", 420, "07:31"), 1425, 420), false);
  // One target set: only it is checked.
  assert.equal(onSchedule(night("02:00"), null, 420), true);
  // No night, or no targets: no verdict.
  assert.equal(onSchedule({ day: "x", steps: 1 }, 1425, 420), null);
  assert.equal(onSchedule(night("23:45"), null, null), null);
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

// A span of `stage` from `from` to `to` ("HH:MM[:SS]" on 2026-09-04, or
// the 5th after midnight with "+").
const sept = (t) => {
  const [day, hms] = t.startsWith("+") ? ["05", t.slice(1)] : ["04", t];
  return `2026-09-${day}T${hms.length === 5 ? `${hms}:00` : hms}Z`;
};
const span = (from, to, stage) => ({
  start_at: sept(from),
  end_at: sept(to),
  stage,
});

test("hypnogram: rows, minutes and shares, awakenings, efficiency and gaps", () => {
  const slept = hypnogram([
    // Falling asleep awake: no awakening.
    span("22:00", "22:20", "awake"),
    span("22:20", "23:30", "light"),
    span("23:30", "+01:00", "deep"),
    // 30 s awake: too short to count.
    span("+01:00", "+01:00:30", "awake"),
    span("+01:00:30", "+02:00", "rem"),
    span("+02:00", "+02:10", "awake"),
    // No data from 02:10 to 02:40: a gap.
    span("+02:40", "+05:00", "light"),
    // Waking up: no awakening.
    span("+05:00", "+05:20", "awake"),
  ]);
  assert.equal(slept.start, "2026-09-04T22:00:00Z");
  assert.equal(slept.end, "2026-09-05T05:20:00Z");
  assert.deepEqual(slept.minutes, {
    awake: 51,
    light: 210,
    deep: 90,
    rem: 60,
    unknown: 0,
  });
  assert.equal(slept.asleep, 360);
  // Of the time asleep.
  assert.deepEqual(slept.share, { light: 58, deep: 25, rem: 17 });
  assert.equal(slept.awakenings, 1);
  // Asleep over the recorded time in bed (the gap left out).
  assert.equal(slept.efficiency, 88);
  assert.deepEqual(slept.gaps, [
    { start: "2026-09-05T02:10:00Z", end: "2026-09-05T02:40:00Z" },
  ]);
  // Each span placed on the night's width (0–1), in its stage's row.
  const first = slept.spans[0];
  assert.deepEqual(
    [first.stage, first.left, Number(first.width.toFixed(4))],
    ["awake", 0, Number((20 / 440).toFixed(4))],
  );
  assert.equal(slept.spans.at(-1).left + slept.spans.at(-1).width, 1);
  assert.equal(hypnogram([]), null);
});

test("step_kinds_from_one_table: every kind says each thing once", () => {
  const push = { id: 1, name: "Push-up", measure: "reps" };
  const plank = {
    id: 2,
    name: "Side plank",
    measure: "time",
    laterality: "unilateral",
  };
  const steps = {
    exercise: { kind: "exercise", exercise_id: 1, reps: 8, kg: 10 },
    rest: { kind: "rest", seconds: 90 },
    note: { kind: "note", text: "Breathe" },
    repeat: { kind: "repeat", times: 3, name: "Main", steps: [] },
  };
  assert.deepEqual(Object.keys(STEP_KINDS), Object.keys(steps));
  for (const [key, step] of Object.entries(steps)) {
    const kind = STEP_KINDS[key];
    for (const fn of ["title", "line", "describe", "problem"])
      assert.equal(typeof kind[fn], "function", `${key}.${fn}`);
    assert.equal(kind.problem(step, push), null, `${key} is fine`);
  }
  const lines = (key, e) => {
    const k = STEP_KINDS[key];
    return [
      k.title(steps[key], e),
      k.line(steps[key], e),
      k.describe(steps[key], e),
    ];
  };
  assert.deepEqual(lines("exercise", push), [
    "Push-up",
    `× 8 · 10${N}kg`,
    `Push-up × 8 · 10${N}kg`,
  ]);
  const ninety = `1${N}min 30${N}s`;
  assert.deepEqual(lines("rest"), ["Rest", ninety, `Rest ${ninety}`]);
  // Closed, a note reads one line, never its text: its name, else its
  // text's first line (cut to fit by CSS), else "Note".
  assert.deepEqual(lines("note"), ["Breathe", "", "Breathe"]);
  const cue = { kind: "note", name: "Cue", text: "Hips level.\nSlow." };
  assert.deepEqual(
    [STEP_KINDS.note.title(cue), STEP_KINDS.note.line(cue)],
    ["Cue", ""],
  );
  assert.equal(
    STEP_KINDS.note.title({ kind: "note", text: "\n Hips level. \nSlow." }),
    "Hips level.",
  );
  assert.equal(STEP_KINDS.note.title({ kind: "note", text: " " }), "Note");
  // A name alone is a note.
  assert.equal(STEP_KINDS.note.problem({ kind: "note", name: "Cue" }), null);
  assert.deepEqual(lines("repeat"), ["Main", "3 rounds", "Main · 3 rounds"]);
  // The run's description reads the same table.
  assert.equal(describe(steps.rest, new Map()), `Rest ${ninety}`);
  // What keeps each from saving.
  assert.equal(STEP_KINDS.rest.problem({ seconds: 0 }), "set how long");
  assert.equal(STEP_KINDS.note.problem({ text: " " }), "write the note");
  assert.equal(STEP_KINDS.repeat.problem({ times: 0 }), "set how many rounds");
  assert.equal(
    STEP_KINDS.exercise.problem({ exercise_id: 9, reps: 5 }),
    "unknown exercise 9",
  );
  // The estimate: a one-sided hold not given a side counts both.
  assert.equal(STEP_KINDS.exercise.seconds({ seconds: 30 }, plank), 60);
  // The editor dispatches on none of them itself.
  const editor = readFileSync(
    new URL("../web/screens/workout-editor.mjs", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(editor, /kind === "(exercise|rest|note)"/u);
  for (const key of Object.keys(STEP_KINDS))
    assert.match(editor, new RegExp(`^ {2}${key}: `, "mu"), `${key}'s panel`);
});

// `n` logged sets of exercise `id`.
const logged = (id, n) =>
  Array.from({ length: n }, () => ({ exercise_id: id }));

// Each primary muscle's group as /api/meta serves it (exercise_traits'
// `primary`, src/model/exercise.rs): one muscle of each group here.
const TRAITS = [
  {
    key: "primary",
    groups: [
      ["pectorals", "chest"],
      ["latissimus dorsi", "back"],
      ["front deltoids", "shoulders"],
      ["triceps", "arms"],
      ["quadriceps", "legs"],
      ["hamstrings", "legs"],
      ["glutes", "glutes"],
      ["obliques", "core"],
    ],
  },
];

test("setsPerGroup: a set counts once per group its primary muscles work, a week over 4", () => {
  const lifts = [
    { id: 1, primary: ["pectorals", "triceps"] },
    { id: 2, primary: ["quadriceps", "hamstrings"] },
  ];
  const activities = [
    { sets: [...logged(1, 5), ...logged(2, 4)] },
    { sets: [...logged(1, 3), ...logged(9, 2)] },
    {},
  ];
  // Bench 8 sets: chest 8, arms 8; squats 4: legs 4, not 8; an unknown
  // exercise counts nowhere. Every group the server names, in its order.
  assert.deepEqual(setsPerGroup(activities, lifts, TRAITS), [
    ["chest", 2],
    ["back", 0],
    ["shoulders", 0],
    ["arms", 2],
    ["legs", 1],
    ["glutes", 0],
    ["core", 0],
  ]);
});

test("setText: a done set in one notation, describeSet with its name", () => {
  assert.equal(setText({ reps: 5 }), "5 reps");
  assert.equal(setText({ reps: 1 }), "1 rep");
  assert.equal(setText({ seconds: 30 }), `30${NBSP}s`);
  assert.equal(setText({ reps: 8, kg: 10 }), `8 reps · 10${NBSP}kg`);
  assert.equal(setText({ seconds: 20, side: "right" }), `20${NBSP}s · right`);
  assert.equal(describeSet({ name: "Pull-up", reps: 5 }), "Pull-up · 5 reps");
});

test("step paths: as text and back, as people count them, every slot in reading order", () => {
  assert.equal(pathKey([1, 0]), "1.0");
  assert.deepEqual(pathOf("1.0"), [1, 0]);
  assert.deepEqual(pathOf(""), []);
  assert.equal(pathLabel([1, 0]), "2.1");
  const steps = [rest(1), repeat(2, [rest(2), rest(3)]), rest(4)];
  assert.deepEqual(
    slots(steps).map((s) => `${pathKey(s.list)}:${s.index}`),
    [":0", ":1", "1:0", "1:1", "1:2", ":2", ":3"],
  );
});

test("a held step moves one slot at a time, into and out of repeats, past what nests too deep", () => {
  const steps = [rest(1), repeat(2, [rest(2), rest(3)]), rest(4)];
  // Down from the top: into the repeat, first.
  assert.deepEqual(stepOver(steps, [0], 1, 3), {
    steps: [repeat(2, [rest(1), rest(2), rest(3)]), rest(4)],
    path: [0, 0],
  });
  // Down from a repeat's last step: out of it.
  assert.deepEqual(stepOver(steps, [1, 1], 1, 3), {
    steps: [rest(1), repeat(2, [rest(2)]), rest(3), rest(4)],
    path: [2],
  });
  // Up from the top, down from the bottom: nowhere.
  assert.equal(stepOver(steps, [0], -1, 3), null);
  assert.equal(stepOver(steps, [2], 1, 3), null);
  // A repeat can't go into a repeat at depth 1: it skips past.
  assert.deepEqual(stepOver([repeat(2, []), repeat(2, [rest(2)])], [0], 1, 1), {
    steps: [repeat(2, [rest(2)]), repeat(2, [])],
    path: [1],
  });
  assert.deepEqual(steps, [rest(1), repeat(2, [rest(2), rest(3)]), rest(4)]);
});

test("replacing a step swaps all of its fields, the steps given untouched", () => {
  const steps = [{ kind: "exercise", exercise_id: 1, reps: 8, kg: 20 }];
  assert.deepEqual(
    replaceAt(steps, [0], { kind: "exercise", exercise_id: 2 }),
    [{ kind: "exercise", exercise_id: 2 }],
  );
  assert.equal(steps[0].kg, 20);
});
