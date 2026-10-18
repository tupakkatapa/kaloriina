// Correlations (ADR 0030), two tiers over the trailing 90 days whatever
// period is shown, each named only when it clears every gate (none rather
// than weak): a few pre-registered pairs (`correlations`), and the
// discovery tier (`discover`) over every daily series, held to stricter
// gates. No DOM here, so `node --test` covers it.
//
// Series are web/insights.mjs's ({values, samples}, optionally `label`,
// `say`, `domain`, `groups`, `night`: see `describe`); pairs read day d's
// outcome against day d − lag's other side (`pairDays`).

import { pretty, shift, today, weekday } from "./dates.mjs";
import { fmt, lower } from "./format.mjs";
import { seriesInfo } from "./series-keys.mjs";
import { mean } from "./stats.mjs";

// How two series pair by day, for `contrast` (web/insights.mjs) and
// correlations: each sample day d of `outcome` with the day its
// other side is read on, d − `by`. [[d − by, d]].
export const pairDays = (outcome, by = 0) =>
  outcome.samples.map((d) => [by ? shift(d, -by) : d, d]);

// The window, the lags, the paired days a test needs, the smallest |ρ|
// named and the false discovery rate kept across every test made.
export const WINDOW_DAYS = 90;
const LAGS = [0, 1];
// Outcomes read over a night and filed under the day it ended (sleep,
// overnight HRV) or a day's resting heart rate, mostly measured asleep:
// at lag 0 that night came before day d's other side, so only lag 1 (the
// night after) runs forward in time.
const NIGHT = new Set([
  "sleep",
  "deep_min",
  "rem_min",
  "light_min",
  "hrv_ms",
  "resting_hr",
]);
const isNight = (key, s) => s?.night ?? NIGHT.has(key);
const lagsOf = (y, lags = LAGS, s = null) =>
  isNight(y, s) ? lags.filter((l) => l >= 1) : lags;
const MIN_PAIRS = 28;
const MIN_RHO = 0.4;
export const Q = 0.1;

// Each pair: the series read first (`x`, on d − lag), the outcome (`y`, on
// d), and the Highlight `covers` when a contrast already says it.
// Pre-registered, ≤ 10, none coupled by definition.
const PAIRS = [
  ["sleep", "energy", "sleep:energy"],
  ["sleep", "checkin:mood", "sleep:checkin-mood"],
  ["sleep", "checkin:energy", "sleep:checkin-energy"],
  ["steps", "sleep"],
  ["minutes", "sleep", "activity:sleep"],
  ["alcohol", "sleep", "alcohol:sleep"],
  ["alcohol", "resting_hr"],
  ["alcohol", "hrv_ms"],
  ["caffeine", "sleep"],
  ["checkin:stress", "sleep"],
];

// Series `key` (`s` its series) described: {label, say, domain, groups,
// night}, the series' own fields over the registry's (web/series-keys.mjs).
export function describe(key, s = {}) {
  const { label, say, domain, groups } = seriesInfo(key);
  return {
    label: s.label ?? label,
    say: s.say ?? say,
    domain: s.domain ?? domain,
    groups: s.groups ?? groups,
    night: isNight(key, s),
  };
}

// Whether two series are coupled by definition (energy and a nutrient
// share of it, hydration and water, steps and activity minutes, sleep and
// its stages, …): they share a group.
const coupled = (a, b) => a.groups.some((g) => b.groups.includes(g));

// Each value's rank from 1, ties sharing their average.
// Sorted as indices in a typed array: no pair per value.
export function ranks(values) {
  const order = new Uint32Array(values.length);
  for (let i = 0; i < order.length; i++) order[i] = i;
  order.sort((a, b) => values[a] - values[b]);
  const out = Array.from(values);
  for (let i = 0; i < order.length; ) {
    let j = i;
    while (j + 1 < order.length && values[order[j + 1]] === values[order[i]])
      j++;
    for (let k = i; k <= j; k++) out[order[k]] = (i + j) / 2 + 1;
    i = j + 1;
  }
  return out;
}

// Spearman's ρ (Pearson on the ranks); null when a side is constant.
export const spearman = (xs, ys) => pearson(ranks(xs), ranks(ys));

