// The Diary tab: a day, as sections (the food groups, then the Log card with
// everything else logged) under the day's targets; and the editor of a
// logged entry.

import { amountControl } from "../amount.mjs";
import {
  api,
  createId,
  get,
  groups,
  meta,
  profileId,
  scoped,
  stored,
} from "../api.mjs";
import { pretty, shift, today } from "../dates.mjs";
import { go, goDay, href, keptHere } from "../nav.mjs";
import {
  CONSUMED,
  KEY_TARGETS,
  KJ_PER_KCAL,
  byCategory,
  fmt,
  fmtUnit,
  isNil,
  kcal,
  PLANNED,
  SOURCES,
  groupLabel,
  nutrient,
  ordered,
  plural,
  qty,
  rangeOf,
  scaled,
} from "../nutrients.mjs";
import {
  busy,
  choice,
  confirmDialog,
  editor,
  field,
  fill,
  formDialog,
  h,
  icon,
  notify,
  nutritionPanel,
} from "../ui.mjs";
import { waterText } from "../habits.mjs";
import { contextLine } from "./finder.mjs";
import { logCard } from "./log.mjs";
import { waitingSection } from "./outbox.mjs";

// One nutrient against its target: eaten, planned on top, and what's left.
export function bar(key, target, consumed, total) {
  const n = nutrient(key);
  const { label } = n;
  // No target: the amount eaten over an empty track, so rows line up.
  if (!target)
    return h(
      "div",
      { class: "target" },
      h(
        "div",
        { class: "target-label" },
        h("span", {}, label),
        h("span", {}, fmtUnit(key, consumed)),
      ),
      h("div", { class: "bar empty", "aria-hidden": "true" }),
      h("small", {}, "No target"),
    );
  const goal = target.value;
  const scale = Math.max(goal, total) || 1;
  const over = !isNil(target.max) && total > target.max;
  const planned = total > consumed;
  const range = rangeOf(key, target);
  const status = () => {
    // "Over" counts from the target shown; "about" targets only count as
    // over past their 10 % allowance, as in Summary.
    if (over) {
      const by = fmtUnit(key, total - goal);
      return consumed > target.max
        ? `${by} over target`
        : `${by} over target with planned`;
    }
    if (isNil(target.min))
      return `${fmtUnit(key, target.max - total)} under target`;
    const toGo = target.min - consumed;
    const after = target.min - total;
    if (toGo <= 0) return "Target met";
    if (!planned) return `${fmtUnit(key, toGo)} to go`;
    return after > 0
      ? `${fmtUnit(key, toGo)} to go · ${fmtUnit(key, after)} after planned`
      : `${fmtUnit(key, toGo)} to go · met with planned`;
  };
  return h(
    "div",
    { class: `target k-${key.replaceAll("_", "-")}${over ? " over" : ""}` },
    h(
      "div",
      { class: "target-label" },
      h("span", {}, label),
      h("span", {}, `${fmtUnit(key, consumed)} / ${range} ${n.unit}`),
    ),
    h(
      "div",
      {
        class: "bar",
        role: "img",
        "aria-label": `${n.label}: ${fmtUnit(key, consumed)} eaten, ${fmtUnit(key, total - consumed)} planned, target ${range} ${n.unit}`,
      },
      h("span", {
        class: "consumed",
        style: { width: `${(consumed / scale) * 100}%` },
      }),
      h("span", {
        class: "planned",
        style: { width: `${((total - consumed) / scale) * 100}%` },
      }),
    ),
    h("small", {}, status()),
  );
}

// Whether an energy total leaves some out: a food logged without an energy
// value can't be counted (imported rows count in their group's total).
const unknownEnergy = (entries) =>
  entries.some((e) => !e.imported && isNil(e.nutrients?.energy));

// An energy total; one that leaves some out is a lower bound, and says so.
const energyTotal = (value, partial) =>
  partial
    ? [
        h("span", { title: "Some energy unknown" }, `≥ ${kcal(value)}`),
        h("span", { class: "sr-only" }, " (some energy unknown)"),
      ]
    : kcal(value);

