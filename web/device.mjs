// A device day from Health Connect as the Log card reads it: steps and
// active energy, the night that ended the day, and the day's heart; a
// period's sleep averages; a night's hypnogram. No DOM here, so
// `node --test` covers it.

import { clockOf, duration } from "./dates.mjs";
import { activeMark } from "./energy-text.mjs";
import { isNil, NBSP, plural, whole } from "./format.mjs";
import { kcal as energy, kcalParts } from "./nutrients.mjs";

// A Log row's text, `{ value, detail }` (detail null when none), or null
// with no parts. The value is the headline, the detail its parts joined by
// " · "; spaces inside a part are no-break, so a line breaks only between
// parts.
const rowText = (parts) => {
  const [value, ...rest] = parts.filter(Boolean).map((x) => whole(x));
  return value
    ? { value, detail: rest.length > 0 ? rest.join(" · ") : null }
    : null;
};

// "9,120 steps" over "Active 512 kcal" ("512 of 600 kcal" against the
// Active energy `target`): a day's steps and active energy (series.mjs
// dayEnergy), marked as energy-text.mjs activeMark says: "≥" from
// activities alone (`floor`), "≈" with an estimate in it (`estimated`),
// none when measured. Shown, never added to the energy target.
export const activityText = (
  { active_kcal, steps, floor = false, estimated = false } = {},
  target = null,
) =>
  rowText([
    isNil(steps) ? null : plural(steps, "step"),
    isNil(active_kcal)
      ? null
      : `Active ${activeMark({ floor, estimated })}${ofTarget(active_kcal, target)}`,
  ]);

// "512 kcal", or "512 of 600 kcal" against `target`.
const ofTarget = (value, target) => {
  if (isNil(target)) return energy(value);
  const of = kcalParts(target);
  return `${kcalParts(value).value} of ${of.value}${NBSP}${of.unit}`;
};

// "7 h 20 min asleep" over "23:40–07:05 · 7 h 50 min in bed · 94 %
// efficiency · deep 1 h 10 min (16 %) · REM … · light … · heart rate
// asleep 55 bpm · + 25 min nap": the day's night (its time asleep the
// value, its facts as known the detail: each stage's share of the night
// asleep, by largest remainder) and, after it, its naps. The server's
// `total_asleep_min` adds the naps' time asleep (`asleep_min` doesn't); a
// nap without stages adds only time in bed (`nap_in_bed_min`), said so and
// never counted asleep. A day of naps only leads with them. Null without
// either. Summary's Sleep calendar names each night so.
export const nightText = (a = {}) => {
  const night = a.asleep_min;
  const inBed = a.nap_in_bed_min ?? 0;
  const napped = isNil(a.total_asleep_min)
    ? 0
    : a.total_asleep_min - (night ?? 0);
  if (isNil(night) && !napped && !inBed) return null;
  const naps = napsText(a.naps ?? (napped || inBed ? 1 : 0), napped, inBed);
  if (isNil(night)) return rowText([naps]);
  return rowText([...nightFacts(a), naps ? `+ ${naps}` : null]);
};

// nightText's naps: `count` of them, `napped` min asleep in the staged
// ones, `inBed` min in bed in the others. Null with none.
function napsText(count, napped, inBed) {
  // Mixed, the time asleep is the staged naps' and the time in bed the
  // others': said apart.
  const mixed = napped && inBed;
  const parts = [
    napped ? `${duration(napped)}${mixed ? " asleep" : ""}` : null,
    inBed
      ? `${duration(inBed)} in bed${mixed ? " without sleep data" : ""}`
      : null,
  ]
    .filter(Boolean)
    .join(", ");
  return count
    ? count === 1
      ? `${parts} nap`
      : `${count} naps${mixed ? ":" : ","} ${parts}`
    : null;
}

// nightText's night: its time asleep, then bed and wake times, time in
// bed, efficiency, each stage (its share of the time asleep), and the heart
// rate asleep, as known.
function nightFacts(a) {
  const night = a.asleep_min;
  const staged = SLEEP_STAGES.map(({ key }) => [key, a[`${key}_min`] ?? 0]);
  const shares = sharesOf({
    ...Object.fromEntries(staged),
    // Asleep in no known stage (or a minute of rounding): its share unsaid.
    other: Math.max(0, night - staged.reduce((t, [, v]) => t + v, 0)),
  });
  return [
    `${duration(night)} asleep`,
    a.bedtime && a.wake_time
      ? `${clockOf(a.bedtime)}–${clockOf(a.wake_time)}`
      : null,
    a.in_bed_min ? `${duration(a.in_bed_min)} in bed` : null,
    night && a.in_bed_min
      ? `${percentOf(night, a.in_bed_min)}${NBSP}% efficiency`
      : null,
    ...SLEEP_STAGES.map(({ key, word }) =>
      isNil(a[`${key}_min`])
        ? null
        : `${word} ${duration(a[`${key}_min`])}${night ? ` (${shares[key]}${NBSP}%)` : ""}`,
    ),
    isNil(a.sleep_avg_hr)
      ? null
      : `heart rate asleep ${a.sleep_avg_hr}${NBSP}bpm`,
  ];
}

