// The Diary tab: a day, as sections (the food groups, then the Sleep,
// Activity and Log cards) under the day's targets; and the editor of a
// logged entry.

import { keptHere, storedOrKept, undoLog } from "../actions.mjs";
import {
  api,
  createId,
  currentProfile,
  get,
  groups,
  meta,
  profileId,
  scoped,
  stored,
  take,
  write,
} from "../api.mjs";
import { bar, nutrientCard } from "../bars.mjs";
import { coverage } from "../coverage.mjs";
import { eatenTime, pretty, shift, today } from "../dates.mjs";
import { isNil, lower, plural, whole } from "../format.mjs";
import {
  builtinHabit,
  builtinText,
  habitAmountText,
  minutesOn,
} from "../habits.mjs";
import { go, goDay, href } from "../nav.mjs";
import {
  carbsFloor,
  EATEN,
  kcal,
  nutrient,
  PLANNED,
  SOURCES,
} from "../nutrients.mjs";
import { latest, waiting } from "../outbox.mjs";
import { deletePhoto, photoSrc } from "../photos.mjs";
import {
  contextLine,
  entryAmount,
  entryRow,
  favoriteStar,
  logRow,
  result,
} from "../rows.mjs";
import { supplementNotes } from "../supplements.mjs";
import { complete } from "../targets.mjs";
import {
  busy,
  choice,
  confirmDialog,
  editLink,
  editor,
  empty,
  field,
  fill,
  formDialog,
  h,
  icon,
  modal,
  nameInput,
  notify,
  periodNav,
  PLUS,
  SELECT,
  timeField,
  undoable,
} from "../ui.mjs";
import { amountView, repeatFrom } from "./amount-view.mjs";
import { activityCard } from "./day-activity.mjs";
import { sleepCard } from "./day-details.mjs";
import { logCard, napRows } from "./log.mjs";
import { waitingSection } from "./outbox.mjs";
import { runBanner } from "./run.mjs";

// Whether an energy total leaves some out: a food logged without an energy
// value can't be counted (imported rows count in their group's total).
const unknownEnergy = (entries) =>
  entries.some((e) => e.kind !== "imported" && isNil(e.nutrients?.energy));

// Whether entries' energy leaves some out: a food without it, or a recipe
// with an ingredient without it (their `known.energy`). One test for a
// group (its `known`, when the server gives one) and the day.
const partly = (entries, known) =>
  unknownEnergy(entries) || !isNil(known?.energy);

// Whether the day's eaten energy leaves some out.
const energyPartly = (data) =>
  partly(
    data.groups.filter((g) => g.name !== PLANNED).flatMap((g) => g.entries),
    data.known,
  );

// An energy total; one that leaves some out is a lower bound, and says so.
const energyTotal = (value, partial) =>
  partial
    ? [
        h("span", { title: "Some energy unknown" }, `≥ ${kcal(value)}`),
        h("span", { class: "sr-only" }, " (some energy unknown)"),
      ]
    : kcal(value);

const moveEntry = (e, group, time) =>
  write(
    "PATCH",
    scoped(`/entries/${e.id}`),
    { group, ...(time === undefined ? {} : { time }) },
    `Move ${e.name}`,
  );

// Planned entries to Eaten, one by one in the order shown, then the day
// with one Undo. Today they take now (back in Planned, the server clears
// it: a planned entry has no time eaten).
// Stopped by a failure midway, what moved is said and can be undone;
// nothing moved, the error stands.
async function markEaten(entries, day) {
  const moved = [];
  const undo = async () => {
    try {
      for (const e of moved) await moveEntry(e, PLANNED);
    } finally {
      goDay(day);
    }
  };
  try {
    for (const e of entries) {
      await moveEntry(e, EATEN, eatenTime(day, EATEN) ?? undefined);
      moved.push(e);
    }
  } catch (err) {
    if (moved.length === 0) throw err;
    goDay(day);
    undoable(
      `Moved ${moved.length} of ${entries.length}: ${err.message}`,
      undo,
      {
        error: true,
      },
    );
    return;
  }
  goDay(day);
  const what =
    entries.length === 1 ? entries[0].name : plural(entries.length, "food");
  undoable(`Moved ${what} to Eaten`, undo);
}

