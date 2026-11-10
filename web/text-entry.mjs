// Text entries: what was eaten in words, with no food behind it, its kcal
// and macros estimates or not known. Logged from the finder ("One-off item"),
// edited here, and matched to a food from the finder ("Find the food").

import { keptHere, logged } from "./actions.mjs";
import { api, createId, groups, meta, scoped, stored } from "./api.mjs";
import { eatenTime, pretty, today } from "./dates.mjs";
import { isNil, NBSP } from "./format.mjs";
import { href } from "./nav.mjs";
import { EATEN, kcalParts, PLANNED } from "./nutrients.mjs";
import { contextLine } from "./rows.mjs";
import {
  chip,
  choice,
  editor,
  energyLabel,
  energyNum,
  energyOf,
  field,
  formDialog,
  h,
  nameInput,
  num,
  numberOrNull,
  setEnergy,
  timeField,
} from "./ui.mjs";

// Rough sizes a tap fills the kcal with.
const SIZES = [
  ["Snack", 200],
  ["Meal", 600],
  ["Big meal", 1000],
];

const MACROS = [
  ["protein", "Protein"],
  ["carbs", "Carbs"],
  ["fat", "Fat"],
];

// A text entry's own inputs: its name, kcal (an estimate, empty when not
// known; `sizes` adds chips filling it), protein, carbs and fat (grams,
// each optional, folded away until given), and its time eaten.
function textInputs({ name, nutrients = null, time = "", sizes = false }) {
  const named = nameInput({ max: meta.limits.name, value: name });
  const energy = energyNum({
    name: "energy",
    value: nutrients?.energy,
    max: meta.limits.entry_energy,
  });
  const macros = MACROS.map(([key, label]) => [
    key,
    label,
    num({
      name: key,
      value: nutrients?.[key] ?? "",
      max: meta.limits.entry_macro,
    }),
  ]);
  const timeInput = timeField({ name: "time", value: time });
  return {
    named,
    energy,
    time: timeInput,
    values: () =>
      Object.fromEntries([
        ["energy", energyOf(energy)],
        ...macros.map(([key, , input]) => [key, numberOrNull(input)]),
      ]),
    fields: [
      field("Name", named),
      field(`${energyLabel()}, an estimate`, energy, {
        hint: "Leave it empty when you can't tell.",
      }),
      sizes
        ? h(
            "div",
            { class: "chips" },
            SIZES.map(([size, kcal]) =>
              chip(`${size} ≈${NBSP}${kcalParts(kcal).value}`, () =>
                setEnergy(energy, kcal),
              ),
            ),
          )
        : null,
      h(
        "details",
        {
          class: "fold",
          open: MACROS.some(([key]) => !isNil(nutrients?.[key])),
        },
        h("summary", {}, "Protein, carbs and fat"),
        h(
          "div",
          { class: "fold-fields" },
          macros.map(([, label, input]) => field(`${label} (g)`, input)),
        ),
      ),
    ],
    timeRow: field("Time eaten", timeInput),
  };
}

// A text entry (`name`, maybe its kcal, its time) logged into `group`.
// Waits offline like any log.
export async function addText(day, group, name) {
  const key = createId();
  const t = textInputs({
    name,
    time: eatenTime(day, group) ?? "",
    sizes: true,
  });
  let entries = null;
  const done = await formDialog("One-off item", {
    body: [...t.fields, group === PLANNED ? null : t.timeRow],
    submit: `Add to ${group}`,
    run: () =>
      stored(async () => {
        const given = Object.entries(t.values()).filter(([, v]) => !isNil(v));
        ({ entries } = await api(
          "POST",
          scoped("/entries"),
          {
            uid: key.get(),
            day,
            group,
            name: t.named.value,
            ...Object.fromEntries(given),
            ...(group !== PLANNED && t.time.value
              ? { time: t.time.value }
              : {}),
          },
          { queue: true, label: t.named.value },
        ));
      }),
  });
  if (!done) return;
  if (done !== true) {
    keptHere(done.queued, day);
    return;
  }
  key.done();
  logged(day, group, t.named.value, entries);
}

// A text entry's editor: name, kcal, time and group; Log again
// (`logAgainToday` the Diary's); "Find the food", the finder searched by
// its name, whose food then takes its place. Its edits are online only,
// as an entry's are.
export function textForm(entry, logAgainToday) {
  const back = href.day(entry.day);
  const t = textInputs({
    name: entry.name,
    nutrients: entry.nutrients,
    time: entry.time ?? "",
  });
  const group = choice({
    name: "group",
    label: "Group",
    options: [...new Set([...groups(), entry.group])].map((g) => [g, g]),
    value: entry.group,
    onChange: (g) => {
      t.timeRow.hidden = g === PLANNED;
    },
  });
  t.timeRow.hidden = entry.group === PLANNED;
  return editor({
    title: entry.name,
    back,
    body: [
      h("p", { class: "muted" }, contextLine(entry.day, null, "One-off item")),
      t.fields,
      t.timeRow,
      field("Group", group),
      h(
        "p",
        {},
        h(
          "a",
          {
            class: "button",
            href: href.add(entry.day, entry.group, {
              q: entry.name,
              replace: entry.id,
            }),
          },
          "Find the food",
        ),
      ),
    ],
    save: () =>
      api("PATCH", scoped(`/entries/${entry.id}`), {
        name: t.named.value,
        ...t.values(),
        group: group.value,
        time: eatenTime(
          entry.day,
          entry.group === EATEN ? null : group.value,
          t.time.value,
        ),
      }),
    after: () => back,
    saved: (e) => `Saved ${e.name}`,
    secondary: [
      h(
        "a",
        { class: "button", href: href.select(entry.day, entry.id) },
        "Log again",
      ),
      entry.day === today()
        ? null
        : h(
            "button",
            { type: "button", onclick: logAgainToday(entry) },
            "Log again today",
          ),
    ],
    remove: {
      ask: `Delete ${entry.name}?`,
      detail: `A one-off item on ${pretty(entry.day)}`,
      run: () => api("DELETE", scoped(`/entries/${entry.id}`)),
      after: back,
      done: `Deleted ${entry.name}`,
    },
  }).node;
}
