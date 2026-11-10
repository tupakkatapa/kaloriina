// Summary → Activity: the period's activities against the weekly target,
// and a calendar of the minutes active each day with what was planned.

import {
  activitiesMetres,
  counted,
  exerciseBest,
  MIN_MINUTES,
  targetWeeks,
  tracksActivity,
} from "../activities.mjs";
import { get, scoped } from "../api.mjs";
import { calendarView } from "../calendar.mjs";
import { legendWords, step } from "../calendar-grid.mjs";
import { touching } from "../correlate.mjs";
import { daysIn, duration, pretty, shift, today } from "../dates.mjs";
import { activeMark } from "../energy-text.mjs";
import { fmt, isNil, noun, plural, qty } from "../format.mjs";
import {
  activitiesVersus,
  everyDay,
  prepare,
  present,
  versusBefore,
} from "../insights.mjs";
import { href } from "../nav.mjs";
import { kcalParts } from "../nutrients.mjs";
import {
  activeEnergy,
  activeKcal,
  estimateKcal,
  periodNumbers,
} from "../series.mjs";
import { tiles } from "../tiles.mjs";
import { h } from "../ui.mjs";
import { unitQty } from "../units.mjs";
import { setText } from "../workouts.mjs";
import { highlightStack } from "./summary-highlights.mjs";
import { cardioSection, loadCardio } from "./summary-load.mjs";

export const KEY = "activity";
export const LABEL = "Activity";

// The period's activities and plans, the period before's activities and
// device days (the tiles compare them), and the records (`/records`:
// Records' bests); the weekly target, Health Connect,
// check-ins, the energy burned and the activity rows come shared
// (web/series.mjs).
export async function load(p, sharing) {
  const range = `from=${p.from}&to=${p.to}`;
  const [shared, plans, exercises, records] = await Promise.all([
    sharing,
    get(scoped(`/plans?${range}`)),
    get("/exercises"),
    get(scoped("/records")),
  ]);
  const [activities, before, beforeDevice, beforeFood, food, cardio] =
    await Promise.all([
      shared.rows("activities", p.from, p.to),
      shared.rows("activities", p.before.from, p.before.to),
      shared.rows("deviceDays", p.before.from, p.before.to),
      shared.rows("energy", p.before.from, p.before.to),
      shared.rows("energy", p.from, p.to),
      loadCardio(p, shared),
    ]);
  // Data of any kind before the period: then its days are all tracked. A
  // device day counts only when it tracked something (tracksActivity).
  const tracked = [
    before,
    beforeDevice.filter((x) => tracksActivity(x)),
    beforeFood,
  ].some((x) => x.length)
    ? p.from
    : [...activities, ...shared.deviceDays.filter(tracksActivity), ...food]
        .map((x) => x.day)
        .toSorted()[0];
  return {
    activities,
    plans,
    before,
    beforeDevice,
    exercises,
    food,
    cardio,
    bests: bestsOf(records),
    since: !tracked || tracked < p.from ? p.from : tracked,
  };
}

// The bests a Highlight may name, as Records counts them: the best step
// day, the longest night and each exercise's ([{what, value, day}]).
const bestsOf = (records) => {
  const d = records.days;
  return [
    d.steps && {
      what: "most steps",
      value: plural(d.steps.value, "step"),
      day: d.steps.day,
    },
    d.night && {
      what: "longest night",
      value: duration(d.night.value),
      day: d.night.day,
    },
    ...records.exercises.flatMap((r) => {
      const best = exerciseBest(r);
      return best
        ? [{ what: r.name, value: setText(best.set), day: best.day }]
        : [];
    }),
  ].filter(Boolean);
};

// " since Jun 2" when the period's numbers start after its first day.
const sinceText = (p, since) =>
  since > p.from ? ` since ${pretty(since, false)}` : "";

// Activities a day over every day of [from, to] (web/insights.mjs): a rest
// day is a 0, not missing data.
const activitySeries = (activities, from, to) =>
  everyDay(from, to, activities, () => 1);
const minutesSeries = (activities, from, to) =>
  everyDay(from, to, activities, (s) => s.minutes);