// A due day's tick (a series' day: `e.key`, no id): an entry in `group`
// (Eaten from its row) with the day's key as its uid, so two devices log
// it once, at the time `typed` (else as `eatenTime`). Its toast, with
// Undo; offline it waits, and the toast says so.
async function tick(e, group = EATEN, typed = null) {
  const done = await write(
    "POST",
    scoped("/entries"),
    {
      uid: e.key,
      day: e.day,
      group,
      repeat_of: e.repeat.id,
      time: eatenTime(e.day, group, typed),
    },
    e.name,
  );
  if (done.queued) return { message: done.queued.message };
  const [{ id }] = done.data.entries;
  return {
    message: `Moved ${e.name} to ${group}`,
    undo: async () => {
      await write("DELETE", scoped(`/entries/${id}`), undefined, e.name);
      goDay(e.day);
    },
  };
}

// Skipping a due day (its editor's Delete): its toast, with Undo; both
// wait offline.
async function skip(e) {
  const path = scoped(`/entries/${e.key}`);
  const done = await stored(() =>
    api("DELETE", path, undefined, { queue: true, label: `Skip ${e.name}` }),
  );
  if (done !== true) return { message: done.queued.message };
  return {
    message: `Skipped ${e.name} on ${pretty(e.day)}`,
    undo: async () => {
      if (
        await storedOrKept(
          () =>
            api("PUT", path, undefined, {
              queue: true,
              label: `Undo skip ${e.name}`,
            }),
          e.day,
        )
      )
        goDay(e.day);
    },
  };
}

// A toast of what a tick or skip said.
const say = (said) =>
  said.undo ? undoable(said.message, said.undo) : notify(said.message);

// A row's ✓: a planned entry moves to Eaten, a due day is ticked.
const eat = (e, day) =>
  e.kind === "due"
    ? tick(e).then((said) => {
        goDay(day);
        say(said);
      })
    : markEaten([e], day);

// The day's entries, but those a removal waiting to send has taken, and
// the due days a tick waiting to send stands in for (its waiting row
// shows instead).
const shownEntries = (entries, day) => {
  const held = waiting(profileId, day);
  return entries.filter(
    (e) =>
      latest(scoped(`/entries/${e.key}`))?.method !== "DELETE" &&
      (e.kind !== "due" || !held.some((x) => x.body?.uid === e.key)),
  );
};

// The day's entry creates still on this device, by group: shown in it,
// not counted yet.
const queuedEntries = (day, group) =>
  waiting(profileId, day).filter(
    (x) =>
      x.method === "POST" &&
      x.path.endsWith("/entries") &&
      x.body?.group === group,
  );

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
      options: groups().map((g) => [g, g]),
      value: day.value && day.value > today() ? PLANNED : EATEN,
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
            time: eatenTime(day.value, group.value),
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
  undoable(`Logged ${plural(n, "food")} on ${pretty(done.day)}`, () =>
    undoLog(done.day, done.entries),
  );
}

// A meal of the picked foods and their grams.
async function saveAsMeal(entries) {
  const items = entries
    .filter((e) => e.food_id && e.grams)
    .map((e) => ({ food_id: e.food_id, grams: e.grams }));
  const name = nameInput({ max: meta.limits.name });
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
  [EATEN]: "Nothing logged.",
};

