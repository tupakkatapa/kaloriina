// Profile → Targets: each goal by section (energy and macros with their
// share of energy, needed energy, body, activity, sleep, habits, other
// nutrients), Recalculate, and a tracker's goal saved on its habit.

import { STEPS_MORE, stepsSuggestion } from "../activities.mjs";
import { api, get, meta, scoped } from "../api.mjs";
import { pretty, shift, today } from "../dates.mjs";
import { hhmm, minutesOf, ON_SCHEDULE_MIN } from "../device.mjs";
import {
  balanceWhy,
  maintenanceFrom,
  maintenanceText,
} from "../energy-text.mjs";
import { fmt, isNil, NBSP, plural, qty } from "../format.mjs";
import { localBuiltin } from "../habits.mjs";
import { href, route } from "../nav.mjs";
import {
  byCategory,
  energySplit,
  GOAL_HINT,
  GOAL_SIGN,
  kcal,
  KCAL_PER_G,
  KEY_TARGETS,
  nutrient,
  ordered,
  withUnit,
} from "../nutrients.mjs";
import { categoryRow } from "../nutrition-panel.mjs";
import {
  appOf,
  plan as energyPlan,
  estimateKcal,
  fetchRows,
  offered,
} from "../series.mjs";
import {
  goalProblems,
  missing,
  recommendedWith,
  setEnergyTarget,
} from "../targets.mjs";
import {
  busy,
  confirmDialog,
  editor,
  h,
  icon,
  notify,
  num,
  numberOrNull,
  RECALC,
  timeField,
} from "../ui.mjs";
import { tiles } from "../tiles.mjs";
import { withTip } from "../tips.mjs";
import { localDisplay, unitQty } from "../units.mjs";
import { SETS_PER_WEEK, SETS_WEEKS, setsPerGroup } from "../workouts.mjs";
// A goal's row: its name and unit, which way it points, its number (a
// `note` under it, then what's wrong with it), then `extra` cells.
const targetRow = (r, note = null, ...extra) =>
  h(
    "tr",
    {},
    h("th", { scope: "row" }, r.unit ? withUnit(r) : r.label),
    h("td", { class: "muted", title: GOAL_HINT[r.goal] }, GOAL_SIGN[r.goal]),
    h(
      "td",
      {},
      r.input,
      note ? h("small", { class: "muted" }, note) : null,
      r.problem,
    ),
    ...extra,
  );

const PER = { day: "a day", week: "a week" };

// The Targets screen lists metrics by their registry `section`; any other
// section is a habit's goal.
const SECTIONS = { body: "Body", activity: "Activity", sleep: "Sleep" };

// What one goal row reads and writes: the stored value (`target`, null when
// unset) shown in its display unit. An input left as shown sends the stored
// value back unchanged; a default left alone stays a default. A built-in
// habit's goal reads as the habit does (its name and unit), a day's. A
// clock time (bedtime) is a time input; a metric in kcal follows this
// device's energy unit.
function goalRow(key, target) {
  const n = nutrient(key);
  const m = n ? null : meta.metrics.find((x) => x.key === key);
  const served = meta.habits?.find((x) => x.metric === key);
  const b = served && localBuiltin(served);
  const clock = m?.display.input === "time";
  const energy = m?.unit === "kcal" ? nutrient("energy") : null;
  // Goal weight in lb under US units.
  const shownAs = m && localDisplay(m.display);
  const factor = b?.factor ?? shownAs?.factor ?? 1;
  const r = b
    ? { key, label: b.name, unit: b.unit, goal: n?.goal ?? m.goal, per: "day" }
    : n
      ? { key, label: n.label, unit: n.unit, goal: n.goal, per: null }
      : {
          key,
          label: m.display.label,
          unit: energy?.unit ?? shownAs.unit,
          goal: m.goal,
          per: m.per,
        };
  const show = energy?.show ?? (n && !b ? n.show : (v) => v * factor);
  r.store = energy?.store ?? (n && !b ? n.store : (v) => v / factor);
  r.parse = clock ? minutesOf : Number;
  r.note = clock ? `±${NBSP}${ON_SCHEDULE_MIN}${NBSP}min` : null;
  r.target = target ?? null;
  r.problem = h("small", { id: `${key}-problem`, hidden: true });
  const label = `${r.label} target`;
  // The values the server takes (meta: the registry's ranges), shown.
  const [lo, hi] = (n ?? m).range;
  r.input = clock
    ? timeField({
        name: key,
        value: isNil(target) ? "" : hhmm(target.value),
        "aria-label": label,
      })
    : num({
        name: key,
        value: isNil(target) ? "" : String(+show(target.value).toFixed(3)),
        min: String(+show(lo).toFixed(3)),
        max: String(+show(hi).toFixed(3)),
        "aria-label": label,
        "aria-describedby": `${key}-problem`,
      });
  r.shown = r.input.value;
  return r;
}

