// Sleep stages (web/device.mjs): one table, everything else read from it.

import assert from "node:assert/strict";
import test from "node:test";

import {
  activityText,
  goalShade,
  heartDaysOver,
  hypnogram,
  sharesOf,
  SLEEP_STAGES,
  STAGES,
} from "../web/device.mjs";
import { setRegistry } from "../web/nutrients.mjs";

test("the stage vocabulary is one table", () => {
  assert.deepEqual(
    STAGES.map((s) => [s.key, s.label, s.word]),
    [
      ["awake", "Awake", "awake"],
      ["rem", "REM", "REM"],
      ["light", "Light", "light"],
      ["deep", "Deep", "deep"],
    ],
  );
  assert.deepEqual(
    SLEEP_STAGES.map((s) => s.key),
    ["deep", "rem", "light"],
  );
  const night = hypnogram([
    {
      stage: "light",
      start_at: "2026-09-02T00:00:00Z",
      end_at: "2026-09-02T01:00:00Z",
    },
    {
      stage: "awake",
      start_at: "2026-09-02T01:00:00Z",
      end_at: "2026-09-02T01:30:00Z",
    },
    {
      stage: "deep",
      start_at: "2026-09-02T01:30:00Z",
      end_at: "2026-09-02T02:30:00Z",
    },
  ]);
  // Every stage counted, the sleeping ones shared, from the same table.
  assert.deepEqual(night.minutes, {
    awake: 30,
    rem: 0,
    light: 60,
    deep: 60,
    unknown: 0,
  });
  assert.deepEqual(night.share, { deep: 50, rem: 0, light: 50 });
  assert.equal(night.asleep, 120);
});

test("sharesOf: whole shares summing to 100 by largest remainder", () => {
  assert.deepEqual(sharesOf({ a: 1, b: 1, c: 1 }), { a: 34, b: 33, c: 33 });
  // Each rounded alone: 12 + 12 + 77 = 101.
  assert.deepEqual(sharesOf({ deep: 41, rem: 41, light: 270 }), {
    deep: 12,
    rem: 11,
    light: 77,
  });
  assert.deepEqual(sharesOf({ a: 0, b: 0 }), { a: 0, b: 0 });
});

test("goalShade: a night at the goal shades as reaching it (B-12)", () => {
  const goal = 420;
  assert.deepEqual(
    [0, 300, 359, 360, 419, 420, 479, 480, 600].map((m) => goalShade(m, goal)),
    [0, 1, 1, 2, 2, 3, 3, 4, 4],
  );
});

test("heartDaysOver: today's heart rate waits for the day's end (B-8)", () => {
  const days = [
    { day: "2026-10-13", avg_hr: 66, min_hr: 45, max_hr: 150, resting_hr: 55 },
    { day: "2026-10-14", avg_hr: 56, min_hr: 39, max_hr: 90, resting_hr: 53 },
  ];
  assert.deepEqual(heartDaysOver(days, "2026-10-14"), [
    days[0],
    {
      day: "2026-10-14",
      avg_hr: null,
      min_hr: null,
      max_hr: null,
      resting_hr: 53,
    },
  ]);
});

// A Log row's text as read, and whether any part of it could break inside:
// the value never, the details only between parts (" · ").
const read = (text) => text?.replaceAll("\u00A0", " ") ?? null;
const shown = (row) => row && [read(row.value), read(row.detail)];
const breaksInside = (row) =>
  [row.value, ...(row.detail?.split(" · ") ?? [])].some((s) => s.includes(" "));

test("activityText: steps the value, the day's active energy the detail, measured without ≈", () => {
  const energy = {
    key: "energy",
    label: "Energy",
    unit: "kcal",
    goal: "about",
    category: "General",
  };
  setRegistry([energy], "kcal");
  assert.equal(activityText({ active_kcal: null, steps: null }), null);
  assert.equal(activityText(), null);
  assert.deepEqual(shown(activityText({ active_kcal: 0, steps: 0 })), [
    "0 steps",
    "Active 0 kcal",
  ]);
  // The device's active energy is measured: no "≈".
  const day = activityText({ active_kcal: 512, steps: 9120 });
  assert.deepEqual(shown(day), ["9,120 steps", "Active 512 kcal"]);
  assert.equal(breaksInside(day), false);
  assert.deepEqual(shown(activityText({ active_kcal: null, steps: 1 })), [
    "1 step",
    null,
  ]);
  // Against the Active energy target.
  assert.deepEqual(shown(activityText({ active_kcal: 512, steps: 1 }, 600)), [
    "1 step",
    "Active 512 of 600 kcal",
  ]);
  assert.equal(
    breaksInside(
      activityText({ active_kcal: 512, steps: 1, estimated: true }, 600),
    ),
    false,
  );
  // From activities alone (no device active energy): a floor.
  assert.deepEqual(
    shown(activityText({ active_kcal: 227, steps: 3811, floor: true })),
    ["3,811 steps", "Active ≥ 227 kcal"],
  );
  // An estimate in the sum: "≈".
  assert.deepEqual(
    shown(activityText({ active_kcal: 640, steps: null, estimated: true })),
    ["Active ≈ 640 kcal", null],
  );
  setRegistry([energy], "kJ");
  assert.deepEqual(shown(activityText({ active_kcal: 512, steps: null })), [
    "Active 2,142 kJ",
    null,
  ]);
  setRegistry([], "kcal");
});
