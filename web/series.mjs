// The energy model's one public face (ADR 0020): what a day
// burned (`burned`), maintenance by day (`maintenance`), the plan a goal
// needs (`plan`) and a Diary day's active energy (`dayEnergy`); web/
// energy.mjs and web/expenditure.mjs sit behind it (energy-text.mjs says
// their numbers). Then what every Summary subtab shares, loaded once per
// period (`sharedSeries`: the profile's goals by metric, Health Connect's
// days, the check-ins, food, activities, weigh-ins and scale readings over
// one union range, the energy burned, and the cross-domain Highlights
// series made from them; a subtab adds only its own domain's series, and
// reads any range the union covers from `rows` without a request); and the
// pure series a Summary chart draws (`energySeries`, `macroSeries`,
// `metricSeries`), with their target lines.

import { currentProfile, get, meta, scoped } from "./api.mjs";
import { series as checkInSeries } from "./check-ins.mjs";
import { correlations, WINDOW_DAYS } from "./correlate.mjs";
import { coverage } from "./coverage.mjs";
import { ageOn, shift, today, weekStart } from "./dates.mjs";
import {
  WINDOW_DAYS as BALANCE_DAYS,
  balanceRange,
  maintenanceSeries,
  plan as planOf,
  trend,
  TREND_DAYS,
  trendPer,
} from "./energy.mjs";
import {
  activeKcal,
  activeOf,
  bmrOf,
  burnedDays,
  burnedOver,
  CARRY_DAYS,
  estimateKcal,
  EVERYDAY,
  round10,
  TEF,
} from "./expenditure.mjs";
import { isNil, qty, whole } from "./format.mjs";
import { habitAmountText } from "./habits.mjs";
import { everyDay, seriesOf, sleepSeries } from "./insights.mjs";
import { kcal as energyText, foodDay, GOAL_SIGN, KNOWN } from "./nutrients.mjs";
import { source as metricDays, seriesInfo } from "./series-keys.mjs";
import { mean } from "./stats.mjs";

// The weight trend's and the activity numbers' rules, as the model has
// them: screens read them here.
export {
  TREND_DAYS,
  WINDOW_DAYS as BALANCE_DAYS,
  projection,
  slope,
  tracksWeight,
  trend,
  trendPer,
  weeklyRate,
} from "./energy.mjs";
export {
  activeKcal,
  activeEnergy,
  appOf,
  estimateKcal,
  offered,
  round10,
} from "./expenditure.mjs";

// Each source `rows` reads: its route, and the rows in its answer.
// `energy` is `days` with each day's energy alone (All time reads years);
// `resting` Health Connect's resting energy in effect each day, from the
// answer `deviceDays` reads.
const SOURCES = {
  days: ["/summary", (r) => r.days],
  energy: ["/summary", (r) => r.days, "&keys=energy"],
  deviceDays: ["/device-days", (r) => r.days],
  resting: ["/device-days", (r) => r.resting],
  checkIns: ["/check-ins", (r) => r],
  activities: ["/activities", (r) => r],
  weights: ["/weights", (r) => r],
  readings: ["/scale", (r) => r],
  habits: ["/habits/days", (r) => r],
};

// Requests in flight by path: two sources of one answer (`deviceDays`,
// `resting`) asked together over one range share its request.
const flying = new Map();

// `source`'s rows ([{day, …}]) over [from, to], fetched; none for an
// empty range.
export async function fetchRows(source, from, to) {
  if (from > to) return [];
  const [path, rowsOf, more = ""] = SOURCES[source];
  const url = scoped(`${path}?from=${from}&to=${to}${more}`);
  if (!flying.has(url))
    flying.set(
      url,
      get(url).finally(() => flying.delete(url)),
    );
  return rowsOf(await flying.get(url));
}

const min = (a, b) => (a < b ? a : b);

// Before any day logged: All time's start.
const EVER = "1970-01-01";

