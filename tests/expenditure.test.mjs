// The energy model's rules (web/expenditure.mjs): what a day burned, the
// resting energy behind it, and the energy a goal needs (ADR 0020).

import assert from "node:assert/strict";
import test from "node:test";

import { setActivityTypes } from "../web/activities.mjs";
import { shift } from "../web/dates.mjs";
import { balance, maintenanceSeries } from "../web/energy.mjs";
import { activeEnergyText, activeMark } from "../web/energy-text.mjs";
import {
  activeEnergy,
  activeKcal,
  activeOf,
  appOf,
  bmrOf,
  BURNED_FROM,
  burnedDay,
  burnedDays,
  burnedOver,
  maintenanceOf,
  maintenanceText,
  mifflin,
  needed,
  offered,
  sure,
} from "../web/expenditure.mjs";
import { setRegistry } from "../web/nutrients.mjs";
import { dayEnergy } from "../web/series.mjs";
import { library, workoutLine } from "../web/workouts.mjs";

// METs as /api/meta serves them (`activity_types[].met`).
const METS = {
  workout: 5,
  walk: 3.5,
  yoga: 2.3,
  cycling: 7,
  run: 9.3,
  other: 4,
};
setActivityTypes(Object.entries(METS).map(([key, met]) => ({ key, met })));

const T = "2026-10-12";
const near = (got, want, tol = 1e-6) =>
  assert.ok(Math.abs(got - want) <= tol, `${got} ≠ ${want}`);
const MAN = { sex: "male", birth_date: "1990-10-12", height_cm: 180 };

test("resting energy: Mifflin–St Jeor", () => {
  // 10·80 + 6.25·180 − 5·36 + 5
  near(mifflin(MAN, 80, T), 1750);
  near(mifflin({ ...MAN, sex: "female" }, 80, T), 1584);
  assert.equal(mifflin({ ...MAN, height_cm: null }, 80, T), null);
});

test("burned: one model every day, resting + TEF + max(device active, everyday + activities) (EN-2)", () => {
  const activities = [
    { kcal: 300, kcal_source: "health_connect", minutes: 30 },
    { kcal: 400, kcal_source: "hand", minutes: 60 },
  ];
  const base = { bmr: 1800, intake: 2000, activities };
  // Everyday movement 180 plus the activities' net 300 + 325.
  const moved = 180 + 300 + (400 - 75);
  // The device's total isn't burned: its resting part is the vendor's
  // formula and it holds no TEF. A high one doesn't stand…
  assert.deepEqual(
    burnedDay({ ...base, deviceDay: { total_kcal: 3000, active_kcal: 500 } }),
    { kcal: 1800 + 200 + moved, source: "active" },
  );
  // …and its active energy wins when larger (its own workouts are in it).
  assert.deepEqual(
    burnedDay({ ...base, deviceDay: { total_kcal: 3000, active_kcal: 900 } }),
    { kcal: 1800 + 200 + 900, source: "active" },
  );
  // A logged activity the device missed isn't dropped, nor the everyday
  // movement around it.
  assert.deepEqual(
    burnedDay({ ...base, deviceDay: { total_kcal: null, active_kcal: 500 } }),
    { kcal: 1800 + 200 + moved, source: "active" },
  );
  // No active energy from the device (a total alone, or nothing): resting
  // plus everyday movement (× 1.1), TEF of what was eaten, and the
  // activities' net kcal (a device's kcal is net, a hand's gross less the
  // hour's BMR).
  assert.deepEqual(burnedDay({ ...base, deviceDay: { total_kcal: 1500 } }), {
    kcal: 1800 * 1.1 + 200 + 300 + (400 - 75),
    source: "activities",
  });
  assert.deepEqual(burnedDay({ ...base, deviceDay: null }), {
    kcal: 1800 * 1.1 + 200 + 300 + (400 - 75),
    source: "activities",
  });
  // A Health Connect day with neither total nor active energy is row 3 too.
  assert.equal(
    burnedDay({ ...base, deviceDay: { steps: 4000 } }).kcal,
    1800 * 1.1 + 200 + 300 + (400 - 75),
  );
  // A hand kcal under the resting share adds nothing; nothing eaten
  // logged, TEF is of resting × 1.1 (unlogged isn't fasted).
  near(
    burnedDay({
      bmr: 2400,
      intake: 0,
      deviceDay: null,
      activities: [{ kcal: 50, kcal_source: "hand", minutes: 60 }],
    }).kcal,
    2400 * 1.1 * 1.1,
  );
  // Without resting energy only the device total stands.
  assert.equal(burnedDay({ ...base, bmr: null, deviceDay: null }), null);
  assert.deepEqual(
    burnedDay({ ...base, bmr: null, deviceDay: { total_kcal: 2100 } }),
    { kcal: 2100, source: "device" },
  );
});

