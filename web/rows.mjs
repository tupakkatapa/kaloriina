// List rows, each built here once: a list's result row, a menu row, a row
// with an action beside it, a key/value list, a diary entry, a Log card
// row, a device workout waiting for Add or Dismiss, an activity done, an
// exercise, a food (with its search and ☆), a tracker's count, and a log
// screen's context line. Below the screens, so screens import them without
// importing each other.

import { keptHere } from "./actions.mjs";
import { distanceOf } from "./activities.mjs";
import { amountText, weightText } from "./amount.mjs";
import {
  activityType,
  api,
  currentProfile,
  get,
  isQueued,
  meta,
  profileId,
  scoped,
  stored,
  weightKg,
} from "./api.mjs";
import { clockAt, clockOf, pretty, today } from "./dates.mjs";
import { activeEnergyText, bmrOf } from "./energy-text.mjs";
import { activeOf } from "./expenditure.mjs";
import { isNil, lower, NBSP, plural, qty } from "./format.mjs";
import {
  counted,
  habitAmountText,
  habitDayPath,
  waterText,
} from "./habits.mjs";
import { weightGuessed } from "./health.mjs";
import { href } from "./nav.mjs";
import { kcal, per100Basis, PLANNED } from "./nutrients.mjs";
import { labelChips } from "./nutrition-panel.mjs";
import { latest, waiting } from "./outbox.mjs";
import {
  busy,
  CHEVRON_R,
  confirmDialog,
  field,
  fill,
  formDialog,
  h,
  icon,
  MINUS,
  notify,
  num,
  numberOrNull,
  PLUS,
  STAR,
  tickButton,
} from "./ui.mjs";
import { distanceText } from "./units.mjs";
import { clock, MEASURE_LABEL } from "./workouts.mjs";

// A row's main control: a link with `href`, a button with `onclick`, else
// plain; its `name`, then `detail` (text, or a node of its own) beside
// it or under it, then `extra` (chips). `cls` adds to its class (`result`
// or `menu-row`); other `attrs` go on it.
function rowMain(
  base,
  { href: to, onclick, name, detail, extra, cls, ...attrs },
) {
  return h(
    to ? "a" : onclick ? "button" : "div",
    {
      class: cls ? `${base} ${cls}` : base,
      href: to,
      type: onclick ? "button" : null,
      onclick,
      ...attrs,
    },
    h("span", { class: "name" }, name),
    isNil(detail) || detail instanceof Node
      ? detail
      : h("span", { class: "muted" }, detail),
    extra,
    // A menu row that leads has its chevron: drawn, not read.
    base === "menu-row" && (to || onclick) ? chevron() : null,
  );
}

const chevron = () => {
  const svg = icon(CHEVRON_R);
  svg.classList.add("chevron");
  return svg;
};

// A list's row control (`li > .result`): name left, details right or
// under it; `resultRow` puts it in its item, with `action` (a star, Start)
// beside it.
export const result = (opts) => rowMain("result", opts);
export const resultRow = ({ action, ...opts }) =>
  action ? actionRow(result(opts), action) : h("li", {}, result(opts));

// A menu's row: title over detail, a chevron when it leads somewhere;
// with `action` (Start) beside it.
export const menuRow = ({ action, ...opts }) =>
  action
    ? actionRow(rowMain("menu-row", opts), action)
    : h("li", {}, rowMain("menu-row", opts));

// A row whose main control takes the space, `actions` keeping theirs.
export const actionRow = (main, ...actions) =>
  h("li", { class: "row-with-action" }, main, actions);

// A key/value list (`ul.days`): each pair a line, its key left and value
// right; text is wrapped, a node (a link) stays as it is. `cls` adds to
// the list's class, `label` names it.
export const kvList = (pairs, { cls, label } = {}) =>
  h(
    "ul",
    { class: cls ? `days ${cls}` : "days", "aria-label": label },
    pairs.map((pair) =>
      h(
        "li",
        {},
        pair.map((x) => (x instanceof Node ? x : h("span", {}, x))),
      ),
    ),
  );