// What each day of [from, to] burned, never a day not yet over (the range
// ends yesterday at the latest: today's energy is still coming in), and
// the resting energy behind it. `from` null starts at the first day eaten.
// Rows come from `rows` (`fetchRows`, or a period's shared ones). {days:
// [{day, kcal, source}], bmr: (day) → {kcal, source, origin} | null, a
// bmrOf over [from, to] (Health Connect's days and resting read over it,
// one request), energy: the food days read ([{day, total}], energy
// alone), for periodNumbers}.
export async function burned(from, to, { rows = fetchRows } = {}) {
  const yesterday = shift(today(), -1);
  const end = min(to, yesterday);
  const start = from ?? EVER;
  const back = shift(start, -CARRY_DAYS);
  const [days, weights, deviceDays, resting, activities] = await Promise.all([
    rows("energy", start, end),
    rows("weights", back, to),
    rows("deviceDays", start, to),
    rows("resting", start, to),
    rows("activities", start, end),
  ]);
  const first = from ?? days[0]?.day ?? null;
  const bmr = bmrOf({ person: currentProfile() ?? {}, weights, resting });
  return {
    days: first
      ? burnedOver({
          from: first,
          to,
          yesterday,
          days,
          deviceDays,
          activities,
          bmr,
        })
      : [],
    bmr,
    energy: days,
  };
}

// The energy target the profile's goal needs today (web/energy.mjs
// `plan`): the inputs over the balance window, fetched. `byKey` the
// profile's targets by metric.
export async function plan(profile, byKey) {
  const day = today();
  const { from } = balanceRange(shift(day, -1));
  const [days, weights, readings, deviceDays, resting, activities] =
    await Promise.all([
      fetchRows("energy", from, day),
      fetchRows("weights", shift(from, -CARRY_DAYS), day),
      fetchRows("readings", shift(from, -CARRY_DAYS), day),
      fetchRows("deviceDays", from, day),
      fetchRows("resting", from, day),
      fetchRows("activities", from, day),
    ]);
  return planOf({
    profile,
    byKey,
    days,
    weights,
    readings,
    deviceDays,
    resting,
    activities,
    today: day,
  });
}

// Each day of the period `p` over (through yesterday)'s maintenance by
// the BALANCE_DAYS ending it (web/energy.mjs maintenanceSeries), from the
// period's shared rows (`shared`, sharedSeries': they cover the first
// window); the weigh-ins from TREND_DAYS before it, so its first trend
// point has its history as `plan`'s does. [{day, kcal, source}].
export async function maintenance(p, shared) {
  const yesterday = shift(today(), -1);
  const end = min(p.to, yesterday);
  const start = shift(p.from, 1 - BALANCE_DAYS);
  if (p.from > end) return [];
  const [days, weights, carried, deviceDays, resting, activities] =
    await Promise.all([
      shared.rows("energy", start, end),
      shared.rows("weights", shift(start, 1 - TREND_DAYS), end),
      shared.rows("weights", shift(start, -CARRY_DAYS), end),
      shared.rows("deviceDays", start, end),
      shared.rows("resting", start, end),
      shared.rows("activities", start, end),
    ]);
  // Resting over its own window, which may start before the period's
  // burned does.
  const bmr = bmrOf({
    person: currentProfile() ?? {},
    weights: carried,
    resting,
  });
  return maintenanceSeries({
    from: p.from,
    to: end,
    days,
    weights,
    burned: burnedDays({
      from: start,
      to: end,
      days,
      deviceDays,
      activities,
      bmr,
    }),
    bmr,
    pal: currentProfile()?.activity ?? null,
  });
}

