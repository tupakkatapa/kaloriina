// The diary day's Log card: everything logged that day but food and
// activity (weight, the scale's body composition, measurements, the
// trackers counted, a check-in and a note) as compact rows; what the food
// held of the habits is Eaten's (diary.mjs), and the Log sheet its + opens, which
// adds them. Weight, measurements, the check-in and the note are edited in
// small dialogs.

import { storedOrKept, writeAll } from "../actions.mjs";
import {
  api,
  createId,
  get,
  loadProfiles,
  meta,
  profileId,
  scoped,
  stored,
  uid,
} from "../api.mjs";
import {
  CHECK_IN_SCALES,
  line as checkInLine,
  customTags,
  normalTag,
  offered,
  tagsOf,
} from "../check-ins.mjs";
import { clockAt, duration, pretty, shift, today } from "../dates.mjs";
import { isNil, lower, qty } from "../format.mjs";
import { counted } from "../habits.mjs";
import { go, goDay, href, showsDay } from "../nav.mjs";
import { EATEN, withUnit } from "../nutrients.mjs";
import { latest } from "../outbox.mjs";
import { readJson, writeJson } from "../prefs.mjs";
import {
  dropSentNotes,
  logRow,
  menuRow,
  result,
  trackerRow,
} from "../rows.mjs";
import {
  chip,
  choice,
  empty,
  errorBox,
  field,
  fill,
  formDialog,
  h,
  icon,
  modal,
  notify,
  PLUS,
  removeButton,
  timeField,
  undoable,
  unitNum,
  unitValue,
} from "../ui.mjs";
import { unitOf, unitQty } from "../units.mjs";
import { addWater, shownBounds } from "../water.mjs";

// A row's main control that opens its dialog.
const editButton = (text, onclick, label = null) =>
  result({ onclick, name: text, "aria-label": label });

// The day's naps, "13:00–13:25" over its length: the Sleep card's
// (diary.mjs), under the night. One logged here has ✕ (Undo logs it
// again); a synced one is removed where it came from.
export const napRows = ({ day, data }) =>
  (data.naps ?? [])
    // A removal waiting to send has taken it already.
    .filter((n) => latest(scoped(`/naps/${n.uid}`))?.method !== "DELETE")
    .map((n) => {
      const span = `${clockAt(n.start_at)}–${clockAt(n.end_at)}`;
      // Its length; asleep too when the device knew less of it asleep.
      const asleep =
        isNil(n.asleep_min) || n.asleep_min === n.in_bed_min
          ? ""
          : `, ${duration(n.asleep_min)} asleep`;
      const row = result({
        cls: "nap",
        name: span,
        detail: `${duration(n.in_bed_min)}${asleep}`,
      });
      if (n.source !== "hand") return logRow("Nap", row);
      return logRow(
        "Nap",
        row,
        removeButton(`Remove nap ${span}`, async () => {
          // Both wait offline: the delete goes by uid, the Undo is a create.
          const path = scoped(`/naps/${n.uid}`);
          const label = `Remove nap ${span}`;
          const del = () =>
            api("DELETE", path, undefined, { queue: true, label });
          if (!(await storedOrKept(del, day))) return;
          await goDay(day);
          undoable(`Removed the ${duration(n.in_bed_min)} nap`, async () => {
            const body = {
              uid: uid(),
              day,
              start_at: n.start_at,
              end_at: n.end_at,
            };
            const add = () =>
              api("POST", scoped("/naps"), body, {
                queue: true,
                label: "Nap",
              });
            if (await storedOrKept(add, day)) goDay(day);
          });
        }),
      );
    });

// Log sheet → Nap: when it began and ended on this device's clock (an end
// before the start began the day before), sent in UTC with a uid, so it
// waits offline like any create.
async function logNap(day) {
  const id = createId();
  const start = timeField({ name: "start_at", required: true });
  const end = timeField({ name: "end_at", required: true });
  let minutes = 0;
  const done = await formDialog(`Nap on ${pretty(day)}`, {
    body: [field("Fell asleep", start), field("Woke up", end)],
    submit: "Save",
    run: async () => {
      const to = new Date(`${day}T${end.value}`);
      const from = new Date(`${day}T${start.value}`);
      if (from >= to) from.setDate(from.getDate() - 1);
      minutes = Math.round((to - from) / 60_000);
      const body = {
        uid: id.get(),
        day,
        start_at: from.toISOString(),
        end_at: to.toISOString(),
      };
      const saved = await stored(() =>
        api("POST", scoped("/naps"), body, { queue: true, label: "Nap" }),
      );
      if (saved === true) id.done();
      return saved;
    },
  });
  if (!done) return;
  await goDay(day);
  notify(
    done === true ? `Logged a ${duration(minutes)} nap` : done.queued.message,
  );
}

