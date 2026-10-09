// The diary day's Log card: everything logged that day but food (workouts
// planned and done, weight, the scale's body composition, measurements,
// habits, a check-in and a note) as compact rows, and the "+ Log" sheet that
// adds them. Weight, measurements, the check-in and the note are edited in
// small dialogs.

import {
  api,
  get,
  isQueued,
  loadProfiles,
  meta,
  profileId,
  scoped,
  stored,
  uid,
} from "../api.mjs";
import {
  METRICS,
  customTags,
  line as checkInLine,
  normalTag,
  offered,
  tagsOf,
} from "../check-ins.mjs";
import { clockAt, pretty, shift, today } from "../dates.mjs";
import { go, goDay, href, showsDay } from "../nav.mjs";
import { CONSUMED, isNil, qty, withUnit } from "../nutrients.mjs";
import { latest } from "../outbox.mjs";
import {
  busy,
  choice,
  confirmDialog,
  errorBox,
  field,
  fill,
  formDialog,
  h,
  notify,
  num,
} from "../ui.mjs";
import { builtinText, counted, dropSentNotes, trackerRow } from "./habits.mjs";
import { activityLine, nightLine } from "../activity.mjs";
import { distanceText } from "../workouts.mjs";
import { addWater } from "./finder.mjs";
import { sessionLine } from "./sessions.mjs";

// A row: what kind it is, the thing itself, then what can be done to it.
const logRow = (kind, main, ...actions) =>
  h(
    "li",
    { class: "log-row" },
    h("span", { class: "kind" }, kind),
    main,
    actions,
  );

const removeButton = (label, run) =>
  h(
    "button",
    {
      type: "button",
      class: "danger icon",
      "aria-label": label,
      onclick: busy(run),
    },
    "✕",
  );

// A row's main control that opens its dialog.
const editButton = (text, onclick, label = null) =>
  h(
    "button",
    { type: "button", class: "result", "aria-label": label, onclick },
    h("span", { class: "name" }, text),
  );

// ------------------------------------------------------------- workouts

// A workout planned on the day: Start runs it for that day; ✕ drops the
// plan (with Undo).
function plannedRow(day, plan) {
  const row = logRow(
    "Planned workout",
    h("span", { class: "result" }, h("span", { class: "name" }, plan.name)),
    h(
      "a",
      {
        class: "button",
        href: `${href.run(plan.workout_id)}?day=${day}`,
        "aria-label": `Start ${plan.name}`,
      },
      "Start",
    ),
    removeButton(`Remove the plan for ${plan.name}`, async () => {
      await api("DELETE", scoped(`/plans/${plan.id}`));
      goDay(day);
      notify(`Removed ${plan.name} from ${pretty(day)}`, {
        action: {
          label: "Undo",
          run: async () => {
            await api("POST", scoped("/plans"), {
              day,
              workout_id: plan.workout_id,
              uid: uid(),
            });
            goDay(day);
          },
        },
      });
    }),
  );
  row.classList.add("planned");
  return row;
}

// A workout done, with what it burned. Burned energy is shown, not taken
// off the energy target: the activity level behind it already counts
// training.
const sessionRow = (s) =>
  logRow(
    "Workout",
    h(
      "a",
      { class: "result", href: href.session(s.id) },
      h("span", { class: "name" }, s.name),
      h("span", { class: "muted" }, sessionLine(s)),
    ),
  );

// ------------------------------------------------------------ activity