// An entry's amount as this device writes numbers: "2 × Slice (40 g)",
// "150 g"; one of the water food (`waterId`) in ml or L, as the Water
// habit reads ("330 ml"). Imported history keeps its export's text.
function entryAmount(e, waterId = null) {
  if (e.imported || isNil(e.grams)) return e.amount;
  const weight =
    e.food_id === waterId
      ? waterText(meta.habits, e.grams)
      : qty(e.grams, "g", 1);
  return e.serving
    ? `${fmt(e.quantity, 2)} × ${e.serving} (${weight})`
    : weight;
}

// An entry's amount line: its time first when it has one ("08:15 · 150 g").
const amountLine = (entry, waterId) =>
  [entry.time, entryAmount(entry, waterId)].filter(Boolean).join(" · ");

const moveEntry = (e, group) =>
  api("PATCH", scoped(`/entries/${e.id}`), { group });

// Planned entries to Eaten, one by one in the order shown, then the day
// with one Undo. Stopped by a failure midway, what moved is said and can be
// undone; nothing moved, the error stands.
async function markEaten(entries, day) {
  const moved = [];
  const undo = {
    label: "Undo",
    run: async () => {
      try {
        for (const e of moved) await moveEntry(e, PLANNED);
      } finally {
        goDay(day);
      }
    },
  };
  try {
    for (const e of entries) {
      await moveEntry(e, CONSUMED);
      moved.push(e);
    }
  } catch (err) {
    if (!moved.length) throw err;
    goDay(day);
    notify(`Moved ${moved.length} of ${entries.length}: ${err.message}`, {
      error: true,
      action: undo,
    });
    return;
  }
  goDay(day);
  const what =
    entries.length === 1 ? entries[0].name : plural(entries.length, "food");
  notify(`Moved ${what} to Eaten`, { action: undo });
}

// A planned entry's to-do tick: an empty ring (✓ on hover and focus) that
// marks it eaten.
const tickButton = (entry, day) =>
  h(
    "button",
    {
      type: "button",
      class: "icon tick",
      "aria-label": `Mark ${entry.name} eaten`,
      onclick: busy(() => markEaten([entry], day)),
    },
    "✓",
  );

function entryRow(entry, day, waterId) {
  const energy = entry.nutrients?.energy;
  return h(
    "li",
    { class: "entry" },
    entry.group === PLANNED ? tickButton(entry, day) : null,
    h(
      "a",
      { class: "entry-main", href: href.entry(entry.id) },
      h("span", { class: "name" }, entry.name),
      h("span", { class: "muted" }, amountLine(entry, waterId)),
      h("span", { class: "kcal" }, entry.imported ? "" : kcal(energy)),
    ),
  );
}

// An entry while selecting: a checkbox and what it is. Imported history has
// no values of its own, so it can't be copied.
function pickRow(entry, picked, changed, waterId) {
  return h(
    "li",
    { class: "entry" },
    h(
      "label",
      { class: "entry-main check" },
      h("input", {
        type: "checkbox",
        checked: picked.has(entry.id),
        disabled: entry.imported,
        "aria-label": entry.name,
        onchange: (e) => {
          if (e.target.checked) picked.add(entry.id);
          else picked.delete(entry.id);
          changed();
        },
      }),
      h("span", { class: "name" }, entry.name),
      h(
        "span",
        { class: "muted" },
        entry.imported ? "History can't be copied" : amountLine(entry, waterId),
      ),
      h(
        "span",
        { class: "kcal" },
        entry.imported ? "" : kcal(entry.nutrients?.energy),
      ),
    ),
  );
}

// Copy entries onto a day and group: the day defaults to today (tomorrow
// when they are today's), the group to Eaten up to today, else Planned.
// Then that day, with Undo.
async function logAgain(ids, fromDay) {
  const now = today();
  const day = h("input", {
    type: "date",
    name: "day",
    required: true,
    value: fromDay === now ? shift(now, 1) : now,
  });
  const holder = h("div");
  let group = null;
  const pickGroup = () => {
    group = choice({
      name: "group",
      label: "Group",
      options: groups().map((g) => [g, groupLabel(g)]),
      value: day.value && day.value > today() ? PLANNED : CONSUMED,
    });
    fill(holder, field("Group", group));
  };
  day.addEventListener("change", pickGroup);
  pickGroup();
  const key = createId();
  const n = ids.length;
  const done = await formDialog("Log again", {
    body: [field("Day", day), holder],
    submit: `Log ${n} again`,
    run: async () => {
      let entries;
      const sent = await stored(async () => {
        ({ entries } = await api(
          "POST",
          scoped("/entries"),
          {
            uid: key.get(),
            day: day.value,
            group: group.value,
            entry_ids: ids,
          },
          { queue: true, label: `Log again · ${plural(n, "food")}` },
        ));
      });
      if (sent !== true) return { day: day.value, queued: sent.queued };
      key.done();
      return { day: day.value, entries };
    },
  });
  if (!done) return;
  if (done.queued) {
    keptHere(done.queued, done.day);
    return;
  }
  go(href.day(done.day));
  notify(`Logged ${plural(n, "food")} on ${pretty(done.day)}`, {
    action: {
      label: "Undo",
      run: async () => {
        for (const e of done.entries)
          await api("DELETE", scoped(`/entries/${e.id}`));
        go(href.day(done.day));
      },
    },
  });
}