// The first day the sync is seen covering among what is loaded, when any
// device activity is: a comparison starting before it would count their
// arrival as a change. Undefined without device activities.
const syncedFrom = (activities, days) => {
  const device = activities.filter((s) => s.source_key).map((s) => s.day);
  if (device.length === 0) return;
  return [...device, ...days.map((d) => d.day)].toSorted()[0];
};

// A period's days count from `since` (`load`: the first day anything was
// tracked, activities, device days or food, when that falls inside it): the
// months before tracking began are no rest and burned nothing measured.
export function render(
  p,
  {
    activities,
    plans,
    before,
    beforeDevice,
    exercises,
    food,
    cardio,
    bests,
    since,
  },
  shared,
) {
  const deviceFrom = syncedFrom([...before, ...activities], shared.deviceDays);
  const bmr = shared.burned.bmr;
  // The tiles' comparisons: activities through today, the device's through
  // yesterday (today's are still coming in).
  const counts = (list, from, to) => ({
    activities: activitySeries(list, from, to),
  });
  const now = prepare({
    kind: p.kind,
    from: p.from,
    to: p.to,
    last: today(),
    before: p.before,
    deviceFrom,
    series: counts(activities, p.from, p.to),
    prev: counts(before, p.before.from, p.before.to),
  });
  const synced = prepare({
    kind: p.kind,
    from: p.from,
    to: p.to,
    last: shift(today(), -1),
    before: p.before,
  });
  const vs = {
    activities: activitiesVersus(now),
    minutes: versusBefore(
      now,
      minutesSeries(activities, p.from, p.to),
      minutesSeries(before, p.before.from, p.before.to),
    ),
    steps: versusBefore(
      synced,
      present(shared.deviceDays, "steps"),
      present(beforeDevice, "steps"),
    ),
    active: versusBefore(
      synced,
      activeSeries(knownActive(shared.deviceDays, activities, bmr)),
      activeSeries(knownActive(beforeDevice, before, bmr)),
    ),
  };
  return [
    // An activity logged today is whole, so today counts.
    highlightStack(
      KEY,
      {
        kind: p.kind,
        from: p.from,
        to: p.to,
        last: today(),
        before: p.before,
        // Activity ↔ sleep and mood.
        series: {
          activities: activitySeries(activities, p.from, p.to),
          ...shared.series,
        },
        targets: shared.targets,
        deviceFrom,
        prev: {
          activities: activitySeries(before, p.before.from, p.before.to),
        },
        // Muscle gaps, the target streak, distance and pace; new bests.
        activities,
        bests,
        // Cardio load against the 4 weeks before (ADR 0034).
        cardio,
        beforeActivities: before,
        trailing: shared.trailing,
        exercises: new Map(exercises.map((e) => [e.id, e])),
        correlations: touching(shared.correlations, KEY),
      },
      p,
      shared,
    ),
    activitiesSummary(
      p,
      activities,
      plans,
      shared.targets.workouts_per_week?.value ?? null,
      shared.burned.bmr,
      since,
      vs,
      movementSummary(
        p,
        shared.deviceDays,
        activities,
        food,
        shared.burned,
        {
          active: shared.targets.active_kcal?.value ?? null,
          steps: shared.targets.steps?.value ?? null,
        },
        since,
        vs,
      ),
    ),
    cardioSection(p, cardio, since),
    activityCalendar(p, activities, plans, since),
  ];
}

// Minutes a day: the upper bounds of shades 1–3 (above is 4).
const BOUNDS = [20, 45, 90];

const byDay = (list) => {
  const out = new Map();
  for (const x of list) out.set(x.day, [...(out.get(x.day) ?? []), x]);
  return out;
};

