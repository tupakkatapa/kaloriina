// Habits: the Summary's Habits calendars, and Profile → Habits, where
// trackers are added, edited, archived and deleted and the food logged as
// water is picked. The Log card's tracker rows are web/rows.mjs'.

import { saveOnce } from "../actions.mjs";
import { api, get, meta, scoped } from "../api.mjs";
import { calendarView } from "../calendar.mjs";
import { legendWords, quartiles, step } from "../calendar-grid.mjs";
import { pretty, shift, tileThrough, today } from "../dates.mjs";
import { fmt, NBSP, noun, plural } from "../format.mjs";
import {
  cellText,
  countText,
  floorsOf,
  goalWords,
  habitAmountText,
  limitOf,
  loggedDays,
  meanTile,
  reachedStep,
  rowsOf,
  stats,
  targetOf,
} from "../habits.mjs";
import { href } from "../nav.mjs";
import { foodRow, menuRow, searchFoods } from "../rows.mjs";
import {
  busy,
  choice,
  editor,
  empty,
  errorBox,
  field,
  fill,
  h,
  nameInput,
  notify,
  picker,
  titleBar,
} from "../ui.mjs";
import { tiles } from "../tiles.mjs";

// ----------------------------------------------------- Summary section

// What one habit looks like over the period: its days' amounts (shown
// units), whether each day was logged (a built-in's: food logged that day;
// a tracker's: anything logged) and, a built-in's, whether its amount is
// known (ADR 0030: an unknown one is a floor), its goal (a limit or a
// target to reach) and shade bounds, its stats through `end` (the
// Highlights' window; its averages over the known days, its totals at
// least the floors) and the calendar's series over them (web/calendar.mjs).
function series(habit, { days, from, end }) {
  const food = habit.builtin
    ? loggedDays(days, new Set(meta.habits.map((b) => b.key)))
    : loggedDays(days);
  const floors = habit.builtin ? floorsOf(habit, days) : [];
  const unknown = new Map(floors.map((r) => [r.day, r.amount]));
  const logged = new Set([...food].filter((d) => !unknown.has(d)));
  const inside = (r) => r.day >= from && r.day <= end;
  const rows = rowsOf(habit, days);
  const limit = limitOf(habit);
  const goal = targetOf(habit);
  // A day is judged by its own goal (hydration's grows with activity).
  const goalOn = goal === null ? null : habit.goalOn;
  const amounts = new Map(rows.map((r) => [r.day, r.amount]));
  const bounds = habit.bounds ?? quartiles(rows.map((r) => r.amount));
  const of = (day) => amounts.get(day) ?? 0;
  // An unknown day's floor over the limit is over all the same.
  const over = (day) => limit !== null && (unknown.get(day) ?? of(day)) > limit;
  return {
    habit,
    limit,
    goal,
    // Some day's goal isn't the base one (hydration's grows with activity):
    // the legend then reads against each day's.
    goalVaries: goalOn !== null && rows.some((r) => goalOn(r.day) !== goal),
    bounds,
    stats: stats(
      rows.filter((r) => r.day <= end),
      {
        limit,
        goal: goalOn,
        logged: [...logged].filter((day) => inside({ day })).length,
        floors: floors.filter((x) => inside(x)),
      },
    ),
    // Days with food logged: what an average over the known days is of.
    food: [...food].filter((day) => inside({ day })).length,
    unknown: unknown.size > 0,
    // An unknown day's floor, as its label says it: "≥211".
    amount: (day) =>
      unknown.get(day) > 0
        ? `≥${cellText(habit, unknown.get(day))}`
        : of(day) > 0
          ? cellText(habit, of(day))
          : "",
    step: (day) =>
      goal === null ? step(of(day), bounds) : reachedStep(of(day), goalOn(day)),
    unlogged: (day) => !logged.has(day),
    over,
    marks: () => null,
    // "Sat, Oct 4: 2 drinks", "…: nothing logged", "…: ≥ 13 drinks, not
    // all known", "…, over".
    label: (day) => {
      const amount = of(day);
      const what = unknown.has(day)
        ? `≥${NBSP}${habitAmountText(habit, unknown.get(day))}, not all known`
        : logged.has(day)
          ? amount > 0
            ? habitAmountText(habit, amount)
            : "none"
          : "nothing logged";
      return `${pretty(day)}: ${what}${over(day) ? ", over" : ""}`;
    },
  };
}

