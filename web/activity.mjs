// A day's activity from Health Connect as it reads: active
// energy and steps, and the night that ended the day with its heart; a
// period's sleep averages. No DOM here, so `node --test` covers it.

import { duration } from "./dates.mjs";
import { NBSP, isNil, kcal as energy, plural } from "./nutrients.mjs";

// "Active ≈ 512 kcal · 9,120 steps": a day's Health Connect totals from the
// Android companion, null when it has neither. Shown, never added to
// targets or to what workouts burned.
export function activityLine({ active_kcal, steps } = {}) {
  const parts = [
    isNil(active_kcal) ? null : `Active ≈ ${energy(active_kcal)}`,
    isNil(steps) ? null : plural(steps, "step"),
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

// "7 h 20 min asleep · 23:40–07:05 · deep 1 h 10 min · REM 1 h 30 min ·
// RHR 54 · HRV 48 ms": the night that ended the day and the day's heart,
// what there is of them; null when nothing.
export function nightLine(a = {}) {
  const parts = [
    isNil(a.asleep_min) ? null : `${duration(a.asleep_min)} asleep`,
    a.bedtime && a.wake_time ? `${a.bedtime}–${a.wake_time}` : null,
    isNil(a.deep_min) ? null : `deep ${duration(a.deep_min)}`,
    isNil(a.rem_min) ? null : `REM ${duration(a.rem_min)}`,
    isNil(a.resting_hr) ? null : `RHR ${a.resting_hr}`,
    isNil(a.hrv_ms) ? null : `HRV ${a.hrv_ms}${NBSP}ms`,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

const DAY_MIN = 1440;
const minutesOf = (hhmm) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};
const hhmm = (min) => {
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

// The nights among `days` (activity days): minutes asleep a night, and
// with MIN_NIGHTS or more the average bedtime and wake-up ("HH:MM",
// circular means) and the bedtime spread (the population SD, minutes);
// null without a night.
export function sleepStats(days) {
  const nights = days.filter((d) => !isNil(d.asleep_min) && d.bedtime);
  if (!nights.length) return null;
  const asleep = nights.reduce((t, d) => t + d.asleep_min, 0) / nights.length;
  if (nights.length < MIN_NIGHTS)
    return {
      nights: nights.length,
      asleep,
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
    bedtime: hhmm(bed),
    spread,
    wake: hhmm(clockMean(nights.map((d) => minutesOf(d.wake_time)))),
  };
}
