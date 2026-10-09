// Habits: the trackers' rows the diary's Log card and sheet count with
// (and the day's "From food" line of built-ins), the Summary's Habits
// calendars, and Profile → Habits, where trackers are added, edited,
// archived and deleted and the food "+ Water" logs is picked.

import { api, get, meta, profileId, scoped, stored } from "../api.mjs";
import { pretty, shift, today } from "../dates.mjs";
import { tileThrough } from "../insights.mjs";
import { calendarView } from "../calendar.mjs";
import { legendWords, quartiles, step } from "../calendar-grid.mjs";
import {
  amountText,
  builtinHabit,
  trackerHabit,
  limitOf,
  loggedDays,
  reachedStep,
  rowsOf,
  stats,
  targetOf,
} from "../habits.mjs";
import { href, keptHere } from "../nav.mjs";
import { latest, waiting } from "../outbox.mjs";
import { NBSP, fmt, noun } from "../nutrients.mjs";
import {
  busy,
  choice,
  editor,
  errorBox,
  field,
  fill,
  formDialog,
  h,
  num,
  notify,
  numberOrNull,
  picker,
  tiles,
  titleBar,
} from "../ui.mjs";
import { foodRow, searchFoods } from "./finder.mjs";

const dayPath = (id, day) => scoped(`/habits/${id}/days/${day}`);

// ------------------------------------------------------- diary Log rows

// What the day's tracker count is: the last write still waiting on this
// device, else the server's.
export function counted(id, day, saved) {
  const last = latest(dayPath(id, day));
  if (!last) return saved;
  return last.method === "DELETE" ? 0 : last.body.amount;
}

// Set `habit`'s count on `day` (0 removes it); queued when offline.
async function setCount(habit, day, amount) {
  const path = dayPath(habit.id, day);
  if (amount > 0)
    await api(
      "PUT",
      path,
      { amount },
      { queue: true, label: `${habit.name} ${amountText(habit, amount)}` },
    );
  else
    await api("DELETE", path, undefined, {
      queue: true,
      label: `Remove ${habit.name}`,
    });
}

// One tracker on the day: − / the count (a dialog for any amount) / +.
// `onCount(n)` hears every count set here, kept on this device or not;
// `waitNote` shows "Waiting to send" under the row while its count waits.
export function trackerRow(
  habit,
  day,
  saved,
  { onCount = () => {}, waitNote = false } = {},
) {
  let amount = counted(habit.id, day, saved);
  const max = meta.limits.habit_amount;
  const node = h("li", { class: "habit-row" });
  // Kept on this device, the day says so once the row shows the count.
  const write = async (next, part) => {
    const done = await stored(() => setCount(habit, day, next));
    amount = next;
    paint(part);
    onCount(next);
    if (done !== true) keptHere(done.queued, day);
  };
  const ask = async () => {
    const value = num({
      name: "amount",
      value: amount || "",
      max,
    });
    let sent = true;
    const done = await formDialog(`${habit.name} on ${pretty(day)}`, {
      body: field(`Amount (${habit.unit})`, value, {
        hint: "0 or empty removes it.",
      }),
      submit: "Set",
      run: async () => {
        const next = numberOrNull(value) ?? 0;
        if (next === amount) return true;
        sent = await stored(() => setCount(habit, day, next));
        amount = next;
        return true;
      },
    });
    if (!done) return;
    paint("count");
    onCount(amount);
    if (sent !== true) keptHere(sent.queued, day);
  };
  // `focus`: the part to hold the keyboard after a repaint (its button was
  // disabled while busy, so focus fell away).
  const paint = (focus = null) => {
    fill(
      node,
      h("span", { class: "name" }, habit.name),
      h(
        "button",
        {
          type: "button",
          class: "icon",
          "data-part": "less",
          "aria-label": `One less ${habit.name}`,
          disabled: !(amount > 0),
          onclick: busy(() => write(Math.max(0, amount - 1), "less")),
        },
        "−",
      ),
      h(
        "button",
        {
          type: "button",
          class: "count",
          "data-part": "count",
          "aria-label": `${habit.name}: ${amountText(habit, amount)}. Set the amount`,
          onclick: busy(ask),
        },
        // A plain space: in a narrow row the unit wraps under the number.
        amountText(habit, amount).replace(NBSP, " "),
      ),
      h(
        "button",
        {
          type: "button",
          class: "icon",
          "data-part": "more",
          "aria-label": `One more ${habit.name}`,
          disabled: amount + 1 > max,
          onclick: busy(() => write(amount + 1, "more")),
        },
        "+",
      ),
      waitNote && latest(dayPath(habit.id, day))
        ? h(
            "small",
            {
              class: "muted waiting-note",
              "data-path": dayPath(habit.id, day),
            },
            "Waiting to send",
          )
        : null,
    );
    // In place: a keyboard stays on the button it pressed (on + once −
    // reaches 0).
    if (focus)
      (
        node.querySelector(`[data-part="${focus}"]:enabled`) ??
        node.querySelector("[data-part=more]")
      ).focus();
  };
  paint();
  return node;
}