// -------------------------------------------------------- per-day logs

// The day's record as last written here: a PUT or DELETE still waiting to
// send is newer than the Day view's (last arrival wins, whole record).
function currentDayLog(path, fromDay) {
  const last = latest(path);
  if (!last) return fromDay;
  return last.method === "PUT" ? last.body : null;
}

// A record's row is `data-kind` "weight", or "measurement:waist" per key.
const rowKind = (rec, key) => (key ? `${rec.kind}:${key}` : rec.kind);

// After a same-screen re-render focus goes back to the record's row (else
// to the card's +), never to the page.
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
async function settle(day, rec, key, done, message, undo = null) {
  if (done === true && rec.reload) await loadProfiles();
  const same = showsDay(day);
  await goDay(day);
  if (same) focusRow(rowKind(rec, key));
  if (done !== true) notify(done.queued.message);
  else if (message && undo) undoable(message, undo);
  else if (message) notify(message);
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
  settle(day, rec, key, done, `Removed ${lower(rec.name(key))}`, async () =>
    settle(
      day,
      rec,
      key,
      await writeAll([putOf(rec, day, key, rec.undoBody(value))]),
    ),
  );

async function removeDayLog(day, rec, key, value) {
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
const saveDayLog = (day, rec, key, done, message) =>
  done ? settle(day, rec, key, done, message) : null;

// The record's value on the day: what waits here, else the Day view's.
const valueOf = (rec, { day, data }, key) =>
  currentDayLog(rec.path(day, key), rec.fromDay(data, key));

// A record's row: its kind, its value opening the dialog, then ✕ when it
// is `removable` here.
function dayLogRow(rec, ctx, key, value, text, label, removable = true) {
  const row = logRow(
    rec.name(key),
    editButton(text, () => rec.edit(ctx, key), label),
    removable
      ? removeButton(`Remove ${lower(rec.name(key))}`, () =>
          removeDayLog(ctx.day, rec, key, value),
        )
      : null,
  );
  row.dataset.kind = rowKind(rec, key);
  return row;
}

const one = () => [null];

// ---------------------------------------------------------------- body

// A weight from the scale (openScale) or Health Connect, not typed here.
const fromScale = (source) => Boolean(source) && source !== "hand";

const WEIGHT = {
  kind: "weight",
  section: "Body",
  // The scale's body composition reads under the weight.
  after: ({ data }) => compositionRow(data.composition ?? null),
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
  // A synced weight goes only with its reading at its source.
  row: (ctx, v) => {
    if (!v) return null;
    const kg = unitQty(v.kg, "kg", 1);
    return dayLogRow(
      WEIGHT,
      ctx,
      null,
      v,
      kg,
      `Change weight, ${kg}`,
      !fromScale(v.source),
    );
  },
  edit: async (ctx) => {
    const { day } = ctx;
    const v = valueOf(WEIGHT, ctx, null);
    // No `step`: a scale weight off any grid saves as stored.
    const kg = unitNum({
      name: "kg",
      value: v?.kg,
      unit: "kg",
      min: meta.limits.body_kg[0],
      max: meta.limits.body_kg[1],
      required: true,
    });
    const label = () => `Weight ${unitQty(unitValue(kg), "kg", 1)}`;
    const done = await formDialog(`Weight on ${pretty(day)}`, {
      body: [
        field(`Weight (${unitOf("kg")})`, kg),
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
              kg: unitValue(kg),
              set_at: Date.now(),
            }),
            label: label(),
          },
        ]),
    });
    await saveDayLog(day, WEIGHT, null, done, `Logged ${lower(label())}`);
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
    ? logRow("Body", result({ cls: "composition", name: text }))
    : null;
}

const measured = (key) => meta.measurements.find((m) => m.key === key);