// Ticked entries removed after one confirm (they're history: no Undo, as
// for any entity delete), then the day again. Stopped by a failure midway,
// what was deleted is said, as markEaten says what moved; nothing deleted,
// the error stands.
async function deleteEntries(entries, day) {
  const n = plural(entries.length, "entry", "entries");
  const ok = await confirmDialog(`Delete ${n}?`, {
    detail: entries.map((e) => e.name).join(", "),
    confirm: "Delete",
  });
  if (!ok) return;
  let deleted = 0;
  let kept = null;
  try {
    for (const e of entries) {
      const done = await write(
        "DELETE",
        scoped(`/entries/${e.id}`),
        undefined,
        e.name,
      );
      kept = done.queued ?? kept;
      deleted += 1;
    }
  } catch (err) {
    if (!deleted) throw err;
    goDay(day);
    notify(`Deleted ${deleted} of ${entries.length}: ${err.message}`, {
      error: true,
    });
    return;
  }
  goDay(day);
  notify(kept ? kept.message : `Deleted ${n}`);
}

// A group's photos as a strip of thumbnails, only when it has some; one
// opens full size with Delete.
function photoStrip(photos, group, day) {
  if (photos.length === 0) return null;
  const label = (i) => `Photo ${i + 1} of ${photos.length}, ${group}`;
  return h(
    "ul",
    { class: "photo-strip", "aria-label": `${group} photos` },
    photos.map((p, i) =>
      h(
        "li",
        {},
        h(
          "button",
          {
            type: "button",
            class: "photo-thumb",
            "aria-label": `Open ${lower(label(i))}`,
            onclick: () => photoView(p, label(i), day),
          },
          h("img", { src: photoSrc(p), alt: "", loading: "lazy" }),
        ),
      ),
    ),
  );
}

// A photo full size, in a dialog: Close, or Delete (confirmed; no Undo).
function photoView(photo, label, day) {
  const { close } = modal(
    { class: "confirm photo-view", "aria-label": label },
    [
      h("img", { src: photoSrc(photo), alt: label }),
      h(
        "div",
        { class: "actions" },
        h(
          "button",
          {
            type: "button",
            class: "danger",
            onclick: busy(async () => {
              if (!(await confirmDialog("Delete this photo?"))) return;
              await deletePhoto(photo);
              close();
              goDay(day);
              notify("Deleted the photo");
            }),
          },
          "Delete",
        ),
        h("button", { type: "button", onclick: () => close() }, "Close"),
      ),
    ],
    { focus: ".actions button:last-child" },
  );
}

// The hydration built-in (ADR 0020): water from food and drink, less what
// alcohol takes back.
const hydration = () => meta.habits.find((b) => b.source === "hydration");

// "1.2 L of 2.5 L": the day's hydration against its goal (the water
// target; more on a day with activity, which it says: "of 2.8 L (2.5 L +
// activity)"). Shown on a day with some, and
// today with a goal (as today's trackers are: one tap to log). Water is
// logged from the Log sheet's Hydration or the Add screen's Water. A food
// that counts but whose water can't be told leaves it a floor: "≥ 1.2 L".
// Under the goal it never rounds up to it: 2,459 ml of 2.5 L is "2.4 L".
function hydrationRow({ day, data }) {
  const b = builtinHabit(
    hydration(),
    data.targets,
    minutesOn(data.activities ?? []),
  );
  const x = (data.builtins ?? []).find((y) => y.habit === b.id);
  const amount = x?.amount;
  // The day's goal, as every view judges the day.
  const goal = b.goalOn(day);
  if (!amount && (isNil(goal) || day !== today())) return null;
  const value = (amount ?? 0) * b.factor;
  // To what habitAmountText shows (ml under 1 L, then a tenth of one),
  // down where up would reach the goal.
  const step = value < 1 ? 1000 : 10;
  const up = Math.round(value * step) / step;
  const reads =
    !isNil(goal) && value < goal && up >= goal
      ? Math.floor(value * step) / step
      : up;
  const shown = whole(
    `${x?.known === false ? "≥ " : ""}${habitAmountText(b, reads)}`,
  );
  // "≥ 402 ml", "of 2.5 L", "(2 L + activity)": each part moves whole.
  const why =
    goal === b.goal
      ? ""
      : ` ${whole(`(${habitAmountText(b, b.goal)} + activity)`)}`;
  return logRow(
    "Hydration",
    result({
      cls: "hydration",
      name: isNil(goal)
        ? shown
        : `${shown} ${whole(`of ${habitAmountText(b, goal)}`)}${why}`,
    }),
  );
}