// "Running · 07:00 · 30 min · 8.2 km": a watch workout waiting (ask mode,
// or one the watch detected by itself), with Add (it becomes a workout
// done) and Dismiss (it never comes back). Both are safe to repeat, so
// they queue offline. `withDay`: where days mix, the row is
// headed by its day, not "From watch", and the buttons name it. `after`
// shows the result.
export function pendingRow(p, after, { withDay = false } = {}) {
  const act = (method, done) => async () => {
    try {
      await api(method, scoped(`/sync/health/workouts/${p.key}`), undefined, {
        queue: true,
        label: p.name,
      });
      notify(done);
    } catch (err) {
      if (!isQueued(err)) throw err;
      notify(err.message);
    }
    after();
  };
  const start = clockAt(p.start_at);
  const what = withDay ? `${p.name} on ${pretty(p.day)}` : p.name;
  const row = logRow(
    withDay ? pretty(p.day) : "From watch",
    h(
      "span",
      { class: "result" },
      h("span", { class: "name" }, p.name),
      h(
        "span",
        { class: "muted" },
        [start, qty(p.minutes, "min", 0), distanceText(p.distance_m)]
          .filter(Boolean)
          .join(" · "),
      ),
    ),
    h(
      "button",
      {
        type: "button",
        "aria-label": `Add ${what} at ${start}`,
        onclick: busy(act("POST", `Added ${p.name}`)),
      },
      "Add",
    ),
    h(
      "button",
      {
        type: "button",
        class: "secondary",
        "aria-label": `Dismiss ${what} at ${start}`,
        onclick: busy(async () => {
          const sure = await confirmDialog(`Dismiss ${what} at ${start}?`, {
            detail:
              "It won't be added, now or on a later sync. To count it, log it by hand.",
            confirm: "Dismiss",
          });
          if (sure) await act("DELETE", `Dismissed ${p.name}`)();
        }),
      },
      "Dismiss",
    ),
  );
  row.classList.add("pending");
  return row;
}

// The Android companion's day from Health Connect: a muted line of active
// energy and steps (shown, never added to targets), the night
// that ended the day with its heart, and the watch workouts waiting to be
// added. Added ones are ordinary workout rows.
function activityRows(day, activity, pending) {
  const line = activityLine(activity ?? {});
  const night = nightLine(activity ?? {});
  return [
    line
      ? logRow(
          "Activity",
          h("span", { class: "result muted activity-line" }, line),
        )
      : null,
    night
      ? logRow("Night", h("span", { class: "result muted night-line" }, night))
      : null,
    ...pending.map((p) => pendingRow(p, () => goDay(day))),
  ];
}

// ------------------------------------------------------- per-day records

// "Weight" → "weight", inside a sentence.
const lower = (s) => s.charAt(0).toLowerCase() + s.slice(1);

// Each write queued: true when all were stored, else `{queued}`
// (one kept on this device says so for all; the rest still go out).
async function writeAll(writes) {
  let kept = null;
  for (const { method, path, body, label } of writes) {
    const done = await stored(() =>
      api(method, path, body, { queue: true, label }),
    );
    kept = done.queued ?? kept;
  }
  return kept ? { queued: kept } : true;
}

// The day's record as last written here: a PUT or DELETE still waiting to
// send is newer than the Day view's (last arrival wins, whole record).
function currentDayRecord(path, fromDay) {
  const last = latest(path);
  if (!last) return fromDay;
  return last.method === "PUT" ? last.body : null;
}

// A record's row is `data-kind` "weight", or "measurement:waist" per key.
const rowKind = (rec, key) => (key ? `${rec.kind}:${key}` : rec.kind);

// After a same-screen re-render focus goes back to the record's row (else
// to + Log), never to the page.
function focusRow(kind) {
  const card = document.querySelector(".log-card");
  (
    card?.querySelector(`[data-kind="${kind}"] button`) ??
    card?.querySelector("[data-add]")
  )?.focus();
}

// After a record's writes: the day re-renders (the profile first when it
// follows the record: estimates use the weight), focus returns to the row,
// and a toast says what was done, or that it waits on this device.
async function settle(day, rec, key, done, message, action = null) {
  if (done === true && rec.reload) await loadProfiles();
  const same = showsDay(day);
  await goDay(day);
  if (same) focusRow(rowKind(rec, key));
  if (done !== true) notify(done.queued.message);
  else if (message) notify(message, { action });
}

const putOf = (rec, day, key, body) => ({
  method: "PUT",
  path: rec.path(day, key),
  body,
  label: rec.name(key),
});