// Each day's minutes (summed over its activities), shaded by BOUNDS, with a
// mark for a plan: ● today or later, ○ on a past day (done as planned, a plan
// goes; one left on a past day was missed). A rest day isn't missing data;
// only a day before `since` (nothing tracked yet) is hatched.
function series(activities, plans, since) {
  const done = byDay(activities);
  const planned = byDay(plans);
  const now = today();
  const minutes = (day) =>
    (done.get(day) ?? []).reduce((t, s) => t + s.minutes, 0);
  return {
    amount: (day) => (minutes(day) > 0 ? fmt(minutes(day)) : ""),
    step: (day) => step(minutes(day), BOUNDS),
    unlogged: (day) => day < since,
    over: () => false,
    marks: (day) => (planned.has(day) ? (day < now ? "○" : "●") : null),
    // "Tue, Oct 6: 2 activities, 75 min (Pull day, Run)", "Thu, Oct 9:
    // planned Legs", "Mon, Oct 5: planned Legs, missed"; both joined by " · ".
    label: (day) => {
      const list = done.get(day) ?? [];
      const plan = planned.get(day) ?? [];
      const parts = [
        list.length > 0
          ? `${plural(list.length, "activity", "activities")}, ${qty(minutes(day), "min", 0)} (${list.map((s) => s.name).join(", ")})`
          : null,
        plan.length > 0
          ? `planned ${plan.map((x) => x.name).join(", ")}${day < now ? ", missed" : ""}`
          : null,
      ].filter(Boolean);
      const none = day < since ? "not tracked" : "no activity";
      return `${pretty(day)}: ${parts.length > 0 ? parts.join(" · ") : none}`;
    },
  };
}

// The calendar of the period and its key, in words as well as colour.
function activityCalendar(p, activities, plans, since) {
  return h(
    "section",
    { class: "finder-section activity-calendar" },
    calendarView({
      kind: p.kind,
      from: p.from,
      caption: "Minutes by day",
      series: series(activities, plans, since),
      monthLink: (month) => href.summary("month", `${month}-01`, KEY),
      className: "activity-cal",
    }),
    h(
      "div",
      { class: "cal-legend muted" },
      h(
        "ul",
        { "aria-label": "Shades" },
        ["0", ...legendWords(BOUNDS, "min")].map((w, i) =>
          h(
            "li",
            {},
            h("span", { class: `cal-cell shade-${i}`, "aria-hidden": "true" }),
            w,
          ),
        ),
      ),
      p.kind === "year"
        ? null
        : h(
            "ul",
            { "aria-label": "Marks" },
            h("li", {}, h("span", { "aria-hidden": "true" }, "●"), "planned"),
            h("li", {}, h("span", { "aria-hidden": "true" }, "○"), "missed"),
          ),
    ),
  );
}

const activityNoun = (k) => noun(k, "activity", "activities");