// What the day's food held of the other built-in habits (alcohol, fruit
// and vegetables, salt…), one row.
function fromFoodRow({ data }) {
  const text = builtinText(
    (data.builtins ?? []).filter(
      (x) => meta.habits.find((b) => b.key === x.habit) !== hydration(),
    ),
    data,
  );
  return text
    ? logRow("From food", result({ cls: "habit-builtins", name: text }))
    : null;
}

// Eaten's foot: the day's totals from food, Hydration then the other
// built-ins, as Log rows (one label column, one value edge). None when
// neither shows.
function dayTotals(day, data) {
  const rows = [hydrationRow({ day, data }), fromFoodRow({ data })].filter(
    Boolean,
  );
  return rows.length > 0
    ? h(
        "ul",
        {
          class: "log-rows day-totals",
          "aria-label": "Day's totals from food",
        },
        rows,
      )
    : null;
}

// A food group. "Select" ticks entries to log again, save as a meal or
// delete; "Select all" ticks every one that can be (`?select={id}` opens it
// selecting, that entry ticked). Planned lists the day's due days first
// (not while selecting: they have no entry to copy yet). `foot`: what goes
// under it all (Eaten's day totals), not while selecting.
function groupSection(
  g,
  day,
  selectId = null,
  waterId = null,
  photos = [],
  foot = null,
) {
  const node = h("section", { class: "group" });
  const queued = queuedEntries(day, g.name).map((x) =>
    entryRow(
      { name: x.label },
      {
        pending: x.failed ? "Not sent" : "Waiting to send · not counted yet",
      },
    ),
  );
  const logged = g.entries.filter((e) => e.kind !== "due");
  const copyable = logged.filter((e) => e.kind !== "imported");
  let picked = copyable.some((e) => e.id === selectId)
    ? new Set([selectId])
    : null;
  const selectBar = h("div", { class: "select-bar" });
  const select = (ids) => {
    picked = ids;
    paint();
    node.querySelector("input:enabled")?.focus();
  };
  const chosen = () => logged.filter((e) => picked.has(e.id));
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
              disabled: picked.size === 0,
              onclick: busy(() => markEaten(chosen(), day)),
            },
            "Mark eaten",
          )
        : null,
      h(
        "button",
        {
          type: "button",
          disabled: picked.size === 0,
          onclick: () => logAgain([...picked], day),
        },
        "Log again…",
      ),
      h(
        "button",
        {
          type: "button",
          disabled: picked.size === 0,
          onclick: () => saveAsMeal(chosen()),
        },
        "Save as meal…",
      ),
      h(
        "button",
        {
          type: "button",
          class: "danger",
          disabled: picked.size === 0,
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
        h("h2", {}, g.name),
        // An empty group's "0 kcal" says nothing its "Nothing here" doesn't.
        g.entries.length > 0
          ? h(
              "span",
              { class: "muted total" },
              energyTotal(g.totals.energy ?? 0, partly(g.entries, g.known)),
            )
          : null,
        picked
          ? h("label", { class: "check select-all" }, all, " Select all")
          : null,
        copyable.length > 0 && !picked
          ? h(
              "button",
              {
                type: "button",
                class: "select",
                "aria-label": `Select from ${g.name}`,
                onclick: () => select(new Set()),
              },
              icon(SELECT),
              h("span", { class: "label" }, "Select"),
            )
          : null,
        groups().includes(g.name) && !picked
          ? h(
              "a",
              {
                class: "button icon",
                href: href.add(day, g.name),
                "aria-label": `Add to ${g.name}`,
              },
              icon(PLUS),
            )
          : null,
      ),
      (picked ? logged : g.entries).length > 0 || (!picked && queued.length > 0)
        ? h(
            "ul",
            { class: "entries" },
            (picked ? logged : g.entries).map((e) =>
              entryRow(e, {
                waterId,
                onTick: () => eat(e, day),
                pick: picked && { picked, changed: paintBar },
                note: g.notes?.get(e.key),
              }),
            ),
            picked ? null : queued,
          )
        : empty(EMPTY[g.name] ?? "Nothing here."),
      picked ? null : photoStrip(photos, g.name, day),
      picked ? selectBar : foot,
    );
    if (picked) paintBar();
  }
  paint();
  return node;
}

