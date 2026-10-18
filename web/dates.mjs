// Calendar days as `YYYY-MM-DD` strings in local time, and how clock times
// and durations read. No DOM here.

import { fmt, NBSP } from "./format.mjs";
import { EATEN } from "./nutrients.mjs";
import { unitSystem } from "./units.mjs";

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

// Whole years from `birth` to `day` (both YYYY-MM-DD).
export const ageOn = (birth, day) =>
  Number(day.slice(0, 4)) -
  Number(birth.slice(0, 4)) -
  (day.slice(5) < birth.slice(5) ? 1 : 0);

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

const PRETTY_YEAR = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
});

// "Jun 9, 2026".
export const prettyYear = (day) => PRETTY_YEAR.format(parseDay(day));

const MONTH_YEAR = new Intl.DateTimeFormat(undefined, {
  month: "long",
  year: "numeric",
});

// "October 2026": the month of `day`.
export const monthYear = (day) => MONTH_YEAR.format(parseDay(day));

// The first day of the month `months` from `day`'s (0: its own; -1: the
// one before).
export function monthStart(day, months = 0) {
  const d = parseDay(day);
  return iso(new Date(d.getFullYear(), d.getMonth() + months, 1));
}

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

// The last day a period's numbers count when `last` is the last day that
// does: the period's end, or `last` while the period runs (on its first
// day too: through yesterday, before `from`, nothing elapsed yet); a
// period wholly after `now` (today) has nothing elapsed and counts what
// is logged, as its calendar does.
export const tileThrough = (from, to, last, now = today()) =>
  from > now || to < last ? to : last;

// A week's title as the browser's locale writes a range, compact enough
// for a phone in any locale: "10/12 – 10/18", "12.–18.10.".
const WEEK = new Intl.DateTimeFormat(undefined, {
  month: "numeric",
  day: "numeric",
});

// The `kind` ("day", "week", "month", "year") of period around `day`:
// {from, to, prev and next (a day in the periods either side), title,
// through (the last day its day totals count: today is still being
// logged, so a running period's end yesterday) and throughToday (the last
// day its activities count: a logged one is whole)}.
export function period(kind, day) {
  const d = parseDay(day);
  let p;
  if (kind === "day")
    p = {
      from: day,
      to: day,
      prev: shift(day, -1),
      next: shift(day, 1),
      title: day === today() ? "Today" : pretty(day),
    };
  else if (kind === "year") {
    const y = d.getFullYear();
    p = {
      from: `${y}-01-01`,
      to: `${y}-12-31`,
      prev: `${y - 1}-01-01`,
      next: `${y + 1}-01-01`,
      title: String(y),
    };
  } else if (kind === "month")
    p = {
      from: iso(new Date(d.getFullYear(), d.getMonth(), 1)),
      to: iso(new Date(d.getFullYear(), d.getMonth() + 1, 0)),
      prev: iso(new Date(d.getFullYear(), d.getMonth() - 1, 1)),
      next: iso(new Date(d.getFullYear(), d.getMonth() + 1, 1)),
      title: monthYear(day),
    };
  else {
    const from = weekStart(day);
    const to = shift(from, 6);
    p = {
      from,
      to,
      prev: shift(from, -7),
      next: shift(from, 7),
      title: WEEK.formatRange(parseDay(from), parseDay(to)),
    };
  }
  const now = today();
  return {
    ...p,
    through: tileThrough(p.from, p.to, shift(now, -1)),
    throughToday: tileThrough(p.from, p.to, now),
  };
}

const pad = (n) => String(n).padStart(2, "0");

// A time of day as data ("23:40": a bedtime, an entry's time) as shown: in
// this device's units, Metric "23:40", US "11:40 PM". Every clock time the
// app shows goes through here (no separate setting: the Units one).
export function clockOf(time, system = unitSystem()) {
  const [h, m] = time.split(":").map(Number);
  return system === "us"
    ? `${h % 12 || 12}:${pad(m)}${NBSP}${h < 12 ? "AM" : "PM"}`
    : `${pad(h)}:${pad(m)}`;
}

// "19:05": an instant (ms or ISO) on this device's clock as data (what a
// time field and the API take).
export function timeValue(at) {
  const d = new Date(at);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// An instant on this device's clock as shown.
export const clockAt = (at, system = unitSystem()) =>
  clockOf(timeValue(at), system);

// An instant's day and clock time as shown: "Oct 12, 2026, 19:05".
export const dateTimeAt = (at) =>
  `${new Date(at).toLocaleDateString(undefined, { dateStyle: "medium" })}, ${clockAt(at)}`;

// A typed clock time as data, whichever way it reads: "14:30", "1430",
// "14.30", "14", "2:30 pm", "2:30p", "2pm" → "14:30"; "" when blank; null
// when not a time.
const TYPED = /^(\d{1,2})(?:[:.]?(\d\d))?\s*(?:([ap])\.?\s*(?:m\.?)?)?$/iu;
export function parseClock(text) {
  const t = text.trim();
  if (t === "") return "";
  const match = TYPED.exec(t);
  if (!match) return null;
  const [, hh, mm = "00", half] = match;
  let h = Number(hh);
  const m = Number(mm);
  if (m > 59) return null;
  if (half) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (half.toLowerCase() === "p" ? 12 : 0);
  } else if (h > 23) return null;
  return `${pad(h)}:${pad(m)}`;
}

// Time spent: "45 min", "1 h", "6 h 20 min", "1,044 h 39 min" (hours
// grouped, as every number).
export function duration(minutes) {
  if (minutes < 60) return `${minutes}${NBSP}min`;
  const m = minutes % 60;
  return `${fmt(Math.floor(minutes / 60))}${NBSP}h${m ? ` ${m}${NBSP}min` : ""}`;
}

// Now on this device ("08:15") when `day` is today; other days none. The
// client names it: the server's clock may be in another zone.
export const nowTime = (day) =>
  day === today() ? timeValue(Date.now()) : null;

// The time an entry logged or moved into `group` takes: the one `typed`,
// else now when that's Eaten today, else none. Every write applies the rule
// through here.
export const eatenTime = (day, group, typed = null) =>
  typed || (group === EATEN ? nowTime(day) : null);