// A Diary day's active energy (`data`, `/diary`'s day), activeKcal's
// {kcal, floor, estimated}: the device's or its activities' (each as its
// row reads it, expenditure.mjs activeOf), the larger. One not sent yet
// takes the day's resting served (`resting`), else its weight's or the
// profile's latest. Null without either.
export function dayEnergy(data, profile = currentProfile() ?? {}) {
  const ctx = dayContext(data, profile);
  return activeKcal({
    deviceDay: data.device_day ?? null,
    energies: (data.activities ?? []).map((s) => activeOf(s, ctx)),
  });
}

// Whose a Diary day's activities' energy is (expenditure.mjs activeOf's
// context): `profile`, the day's weight or its latest, and the day's
// resting energy as served (`resting`). Its rows and dayEnergy share it.
export function dayContext(data, profile = currentProfile() ?? {}) {
  const kg = data.weight ?? profile.latest_weight_kg ?? null;
  return {
    person: profile,
    weights: isNil(kg) ? [] : [{ day: data.day, kg }],
    resting: data.resting ? [{ day: data.day, ...data.resting }] : [],
  };
}

// Food days ([{day, total, known}]) as series of what was eaten: `energy`
// over the days with energy eaten; `alcohol` and `caffeine` over those the
// day knows them (KNOWN of what could hold them carried a value, ADR 0030:
// a drink without its value is no sober day, a pizza holds none), alcohol
// said in drinks as its habit is.
export const eatenSeries = (days) => {
  const eaten = days.filter((x) => foodDay(x));
  const known = (key) => eaten.filter((d) => coverage([d], key) >= KNOWN);
  const alcohol = meta?.habits?.find((b) => b.key === "alcohol");
  return {
    energy: seriesOf(eaten, (d) => d.total.energy),
    alcohol: {
      ...seriesOf(known("alcohol"), (d) => d.total.alcohol ?? 0),
      ...(alcohol && {
        say: (v) => habitAmountText(alcohol, v * alcohol.factor),
      }),
    },
    caffeine: seriesOf(known("caffeine"), (d) => d.total.caffeine ?? 0),
  };
};

const inside = (x, from, to) => x.day >= from && x.day <= to;