test("burned: a quiet device day is resting × 1.1 + TEF, whatever its total (the owner's report, EN-1)", () => {
  // Oct 5: the device's total 1,792 kcal (its own resting formula, no
  // TEF), 37 active, against resting ≈ 1,712 and 1,729 eaten: the day
  // burned resting + TEF + everyday movement, as a day without a device.
  const day = { bmr: 1712, intake: 1729, activities: [] };
  const quiet = burnedDay({
    ...day,
    deviceDay: { total_kcal: 1792, active_kcal: 37 },
  });
  near(quiet.kcal, 1712 * 1.1 + 172.9);
  near(quiet.kcal, burnedDay({ ...day, deviceDay: null }).kcal);
  // Each source has its words, true of the day.
  assert.equal(quiet.source, "active");
  assert.doesNotMatch(BURNED_FROM.activities, /no device data/u);
  // A busy day: resting + TEF + its active energy, never its total.
  near(
    burnedDay({ ...day, deviceDay: { total_kcal: 3029, active_kcal: 896 } })
      .kcal,
    1712 + 172.9 + 896,
  );
});

test("burned: an empty day is resting × 1.1 + TEF, not resting (the owner's report)", () => {
  // Male, born 1995-09-23, 174 cm, 76.25 kg: Mifflin ≈ 1,700; an online
  // TDEE calculator's sedentary ≈ 2,049, not 1,696.
  const me = { sex: "male", birth_date: "1995-09-23", height_cm: 174 };
  const bmr = mifflin(me, 76.25, "2026-10-12");
  near(bmr, 1700);
  const empty = burnedDay({ deviceDay: null, bmr, intake: 0, activities: [] });
  // Resting × 1.1 (everyday movement) + TEF of that (nothing logged).
  near(empty.kcal, bmr * 1.1 + 0.1 * bmr * 1.1);
  assert.ok(Math.abs(empty.kcal - 2049) < 25, String(empty.kcal));
  assert.equal(empty.source, "activities");
  // Each source has its words (Summary → Food says where burned came from).
  assert.ok(BURNED_FROM[empty.source]);
  // Logged food: TEF is of it, not of the baseline.
  near(
    burnedDay({ deviceDay: null, bmr, intake: 2500, activities: [] }).kcal,
    bmr * 1.1 + 250,
  );
  // A 300 kcal workout lands on top.
  const run = { kcal: 300, kcal_source: "health_connect", minutes: 30 };
  near(
    burnedDay({ deviceDay: null, bmr, intake: 0, activities: [run] }).kcal,
    empty.kcal + 300,
  );
  // Device active energy holds everyday movement: unchanged.
  near(
    burnedDay({
      deviceDay: { active_kcal: 600 },
      bmr,
      intake: 2000,
      activities: [run],
    }).kcal,
    bmr + 600 + 200,
  );
});

// A device day with `active` kcal of active energy, resting 1,800, 2,000
// eaten: a phone left on a desk reads under resting × 0.1.
const activeDay = (active) =>
  burnedDay({
    deviceDay: { active_kcal: active },
    bmr: 1800,
    intake: 2000,
    activities: [],
  });
// A 500 kcal hour (1,440 kcal resting is 1 kcal a minute: an hour's 60).
const hour = (rest) => ({ kcal: 500, minutes: 60, ...rest });
// An hour of `type` at 70 kg without energy, netted.
const estimate = (type, rest = {}) =>
  activeEnergy({ kcal: null, minutes: 60, weight_kg: 70, type, ...rest }, 1440)
    .active;
// Its active energy alone.
const net = (s, bmr) => activeEnergy(s, bmr).active;

test("burned: device active energy never counts under everyday movement", () => {
  assert.deepEqual(activeDay(50), { kcal: 1800 + 200 + 180, source: "active" });
  assert.deepEqual(activeDay(0), { kcal: 1800 + 200 + 180, source: "active" });
  assert.deepEqual(activeDay(400), {
    kcal: 1800 + 200 + 400,
    source: "active",
  });
});

test("activity energy: a device's active net; hand, import and a device total gross less resting; none by type's MET", () => {
  assert.equal(net(hour({ kcal_source: "health_connect" }), 1440), 500);
  assert.equal(net(hour({ kcal_source: "hand" }), 1440), 440);
  assert.equal(net(hour({ kcal_source: "import" }), 1440), 440);
  // A device's total over the activity (no active energy) is gross too.
  assert.equal(net(hour({ kcal_source: "health_connect_total" }), 1440), 440);
  // Never below 0.
  assert.equal(net(hour({ kcal: 30, kcal_source: "hand" }), 1440), 0);
  // No energy: (MET − 1) × kg × h by type, net already.
  assert.equal(estimate("walk"), Math.round((METS.walk - 1) * 70));
  assert.equal(estimate("yoga"), Math.round((METS.yoga - 1) * 70));
  assert.equal(estimate("workout"), Math.round((METS.workout - 1) * 70));
  assert.notEqual(
    estimate("walk"),
    estimate("cycling"),
    "one MET for every type",
  );
  // An unknown type is "other". A run with its distance costs its
  // net ~1 kcal a kg a km (Margaria 1963), resting not taken off again:
  // 70 kg × 6 km, not (12 − 1) × 70 × 0.5 = 385; under 50 m (a device's
  // leftover) is no distance, so the run's MET.
  assert.equal(estimate("unicycling"), Math.round((METS.other - 1) * 70));
  assert.equal(estimate("run", { minutes: 30, distance_m: 6000 }), 420);
  assert.equal(
    estimate("run", { minutes: 30, distance_m: 2 }),
    Math.round((METS.run - 1) * 70 * 0.5),
  );
  // Without a weight it can't be estimated: the day counts no activity.
  assert.equal(estimate("walk", { weight_kg: null }), null);
  assert.equal(
    dayActive(null, [{ kcal: null, minutes: 60, type: "walk" }]),
    null,
  );
  // An estimated activity reaches Burned (the audit: dropped before).
  near(
    burnedDay({
      deviceDay: null,
      bmr: 1440,
      intake: 2000,
      activities: [{ kcal: null, minutes: 60, weight_kg: 70, type: "walk" }],
    }).kcal,
    1440 * 1.1 + 200 + estimate("walk"),
  );
});

