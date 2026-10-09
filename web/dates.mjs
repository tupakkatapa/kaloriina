// Calendar days as `YYYY-MM-DD` strings in local time, and how clock times
// and durations read. No DOM here.

import { NBSP } from "./nutrients.mjs";

export const iso = (d) => d.toLocaleDateString("sv-SE");
export const today = () => iso(new Date());

export function parseDay(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function shift(day, days) {
  const d = parseDay(day);
  d.setDate(d.getDate() + days);
  return iso(d);
}

// Built once: building a formatter costs ~50 calls to it.
const PRETTY = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
});
const PRETTY_DATE = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
});

// "Tue, Oct 6", or "Oct 6" without the weekday.
export const pretty = (day, weekday = true) =>
  (weekday ? PRETTY : PRETTY_DATE).format(parseDay(day));

// Monday of `day`'s week.
export const weekStart = (day) =>
  shift(day, -((parseDay(day).getDay() + 6) % 7));

const utc = (day) => {
  const [y, m, d] = day.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
};

// Days in [from, to], both included (calendar days: no DST drift).
export function daysIn(from, to) {
  return Math.round((utc(to) - utc(from)) / 864e5) + 1;
}

// Monday 0 … Sunday 6, whatever the time zone.
export const weekday = (day) => (new Date(utc(day)).getUTCDay() + 6) % 7;

// "07:05": an instant (ms or ISO) on this device's clock, 24-hour.
export const clockAt = (at) =>
  new Date(at).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });

// Time spent: "45 min", "1 h", "6 h 20 min".
export function duration(minutes) {
  if (minutes < 60) return `${minutes}${NBSP}min`;
  const m = minutes % 60;
  return `${Math.floor(minutes / 60)}${NBSP}h${m ? ` ${m}${NBSP}min` : ""}`;
}