// The period `p`'s shared data: `targets` (metric → {value, min, max,
// default?}, registry defaults included), `deviceDays` (Health Connect days),
// `checkIns`, `series` ({sleep, steps, resting_hr, hrv_ms, checkin:*}),
// `burned` (`burned` over the period); and over the WINDOW_DAYS ending
// `p.through`, yesterday at the latest (correlations and the rules that
// need weeks before a short period, and the BALANCE_DAYS before `p.from`
// maintenance reads):
// `trailing` (the same series plus energy, alcohol, caffeine, energy
// burned and minutes eaten or trained, and `activities`; burned is worked
// out once over both) and its `correlations`
// (web/correlate.mjs), `window` ({from, to}: those days); `prefs` (id →
// {state, until}: an insight hidden through a day or pinned,
// `/insights/prefs`). Each source loads once over the union of both
// (apart, never the days between, when the period lies past today;
// weigh-ins from CARRY_DAYS before, for the model; `/habits/days` over
// the window: the Highlights' habits); `rows`
// reads a range of one, sliced when the union covers it, else fetched.
export async function sharedSeries(p) {
  // The trailing window ends yesterday at the latest: a period still to
  // come has no data, and its days would push real ones out.
  const last = min(p.through, shift(today(), -1));
  const back = shift(last, 1 - WINDOW_DAYS);
  const lead = shift(p.from, 1 - BALANCE_DAYS);
  const first = min(back, lead);
  const carried = shift(first, -CARRY_DAYS);
  // A period further ahead than today: the days between are never loaded
  // (nothing is logged there yet; a test's period lies centuries ahead),
  // each source read through today and over the period apart.
  const now = today();
  const load = (source, from) => {
    // The period's part from as far before it as the window's: weigh-ins
    // from CARRY_DAYS before.
    const ahead = from === carried ? shift(lead, -CARRY_DAYS) : lead;
    return shift(now, 1) < ahead && from <= now
      ? Promise.all([
          fetchRows(source, from, now),
          fetchRows(source, ahead, p.to),
        ]).then(([before, after]) => [...before, ...after])
      : fetchRows(source, from, p.to);
  };
  const covered = {
    days: first,
    energy: first,
    deviceDays: first,
    resting: first,
    checkIns: first,
    activities: first,
    weights: carried,
    readings: first,
    habits: back,
  };
  const loaded = Object.fromEntries(
    Object.entries(covered)
      .filter(([source]) => source !== "energy")
      .map(([source, from]) => [source, load(source, from)]),
  );
  loaded.energy = loaded.days;
  const rows = (source, from, to) =>
    from >= covered[source] && to <= p.to
      ? loaded[source].then((list) => list.filter((x) => inside(x, from, to)))
      : fetchRows(source, from, to);
  const [prefs, targets, deviceDays, checkIns, eaten, activities, spent] =
    await Promise.all([
      // Insights hidden or pinned: none when the server can't say.
      get(scoped("/insights/prefs"))
        .then((list) => new Map(list.map(({ id, ...x }) => [id, x])))
        .catch(() => new Map()),
      get(scoped("/targets")),
      loaded.deviceDays,
      loaded.checkIns,
      rows("days", back, last),
      rows("activities", back, last),
      burned(min(back, p.from), p.to, { rows }),
    ]);
  const of = (from, to) => {
    const hc = deviceDays.filter((x) => inside(x, from, to));
    return {
      sleep: sleepSeries(hc),
      ...Object.fromEntries(
        ["steps", "resting_hr", "hrv_ms"].map((key) => [
          key,
          seriesOf(metricDays(key, hc), "value"),
        ]),
      ),
      ...checkInSeries(checkIns.filter((x) => inside(x, from, to))),
    };
  };
  const trailing = {
    ...of(back, last),
    ...eatenSeries(eaten),
    burned: seriesOf(
      spent.days.filter((x) => inside(x, back, last)),
      "kcal",
    ),
    minutes: everyDay(back, last, activities, (a) => a.minutes),
  };
  return {
    targets: Object.fromEntries(targets.map((t) => [t.metric, t])),
    deviceDays: deviceDays.filter((x) => inside(x, p.from, p.to)),
    checkIns: checkIns.filter((x) => inside(x, p.from, p.to)),
    series: of(p.from, p.to),
    burned: {
      ...spent,
      days: spent.days.filter((x) => inside(x, p.from, p.to)),
    },
    rows,
    trailing: { ...trailing, activities },
    window: { from: back, to: last },
    prefs,
    correlations: correlations(trailing, last),
  };
}

// -------------------------------------------------------------- charts

// What a period's charts are by (the period, not a pick): a week's and a
// month's points are days, a year's weeks (from Monday).
export const bucketOf = (kind) => (kind === "year" ? "week" : "day");
export const BUCKET = { day: (day) => day, week: weekStart };

// The bucket keys (`by`) of daily series ([{day, value}]), in order.
export const keysOf = (by, ...dailies) =>
  [...new Set(dailies.flat().map((x) => BUCKET[by](x.day)))].toSorted();