// The row's target as sent, or null (left empty, or a default untouched).
function rowTarget(r) {
  if (r.input.value === "") return null;
  if (r.input.value !== r.shown)
    return { metric: r.key, value: r.store(r.parse(r.input.value)) };
  return r.target.default ? null : { metric: r.key, value: r.target.value };
}

// A tracker's goal: at least or at most an amount a day, saved on
// the habit itself. Its way shows as the other rows' glyph (≥ or ≤),
// named in words.
function habitGoalRow(habit) {
  const dir = h(
    "select",
    { name: `habit-${habit.id}-dir`, "aria-label": `${habit.name} goal` },
    ["at_least", "at_most"].map((v) =>
      h(
        "option",
        {
          value: v,
          selected: v === habit.goal_dir,
          "aria-label": GOAL_HINT[v],
        },
        GOAL_SIGN[v],
      ),
    ),
  );
  const input = num({
    name: `habit-${habit.id}`,
    value: habit.goal_value ?? "",
    max: meta.limits.habit_amount,
    "aria-label": `${habit.name} target`,
  });
  const before = [dir.value, input.value];
  return {
    node: h(
      "tr",
      {},
      h("th", { scope: "row" }, `${habit.name} (${habit.unit})`),
      h("td", {}, dir),
      h("td", {}, input, h("small", { class: "muted" }, PER.day)),
    ),
    // Changed: the whole habit with its new goal, else null.
    changed: () =>
      dir.value === before[0] && input.value === before[1]
        ? null
        : {
            name: habit.name,
            unit: habit.unit,
            archived: habit.archived,
            rev: habit.rev,
            goal_value: numberOrNull(input),
            goal_dir: dir.value,
          },
    habit,
    input,
  };
}

// A metric's or built-in's row: its period, and "Recommended" while a
// registry default applies.
const goalTr = (r) =>
  targetRow(
    r,
    [r.note ?? PER[r.per], r.target?.default ? "Recommended" : null]
      .filter(Boolean)
      .join(" · "),
  );
// Targets' tables share their columns, so inputs line up section to
// section: the name, which way it points, the number (then a share).
const cols = (...extra) =>
  h(
    "colgroup",
    {},
    h("col", { class: "label" }),
    h("col", { class: "sign" }),
    h("col"),
    extra,
  );
const table = (trs) =>
  h("table", { class: "grid goals" }, cols(), h("tbody", {}, trs));
const section = (title, trs) =>
  trs.length > 0 ? [h("h2", {}, title), table(trs)] : null;