// The day's food groups, Planned with its due days first, Eaten with the
// day's totals at its foot and a note on a supplement eaten with no meal
// with fat near it (supplements.mjs).
function groupSections(data, day, select) {
  return data.groups.map((g) =>
    groupSection(
      {
        ...g,
        entries: shownEntries(g.entries, day),
        notes: g.name === EATEN ? supplementNotes(g.entries) : null,
      },
      day,
      select,
      data.water_food_id ?? null,
      (data.photos ?? []).filter((p) => p.group === g.name),
      g.name === EATEN ? dayTotals(day, data) : null,
    ),
  );
}

export async function diary(day, params = new URLSearchParams()) {
  const select = Number(params.get("select")) || null;
  // The trackers load beside the day; failing, only the Log's habits say so.
  // Started already with meta and profiles, on an open (nav.mjs).
  const [data, habits, run] = await Promise.all([
    take(scoped(`/day/${day}`)),
    take(scoped("/habits")).catch((err) => err),
    runBanner(),
  ]);
  const { total } = data;
  const eaten = carbsFloor(data.eaten);
  // What was eaten and how far it's known (ADR 0030), as coverage reads it.
  const day0 = { total: eaten, known: data.known };
  // The day's nutrient targets (steps, sleep and other goals show elsewhere).
  const targets = data.targets.filter(
    (t) => !isNil(t.value) && nutrient(t.metric),
  );
  const byKey = Object.fromEntries(targets.map((t) => [t.metric, t]));
  // Nothing logged: empty tracks, nothing said under them.
  const blank =
    data.groups.every((g) => g.entries.length === 0) &&
    !Object.values(total).some(Boolean);
  return h(
    "section",
    {},
    periodNav({ kind: "day", day, hrefFor: (_, d) => href.day(d) }),
    run,
    // One column at every width, in one order: the day's numbers, its food
    // groups, then Sleep, Activity and the Log. A stack, not the section's own
    // children: cards follow each other at the stack's gap.
    h(
      "div",
      { class: "stack" },
      nutrientCard(
        (key, compact) =>
          bar(key, byKey[key], eaten[key], total[key] ?? 0, {
            compact,
            share: coverage([day0], key),
            lower: key === "energy" ? energyPartly(data) : null,
            blank,
          }),
        {
          headline: headline(data),
          // Nothing logged: every row as it is, nothing to fold.
          tracked: (key) => blank || !isNil(eaten[key]) || Boolean(byKey[key]),
        },
      ),
      targets.length > 0 ? null : targetsHint(),
      groupSections(data, day, select),
      sleepCard(data, napRows({ day, data })),
      activityCard(day, data),
      logCard(day, data, habits),
    ),
    waitingSection(day),
  );
}

// No nutrient targets: set them on Targets, which recommends them once the
// profile has every measurement it needs (else fill those in first).
const targetsHint = () =>
  h(
    "p",
    { class: "muted targets-hint" },
    "No targets yet: ",
    complete(currentProfile() ?? {})
      ? null
      : [
          h("a", { href: href.profileEdit(profileId) }, "fill in your profile"),
          " or ",
        ],
    h("a", { href: href.targets() }, "set targets"),
    ".",
  );

