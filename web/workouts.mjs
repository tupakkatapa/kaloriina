// Workouts without the DOM: the step tree and its edits, the rules that fit a
// step to its exercise, estimates, search, and the order the run screen walks.
// `node --test` covers all of it.
//
// A step is `{kind: "exercise", exercise_id, reps | seconds, kg?, side?}`,
// `{kind: "rest", seconds}`, `{kind: "repeat", times, every?, name?,
// steps}` or `{kind: "note", name?, text?}` (a name, words to read, or
// both: never run or counted); with `every` (EMOM) each round
// takes that many seconds. A path is the list of indices down to a step:
// [1, 0] is the first step of the repeat that is the second step. A list
// path is the path of the repeat holding a list ([] for the workout itself).

import { kcalFor, metOf, runMetres } from "./activities.mjs";
import { activeEnergyText } from "./energy-text.mjs";
import { activeEnergy } from "./expenditure.mjs";
import { capitalized, fmt, isNil, NBSP, plural, whole } from "./format.mjs";
import { unitQty } from "./units.mjs";

// ------------------------------------------------------------ the tree

export const listAt = (steps, listPath) =>
  listPath.reduce((list, i) => list[i].steps, steps);

export const at = (steps, path) =>
  listAt(steps, path.slice(0, -1))[path.at(-1)];

// Repeats from this step down: 0 for an exercise or a rest.
const height = (step) =>
  step.kind === "repeat" ? 1 + Math.max(0, ...step.steps.map(height)) : 0;

// Whether `step` may sit in the list at `listPath` without nesting repeats
// deeper than `depth` (the server's limit, /api/meta `limits.depth`).
export const fitsAt = (step, listPath, depth) =>
  listPath.length + height(step) <= depth;

// The edits below never change their input: each returns new steps (and
// where the edited step now is), so the old steps serve as Undo. Those that
// can nest repeats return null past `depth`.

export function insert(steps, listPath, index, step, depth) {
  if (!fitsAt(step, listPath, depth)) return null;
  const next = structuredClone(steps);
  listAt(next, listPath).splice(index, 0, step);
  return { steps: next, path: [...listPath, index] };
}

export function remove(steps, path) {
  const next = structuredClone(steps);
  listAt(next, path.slice(0, -1)).splice(path.at(-1), 1);
  return next;
}

export function update(steps, path, change) {
  const next = structuredClone(steps);
  change(at(next, path));
  return next;
}

const startsWith = (path, prefix) => prefix.every((v, i) => path[i] === v);

// Move the step at `from` to position `index` of the list at `toList`
// (index counted before the step leaves). Null if it would land inside
// itself or nest too deep.
export function move(steps, from, toList, index, depth) {
  const step = at(steps, from);
  if (startsWith(toList, from) || !fitsAt(step, toList, depth)) return null;
  const parent = from.slice(0, -1);
  const target = [...toList];
  let i = index;
  // Taking the step out shifts what comes after it in its own list.
  if (startsWith(target, parent) && target.length > parent.length) {
    if (target[parent.length] > from.at(-1)) target[parent.length] -= 1;
  } else if (
    target.length === parent.length &&
    startsWith(target, parent) &&
    i > from.at(-1)
  )
    i -= 1;
  const next = remove(steps, from);
  listAt(next, target).splice(i, 0, step);
  return { steps: next, path: [...target, i] };
}

// Put steps `first`..`last` of the list at `listPath` into a new repeat.
export function wrap(steps, listPath, first, last, depth, times = 2) {
  const list = listAt(steps, listPath);
  const repeat = {
    kind: "repeat",
    times,
    steps: structuredClone(list.slice(first, last + 1)),
  };
  if (!fitsAt(repeat, listPath, depth)) return null;
  const next = structuredClone(steps);
  listAt(next, listPath).splice(first, last - first + 1, repeat);
  return { steps: next, path: [...listPath, first] };
}