// The sheet's "Waiting to send" notes whose count has since gone out.
export function dropSentNotes(root, day) {
  for (const note of root.querySelectorAll(".waiting-note"))
    if (
      !waiting(profileId, day).some(
        (x) => x.path === note.dataset.path && !x.failed,
      )
    )
      note.remove();
}

// "Water 1.2 L · Alcohol 2 drinks · Fruit and vegetables 320 g": the
// built-ins the day's food held (the Day view's `builtins`, stored units),
// in the registry's order; null when none.
export function builtinText(builtins) {
  const parts = meta.habits.flatMap((b) => {
    const amount = builtins.find((x) => x.habit === b.key)?.amount;
    return amount > 0 ? [`${b.name} ${amountText(b, amount * b.factor)}`] : [];
  });
  return parts.length ? parts.join(" · ") : null;
}

// ------------------------------------------------------- Summary section

// The built-ins with the profile's goals (`/targets`), then its active
// trackers (`/habits`), oldest first: every habit in one shape
// (web/habits.mjs).
export const allHabits = (targets, trackers) => [
  ...meta.habits.map((b) => builtinHabit(b, targets)),
  ...trackers
    .filter((x) => !x.archived)
    .toSorted((a, b) => a.id - b.id)
    .map(trackerHabit),
];

// What one habit looks like over the period: its days' amounts (shown
// units), whether each day was logged at all, its goal (a limit or a
// target to reach) and shade bounds, its stats through `end` (the
// Highlights' window) and the calendar's series over them
// (web/calendar.mjs).
function series(habit, { days, from, end }) {
  const logged = loggedDays(days);
  const rows = rowsOf(habit, days);
  const limit = limitOf(habit);
  const goal = targetOf(habit);
  const amounts = new Map(rows.map((r) => [r.day, r.amount]));
  const bounds = habit.bounds ?? quartiles(rows.map((r) => r.amount));
  const of = (day) => amounts.get(day) ?? 0;
  const over = (day) => limit !== null && of(day) > limit;
  return {
    habit,
    limit,
    goal,
    bounds,
    stats: stats(
      rows.filter((r) => r.day <= end),
      { from, to: end, limit, goal },
    ),
    amount: (day) => (of(day) > 0 ? fmt(of(day), 1) : ""),
    step: (day) =>
      goal === null ? step(of(day), bounds) : reachedStep(of(day), goal),
    unlogged: (day) => !logged.has(day),
    over,
    marks: () => null,
    // "Sat, Oct 4: 2 drinks", "…: nothing logged", "…, over".
    label: (day) => {
      const amount = of(day);
      const what = !logged.has(day)
        ? "nothing logged"
        : amount > 0
          ? amountText(habit, amount)
          : "none";
      return `${pretty(day)}: ${what}${over(day) ? ", over" : ""}`;
    },
  };
}

// The shade key under the calendar, in words as well as colour: by the
// goal to reach, else the habit's fixed steps or the period's quartiles, in
// the one legend grammar every calendar shares; with too few amounts for
// quartiles, in words.
function legend(s) {
  const { habit } = s;
  const words =
    s.goal !== null || s.bounds[0] > 0
      ? ["None", ...legendWords(s.bounds, habit.unit, { goal: s.goal })]
      : ["None", "less", "", "", "most this period"];
  return h(
    "div",
    { class: "cal-legend habit-legend muted" },
    h(
      "ul",
      { "aria-label": "Shades" },
      words.map((w, i) =>
        h(
          "li",
          {},
          h("span", { class: `cal-cell shade-${i}`, "aria-hidden": "true" }),
          w,
        ),
      ),
    ),
    h(
      "ul",
      { "aria-label": "Marks" },
      h(
        "li",
        {},
        h("span", { class: "cal-cell none", "aria-hidden": "true" }),
        "nothing logged",
      ),
      s.limit === null
        ? null
        : h(
            "li",
            {},
            h("span", {
              class: "cal-cell shade-0 over",
              "aria-hidden": "true",
            }),
            "over your limit",
          ),
    ),
    habit.note ? h("p", {}, habit.note) : null,
  );
}

const PERIOD = { week: "this week", month: "this month", year: "this year" };

const dayCount = (n, words) => [fmt(n), `${noun(n, "day")} ${words}`];