// An entry's amount as this device writes numbers: "2 × Slice (40 g)",
// "150 g"; one of the water food (`waterId`) in ml or L, as the Water
// habit reads ("330 ml"). Imported history keeps its export's text.
export function entryAmount(e, waterId = null) {
  if (e.kind === "imported" || isNil(e.grams)) return e.amount;
  const weight =
    e.food_id === waterId
      ? waterText(meta.habits, e.grams)
      : weightText(e.grams, e.weight_estimated, 1, e.by_volume);
  return amountText(e, weight);
}

// An entry's quiet line under it, or null.
const noteLine = (note) =>
  note ? h("span", { class: "entry-note" }, note) : null;

// A diary entry (`li.entry`): its name; its time, "Daily" when it repeats,
// its amount and where imported history came from; its energy. It opens
// its editor at its `key` (a due day's, which has no id, too); in Planned,
// `onTick` puts its ✓ at the right. `pick` ({picked, changed}) makes it a
// checkbox while selecting: imported history has no values of its own, so
// can't be copied. `pending` (a write waiting to send: its label as
// `name`, its group, and this state) makes it a plain row. `note`: a quiet
// line under it (a supplement eaten with no meal with fat near it).
export function entryRow(
  e,
  { waterId = null, onTick = null, pick = null, pending = null, note } = {},
) {
  const imported = e.kind === "imported";
  const detail = pending
    ? [e.group, pending]
    : [
        e.time && clockOf(e.time),
        e.repeat ? "Daily" : null,
        pick && imported ? "History can't be copied" : entryAmount(e, waterId),
        imported && !pick ? "From Cronometer" : null,
      ];
  const parts = [
    h("span", { class: "name" }, e.name),
    h("span", { class: "muted" }, detail.filter(Boolean).join(" · ")),
    pending
      ? null
      : h("span", { class: "kcal" }, imported ? "" : kcal(e.nutrients?.energy)),
    noteLine(note),
  ];
  if (pick)
    return h(
      "li",
      { class: "entry" },
      h(
        "label",
        { class: "entry-main check" },
        h("input", {
          type: "checkbox",
          checked: pick.picked.has(e.id),
          disabled: imported,
          "aria-label": e.name,
          onchange: (ev) => {
            if (ev.target.checked) pick.picked.add(e.id);
            else pick.picked.delete(e.id);
            pick.changed();
          },
        }),
        parts,
      ),
    );
  return h(
    "li",
    { class: "entry" },
    pending
      ? h("div", { class: "entry-main" }, parts)
      : h("a", { class: "entry-main", href: href.entry(e.key) }, parts),
    onTick && e.group === PLANNED
      ? tickButton(`Mark ${e.name} eaten`, onTick)
      : null,
  );
}

// A Log card row: what kind it is, the thing itself, then what can be done
// to it (in the card's right column).
export function logRow(kind, main, ...actions) {
  const shown = actions.flat().filter(Boolean);
  return h(
    "li",
    { class: "log-row" },
    h("span", { class: "kind" }, kind),
    main,
    shown.length > 0 ? h("span", { class: "actions" }, shown) : null,
  );
}

// "Running · 07:00 · 30 min · 8.2 km": a device workout waiting (ask mode, or
// one the device detected by itself), with Add (it becomes an activity done)
// and Dismiss (it never comes back). Both are safe to repeat, so they queue
// offline. `withDay`: where days mix, the row is headed by its day, not
// "Waiting" (the Diary's Activity card), and the buttons name it. `after` shows
// the result.
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
    withDay ? pretty(p.day) : "Waiting",
    result({
      name: p.name,
      detail: [start, qty(p.minutes, "min", 0), distanceText(p.distance_m)]
        .filter(Boolean)
        .join(" · "),
    }),
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

// The weight an activity's energy is estimated with: the weigh-in in
// effect on its day, as the server gives it, so history never rewrites
// itself; one not yet sent from here has none, so the latest stands in.
// Null without any weigh-in: no estimate.
export const weightOf = (s) => ("weight_kg" in s ? s.weight_kg : weightKg());