// Replace the repeat at `path` with its steps.
export function unwrap(steps, path) {
  const next = structuredClone(steps);
  const list = listAt(next, path.slice(0, -1));
  list.splice(path.at(-1), 1, ...list[path.at(-1)].steps);
  return next;
}

// A step's path as text ("1.0"), back, and as people count it ("2.1").
export const pathKey = (path) => path.join(".");
export const pathOf = (k) => (k === "" ? [] : k.split(".").map(Number));
export const pathLabel = (path) => path.map((i) => i + 1).join(".");

// Every place a step could go in `list`, in reading order.
export function slots(list, listPath = []) {
  return [
    ...list.flatMap((s, i) => [
      { list: listPath, index: i },
      ...(s.kind === "repeat" ? slots(s.steps, [...listPath, i]) : []),
    ]),
    { list: listPath, index: list.length },
  ];
}

// The step at `path` moved one place `dir` (1 down, -1 up) through every
// slot, into and out of repeats, past those it can't take (too deep): the
// move, or null at an end.
export function stepOver(steps, path, dir, depth) {
  const all = slots(steps);
  const parent = pathKey(path.slice(0, -1));
  const i = path.at(-1);
  const from = all.findIndex(
    (s) => pathKey(s.list) === parent && s.index === i + (dir > 0 ? 1 : 0),
  );
  for (let j = from + dir; j >= 0 && j < all.length; j += dir) {
    const result = move(steps, path, all[j].list, all[j].index, depth);
    if (result && pathKey(result.path) !== pathKey(path)) return result;
  }
  return null;
}

// The step at `path` replaced by `step` (a variant or exercise switch).
export const replaceAt = (steps, path, step) =>
  update(steps, path, (s) => {
    for (const k of Object.keys(s)) delete s[k];
    Object.assign(s, step);
  });

// ---------------------------------------------------------- step rules

const unilateral = (e) => e.laterality === "unilateral";

// Whether a step not given a side is done on each side: a one-sided
// exercise, or an alternating one counted in reps (8 means 8 a side). An
// alternating hold (high knees, bear crawl) is one block of time.
const eachSide = (s, e) =>
  !s.side &&
  !!e &&
  (unilateral(e) || (e.laterality === "alternating" && !s.seconds));

// What's wrong with a step for its exercise, or null. The server applies the
// same rules (`step_fits` in src/model/workout.rs);
// tests/fixtures/step-cases.json holds the cases both must agree on.
export function stepError(exercise, step) {
  const { name, measure, load = "optional" } = exercise;
  if (measure === "reps" && step.reps === undefined)
    return `${name} is done for reps`;
  if (measure === "time" && step.seconds === undefined)
    return `${name} is done for a time`;
  if (load === "none" && step.kg !== undefined)
    return `${name} takes no weight`;
  if (load === "required" && step.kg === undefined)
    return `${name} needs a weight (kg)`;
  if (!unilateral(exercise) && step.side !== undefined)
    return `${name} has no sides`;
  return null;
}

// `step` made to fit `exercise`: reps or seconds as it's measured (keeping
// the amount when it can), and no weight or side it can't take. `dropped`
// names what was lost, so the editor can say so.
export function fit(exercise, step = {}) {
  const next = { kind: "exercise", exercise_id: exercise.id };
  const dropped = [];
  if (exercise.measure === "time") next.seconds = step.seconds ?? 30;
  else next.reps = step.reps ?? 10;
  if (step.kg !== undefined) {
    if ((exercise.load ?? "optional") === "none") dropped.push("weight");
    else next.kg = step.kg;
  }
  if (step.side !== undefined) {
    if (unilateral(exercise)) next.side = step.side;
    else dropped.push("side");
  }
  return { step: next, dropped };
}

// ------------------------------------------------------------- reading

// A duration in a list or summary: "45 s", "1 min", "1 min 30 s".
export function clock(seconds) {
  if (seconds < 60) return `${seconds}${NBSP}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}${NBSP}min${s ? ` ${s}${NBSP}s` : ""}`;
}