// The habit's numbers as tiles: a day's habits (water, caffeine…) their
// mean a day, the others a week (a week's view: in total); days at the
// target, days with any, the most in a day and days over the limit. At
// most 4: "days with any" goes first.
function statTiles(s, kind) {
  const { habit } = s;
  const t = s.stats;
  // A built-in's name is a common noun ("No water"); a tracker's is yours.
  if (!t.days)
    return h(
      "p",
      { class: "muted" },
      `No ${habit.builtin ? habit.name.toLowerCase() : habit.name} ${PERIOD[kind]}`,
    );
  const perDay = habit.per === "day";
  const unit = (n) => noun(n, habit.one ?? habit.unit, habit.unit, 1);
  const shown = (n) => (perDay ? amountText(habit, n) : fmt(n, 1));
  const any = dayCount(t.days, "with any");
  const items = [
    perDay ? [amountText(habit, t.mean), "a day"] : null,
    t.reached === null ? null : dayCount(t.reached, "at your target"),
    perDay
      ? null
      : kind === "week"
        ? [fmt(t.total, 1), `${unit(t.total)} in total`]
        : [fmt(t.perWeek, 1), `${unit(t.perWeek)} a week`],
    any,
    [shown(t.peak.amount), `most in a day (${pretty(t.peak.day)})`],
    t.over === null ? null : dayCount(t.over, "over your limit"),
  ].filter(Boolean);
  return tiles(
    habit.name,
    items.length > 4 ? items.filter((x) => x !== any) : items,
  );
}

const HABIT_KEY = "summary-habit";

// The Summary's Habits section around `body`.
const section = (...body) =>
  h(
    "section",
    { class: "finder-section habits-summary" },
    h("h2", {}, "Habits"),
    ...body,
  );

// The Summary's Habits section: one habit at a time, picked from `habits`
// (the pick kept on this device; the first when the saved one is gone),
// its numbers, a calendar of the period and its shade key. A pick repaints
// the habit in place. `days`: the period's `/habits/days`.
export function habitsSection({ habits, days, from, to, kind }) {
  if (!habits.length)
    return section(
      h(
        "p",
        { class: "muted" },
        `Nothing ${PERIOD[kind]}: what you eat fills the built-ins; count your own from the Diary's + Log.`,
      ),
    );
  const saved = localStorage.getItem(HABIT_KEY);
  let picked = habits.some((x) => x.id === saved) ? saved : habits[0].id;
  // Today is still being logged: the numbers end yesterday.
  const end = tileThrough(from, to, shift(today(), -1));
  const body = h("div");
  const paint = () => {
    const habit = habits.find((x) => x.id === picked);
    const s = series(habit, { days, from, end });
    body.className = `stack habit habit-${habit.id}`;
    fill(
      body,
      statTiles(s, kind),
      calendarView({
        kind,
        from,
        caption: `${habit.name} by day`,
        series: s,
        monthLink: (month) => href.summary("month", `${month}-01`, "habits"),
        className: "habit-cal",
      }),
      legend(s),
    );
  };
  paint();
  return section(
    choice({
      name: "habit",
      label: "Habit",
      look: "switch",
      options: habits.map((x) => [x.id, x.name]),
      value: picked,
      onChange: (id) => {
        picked = id;
        localStorage.setItem(HABIT_KEY, id);
        paint();
      },
    }),
    body,
  );
}

// -------------------------------------------------------- Profile → Habits

const DIR = { at_least: "at least", at_most: "at most" };

// "at most 5 a day", or null without a goal.
const goalText = (x) =>
  x.goal_value === null
    ? null
    : `${DIR[x.goal_dir]} ${fmt(x.goal_value, 1)} a day`;

const habitRow = (x) =>
  h(
    "li",
    {},
    h(
      "a",
      { class: "menu-row", href: href.habit(x.id) },
      h("span", { class: "name" }, x.name),
      h(
        "span",
        { class: "muted" },
        [x.unit, goalText(x), x.archived ? "Archived" : null]
          .filter(Boolean)
          .join(" · "),
      ),
    ),
  );

// Profile → Habits: the trackers of your own, active then archived, and
// where every habit's goal lives.
export async function habitsScreen() {
  const [list, water] = await Promise.all([
    get(scoped("/habits")),
    get(scoped("/water-food")),
  ]);
  const active = list.filter((x) => !x.archived);
  const archived = list.filter((x) => x.archived);
  const full = list.length >= meta.limits.habits;
  return h(
    "section",
    {},
    titleBar("Habits", href.profile()),
    h(
      "p",
      { class: "muted" },
      `Built in, from what you eat: ${meta.habits.map((b) => b.name).join(", ")}. Count anything else yourself: add it here, then count it on the diary day. Every habit's goal is on `,
      h("a", { href: href.targets() }, "Targets"),
      ".",
    ),
    h(
      "ul",
      { class: "menu card" },
      active.map(habitRow),
      full
        ? h(
            "li",
            { class: "muted empty" },
            `At most ${meta.limits.habits} habits: delete one to add another.`,
          )
        : h(
            "li",
            {},
            h(
              "a",
              { class: "menu-row", href: href.habit("new") },
              h("span", { class: "name" }, "New habit"),
              h("span", { class: "muted" }, "A name and what you count"),
            ),
          ),
    ),
    archived.length
      ? [
          h("h2", {}, "Archived"),
          h("ul", { class: "menu card" }, archived.map(habitRow)),
        ]
      : null,
    waterFoodSection(water),
  );
}

