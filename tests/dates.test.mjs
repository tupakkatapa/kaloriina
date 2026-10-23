// The "Eaten today → time now" rule: one function, and every screen goes
// through it.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

import {
  clockAt,
  clockOf,
  dayAt,
  eatenTime,
  parseClock,
  period,
  shift,
  tileThrough,
  today,
} from "../web/dates.mjs";
import { NBSP } from "../web/format.mjs";
import { EATEN, PLANNED } from "../web/nutrients.mjs";

test("eaten_time_rule_once: the rule's cases", () => {
  const now = eatenTime(today(), EATEN);
  assert.match(now, /^\d\d:\d\d$/u, "Eaten today: now");
  assert.equal(eatenTime(today(), EATEN, "08:15"), "08:15", "typed wins");
  assert.equal(eatenTime(today(), PLANNED), null, "Planned: none");
  assert.equal(eatenTime(today(), null, ""), null, "no group, none typed");
  assert.equal(eatenTime(shift(today(), -1), EATEN), null, "past: none");
});

// The day starts at 03:00: a night out still logs on the evening's day.
test("today: the day starts at 03:00, on DST nights too", (t) => {
  for (const [at, day] of [
    [new Date(2026, 9, 23, 1, 0), "2026-10-22"],
    [new Date(2026, 9, 23, 2, 59), "2026-10-22"],
    [new Date(2026, 9, 23, 3, 0), "2026-10-23"],
    [new Date(2026, 9, 23, 23, 59), "2026-10-23"],
    // Spring forward: 03:00 is skipped, 02:59 EET then 04:00 EEST.
    [new Date("2026-03-29T00:59:00Z"), "2026-03-28"],
    [new Date("2026-03-29T01:00:00Z"), "2026-03-29"],
    // Fall back: 03:00–03:59 runs twice, both on the new day.
    [new Date("2026-10-24T23:59:00Z"), "2026-10-24"],
    [new Date("2026-10-25T00:00:00Z"), "2026-10-25"],
    [new Date("2026-10-25T01:30:00Z"), "2026-10-25"],
  ]) {
    t.mock.timers.enable({ apis: ["Date"], now: at });
    assert.equal(today(), day, at.toISOString());
    t.mock.timers.reset();
  }
});

test("eaten_time_rule_once: at 01:00, yesterday's Eaten gets 01:00", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date(2026, 9, 23, 1, 0) });
  assert.equal(eatenTime("2026-10-22", EATEN), "01:00");
  assert.equal(eatenTime("2026-10-23", EATEN), null);
});

test("dayAt: a clock time before 03:00 is the next morning's", () => {
  assert.deepEqual(dayAt("2026-10-22", "14:30"), new Date(2026, 9, 22, 14, 30));
  assert.deepEqual(dayAt("2026-10-22", "03:00"), new Date(2026, 9, 22, 3, 0));
  assert.deepEqual(dayAt("2026-10-22", "02:59"), new Date(2026, 9, 23, 2, 59));
  assert.deepEqual(dayAt("2026-10-22", "00:30"), new Date(2026, 9, 23, 0, 30));
});

test("dayAt: no screen builds a day's instant itself", () => {
  const dir = new URL("../web/screens/", import.meta.url);
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".mjs")))
    assert.doesNotMatch(
      readFileSync(new URL(f, dir), "utf8"),
      /new Date\(`\$\{[^}]+\}T/u,
      `${f} builds a day's instant: use dayAt`,
    );
});

