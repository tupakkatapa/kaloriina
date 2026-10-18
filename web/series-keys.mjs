// Every daily series by key, declared once: its label, its stored
// unit (shown in this device's units: `shownUnit`, `convert`), how a value
// reads (`say`), the row field it comes from (`col`: a Health Connect day's,
// a scale reading's), the Summary subtabs it belongs to (`domain`) and what
// it is coupled with by definition (`groups`, web/correlate.mjs: two series
// sharing one are never tested). `estimate`: a scale's bioimpedance share,
// said with "≈". `goal`: the server metric holding its goal, if any (a
// series key isn't one: `water` there is hydration). `trend: false`: its
// chart draws no moving average (derived from another series, already
// smooth, near-constant, or driven by the day's activity); a body
// measurement (`m:…`, weekly or rarer) has none either. No DOM here, so
// `node --test` covers it.

import { duration } from "./dates.mjs";
import { fmt, fmtNum, isNil, qty } from "./format.mjs";
import { kcal, nutrient } from "./nutrients.mjs";
import { toShown, unitOf } from "./units.mjs";

const minutes = (v) => duration(Math.round(v));
const scale = (v) => fmt(v, 1);
const unitSay = (unit, digits) => (v) => qty(v, unit, digits);

const SERIES = {
  energy: { label: "Energy eaten", say: kcal, domain: ["food"] },
  alcohol: { label: "Alcohol", unit: "g", domain: ["food", "habits"] },
  caffeine: { label: "Caffeine", unit: "mg", domain: ["food", "habits"] },
  sleep: { label: "Sleep", say: minutes, domain: ["body"] },
  deep_min: { label: "Deep sleep", say: minutes, col: "deep_min" },
  rem_min: { label: "REM sleep", say: minutes, col: "rem_min" },
  light_min: { label: "Light sleep", say: minutes, col: "light_min" },
  steps: { label: "Steps", say: fmtNum, domain: ["activity"], col: "steps" },
  activities: { label: "Activities", say: fmtNum, domain: ["activity"] },
  minutes: { label: "Activity minutes", say: minutes, domain: ["activity"] },
  // Burned counts the food's thermic effect: coupled with eating too.
  burned: {
    label: "Energy burned",
    say: kcal,
    domain: ["activity"],
    groups: ["movement", "food"],
  },
  resting_hr: { label: "RHR", unit: "bpm", digits: 0, col: "resting_hr" },
  hrv_ms: { label: "HRV", unit: "ms", digits: 0, col: "hrv_ms" },
  // The day's average follows how active it was: RHR is the trend to read.
  avg_hr: {
    label: "Heart rate",
    unit: "bpm",
    digits: 0,
    col: "avg_hr",
    trend: false,
  },
  "checkin:mood": { label: "Mood", say: scale },
  // The check-in's "Energy", told apart from energy eaten.
  "checkin:energy": { label: "Energy level", say: scale },
  "checkin:stress": { label: "Stress", say: scale },
  weight_trend: { label: "Weight trend change", unit: "kg", digits: 2 },
  weight: { label: "Weight", unit: "kg", goal: "goal_weight" },
  body_fat: {
    label: "Body fat",
    unit: "%",
    col: "body_fat",
    estimate: true,
    goal: "goal_body_fat",
  },
  muscle: {
    label: "Muscle",
    unit: "%",
    col: "muscle",
    estimate: true,
    goal: "goal_muscle",
  },
  // A scale reading's body water, not the hydration goal (`water`).
  body_water: {
    label: "Water",
    unit: "%",
    col: "water",
    estimate: true,
    trend: false,
  },
  lbm_kg: { label: "Lean mass", unit: "kg", col: "lbm_kg", estimate: true },
  bone_kg: {
    label: "Bone mass",
    unit: "kg",
    col: "bone_kg",
    estimate: true,
    trend: false,
  },
  // BMI stays kg/m² whatever the units.
  // Weight over height²: the weight's trend again.
  bmi: { label: "BMI", unit: "kg/m²", fixed: true, trend: false },
  // What keeps your weight a day (web/series.mjs `maintenance`).
  // A 28-day model already: a trend of it smooths twice.
  maintenance: {
    label: "Maintenance",
    unit: "kcal",
    energy: true,
    trend: false,
  },
};

// The groups and domain a series has unless declared: groups by topic.
const GROUPS = {
  energy: ["food"],
  alcohol: ["food"],
  caffeine: ["food"],
  sleep: ["sleep"],
  deep_min: ["sleep"],
  rem_min: ["sleep"],
  light_min: ["sleep"],
  steps: ["movement"],
  activities: ["movement"],
  minutes: ["movement"],
};

// Series `key` described: {label, unit (stored), say, domain (Body's
// unless said), groups, col, estimate, goal}; an unknown key is its own
// label and group, of no subtab.
export function seriesInfo(key) {
  const m = SERIES[key] ?? { label: key, domain: [] };
  return {
    ...m,
    say: m.say ?? (m.unit ? unitSay(m.unit, m.digits ?? null) : fmtNum),
    domain: m.domain ?? ["body"],
    trend: m.trend ?? !key.startsWith("m:"),
    groups: m.groups ?? GROUPS[key] ?? [key],
  };
}

// Its unit on this device: lb and in under US units, the energy unit for
// energy; BMI (`fixed`) as stored.
export const shownUnit = (key, unit = seriesInfo(key).unit) =>
  seriesInfo(key).energy
    ? nutrient("energy").unit
    : seriesInfo(key).fixed
      ? unit
      : unitOf(unit);

// A stored value in the shown unit (shownUnit).
export const convert = (key, v, unit = seriesInfo(key).unit) =>
  seriesInfo(key).energy
    ? nutrient("energy").show(v)
    : seriesInfo(key).fixed
      ? v
      : toShown(v, unit);

// Series `key`'s days among `rows` ([{day, …}]) by its field `col`:
// [{day, value}], a row without it left out.
export const source = (key, rows) => {
  const col = seriesInfo(key).col;
  return rows
    .filter((r) => !isNil(r[col]))
    .map((r) => ({ day: r.day, value: r[col] }));
};