// A day's active energy (activeKcal) from its activities at `bmr`.
const dayActive = (deviceDay, activities, bmr = 1800) =>
  activeKcal({
    deviceDay,
    energies: activities.map((s) => activeEnergy(s, bmr)),
  });

test("active energy: max(device active, Σ active of activities), null with neither", () => {
  const run = { kcal: 450, kcal_source: "health_connect", minutes: 40 };
  // The device's or the activities', the larger; measured either way.
  const measured = { floor: false, estimated: false };
  assert.deepEqual(dayActive({ active_kcal: 300 }, [run]), {
    kcal: 450,
    ...measured,
  });
  assert.deepEqual(dayActive({ active_kcal: 600 }, [run]), {
    kcal: 600,
    ...measured,
  });
  assert.deepEqual(dayActive({ active_kcal: 120 }, []), {
    kcal: 120,
    ...measured,
  });
  // Activities alone leave everyday movement out: a floor.
  assert.deepEqual(dayActive(null, [run]), {
    kcal: 450,
    floor: true,
    estimated: false,
  });
  assert.equal(dayActive({}, [{ kcal: null, minutes: 30 }]), null);
  // An estimate in the sum is one; a device's larger value isn't.
  const walk = { kcal: null, minutes: 60, weight_kg: 70, type: "walk" };
  assert.deepEqual(dayActive(null, [run, walk]), {
    kcal: 450 + estimate("walk"),
    floor: true,
    estimated: true,
  });
  assert.deepEqual(dayActive({ active_kcal: 2000 }, [walk]), {
    kcal: 2000,
    ...measured,
  });
  // A total with resting unknown adds nothing (its row says it as a
  // total).
  assert.equal(dayActive(null, [hour({ kcal_source: "hand" })], null), null);
});

test("BMR: Mifflin–St Jeor every day, never from a scale's body fat or its own estimate (EN-8)", () => {
  const weights = [
    { day: shift(T, -60), kg: 82 },
    { day: shift(T, -10), kg: 80 },
  ];
  const fat = (ago, bf) => ({ day: shift(T, -ago), body_fat: bf });
  // Body fat on 4 days and the scale's own BMR: bioimpedance, so neither
  // is resting energy's input (Katch–McArdle took 3 readings before).
  const readings = [
    fat(20, 20),
    fat(10, 20),
    fat(5, 20),
    fat(1, 20),
    { day: shift(T, -3), bmr_kcal: 1650 },
  ];
  const bmr = bmrOf({ person: MAN, weights, readings, to: T });
  assert.deepEqual(bmr(T), {
    kcal: mifflin(MAN, 80, T),
    source: "mifflin",
    origin: null,
  });
  // The weight standing that day; before the first, the first.
  near(bmr(shift(T, -30)).kcal, mifflin(MAN, 82, shift(T, -30)));
  near(bmr(shift(T, -90)).kcal, mifflin(MAN, 82, shift(T, -90)));
  // Without a weight, or sex, birth date and height: none.
  assert.equal(bmrOf({ person: MAN, weights: [] })(T), null);
  assert.equal(bmrOf({ person: {}, weights })(T), null);
});

// Inputs for burnedDays over `n` days ending T: food and an activity every
// day, a weigh-in every day, each `day` read counted in `reads`.
function year(n) {
  const reads = { n: 0 };
  const counted = (day, rest) => ({
    get day() {
      reads.n++;
      return day;
    },
    ...rest,
  });
  const span = Array.from({ length: n }, (_, i) => shift(T, i - n + 1));
  return {
    reads,
    from: span[0],
    to: T,
    days: span.map((day) => ({ day, total: { energy: 2000 } })),
    deviceDays: [],
    activities: span.map((day) =>
      counted(day, { kcal: 300, kcal_source: "health_connect", minutes: 30 }),
    ),
    weights: span.map((day) => counted(day, { kg: 80 })),
  };
}

test("burned days are linear: no per-day scan of the activities or weigh-ins", () => {
  // Timing-free: count the reads of an activity's or weigh-in's day. A scan
  // per day reads days × records (133,225 for a year); bucketing and a
  // binary search read a few per record and a log per day.
  for (const n of [365, 730]) {
    const y = year(n);
    const bmr = bmrOf({ person: MAN, weights: y.weights });
    const out = burnedDays({ ...y, bmr });
    assert.equal(out.length, n);
    assert.ok(y.reads.n < 30 * n, `${n} days: ${y.reads.n} reads`);
  }
});