// Whole % shares of `parts` (key → amount) that sum to 100: each rounded
// down, the rest going to the largest remainders (Hamilton's method); all
// 0 without a total.
export function sharesOf(parts) {
  const total = Object.values(parts).reduce((t, v) => t + v, 0);
  const exact = Object.entries(parts).map(([k, v]) => [
    k,
    total ? (v / total) * 100 : 0,
  ]);
  const out = Object.fromEntries(exact.map(([k, v]) => [k, Math.floor(v)]));
  const left = total ? 100 - Object.values(out).reduce((t, v) => t + v, 0) : 0;
  exact
    .toSorted((a, b) => (b[1] % 1) - (a[1] % 1))
    .slice(0, left)
    .forEach(([k]) => (out[k] += 1));
  return out;
}

// `days` (device days) with the heart rate of a day not yet over (from
// `today`) left out: its average, lowest and highest are the day so far.
// The resting heart rate and HRV are the night's, so they stay.
export const heartDaysOver = (days, today) =>
  days.map((d) =>
    d.day < today ? d : { ...d, avg_hr: null, min_hr: null, max_hr: null },
  );

// "142 bpm avg, 171 max": an activity's heart rate from the device; null
// without an average.
export const activityHeartText = ({ avg_hr, max_hr } = {}) =>
  isNil(avg_hr)
    ? null
    : `${avg_hr}${NBSP}bpm avg${isNil(max_hr) ? "" : `, ${max_hr}${NBSP}max`}`;

const DAY_MIN = 1440;
// "HH:MM" → minutes after midnight, and back (any minutes, mod 1440).
export const minutesOf = (hhmm) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};
export const hhmm = (min) => {
  const m = ((Math.round(min) % DAY_MIN) + DAY_MIN) % DAY_MIN;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};
// The circular mean of clock times (minutes): 23:50 and 00:10 average
// 00:00, never noon.
const clockMean = (list) => {
  const a = list.map((m) => (m / DAY_MIN) * 2 * Math.PI);
  const sin = a.reduce((t, x) => t + Math.sin(x), 0);
  const cos = a.reduce((t, x) => t + Math.cos(x), 0);
  return (Math.atan2(sin, cos) / (2 * Math.PI)) * DAY_MIN;
};
// From `mean` to `m` the short way round, −720..720 minutes.
const around = (m, mean) =>
  ((((m - mean) % DAY_MIN) + DAY_MIN * 1.5) % DAY_MIN) - DAY_MIN / 2;

// Nights the clock averages need.
export const MIN_NIGHTS = 3;

// The nights among `days` (device days): minutes asleep a night (the
// night's alone: naps are their own figure), and with MIN_NIGHTS or more
// the average bedtime and wake-up ("HH:MM", circular means) and the
// bedtime spread (the population SD, minutes); and over every day, the
// naps: how many, minutes asleep in them, and whether some were only time
// in bed (`partial`: asleep is then at least so much). Null without a
// night.
export function sleepStats(days) {
  const nights = days.filter((d) => !isNil(d.asleep_min) && d.bedtime);
  if (nights.length === 0) return null;
  const asleep = nights.reduce((t, d) => t + d.asleep_min, 0) / nights.length;
  const naps = {
    count: days.reduce((t, d) => t + (d.naps ?? 0), 0),
    asleep: days.reduce(
      (t, d) =>
        t +
        (isNil(d.total_asleep_min)
          ? 0
          : d.total_asleep_min - (d.asleep_min ?? 0)),
      0,
    ),
    partial: days.some((d) => d.nap_in_bed_min > 0),
  };
  if (nights.length < MIN_NIGHTS)
    return {
      nights: nights.length,
      asleep,
      naps,
      bedtime: null,
      spread: null,
      wake: null,
    };
  const beds = nights.map((d) => minutesOf(d.bedtime));
  const bed = clockMean(beds);
  const spread = Math.sqrt(
    beds.reduce((t, m) => t + around(m, bed) ** 2, 0) / beds.length,
  );
  return {
    nights: nights.length,
    asleep,
    naps,
    bedtime: hhmm(bed),
    spread,
    wake: hhmm(clockMean(nights.map((d) => minutesOf(d.wake_time)))),
  };
}

// A night's shade on the Sleep calendar against the sleep `goal`
// (minutes asleep): 1 under an hour short, 2 within the hour short, 3 from
// the goal to an hour over, 4 an hour or more over; 0 without a night. Each
// step starts at its bound, so a night at the goal shades as one that
// reached it (its ✓ is "the goal or more").
export const GOAL_STEP_MIN = 60;
export const goalShade = (min, goal) =>
  min > 0
    ? 1 +
      [goal - GOAL_STEP_MIN, goal, goal + GOAL_STEP_MIN].filter((b) => min >= b)
        .length
    : 0;