// Today's resting energy as served (`/device-days` `resting`: Health
// Connect's, carried), [{day, kcal, origin}]; a screen that shows an
// activity not sent yet or a workout's line loads it (`loadResting`).
// None offline: Mifflin–St Jeor stands in.
let resting = [];
export async function loadResting() {
  const day = today();
  resting = await get(scoped(`/device-days?from=${day}&to=${day}`))
    .then((r) => r.resting)
    .catch(() => []);
}

// Whose an activity's energy is (expenditure.mjs activeOf's context): the
// profile, its latest weigh-in for an activity not sent yet, and today's
// resting energy as served.
export const energyContext = () => {
  const kg = weightKg();
  return {
    person: currentProfile() ?? {},
    weights: isNil(kg) ? [] : [{ day: today(), kg }],
    resting,
  };
};

// Who a workout's energy is of, as `workoutLine` reads it: the latest
// weigh-in and today's resting energy.
export const workoutEnergy = () => ({
  kg: weightKg(),
  bmr: bmrOf(energyContext())(today())?.kcal ?? null,
});

// What an activity burned beyond resting as read (energy-text.mjs
// activeEnergyText of expenditure.mjs activeOf): one reading wherever an
// activity's energy shows. `ctx` whose energy it is: energyContext, or a
// screen's own (the Diary's day, series.mjs dayContext).
export const activeEnergyLine = (s, ctx = energyContext()) =>
  activeEnergyText(activeOf(s, ctx));

// Where a synced or imported activity came from: "Health Connect",
// "Google Health" (an import's `gh-…` record, or a hand log matched to
// one); null for one logged here alone.
export const sourceText = (s) =>
  s.source === "import" || s.source_key?.startsWith("gh-")
    ? `Google${NBSP}Health`
    : s.source_key
      ? `Health${NBSP}Connect`
      : null;

// "46 min · 8.2 km · active 410 kcal": an activity in a row, its time, its
// distance (a device's leftover metres aside: activities.mjs
// MIN_DISTANCE_M) and its active energy (activeEnergyLine's, its total
// left to the view when the active part is known). Pace, heart rate and
// where it came from are its view's. `ctx` as activeEnergyLine's.
export function activityBrief(s, ctx = energyContext()) {
  const metres = distanceOf(s);
  const energy = activeOf(s, ctx);
  return [
    clock(s.minutes * 60),
    metres === null ? null : distanceText(metres),
    activeEnergyText(
      isNil(energy.active) ? energy : { ...energy, total: null },
    ),
  ]
    .filter(Boolean)
    .join(" · ");
}

// An activity done as a list row: its name (its type when it has none)
// over its date (no weekday: the line fits a phone) and `activityBrief`;
// every row the same shape, the type on its view. `byDay` (a workout's
// History, the page named for it) titles it by its day instead, over
// `activityBrief` alone. It opens its view, whose Back leads to `back`.
export const activityRow = (s, back, { byDay = false } = {}) =>
  menuRow({
    href: href.activityView(s.id, back),
    name: byDay
      ? pretty(s.day)
      : s.name || (activityType(s.type)?.label ?? "Activity"),
    detail: byDay
      ? activityBrief(s)
      : [pretty(s.day, false), activityBrief(s)].join(" · "),
  });

// How many of the latest a list of recent activities shows.
export const RECENT = 5;

// A list of the latest activities (each by `row`), read with RECENT + 1: its
// first RECENT, and, when there are more, a last row to all of them at `all`.
export const recentRows = (list, row, all) => [
  ...list.slice(0, RECENT).map((x) => row(x)),
  list.length > RECENT ? menuRow({ href: all, name: "All activities" }) : null,
];