test("period after yesterday → no burned days; a running one ends yesterday", () => {
  const y = year(10);
  const bmr = bmrOf({ person: MAN, weights: y.weights });
  const inputs = {
    days: y.days,
    deviceDays: [],
    activities: y.activities,
    bmr,
  };
  // Today starts the period (a Monday's week): nothing is over yet.
  assert.deepEqual(
    burnedOver({
      ...inputs,
      from: T,
      to: shift(T, 6),
      yesterday: shift(T, -1),
    }),
    [],
  );
  // A week that began 3 days ago: its 3 days over, never today or after.
  const days = burnedOver({
    ...inputs,
    from: shift(T, -3),
    to: shift(T, 3),
    yesterday: shift(T, -1),
  }).map((b) => b.day);
  assert.deepEqual(days, [shift(T, -3), shift(T, -2), shift(T, -1)]);
});

// `n` days that burned `kcal`.
const device = (n, kcal, source = "active") =>
  Array.from({ length: n }, () => ({ kcal, source }));

test("maintenance said to 10 kcal, like its range and the target (EN-9)", () => {
  assert.equal(
    maintenanceText({ kcal: 2153.4, spread: 221.4 }),
    "≈ 2,150\u00A0kcal (± 220)",
  );
  assert.equal(maintenanceText({ kcal: 2386 }), "≈ 2,390\u00A0kcal");
});

test("maintenance: the mean of every day burned, not only the device's high days (EN-3)", () => {
  // 9 days the device read high, 19 quiet ones under the estimate: the
  // window's mean is of all 28.
  const burned = [...device(9, 2400), ...device(19, 2050, "activities")];
  const m = maintenanceOf({ balance: { enough: false }, burned });
  assert.equal(m.source, "burned");
  near(m.kcal, (9 * 2400 + 19 * 2050) / 28);
});

test("maintenance: the adaptive balance when sure, else the mean of burned, else PAL", () => {
  const sureBalance = { enough: true, maintenance: 2500, spread: 180 };
  assert.deepEqual(
    maintenanceOf({ balance: sureBalance, burned: device(20, 2800) }),
    { kcal: 2500, source: "balance", spread: 180 },
  );
  // Its 95 % range wider than ± 250 kcal: not sure, the mean of burned.
  assert.deepEqual(
    maintenanceOf({
      balance: { ...sureBalance, spread: 260 },
      burned: device(20, 2800),
    }),
    { kcal: 2800, source: "burned" },
  );
  // Under resting × 1.1 or over × 2.5: noise, not a body.
  for (const maintenance of [1900, 4600])
    assert.equal(
      maintenanceOf({
        balance: { ...sureBalance, maintenance },
        burned: device(20, 2800),
        bmr: 1800,
      }).source,
      "burned",
      String(maintenance),
    );
  assert.equal(
    maintenanceOf({ balance: sureBalance, bmr: 1800, activity: 1.5 }).source,
    "balance",
  );
  assert.deepEqual(
    maintenanceOf({
      balance: { enough: false },
      burned: [...device(14, 2800), { kcal: 1900, source: "activities" }],
      bmr: 1800,
      activity: 1.6,
    }),
    { kcal: (14 * 2800 + 1900) / 15, source: "burned" },
  );
  assert.deepEqual(
    maintenanceOf({
      balance: { enough: false },
      burned: device(5, 2800),
      bmr: 1800,
      activity: 1.5,
    }),
    { kcal: 2700, source: "pal", pal: 1.5 },
  );
  assert.equal(
    maintenanceOf({ balance: { enough: false }, burned: [], bmr: null }),
    null,
  );
});

// The mean kcal of burned rows.
const mean = (list) => list.reduce((t, b) => t + b.kcal, 0) / list.length;