// Recalculate: replaces the targets a recommendation gives,
// keeps the goals it doesn't (goal weight, a habit's limit). An icon in
// the header (`button`), and why it can't yet (`why`, in the form);
// `shell()` the editor it saves through.
function recalc(profile, energy, shell) {
  const lacking = missing(profile);
  const why = h(
    "p",
    { class: "muted", id: "recalc-why", hidden: lacking.length === 0 },
    `Needs your ${new Intl.ListFormat("en-GB").format(lacking)}`,
  );
  const button = h(
    "button",
    {
      type: "button",
      class: "icon",
      "aria-label": "Recalculate targets",
      title: "Recalculate targets",
      disabled: lacking.length > 0,
      "aria-describedby": lacking.length > 0 ? "recalc-why" : null,
      onclick: busy(async () => {
        if (
          !(await confirmDialog("Recalculate targets?", {
            detail:
              "Sets energy (as Needed energy plans it), nutrients, steps and sleep to what's recommended for your measurements. Other goals stay as they are.",
            confirm: "Recalculate",
            danger: false,
          }))
        )
          return;
        try {
          const [recommended, list] = await Promise.all([
            recommendedWith(scoped(""), energy),
            get(scoped("/targets")),
          ]);
          const fresh = new Set(recommended.map((t) => t.metric));
          await api("PUT", scoped("/targets"), {
            rev: profile.rev,
            targets: [
              ...list.filter((t) => !t.default && !fresh.has(t.metric)),
              ...recommended,
            ].map((t) => ({ metric: t.metric, value: t.value })),
          });
          shell().markClean();
          await route();
          notify("Recalculated targets");
        } catch (err) {
          shell().failed(err);
        }
      }),
    },
    icon(RECALC),
  );
  return { button, why };
}

// "+1.2 kg", "−0.5 kg" (lb under US units).
const signed = (kg) => `${kg < 0 ? "−" : "+"}${unitQty(Math.abs(kg), "kg", 1)}`;

// "Needed energy" (ADR 0020): maintenance, what your goal (any two of
// goal weight, body fat and muscle, by the goal date or at kg a week)
// needs a day (`plan`: web/series.mjs) and resting energy as tiles,
// the goal's pace in one line (a goal weight without a pace or date says
// it plans to keep your weight), why your weight trend doesn't say
// maintenance yet when it doesn't, the guards that slowed it, a
// muscle goal's weekly sets, one note on the scale's shares that follow
// weight, and the offer to set it (never set silently). Resting energy
// names its source: Health Connect's app, or Mifflin–St Jeor, "(Health
// Connect sent none)" once a phone has synced (`synced`).
function neededSection(byKey, plan, weight, volume, synced) {
  const current = byKey.energy?.value ?? null;
  const m = plan.maintenance;
  const n = plan.needed;
  const goalWeight = byKey.goal_weight?.value ?? null;
  const muscleGoal =
    !isNil(byKey.goal_muscle?.value) &&
    isNil(goalWeight) !== isNil(byKey.goal_body_fat?.value);
  const said = n
    ? null
    : !m || isNil(weight)
      ? "Needs a logged weight, and two weeks of food and weigh-ins, a device's energy, or sex, birth date, height and activity level."
      : plan.weightOnly
        ? "Your scale's readings follow your weight: set a goal weight to plan from."
        : muscleGoal
          ? "A muscle goal needs muscle readings (and body fat without a goal weight) from a scale or Health Connect."
          : "A body-fat goal needs a body-fat reading (a scale or Health Connect).";
  const pace = n?.muscle
    ? `Your goal: fat ${signed(n.split.fat)}, muscle ${signed(n.muscle.kg)}${n.muscle.day ? ` by around ${pretty(n.muscle.day)}` : ""}; protein at least ${qty(n.protein, "g", 0)}.`
    : n?.recomp
      ? `Recomposition: about 10${NBSP}% under maintenance, protein at least ${qty(n.protein, "g", 0)}.`
      : n?.weeklyKg
        ? `Your goal: ${n.weeklyKg < 0 ? "−" : "+"}${unitQty(Math.abs(n.weeklyKg), "kg", 2)} a week.`
        : isNil(goalWeight)
          ? "No goal set: planned to keep your weight."
          : `Your goal weight (${unitQty(goalWeight, "kg", 1)}) has no pace or date: planned to keep your weight. Set a pace to plan toward it.`;
  // The scale's shares that follow weight, said once; the plan
  // follows the goal weight alone only when it moves toward it.
  const tracked = [
    ["body_fat", "body fat"],
    ["muscle", "muscle"],
  ]
    .filter(([key]) => plan.tracked?.[key])
    .map(([, name]) => name);
  const note =
    tracked.length > 0
      ? h(
          "p",
          { class: "scale-note" },
          `Your scale's ${tracked.join(" and ")}${NBSP}% follow${tracked.length === 1 ? "s" : ""} your weight: goals from ${tracked.length === 1 ? "it" : "them"} will be unreliable. Use weight and waist.${plan.weightOnly && n?.weeklyKg ? " Planned from your goal weight alone." : ""}`,
        )
      : null;
  return h(
    "section",
    { class: "needed-energy" },
    h("h2", {}, "Needed energy"),
    note,
    said
      ? h("p", { class: "muted" }, said)
      : [
          tiles("Needed energy", [
            {
              value: maintenanceText(m),
              short: "maintenance a day",
              long: `What keeps your weight where it is, a day: from ${maintenanceFrom(m)}.`,
            },
            {
              value: kcal(n.target),
              short: "needed a day",
              long: "What to eat a day for your goal: maintenance, less or more for the pace you set.",
            },
            // Health Connect's, else Mifflin–St Jeor's (ADR 0028).
            isNil(plan.bmr)
              ? null
              : {
                  value: `≈ ${kcal(estimateKcal(plan.bmr))}`,
                  short: "resting a day",
                  long: "What your body burns a day at complete rest (BMR, basal metabolic rate): the part of maintenance you burn doing nothing.",
                },
          ]),
          h("p", { class: "needed-pace" }, pace),
          m.source === "balance"
            ? null
            : h("p", { class: "muted" }, balanceWhy(plan.balance, false)),
          isNil(plan.resting)
            ? null
            : h(
                "p",
                { class: "muted resting-from" },
                plan.resting.source === "health_connect"
                  ? `Resting energy ≈ ${kcal(estimateKcal(plan.resting.kcal))} a day, from Health Connect (${appOf(plan.resting.origin)}).`
                  : `Resting energy by Mifflin–St Jeor from your weight, height, age and sex${synced ? " (Health Connect sent none)" : ""}: a scale's body fat is too rough an estimate for a lean-mass formula.`,
              ),
          n.clamps.map((c) => h("p", { class: "muted" }, c)),
          n.muscle?.kg > 0 && volume ? weeklySets(volume) : null,
          h(
            "p",
            { class: "muted" },
            "Approximate: an estimate to adjust as your weight moves.",
          ),
          offered(n.target, current)
            ? h(
                "button",
                {
                  type: "button",
                  onclick: busy(() =>
                    setEnergyTarget(n.target, n.protein ?? 0),
                  ),
                },
                `Energy target → ${kcal(n.target)}`,
              )
            : null,
        ],
  );
}

