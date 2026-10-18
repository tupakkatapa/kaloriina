// Records (Activity → Records): the bests per activity type and per day,
// and which a new activity beats. `node --test tests/`.

import assert from "node:assert/strict";
import test from "node:test";

import {
  activitiesMetres,
  dayRecords,
  distanceOf,
  newTypeRecords,
  paceDistance,
  tracksActivity,
  typeRecords,
} from "../web/activities.mjs";

const run = (id, day, minutes, distance_m, kcal = null) => ({
  id,
  day,
  type: "run",
  minutes,
  distance_m,
  kcal,
  sets: [],
});

test("typeRecords: the longest and the fastest over 1 km per type; energy is no record", () => {
  // The fastest, but under 1 km.
  const short = run(1, "2026-09-01", 4, 900, 60);
  const long = run(2, "2026-09-02", 70, 12_000, 800);
  const quick = run(3, "2026-09-03", 25, 5000, 350);
  const ride = { ...run(4, "2026-09-04", 90, 30_000), type: "cycling" };
  const r = typeRecords([short, long, quick, ride]);
  assert.equal(r.run.distance, long);
  assert.equal(r.run.minutes, long);
  assert.equal(r.run.pace, quick);
  // A gross typed total, a device's net and an estimate don't rank.
  assert.equal(r.run.kcal, undefined);
  assert.equal(r.cycling.distance, ride);
  // A device's 2 m is no distance to hold a record.
  assert.equal(
    typeRecords([run(9, "2026-09-09", 17, 2)]).run.distance,
    undefined,
  );
  // A tie goes to the later activity: the record is when you last reached
  // it, the later day even when listed first.
  const again = run(5, "2026-09-05", 70, 12_000);
  assert.equal(typeRecords([long, again]).run.distance, again);
  assert.equal(typeRecords([again, long]).run.distance, again);
  assert.deepEqual(typeRecords([]), {});
});

test("typeRecords: pace counts from exactly 1 km, never under", () => {
  // 4:00 /km over exactly 1 km; faster, 1 m short; 6:00 /km.
  const km = run(6, "2026-09-06", 4, 1000);
  const under = run(7, "2026-09-07", 3, 999);
  const slow = run(8, "2026-09-08", 30, 5000);
  assert.equal(typeRecords([km, under, slow]).run.pace, km);
  assert.equal(typeRecords([under, slow]).run.pace, slow);
});

test("newTypeRecords: what an activity beats among its type's before it", () => {
  const before = [run(1, "2026-09-01", 30, 5000, 300)];
  const further = run(2, "2026-09-02", 40, 8000, 250);
  assert.deepEqual(
    newTypeRecords(before, further).map((r) => r.key),
    ["distance", "minutes", "pace"],
  );
  const faster = run(3, "2026-09-03", 20, 5000, 310);
  assert.deepEqual(
    newTypeRecords(before, faster).map((r) => r.key),
    ["pace"],
  );
  // Equal is no record; nothing before, nothing to beat; other types don't
  // count.
  assert.deepEqual(
    newTypeRecords(before, run(4, "2026-09-04", 30, 5000, 300)),
    [],
  );
  assert.deepEqual(newTypeRecords([], further), []);
  assert.deepEqual(
    newTypeRecords([{ ...before[0], type: "walk" }], further),
    [],
  );
  // An activity saved already isn't its own record to beat.
  assert.equal(newTypeRecords([...before, further], further).length, 3);
});

test("dayRecords: the best step day and the longest sleep, night and naps", () => {
  // `/device-days` days: `total_asleep_min` is the night (`asleep_min`) plus
  // the naps' time asleep.
  const days = [
    { day: "2026-09-01", steps: 9000, asleep_min: 480, total_asleep_min: 480 },
    {
      day: "2026-09-02",
      steps: 15_000,
      asleep_min: null,
      total_asleep_min: null,
    },
    // A shorter night with a 90-minute nap is the longest sleep.
    { day: "2026-09-03", steps: null, asleep_min: 420, total_asleep_min: 510 },
  ];
  // The longest night is the night alone (09-01), never one
  // lengthened by naps; the most sleep in a day adds them (09-03).
  assert.deepEqual(dayRecords(days), {
    steps: { day: "2026-09-02", value: 15_000 },
    night: { day: "2026-09-01", value: 480 },
    sleep: { day: "2026-09-03", value: 510 },
  });
  // Later days win ties.
  assert.equal(
    dayRecords([...days, { day: "2026-09-04", asleep_min: 480 }]).night.day,
    "2026-09-04",
  );
  assert.deepEqual(dayRecords([]), { steps: null, night: null, sleep: null });
});

test("TFA-A3: a pace needs a speed its type moves at", () => {
  // 317 m in 19 min (1.0 km/h) is no walk: no pace, the distance stays.
  const crawl = {
    type: "walk",
    minutes: 19,
    distance_m: 317,
    source: "health_connect",
  };
  assert.equal(distanceOf(crawl), 317);
  assert.equal(paceDistance(crawl), null);
  // 317 m in 4 min: 4.8 km/h.
  assert.equal(paceDistance({ ...crawl, minutes: 4 }), 317);
  // A run at 4 km/h isn't one; 1.2 km in an hour's walk holds no record.
  assert.equal(
    paceDistance({ type: "run", minutes: 30, distance_m: 2000 }),
    null,
  );
  const slow = {
    id: 1,
    day: "2026-07-23",
    type: "walk",
    minutes: 60,
    distance_m: 1200,
  };
  assert.equal(typeRecords([slow]).walk.pace, undefined);
  assert.equal(typeRecords([slow]).walk.distance, slow);
});

test("TFA-A4: an other activity's synced metres are no distance; typed ones are", () => {
  const zumba = {
    id: 2,
    day: "2026-09-26",
    type: "other",
    minutes: 60,
    distance_m: 641,
    source: "health_connect",
  };
  assert.equal(distanceOf(zumba), null);
  assert.equal(typeRecords([zumba]).other.distance, undefined);
  assert.equal(distanceOf({ ...zumba, source: "hand" }), 641);
});

test("TFA-A1: a device day with only a resting total tracked nothing", () => {
  assert.equal(tracksActivity({ day: "2026-01-05", total_kcal: 1554 }), false);
  assert.equal(tracksActivity({ day: "2026-06-03", steps: 4200 }), true);
  assert.equal(tracksActivity({ day: "2026-06-03", active_kcal: 0 }), true);
  assert.equal(
    tracksActivity({ day: "2026-06-03", total_asleep_min: 30 }),
    true,
  );
});

test("activitiesMetres adds the distances that are one, once each", () => {
  assert.equal(
    activitiesMetres([
      { type: "run", distance_m: 5000, source: "hand" },
      { type: "walk", distance_m: 2300, source: "health_connect" },
      // A phone's step metres on an "other": no route, no distance.
      { type: "other", distance_m: 900, source: "health_connect" },
      // Under 50 m: a leftover.
      { type: "walk", distance_m: 30, source: "health_connect" },
      { type: "strength", distance_m: null, source: "hand" },
    ]),
    7300,
  );
  assert.equal(activitiesMetres([]), 0);
});
