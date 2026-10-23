// Activities done: an activity's page, its form (a run's result, a workout
// logged by hand, or any other activity: its exercises with their sets),
// and the list of everything done (its rows are web/rows.mjs').

import { newTypeRecords } from "../activities.mjs";
import {
  activityType,
  api,
  createId,
  get,
  meta,
  scoped,
  stored,
} from "../api.mjs";
import {
  dayAt,
  monthStart,
  monthYear,
  pretty,
  shift,
  timeValue,
  today,
} from "../dates.mjs";
import { activeEnergyText } from "../energy-text.mjs";
import { activeOf } from "../expenditure.mjs";
import { isNil, plural } from "../format.mjs";
import { href, safeBack } from "../nav.mjs";
import {
  activityRow,
  energyContext,
  exerciseRow,
  loadResting,
  sourceText,
  weightOf,
} from "../rows.mjs";
import {
  busy,
  editor,
  empty,
  energyLabel,
  energyNum,
  energyOf,
  field,
  fill,
  h,
  nameInput,
  num,
  numberOrNull,
  picker,
  removeButton,
  setEnergy,
  timeField,
  titleBar,
  unitNum,
  unitValue,
} from "../ui.mjs";
import { unitOf } from "../units.mjs";
import {
  describeSet,
  effort,
  fit,
  library,
  recordSets,
  unroll,
} from "../workouts.mjs";

// Whether an activity type takes a distance: the server's rule.
const takesDistance = (type) => Boolean(activityType(type)?.distance);

// The sets a workout plans, as an activity records them.
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