// A muscle goal's weekly sets: each muscle group's sets a week (setsPerGroup)
// against SETS_PER_WEEK, the ones outside it named.
function weeklySets(volume) {
  const [low, high] = SETS_PER_WEEK;
  const off = volume
    .map(([group, perWeek]) => [group, Math.round(perWeek)])
    .filter(([, n]) => n < low || n > high)
    .map(
      ([group, n]) =>
        `${group[0].toUpperCase()}${group.slice(1)}: ${plural(n, "set")} a week, ${n < low ? `add ${low - n} or more` : `over ${high} adds little`}.`,
    );
  return h(
    "div",
    { class: "weekly-sets" },
    h(
      "p",
      {},
      `${low}–${high} hard sets per muscle group a week builds muscle (your logged sets of the last ${SETS_WEEKS} weeks, by primary muscle).`,
    ),
    off.length > 0
      ? h(
          "ul",
          {},
          off.map((t) => h("li", {}, t)),
        )
      : h("p", { class: "muted" }, "Every muscle group is in range."),
  );
}

// A steps target from your last 28 days (activities.mjs stepsSuggestion),
// offered under Activity when it differs from the one in effect: the basis
// in one line and Use, which types it into `row` and saves when nothing
// else is unsaved (else your Save saves it with the rest). Never set
// unasked; null without one.
function stepsOffer(suggested, row, shell) {
  if (!suggested || !row || suggested.value === row.target?.value) return null;
  const { median, value, plateau } = suggested;
  const n = fmt(value);
  return h(
    "p",
    { class: "steps-offer" },
    `Your median: ${fmt(Math.round(median / 100) * 100)}${NBSP}steps a day over the last 28 days. Suggested: ${n} (${median < plateau ? `+${fmt(STEPS_MORE)} a day, up to ${fmt(plateau)}` : `kept: past ${fmt(plateau)}, where the benefit levels off`}).`,
    " ",
    h(
      "button",
      {
        type: "button",
        "aria-label": `Use ${n} steps as your target`,
        onclick: () => {
          const clean = !shell().dirty();
          row.input.value = String(value);
          row.input.dispatchEvent(new Event("input", { bubbles: true }));
          if (clean) shell().form.requestSubmit();
        },
      },
      `Use ${n}`,
    ),
  );
}