test("maintenance by day: the window ending each day, balance → mean of burned → PAL (EN-4)", () => {
  // 70 days ending T: the device's active energy 600 on the first 20; from
  // day 20 food (2200) every day and a weigh-in every other day, 0.05 kg a
  // day down.
  const at = (i) => shift(T, i - 69);
  const n = Array.from({ length: 70 }, (_, i) => i);
  const days = n
    .filter((i) => i >= 20)
    .map((i) => ({ day: at(i), total: { energy: 2200 } }));
  const weights = n
    .filter((i) => i >= 20 && i % 2 === 0)
    .map((i) => ({ day: at(i), kg: 80 - 0.05 * (i - 20) }));
  const deviceDays = n
    .filter((i) => i < 20)
    .map((i) => ({ day: at(i), total_kcal: 2600, active_kcal: 600 }));
  const bmr = bmrOf({ person: MAN, weights });
  const burned = burnedDays({
    from: at(0),
    to: T,
    days,
    deviceDays,
    activities: [],
    bmr,
  });
  const series = maintenanceSeries({
    from: at(0),
    to: T,
    days,
    weights,
    burned,
    bmr,
    pal: 1.5,
  });
  assert.equal(series.length, 70);
  const of = new Map(series.map((m) => [m.day, m]));
  // Under 14 days burned: resting × PAL (no history yet).
  assert.equal(of.get(at(5)).source, "pal");
  near(of.get(at(5)).kcal, bmr(at(5)).kcal * 1.5);
  // 14 days burned in the window: their mean, never PAL again.
  assert.equal(of.get(at(15)).source, "burned");
  near(of.get(at(15)).kcal, mean(burned.slice(0, 16)));
  assert.ok(
    series.filter((m) => m.day >= at(13)).every((m) => m.source !== "pal"),
  );
  // 14 food days and weigh-ins 10+ days apart: the balance, from the
  // trend's slope (at the end every trend point averages a full week, so
  // it is the weigh-ins' 0.05 kg a day; early on it lags).
  assert.equal(of.get(at(40)).source, "balance");
  assert.equal(of.get(T).source, "balance");
  near(of.get(T).kcal, 2200 + 0.05 * 7700);
  near(of.get(T).spread, 0);
  // Each day as `plan` takes its window, one by one.
  for (const i of n) {
    const day = at(i);
    const want = maintenanceOf({
      balance: balance({ days, weights, yesterday: day }),
      burned: burned.filter((b) => b.day > shift(day, -28) && b.day <= day),
      bmr: bmr(day).kcal,
      activity: 1.5,
    });
    assert.equal(of.get(day).source, want.source, day);
    near(of.get(day).kcal, want.kcal);
  }
  // Inputs from before the first window change nothing: the sums
  // never take away a day they didn't add.
  // From day 40 the first window starts on day 13: a food day before it
  // and the burned days 0–12 are given but outside.
  const sliced = (list) => list.filter((x) => x.day >= at(13));
  const more = [{ day: at(5), total: { energy: 9000 } }, ...days];
  const fromLater = (inputs) =>
    maintenanceSeries({
      from: at(40),
      to: T,
      days,
      weights,
      burned,
      bmr,
      pal: 1.5,
      ...inputs,
    });
  assert.deepEqual(
    fromLater({ days: more }),
    fromLater({ days: sliced(days), burned: sliced(burned) }),
  );
});

// A man of 80 kg using 2500 kcal, resting 1750.
const base = {
  today: T,
  weight: 80,
  bf: null,
  goalWeight: null,
  goalBf: null,
  goalDate: null,
  goalKgPerWeek: 0,
  maintenance: 2500,
  bmr: 1750,
  sex: "male",
};

test("needed: weight goal only, by date, at 7700 kcal a kg", () => {
  // −4 kg in 70 days (0.4 kg a week): 4 × 7700 / 70 = 440 a day.
  const n = needed({ ...base, goalWeight: 76, goalDate: shift(T, 70) });
  near(n.perDay, -440);
  assert.equal(n.target, 2060);
  assert.equal(n.split, null, "no body fat reading: no fat/lean split");
  assert.deepEqual(n.clamps, []);
});

test("needed: body-fat goal only keeps lean mass", () => {
  // 80 kg at 25 % → 20 %: lean 60 kg stays, goal 75 kg; all of it fat.
  const n = needed({
    ...base,
    bf: 25,
    goalBf: 20,
    goalDate: shift(T, 100),
  });
  near(n.goalKg, 75);
  near(n.split.fat, -5);
  near(n.split.lean, 0);
  near(n.perDay, (-5 * 9440) / 100);
  // Without a reading no goal follows from body fat alone.
  assert.equal(needed({ ...base, goalBf: 20, goalDate: shift(T, 100) }), null);
});

test("needed: both goals, weight wins and body fat splits it (Hall 2008)", () => {
  // 80 kg at 25 % → 74 kg at 20 %: fat 20 → 14.8 (−5.2), lean 60 → 59.2 (−0.8).
  const n = needed({
    ...base,
    bf: 25,
    goalWeight: 74,
    goalBf: 20,
    goalDate: shift(T, 120),
  });
  near(n.goalKg, 74);
  near(n.split.fat, -5.2);
  near(n.split.lean, -0.8);
  near(n.perDay, (-5.2 * 9440 - 0.8 * 1816) / 120);
});

test("needed: a past or missing goal date falls back to kg a week", () => {
  for (const goalDate of [T, shift(T, -3), null]) {
    const n = needed({
      ...base,
      goalWeight: 76,
      goalDate,
      goalKgPerWeek: -0.5,
    });
    near(n.perDay, (-0.5 * 7700) / 7);
    assert.equal(n.target, 1950);
  }
  // No goal at all: what you use.
  assert.equal(needed(base).target, 2500);
});