// A meal of the picked foods and their grams.
async function saveAsMeal(entries) {
  const items = entries
    .filter((e) => e.food_id && e.grams)
    .map((e) => ({ food_id: e.food_id, grams: e.grams }));
  const name = h("input", {
    name: "name",
    required: true,
    maxLength: meta.limits.name,
  });
  const meal = await formDialog("Save as meal", {
    body: [field("Name", name)],
    submit: "Save as meal",
    run: () => api("POST", "/meals", { name: name.value, items }),
  });
  if (!meal) return;
  notify(`Saved meal ${meal.name}`, {
    action: { label: "Open", run: () => go(href.meal(meal.id)) },
  });
}

// What an empty group says.
const EMPTY = {
  [PLANNED]: "Nothing planned.",
  [CONSUMED]: "Nothing eaten yet.",
};

// Ticked entries removed after one confirm (they're history: no Undo, as
// for any entity delete), then the day again.
async function deleteEntries(entries, day) {
  const n = plural(entries.length, "entry", "entries");
  const ok = await confirmDialog(`Delete ${n}?`, {
    detail: entries.map((e) => e.name).join(", "),
    confirm: "Delete",
  });
  if (!ok) return;
  for (const e of entries) await api("DELETE", scoped(`/entries/${e.id}`));
  goDay(day);
  notify(`Deleted ${n}`);
}

// A list with a tick: Select's icon on a narrow phone, where the word
// would push "+ Add" onto a second line.
const SELECT_ICON =
  "M4 6l1.5 1.5L8 5M4 12l1.5 1.5L8 11M4 18l1.5 1.5L8 17M11 6h9M11 12h9M11 18h9";

// A food group. "Select" ticks entries to log again, save as a meal or
// delete; "Select all" ticks every one that can be (`?select={id}` opens it
// selecting, that entry ticked).
function groupSection(g, day, selectId = null, waterId = null) {
  const node = h("section", { class: "group" });
  const copyable = g.entries.filter((e) => !e.imported);
  let picked = copyable.some((e) => e.id === selectId)
    ? new Set([selectId])
    : null;
  const selectBar = h("div", { class: "select-bar" });
  const select = (ids) => {
    picked = ids;
    paint();
    node.querySelector("input:enabled")?.focus();
  };
  const chosen = () => g.entries.filter((e) => picked.has(e.id));
  const all = h("input", {
    type: "checkbox",
    onchange: (e) => {
      picked = new Set(e.target.checked ? copyable.map((x) => x.id) : []);
      paint();
      all.focus();
    },
  });
  const paintBar = () => {
    all.checked = picked.size === copyable.length;
    all.indeterminate = picked.size > 0 && !all.checked;
    fill(
      selectBar,
      h("span", { class: "muted" }, `${picked.size} selected`),
      g.name === PLANNED
        ? h(
            "button",
            {
              type: "button",
              disabled: !picked.size,
              onclick: busy(() => markEaten(chosen(), day)),
            },
            "Mark eaten",
          )
        : null,
      h(
        "button",
        {
          type: "button",
          disabled: !picked.size,
          onclick: () => logAgain([...picked], day),
        },
        "Log again…",
      ),
      h(
        "button",
        {
          type: "button",
          disabled: !picked.size,
          onclick: () => saveAsMeal(chosen()),
        },
        "Save as meal…",
      ),
      h(
        "button",
        {
          type: "button",
          class: "danger",
          disabled: !picked.size,
          onclick: busy(() => deleteEntries(chosen(), day)),
        },
        "Delete…",
      ),
      h("button", { type: "button", onclick: () => select(null) }, "Done"),
    );
  };
  function paint() {
    fill(
      node,
      h(
        "header",
        {},
        h("h2", {}, groupLabel(g.name)),
        h(
          "span",
          { class: "muted total" },
          energyTotal(g.totals.energy ?? 0, unknownEnergy(g.entries)),
        ),
        picked
          ? h("label", { class: "check select-all" }, all, " Select all")
          : null,
        copyable.length && !picked
          ? h(
              "button",
              {
                type: "button",
                class: "select",
                "aria-label": `Select from ${groupLabel(g.name)}`,
                onclick: () => select(new Set()),
              },
              icon(SELECT_ICON),
              h("span", { class: "label" }, "Select"),
            )
          : null,
        groups().includes(g.name) && !picked
          ? h(
              "a",
              {
                class: "button",
                href: href.add(day, g.name),
                "aria-label": `Add to ${groupLabel(g.name)}`,
              },
              "+ Add",
            )
          : null,
      ),
      g.entries.length
        ? h(
            "ul",
            { class: "entries" },
            g.entries.map((e) =>
              picked
                ? pickRow(e, picked, paintBar, waterId)
                : entryRow(e, day, waterId),
            ),
          )
        : h("p", { class: "muted empty" }, EMPTY[g.name] ?? "Nothing here."),
      picked ? selectBar : null,
    );
    if (picked) paintBar();
  }
  paint();
  return node;
}