// "2 of 3 activities this week", "1 h 15 min active", "≈ 640 kcal from
// activities", "1 planned": a week against the target (with a bar); a
// month or year as a weekly average over its elapsed days, with how many
// of its weeks met `target` (activities a week, or null). The energy is
// each one's active energy, as Burned counts it (expenditure.mjs
// activeEnergy, `bmr` a bmrOf): measured as it is; not set on one, it is
// estimated (≈, read out as "includes estimates") from its type, time and
// the weight in effect on its day; without one it isn't. The day's whole
// burned is Daily movement's. `vs`: each tile's change from the period
// before (render's).
function activitiesSummary(
  p,
  activities,
  plans,
  target,
  bmr,
  since,
  vs,
  movement,
) {
  const end = p.throughToday;
  const done = activities.filter((s) => s.day <= end);
  const n = done.length;
  // A device's minute-long leftover counts toward no target (activities.mjs
  // MIN_MINUTES).
  const short = done.filter((s) => !counted(s)).length;
  const toward = n - short;
  const minutes = done.reduce((t, s) => t + s.minutes, 0);
  const energies = done.map((s) => activeEnergy(s, bmr(s.day)?.kcal ?? null));
  const burned = energies.reduce((t, e) => t + (e.active ?? 0), 0);
  const estimated = energies.some((e) => e.estimated && e.active !== null);
  const unestimated = energies.some((e) => e.estimated && e.active === null);
  const week = p.kind === "week";
  const judged = week
    ? null
    : targetWeeks(activities, p.from, p.to, target, today(), since);
  // The unit goes with the caption, so a long total fits a phone's tile.
  const { value: burnedValue, unit } = kcalParts(burned);
  const planned =
    plans.length > 0
      ? {
          value: fmt(plans.length),
          short: "planned",
          long: "Workouts planned this week and not done yet.",
        }
      : null;
  // Under the target's tile, its caption's small print.
  const note =
    short && target
      ? h(
          "span",
          { class: "tile-sub" },
          `${plural(short, "activity", "activities")} under ${qty(MIN_MINUTES, "min", 0)} ${short === 1 ? "doesn't" : "don't"} count`,
        )
      : null;
  return h(
    "section",
    { class: "finder-section activity-summary" },
    h("h2", {}, "Activities"),
    tiles("Activities", [
      week
        ? isNil(target)
          ? {
              value: fmt(n),
              short: activityNoun(n),
              long: "Activities this week: the ones you logged and the ones a device recorded that you added.",
              vs: vs.activities,
            }
          : {
              value: `${fmt(toward)} of ${fmt(target)}`,
              short: [`${activityNoun(target)} this week`, note],
              long: `Activities this week against your target of ${plural(target, "activity", "activities")} a week.${short ? ` One under ${qty(MIN_MINUTES, "min", 0)} doesn't count: a device's leftover.` : ""}`,
              vs: vs.activities,
            }
        : {
            value: fmt(n),
            short: `${activityNoun(n)} · ${fmt(n / (Math.max(1, daysIn(since, end)) / 7), 1)} a week`,
            long: `Activities${sinceText(p, since)} this ${p.kind}, and how many that makes a week on average.`,
            vs: vs.activities,
          },
      n
        ? {
            value: duration(minutes),
            short: "active",
            long: "The time of all the activities, added up.",
            vs: vs.minutes,
          }
        : null,
      burned
        ? {
            value: [
              estimated
                ? h(
                    "span",
                    {
                      role: "img",
                      "aria-label": "includes estimates",
                      title: "Includes estimates",
                    },
                    "≈",
                  )
                : null,
              estimated ? " " : null,
              burnedValue,
            ],
            short: `${unit} from activities`,
            long: `The energy the activities burned beyond resting, added up: as your device measured it${estimated ? ", else estimated from each one's type, time and your weight" : ""}.`,
          }
        : null,
      week || !judged?.total
        ? planned
        : {
            value: `${judged.met} of ${judged.total}`,
            short: [
              `weeks at your target of ${fmt(target)}${sinceText(p, since)}`,
              note,
            ],
            long: `Weeks with at least ${plural(target, "activity", "activities")}, of the weeks${sinceText(p, since)} this ${p.kind} so far.`,
          },
    ]),
    week && target
      ? h("progress", {
          max: target,
          value: Math.min(toward, target),
          "aria-label": `${toward} of ${plural(target, "activity", "activities")} this week`,
        })
      : null,

    unestimated
      ? h("p", { class: "muted" }, "Log a weight to estimate energy.")
      : null,
    // An empty period says so in its tiles ("0 activities") and calendar,
    // not again in a sentence: a rest week is data, not a gap.
    movement,
  );
}

// Each day's active energy among Health Connect `deviceDays` and the
// `activities` ([{day, kcal, floor, estimated}]): the device's or its
// activities', the larger (activeKcal); a day without the device's holds
// its activities alone, a floor. `bmr` a bmrOf.
function knownActive(deviceDays, activities, bmr) {
  const device = new Map(deviceDays.map((d) => [d.day, d]));
  const done = byDay(activities);
  return [...new Set([...device.keys(), ...done.keys()])]
    .toSorted()
    .map((day) => {
      const known = activeKcal({
        deviceDay: device.get(day) ?? null,
        energies: (done.get(day) ?? []).map((s) =>
          activeEnergy(s, bmr(day)?.kcal ?? null),
        ),
      });
      return known && { day, ...known };
    })
    .filter(Boolean);
}

// knownActive as a series, its floors `partly`.
const activeSeries = (list) => ({
  ...present(list, "kcal"),
  partly: new Set(list.filter((x) => x.floor).map((x) => x.day)),
});