// One series as a chart draws it over `keys` (keysOf's): its points
// (`daily` [{day, value}] in day order, each bucket's mean) and its 7-day
// trend at each bucket's last day (from `lead` too, days before the
// period: its first point has its history), `round`ed; null where a bucket
// has none. `part(x)`, when given, names what kind of point a day's is (a
// method): each kind its own points mark, `${key}:${name}`, its `note` the
// name, so its shape and legend entry say which a point is (a bucket
// mixing kinds has a point in each); the trend reads them all. `partly`
// ({is(x), note}), when given, flags a bucket holding such a day: one
// point still, its mean over all its days, a floor ("≥", `note` why) in
// `partly` by bucket. Marks are {key, group (the series' `key`: its marks
// show and hide together), kind: "points" | "trend" | "line", label,
// data} (a line also its `value`). `trend: false`: the points alone
// (series-keys.mjs `trend`).
export function seriesMarks({
  key,
  label,
  daily,
  lead = [],
  by,
  keys,
  round = (v) => v,
  part = () => null,
  partly = null,
  trend: trended = true,
}) {
  // Each bucket's mean of `list`.
  const means = (list) =>
    new Map(
      [...Map.groupBy(list, (x) => BUCKET[by](x.day))].map(([k, xs]) => [
        k,
        mean(xs.map((x) => x.value)),
      ]),
    );
  const points = means(daily);
  const kinds = [...Map.groupBy(daily, (x) => part(x) ?? "")];
  const floors = new Set(
    partly
      ? daily.filter((x) => partly.is(x)).map((x) => BUCKET[by](x.day))
      : [],
  );
  const all = [...lead, ...daily];
  const at =
    all.length > 0 ? trendPer(trend(all, "value"), BUCKET[by]) : new Map();
  return [
    ...(kinds.length > 0 ? kinds : [["", []]]).map(([name, list]) => {
      const byBucket = means(list);
      return {
        key: name ? `${key}:${name}` : key,
        group: key,
        kind: "points",
        label,
        ...(name ? { note: name } : {}),
        data: keys.map((k) =>
          byBucket.has(k) ? round(byBucket.get(k)) : null,
        ),
        partly: keys.map((k) => floors.has(k)),
        ...(partly ? { partlyNote: partly.note } : {}),
      };
    }),
    trended && {
      key,
      group: key,
      kind: "trend",
      label: `${label} trend`,
      data: keys.map((k) =>
        points.has(k) && at.has(k) ? round(at.get(k).value) : null,
      ),
    },
  ].filter(Boolean);
}

// A round step (1, 2 or 5 × 10ⁿ) of about a fifth of `span`, never under
// `least`; null for no span.
export function niceStep(span, least = 0) {
  const raw = Math.max(span / 5, least);
  if (!(raw > 0)) return null;
  const ten = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 5, 10].map((m) => m * ten).find((x) => x >= raw * (1 - 1e-9));
}

// The decimals a step needs: 0.5 one, 20 none.
export const placesOf = (step) =>
  step === null ? 0 : Math.max(0, -Math.floor(Math.log10(step)));

// The y ticks of an axis from `lo` to `hi` (the data's, zoomed): round
// values a nice step apart inside it (never under 1 for whole units,
// `digits` 0), and each edge, the data's own lowest and highest, only
// where it sits more than half a step from the nearest round one, so no
// two labels collide. Numbers.
export function zoomTicks(lo, hi, digits = null) {
  const step = niceStep(hi - lo, digits === 0 ? 1 : 0);
  if (step === null) return [lo];
  const places = placesOf(step);
  const round = [];
  for (let i = Math.ceil(lo / step - 1e-9); i * step <= hi + 1e-9; i++)
    round.push(Number((i * step).toFixed(places)));
  const clear = (v) => round.every((t) => Math.abs(t - v) > step / 2);
  return [...(clear(lo) ? [lo] : []), ...round, ...(clear(hi) ? [hi] : [])];
}

// The range an axis spans at least, `span` (a change smaller than it isn't
// drawn as a cliff): around the data's middle, out to round steps
// (its edges are no data, so they read round too); a positive series stays
// at or above 0. [lo, hi].
export function spanAtLeast(lo, hi, span) {
  if (!(hi - lo < span)) return [lo, hi];
  const step = niceStep(span);
  const low = Math.max((lo + hi) / 2 - span / 2, lo >= 0 ? 0 : -Infinity);
  return [Math.floor(low / step) * step, Math.ceil((low + span) / step) * step];
}

// A target as a dashed line across the chart at `value`, `label` its name
// (marks of one `key` show and hide together), `text` said for screen
// readers.
const line = (key, label, value, keys, text) => ({
  key,
  kind: "line",
  target: true,
  label,
  value,
  data: keys.map(() => value),
  text,
});