// "20 kg", "12.5 kg" (lb in US units).
const loadText = (weight) => unitQty(weight, "kg", 2);

// "1 round", "3 rounds".
export const rounds = (n) => plural(n, "round");

// "3 rounds", or "10 rounds · every 1 min" for an EMOM repeat.
export const repeatText = (step) =>
  [rounds(step.times || 0), step.every ? `every ${clock(step.every)}` : null]
    .filter(Boolean)
    .join(" · ");

// "× 8" or "45 s".
export const amount = (step) =>
  step.seconds ? clock(step.seconds) : `× ${step.reps}`;

// What a step adds to its exercise: "left · 20 kg", "each side" for a
// one-sided exercise done on both, "each side, alternating" for reps
// that switch sides as they go.
export function details(step, exercise) {
  const side =
    step.side ??
    (eachSide(step, exercise)
      ? unilateral(exercise)
        ? "each side"
        : "each side, alternating"
      : null);
  return [side, step.kg ? loadText(step.kg) : null].filter(Boolean).join(" · ");
}

// Seconds per rep, for the time estimate.
const SECONDS_PER_REP = 3;

const joined = (parts) => parts.filter(Boolean).join(" · ");

// The kinds of step a workout holds, each said once: its `title` and
// `line` (the editor's row), how a run `describe`s it in one line, the
// `sets` and `seconds` it adds to an estimate (a repeat: its rounds of its
// steps), and the `problem` that keeps it from saving (null: none). `e`
// is the step's exercise, if it has one. A new kind is one more entry here
// and its panel in the editor.
export const STEP_KINDS = {
  exercise: {
    title: (s, e) => e?.name ?? `Exercise ${s.exercise_id}`,
    line: (s, e) =>
      joined([s.reps || s.seconds ? amount(s) : "", details(s, e)]),
    describe: (s, e) =>
      joined([
        `${e?.name ?? `exercise ${s.exercise_id}`} ${amount(s)}`,
        details(s, e),
      ]),
    sets: 1,
    seconds: (s, e) =>
      (eachSide(s, e) ? 2 : 1) * (s.seconds || (s.reps || 0) * SECONDS_PER_REP),
    problem: (s, e) => {
      if (!e) return `unknown exercise ${s.exercise_id}`;
      if (s.reps === 0 || s.seconds === 0) return `${e.name} needs more than 0`;
      return stepError(e, s);
    },
  },
  rest: {
    title: () => "Rest",
    line: (s) => clock(s.seconds || 0),
    describe: (s) => s.label ?? `Rest ${clock(s.seconds)}`,
    sets: 0,
    seconds: (s) => s.seconds || 0,
    problem: (s) => (s.seconds >= 1 ? null : "set how long"),
  },
  // Closed, a note reads one line: its name, else its text's first line.
  note: {
    title: (s) =>
      s.name ??
      (s.text ?? "")
        .split("\n")
        .map((l) => l.trim())
        .find(Boolean) ??
      "Note",
    line: () => "",
    describe: (s) => s.name ?? s.text,
    sets: 0,
    seconds: () => 0,
    problem: (s) => (s.name || s.text?.trim() ? null : "write the note"),
  },
  repeat: {
    title: (s) => s.name ?? "Repeat",
    line: (s) => repeatText(s),
    describe: (s) => joined([s.name, repeatText(s)]),
    problem: (s) => (s.times >= 1 ? null : "set how many rounds"),
  },
};

// A step as one line; `exercises` maps id → exercise. A run's EMOM pad
// (`unroll`) is its own.
export function describe(step, exercises) {
  if (step.kind === "pad") return "Next round";
  return STEP_KINDS[step.kind].describe(step, exercises?.get(step.exercise_id));
}

// Seconds to switch sides between the two halves of a hold done on each
// side.
export const SWITCH_SECONDS = 15;

