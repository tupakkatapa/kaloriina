// Workouts without the DOM: the step tree and its edits, the rules that fit a
// step to its exercise, estimates, search, and the order the run screen walks.
// `node --test` covers all of it.
//
// A step is `{kind: "exercise", exercise_id, reps | seconds, kg?, side?}`,
// `{kind: "rest", seconds}` or `{kind: "repeat", times, every?, name?,
// steps}`; with `every` (EMOM) each round takes that many seconds. A
// path is the list of indices down to a step: [1, 0] is the first step of
// the repeat that is the second step. A list path is the path of the repeat
// holding a list ([] for the workout itself).

import { shift, weekStart } from "./dates.mjs";
import { NBSP, fmt, isNil, plural } from "./nutrients.mjs";

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
  } else if (target.length === parent.length && startsWith(target, parent)) {
    if (i > from.at(-1)) i -= 1;
  }
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

// ------------------------------------------------------- step rules

const unilateral = (e) => e.laterality === "unilateral";

// What's wrong with a step for its exercise, or null. The server applies the
// same rules (`step_fits` in src/model/workout.rs); tests/step-rules.json
// holds the cases both must agree on.
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

// ------------------------------------------------------------ reading

// A duration in a list or summary: "45 s", "1 min", "1 min 30 s".
export function clock(seconds) {
  if (seconds < 60) return `${seconds}${NBSP}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}${NBSP}min${s ? ` ${s}${NBSP}s` : ""}`;
}