// A target range as a field from `lo` to `hi` (a band's `low` and `high`
// edges, the space between filled), named and said once, on its `high`.
const field = (key, label, lo, hi, keys, text) => [
  {
    key,
    kind: "low",
    target: true,
    label,
    value: lo,
    data: keys.map(() => lo),
  },
  {
    key,
    kind: "high",
    target: true,
    label,
    value: hi,
    data: keys.map(() => hi),
    text,
  },
];

// A target ({value, min, max}) over `keys`, `label`led: a min–max range
// as a field, one value as a line, nothing without a target; in the shown
// unit (`show`, then `round`), `say` writing a value. A tooltip names it
// "Target", a line with its sign (at least, at most) as the bars do.
function targetLines(target, { label, keys, show, round, say }) {
  if (isNil(target?.value)) return [];
  const range =
    !isNil(target.min) && !isNil(target.max) && target.min !== target.max;
  const sign = isNil(target.max)
    ? !isNil(target.min) && GOAL_SIGN.at_least
    : isNil(target.min) && GOAL_SIGN.at_most;
  const marks = range
    ? field(
        "target",
        label,
        round(show(target.min)),
        round(show(target.max)),
        keys,
        `${label}: ${say(target.min)}–${say(target.max)}`,
      )
    : [
        line(
          "target",
          label,
          round(show(target.value)),
          keys,
          `${label}: ${say(target.value)}`,
        ),
      ];
  return marks.map((m) => ({ ...m, name: "Target", sign }));
}

// The lines of `marks` that would leave the data under half the y-axis
// start hidden (`hidden`; the legend shows them struck through, a tap
// shows them): one lying more than the data's own span beyond its lowest
// or highest. A flat series' span is 1 % of
// its value.
export function withHidden(marks) {
  const values = marks
    .filter((m) => m.kind === "points" || m.kind === "trend")
    .flatMap((m) => m.data)
    .filter((v) => !isNil(v));
  if (values.length === 0) return marks;
  const hi = Math.max(...values);
  const lo = Math.min(...values);
  const span = Math.max(hi - lo, Math.abs(hi) * 0.01);
  const far = (m) => m.value > hi + span || m.value < lo - span;
  // A field hides whole: when both its edges are far.
  const fields = new Map();
  for (const m of marks.filter((x) => x.target && x.kind !== "line"))
    fields.set(m.key, (fields.get(m.key) ?? true) && far(m));
  return marks.map((m) =>
    m.target
      ? { ...m, hidden: m.kind === "line" ? far(m) : fields.get(m.key) }
      : m,
  );
}

// Whether a day's eaten energy (a `/summary` day) leaves some out, as the
// Diary's "≥" says: a food without energy (`energy_unknown`) or a recipe
// with an ingredient without it (`known.energy`).
export const energyPartly = (d) =>
  Boolean(d.energy_unknown) || !isNil(d.known?.energy);

// A gap between eaten and burned, said to 10 kcal, of at most this a day is
// "about even": burned is an estimate, its mean within about this of the weight
// trend's balance over a month (−60 to +100 kcal, measured). The rounded gap is
// judged, so "≈ 100" is never beside the rule that calls it even.
const EVEN = 100;

// The most frequent of `list` (the first of a tie).
const mostCommon = (list) => {
  const n = new Map();
  for (const x of list) n.set(x, (n.get(x) ?? 0) + 1);
  return [...n].reduce((a, b) => (b[1] > a[1] ? b : a))[0];
};