// "2,099 kcal eaten · 2,719 kcal with planned": the second part only with
// something planned. Wrapping, it moves whole, the "·" (CSS, before it)
// leading it, never one left dangling at a line's end. A day with nothing
// in it says so, not "0 kcal".
function headline(data) {
  if (!data.total.energy && data.groups.every((g) => g.entries.length === 0))
    return h(
      "p",
      { class: "headline" },
      h("span", { class: "muted" }, "Nothing logged"),
    );
  const eatenKcal = data.eaten.energy ?? 0;
  const withPlanned = data.total.energy ?? 0;
  const eatenPartly = energyPartly(data);
  return h(
    "p",
    { class: "headline" },
    h("strong", {}, energyTotal(eatenKcal, eatenPartly)),
    h("span", { class: "muted" }, " eaten"),
    withPlanned > eatenKcal
      ? [
          " ",
          h(
            "span",
            { class: "muted" },
            energyTotal(
              withPlanned,
              eatenPartly ||
                data.groups.some((g) => partly(g.entries, g.known)),
            ),
            " with planned",
          ),
        ]
      : null,
  );
}

// Removing imported history: an imported row has no nutrients of its own
// (they're in its import group's total), so the import group's rows
// (`src_group`) go together with that total, and the day's totals drop by
// exactly it. No Undo, like any delete; the confirm says what goes.
function importedRemoval(day, group, items, back) {
  const name = group;
  const what = plural(items, "item");
  return {
    label: `Remove imported ${name} (${what})`,
    ask: `Remove imported ${name}?`,
    detail:
      `All ${what} imported into ${name} on ${pretty(day)} and their ` +
      "total go together: imported rows have no nutrients of their own. " +
      "Your own entries stay.",
    run: () =>
      api("DELETE", scoped(`/imported/${day}/${encodeURIComponent(group)}`)),
    after: back,
    done: `Removed imported ${name}`,
  };
}

// A logged entry, or a due day of a series (no id: its key is
// `daily-{item}-{day}`): its amount (by the serving it was logged with),
// group and time, whether it repeats daily; its food's ☆ and Edit, and a
// recipe's ingredients. Imported history has no food behind it, so it can
// only move, go with its import group (`importedRemoval`), or be
// re-created as a food of yours. A day not due (skipped, stopped, not
// started) opens the day; a ticked one, its tick.
export async function entryEditor(key) {
  let entry;
  try {
    entry = await get(scoped(`/entries/${key}`));
  } catch (err) {
    const day = key.match(/\d{4}-\d{2}-\d{2}$/u)?.[0];
    if (err.status !== 404 || !day) throw err;
    location.replace(href.day(day));
    return null;
  }
  if (entry.key !== key) {
    location.replace(href.entry(entry.key));
    return null;
  }
  return entryForm(entry);
}