// Sets as an editable list under their exercises (sets of one exercise in
// a row are its group, its name leading to its page): each set's reps or
// seconds and its weight, a ✕ to drop it, and a search to add more.
function setsEditor(initial, lib, onChange, records = new Set()) {
  let sets = structuredClone(initial);
  // The sets that were records (by index in `initial`), as they move.
  const recordSet = new Set([...records].map((i) => sets[i]));
  const list = h("ol", { class: "set-groups" });
  // Set `i`, the `n`th of its group.
  const setRow = (set, i, n) => {
    const amount = num({
      name: `set-${i}-amount`,
      value: set.reps ?? set.seconds ?? "",
      step: 1,
      min: 0,
      max:
        set.seconds === undefined ? meta.limits.reps : meta.limits.step_seconds,
      required: true,
      "aria-label": `${set.name} ${set.seconds === undefined ? "reps" : "seconds"}`,
      oninput: (e) => {
        const v = Number(e.target.value);
        if (set.seconds === undefined) set.reps = v;
        else set.seconds = v;
        onChange();
      },
    });
    const weight = unitNum({
      name: `set-${i}-kg`,
      value: set.kg,
      unit: "kg",
      max: meta.limits.kg,
      "aria-label": `${set.name} weight (${unitOf("kg")})`,
      oninput: () => {
        const kg = unitValue(weight);
        if (kg === null) delete set.kg;
        else set.kg = kg;
        onChange();
      },
    });
    return h(
      "li",
      { class: "row set" },
      h(
        "span",
        { class: "name" },
        set.side ? `Set ${n} · ${set.side}` : `Set ${n}`,
        recordSet.has(set) ? h("span", { class: "badge" }, "Record") : null,
      ),
      amount,
      h("span", {}, set.seconds === undefined ? "reps" : "s"),
      weight,
      h("span", {}, unitOf("kg")),
      removeButton(`Remove set ${i + 1}, ${set.name}`, () => {
        sets.splice(i, 1);
        paint();
        onChange();
      }),
    );
  };
  const paint = () => {
    const groups = [];
    sets.forEach((set, i) => {
      const last = groups.at(-1);
      if (last?.id === set.exercise_id && last.name === set.name)
        last.rows.push(setRow(set, i, last.rows.length + 1));
      else
        groups.push({
          id: set.exercise_id,
          name: set.name,
          rows: [setRow(set, i, 1)],
        });
    });
    fill(
      list,
      ...groups.map((g) =>
        h(
          "li",
          { class: "set-group" },
          // A deleted exercise's sets keep its name, leading nowhere.
          h(
            "h3",
            {},
            g.id ? h("a", { href: href.exercise(g.id) }, g.name) : g.name,
          ),
          h("ol", { class: "sets" }, g.rows),
        ),
      ),
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
    h("legend", {}, "Exercises"),
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

// "Saved Run · new record: longest distance, fastest pace" when a new
// activity beats a best of its type's others; for a workout (a PR
// attempt too), "Saved … · new record: Pull-up × 9" when a set beats the
// exercise's best; else null. A failed read only loses the news.
async function recordNews(saved) {
  const all = await get(scoped("/activities")).catch(() => []);
  if (saved.type === "workout") {
    const sets = [...recordSets(all, saved)].map((i) => saved.sets[i]);
    return sets.length > 0
      ? `Saved ${saved.name} · new record${sets.length > 1 ? "s" : ""}: ${sets.map((x) => describeSet(x)).join(", ")}`
      : null;
  }
  const beat = newTypeRecords(all, saved);
  return beat.length > 0
    ? `Saved ${saved.name} · new record: ${beat.map((r) => r.label).join(", ")}`
    : null;
}

// "Something else": an activity of no saved workout (a run, a ride).
const OTHER = "other";

// The activity form: name, day, duration and energy (empty: estimated from
// the duration and the weight then), its type, distance and start, and its
// exercises' sets. `s` is the activity, or what a new one starts from. A
// device's activity keeps what the device measured; with no sets it shows
// none to add (nothing on it takes any). `body()` is the activity to send,
// without its workout; `other(on)` shows the type and distance fields (an
// activity not of a saved workout).
export function activityForm(s, { lib, records = new Set(), other = false }) {
  const name = nameInput({ max: meta.limits.name, value: s.name });
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
    max: meta.limits.activity_minutes,
    required: true,
  });
  const energy = energyNum({
    name: "kcal",
    value: s.kcal,
    min: 0,
    max: meta.limits.kcal,
  });
  const kg = weightOf(s);
  // Under the energy, its active part as the activity's row will read it
  // (expenditure.mjs activeOf): a total typed less resting, or, empty, the
  // estimate from the time, type and weight (a run by its distance as
  // saved, body()).
  const active = h("span", { class: "energy-active", "aria-live": "polite" });
  const estimate = () => {
    const time = numberOrNull(minutes);
    fill(
      active,
      time
        ? activeEnergyText(
            activeOf(
              {
                ...s,
                day: day.value || s.day,
                minutes: time,
                kcal: energyOf(energy),
                kcal_source: s.kcal_source ?? "hand",
                type: type.value,
                distance_m: body().distance_m,
                weight_kg: kg,
              },
              energyContext(),
            ),
          )
        : null,
    );
  };
  const device = s.source === "health_connect";
  const type = h(
    "select",
    {
      name: "type",
      onchange: () => {
        shown();
        estimate();
      },
    },
    meta.activity_types.map((t) =>
      h("option", { value: t.key, selected: t.key === s.type }, t.label),
    ),
  );
  const distance = unitNum({
    name: "distance",
    value: isNil(s.distance_m) ? null : s.distance_m / 1000,
    unit: "km",
    // Whole metres, as stored: a device distance (8.234 km) fits the grid.
    step: "0.001",
    min: 0,
    max: meta.limits.distance_m / 1000,
  });
  const start = timeField({
    name: "start",
    value: s.start_at ? timeValue(s.start_at) : "",
  });
  const typeField = field("Type", type);
  const distanceField = field(`Distance (${unitOf("km")})`, distance);
  let whole = other;
  const shown = () => {
    typeField.hidden = !whole;
    distanceField.hidden = !whole || !takesDistance(type.value);
  };
  shown();
  if (device)
    for (const input of [day, minutes, energy, type, distance, start])
      input.disabled = true;
  for (const input of [minutes, distance, energy, day])
    input.addEventListener("input", estimate);
  const sets = setsEditor(s.sets, lib, () => {}, records);
  const fields = [
    // A hand log the device's record matched keeps what you typed,
    // taking only what it lacked (a start, the minutes).
    device || (s.source === "hand" && s.source_key)
      ? h(
          "p",
          { class: "muted device-hint" },
          device ? "From Health Connect" : `Matched with ${sourceText(s)}`,
        )
      : null,
    field("Name", name),
    field("Day", day),
    typeField,
    h(
      "div",
      { class: "pair" },
      field("Duration (min)", minutes),
      // The device's energy is shown, not typed: no hint for it. A typed
      // value is the total (resting included), as a device or a machine
      // shows it, and read as active, resting taken off; empty, it is
      // estimated (active already).
      field(device ? energyLabel() : energyLabel("total"), energy, {
        hint: device
          ? null
          : [
              kg === null
                ? "What your device or machine says, resting included. Log a weight to estimate it."
                : "What your device or machine says, resting included. Empty: estimated from time and weight.",
              active,
            ],
      }),
    ),
    h("div", { class: "pair" }, distanceField, field("Start time", start)),
    device && s.sets.length === 0 ? null : sets.node,
  ];
  const body = () => {
    const kind = type.value;
    return {
      day: day.value,
      name: name.value,
      minutes: Number(minutes.value),
      kcal: energyOf(energy),
      sets: sets.value(),
      type: kind,
      distance_m:
        takesDistance(kind) && distance.value !== ""
          ? Math.round(unitValue(distance) * 1000)
          : null,
      // The day and time as this device reads them, sent in UTC.
      start_at: start.value
        ? dayAt(day.value, start.value).toISOString()
        : null,
      // What the device measured goes back as it came.
      ...(device
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
  };
  estimate();

  return {
    fields,
    body,
    name,
    minutes,
    energy,
    type,
    sets,
    kg,
    estimate,
    other: (on) => {
      whole = on;
      shown();
    },
  };
}

// An activity: its name, day, time and energy (empty energy: estimated
// from the duration and your weight), and its exercises' sets. A new one
// (?day=) starts from a saved workout's plan (`?workout=`, a planned one's
// tick), from nothing of a type picked on Activity (`?type=`: "Empty
// workout" is `workout`), or from one set of an exercise (`?exercise=`: a
// record attempt outside a workout).
export async function activityEditor(id, params) {
  const isNew = id === "new";
  const [activity, workouts, exercises] = await Promise.all([
    isNew ? null : get(scoped(`/activities/${id}`)),
    get("/workouts"),
    get("/exercises"),
    loadResting(),
  ]);
  // The sets that beat an earlier best when done.
  const records = activity
    ? recordSets(await get(scoped(`/activities?to=${activity.day}`)), activity)
    : new Set();
  const lib = library(exercises);
  // A record attempt: a workout of one set (a side each when one-sided).
  const tried = isNew ? lib.byId.get(Number(params.get("exercise"))) : null;
  const sides =
    tried?.laterality === "unilateral" ? ["left", "right"] : [undefined];
  const attempt = tried ? sides.map((side) => fit(tried, { side }).step) : [];
  // The type picked on Activity: picked once, not asked again.
  const picked = isNew && !tried ? activityType(params.get("type")) : null;
  const s = activity ?? {
    day: params.get("day") ?? today(),
    name: tried ? `${tried.name} attempt` : (picked?.label ?? ""),
    minutes: tried ? effort({ steps: attempt }, lib.byId).minutes : null,
    kcal: null,
    sets: plannedSets(attempt, lib.byId),
    workout_id: null,
    type: picked?.key ?? "workout",
  };
  // Type shows for a type picked, "Something else" and any activity saved
  // before (a workout from a saved one is a workout); distance for the
  // types that have one.
  const form = activityForm(s, {
    lib,
    records,
    other: !isNew || Boolean(picked),
  });
  const { name, minutes, energy, type, sets, estimate } = form;
  let workoutId = s.workout_id;
  const from =
    isNew && !tried && !picked
      ? h(
          "select",
          {
            name: "workout",
            required: true,
            onchange: (e) => {
              const w = workouts.find((x) => String(x.id) === e.target.value);
              workoutId = w?.id ?? null;
              const other = e.target.value === OTHER;
              if (!other) type.value = "workout";
              form.other(other);
              if (!w) {
                name.value = "";
                sets.set([]);
                return;
              }
              name.value = w.name;
              const est = effort(w, lib.byId, form.kg);
              minutes.value = est.minutes;
              setEnergy(energy, w.kcal);
              estimate();
              sets.set(plannedSets(w.steps, lib.byId));
            },
          },
          h("option", { value: "" }, "Choose…"),
          workouts
            .filter((w) => !w.archived)
            .map((w) => h("option", { value: w.id }, w.name)),
          h("option", { value: OTHER }, "Something else (a run, a ride…)"),
        )
      : null;
  // From a planned workout's tick (`?workout=`): that workout, filled in.
  if (from && workouts.some((w) => String(w.id) === params.get("workout"))) {
    from.value = params.get("workout");
    from.dispatchEvent(new Event("change"));
  }
  const key = createId();
  // Opened from a list of workouts done (`?back=`), it returns there.
  const origin = safeBack(params.get("back"));
  const back = origin ?? href.day(s.day);
  // Deleted, it leaves where it was opened, unless that was its own view:
  // then where the view's Back led.
  const [path, query] = (origin ?? "").split("?");
  const gone =
    !isNew && path === href.activityView(id)
      ? (safeBack(new URLSearchParams(query).get("back")) ?? href.day(s.day))
      : back;
  const { node } = editor({
    title: tried ? "Log a set" : isNew ? "Log an activity" : s.name,
    back,
    body: [from ? field("Workout", from) : null, ...form.fields],
    state: () => sets.value(),
    save: async () => {
      const body = { ...form.body(), workout_id: workoutId };
      if (!isNew)
        return api("PUT", scoped(`/activities/${id}`), { ...body, rev: s.rev });
      let saved;
      const done = await stored(async () => {
        saved = await api(
          "POST",
          scoped("/activities"),
          { ...body, uid: key.get() },
          { queue: true, label: body.name },
        );
      });
      if (done !== true) return { ...body, queued: done.queued.message };
      key.done();
      return { ...saved, record: await recordNews(saved) };
    },
    after: (saved) => origin ?? href.day(saved.day),
    saved: (x) => x.queued ?? x.record ?? `Saved ${x.name}`,
    remove: isNew
      ? null
      : {
          ask: `Delete ${s.name} on ${pretty(s.day)}?${s.source_key ? " It won't come back on the next sync." : ""}`,
          run: () => api("DELETE", scoped(`/activities/${id}`)),
          after: gone,
          done: `Deleted ${s.name}`,
        },
  });
  return node;
}

// Months the history reads at a time.
const HISTORY_MONTHS = 6;

// Every activity done, newest first, by month: the last 6 months (and any
// logged ahead), then "Show older" reads the 6 before, and on. `?workout=`
// or `?exercise=` keeps those done from that workout or with that exercise
// (named under the title); `?back=` is where Back leads.
export async function activityHistory(params = new URLSearchParams()) {
  const workout = params.get("workout");
  const exercise = params.get("exercise");
  const here = href.activities(
    Object.fromEntries(
      ["workout", "exercise", "back"].map((k) => [k, params.get(k)]),
    ),
  );
  const filter = workout
    ? `&workout_id=${workout}`
    : exercise
      ? `&exercise_id=${exercise}`
      : "";
  const named = workout
    ? (await get(`/workouts/${workout}`)).name
    : exercise
      ? (await get(`/exercises/${exercise}`)).name
      : null;
  const list = h("div");
  // The last day not read yet; the first read has no end.
  let end = null;
  const older = h("button", { type: "button", class: "link" }, "Show older");
  const read = async () => {
    const from = monthStart(end ?? today(), 1 - HISTORY_MONTHS);
    const range = end ? `?from=${from}&to=${end}` : `?from=${from}`;
    const got = (
      await get(scoped(`/activities${range}${filter}`))
    ).toReversed();
    const months = new Map();
    for (const s of got) {
      const month = monthYear(s.day);
      if (months.has(month)) months.get(month).push(s);
      else months.set(month, [s]);
    }
    list.append(
      ...[...months].map(([month, rows]) =>
        h(
          "section",
          { class: "finder-section" },
          h(
            "h2",
            {},
            `${month} · ${plural(rows.length, "activity", "activities")}`,
          ),
          h(
            "ul",
            { class: "results card" },
            rows.map((x) => activityRow(x, here)),
          ),
        ),
      ),
    );
    if (got.length === 0)
      list.append(
        end
          ? empty(`Nothing logged ${monthYear(from)} – ${monthYear(end)}.`)
          : empty(
              "No activities in the last 6 months: finish a workout, or log one in the Diary.",
            ),
      );
    end = shift(from, -1);
  };
  await read();
  older.addEventListener("click", busy(read));
  return h(
    "section",
    {},
    titleBar("Activities", safeBack(params.get("back")) ?? href.activity()),
    named ? h("p", { class: "muted filtered" }, named) : null,
    list,
    h("p", {}, older),
  );
}
