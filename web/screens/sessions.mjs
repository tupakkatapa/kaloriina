// Workouts done: the session form (a run's result, a workout logged by
// hand, or any other activity), the list of everything done, and the line
// that sums one up (the diary's Log rows use it too).

import { api, createId, get, meta, scoped, stored, weightKg } from "../api.mjs";
import { clockAt, pretty, today } from "../dates.mjs";
import { href, safeBack } from "../nav.mjs";
import { NBSP, isNil, kcal, plural } from "../nutrients.mjs";
import {
  editor,
  field,
  fill,
  h,
  num,
  numberOrNull,
  picker,
  titleBar,
} from "../ui.mjs";
import {
  clock,
  distanceText,
  effort,
  fit,
  pace,
  recordSets,
  unroll,
} from "../workouts.mjs";
import { exerciseRow, library } from "./workouts.mjs";

// The weight a session's energy is estimated with: the weigh-in in effect
// on its day, as the server gives it, so history never rewrites itself; a
// session not yet sent from here has none, so the latest stands in. Null
// without any weigh-in: no estimate.
const weightOf = (s) => ("weight_kg" in s ? s.weight_kg : weightKg());

// "46 min · 8.2 km · 5:37 /km · 410 kcal · Health Connect": the time, a
// whole session's distance and pace, the energy ("≈" when estimated from
// the time and your weight), and where a watch workout came from.
export function sessionLine(s) {
  const e = effort(s, new Map(), weightOf(s));
  return [
    clock(s.minutes * 60),
    distanceText(s.distance_m),
    pace(s.type, s.distance_m, s.minutes),
    e.kcal === null
      ? null
      : `${e.kcalEstimated ? `≈${NBSP}` : ""}${kcal(e.kcal)}`,
    s.source_key ? "Health Connect" : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

// A workout done as a list row: its name, then its day and `sessionLine`;
// it opens with a way `back` to the list.
export function sessionRow(s, back) {
  return h(
    "li",
    {},
    h(
      "a",
      { class: "result", href: href.session(s.id, { back }) },
      h("span", { class: "name" }, s.name),
      h("span", { class: "muted" }, `${pretty(s.day)} · ${sessionLine(s)}`),
    ),
  );
}

// Whether a session type takes a distance: the server's rule.
const takesDistance = (type) =>
  meta.session_types.some((t) => t.key === type && t.distance);

// The sets a workout plans, as a session records them.
const plannedSets = (steps, byId) =>
  unroll(steps, byId)
    .filter((s) => s.kind === "exercise")
    .map(({ exercise_id, reps, seconds, kg: weight, side }) => ({
      exercise_id,
      name: byId.get(exercise_id)?.name ?? `Exercise ${exercise_id}`,
      ...(reps ? { reps } : {}),
      ...(seconds ? { seconds } : {}),
      ...(weight ? { kg: weight } : {}),
      ...(side ? { side } : {}),
    }));

// Sets as an editable list: each set's reps or seconds and its weight, a ✕
// to drop it, and a search to add more.
function setsEditor(initial, lib, onChange, records = new Set()) {
  let sets = structuredClone(initial);
  // The sets that were records (by index in `initial`), as they move.
  const recordSet = new Set([...records].map((i) => sets[i]));
  const list = h("ol", { class: "sets" });
  const paint = () => {
    fill(
      list,
      ...sets.map((set, i) => {
        const amount = num({
          name: `set-${i}-amount`,
          value: set.reps ?? set.seconds ?? "",
          step: 1,
          min: 0,
          max:
            set.seconds === undefined
              ? meta.limits.reps
              : meta.limits.step_seconds,
          required: true,
          "aria-label": `${set.name} ${set.seconds === undefined ? "reps" : "seconds"}`,
          oninput: (e) => {
            const v = Number(e.target.value);
            if (set.seconds === undefined) set.reps = v;
            else set.seconds = v;
            onChange();
          },
        });
        const weight = num({
          name: `set-${i}-kg`,
          value: set.kg ?? "",
          step: "any",
          min: 0,
          max: meta.limits.kg,
          "aria-label": `${set.name} weight (kg)`,
          oninput: (e) => {
            if (e.target.value === "") delete set.kg;
            else set.kg = Number(e.target.value);
            onChange();
          },
        });
        return h(
          "li",
          { class: "row set" },
          h(
            "span",
            { class: "name" },
            set.side ? `${set.name} · ${set.side}` : set.name,
            recordSet.has(set) ? h("span", { class: "badge" }, "Record") : null,
          ),
          amount,
          h("span", {}, set.seconds === undefined ? "reps" : "s"),
          weight,
          h("span", {}, "kg"),
          h(
            "button",
            {
              type: "button",
              class: "danger icon",
              "aria-label": `Remove set ${i + 1}, ${set.name}`,
              onclick: () => {
                sets.splice(i, 1);
                paint();
                onChange();
              },
            },
            "✕",
          ),
        );
      }),
    );
  };
  paint();
  const add = picker({
    placeholder: "Add an exercise",
    search: (q) => lib.search(q),
    row: (m, pick) => exerciseRow(m, pick, lib),
    onPick: ({ root, hit }) => {
      const e = hit ?? root;
      const { step } = fit(e);
      sets.push({
        exercise_id: e.id,
        name: e.name,
        ...(step.reps === undefined
          ? { seconds: step.seconds }
          : { reps: step.reps }),
      });
      paint();
      onChange();
    },
  });
  const node = h(
    "fieldset",
    { class: "sets-editor" },
    h("legend", {}, "Sets"),
    list,
    add,
  );
  return {
    node,
    value: () => sets,
    set: (next) => {
      sets = structuredClone(next);
      paint();
    },
  };
}

// "Something else": a session without a saved workout (a run, a ride).
const OTHER = "other";

// A workout done: its name, day, time and energy (empty energy: estimated
// from the duration and your weight), and its sets. A new one (?day=) starts
// from a saved workout's plan, or from nothing for any other activity.
export async function sessionEditor(id, params) {
  const isNew = id === "new";
  const [session, workouts, exercises] = await Promise.all([
    isNew ? null : get(scoped(`/sessions/${id}`)),
    get("/workouts"),
    get("/exercises"),
  ]);
  // The sets that beat an earlier best when done.
  const records = session
    ? recordSets(await get(scoped(`/sessions?to=${session.day}`)), session)
    : new Set();
  const lib = library(exercises);
  const s = session ?? {
    day: params.get("day") ?? today(),
    name: "",
    minutes: null,
    kcal: null,
    sets: [],
    workout_id: null,
  };
  const name = h("input", {
    name: "name",
    value: s.name,
    required: true,
    maxLength: meta.limits.name,
  });
  const day = h("input", {
    type: "date",
    name: "day",
    required: true,
    value: s.day,
  });
  const minutes = num({
    name: "minutes",
    value: s.minutes ?? "",
    step: 1,
    min: 1,
    max: meta.limits.session_minutes,
    required: true,
  });
  const energy = num({
    name: "kcal",
    value: s.kcal ?? "",
    step: 1,
    min: 0,
    max: meta.limits.kcal,
  });
  const kg = weightOf(s);
  // Empty energy shows what it will be estimated as.
  const estimate = () => {
    const e = effort({ minutes: numberOrNull(minutes) }, lib.byId, kg);
    energy.placeholder = e.kcal === null ? "" : `≈ ${e.kcal}`;
  };
  // A whole session (a run, a ride): its type, distance and start. The
  // watch's own sessions keep what the watch measured.
  const watch = s.source === "health_connect";
  const type = h(
    "select",
    { name: "type", onchange: () => shown() },
    h("option", { value: "" }, "Workout (sets)"),
    meta.session_types.map((t) =>
      h("option", { value: t.key, selected: t.key === s.type }, t.label),
    ),
  );
  const distance = num({
    name: "distance",
    value: isNil(s.distance_m) ? "" : s.distance_m / 1000,
    // Whole metres, as stored: a watch distance (8.234 km) fits the grid.
    step: "0.001",
    min: 0,
    max: meta.limits.distance_m / 1000,
  });
  const start = h("input", {
    type: "time",
    name: "start",
    value: s.start_at ? clockAt(s.start_at) : "",
  });
  const typeField = field("Type", type);
  const distanceField = field("Distance (km)", distance);
  // Type shows for "Something else" and any typed session; distance for
  // the types that have one.
  let other = Boolean(s.type);
  const shown = () => {
    typeField.hidden = !other;
    distanceField.hidden = !other || !takesDistance(type.value);
  };
  shown();
  if (watch)
    for (const input of [day, minutes, energy, type, distance, start])
      input.disabled = true;
  minutes.addEventListener("input", estimate);
  estimate();
  const sets = setsEditor(s.sets, lib, () => {}, records);
  let workoutId = s.workout_id;
  const from = isNew
    ? h(
        "select",
        {
          name: "workout",
          required: true,
          onchange: (e) => {
            const w = workouts.find((x) => String(x.id) === e.target.value);
            workoutId = w?.id ?? null;
            other = e.target.value === OTHER;
            if (!other) type.value = "";
            shown();
            if (!w) {
              name.value = "";
              sets.set([]);
              return;
            }
            name.value = w.name;
            const est = effort(w, lib.byId, kg);
            minutes.value = est.minutes;
            energy.value = w.kcal ?? "";
            estimate();
            sets.set(plannedSets(w.steps, lib.byId));
          },
        },
        h("option", { value: "" }, "Choose…"),
        workouts.map((w) => h("option", { value: w.id }, w.name)),
        h("option", { value: OTHER }, "Something else (a run, a ride…)"),
      )
    : null;
  const key = createId();
  // Opened from a list of workouts done (`?back=`), it returns there.
  const origin = safeBack(params.get("back"));
  const back = origin ?? href.day(s.day);
  const { node } = editor({
    title: isNew ? "Log a workout" : s.name,
    back,
    body: [
      from ? field("Workout", from) : null,
      watch
        ? h(
            "p",
            { class: "muted watch-hint" },
            "From your watch (Health Connect)",
          )
        : null,
      field("Name", name),
      field("Day", day),
      typeField,
      h(
        "div",
        { class: "pair" },
        field("Duration (min)", minutes),
        field("Energy (kcal)", energy, {
          hint:
            kg === null
              ? "Log a weight to estimate energy."
              : "Empty: estimated from the duration and your weight.",
        }),
      ),
      h("div", { class: "pair" }, distanceField, field("Start time", start)),
      sets.node,
    ],
    state: () => sets.value(),
    save: async () => {
      const kind = other ? type.value || null : null;
      const body = {
        day: day.value,
        workout_id: workoutId,
        name: name.value,
        minutes: Number(minutes.value),
        kcal: numberOrNull(energy),
        sets: sets.value(),
        type: kind,
        distance_m:
          takesDistance(kind) && distance.value !== ""
            ? Math.round(Number(distance.value) * 1000)
            : null,
        // The day and time as this device reads them, sent in UTC.
        start_at: start.value
          ? new Date(`${day.value}T${start.value}`).toISOString()
          : null,
        // What the watch measured goes back as it came.
        ...(watch
          ? {
              day: s.day,
              minutes: s.minutes,
              kcal: s.kcal,
              type: s.type,
              distance_m: s.distance_m,
              start_at: s.start_at,
            }
          : {}),
      };
      if (!isNew)
        return api("PUT", scoped(`/sessions/${id}`), { ...body, rev: s.rev });
      let saved;
      const done = await stored(async () => {
        saved = await api(
          "POST",
          scoped("/sessions"),
          { ...body, uid: key.get() },
          { queue: true, label: body.name },
        );
      });
      if (done !== true) return { ...body, queued: done.queued.message };
      key.done();
      return saved;
    },
    after: (saved) => origin ?? href.day(saved.day),
    saved: (x) => x.queued ?? `Saved ${x.name}`,
    remove: isNew
      ? null
      : {
          ask: `Delete ${s.name} on ${pretty(s.day)}?${s.source_key ? " It won't come back on the next sync." : ""}`,
          run: () => api("DELETE", scoped(`/sessions/${id}`)),
          after: back,
          done: `Deleted ${s.name}`,
        },
  });
  return node;
}

// Everything done, newest first, by month.
export async function sessionList() {
  const sessions = (await get(scoped("/sessions"))).toReversed();
  const months = new Map();
  for (const s of sessions) {
    const month = new Date(`${s.day}T12:00`).toLocaleDateString(undefined, {
      month: "long",
      year: "numeric",
    });
    months.set(month, [...(months.get(month) ?? []), s]);
  }
  return h(
    "section",
    {},
    titleBar("Workouts done", href.workouts()),
    sessions.length
      ? [...months].map(([month, list]) =>
          h(
            "section",
            { class: "finder-section" },
            h("h2", {}, `${month} · ${plural(list.length, "workout")}`),
            h(
              "ul",
              { class: "results card" },
              list.map((x) => sessionRow(x, href.sessions())),
            ),
          ),
        )
      : h(
          "p",
          { class: "muted" },
          "Nothing yet: finish a workout, or log one in the diary.",
        ),
  );
}