// "≈ 510 kcal active a day", "12 of 28 days" (at the Active energy
// target), "8,743 steps a day", "6.1 km a day" (the device's distance),
// "9 of 17 days" (at the steps target), "42.3 km in activities", "≈ 2,640 kcal burned a day": through yesterday
// (today's are still coming in), the mean active energy a day over the days
// it is known (the device's or its activities', the larger: activeKcal;
// marked as energy-text.mjs activeMark says, "≥" with a day of activities
// alone, "≈" with an estimate in it, none when measured), the steps a day
// over the days that have them and the days at `targets.steps`, the
// distance the activities covered, and what a day burned by the energy
// model (`burned`, web/series.mjs) over Food's balance's days
// (periodNumbers of the period's `food` days: those with food logged), as
// Food says it. `targets` {active, steps}: kcal and steps a day, or null;
// `vs` render's.
function movementSummary(
  p,
  all,
  activities,
  food,
  { days: burnedAll, bmr },
  { active: target, steps: stepsTarget },
  since,
  vs,
) {
  const end = p.through;
  const days = all.filter((d) => d.day <= end);
  const balance = periodNumbers({
    days: food.filter((d) => d.day <= end),
    burned: burnedAll,
    bmr,
  });
  const sum = (key) => days.reduce((t, d) => t + (d[key] ?? 0), 0);
  const stepped = days.filter((d) => !isNil(d.steps));
  const stepDays = stepped.length;
  const walked = days.filter((d) => !isNil(d.distance_m));
  const elapsed = Math.max(0, daysIn(since, end));
  const known = knownActive(
    days,
    activities.filter((s) => s.day <= end),
    bmr,
  );
  const activeDays = known.map((x) => x.kcal);
  const alone = known.filter((x) => x.floor).length;
  const mark = activeMark({
    floor: alone > 0,
    estimated: known.some((x) => x.estimated),
  });
  // An activity logged today is whole, so its distance counts.
  const metres = activitiesMetres(
    activities.filter((s) => s.day <= p.throughToday),
  );
  // A mean a day, as steps are: a total over a varying count of days
  // compares with nothing.
  const { value: active, unit } = kcalParts(
    activeDays.reduce((t, k) => t + k, 0) / Math.max(1, activeDays.length),
  );

  const node = tiles("Daily movement", [
    activeDays.length > 0
      ? {
          value: `${mark}${active}`,
          short: `${unit} active a day`,
          long: `Your average energy burned moving, beyond resting, over the ${plural(activeDays.length, "day")} it's known${sinceText(p, since)}${elapsed > activeDays.length ? ` (of ${plural(elapsed, "day")})` : ""}: your device's measure, or your activities' when larger.${alone ? ` At least: on ${plural(alone, "day")} only your activities said it.` : ""}`,
          vs: vs.active,
        }
      : null,
    activeDays.length > 0 && !isNil(target)
      ? {
          value: `${activeDays.filter((k) => k >= target).length} of ${activeDays.length}`,
          short: "days at active energy target",
          long: "Days whose active energy reached your target, of the days it's known.",
        }
      : null,
    stepDays
      ? {
          value: fmt(sum("steps") / stepDays),
          short: "steps a day",
          long: `Your average steps a day, over the ${plural(stepDays, "day")} your device counted them.`,
          vs: vs.steps,
        }
      : null,
    // A day's distance, the device's (all it counted, walking too).
    walked.length > 0
      ? {
          value: unitQty(sum("distance_m") / walked.length / 1000, "km", 1),
          short: "a day",
          long: `Your average distance a day, over the ${plural(walked.length, "day")} your device measured it: walking and the rest it counted.`,
        }
      : null,
    stepDays && !isNil(stepsTarget)
      ? {
          value: `${stepped.filter((d) => d.steps >= stepsTarget).length} of ${stepDays}`,
          short: "days at steps target",
          long: `Days with at least ${fmt(stepsTarget)} steps, your target, of the days your device counted steps.`,
        }
      : null,
    // A total to a tenth, not "300.29 km".
    metres
      ? {
          value: unitQty(metres / 1000, "km", 1),
          short: "in activities",
          long: "The distance of the activities that have one, added up.",
        }
      : null,
    // An estimate, to 10 kcal (50 kJ) as Food's balance says it.
    balance
      ? {
          value: `≈ ${kcalParts(estimateKcal(balance.burned)).value}`,
          short: `${unit} burned a day`,
          long: `An estimate of all you burned a day (resting, digesting and moving), over the ${plural(balance.n, "day")} with food logged: the same days as Food's energy balance.`,
        }
      : null,
  ]);
  node?.classList.add("movement-summary");
  return node;
}