// An exercise in a list, shaped like a food row: name left; how it's
// measured, its muscle group and equipment, its variants right.
export function exerciseRow({ root, hit }, onPick, lib) {
  const e = hit ?? root;
  const more = (lib?.variants.get(root.id) ?? []).length;
  return resultRow({
    onclick: () => onPick({ root, hit }),
    name: e.name,
    detail: [
      MEASURE_LABEL[e.measure],
      e.group,
      (e.equipment ?? []).join(", "),
      e === root && more ? plural(more, "variant") : null,
      e.source === "custom" ? "yours" : null,
    ]
      .filter(Boolean)
      .join(" · "),
  });
}

// The line under a log screen's or entry's title, one format everywhere:
// "Today · Eaten · Fazer" (day, group, then brand or source).
export const contextLine = (day, group, ...rest) =>
  [day === today() ? "Today" : pretty(day), group, ...rest]
    .filter(Boolean)
    .join(" · ");

// Ingredient search, for recipe and meal editors: the same ranking.
export const searchFoods = (q) =>
  get(scoped(`/foods?${new URLSearchParams({ q })}`));

// ☆/★ toggle of a food's favourite state; `onChange(starred)` runs after it
// flips.
// A food's ☆ in its editor's header, as on its log screen.
export async function favoriteStar(food) {
  const favorites = await get(scoped("/foods/favorites"));
  return starButton(
    food,
    favorites.some((f) => f.id === food.id),
    `Favourite ${food.name}`,
  );
}

export function starButton(food, starred, label, onChange = () => {}) {
  const button = h("button", {
    type: "button",
    class: "icon star",
    "aria-label": label,
    onclick: busy(async () => {
      if (starred) await api("DELETE", scoped(`/foods/favorites/${food.id}`));
      else await api("POST", scoped("/foods/favorites"), { food_id: food.id });
      starred = !starred;
      paint();
      onChange(starred);
    }),
  });
  const paint = () => {
    button.setAttribute("aria-pressed", String(starred));
    button.replaceChildren(icon(STAR, starred));
  };
  paint();
  return button;
}

// "240 kcal per 100 g" (per 100 ml for a drink, `per100Basis`): "≈" when
// its weight is a guess (its values are exact per its serving), "≥" when a
// recipe's energy is partly unknown.
const energyPer100 = (f) => {
  const e = f.per100.energy;
  const mark = isNil(e)
    ? ""
    : weightGuessed(f)
      ? `≈${NBSP}`
      : isNil(f.known?.energy)
        ? ""
        : `≥${NBSP}`;
  return `${mark}${kcal(e)} ${lower(per100Basis(f))}`;
};

// A food in a list: name; brand, recipe, energy per 100 g. `star`
// ({starred, onChange}) adds a favourite toggle.
export function foodRow(f, onPick, star = null) {
  return resultRow({
    onclick: () => onPick(f),
    name: f.name,
    detail: [f.brand, f.kind === "recipe" ? "recipe" : null, energyPer100(f)]
      .filter(Boolean)
      .join(" · "),
    extra: labelChips(f),
    action: star
      ? starButton(f, star.starred, `Favourite ${f.name}`, star.onChange)
      : null,
  });
}

// Set `habit`'s count on `day` (0 removes it); queued when offline.
async function setCount(habit, day, amount) {
  const path = habitDayPath(habit.id, day);
  if (amount > 0)
    await api(
      "PUT",
      path,
      { amount },
      { queue: true, label: `${habit.name} ${habitAmountText(habit, amount)}` },
    );
  else
    await api("DELETE", path, undefined, {
      queue: true,
      label: `Remove ${habit.name}`,
    });
}

// One tracker on the day: its name, the count (a dialog for any amount),
// then − and + in a right column of their own.
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
          class: "count",
          "data-part": "count",
          "aria-label": `${habit.name}: ${habitAmountText(habit, amount)}. Set the amount`,
          onclick: busy(ask),
        },
        // A plain space: in a narrow row the unit wraps under the number.
        habitAmountText(habit, amount).replace(NBSP, " "),
      ),
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
        icon(MINUS),
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
        icon(PLUS),
      ),
      waitNote && latest(habitDayPath(habit.id, day))
        ? h(
            "small",
            {
              class: "muted waiting-note",
              "data-path": habitDayPath(habit.id, day),
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
