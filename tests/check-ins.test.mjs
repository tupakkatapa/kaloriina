// Daily check-ins as text and numbers (web/check-ins.mjs).

import assert from "node:assert/strict";
import test from "node:test";

import {
  customTags,
  line,
  offered,
  series,
  stats,
  tagCounts,
  tagsOf,
} from "../web/check-ins.mjs";

const c = (day, mood, energy, stress, tags = []) => ({
  day,
  mood,
  energy,
  stress,
  tags,
});

test('line: "Mood 4 · Energy 3 · Stress 2 · travel", unset scales skipped', () => {
  assert.equal(
    line(c("2026-10-09", 4, 3, 2, ["travel"])),
    "Mood 4 · Energy 3 · Stress 2 · travel",
  );
  assert.equal(
    line(c("2026-10-09", null, 3, null, ["sick", "sore"])),
    "Energy 3 · sick · sore",
  );
  assert.equal(line(c("2026-10-09", 1, null, null)), "Mood 1");
});

test("stats: mean, count, and the extremes as value and days, linking to the latest", () => {
  const list = [
    c("2026-10-01", 5, null, 1),
    c("2026-10-02", 2, 3, null),
    c("2026-10-03", 5, null, null),
    c("2026-10-04", null, null, null, ["sick"]),
    c("2026-10-05", 2, 4, 1),
  ];
  assert.deepEqual(stats(list, "mood"), {
    mean: 3.5,
    count: 4,
    highest: { value: 5, days: 2, day: "2026-10-03" },
    lowest: { value: 2, days: 2, day: "2026-10-05" },
  });
  // One value is both ends.
  assert.deepEqual(stats(list, "stress").highest, {
    value: 1,
    days: 2,
    day: "2026-10-05",
  });
  assert.equal(stats([c("2026-10-04", null, null, null, ["x"])], "mood"), null);
});

test("tag counts: most first, then alphabetical", () => {
  assert.deepEqual(
    tagCounts([
      c("2026-10-01", 3, null, null, ["travel", "sick"]),
      c("2026-10-02", 3, null, null, ["social", "travel"]),
      c("2026-10-03", 3, null, null, ["sick", "travel"]),
      c("2026-10-04", 3, null, null, ["alpha"]),
    ]),
    [
      ["travel", 3],
      ["sick", 2],
      ["alpha", 1],
      ["social", 1],
    ],
  );
});

test("series: a scale's samples are only the days that have it", () => {
  const s = series([
    c("2026-10-01", 4, null, 2),
    c("2026-10-02", null, null, 3, ["sick"]),
    c("2026-10-03", 2, null, null),
  ]);
  assert.deepEqual(Object.keys(s), ["checkin:mood", "checkin:stress"]);
  assert.deepEqual(s["checkin:mood"].samples, ["2026-10-01", "2026-10-03"]);
  assert.equal(s["checkin:mood"].values.get("2026-10-03"), 2);
  assert.deepEqual(s["checkin:stress"].samples, ["2026-10-01", "2026-10-02"]);
  assert.deepEqual(series([]), {});
});

test("tags: normalised like the server, deduped, capped", () => {
  assert.deepEqual(tagsOf([" Travel ", "travel", "Poor  sleep", "  "]), [
    "travel",
    "poor sleep",
  ]);
  assert.deepEqual(tagsOf(["a", "b", "c"], 2), ["a", "b"]);
});

test("offered: built-ins, then the day's own, then custom by use", () => {
  const builtins = ["sick", "travel"];
  const list = [
    c("2026-10-01", 3, null, null, ["gym crew", "sick"]),
    c("2026-10-02", 3, null, null, ["deadline", "gym crew"]),
    c("2026-10-03", 3, null, null, ["beach"]),
  ];
  const custom = customTags(list, builtins);
  assert.deepEqual(custom, ["gym crew", "beach", "deadline"]);
  assert.deepEqual(customTags(list, builtins, 1), ["gym crew"]);
  assert.deepEqual(offered(builtins, ["old one", "sick"], custom), [
    "sick",
    "travel",
    "old one",
    "gym crew",
    "beach",
    "deadline",
  ]);
});