// A record gone (✕, or its dialog emptied): "Removed weight" with Undo,
// which puts it back through the outbox too.
const removed = (day, rec, key, value, done) =>
  settle(day, rec, key, done, `Removed ${lower(rec.name(key))}`, {
    label: "Undo",
    run: async () =>
      settle(
        day,
        rec,
        key,
        await writeAll([putOf(rec, day, key, rec.undoBody(value))]),
      ),
  });

async function removeDayRecord(day, rec, key, value) {
  const done = await writeAll([
    {
      method: "DELETE",
      path: rec.path(day, key),
      label: `Remove ${lower(rec.name(key))}`,
    },
  ]);
  await removed(day, rec, key, value, done);
}

// A record's dialog closed: `done` is what `writeAll` gave (null: nothing
// was sent).
const saveDayRecord = (day, rec, key, done, message) =>
  done ? settle(day, rec, key, done, message) : null;

// The record's value on the day: what waits here, else the Day view's.
const valueOf = (rec, { day, data }, key) =>
  currentDayRecord(rec.path(day, key), rec.fromDay(data, key));

// A record's row: its kind, its value opening the dialog, then ✕ (or
// `instead`, a note on why it can't be removed here).
function recordRow(rec, ctx, key, value, text, label, instead = null) {
  const row = logRow(
    rec.name(key),
    editButton(text, () => rec.edit(ctx, key), label),
    instead ??
      removeButton(`Remove ${lower(rec.name(key))}`, () =>
        removeDayRecord(ctx.day, rec, key, value),
      ),
  );
  row.dataset.kind = rowKind(rec, key);
  return row;
}

const one = () => [null];

// ---------------------------------------------------------------- body

// A weight from the scale (openScale), not typed here.
const fromScale = (source) => Boolean(source) && source !== "manual";

const WEIGHT = {
  kind: "weight",
  label: "Weight",
  name: () => "Weight",
  keys: one,
  path: (day) => scoped(`/weights/${day}`),
  // A waiting value was typed here: it carries no source.
  fromDay: (data) =>
    isNil(data.weight) ? null : { kg: data.weight, source: data.weight_source },
  // The profile's weight follows its weight log; estimates use it.
  reload: true,
  // `set_at`: when it was typed, so a later scale reading wins.
  undoBody: (v) => ({ kg: v.kg, set_at: Date.now() }),
  // A scale's weight goes only with its reading in openScale.
  row: (ctx, v) => {
    if (!v) return null;
    const kg = qty(v.kg, "kg", 1);
    return recordRow(
      WEIGHT,
      ctx,
      null,
      v,
      kg,
      `Change weight, ${kg}`,
      fromScale(v.source)
        ? h(
            "span",
            { class: "muted scale-hint" },
            "From the scale: delete the reading in openScale to remove it.",
          )
        : null,
    );
  },
  edit: async (ctx) => {
    const { day } = ctx;
    const v = valueOf(WEIGHT, ctx, null);
    // No `step`: a scale weight off any grid saves as stored.
    const kg = num({
      name: "kg",
      value: v?.kg ?? "",
      min: meta.limits.body_kg[0],
      max: meta.limits.body_kg[1],
      required: true,
    });
    const label = () => `Weight ${qty(Number(kg.value), "kg", 1)}`;
    const done = await formDialog(`Weight on ${pretty(day)}`, {
      body: [
        field("Weight (kg)", kg),
        fromScale(v?.source)
          ? h(
              "p",
              { class: "muted" },
              "A weight saved here replaces the scale's for this day until the next weigh-in.",
            )
          : null,
      ],
      submit: "Save",
      run: () =>
        writeAll([
          {
            ...putOf(WEIGHT, day, null, {
              kg: Number(kg.value),
              set_at: Date.now(),
            }),
            label: label(),
          },
        ]),
    });
    await saveDayRecord(day, WEIGHT, null, done, `Logged ${lower(label())}`);
  },
};