// The day's sections in order, each `(data, day, {select, habits})` →
// nodes: the food groups, the Log card (everything else), what waits.
const SECTIONS = [
  (data, day, { select }) =>
    data.groups.map((g) =>
      groupSection(g, day, select, data.water_food_id ?? null),
    ),
  (data, day, { habits }) => logCard(day, data, habits),
  (data, day) => waitingSection(day),
];

export async function diary(day, params = new URLSearchParams()) {
  const select = Number(params.get("select")) || null;
  // The trackers load beside the day; failing, only the Log's habits say so.
  const [data, habits] = await Promise.all([
    get(scoped(`/day/${day}`)),
    get(scoped("/habits")).catch((err) => err),
  ]);
  const { consumed, total } = data;
  // The day's nutrient targets (steps, sleep and other goals show elsewhere).
  const targets = data.targets.filter(
    (t) => !isNil(t.value) && nutrient(t.metric),
  );
  const byKey = Object.fromEntries(targets.map((t) => [t.metric, t]));
  // The fold lists every other nutrient, targeted or not, like Targets does.
  const others = ordered().filter((n) => !KEY_TARGETS.includes(n.key));
  const dateInput = h("input", {
    type: "date",
    value: day,
    "aria-label": "Day",
    onchange: (e) => e.target.value && go(href.day(e.target.value)),
  });
  const allTargets = h(
    "details",
    { class: "all-targets" },
    h("summary", {}, "Other nutrients"),
    h(
      "div",
      { class: "targets" },
      byCategory(others).map(([name, list]) => [
        h("h3", { class: "category" }, name),
        list.map((n) =>
          bar(n.key, byKey[n.key], consumed[n.key] ?? 0, total[n.key] ?? 0),
        ),
      ]),
    ),
  );
  const eaten = consumed.energy ?? 0;
  const withPlanned = total.energy ?? 0;
  const partly = (list) => unknownEnergy(list.flatMap((g) => g.entries));
  const eatenPartly = partly(data.groups.filter((g) => g.name !== PLANNED));
  return h(
    "section",
    {},
    h(
      "header",
      { class: "day-nav" },
      h(
        "a",
        {
          class: "button icon",
          href: href.day(shift(day, -1)),
          "aria-label": "Previous day",
        },
        "‹",
      ),
      h("h1", {}, day === today() ? "Today" : pretty(day)),
      dateInput,
      h(
        "a",
        {
          class: "button icon",
          href: href.day(shift(day, 1)),
          "aria-label": "Next day",
        },
        "›",
      ),
    ),
    h(
      "p",
      { class: "headline" },
      h("strong", {}, energyTotal(eaten, eatenPartly)),
      h(
        "span",
        { class: "muted" },
        // The other unit than the headline's.
        ` (${nutrient("energy").unit === "kJ" ? qty(eaten, "kcal", 0) : qty(eaten * KJ_PER_KCAL, "kJ", 0)}) eaten`,
        withPlanned > eaten ? " · " : null,
      ),
      // Wrapping, the "·" stays at the line's end and this part moves whole.
      withPlanned > eaten
        ? h(
            "span",
            { class: "muted", style: { whiteSpace: "nowrap" } },
            energyTotal(withPlanned, partly(data.groups)),
            " with planned",
          )
        : null,
    ),
    h(
      "div",
      { class: "stack" },
      h(
        "div",
        { class: "stack" },
        h(
          "div",
          { class: "targets main" },
          KEY_TARGETS.map((key) =>
            bar(key, byKey[key], consumed[key] ?? 0, total[key] ?? 0),
          ),
        ),
        allTargets,
        targets.length
          ? null
          : h(
              "p",
              { class: "muted" },
              "No targets yet. ",
              h(
                "a",
                { href: href.profileEdit(profileId) },
                "Fill in your profile",
              ),
              " or ",
              h("a", { href: href.targets() }, "set targets"),
              ".",
            ),
      ),
      h(
        "div",
        { class: "stack" },
        SECTIONS.map((section) => section(data, day, { select, habits })),
      ),
    ),
  );
}