export async function targets() {
  const [profile, list, habits, synced, stepDays] = await Promise.all([
    get(scoped("")),
    get(scoped("/targets")),
    get(scoped("/habits")),
    // Whether a phone ever synced: Mifflin's line says Health Connect sent
    // no resting energy only then.
    get(scoped("/sync/health"))
      .then((s) => Boolean(s.last_seen))
      .catch(() => false),
    // The steps suggestion's days; unread (offline), none offered.
    fetchRows("deviceDays", shift(today(), -28), shift(today(), -1)).catch(
      () => [],
    ),
  ]);
  const byKey = Object.fromEntries(list.map((t) => [t.metric, t]));
  const plan = await energyPlan(profile, byKey);
  // A muscle goal's weekly sets: the last SETS_WEEKS weeks' activities.
  const volume = isNil(byKey.goal_muscle?.value)
    ? null
    : setsPerGroup(
        ...(await Promise.all([
          fetchRows("activities", shift(today(), 1 - 7 * SETS_WEEKS), today()),
          get("/exercises"),
        ])),
        meta.exercise_traits,
      );
  // Built-in habits' goals (meta.habits) and metrics of no other section
  // are Habits rows; they leave Other nutrients.
  const habitKeys = [
    ...new Set([
      ...(meta.habits ?? []).map((x) => x.metric),
      ...meta.metrics.filter((m) => !SECTIONS[m.section]).map((m) => m.key),
    ]),
  ];
  const rows = [
    ...ordered().map((n) => n.key),
    ...meta.metrics.map((m) => m.key),
  ].map((key) => goalRow(key, byKey[key]));
  const rowOf = (key) => rows.find((r) => r.key === key);
  const trackers = habits
    .filter((x) => !x.archived)
    .map((x) => habitGoalRow(x));
  // Each macro target's share of the energy target (the "Share"
  // column is of the target its header names, not of the macros' own
  // sum), whole %; the energy row their sum (under 100: the rest is fibre,
  // alcohol or unplanned; over: the macros overshoot it). Blank without an
  // energy target.
  const shares = Object.fromEntries(
    ["energy", ...Object.keys(KCAL_PER_G)].map((k) => [
      k,
      h("span", { class: "share muted" }),
    ]),
  );
  const updateShares = () => {
    const r = rowOf("energy");
    const target =
      r && r.input.value !== "" ? r.store(r.parse(r.input.value)) : null;
    // The food panel's split of the same grams (its kcal a gram), each
    // part's kcal over the target.
    const split = energySplit(
      Object.fromEntries(
        Object.keys(KCAL_PER_G)
          .map((key) => [key, rowOf(key)?.input.value ?? ""])
          .filter(([, value]) => value !== "")
          .map(([key, value]) => [key, Number(value)]),
      ),
    );
    const pct = Object.fromEntries(
      (split?.parts ?? []).map((x) => [
        x.key,
        Math.round((x.kcal / target) * 100),
      ]),
    );
    const known = target > 0 && Boolean(split);
    const sum = Object.values(pct).reduce((t, x) => t + x, 0);
    for (const [key, el] of Object.entries(shares))
      el.textContent = known
        ? key === "energy"
          ? `${sum}${NBSP}%`
          : key in pct
            ? `${pct[key]}${NBSP}%`
            : ""
        : "";
  };
  updateShares();
  // Under each goal what's wrong with it as typed: outside the values the
  // server takes, or a body goal no body reaches (both refused on save),
  // else unrealistic (allowed; said). A value stored before a rule
  // tightened shows it on opening.
  const updateProblems = () => {
    const value = (key) => {
      const r = rowOf(key);
      return !r || r.input.value === ""
        ? null
        : r.store(r.parse(r.input.value));
    };
    const found = goalProblems(
      value,
      profile,
      profile.latest_weight_kg ?? null,
      plan,
    );
    for (const r of rows) {
      const invalid = r.input.validationMessage;
      const p = invalid ? { text: invalid, error: true } : found[r.key];
      r.problem.hidden = !p;
      r.problem.textContent = p?.text ?? "";
      r.problem.className = p?.error ? "error" : "muted";
    }
  };
  updateProblems();
  const metricRows = (name) =>
    meta.metrics
      .filter((m) => m.section === name)
      .map((m) => goalTr(rowOf(m.key)));
  const otherRows = ordered()
    .filter((n) => !KEY_TARGETS.includes(n.key) && !habitKeys.includes(n.key))
    .map((n) => rowOf(n.key));
  const recalcs = recalc(profile, plan.needed?.target ?? null, () => shell);
  const offer = stepsOffer(
    stepsSuggestion(stepDays, today(), profile.birth_date ?? null),
    rowOf("steps"),
    () => shell,
  );
  const shell = editor({
    title: "Targets",
    back: href.profile(),
    action: recalcs.button,
    body: [
      h("h2", {}, "Energy and macros"),
      h(
        "table",
        { class: "grid goals" },
        cols(h("col", { class: "share" })),
        h(
          "thead",
          {},
          h(
            "tr",
            {},
            h("th", {}, "Nutrient"),
            h("th", {}, h("span", { class: "sr-only" }, "Goal")),
            h("th", {}, "Target"),
            h(
              "th",
              { class: "tip-host" },
              ...withTip(
                h("button", { type: "button", class: "link" }, "Share"),
                "% of the energy target",
              ),
            ),
          ),
        ),
        h(
          "tbody",
          {},
          KEY_TARGETS.map((key) =>
            targetRow(rowOf(key), null, h("td", {}, shares[key] ?? "")),
          ),
        ),
      ),
      neededSection(byKey, plan, profile.latest_weight_kg, volume, synced),
      Object.entries(SECTIONS).map(([key, title]) => [
        section(title, metricRows(key)),
        key === "activity" ? offer : null,
      ]),
      section("Habits", [
        ...habitKeys.map((key) => goalTr(rowOf(key))),
        ...trackers.map((t) => t.node),
      ]),
      h(
        "details",
        { class: "fold" },
        h("summary", {}, "Other nutrients"),
        table(
          byCategory(otherRows, (r) => nutrient(r.key)).map(([name, rs]) => [
            categoryRow(name, 3),
            rs.map((r) => targetRow(r)),
          ]),
        ),
      ),
      h(
        "p",
        { class: "muted" },
        `≥ at least · ≤ at most · ~ about (within 5${NBSP}% either way is fine)`,
      ),
    ],
    // Trackers first: their own revs move on, so saving again after a
    // refused targets list repeats them harmlessly.
    save: async () => {
      for (const t of trackers) {
        const body = t.changed();
        if (!body) continue;
        try {
          Object.assign(
            t.habit,
            await api("PUT", scoped(`/habits/${t.habit.id}`), {
              ...body,
              rev: t.habit.rev,
            }),
          );
        } catch (err) {
          // The server names its own field; on this screen it is the row's.
          throw Object.assign(err, { field: t.input.name });
        }
      }
      const saved = await api("PUT", scoped("/targets"), {
        rev: profile.rev,
        targets: rows.map((x) => rowTarget(x)).filter(Boolean),
      });
      return saved;
    },
    saved: () => "Saved targets",
  });
  shell.form.prepend(recalcs.why);
  shell.form.addEventListener("input", updateShares);
  shell.form.addEventListener("input", updateProblems);
  return shell.node;
}