// The balance's gap a day in words (`n` periodNumbers'), whole: "Deficit ≈
// 480 kcal a day", "Surplus ≈ …", "About even (within 100 kcal a day)".
// Eaten a floor (`partly`) makes eaten − burned a floor too: a
// deficit is at most, a surplus at least, and "about even" may be a
// surplus.
export function gapText(n) {
  const gap = energyText(estimateKcal(Math.abs(n.net)));
  if (n.word === "even")
    return whole(
      n.partly
        ? "About even, or a surplus"
        : `About even (within ${energyText(EVEN)} a day)`,
    );
  return whole(
    n.word === "deficit"
      ? `Deficit ${n.partly ? "≤" : "≈"} ${gap} a day`
      : `Surplus ${n.partly ? "≥" : "≈"} ${gap} a day`,
  );
}

// A gap a day eaten less used (`net` kcal; `partly`: eaten a floor) as
// gapText says it: `word` deficit, surplus, or even under EVEN (the
// rounded gap judged). The balance's against burned, or against a
// maintenance measured from the weight trend.
export const gapOf = (net, partly) => ({
  net,
  partly,
  word:
    round10(Math.abs(net)) <= EVEN ? "even" : net < 0 ? "deficit" : "surplus",
});

// A period's energy balance (ADR 0028) over its days over with food
// logged and a burned estimate (`days` /summary's, `burned` burnedDays'
// rows, `bmr` a bmrOf): how many (`n`), what was eaten (`partly` when a
// day's leaves some out: a lower bound), burned and the gap a day (`net`,
// `word` deficit, surplus, or even under EVEN), the source most of those
// days' burned came from, and burned's parts a day as burnedDay adds
// them: resting, TEF (of what was eaten), everyday movement (EVERYDAY ×
// resting, every day) and active (the rest: movement above everyday);
// `restingFrom` how many of those days' resting was Health Connect's
// (`health_connect`) and its app (`origin`, or null). Null without such
// a day (a period starting today has none).
export function periodNumbers({ days, burned: spent, bmr }) {
  const of = new Map(spent.map((b) => [b.day, b]));
  const both = days.filter((d) => foodDay(d) && of.has(d.day) && bmr(d.day));
  if (both.length === 0) return null;
  const per = (f) => both.reduce((t, d) => t + f(d), 0) / both.length;
  const parts = (d) => {
    const resting = bmr(d.day).kcal;
    const tef = TEF * d.total.energy;
    const everyday = EVERYDAY * resting;
    return {
      resting,
      tef,
      everyday,
      active: Math.max(0, of.get(d.day).kcal - resting - tef - everyday),
    };
  };
  const part = (key) => per((d) => parts(d)[key]);
  const net = per((d) => d.total.energy - of.get(d.day).kcal);
  return {
    n: both.length,
    eaten: per((d) => d.total.energy),
    burned: per((d) => of.get(d.day).kcal),
    ...gapOf(
      net,
      both.some((x) => energyPartly(x)),
    ),
    source: mostCommon(both.map((d) => of.get(d.day).source)),
    resting: part("resting"),
    restingFrom: (() => {
      const hc = both
        .map((d) => bmr(d.day))
        .filter((r) => r.source === "health_connect");
      return {
        health_connect: hc.length,
        origin: hc.length > 0 ? mostCommon(hc.map((r) => r.origin)) : null,
      };
    })(),
    tef: part("tef"),
    everyday: part("everyday"),
    active: part("active"),
  };
}