// "Body fat 18 % · Water 55 % · Muscle 41 %", from the scale.
function compositionRow(c) {
  const text = [
    ["Body fat", c?.body_fat],
    ["Water", c?.water],
    ["Muscle", c?.muscle],
  ]
    .filter(([, v]) => !isNil(v))
    .map(([label, v]) => `${label} ${qty(v, "%", 1)}`)
    .join(" · ");
  return text
    ? logRow(
        "Body",
        h(
          "span",
          { class: "result composition" },
          h("span", { class: "name" }, text),
        ),
      )
    : null;
}

const measured = (key) => meta.measurements.find((m) => m.key === key);

// One record per kind measured (waist, hips…), in the registry's order;
// every kind is edited in one dialog.
const MEASUREMENT = {
  kind: "measurement",
  label: "Measurements",
  name: (key) => measured(key).label,
  keys: () => meta.measurements.map((m) => m.key),
  path: (day, key) => scoped(`/measurements/${day}/${key}`),
  fromDay: (data, key) => {
    const m = (data.measurements ?? []).find((x) => x.kind === key);
    return m ? { value: m.value } : null;
  },
  undoBody: (v) => v,
  row: (ctx, v, key) => {
    if (!v) return null;
    const m = measured(key);
    const text = qty(v.value, m.unit, 1);
    return recordRow(
      MEASUREMENT,
      ctx,
      key,
      v,
      text,
      `Change measurements, ${m.label} ${text}`,
    );
  },
  // Each changed kind is written, one emptied is removed; the dialog opens
  // at `focusKey`.
  edit: async (ctx, focusKey) => {
    const { day } = ctx;
    const [min, max] = meta.limits.measure_cm;
    const inputs = meta.measurements.map((m) => {
      const before = valueOf(MEASUREMENT, ctx, m.key)?.value ?? null;
      return [m, before, num({ name: m.key, value: before ?? "", min, max })];
    });
    let first = null;
    const asked = formDialog(`Measurements on ${pretty(day)}`, {
      body: h(
        "div",
        { class: "measures" },
        inputs.map(([m, , input]) => field(withUnit(m), input)),
      ),
      submit: "Save",
      run: () => {
        const writes = inputs.flatMap(([m, before, input]) => {
          const path = MEASUREMENT.path(day, m.key);
          const value = input.value === "" ? null : Number(input.value);
          if (value === before) return [];
          first ??= m.key;
          return value === null
            ? [{ method: "DELETE", path, label: `Remove ${lower(m.label)}` }]
            : [
                {
                  method: "PUT",
                  path,
                  body: { value },
                  label: `${m.label} ${qty(value, m.unit, 1)}`,
                },
              ];
        });
        return writeAll(writes);
      },
    });
    inputs.find(([m]) => m.key === focusKey)?.[2].focus();
    const done = await asked;
    await saveDayRecord(
      day,
      MEASUREMENT,
      focusKey ?? first,
      done,
      "Saved measurements",
    );
  },
};

// ------------------------------------------------------------ check-in

// Your own tags from the last year, most used first, per profile; the last
// list is kept on this device for offline use.
const TAGS_KEY = "checkin-tags";
function keptTags() {
  try {
    return JSON.parse(localStorage.getItem(TAGS_KEY))?.[profileId] ?? [];
  } catch {
    return [];
  }
}
async function freshTags() {
  const list = await get(scoped(`/check-ins?from=${shift(today(), -365)}`));
  const tags = customTags(list, meta.check_in_tags);
  let all = {};
  try {
    all = JSON.parse(localStorage.getItem(TAGS_KEY)) ?? {};
  } catch {
    // A corrupt store is replaced.
  }
  localStorage.setItem(TAGS_KEY, JSON.stringify({ ...all, [profileId]: tags }));
  return tags;
}