// Pearson's r of two rank lists; null when a side is constant.
function pearson(a, b) {
  const ma = mean(a);
  const mb = mean(b);
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < a.length; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da && db ? num / Math.sqrt(da * db) : null;
}

// `s` less each weekday's mean, so a weekly rhythm two series share (long
// weekend nights, weekend moods) isn't read as one driving the other.
export function demean(s) {
  const by = Array.from({ length: 7 }, () => []);
  for (const d of s.samples) by[weekday(d)].push(s.values.get(d) ?? 0);
  const means = by.map((list) => (list.length > 0 ? mean(list) : 0));
  return {
    ...s,
    values: new Map(
      s.samples.map((d) => [d, (s.values.get(d) ?? 0) - means[weekday(d)]]),
    ),
  };
}

// The standard normal CDF (Abramowitz & Stegun 7.1.26, error < 1.5e-7).
function normal(z) {
  const t = 1 / (1 + (0.3275911 * Math.abs(z)) / Math.SQRT2);
  const poly =
    t *
    (0.254829592 +
      t *
        (-0.284496736 +
          t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - poly * Math.exp(-(z * z) / 2);
  return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

// A two-sided p for ρ over n pairs: Fisher's z with Spearman's variance
// 1.06 / (n − 3) (Fieller, Hartley & Pearson, Biometrika 1957).
const pValue = (rho, n) => {
  const z =
    Math.atanh(Math.min(Math.abs(rho), 0.999999)) * Math.sqrt((n - 3) / 1.06);
  return 2 * (1 - normal(z));
};

// Mann–Whitney U of samples `a` against `b`, two-sided: {p, r}. p by the
// normal approximation with the tie and continuity corrections (Lehmann,
// Nonparametrics 1975); `r` the rank-biserial correlation, 2U/(n₁n₂) − 1
// (Kerby, Compr Psychol 2014): above 0 when `a` ranks higher. Ranks, as
// Spearman's ρ, so a contrast and a correlation share one kind of test.
export function mannWhitney(a, b) {
  const [n1, n2] = [a.length, b.length];
  const n = n1 + n2;
  const all = [...a, ...b];
  const r = ranks(all);
  let u = -(n1 * (n1 + 1)) / 2;
  for (let i = 0; i < n1; i++) u += r[i];
  const ties = [...Map.groupBy(all, (v) => v).values()].reduce(
    (t, list) => t + list.length ** 3 - list.length,
    0,
  );
  const sigma = Math.sqrt(((n1 * n2) / 12) * (n + 1 - ties / (n * (n - 1))));
  const z = (Math.abs(u - (n1 * n2) / 2) - 0.5) / sigma;
  return {
    // Every value tied: nothing to tell apart.
    p: sigma ? Math.min(1, 2 * (1 - normal(Math.max(0, z)))) : 1,
    r: (2 * u) / (n1 * n2) - 1,
  };
}

// Benjamini–Hochberg at `q`: which of `ps` pass (the largest k with
// p(k) ≤ k/m · q, and every smaller p).
export function bh(ps, q = Q) {
  const order = ps.map((p, i) => [p, i]).toSorted((a, b) => a[0] - b[0]);
  let k = 0;
  order.forEach(([p], i) => {
    if (p <= ((i + 1) / ps.length) * q) k = i + 1;
  });
  const out = ps.map(() => false);
  for (let i = 0; i < k; i++) out[order[i][1]] = true;
  return out;
}

// When the outcome is read, from the pair and the lag, each phrase naming
// one time. A night is filed under the day it ended: a night-read cause
// (sleep) at lag 0 is the night before day d ("the next day"), at lag 1
// the night before d − 1 ("the day after next"). A night-read outcome is
// lag ≥ 1 only (see NIGHT): the night after the cause's day; resting HR
// reads as the day it is filed under.
const LATER = ["the same day", "the next day", "two days later"];
export function when(x, y, lag) {
  if (isNight(y)) {
    if (y === "resting_hr") return LATER[lag];
    return lag === 1 ? "the night after" : "the second night after";
  }
  if (isNight(x))
    return ["the next day", "the day after next", "three days later"][lag];
  return LATER[lag];
}

// ρ to two places, in the browser's locale as every number shown (fmt).
const TWO = new Intl.NumberFormat(undefined, {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

// "last 90 days", or "90 days to Sep 30" for a window ended before
// yesterday.
const windowWords = (end) =>
  end === shift(today(), -1)
    ? `last ${WINDOW_DAYS} days`
    : `${WINDOW_DAYS} days to ${pretty(end, false)}`;

// The window ending `through` (never past yesterday: a future day has no
// data and would shrink the window): {end, raw, prepared}, each series
// clipped to it, and weekday-demeaned in `prepared`.
function windowed(series, through) {
  const yesterday = shift(today(), -1);
  const end = through < yesterday ? through : yesterday;
  const from = shift(end, 1 - WINDOW_DAYS);
  const inside = (d) => d >= from && d <= end;
  const raw = Object.fromEntries(
    Object.entries(series).map(([k, s]) => [
      k,
      { ...s, samples: s.samples.filter(inside) },
    ]),
  );
  const prepared = Object.fromEntries(
    Object.entries(raw).map(([k, s]) => [k, demean(s)]),
  );
  return { end, raw, prepared };
}

// One pair × lag test of the prepared series: {days, rho} over the days
// both have, or null under `min` days or with a constant side. `paired`
// gives b's pairDays at a lag (memoised by `discover`: day arithmetic is
// most of a test's cost), and `ranked` a side's ranks on all its samples.
function tested(a, b, lag, min, paired = pairDays, ranked = null) {
  const xs = a.set ?? new Set(a.samples);
  const days = paired(b, lag).filter(([at]) => xs.has(at));
  if (days.length < min) return null;
  // A side paired on every sample ranks the same values whatever the pair
  // or lag (in day order: pairDays keeps it), so `ranked` keeps its ranks.
  const side = (s, values) =>
    ranked && days.length === s.samples.length
      ? ranked(s, values)
      : ranks(values);
  const rho = pearson(
    side(
      a,
      days.map(([at]) => a.values.get(at)),
    ),
    side(
      b,
      days.map(([, d]) => b.values.get(d)),
    ),
  );
  return rho === null ? null : { days, rho };
}

// A tested pair as the contrast its numbers line reads (ADR 0030, cards):
// the outcome's mean on the days whose cause was over its median against
// the rest, raw (not demeaned). "Mood 0.4 higher the next day after sleep
// over 7 h 10 min (45 vs 44 days)".
function contrastLine(t, raw) {
  const a = raw[t.x];
  const b = raw[t.y];
  const X = describe(t.x, a);
  const Y = describe(t.y, b);
  const pairs = t.days.map(([at, d]) => [
    a.values.get(at) ?? 0,
    b.values.get(d) ?? 0,
  ]);
  const sorted = pairs.map(([v]) => v).toSorted((p, q) => p - q);
  const median = sorted[Math.floor(sorted.length / 2)];
  // Over the median, or at least it when nothing is over (ties at the top).
  const over = pairs.some(([v]) => v > median);
  const high = (v) => (over ? v > median : v >= median);
  const hi = pairs.filter(([v]) => high(v)).map(([, w]) => w);
  const lo = pairs.filter(([v]) => !high(v)).map(([, w]) => w);
  const diff = mean(hi) - mean(lo);
  const time = when(t.x, t.y, t.lag);
  // "the night after" already says it: "after" once.
  const after =
    time === "the same day"
      ? "on days with"
      : time.endsWith(" after")
        ? time
        : `${time} after`;
  const cause =
    over && median === 0
      ? `any ${lower(X.label)}`
      : `${lower(X.label)} ${over ? "over" : "of at least"} ${X.say(median)}`;
  return `${Y.label} ${Y.say(Math.abs(diff))} ${diff > 0 ? "higher" : "lower"} ${after} ${cause} (${fmt(hi.length)} vs ${fmt(lo.length)} days)`;
}

// The chart a tested pair links to: both raw series over the window, the
// cause `lag` days before.
const chartLink = (t, raw) => ({
  to: "chart",
  x: t.x,
  y: t.y,
  xs: raw[t.x],
  ys: raw[t.y],
  lag: t.lag,
});

// The pre-registered pairs that clear every gate over the WINDOW_DAYS
// ending `through` (`windowed`), one per pair at its strongest lag,
// strongest first: ≥ MIN_PAIRS days with
// both (each weekday-demeaned), a side not constant, |ρ| ≥ MIN_RHO, and BH
// q ≤ Q across every pair × lag tested. Each a card (insights.mjs) with
// `x`, `y`, `lag`, `rho`, `n`, `tests` (m) and `covers`.
export function correlations(series, through) {
  const { end, raw, prepared } = windowed(series, through);
  const done = [];
  for (const [x, y, covers] of PAIRS) {
    const a = prepared[x];
    const b = prepared[y];
    if (!a || !b) continue;
    for (const lag of lagsOf(y)) {
      const t = tested(a, b, lag, MIN_PAIRS);
      if (!t) continue;
      done.push({ ...t, x, y, lag, covers, p: pValue(t.rho, t.days.length) });
    }
  }
  const passed = bh(done.map((t) => t.p));
  // One card per pair, its strongest lag, as discovery keeps it: two lags
  // of one pair are one finding.
  const best = new Map();
  done.forEach((t, i) => {
    const pair = `${t.x}~${t.y}`;
    if (!passed[i] || Math.abs(t.rho) < MIN_RHO) return;
    if (!(Math.abs(best.get(pair)?.rho) >= Math.abs(t.rho))) best.set(pair, t);
  });
  return [...best.values()]
    .map((t) => {
      const X = describe(t.x, raw[t.x]);
      const Y = describe(t.y, raw[t.y]);
      return {
        id: `corr:${t.x}:${t.y.replace("checkin:", "checkin-")}:${t.lag}`,
        tone: "correlation",
        headline: `${X.label} → ${lower(Y.label)}`,
        numbers: `${contrastLine(t, raw)} · ${windowWords(end)}`,
        detail: `Spearman ρ ${TWO.format(t.rho)} over ${t.days.length} days, ${lower(Y.label)} read ${when(t.x, t.y, t.lag)}, weekday rhythms removed; one of ${done.length} pre-registered tests, Benjamini–Hochberg q ≤ ${Q}. Moving together isn't cause.`,
        margin: Math.abs(t.rho) / MIN_RHO,
        link: chartLink(t, raw),
        x: t.x,
        y: t.y,
        lag: t.lag,
        rho: t.rho,
        n: t.days.length,
        tests: done.length,
        covers: t.covers ?? null,
      };
    })
    .toSorted((a, b) => b.margin - a.margin);
}

// The discovery tier: every pair of daily series, held to stricter gates
// than the pre-registered (more tests, more false leads): lags 0–2 (night
// outcomes ≥ 1), ≥ D_MIN_PAIRS days, |ρ| ≥ D_MIN_RHO, BH q ≤ D_Q across
// every discovery test, and replicated: the same sign and |ρ| ≥ HALF_RHO
// in each chronological half.
const D_LAGS = [0, 1, 2];
const D_MIN_PAIRS = 42;
const D_MIN_RHO = 0.5;
const D_Q = 0.05;
const HALF_RHO = 0.3;

// The pre-registered pairs, either way round: the discovery tier leaves
// them to `correlations`.
const REGISTERED = new Set(
  PAIRS.flatMap(([x, y]) => [`${x}~${y}`, `${y}~${x}`]),
);

// One stable id per pair of series, whichever leads and at whatever lag:
// what "Hide" and "Interesting" keep.
const patternId = (a, b) => `pattern:${[a, b].toSorted().join("~")}`;

// ρ of a tested pair's days `days` ([[at, d]]) in the prepared `a`, `b`.
const rhoOf = (a, b, days) =>
  spearman(
    days.map(([at]) => a.values.get(at)),
    days.map(([, d]) => b.values.get(d)),
  );

// A slice of `discover` gives the main thread back after this long, so a
// tap waits no more.
const SLICE_MS = 40;
const pause = () =>
  globalThis.scheduler?.yield?.() ??
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

// Patterns found among `series` over the WINDOW_DAYS ending `through`,
// clearing every discovery gate; one per pair (its strongest lag),
// strongest first. Each a card ("Possible pattern", tone `correlation`:
// "X tends to go with Y", never a cause) with `x`, `y`, `lag`, `rho`, `n`,
// `halves`, `tests` and `discovered`.
// Async: it yields every SLICE_MS.
export async function discover(series, through) {
  const { end, raw, prepared } = windowed(series, through);
  const keys = Object.keys(prepared).filter(
    (k) => prepared[k].samples.length >= D_MIN_PAIRS,
  );
  const about = Object.fromEntries(
    keys.map((k) => [k, describe(k, prepared[k])]),
  );
  for (const k of keys) prepared[k].set = new Set(prepared[k].samples);
  const memo = new Map();
  const paired = (s, lag) => {
    if (!memo.has(s)) memo.set(s, []);
    return (memo.get(s)[lag] ??= pairDays(s, lag));
  };
  // Ranks per series, on all its samples (see `tested`).
  const ranksOf = new Map();
  const ranked = (s, values) => {
    if (!ranksOf.has(s)) ranksOf.set(s, ranks(values));
    return ranksOf.get(s);
  };
  // Series `p` and `q` tested each way round at each lag. Lag 0 pairs
  // the same days either way round: tested once.
  const pairTests = (p, q) => {
    const out = [];
    let sameDay = false;
    for (const [x, y] of [
      [p, q],
      [q, p],
    ])
      for (const lag of lagsOf(y, D_LAGS, prepared[y])) {
        if (lag === 0 && sameDay) continue;
        sameDay ||= lag === 0;
        const t = tested(
          prepared[x],
          prepared[y],
          lag,
          D_MIN_PAIRS,
          paired,
          ranked,
        );
        if (t) out.push({ ...t, x, y, lag, p: pValue(t.rho, t.days.length) });
      }
    return out;
  };
  const done = [];
  let slice = performance.now();
  for (let i = 0; i < keys.length; i++)
    for (let j = i + 1; j < keys.length; j++) {
      if (performance.now() - slice > SLICE_MS) {
        await pause();
        slice = performance.now();
      }
      const [p, q] = [keys[i], keys[j]];
      if (coupled(about[p], about[q]) || REGISTERED.has(`${p}~${q}`)) continue;
      done.push(...pairTests(p, q));
    }
  const passed = bh(
    done.map((t) => t.p),
    D_Q,
  );
  const best = new Map();
  done.forEach((t, i) => {
    if (!passed[i] || Math.abs(t.rho) < D_MIN_RHO) return;
    const half = Math.floor(t.days.length / 2);
    const halves = [t.days.slice(0, half), t.days.slice(half)].map((days) =>
      rhoOf(prepared[t.x], prepared[t.y], days),
    );
    const replicated = halves.every(
      (r) =>
        r !== null &&
        Math.sign(r) === Math.sign(t.rho) &&
        Math.abs(r) >= HALF_RHO,
    );
    const id = patternId(t.x, t.y);
    if (replicated && !(Math.abs(best.get(id)?.rho) >= Math.abs(t.rho)))
      best.set(id, { ...t, halves });
  });
  return [...best]
    .map(([id, t]) => {
      const X = describe(t.x, raw[t.x]);
      const Y = describe(t.y, raw[t.y]);
      return {
        id,
        tone: "correlation",
        headline: "Possible pattern",
        numbers: `Higher ${lower(X.label)} tends to go with ${t.rho > 0 ? "higher" : "lower"} ${lower(Y.label)} ${when(t.x, t.y, t.lag)} · ${windowWords(end)}`,
        detail: `${contrastLine(t, raw)}. Spearman ρ ${TWO.format(t.rho)} over ${t.days.length} days (each half: ${t.halves.map((r) => TWO.format(r)).join(" and ")}), weekday rhythms removed; found among ${fmt(done.length)} pairings tested, Benjamini–Hochberg q ≤ ${D_Q}. A pattern worth following, not a cause.`,
        margin: Math.abs(t.rho) / D_MIN_RHO,
        link: chartLink(t, raw),
        x: t.x,
        y: t.y,
        lag: t.lag,
        rho: t.rho,
        n: t.days.length,
        halves: t.halves,
        tests: done.length,
        discovered: true,
      };
    })
    .toSorted((a, b) => b.margin - a.margin);
}

// The results of `list` touching subtab `tab`'s domain.
export const touching = (list, tab) =>
  list.filter(
    (r) =>
      describe(r.x, r.link?.xs).domain.includes(tab) ||
      describe(r.y, r.link?.ys).domain.includes(tab),
  );