// The steps in the order they're done, repeats unrolled. Each carries
// `round`: the repeats it's in and which round, "main · round 1 of 2". A
// timed one-sided step done on each side becomes left, a rest to switch
// sides (a rest: no work, no records), then right. A round of an
// EMOM repeat ends in a pad `{kind: "pad", every, steps}`: wait out the
// `every` seconds counted from the round's first step, `steps` back. Notes
// are no step: each rides on the step after it (`notes`, [{name, text}],
// read above it), the last ones on the last step (`notesAfter`).
export function unroll(steps, exercises = new Map()) {
  const run = [];
  let notes = [];
  for (const s of inOrder(steps, exercises)) {
    if (s.kind === "note") notes.push({ name: s.name, text: s.text });
    else {
      run.push(notes.length > 0 ? { ...s, notes } : s);
      notes = [];
    }
  }
  if (notes.length > 0 && run.length > 0)
    run.push({ ...run.pop(), notesAfter: notes });
  return run;
}

// unroll's steps with the notes where they stand.
function inOrder(steps, exercises, within = []) {
  return steps.flatMap((s) => {
    if (s.kind === "note") return [s];
    if (s.kind === "repeat")
      return Array.from({ length: s.times }, (_, i) => {
        const where = [
          ...within,
          `${s.name ? `${s.name} · ` : ""}round ${i + 1} of ${s.times}`,
        ];
        const round = inOrder(s.steps, exercises, where);
        if (!s.every) return round;
        const pad = {
          kind: "pad",
          every: s.every,
          steps: round.filter((x) => x.kind !== "note").length,
          round: where.join(" · "),
        };
        return [...round, pad];
      }).flat();
    const round = within.join(" · ");
    const e = exercises.get(s.exercise_id);
    if (s.kind === "exercise" && s.seconds && !s.side && e && unilateral(e))
      return [
        { ...s, side: "left", round },
        { kind: "rest", seconds: SWITCH_SECONDS, label: "Switch sides", round },
        { ...s, side: "right", round },
      ];
    return [{ ...s, round }];
  });
}

// The exercises a workout's steps use, each once.
export function exerciseIds(steps) {
  const ids = new Set();
  const walk = (list) => {
    for (const s of list)
      if (s.kind === "repeat") walk(s.steps);
      else if (s.kind === "exercise") ids.add(s.exercise_id);
  };
  walk(steps);
  return ids;
}

// The steps a run walks, as one short text: a resumed run carries it, so
// progress saved for other steps (the workout was edited meanwhile) is
// never applied to these.
export function fingerprint(run) {
  // 32-bit wrapping arithmetic: the Int32Array slot truncates each step,
  // read back unsigned for the text.
  const hash = new Int32Array(1);
  for (const c of JSON.stringify(
    run.map(({ kind, exercise_id, reps, seconds, kg, side }) => [
      kind,
      exercise_id,
      reps,
      seconds,
      kg,
      side,
    ]),
  ))
    hash[0] = Math.imul(hash[0], 31) + c.codePointAt(0);
  return `${run.length}:${new Uint32Array(hash.buffer)[0].toString(36)}`;
}

// How many sets and about how long. Counted without unrolling; a field
// being edited (empty) counts as 0.
export function estimate(steps, exercises) {
  const walk = (list) =>
    list.reduce(
      (t, s) => {
        if (s.kind === "repeat") {
          const inner = walk(s.steps);
          const times = s.times || 0;
          // An EMOM round takes `every`, unless its work takes longer.
          const round = Math.max(inner.seconds, s.every || 0);
          return {
            sets: t.sets + times * inner.sets,
            seconds: t.seconds + times * round,
          };
        }
        const kind = STEP_KINDS[s.kind];
        return {
          sets: t.sets + kind.sets,
          seconds: t.seconds + kind.seconds(s, exercises.get(s.exercise_id)),
        };
      },
      { sets: 0, seconds: 0 },
    );
  const { sets, seconds } = walk(steps);
  return { sets, minutes: Math.max(1, Math.round(seconds / 60)) };
}