test("eaten_time_rule_once: no screen restates it", () => {
  const dir = new URL("../web/screens/", import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith(".mjs"));
  assert.ok(files.length > 0, "scanned the screens");
  for (const f of files)
    assert.doesNotMatch(
      readFileSync(new URL(f, dir), "utf8"),
      /\bnowTime\(/u,
      `${f} calls nowTime: use eatenTime`,
    );
});

// The clock follows the Units setting: Metric 24-hour, US 12-hour.
test("clockOf: Metric 24-hour, US 12-hour", () => {
  for (const [time, metric, us] of [
    ["00:00", "00:00", "12:00 AM"],
    ["07:05", "07:05", "7:05 AM"],
    ["12:00", "12:00", "12:00 PM"],
    ["14:30", "14:30", "2:30 PM"],
    ["23:59", "23:59", "11:59 PM"],
  ]) {
    assert.equal(clockOf(time, "metric"), metric, time);
    assert.equal(clockOf(time, "us").replace(NBSP, " "), us, time);
  }
  assert.equal(clockOf("19:05"), "19:05", "Metric without a choice");
});

test("clockAt: an instant on this device's clock, per units", () => {
  const at = new Date(2026, 9, 12, 19, 5).getTime();
  assert.equal(clockAt(at, "metric"), "19:05");
  assert.equal(clockAt(at, "us").replace(NBSP, " "), "7:05 PM");
});

test("parseClock: what either units' reader types", () => {
  for (const [text, want] of [
    ["14:30", "14:30"],
    ["1430", "14:30"],
    ["930", "09:30"],
    ["9:30", "09:30"],
    ["14.30", "14:30"],
    ["2:30 pm", "14:30"],
    ["2:30 PM", "14:30"],
    [`2:30${NBSP}PM`, "14:30"],
    ["2:30p", "14:30"],
    ["2:30 p.m.", "14:30"],
    ["2pm", "14:00"],
    ["12am", "00:00"],
    ["12:15 AM", "00:15"],
    ["12 pm", "12:00"],
    ["11:30 pm", "23:30"],
    ["7:05 am", "07:05"],
    ["14", "14:00"],
    ["0", "00:00"],
    ["  14:30  ", "14:30"],
    ["", ""],
    ["   ", ""],
  ])
    assert.equal(parseClock(text), want, JSON.stringify(text));
  for (const text of [
    "24:00",
    "14:60",
    "13pm",
    "0am",
    "2:3",
    "abc",
    "14:30:00",
    "12345",
    "pm",
    "-1",
  ])
    assert.equal(parseClock(text), null, JSON.stringify(text));
});

test("clock round-trip: shown text parses back to the data", () => {
  for (let min = 0; min < 24 * 60; min += 7) {
    const time = `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
    for (const system of ["metric", "us"])
      assert.equal(
        parseClock(clockOf(time, system)),
        time,
        `${system} ${time}`,
      );
  }
});

// A period's cut-offs belong to the period: day totals count
// through yesterday while it runs, activities through today.
test("period: bounds, neighbours and cut-offs", () => {
  const now = today();
  const week = period("week", now);
  assert.ok(week.from <= now && now <= week.to);
  assert.equal(week.prev, shift(week.from, -7));
  assert.equal(week.throughToday, now);
  // A running period ends yesterday, its first day too.
  assert.equal(week.through, shift(now, -1));
  const past = period("month", "2020-02-10");
  assert.deepEqual(
    [past.from, past.to, past.prev, past.next, past.through, past.throughToday],
    [
      "2020-02-01",
      "2020-02-29",
      "2020-01-01",
      "2020-03-01",
      "2020-02-29",
      "2020-02-29",
    ],
  );
  const year = period("year", "2020-06-15");
  assert.deepEqual(
    [year.from, year.to, year.title],
    ["2020-01-01", "2020-12-31", "2020"],
  );
  const day = period("day", "2020-06-15");
  assert.deepEqual(
    [day.from, day.to, day.prev, day.next],
    ["2020-06-15", "2020-06-15", "2020-06-14", "2020-06-16"],
  );
  assert.equal(period("day", now).title, "Today");
  // A period wholly ahead counts what is logged, as its calendar does.
  const ahead = period("month", shift(now, 62));
  assert.equal(ahead.through, ahead.to);
});

test("a period starting today has nothing elapsed: through yesterday, before it", () => {
  const now = today();
  const day = period("day", now);
  assert.deepEqual([day.through, day.throughToday], [shift(now, -1), now]);
  // On the 1st (or Monday, or Jan 1) as on any other day.
  const first = "2026-11-01";
  assert.equal(
    tileThrough(first, "2026-11-30", "2026-10-31", first),
    "2026-10-31",
  );
  assert.equal(tileThrough(first, "2026-11-30", first, first), first);
  // Wholly after today: what is logged, as its calendar counts it.
  assert.equal(
    tileThrough("2026-12-01", "2026-12-31", "2026-10-31", first),
    "2026-12-31",
  );
  assert.equal(
    tileThrough(first, "2026-11-30", "2026-11-09", "2026-11-10"),
    "2026-11-09",
  );
});