test("needed: loss ≤ 1 %/week, gain ≤ 0.5 %/week, never under the floor", () => {
  // −10 kg in 28 days is 2.5 kg a week: capped at 0.8.
  const fast = needed({
    ...base,
    maintenance: 2800,
    goalWeight: 70,
    goalDate: shift(T, 28),
  });
  near(fast.weeklyKg, -0.8);
  near(fast.perDay, (-0.8 * 7700) / 7);
  assert.equal(fast.clamps.length, 1);
  assert.match(fast.clamps[0], /1\u00A0%/u);
  const gain = needed({ ...base, goalWeight: 90, goalDate: shift(T, 28) });
  near(gain.weeklyKg, 0.4);
  assert.match(gain.clamps[0], /0\.5\u00A0%/u);
  // A floor: the higher of BMR and 1500 (men) / 1200 (women).
  const low = needed({
    ...base,
    maintenance: 1600,
    bmr: 1400,
    goalKgPerWeek: -0.7,
  });
  assert.equal(low.target, 1500);
  assert.match(low.clamps.at(-1), /1\D?500\skcal/u);
  const woman = needed({
    ...base,
    sex: "female",
    maintenance: 1500,
    bmr: 1100,
    goalKgPerWeek: -0.7,
  });
  assert.equal(woman.target, 1200);
  const highBmr = needed({
    ...base,
    maintenance: 2000,
    bmr: 1800,
    goalKgPerWeek: -1,
  });
  assert.equal(highBmr.target, 1800);
});

test("needed: recomposition trims 10 % and raises protein", () => {
  // 80 kg at 25 % → 80 kg at 20 %: fat −4, lean +4, |Δw| ≤ 1.
  const n = needed({
    ...base,
    bf: 25,
    goalWeight: 80,
    goalBf: 20,
    goalDate: shift(T, 120),
  });
  assert.equal(n.recomp, true);
  assert.equal(n.target, 2250);
  // 2.4 g a kg of lean mass (60 kg) when body fat is known.
  near(n.protein, 144);
  // A gain of fat isn't a recomposition.
  const up = needed({
    ...base,
    bf: 15,
    goalWeight: 80.5,
    goalBf: 20,
    goalDate: shift(T, 120),
  });
  assert.equal(up.recomp, false);
  assert.equal(up.protein, null);
});

// -------------------------------------------- measured activity energy

// Text as read: no-break spaces as spaces.
const read = (text) => text?.replaceAll(" ", " ") ?? null;
const ENERGY = {
  key: "energy",
  label: "Energy",
  unit: "kcal",
  goal: "about",
  category: "General",
};

test("activeEnergy: a device's active as measured, a total netted of resting, an estimate alone ≈", () => {
  // 1,560 kcal a day is 65 kcal an hour.
  const total = { kcal: 355, minutes: 60 };
  assert.deepEqual(
    activeEnergy({ ...total, kcal_source: "health_connect" }, 1560),
    { active: 355, total: null, estimated: false },
  );
  for (const kcal_source of ["health_connect_total", "hand", "import"])
    assert.deepEqual(activeEnergy({ ...total, kcal_source }, 1560), {
      active: 290,
      total: 355,
      estimated: false,
    });
  // Under its resting share: 0, never below.
  assert.deepEqual(
    activeEnergy({ kcal: 100, minutes: 120, kcal_source: "hand" }, 1700),
    { active: 0, total: 100, estimated: false },
  );
  // Resting unknown: the total as it is, no active energy.
  assert.deepEqual(activeEnergy({ ...total, kcal_source: "hand" }, null), {
    active: null,
    total: 355,
    estimated: false,
  });
  // No energy: estimated from type, time and weight; none without weight.
  const walk = { kcal: null, minutes: 60, type: "walk" };
  assert.deepEqual(activeEnergy({ ...walk, weight_kg: 80 }, 1560), {
    active: 200,
    total: null,
    estimated: true,
  });
  assert.deepEqual(activeEnergy({ ...walk, weight_kg: null }, 1560), {
    active: null,
    total: null,
    estimated: true,
  });
});

test("activeEnergyText: measured without ≈, a total beside its active, ≈ only on an estimate, in kcal and kJ", () => {
  const texts = () =>
    [
      { active: 410, total: null, estimated: false },
      { active: 290, total: 355, estimated: false },
      { active: 0, total: 100, estimated: false },
      { active: null, total: 355, estimated: false },
      { active: 288, total: null, estimated: true },
      { active: null, total: null, estimated: true },
    ].map((e) => read(activeEnergyText(e)));
  setRegistry([ENERGY], "kcal");
  assert.deepEqual(texts(), [
    "active 410 kcal",
    "active 290 kcal · 355 total",
    "active 0 kcal · 100 total",
    "355 kcal total",
    "active ≈ 288 kcal",
    null,
  ]);
  setRegistry([ENERGY], "kJ");
  assert.deepEqual(texts(), [
    "active 1,715 kJ",
    "active 1,213 kJ · 1,485 total",
    "active 0 kJ · 418 total",
    "1,485 kJ total",
    "active ≈ 1,205 kJ",
    null,
  ]);
  setRegistry([], "kcal");
});

test("activeMark: a floor ≥, an estimate in the sum ≈, measured nothing", () => {
  assert.equal(read(activeMark({ floor: true, estimated: true })), "≥ ");
  assert.equal(read(activeMark({ floor: false, estimated: true })), "≈ ");
  assert.equal(activeMark({ floor: false, estimated: false }), "");
});