// A workout's (or activity's) time and energy: as set on it, else
// estimated (`estimated` says which). Energy needs the person's weight
// (`kg`) unless it was set; `null` without.
export function effort(w, exercises, kg = null) {
  const est = w.steps ? estimate(w.steps, exercises) : null;
  const minutes = w.minutes ?? est?.minutes ?? null;
  const kcal =
    w.kcal ??
    (minutes
      ? kcalFor(minutes, kg, metOf(w.type ?? "workout"), runMetres(w))
      : null);
  return {
    sets: est?.sets ?? w.sets?.length ?? 0,
    minutes,
    kcal,
    minutesEstimated: isNil(w.minutes),
    kcalEstimated: isNil(w.kcal),
  };
}

// "6 sets · ≈ 24 min · active ≈ 210 kcal": estimates say ≈, values set
// on the workout don't. Its energy reads as its activities' will
// (energy-text.mjs activeEnergyText): an estimate from the time and `kg`,
// or the total set on it netted of resting (`bmr` kcal a day, today's).
// Each part whole: a line wraps between parts only.
export function workoutLine(w, lib, { kg = null, bmr = null } = {}) {
  const e = effort(w, lib.byId, kg);
  const energy =
    e.minutes &&
    activeEnergy(
      {
        kcal: w.kcal ?? null,
        minutes: e.minutes,
        type: w.type ?? "workout",
        distance_m: w.distance_m,
        weight_kg: kg,
      },
      bmr,
    );
  return [
    whole(plural(e.sets, "set")),
    whole(`${e.minutesEstimated ? "≈ " : ""}${clock(e.minutes * 60)}`),
    energy && activeEnergyText(energy),
  ]
    .filter(Boolean)
    .join(" · ");
}

// "Diamond" for "Diamond push-up" under "Push-up": a variant's name without
// its root's.
export function variantLabel(v, root) {
  const short = v.name
    .replace(
      new RegExp(root.name.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "iu"),
      "",
    )
    .replaceAll(/\s+/gu, " ")
    .trim();
  return short && short !== v.name ? capitalized(short) : v.name;
}

// -------------------------------------------------------------- search

// How an exercise is measured, as its rows name it.
export const MEASURE_LABEL = { reps: "Reps", time: "Timed" };