// A countdown, only while running: "0:45", "1:30".
export const countdown = (seconds) =>
  `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

// "20 kg", "12.5 kg".
export const weightText = (weight) => `${weight}${NBSP}kg`;

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

// What a step adds to its exercise: "left · 20 kg", or "each side" for a
// one-sided exercise done on both.
export function details(step, exercise) {
  const side =
    step.side ?? (exercise && unilateral(exercise) ? "each side" : null);
  return [side, step.kg ? weightText(step.kg) : null]
    .filter(Boolean)
    .join(" · ");
}

// A step as one line; `exercises` maps id → exercise.
export function describe(step, exercises) {
  if (step.kind === "rest") return `Rest ${clock(step.seconds)}`;
  if (step.kind === "pad") return "Next round";
  if (step.kind === "repeat")
    return [step.name, repeatText(step)].filter(Boolean).join(" · ");
  const e = exercises.get(step.exercise_id);
  const name = e?.name ?? `exercise ${step.exercise_id}`;
  return [`${name} ${amount(step)}`, details(step, e)]
    .filter(Boolean)
    .join(" · ");
}

// The steps in the order they're done, repeats unrolled. Each carries
// `round`: the repeats it's in and which round, "main · round 1 of 2". A
// timed one-sided step done on each side becomes left, then right. A round of an
// EMOM repeat ends in a pad `{kind: "pad", every, steps}`: wait out the
// `every` seconds counted from the round's first step, `steps` back.
export function unroll(steps, exercises = new Map(), within = []) {
  return steps.flatMap((s) => {
    if (s.kind === "repeat")
      return Array.from({ length: s.times }, (_, i) => {
        const where = [
          ...within,
          `${s.name ? `${s.name} · ` : ""}round ${i + 1} of ${s.times}`,
        ];
        const round = unroll(s.steps, exercises, where);
        if (!s.every) return round;
        const pad = {
          kind: "pad",
          every: s.every,
          steps: round.length,
          round: where.join(" · "),
        };
        return [...round, pad];
      }).flat();
    const round = within.join(" · ");
    const e = exercises.get(s.exercise_id);
    if (s.kind === "exercise" && s.seconds && !s.side && e && unilateral(e))
      return ["left", "right"].map((side) => ({ ...s, side, round }));
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
  let hash = 0;
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
    hash = (Math.imul(hash, 31) + c.charCodeAt(0)) | 0;
  return `${run.length}:${(hash >>> 0).toString(36)}`;
}

// Seconds per rep, for the time estimate.
const SECONDS_PER_REP = 3;
// A moderate workout's metabolic equivalent: kcal ≈ MET × kg × hours.
// ponytail: one MET for everything; per-exercise METs if estimates need to
// be closer.
export const MET = 5;

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
        if (s.kind === "rest")
          return { ...t, seconds: t.seconds + (s.seconds || 0) };
        const e = exercises.get(s.exercise_id);
        const sides = e && unilateral(e) && !s.side ? 2 : 1;
        const work = s.seconds || (s.reps || 0) * SECONDS_PER_REP;
        return { sets: t.sets + 1, seconds: t.seconds + sides * work };
      },
      { sets: 0, seconds: 0 },
    );
  const { sets, seconds } = walk(steps);
  return { sets, minutes: Math.max(1, Math.round(seconds / 60)) };
}

// A workout's (or session's) time and energy: as set on it, else
// estimated (`estimated` says which). Energy needs the person's weight
// (`kg`) unless it was set; `null` without.
export function effort(w, exercises, kg = null) {
  const est = w.steps ? estimate(w.steps, exercises) : null;
  const minutes = w.minutes ?? est?.minutes ?? null;
  const kcal = w.kcal ?? (minutes ? kcalFor(minutes, kg) : null);
  return {
    sets: est?.sets ?? w.sets?.length ?? 0,
    minutes,
    kcal,
    minutesEstimated: isNil(w.minutes),
    kcalEstimated: isNil(w.kcal),
  };
}

// ------------------------------------------------------------ search

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
const squash = (s) => s.replace(/[\s-]+/g, "");

// Whether every word of `query` (or what its shorthand stands for) appears
// somewhere in lowercase `text`, spaces and hyphens aside.
export const matches = (text, query) => {
  const flat = squash(text);
  const has = (w) => text.includes(w) || flat.includes(squash(w));
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => has(w) || (ALIASES.get(w)?.split(" ").every(has) ?? false));
};

// ------------------------------------------------------------ sessions

// Energy for `minutes` of training by someone weighing `kg` (null without).
export const kcalFor = (minutes, kg) =>
  kg ? Math.round((MET * kg * minutes) / 60) : null;

// A set's weight, reps or seconds, for comparing sets.
const of = (set, key) => set[key] ?? 0;

// The better of two sets: heavier, then more reps or longer.
const better = (a, b) =>
  of(b, "kg") > of(a, "kg") ||
  (of(b, "kg") === of(a, "kg") &&
    of(b, "reps") + of(b, "seconds") > of(a, "reps") + of(a, "seconds"))
    ? b
    : a;

// Your bests at an exercise over `sessions` (oldest first, as listed), each
// a set you actually did, with its day: the most reps (`reps`), the longest
// (`seconds`), the heaviest (`kg`); and each session's best set, newest
// first. Later sessions win ties: a record is when you last reached it.
export function records(sessions, exerciseId) {
  const best = { reps: null, seconds: null, kg: null };
  const history = [];
  for (const s of sessions) {
    const sets = s.sets.filter((set) => set.exercise_id === exerciseId);
    if (!sets.length) continue;
    history.push({ day: s.day, session: s.id, set: sets.reduce(better) });
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

// A set as one line: "Pull-up × 8 · left · 20 kg".
export const describeSet = (set) =>
  [`${set.name} ${amount(set)}`, set.side, set.kg ? weightText(set.kg) : null]
    .filter(Boolean)
    .join(" · ");

// Where a run keeps its progress (sessionStorage), so a reload or a detour
// resumes it.
export const runKey = (workoutId) => `run:${workoutId}`;

// ------------------------------------------------------- progression

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

// The sets of `exerciseId` in the newest of `sessions` (oldest first, as
// listed) that did it, with its day; null if none did.
export function lastTime(sessions, exerciseId) {
  const last = records(sessions, exerciseId).history[0];
  if (!last) return null;
  const session = sessions.find((s) => s.id === last.session);
  return {
    day: last.day,
    sets: session.sets.filter((set) => set.exercise_id === exerciseId),
  };
}

// "× 8, × 8, × 7 · 20 kg": a last time's sets, with the heaviest weight.
export function lastTimeText({ sets }) {
  const kg = Math.max(0, ...sets.map((set) => set.kg ?? 0));
  return [sets.map(amount).join(", "), kg ? weightText(kg) : null]
    .filter(Boolean)
    .join(" · ");
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

// The sets of `session` that beat a best of `before` (the sessions done
// before it): more reps, longer or heavier than ever. One per exercise (its
// best such set); an exercise never done before has nothing to beat.
export function newRecords(before, session) {
  const out = [];
  for (const id of new Set(session.sets.map((set) => set.exercise_id))) {
    const old = records(before, id);
    const now = records([...before, session], id);
    const beat = ["reps", "seconds", "kg"].filter(
      (key) => old[key] && of(now[key].set, key) > of(old[key].set, key),
    );
    if (beat.length)
      out.push(beat.map((key) => now[key].set).reduce((a, b) => better(a, b)));
  }
  return out;
}

// The indices of the sets of `session` that were records when done, from
// `sessions` (oldest first, including it and any others).
export function recordSets(sessions, session) {
  const before = sessions.filter(
    (s) => s.day < session.day || (s.day === session.day && s.id < session.id),
  );
  return new Set(
    newRecords(before, session).map((set) => session.sets.indexOf(set)),
  );
}

// How many weeks of [from, to] met `perWeek` workouts, of how many judged:
// Monday-first weeks wholly inside the period and over before `today` (a
// week still going shows as the Summary's bar instead). `perWeek` is today's
// target applied to every past week; null without one.
export function targetWeeks(sessions, from, to, perWeek, today) {
  if (!(perWeek > 0)) return null;
  const first = weekStart(from) < from ? shift(weekStart(from), 7) : from;
  let met = 0;
  let total = 0;
  for (
    let monday = first;
    shift(monday, 6) <= to && shift(monday, 6) < today;
    monday = shift(monday, 7)
  ) {
    const sunday = shift(monday, 6);
    total += 1;
    if (
      sessions.filter((s) => s.day >= monday && s.day <= sunday).length >=
      perWeek
    )
      met += 1;
  }
  return { met, total };
}

// ------------------------------------------------- whole sessions

// Which session types take a distance is the server's rule (meta
// `session_types[].distance`); these only read one.

// "8.2 km", "5 km", "1.25 km"; null without a distance.
export const distanceText = (metres) =>
  isNil(metres) ? null : `${fmt(metres / 1000, 2)}${NBSP}km`;

// Types whose pace reads per kilometre.
const ON_FOOT = ["run", "walk", "hike"];

// "5:37 /km" on foot, "24.3 km/h" on a bike, "2:05 /100 m" swimming; null
// without a distance or a time, or for a type with no one way to read it
// ("other": rowing, skiing…).
export function pace(type, metres, minutes) {
  if (!metres || !minutes) return null;
  const seconds = minutes * 60;
  const per = (m) => countdown(Math.round((seconds * m) / metres));
  if (type === "cycling")
    return `${fmt(metres / 1000 / (minutes / 60), 1)}${NBSP}km/h`;
  if (type === "swim") return `${per(100)}${NBSP}/100${NBSP}m`;
  return ON_FOOT.includes(type) ? `${per(1000)}${NBSP}/km` : null;
}