// An entry's editor. A due day's Save changes the series' amount (every
// un-ticked day follows) or, out of Planned, ticks it; Delete skips the
// day. "Repeat daily" on starts a series from the later of its day and
// today (past days stay clean); off stops it, ticked days keep their
// entries.
async function entryForm(entry) {
  const due = entry.kind === "due";
  const imported = entry.kind === "imported";
  const [food, targets] = await Promise.all([
    entry.food_id && !imported ? get(`/foods/${entry.food_id}`) : null,
    // Only what 100 kcal gives needs them: none, and it isn't shown.
    get(scoped("/targets")).catch(() => null),
  ]);
  const back = href.day(entry.day);
  const here = href.entry(entry.key);
  const action = food
    ? [
        await favoriteStar(food),
        editLink(
          href.food(food, here),
          food.kind === "recipe" ? "recipe" : "food",
        ),
      ]
    : null;
  // An imported row's import group: its rows and total, removed together.
  const items = imported
    ? (await get(scoped(`/day/${entry.day}`))).groups
        .flatMap((g) => g.entries)
        .filter((e) => e.src_group === entry.src_group).length
    : 0;
  const group = choice({
    name: "group",
    label: "Group",
    options: [...new Set([...groups(), entry.group])].map((g) => [g, g]),
    value: entry.group,
    onChange: (g) => untimedIn(g),
  });
  const sub = contextLine(
    entry.day,
    null,
    entry.source
      ? `From ${SOURCES[food?.kind === "recipe" ? "recipe" : entry.source]}`
      : null,
  );
  // The food's view (`amountView`) at this amount; without a food (gone,
  // or imported history) only its amount as logged.
  const view = food
    ? amountView({
        food,
        start: entry,
        time: entry.time ?? "",
        series: entry.repeat,
        sub,
        column: due ? "Each day" : "This entry",
        here,
        targets,
        fields: [field("Group", group)],
      })
    : null;
  const amount = view?.amount ?? null;
  const time = imported
    ? null
    : (view?.time ?? timeField({ name: "time", value: entry.time ?? "" }));
  // Planned has no time eaten: its row shows once the group is Eaten.
  const timeRow = view?.timeRow ?? (time ? field("Time eaten", time) : null);
  const untimedIn = (g) => {
    if (timeRow) timeRow.hidden = g === PLANNED;
  };
  untimedIn(entry.group);
  const repeat = imported
    ? null
    : (view?.repeat ??
      h("input", {
        type: "checkbox",
        name: "repeat",
        checked: Boolean(entry.repeat),
      }));
  const dueAmount = due && JSON.stringify(amount.body());
  // Moved to Eaten today without a time, it takes now.
  const timeOnSave = () =>
    eatenTime(
      entry.day,
      entry.group === EATEN ? null : group.value,
      time.value,
    );
  // What Save sends for the switch: nothing unless it changed.
  const repeatBody = () =>
    repeat.checked === Boolean(entry.repeat)
      ? {}
      : { repeat: repeat.checked ? repeatFrom(entry.day) : null };
  // Due: a new amount is the series'; out of Planned, the day's tick. The
  // switch off stops the series (after the tick).
  const saveDue = async () => {
    const path = scoped(`/entries/${entry.key}`);
    const stop = repeat.checked ? {} : { repeat: null };
    const planned = group.value === PLANNED;
    const changed = JSON.stringify(amount.body()) !== dueAmount;
    if (planned || changed) {
      const e = await api("PATCH", path, {
        ...amount.body(),
        ...(planned ? stop : {}),
      });
      if (planned)
        return e.repeat ? `Saved ${e.name}` : `Stopped repeating ${e.name}`;
    }
    const said = await tick(entry, group.value, time.value);
    if (stop.repeat === null) await api("PATCH", path, stop);
    return said;
  };
  const node = editor({
    title: entry.name,
    back,
    body: view
      ? [view.head, view.fields]
      : [
          h("p", { class: "muted" }, sub),
          h("p", {}, entry.amount),
          timeRow,
          field("Group", group),
          repeat
            ? h("label", { class: "check" }, repeat, " Repeat daily")
            : null,
          imported
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
    save: due
      ? saveDue
      : () =>
          api("PATCH", scoped(`/entries/${entry.id}`), {
            group: group.value,
            ...(amount ? amount.body() : {}),
            ...(time ? { time: timeOnSave() } : {}),
            ...(repeat ? repeatBody() : {}),
          }),
    after: () => back,
    saved: due
      ? (said) => said
      : (e) =>
          e.repeat && !entry.repeat
            ? `${e.name} repeats daily from ${pretty(e.repeat.start)}`
            : !e.repeat && entry.repeat
              ? `Stopped repeating ${e.name}`
              : `Saved ${e.name}`,
    secondary:
      imported || due
        ? []
        : [
            h(
              "a",
              { class: "button", href: href.select(entry.day, entry.id) },
              "Log again",
            ),
          ],
    remove: due
      ? {
          ask: `Delete ${entry.name} from ${pretty(entry.day)}?`,
          detail: "Skips it this day only: it stays in Planned on the others.",
          run: () => skip(entry),
          after: back,
          done: (said) => said,
        }
      : imported
        ? items && importedRemoval(entry.day, entry.src_group, items, back)
        : {
            ask: `Delete ${entry.name}?`,
            detail: `${entryAmount(entry)} on ${pretty(entry.day)}`,
            run: () => api("DELETE", scoped(`/entries/${entry.id}`)),
            after: back,
            done: `Deleted ${entry.name}`,
          },
    aside: view?.tail,
    action,
  }).node;
  node.classList.add("amount-view");
  return node;
}