// One record per kind measured (waist, hips…), in the registry's order;
// every kind is edited in one dialog.
const MEASUREMENT = {
  kind: "measurement",
  section: "Body",
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
    const text = unitQty(v.value, m.unit, 1);
    return dayLogRow(
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
    const inputs = meta.measurements.map((m) => {
      const before = valueOf(MEASUREMENT, ctx, m.key)?.value ?? null;
      const input = unitNum({ name: m.key, value: before, unit: m.unit });
      // As shown, rounded inward: either end saves.
      [input.min, input.max] = shownBounds(meta.limits.measure_cm, m.unit);
      return [m, before, input];
    });
    let first = null;
    const asked = formDialog(`Measurements on ${pretty(day)}`, {
      body: h(
        "div",
        { class: "measures" },
        inputs.map(([m, , input]) =>
          field(withUnit({ ...m, unit: unitOf(m.unit) }), input),
        ),
      ),
      submit: "Save",
      run: () => {
        const writes = inputs.flatMap(([m, before, input]) => {
          const path = MEASUREMENT.path(day, m.key);
          const value = unitValue(input);
          if (value === before) return [];
          first ??= m.key;
          return value === null
            ? [{ method: "DELETE", path, label: `Remove ${lower(m.label)}` }]
            : [
                {
                  method: "PUT",
                  path,
                  body: { value },
                  label: `${m.label} ${unitQty(value, m.unit, 1)}`,
                },
              ];
        });
        return writeAll(writes);
      },
    });
    inputs.find(([m]) => m.key === focusKey)?.[2].focus();
    const done = await asked;
    await saveDayLog(
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
const keptTags = () => readJson(TAGS_KEY, {})[profileId] ?? [];
async function freshTags() {
  const list = await get(scoped(`/check-ins?from=${shift(today(), -365)}`));
  const tags = customTags(list, meta.check_in_tags);
  writeJson(TAGS_KEY, { ...readJson(TAGS_KEY, {}), [profileId]: tags });
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
  const scales = CHECK_IN_SCALES.map(([key, label]) => {
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
        chip(
          tag,
          () => {
            if (!picked.delete(tag)) picked.add(tag);
            paint();
          },
          { pressed: picked.has(tag), disabled: full && !picked.has(tag) },
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
  let cleared = false;
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
      cleared = Object.keys(body).length === 1 && body.tags.length === 0;
      // Nothing to save and nothing to remove: no request.
      if (cleared && !current) return null;
      return writeAll([
        cleared
          ? {
              method: "DELETE",
              path: CHECK_IN.path(day),
              label: "Remove check-in",
            }
          : putOf(CHECK_IN, day, null, body),
      ]);
    },
  });
  if (done && cleared) await removed(day, CHECK_IN, null, current, done);
  else await saveDayLog(day, CHECK_IN, null, done, "Saved check-in");
}

// The check-in reads as itself; today without one asks for it, other days
// show nothing.
const CHECK_IN = {
  kind: "check-in",
  section: "Day",
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
      const text = checkInLine(v, meta.limits.check_in_scale[1]);
      return dayLogRow(
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
  section: "Day",
  label: "Note",
  name: () => "Note",
  keys: one,
  path: (day) => scoped(`/notes/${day}`),
  fromDay: (data) => (data.note ? { text: data.note } : null),
  undoBody: (v) => v,
  row: (ctx, v) => (v ? dayLogRow(NOTE, ctx, null, v, v.text, null) : null),
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
    let cleared = false;
    const done = await formDialog(`Note on ${pretty(day)}`, {
      body: text,
      submit: "Save",
      run: () => {
        cleared = !text.value.trim();
        if (cleared && !current) return null;
        return writeAll([
          cleared
            ? { method: "DELETE", path: NOTE.path(day), label: "Remove note" }
            : putOf(NOTE, day, null, { text: text.value }),
        ]);
      },
    });
    if (done && cleared) await removed(day, NOTE, null, current, done);
    else await saveDayLog(day, NOTE, null, done, "Saved note");
  },
};

// Logged once a day, the same way: a row each in its card `section`, a button
// in the Log sheet (not ahead of today), edit, ✕ with Undo, all through the
// outbox. A new one is one more entry here (its server triple and the export):
// its rows and its button follow.
const DAY_LOGS = [WEIGHT, MEASUREMENT, CHECK_IN, NOTE];

// A record's rows on the day, one per key, then what goes with them.
const dayLogRows = (rec) => (ctx) => [
  ...rec.keys().map((key) => rec.row(ctx, valueOf(rec, ctx, key), key)),
  rec.after?.(ctx),
];

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

// ---------------------------------------------------------------- card

// The card's sections (Body · Habits · Day; activity is the Activity
// card's, web/screens/day-activity.mjs), each its rows in order,
// `(ctx) => row(s) | null`: what else the day holds, then the per-day logs
// of that section, in their order.
const HEADS = [
  ["Body", []],
  ["Habits", [trackerRows]],
  ["Day", []],
];

export function cardSections(logs) {
  const unknown = logs.find((r) => !HEADS.some(([head]) => head === r.section));
  if (unknown)
    throw new Error(`${unknown.kind}: no section ${unknown.section}`);
  return HEADS.map(([head, rows]) => [
    head,
    [
      ...rows,
      ...logs.filter((r) => r.section === head).map((x) => dayLogRows(x)),
    ],
  ]);
}

const SECTIONS = cardSections(DAY_LOGS);

// The card's rows, section by section.
const cardRows = (ctx) =>
  SECTIONS.flatMap(([, rows]) => rows.flatMap((row) => row(ctx)));

// `habits`: the profile's trackers, or the Error loading them.
export function logCard(day, data, habits) {
  // The day's counts, shared with the sheet.
  const counts = new Map(
    (data.habits ?? []).map((x) => [x.habit_id, x.amount]),
  );
  const ctx = { day, data, habits, counts };
  const rows = h("div");
  const paint = () => {
    const list = cardRows(ctx).filter(Boolean);
    fill(
      rows,
      list.length > 0
        ? h("ul", { class: "log-rows" }, list)
        : empty("Nothing logged."),
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
          class: "icon",
          "data-add": true,
          "aria-haspopup": "dialog",
          "aria-label": `Log on ${pretty(day)}`,
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
        icon(PLUS),
      ),
    ),
    rows,
  );
  paint();
  return node;
}

// --------------------------------------------------------------- sheet

const linkRow = (name, to) => menuRow({ href: to, name });
const buttonRow = (name, onclick) => menuRow({ onclick, name });

// The Log sheet: what can be logged on the day. A modal on the page's
// body, so a re-render of the day behind (a count kept offline) leaves it
// open; it closes when the address leaves this day's diary.
// `onClose(changed)` runs when it closes on the day: whether a count
// changed. Hydration, a habit read from food, logs water to Eaten as the
// Add screen's Water does.
function logSheet({ day, data, habits, counts, onClose }) {
  const stop = new AbortController();
  // Known before it's needed: a tap made offline still finds the food.
  const water = get(scoped("/water-food")).catch(() => null);
  let changed = false;
  // Left for another address: closed without telling the day.
  let onDay = true;
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
  const { dialog, close } = modal(
    { class: "confirm sheet", "aria-labelledby": "log-sheet-title" },
    [
      h("h2", { id: "log-sheet-title" }, "Log"),
      h("p", { class: "muted" }, pretty(day)),
      h(
        "ul",
        { class: "menu" },
        // Per-day records and naps, not written ahead of today.
        day <= today()
          ? [
              ...DAY_LOGS.map((rec) =>
                buttonRow(
                  rec.label,
                  instead(() => rec.edit({ day, data }, null)),
                ),
              ),
              buttonRow(
                "Nap",
                instead(() => logNap(day)),
              ),
            ]
          : null,
      ),
      h("h3", { class: "category" }, "Habits"),
      h(
        "ul",
        { class: "menu" },
        buttonRow(
          "Hydration",
          instead(() => addWater(day, EATEN, water)),
        ),
      ),
      Array.isArray(trackers)
        ? trackers.length > 0
          ? h("ul", { class: "habit-rows" }, trackers)
          : null
        : trackers,
      h("ul", { class: "menu" }, linkRow("Manage habits…", href.habits())),
      h(
        "div",
        { class: "actions" },
        h("button", { type: "button", onclick: () => close() }, "Done"),
      ),
    ],
    {
      onClose: () => {
        stop.abort();
        if (onDay) onClose(changed);
      },
      focus: "a, button",
    },
  );
  addEventListener(
    "hashchange",
    () => {
      if (showsDay(day)) return;
      onDay = false;
      close();
    },
    { signal: stop.signal },
  );
  addEventListener("outbox", () => dropSentNotes(dialog, day), {
    signal: stop.signal,
  });
}