// How far a night's bedtime or wake-up may be from its target (minutes)
// and still keep the schedule: the `bedtime`/`wake_time` targets' window.
export const ON_SCHEDULE_MIN = 30;

// Whether the night ending day `d` (an activity day) kept the schedule:
// its bedtime and wake-up each within ON_SCHEDULE_MIN of `bedtime` and
// `wake` (target minutes, compared mod 1440; one not set isn't checked).
// Null without a night or without either target.
export function onSchedule(d, bedtime, wake) {
  if ((isNil(bedtime) && isNil(wake)) || !d.bedtime || !d.wake_time)
    return null;
  const kept = (clock, target) =>
    isNil(target) ||
    Math.abs(around(minutesOf(clock), target)) <= ON_SCHEDULE_MIN;
  return kept(d.bedtime, bedtime) && kept(d.wake_time, wake);
}

// The sleep stages the server names (src/model/activity.rs), in the
// hypnogram's rows top to bottom: `key`, `label`, `word` (mid-sentence:
// "light", "REM") and `tile` (the night's tiles lead with the restorative
// stages; awake has none). A span in no known stage is asleep but drawn
// nowhere.
export const STAGES = [
  { key: "awake", label: "Awake", tile: null },
  { key: "rem", label: "REM", tile: 1 },
  { key: "light", label: "Light", tile: 2 },
  { key: "deep", label: "Deep", tile: 0 },
].map((s) => ({
  ...s,
  word: /^[A-Z][a-z]/u.test(s.label) ? s.label.toLowerCase() : s.label,
}));
const STAGE_ROWS = STAGES.map((s) => s.key);
// The stages that are sleep, as the night's tiles list them.
export const SLEEP_STAGES = STAGES.filter((s) => s.tile !== null).toSorted(
  (a, b) => a.tile - b.tile,
);

// A span's minutes; whether it is sleep; a time as RFC 3339 to the
// second; `part` of `total` in whole %.
const spanMin = (s) => (s.to - s.from) / 60_000;
const sleeping = (s) => s.stage !== "awake";
const isoAt = (ms) => new Date(ms).toISOString().replace(".000Z", "Z");
const percentOf = (part, total) =>
  total ? Math.round((part / total) * 100) : 0;

// A night's stage spans ([{start_at, end_at, stage}]) read: its `start`
// and `end`, minutes in each stage, minutes `asleep` (every stage but
// awake) and each sleeping stage's `share` of it (whole %: with asleep in
// no known stage, summing to 100), `awakenings` (awake
// spans of a minute or more between sleep), `efficiency` (% asleep of the
// recorded time in bed, gaps without data left out), the `gaps` and each
// span placed on the night (`left`, `width`: 0–1). Null without a span.
export function hypnogram(stages) {
  if (stages.length === 0) return null;
  const spans = stages
    .map((s) => ({
      stage: s.stage,
      from: Date.parse(s.start_at),
      to: Date.parse(s.end_at),
    }))
    .toSorted((a, b) => a.from - b.from);
  const start = spans[0].from;
  const end = Math.max(...spans.map((s) => s.to));
  const exact = Object.fromEntries(
    [...STAGE_ROWS, "unknown"].map((k) => [k, 0]),
  );
  for (const s of spans) exact[s.stage] = (exact[s.stage] ?? 0) + spanMin(s);
  const asleep =
    SLEEP_STAGES.reduce((t, { key }) => t + exact[key], 0) + exact.unknown;
  const shares = sharesOf({
    ...Object.fromEntries(SLEEP_STAGES.map(({ key }) => [key, exact[key]])),
    unknown: exact.unknown,
  });
  const gaps = [];
  let reached = start;
  for (const s of spans) {
    if (s.from > reached) gaps.push({ start: reached, end: s.from });
    reached = Math.max(reached, s.to);
  }
  return {
    start: isoAt(start),
    end: isoAt(end),
    minutes: Object.fromEntries(
      Object.entries(exact).map(([k, v]) => [k, Math.round(v)]),
    ),
    asleep: Math.round(asleep),
    share: Object.fromEntries(
      SLEEP_STAGES.map(({ key }) => [key, shares[key]]),
    ),
    awakenings: spans.filter(
      (s, i) =>
        s.stage === "awake" &&
        spanMin(s) >= 1 &&
        spans.slice(0, i).some((x) => sleeping(x)) &&
        spans.slice(i + 1).some((x) => sleeping(x)),
    ).length,
    efficiency: percentOf(asleep, asleep + exact.awake),
    gaps: gaps.map((g) => ({ start: isoAt(g.start), end: isoAt(g.end) })),
    spans: spans.map((s) => ({
      stage: s.stage,
      start_at: isoAt(s.from),
      end_at: isoAt(s.to),
      left: (s.from - start) / (end - start),
      width: (s.to - s.from) / (end - start),
    })),
  };
}