// A logged entry: its amount (by the serving it was logged with), group and
// time. Imported
// history has no food behind it, so it can only move — or be re-created as
// a food of yours.
export async function entryEditor(id) {
  const entry = await get(scoped(`/entries/${id}`));
  const food = entry.food_id ? await get(`/foods/${entry.food_id}`) : null;
  const back = href.day(entry.day);
  const panel = nutritionPanel();
  // What saving would make it: the food as it is now, by the amount.
  const per100 = food && !entry.imported ? food.per100 : null;
  let amount = null;
  const paint = () => {
    if (!amount || !per100) return;
    panel.paint([
      { label: "Per 100 g", values: per100 },
      {
        label: `This entry (${qty(amount.grams(), "g")})`,
        values: scaled(per100, amount.grams()),
      },
    ]);
  };
  amount =
    food && !entry.imported
      ? amountControl(
          food,
          entry.serving
            ? { serving: entry.serving, quantity: entry.quantity }
            : { grams: entry.grams },
          paint,
        )
      : null;
  paint();
  const group = choice({
    name: "group",
    label: "Group",
    options: [...new Set([...groups(), entry.group])].map((g) => [
      g,
      groupLabel(g),
    ]),
    value: entry.group,
  });
  // When it was eaten ("08:15"), optional.
  const time = entry.imported
    ? null
    : h("input", { type: "time", name: "time", value: entry.time ?? "" });
  const what = () => [
    amount ? field("Amount", amount.node) : h("p", {}, entry.amount),
    time ? field("Time eaten", time) : null,
  ];
  const { node } = editor({
    title: entry.name,
    back,
    body: [
      h(
        "p",
        { class: "muted" },
        contextLine(
          entry.day,
          null,
          entry.source ? `From ${SOURCES[entry.source]}` : null,
        ),
      ),
      what(),
      field("Group", group),
      entry.imported
        ? h(
            "p",
            { class: "muted" },
            "Imported from your previous diary, without nutrients of its own. ",
            h(
              "a",
              { href: href.newFood({ name: entry.name }) },
              "Create this food",
            ),
            " to log it with its values.",
          )
        : null,
    ],
    save: () =>
      api("PATCH", scoped(`/entries/${entry.id}`), {
        group: group.value,
        ...(amount ? amount.body() : {}),
        ...(time ? { time: time.value || null } : {}),
      }),
    after: () => back,
    saved: (e) => `Saved ${e.name}`,
    secondary: entry.imported
      ? []
      : [
          h(
            "a",
            { class: "button", href: href.select(entry.day, entry.id) },
            "Log again",
          ),
        ],
    remove: entry.imported
      ? null
      : {
          ask: `Delete ${entry.name}?`,
          detail: `${entryAmount(entry)} on ${pretty(entry.day)}`,
          run: () => api("DELETE", scoped(`/entries/${entry.id}`)),
          after: back,
          done: `Deleted ${entry.name}`,
        },
    aside: per100 ? panel.node : null,
  });
  return node;
}