// The energy chart: exactly what was eaten (food days, a
// partial day's point "≥": a floor) and what was burned (`burned` [{day,
// kcal}], from the first food day; an estimate, "≈", to 10 kcal), each its
// points and trend, and the energy target. By week, burned is over the
// same days as eaten, the week's food days: a week's two means set the
// same days against each other. `show` converts kcal to the shown
// unit, `say` writes a stored value. {keys, marks}.
export function energySeries({ days, burned: spent, target, by, show, say }) {
  const eaten = days
    .filter((x) => foodDay(x))
    .map((d) => ({
      day: d.day,
      value: show(d.total.energy),
      partly: energyPartly(d),
    }));
  // Burned from the first food day on: before it there's nothing to set it
  // against (and resting alone would draw a line of no evidence).
  const first = eaten[0]?.day;
  const fed = new Set(eaten.map((d) => d.day));
  const out = spent
    .filter((b) => first && b.day >= first && (by === "day" || fed.has(b.day)))
    .map((b) => ({ day: b.day, value: show(b.kcal) }));
  const keys = keysOf(by, eaten, out);
  const round = Math.round;
  return {
    keys,
    marks: withHidden([
      ...seriesMarks({
        key: "eaten",
        label: "Eaten",
        daily: eaten,
        by,
        keys,
        round,
        partly: { is: (x) => x.partly, note: "some energy unknown" },
      }),
      ...seriesMarks({
        key: "burned",
        label: "Burned ≈",
        daily: out,
        by,
        keys,
        round: round10,
      }),
      // The target is what to eat: eaten's, named so.
      ...targetLines(target, {
        label: "Eaten target",
        keys,
        show,
        round,
        say,
      }),
    ]),
  };
}

// A macro's chart: the grams of `key` each food day, points and
// trend, and its target, `label` its name. {keys,
// marks}.
export function macroSeries({ days, key, label, target, by, say }) {
  // A day whose food didn't all carry it is a floor.
  const daily = days
    .filter((x) => foodDay(x))
    .map((d) => ({
      day: d.day,
      value: d.total[key] ?? 0,
      partly: coverage([d], key) < 1,
    }));
  const keys = keysOf(by, daily);
  const round = Math.round;
  return {
    keys,
    marks: withHidden([
      ...seriesMarks({
        key,
        label,
        daily,
        by,
        keys,
        round,
        part: (x) => (x.partly ? "≥ (not all known)" : null),
      }),
      ...targetLines(target, {
        label: `${label} target`,
        keys,
        show: (v) => v,
        round,
        say,
      }),
    ]),
  };
}

const roundTenth = (v) => Math.round(v * 10) / 10;

// The recommended BMI range on `day` for someone born `birth`, from
// `table` (meta.limits.recommended_bmi: [from age, min, max] rows, the
// last one reached applies): [min, max]; null under the first row's age
// or without a birth date.
export function bmiRange(birth, day, table) {
  if (!birth) return null;
  const age = ageOn(birth, day);
  const row = table.findLast(([from]) => age >= from);
  return row ? [row[1], row[2]] : null;
}

// The Body chart's lines for series `key` over `keys`, in the shown unit `unit`
// (`show` from stored): its goal (`goal`, series-keys.mjs: weight, body fat,
// muscle; `targets` by metric) when set; for BMI the recommended range for
// `person`'s age on `day` (bmiRange of `table`) and, with a goal weight and a
// height, the goal's BMI. Each said to the tenth.
export function bodyLines({
  key,
  keys,
  targets,
  person,
  day,
  table,
  unit,
  show,
}) {
  const said = (label, v) => `${label}: ${qty(v, unit, 1)}`;
  const { goal } = seriesInfo(key);
  if (goal) {
    const v = targets[goal]?.value;
    return isNil(v)
      ? []
      : [
          line(
            "target",
            "Goal",
            roundTenth(show(v)),
            keys,
            said("Goal", roundTenth(show(v))),
          ),
        ];
  }
  if (key !== "bmi") return [];
  const range = bmiRange(person.birth_date, day, table) ?? [];
  const kg = targets.goal_weight?.value;
  const goalBmi =
    isNil(kg) || !person.height_cm
      ? null
      : roundTenth(kg / (person.height_cm / 100) ** 2);
  return [
    ...(range.length === 2
      ? field(
          "recommended",
          "Recommended BMI",
          range[0],
          range[1],
          keys,
          `Recommended BMI: ${range[0]}–${qty(range[1], unit, 1)}`,
        )
      : []),
    ...(goalBmi === null
      ? []
      : [line("goal", "Goal BMI", goalBmi, keys, said("Goal BMI", goalBmi))]),
  ];
}