// Each scale a switch of 1–5 (tapping the pressed one clears it), tags as
// toggle chips plus one of your own. The dialog opens at once; your custom
// tags fill in when they load. Saved empty, an existing check-in goes.
async function editCheckIn(ctx) {
  const { day } = ctx;
  const current = valueOf(CHECK_IN, ctx, null);
  const max = meta.limits.check_in_tags_max;
  // The day's own tags and those added here stay offered when unpressed.
  const own = [...(current?.tags ?? [])];
  const picked = new Set(own);
  let custom = keptTags();
  // Each scale as the server bounds it (1–5).
  const [low, high] = meta.limits.check_in_scale;
  const scales = METRICS.map(([key, label]) => {
    const ends = `${label} · ${low} low, ${high} high`;
    const control = choice({
      name: key,
      label: ends,
      look: "switch",
      clearable: true,
      options: Array.from({ length: high - low + 1 }, (_, i) =>
        String(low + i),
      ).map((v) => [v, v]),
      value: isNil(current?.[key]) ? "" : String(current[key]),
    });
    control.classList.add("scale");
    return [
      key,
      control,
      h("div", { class: "field" }, h("span", {}, ends), control),
    ];
  });
  const added = h("input", {
    name: "new_tag",
    "aria-label": "Add tag",
    placeholder: "Add tag",
    maxLength: meta.limits.check_in_tag,
    autocomplete: "off",
    onkeydown: (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      const tag = normalTag(added.value);
      if (!tag) return;
      picked.add(tag);
      if (!own.includes(tag)) own.push(tag);
      added.value = "";
      paint();
    },
  });
  const chips = h("div", { class: "chips" });
  const paint = () => {
    const full = picked.size >= max;
    fill(
      chips,
      offered(meta.check_in_tags, own, custom).map((tag) =>
        h(
          "button",
          {
            type: "button",
            class: "chip",
            "aria-pressed": String(picked.has(tag)),
            disabled: full && !picked.has(tag),
            onclick: () => {
              if (!picked.delete(tag)) picked.add(tag);
              paint();
            },
          },
          tag,
        ),
      ),
    );
    added.disabled = full;
  };
  paint();
  freshTags()
    .then((tags) => {
      custom = tags;
      paint();
    })
    .catch(() => {});
  let empty = false;
  const done = await formDialog(`Check-in on ${pretty(day)}`, {
    body: [
      scales.map(([, , node]) => node),
      h(
        "fieldset",
        { class: "check-in-tags", name: "tags", tabIndex: -1 },
        h("legend", {}, "Tags"),
        chips,
        added,
      ),
    ],
    submit: "Save",
    run: () => {
      const body = { tags: tagsOf([...picked, added.value], max) };
      for (const [key, control] of scales)
        if (control.value !== "") body[key] = Number(control.value);
      empty = Object.keys(body).length === 1 && !body.tags.length;
      // Nothing to save and nothing to remove: no request.
      if (empty && !current) return null;
      return writeAll([
        empty
          ? {
              method: "DELETE",
              path: CHECK_IN.path(day),
              label: "Remove check-in",
            }
          : putOf(CHECK_IN, day, null, body),
      ]);
    },
  });
  if (done && empty) await removed(day, CHECK_IN, null, current, done);
  else await saveDayRecord(day, CHECK_IN, null, done, "Saved check-in");
}

// The check-in reads as itself; today without one asks for it, other days
// show nothing.
const CHECK_IN = {
  kind: "check-in",
  label: "Check-in",
  name: () => "Check-in",
  keys: one,
  path: (day) => scoped(`/check-ins/${day}`),
  fromDay: (data) => {
    if (!data.check_in) return null;
    const { mood, energy, stress, tags } = data.check_in;
    return { mood, energy, stress, tags };
  },
  undoBody: (v) => v,
  row: (ctx, v) => {
    if (v) {
      const text = checkInLine(v);
      return recordRow(
        CHECK_IN,
        ctx,
        null,
        v,
        text,
        `Change check-in, ${text}`,
      );
    }
    if (ctx.day !== today()) return null;
    const row = logRow(
      "Check-in",
      editButton("How are you today?", () => editCheckIn(ctx)),
    );
    row.classList.add("prompt");
    row.dataset.kind = CHECK_IN.kind;
    return row;
  },
  edit: (ctx) => editCheckIn(ctx),
};

// ---------------------------------------------------------------- note