// Everything an exercise is, as lowercase text to search.
export const exerciseText = (e) =>
  [
    e.name,
    e.measure === "time" ? "timed" : "reps",
    ...(e.equipment ?? []),
    e.pattern,
    e.region,
    e.group,
    ...(e.primary ?? []),
    ...(e.secondary ?? []),
    e.mechanics,
    e.laterality,
    e.difficulty,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

// Gym shorthand a search word stands for, besides itself.
const ALIASES = new Map([
  ["sl", "single leg"],
  ["db", "dumbbell"],
  ["kb", "kettlebell"],
  ["bb", "barbell"],
  ["bw", "bodyweight"],
  ["rdl", "romanian deadlift"],
  ["ohp", "overhead press"],
  ["jog", "running"],
]);

// Without spaces and hyphens: "pull-apart", "pull apart", "pullapart" alike.
const squash = (s) => s.replaceAll(/[\s-]+/gu, "");

// Whether every word of `query` (or what its shorthand stands for) appears
// somewhere in lowercase `text`, spaces and hyphens aside.
export const matches = (text, query) => {
  const flat = squash(text);
  const has = (w) => text.includes(w) || flat.includes(squash(w));
  return query
    .toLowerCase()
    .split(/\s+/u)
    .filter(Boolean)
    .every(
      (w) =>
        has(w) ||
        (ALIASES.get(w)
          ?.split(" ")
          .every((x) => has(x)) ??
          false),
    );
};

// The exercise library: lookups, variants under their root move, and search
// that finds a root by any of its variants.
export function library(exercises) {
  const byId = new Map(exercises.map((e) => [e.id, e]));
  const variants = new Map();
  for (const e of exercises)
    if (e.variant_of)
      variants.set(e.variant_of, [...(variants.get(e.variant_of) ?? []), e]);
  const roots = exercises.filter((e) => !e.variant_of);
  const text = new Map(exercises.map((e) => [e.id, exerciseText(e)]));
  const rootOf = (e) => (e.variant_of ? (byId.get(e.variant_of) ?? e) : e);
  // Roots matching `q` themselves or through a variant ({root, hit}).
  const search = (q, keep = () => true) =>
    roots.flatMap((root) => {
      const family = [root, ...(variants.get(root.id) ?? [])].filter((x) =>
        keep(x),
      );
      const hit = family.find((e) => matches(text.get(e.id), q));
      return hit ? [{ root, hit }] : [];
    });
  return { byId, variants, roots, rootOf, search };
}

// Exercise for a muscle goal: 10–20 hard sets per muscle group a week
// (Schoenfeld, Ogborn & Krieger, J Sports Sci 2017: gains rise with weekly
// sets, 10 or more beating fewer; past about 20 little is added).
export const SETS_PER_WEEK = [10, 20];
export const SETS_WEEKS = 4;

// Sets a week per muscle group over `activities` (the last SETS_WEEKS
// weeks'), each logged set counted once for each group its exercise's
// primary muscles (`exercises` by id) work, by each muscle's group in
// `traits` (meta `exercise_traits`: the primary muscles' `groups`):
// [[group, sets a week]] in the server's order, every group (0 when
// untrained).
export function setsPerGroup(activities, exercises, traits) {
  const group = new Map(traits.find((t) => t.key === "primary")?.groups);
  const byId = new Map(exercises.map((e) => [e.id, e]));
  const sets = new Map([...group.values()].map((g) => [g, 0]));
  for (const s of activities)
    for (const set of s.sets ?? []) {
      const primary = byId.get(set.exercise_id)?.primary ?? [];
      for (const g of new Set(primary.map((m) => group.get(m))))
        if (g) sets.set(g, sets.get(g) + 1);
    }
  return [...sets].map(([g, n]) => [g, n / SETS_WEEKS]);
}

// A set's weight, reps or seconds, for comparing sets.
const of = (set, key) => set[key] ?? 0;

// The better of two sets: heavier, then more reps or longer.
const better = (a, b) =>
  of(b, "kg") > of(a, "kg") ||
  (of(b, "kg") === of(a, "kg") &&
    of(b, "reps") + of(b, "seconds") > of(a, "reps") + of(a, "seconds"))
    ? b
    : a;

// Your bests at an exercise over `activities` (oldest first, as listed), each
// a set you actually did, with its day: the most reps (`reps`), the longest
// (`seconds`), the heaviest (`kg`); and each activity's best set, newest
// first. Later activities win ties: a record is when you last reached it.
export function records(activities, exerciseId) {
  const best = { reps: null, seconds: null, kg: null };
  const history = [];
  for (const s of activities) {
    const sets = s.sets.filter((set) => set.exercise_id === exerciseId);
    if (sets.length === 0) continue;
    history.push({
      day: s.day,
      activity: s.id,
      set: sets.reduce((a, b) => better(a, b)),
    });
    for (const set of sets)
      for (const key of ["reps", "seconds", "kg"])
        if (
          of(set, key) > 0 &&
          (!best[key] || of(set, key) >= of(best[key].set, key))
        )
          best[key] = { set, day: s.day };
  }
  return { ...best, history: history.toReversed() };
}

// A set done, without its exercise: "8 reps · 20 kg", "45 s · left". One
// notation wherever a done set shows (Records, an exercise's history, the
// run's last time).
export const setText = (set) =>
  [
    set.seconds ? clock(set.seconds) : plural(set.reps, "rep"),
    set.side,
    set.kg ? loadText(set.kg) : null,
  ]
    .filter(Boolean)
    .join(" · ");

// A set as one line: "Pull-up · 8 reps · left · 20 kg".
export const describeSet = (set) => `${set.name} · ${setText(set)}`;

// --------------------------------------------------------- progression

const RANK = { beginner: 0, intermediate: 1, advanced: 2 };

// The next harder variants of `exercise` in its family (the root and its
// variants): the lowest difficulty above its own, done the same way, with
// no equipment it doesn't already use (bodyweight aside). At most 3, by
// name; none when its difficulty isn't known.
// ponytail: difficulty has three levels with many ties, so this offers a
// choice; a per-exercise progression rank if one pick is ever wanted.
export function harder(exercise, exercises) {
  const rank = RANK[exercise.difficulty];
  if (rank === undefined) return [];
  const root = exercise.variant_of ?? exercise.id;
  const has = new Set(["bodyweight", ...(exercise.equipment ?? [])]);
  const family = exercises.filter(
    (e) =>
      (e.id === root || e.variant_of === root) &&
      RANK[e.difficulty] > rank &&
      e.measure === exercise.measure &&
      (e.equipment ?? []).every((x) => has.has(x)),
  );
  const next = Math.min(...family.map((e) => RANK[e.difficulty]));
  return family
    .filter((e) => RANK[e.difficulty] === next)
    .toSorted((a, b) => a.name.localeCompare(b.name))
    .slice(0, 3);
}

// The sets of `exerciseId` in the newest of `activities` (oldest first, as
// listed) that did it, with its day; null if none did.
export function lastTime(activities, exerciseId) {
  const last = records(activities, exerciseId).history[0];
  if (!last) return null;
  const activity = activities.find((s) => s.id === last.activity);
  return {
    day: last.day,
    sets: activity.sets.filter((set) => set.exercise_id === exerciseId),
  };
}

// "8, 8, 7 reps · 20 kg" (setText's words): a last time's sets, with the
// heaviest weight.
export function lastTimeText({ sets }) {
  const kg = Math.max(0, ...sets.map((set) => set.kg ?? 0));
  const timed = sets.some((set) => set.seconds);
  const done = timed
    ? sets.map((set) => clock(set.seconds || 0)).join(", ")
    : `${sets.map((set) => fmt(set.reps)).join(", ")} ${sets.length === 1 && sets[0].reps === 1 ? "rep" : "reps"}`;
  return [done, kg ? loadText(kg) : null].filter(Boolean).join(" · ");
}

// `steps` with every step of exercise `fromId` done as `to` instead, made
// to fit it (`fit`); new steps, the old ones untouched.
export function swapExercise(steps, fromId, to) {
  const swap = (list) =>
    list.map((s) => {
      if (s.kind === "repeat") return { ...s, steps: swap(s.steps) };
      if (s.kind !== "exercise" || s.exercise_id !== fromId) return s;
      return fit(to, s).step;
    });
  return swap(steps);
}

// The sets of `activity` that beat a best of `before` (the activities done
// before it): more reps, longer or heavier than ever. One per exercise (its
// best such set); an exercise never done before has nothing to beat.
export function newRecords(before, activity) {
  const out = [];
  for (const id of new Set(activity.sets.map((set) => set.exercise_id))) {
    const old = records(before, id);
    const now = records([...before, activity], id);
    const beat = ["reps", "seconds", "kg"].filter(
      (key) => old[key] && of(now[key].set, key) > of(old[key].set, key),
    );
    if (beat.length > 0)
      out.push(beat.map((key) => now[key].set).reduce((a, b) => better(a, b)));
  }
  return out;
}

// The indices of the sets of `activity` that were records when done, from
// `activities` (oldest first, including it and any others).
export function recordSets(activities, activity) {
  const before = activities.filter(
    (s) =>
      s.day < activity.day || (s.day === activity.day && s.id < activity.id),
  );
  return new Set(
    newRecords(before, activity).map((set) => activity.sets.indexOf(set)),
  );
}