test("activeOf: resting as served on the activity, else Mifflin at its weight", () => {
  const ctx = { person: MAN, weights: [{ day: T, kg: 80 }] };
  const typed = { day: T, kcal: 355, minutes: 60, kcal_source: "hand" };
  // Served: 1,560 a day.
  assert.deepEqual(activeOf({ ...typed, weight_kg: 80, bmr_kcal: 1560 }, ctx), {
    active: 290,
    total: 355,
    estimated: false,
  });
  // Mifflin at 80 kg, 1,750 a day: 72.9 of the hour.
  assert.equal(activeOf({ ...typed, weight_kg: 80 }, ctx).active, 282);
  // One not sent yet carries no weight: the latest weigh-in stands in.
  assert.equal(activeOf(typed, ctx).active, 282);
  assert.equal(
    activeOf({ day: T, kcal: null, minutes: 60, type: "walk" }, ctx).active,
    200,
  );
  // Without a weight, a total stays a total.
  assert.deepEqual(activeOf({ ...typed, weight_kg: null }, ctx), {
    active: null,
    total: 355,
    estimated: false,
  });
});

test("a day's active energy is the sum of its rows' active", () => {
  const ctx = { person: MAN, weights: [{ day: T, kg: 80 }] };
  const activities = [
    { day: T, kcal: 355, minutes: 60, kcal_source: "hand", weight_kg: 79 },
    { day: T, kcal: 500, minutes: 45, kcal_source: "import", weight_kg: 79 },
    { day: T, kcal: null, minutes: 30, type: "walk", weight_kg: 79 },
    { day: T, kcal: 120, minutes: 20, kcal_source: "health_connect" },
  ];
  const rows = activities
    .map((s) => activeOf(s, ctx).active)
    .reduce((t, k) => t + k, 0);
  const data = { day: T, weight: 80, device_day: null, activities };
  assert.deepEqual(dayEnergy(data, MAN), {
    kcal: rows,
    floor: true,
    estimated: true,
  });
});

test("workoutLine: a workout's total reads as its activities will, netted of today's resting", () => {
  setRegistry([ENERGY], "kcal");
  const lib = library([]);
  const typed = { steps: [], minutes: 60, kcal: 355 };
  assert.equal(
    read(workoutLine(typed, lib, { kg: 80, bmr: 1560 })),
    "0 sets · 60 min · active 290 kcal · 355 total",
  );
  // Resting unknown: the total as typed.
  assert.equal(
    read(workoutLine(typed, lib, { kg: null, bmr: null })),
    "0 sets · 60 min · 355 kcal total",
  );
  // Nothing typed: the estimate, (5 − 1) × 80 kg × 1 h.
  assert.equal(
    read(workoutLine({ steps: [], minutes: 60 }, lib, { kg: 80, bmr: 1560 })),
    "0 sets · 60 min · active ≈ 320 kcal",
  );
  setRegistry([], "kcal");
});

// ------------------------------------------------------ decision edges

test("needed: a reached goal or a pace away from it plans at maintenance (TEST11-5)", () => {
  // 0.05 kg off the goal is reached, whichever way the pace points.
  for (const goalKgPerWeek of [-0.5, 0.5]) {
    const n = needed({ ...base, goalWeight: 80.05, goalKgPerWeek });
    assert.equal(n.target, base.maintenance);
    assert.equal(n.perDay, 0);
    assert.deepEqual(n.clamps, [
      "Goal weight reached: planned at maintenance.",
    ]);
  }
  // A pace losing weight toward a goal above, or gaining toward one below.
  const up = needed({ ...base, goalWeight: 85, goalKgPerWeek: -0.5 });
  assert.equal(up.target, base.maintenance);
  assert.equal(up.perDay, 0);
  assert.deepEqual(up.clamps, [
    "Your pace loses weight but your goal is above it: planned at maintenance.",
  ]);
  const down = needed({ ...base, goalWeight: 75, goalKgPerWeek: 0.5 });
  assert.equal(down.perDay, 0);
  assert.deepEqual(down.clamps, [
    "Your pace gains weight but your goal is below it: planned at maintenance.",
  ]);
});

test("needed: edges, each on both sides (TEST11-13)", () => {
  // Recomposition at exactly 1 kg from the goal; not past it.
  const recomp = (goalWeight) =>
    needed({ ...base, bf: 25, goalWeight, goalBf: 20, goalDate: shift(T, 120) })
      .recomp;
  assert.equal(recomp(79), true);
  assert.equal(recomp(78.9), false);
  // A pace of exactly 1 % a week isn't slowed; past it, it is.
  const pace = (goalKgPerWeek) =>
    needed({ ...base, maintenance: 3000, goalKgPerWeek }).clamps;
  assert.deepEqual(pace(-0.8), []);
  assert.equal(pace(-0.81).length, 1);
  // No sex: the lower floor (women's), said as the lowest planned.
  const unknown = needed({
    ...base,
    sex: null,
    maintenance: 1300,
    bmr: 1000,
    goalKgPerWeek: -0.7,
  });
  assert.equal(unknown.target, 1200);
  assert.match(unknown.clamps.at(-1), /the lowest planned for women/u);
  // Resting energy over the floor: the clamp names it.
  const rest = needed({
    ...base,
    maintenance: 2000,
    bmr: 1800,
    goalKgPerWeek: -1,
  });
  assert.equal(rest.target, 1800);
  assert.match(rest.clamps.at(-1), /: your resting energy\.$/u);
});