// "Vesi · Fineli", "Water (default)", or that there is none.
const waterFoodName = (w) =>
  w.food
    ? `${[w.food.name, w.food.brand].filter(Boolean).join(" · ")}${w.chosen ? "" : " (default)"}`
    : "None yet: pick one below.";

// The food "+ Water" logs for this profile, and a search to pick another
// (or go back to the default).
function waterFoodSection(water) {
  const current = h("p", { class: "water-food-current" });
  const reset = h("div", {});
  const status = h("div", { class: "status", role: "status" });
  const choose = async (foodId) => {
    try {
      paint(await api("PUT", scoped("/water-food"), { food_id: foodId }));
      notify(`“+ Water” logs ${waterFoodName(water)}`);
    } catch (err) {
      fill(status, errorBox(err));
    }
  };
  const paint = (w) => {
    water = w;
    current.textContent = waterFoodName(w);
    fill(status);
    fill(
      reset,
      w.chosen
        ? h(
            "button",
            { type: "button", onclick: busy(() => choose(null)) },
            "Use the default",
          )
        : null,
    );
  };
  paint(water);
  return h(
    "section",
    { class: "finder-section water-food" },
    h("h2", {}, "Water food"),
    h(
      "p",
      { class: "muted" },
      "“+ Water” on the Add screens of Eaten and Planned logs this food: as many grams as ml.",
    ),
    current,
    reset,
    picker({
      placeholder: "Search another water food",
      label: "Water food",
      search: searchFoods,
      row: foodRow,
      onPick: (f) => choose(f.id),
    }),
    status,
  );
}

// One tracker's editor: name, unit and whether it's archived; its goal
// shows here and is set on Targets with every other goal. Deleting it takes
// its logged days.
export async function habitEditor(id) {
  const isNew = id === "new";
  const [list, logged] = await Promise.all([
    get(scoped("/habits")),
    isNew ? [] : get(scoped("/habits/days")),
  ]);
  const x = isNew
    ? { name: "", unit: "", goal_value: null, archived: false }
    : list.find((t) => t.id === Number(id));
  if (!x)
    throw Object.assign(new Error("Not found"), {
      code: "not_found",
      resource: "habit",
    });
  const days = logged.filter((d) => d.habit === String(x.id)).length;
  const name = h("input", {
    name: "name",
    value: x.name,
    required: true,
    maxLength: meta.limits.label,
    placeholder: "Snus",
  });
  const unit = h("input", {
    name: "unit",
    value: x.unit,
    required: true,
    maxLength: meta.limits.unit,
    placeholder: "pouches",
  });
  const status = choice({
    name: "archived",
    label: "Status",
    options: [
      ["", "Active"],
      ["1", "Archived"],
    ],
    value: x.archived ? "1" : "",
  });
  const goal = h(
    "p",
    { class: "habit-goal" },
    `Goal: ${goalText(x) ?? "none"} · `,
    h(
      "a",
      { href: href.targets() },
      isNew ? "Set it on Targets once saved" : "Change on Targets",
    ),
  );
  const shell = editor({
    title: isNew ? "New habit" : x.name,
    back: href.habits(),
    body: [
      field("Name", name),
      field("Unit", unit, { hint: "What you count: pouches, cups, times." }),
      goal,
      isNew
        ? null
        : field("Status", status, {
            hint: "Archived habits leave the diary and the Summary; their days stay.",
          }),
    ],
    save: () => {
      const body = {
        name: name.value,
        unit: unit.value,
        archived: status.value === "1",
      };
      // The goal is Targets' to change: sent back as it was.
      return isNew
        ? api("POST", scoped("/habits"), body)
        : api("PUT", scoped(`/habits/${x.id}`), {
            ...body,
            goal_value: x.goal_value,
            goal_dir: x.goal_dir,
            rev: x.rev,
          });
    },
    after: (saved) => (isNew ? href.habits() : href.habit(saved.id)),
    remove: isNew
      ? null
      : {
          ask: `Delete ${x.name}?`,
          detail: `${
            days === 1
              ? "Its 1 logged day goes with it."
              : days
                ? `Its ${fmt(days)} logged days go with it.`
                : "Nothing is logged for it."
          } This can't be undone.`,
          run: () => api("DELETE", scoped(`/habits/${x.id}`)),
          after: href.habits(),
          done: `Deleted ${x.name}`,
        },
  });
  return shell.node;
}