// The shade key under the calendar, in words as well as colour: by the goal to
// reach (each day's own when it varies), else the habit's fixed steps or the
// period's quartiles, in the one legend grammar every calendar shares; with too
// few amounts for quartiles, in words.
function legend(s) {
  const { habit } = s;
  const words = goalWords(habit)
    ? ["0", ...goalWords(habit)]
    : s.goal !== null || s.bounds[0] > 0
      ? ["0", ...legendWords(s.bounds, habit.unit, { goal: s.goal })]
      : ["0", "less", "", "", "most this period"];
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
        s.unknown ? "Nothing logged, or not known" : "Nothing logged",
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

// While any day isn't known, how a count of days reads: a floor.
const partlyWords = (partial) =>
  partial ? " At least: on some days it isn't known." : "";

// The habit's numbers as tiles: a day's habits (water, caffeine…) their
// mean a day, the others a week (a week's view: in total), each over the
// days it is known and saying how many (a built-in's: days with food
// logged, then how many of them it's known on); days at the target, days
// with any, the most in a day and days over the limit (a day's), each
// "≥" while any day isn't known. At most 4: "days with any" goes first.
function statTiles(s, kind) {
  const { habit, limit } = s;
  const t = s.stats;
  // A built-in's name is a common noun ("No water"); a tracker's is yours.
  if (!t.days)
    return h(
      "p",
      { class: "muted" },
      `No ${habit.builtin ? habit.name.toLowerCase() : habit.name} ${PERIOD[kind]}${t.partial ? `, known on ${fmt(t.logged)} of ${plural(s.food, "day")} with food logged` : ""}`,
    );
  const perDay = habit.per === "day";
  const unit = (n) => noun(n, habit.one ?? habit.unit, habit.unit, 1);
  // Over unknown days a count or total is a floor.
  const ge = (text) => (t.partial ? `≥${NBSP}${text}` : text);
  const count = (n, words, long) => ({
    value: countText(n, t.partial),
    short: `${noun(n, "day")} ${words}`,
    long: `${long}${partlyWords(t.partial)}`,
  });
  const any = count(
    t.days,
    "with any",
    `Days ${PERIOD[kind]} with any ${habit.name.toLowerCase()} logged.`,
  );
  const items = [
    perDay ? meanTile(habit, t, s.food) : null,
    t.reached === null
      ? null
      : count(
          t.reached,
          "at your target",
          `Days ${PERIOD[kind]} that reached your target.`,
        ),
    perDay
      ? null
      : kind === "week"
        ? {
            value: ge(fmt(t.total, 1)),
            short: `${unit(t.total)} in total`,
            long: `Everything logged this week, added up.${partlyWords(t.partial)}`,
          }
        : meanTile(habit, t, s.food),
    any,
    {
      value: ge(habitAmountText(habit, t.peak.amount)),
      short: `most in a day (${pretty(t.peak.day)})`,
      long: `Your biggest day ${PERIOD[kind]}, and which day it was.${partlyWords(t.partial)}`,
    },
    t.over === null
      ? null
      : count(
          t.over,
          "over your limit",
          `Days ${PERIOD[kind]} over your daily limit of ${habitAmountText(habit, limit)}.`,
        ),
  ].filter(Boolean);
  return tiles(
    habit.name,
    items.length > 4 ? items.filter((x) => x !== any) : items,
  );
}

const HABIT_KEY = "summary-habit";

// The Summary's Habits section around `body`, its heading for screen
// readers only: the Habits subtab above already names it.
const section = (...body) =>
  h(
    "section",
    { class: "finder-section habits-summary" },
    h("h2", { class: "sr-only" }, "Habits"),
    ...body,
  );

// The Summary's Habits section: one habit at a time, picked from `habits`
// (the pick kept on this device; the first when the saved one is gone),
// its numbers, a calendar of the period and its shade key. A pick repaints
// the habit in place. `days`: the period's `/habits/days`.
export function habitsSection({ habits, days, from, to, kind }) {
  if (habits.length === 0)
    return section(
      h(
        "p",
        { class: "muted" },
        `Nothing logged ${PERIOD[kind]}: what you eat fills the built-ins; count your own from the Diary's Log card.`,
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

// ---------------------------------------------------- Profile → Habits

const DIR = { at_least: "at least", at_most: "at most" };

// "at most 5 a day", or null without a goal.
const goalText = (x) =>
  x.goal_value === null
    ? null
    : `${DIR[x.goal_dir]} ${fmt(x.goal_value, 1)} a day`;

const habitRow = (x) =>
  menuRow({
    href: href.habit(x.id),
    name: x.name,
    detail: [x.unit, goalText(x), x.archived ? "Archived" : null]
      .filter(Boolean)
      .join(" · "),
  });

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
      `Built in, from what you eat: ${meta.habits.map((b) => b.name).join(", ")}. Count anything else yourself: add it here, then count it on its day in the Diary. Every habit's goal is on `,
      h("a", { href: href.targets() }, "Targets"),
      ".",
    ),
    h(
      "ul",
      { class: "menu card" },
      active.map((x) => habitRow(x)),
      full
        ? empty(
            `At most ${meta.limits.habits} habits: delete one to add another.`,
            "li",
          )
        : menuRow({
            href: href.habit("new"),
            name: "New habit",
            detail: "A name and what you count",
          }),
    ),
    archived.length > 0
      ? [
          h("h2", {}, "Archived"),
          h(
            "ul",
            { class: "menu card" },
            archived.map((x) => habitRow(x)),
          ),
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

// The food logged as water for this profile, and a search to pick another
// (or go back to the default).
function waterFoodSection(water) {
  const current = h("p", { class: "water-food-current" });
  const reset = h("div", {});
  const status = h("div", { class: "status", role: "status" });
  const choose = async (foodId) => {
    try {
      paint(await api("PUT", scoped("/water-food"), { food_id: foodId }));
      notify(`Water now logs ${waterFoodName(water)}`);
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
      "Water on the Add screens and Hydration in the Diary's Log sheet log this food: as many grams as ml.",
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
  const name = nameInput({
    max: meta.limits.label,
    value: x.name,
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
  // No read of one habit: the list's.
  const send = saveOnce(
    scoped("/habits"),
    (hid) => scoped(`/habits/${hid}`),
    async (hid) => (await get(scoped("/habits"))).find((t) => t.id === hid),
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
            hint: "Archived habits leave the Diary and the Summary; their days stay.",
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
        ? send(body)
        : send(
            {
              ...body,
              goal_value: x.goal_value,
              goal_dir: x.goal_dir,
              rev: x.rev,
            },
            x.id,
          );
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