// A balance sure enough to judge: its `spread` and `maintenance`.
const judged = (spread, maintenance = 2000) => ({
  enough: true,
  spread,
  maintenance,
});

test("sure and offered: edges, each on both sides (TEST11-13)", () => {
  // A spread of exactly 250 kcal is sure; past it, not.
  assert.equal(sure(judged(250), null), true);
  assert.equal(sure(judged(250.5), null), false);
  // Plausible from 1.1 to 2.5 × resting, both ends in.
  assert.equal(sure(judged(100, 1100), 1000), true);
  assert.equal(sure(judged(100, 1099), 1000), false);
  assert.equal(sure(judged(100, 2500), 1000), true);
  assert.equal(sure(judged(100, 2501), 1000), false);
  // A change of exactly 50 kcal is offered, 49 isn't; without a target,
  // any is.
  assert.equal(offered(2000, 2050), true);
  assert.equal(offered(2000, 2049), false);
  assert.equal(offered(2000, null), true);
  assert.equal(offered(30, null), true);
});

test("resting energy's weigh-in: carried 90 days, then the next, else the last (TEST11-13)", () => {
  const first = shift(T, -200);
  const weights = [
    { day: first, kg: 90 },
    { day: T, kg: 80 },
  ];
  const kgOn = (day) => {
    const k = bmrOf({ person: MAN, weights })(day).kcal;
    return (k - mifflin(MAN, 0, day)) / 10;
  };
  near(kgOn(shift(first, 90)), 90);
  near(kgOn(shift(first, 91)), 80);
  // After the last weigh-in, however long: it stands.
  near(kgOn(shift(T, 500)), 80);
});

// ------------------------------------------------------ resting energy

const SAMSUNG = "com.sec.android.app.shealth";

test("bmrOf: Health Connect's resting energy where served, else Mifflin, its source and origin per day", () => {
  const weights = [{ day: shift(T, -10), kg: 80 }];
  // The server serves each day's resting in effect (its own, else carried
  // up to 6 days): the client takes the day's as it is.
  const resting = [
    { day: shift(T, -1), kcal: 1720, origin: SAMSUNG },
    { day: T, kcal: 1720, origin: SAMSUNG },
  ];
  const bmr = bmrOf({ person: MAN, weights, resting });
  assert.deepEqual(bmr(T), {
    kcal: 1720,
    source: "health_connect",
    origin: SAMSUNG,
  });
  assert.deepEqual(bmr(shift(T, -2)), {
    kcal: mifflin(MAN, 80, shift(T, -2)),
    source: "mifflin",
    origin: null,
  });
  // Health Connect's needs no weight or body.
  assert.equal(bmrOf({ person: {}, weights: [], resting })(T).kcal, 1720);
  assert.equal(bmrOf({ person: {}, weights: [], resting })(shift(T, -2)), null);
});

test("appOf: an origin package as its app, else the package", () => {
  assert.equal(appOf(SAMSUNG), "Samsung Health");
  assert.equal(appOf("com.fitbit.FitbitMobile"), "Fitbit");
  assert.equal(appOf("com.google.android.apps.fitness"), "Google Fit");
  assert.equal(appOf("com.health.openscale.pro"), "openScale");
  assert.equal(appOf("com.withings.wiscale2"), "Withings");
  assert.equal(appOf("org.example.scale"), "org.example.scale");
});

test("activeOf and burned: one resting a day, Health Connect's where served", () => {
  const typed = { day: T, kcal: 355, minutes: 60, kcal_source: "hand" };
  const resting = [{ day: T, kcal: 1440, origin: SAMSUNG }];
  // Not yet sent (no `bmr_kcal`): the day's served resting, 60 kcal of
  // the hour, not Mifflin's 72.9.
  assert.equal(
    activeOf({ ...typed, weight_kg: 80 }, { person: MAN, resting }).active,
    295,
  );
  // Burned of that day nets the same resting.
  const bmr = bmrOf({ person: MAN, weights: [], resting });
  const [b] = burnedDays({
    from: T,
    to: T,
    days: [{ day: T, total: { energy: 2000 } }],
    deviceDays: [],
    activities: [{ ...typed, weight_kg: 80 }],
    bmr,
  });
  near(b.kcal, 1440 + 200 + 144 + 295);
});

test("an estimate is said to 10 kcal, or 50 kJ: rounded in the unit shown (QUAL11-N2)", () => {
  setRegistry([ENERGY], "kJ");
  // 2,520 kcal is 10,543.7 kJ; its range 221.4 kcal is 926.3 kJ.
  assert.equal(
    read(maintenanceText({ kcal: 2520, spread: 221.4 })),
    "≈ 10,550 kJ (± 950)",
  );
  setRegistry([ENERGY], "kcal");
  assert.equal(read(maintenanceText({ kcal: 2520 })), "≈ 2,520 kcal");
  setRegistry([], "kcal");
});