// The note is the row's button and reads as itself; emptied, it goes.
const NOTE = {
  kind: "note",
  label: "Note",
  name: () => "Note",
  keys: one,
  path: (day) => scoped(`/notes/${day}`),
  fromDay: (data) => (data.note ? { text: data.note } : null),
  undoBody: (v) => v,
  row: (ctx, v) => (v ? recordRow(NOTE, ctx, null, v, v.text, null) : null),
  edit: async (ctx) => {
    const { day } = ctx;
    const current = valueOf(NOTE, ctx, null);
    // Named by the dialog's title; no second "Note" inside it.
    const text = h("textarea", {
      name: "text",
      rows: 3,
      maxLength: meta.limits.note,
      value: current?.text ?? "",
      "aria-labelledby": "form-dialog-title",
    });
    let empty = false;
    const done = await formDialog(`Note on ${pretty(day)}`, {
      body: text,
      submit: "Save",
      run: () => {
        empty = !text.value.trim();
        if (empty && !current) return null;
        return writeAll([
          empty
            ? { method: "DELETE", path: NOTE.path(day), label: "Remove note" }
            : putOf(NOTE, day, null, { text: text.value }),
        ]);
      },
    });
    if (done && empty) await removed(day, NOTE, null, current, done);
    else await saveDayRecord(day, NOTE, null, done, "Saved note");
  },
};

// Logged once a day, the same way: a row each, a button in + Log (not
// ahead of today), edit, ✕ with Undo, all through the outbox; a new one is
// one more entry here (its server triple and the export).
const DAY_RECORDS = [WEIGHT, MEASUREMENT, CHECK_IN, NOTE];

// A record's rows on the day, one per key.
const recordRows = (rec) => (ctx) =>
  rec.keys().map((key) => rec.row(ctx, valueOf(rec, ctx, key), key));

// -------------------------------------------------------------- habits

// Today lists every active tracker (one tap to count); other days only
// those counted.
function trackerRows({ day, habits, counts }) {
  if (habits instanceof Error)
    return h("li", { class: "log-row muted" }, "Habits couldn't load");
  const isToday = day === today();
  return habits
    .filter((x) => !x.archived)
    .filter((x) => isToday || counted(x.id, day, counts.get(x.id) ?? 0) > 0)
    .map((x) =>
      trackerRow(x, day, counts.get(x.id) ?? 0, {
        onCount: (n) => counts.set(x.id, n),
      }),
    );
}

// What the day's food held of the built-in habits (water, alcohol, fruit
// and vegetables…), one row.
function fromFoodRow({ data }) {
  const text = builtinText(data.builtins ?? []);
  return text
    ? logRow(
        "From food",
        h(
          "span",
          { class: "result habit-builtins" },
          h("span", { class: "name" }, text),
        ),
      )
    : null;
}

// ---------------------------------------------------------------- card

// The card's rows in order, each `(ctx) => row(s) | null`: the per-day
// records (DAY_RECORDS) among what else the day holds. A new kind of log is
// one more entry here.
const ROWS = [
  ({ day, data }) => (data.plans ?? []).map((p) => plannedRow(day, p)),
  ({ data }) => (data.sessions ?? []).map(sessionRow),
  ({ day, data }) =>
    activityRows(day, data.activity, data.pending_sessions ?? []),
  recordRows(WEIGHT),
  ({ data }) => compositionRow(data.composition ?? null),
  recordRows(MEASUREMENT),
  trackerRows,
  fromFoodRow,
  recordRows(CHECK_IN),
  recordRows(NOTE),
];

// `habits`: the profile's trackers, or the Error loading them.
export function logCard(day, data, habits) {
  // The day's counts, shared with the sheet.
  const counts = new Map(
    (data.habits ?? []).map((x) => [x.habit_id, x.amount]),
  );
  const ctx = { day, data, habits, counts };
  const rows = h("div");
  const paint = () => {
    const list = ROWS.flatMap((row) => row(ctx)).filter(Boolean);
    fill(
      rows,
      list.length
        ? h("ul", { class: "log-rows" }, list)
        : h("p", { class: "muted" }, "Nothing logged yet. Use + Log."),
    );
  };
  const node = h(
    "section",
    { class: "group log-card" },
    h(
      "header",
      {},
      h("h2", {}, "Log"),
      h(
        "button",
        {
          type: "button",
          "data-add": true,
          "aria-haspopup": "dialog",
          onclick: () =>
            logSheet({
              ...ctx,
              onClose: async (changed) => {
                if (node.isConnected) paint();
                // The day re-rendered meanwhile, before the last count.
                else if (changed) await go(location.hash);
                document.querySelector(".log-card [data-add]")?.focus();
              },
            }),
        },
        "+ Log",
      ),
    ),
    rows,
  );
  paint();
  return node;
}

// ---------------------------------------------------------------- sheet

const linkRow = (label, to) =>
  h(
    "li",
    {},
    h(
      "a",
      { class: "menu-row", href: to },
      h("span", { class: "name" }, label),
    ),
  );

const buttonRow = (label, onclick) =>
  h(
    "li",
    {},
    h(
      "button",
      { type: "button", class: "menu-row", onclick },
      h("span", { class: "name" }, label),
    ),
  );

// "+ Log": what can be logged on the day. A modal on the page's body, so a
// re-render of the day behind (a count kept offline) leaves it open; it
// closes when the address leaves this day's diary. `onClose(changed)` runs
// when it closes on the day: whether a count changed. Water, a habit read
// from food, logs to Eaten as "+ Water" does.
function logSheet({ day, data, habits, counts, onClose }) {
  const stop = new AbortController();
  // Known before it's needed: a tap made offline still finds the food.
  const water = get(scoped("/water-food")).catch(() => null);
  let changed = false;
  const close = (onDay = true) => {
    stop.abort();
    dialog.close();
    dialog.remove();
    if (onDay) onClose(changed);
  };
  // Another dialog opens instead: never one modal over the other.
  const instead = (open) => () => {
    close();
    open();
  };
  const trackers =
    habits instanceof Error
      ? errorBox(habits)
      : habits
          .filter((x) => !x.archived)
          .map((x) =>
            trackerRow(x, day, counts.get(x.id) ?? 0, {
              onCount: (n) => {
                counts.set(x.id, n);
                changed = true;
              },
              waitNote: true,
            }),
          );
  const dialog = h(
    "dialog",
    {
      class: "confirm sheet",
      "aria-labelledby": "log-sheet-title",
      oncancel: (e) => {
        e.preventDefault();
        close();
      },
    },
    h("h2", { id: "log-sheet-title" }, "Log"),
    h("p", { class: "muted" }, pretty(day)),
    h(
      "ul",
      { class: "menu" },
      linkRow("Log a workout done", href.session("new", { day })),
      linkRow("Plan a workout", href.plan(day)),
      linkRow("Start a saved workout", href.plan(day, { start: 1 })),
      // Per-day records, not written ahead of today.
      day <= today()
        ? DAY_RECORDS.map((rec) =>
            buttonRow(
              rec.label,
              instead(() => rec.edit({ day, data }, null)),
            ),
          )
        : null,
    ),
    h("h3", { class: "category" }, "Habits"),
    h(
      "ul",
      { class: "menu" },
      buttonRow(
        "Water",
        instead(() => addWater(day, CONSUMED, water)),
      ),
    ),
    Array.isArray(trackers)
      ? trackers.length
        ? h("ul", { class: "habit-rows" }, trackers)
        : null
      : trackers,
    h("ul", { class: "menu" }, linkRow("Manage habits…", href.habits())),
    h(
      "div",
      { class: "actions" },
      h("button", { type: "button", onclick: () => close() }, "Done"),
    ),
  );
  addEventListener(
    "hashchange",
    () => {
      if (!showsDay(day)) close(false);
    },
    { signal: stop.signal },
  );
  addEventListener("outbox", () => dropSentNotes(dialog, day), {
    signal: stop.signal,
  });
  document.body.append(dialog);
  dialog.showModal();
  dialog.querySelector("a, button").focus();
}
