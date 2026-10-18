// The energy model's façade and the Summary charts' series (web/
// series.mjs): exactly what each chart draws, its target lines and which
// start hidden; maintenance as Targets plans it; a Diary day's energy.

import assert from "node:assert/strict";
import test from "node:test";

// web/api.mjs keeps the profile in localStorage; a Map stands in for it.
const store = new Map();
Object.defineProperty(globalThis, "localStorage", {
  value: {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  },
});

const { period, shift, today } = await import("../web/dates.mjs");
const { plan } = await import("../web/energy.mjs");
const {
  bmiRange,
  bodyLines,
  dayEnergy,
  eatenSeries,
  energySeries,
  gapOf,
  gapText,
  niceStep,
  spanAtLeast,
  zoomTicks,
  macroSeries,
  maintenance,
  periodNumbers,
  seriesMarks,
  sharedSeries,
  withHidden,
} = await import("../web/series.mjs");
const { seriesInfo } = await import("../web/series-keys.mjs");

const { setRegistry } = await import("../web/nutrients.mjs");
const ENERGY = {
  key: "energy",
  label: "Energy",
  unit: "kcal",
  goal: "about",
  category: "General",
};

const day = (d, energy) => ({ day: d, total: { energy } });
const same = (v) => v;
const say = (v) => `${v} kcal`;
const shape = (marks) => marks.map((m) => [m.key, m.kind]);

test("the energy chart is exactly eaten and burned, points and trend, and the target (items 13, 17)", () => {
  const { keys, marks } = energySeries({
    days: [day("2026-03-02", 1500), day("2026-03-03", 2500)],
    burned: [{ day: "2026-03-02", kcal: 2200 }],
    target: { value: 2000 },
    by: "day",
    show: same,
    say,
  });
  assert.deepEqual(keys, ["2026-03-02", "2026-03-03"]);
  assert.deepEqual(shape(marks), [
    ["eaten", "points"],
    ["eaten", "trend"],
    ["burned", "points"],
    ["burned", "trend"],
    ["target", "line"],
  ]);
  assert.deepEqual(
    marks.map((m) => m.label),
    ["Eaten", "Eaten trend", "Burned ≈", "Burned ≈ trend", "Eaten target"],
  );
  assert.deepEqual(marks[0].data, [1500, 2500]);
  assert.deepEqual(marks[1].data, [1500, 2000]);
  // A day without burned is no point, not 0.
  assert.deepEqual(marks[2].data, [2200, null]);
  assert.equal(marks[4].value, 2000);
  // Owner (2026-10-14): the target is what to eat, named so.
  assert.equal(marks[4].text, "Eaten target: 2000 kcal");
  // Without a target: no line.
  const bare = energySeries({
    days: [day("2026-03-02", 1500)],
    burned: [],
    target: null,
    by: "day",
    show: same,
    say,
  });
  assert.equal(bare.marks.filter((m) => m.kind === "line").length, 0);
});

test("a day whose eaten energy leaves some out is a ≥ point of eaten's, as the Diary's (EN-11, E3-6, U3-6)", () => {
  const { marks } = energySeries({
    days: [
      day("2026-10-10", 2000),
      { ...day("2026-10-11", 1848), energy_unknown: true },
      { ...day("2026-10-12", 1900), known: { energy: 1500 } },
    ],
    burned: [],
    target: null,
    by: "day",
    show: same,
    say,
  });
  // One points mark for eaten (one legend entry), each partial day
  // flagged: "≥" and why in the tooltip and the list, not the legend.
  const eaten = marks.filter((m) => m.kind === "points");
  assert.deepEqual(
    eaten.map((m) => [m.label, m.data, m.partly]),
    [
      ["Eaten", [2000, 1848, 1900], [false, true, true]],
      ["Burned ≈", [null, null, null], [false, false, false]],
    ],
  );
  assert.equal(eaten[0].partlyNote, "some energy unknown");
  // One trend over every day eaten.
  assert.deepEqual(
    marks.find((m) => m.key === "eaten" && m.kind === "trend").data,
    [2000, 1924, 1916],
  );
});

test("a year's week is one eaten point, its mean over all its days, ≥ when any is partial (E3-2, TFA-F1)", () => {
  // Week of Mon Oct 5: five whole days and two partial ones.
  const whole = [1729, 1694, 1883, 1810, 1790].map((kcal, i) =>
    day(`2026-10-0${5 + i}`, kcal),
  );
  const { keys, marks } = energySeries({
    days: [
      ...whole,
      { ...day("2026-10-10", 3545), energy_unknown: true },
      { ...day("2026-10-11", 1848), energy_unknown: true },
    ],
    burned: [],
    target: null,
    by: "week",
    show: same,
    say,
  });
  assert.deepEqual(keys, ["2026-10-05"]);
  const eaten = marks.filter((m) => m.key === "eaten" && m.kind === "points");
  assert.equal(eaten.length, 1);
  // (1,729 + 1,694 + 1,883 + 1,810 + 1,790 + 3,545 + 1,848) / 7 = 2,042.7.
  assert.deepEqual(eaten[0].data, [2043]);
  assert.deepEqual(eaten[0].partly, [true]);
});

test("a year's week sets eaten against burned over the same days: its food days (E3-1)", () => {
  // Week of Sep 7: one food day; burned every day, 2,507 on the food day.
  const burned = [2507, 2300, 2300, 2300, 2300, 2300, 2300].map((kcal, i) => ({
    day: `2026-09-${String(7 + i).padStart(2, "0")}`,
    kcal,
  }));
  const { marks } = energySeries({
    days: [day("2026-09-07", 3376)],
    burned,
    target: null,
    by: "week",
    show: same,
    say,
  });
  const out = marks.find((m) => m.key === "burned" && m.kind === "points");
  assert.deepEqual(out.data, [2510]);
  // By day, each day over has its burned point (to set against a plan).
  const daily = energySeries({
    days: [day("2026-09-07", 3376)],
    burned,
    target: null,
    by: "day",
    show: same,
    say,
  });
  assert.equal(
    daily.marks.find((m) => m.key === "burned" && m.kind === "points").data
      .length,
    7,
  );
});

test("burned is to 10 kcal everywhere it's said, points and trend (E3-9)", () => {
  const { marks } = energySeries({
    days: [day("2026-10-01", 2000), day("2026-10-02", 2000)],
    burned: [
      { day: "2026-10-01", kcal: 2377 },
      { day: "2026-10-02", kcal: 2194 },
    ],
    target: null,
    by: "day",
    show: same,
    say,
  });
  const burned = marks.filter((m) => m.key === "burned");
  for (const m of burned)
    for (const v of m.data.filter((x) => x !== null))
      assert.equal(v % 10, 0, `${m.kind} ${v}`);
  assert.deepEqual(burned[0].data, [2380, 2190]);
});

test("a series' points by kind: maintenance names its method per point, its own shape (B-7, B3-7, B3-10)", () => {
  const daily = [
    { day: "2026-10-03", value: 2156, source: "balance" },
    { day: "2026-10-04", value: 2190, source: "burned" },
    { day: "2026-10-05", value: 2150, source: "balance" },
  ];
  const keys = daily.map((x) => x.day);
  const marks = seriesMarks({
    key: "maintenance",
    label: "Maintenance ≈",
    daily,
    by: "day",
    keys,
    part: (x) => x.source,
    // Maintenance is a 28-day model already: no trend of it.
    trend: seriesInfo("maintenance").trend,
  });
  // Each method its own points mark (its own shape and legend entry), all
  // one series (`group`); the method is a note, said after the number.
  assert.deepEqual(
    marks.map((m) => [m.key, m.group, m.kind, m.label, m.note, m.data]),
    [
      [
        "maintenance:balance",
        "maintenance",
        "points",
        "Maintenance ≈",
        "balance",
        [2156, null, 2150],
      ],
      [
        "maintenance:burned",
        "maintenance",
        "points",
        "Maintenance ≈",
        "burned",
        [null, 2190, null],
      ],
    ],
  );
});

test("a trend only where a moving average reads truer than the points", () => {
  const trended = (key) => seriesInfo(key).trend;
  // Noisy daily measures whose direction matters keep theirs.
  for (const key of [
    "energy",
    "burned",
    "weight",
    "body_fat",
    "muscle",
    "lbm_kg",
    "resting_hr",
    "hrv_ms",
  ])
    assert.equal(trended(key), true, key);
  // Derived, already smooth, near-constant, sparse or activity-driven:
  // none.
  for (const key of [
    "bmi",
    "maintenance",
    "body_water",
    "bone_kg",
    "avg_hr",
    "m:waist",
  ])
    assert.equal(trended(key), false, key);
  // Without one, the series is its points alone.
  const marks = seriesMarks({
    key: "bmi",
    label: "BMI",
    daily: [
      { day: "2026-10-03", value: 24.1 },
      { day: "2026-10-05", value: 24.3 },
    ],
    by: "day",
    keys: ["2026-10-03", "2026-10-05"],
    trend: false,
  });
  assert.deepEqual(
    marks.map((m) => m.kind),
    ["points"],
  );
});

// /summary days, burned rows and a resting energy of 1,700 for the
// balance's numbers.
const resting = () => ({ kcal: 1700, source: "mifflin" });
const spent = (d, kcal, source = "active") => ({ day: d, kcal, source });

test("energy balance: everyday movement every day, active the rest; even inside the error (EN-5, EN-6)", () => {
  // A quiet device day (burned = resting + TEF + everyday) and a busy one
  // (active 600).
  const n = periodNumbers({
    days: [day("2026-10-01", 2000), day("2026-10-02", 2000)],
    burned: [
      spent("2026-10-01", 1700 + 200 + 170),
      spent("2026-10-02", 1700 + 200 + 600),
    ],
    bmr: resting,
  });
  // Everyday movement is 170 on both days; active is what's above it.
  assert.equal(n.everyday, 170);
  assert.equal(n.active, (0 + 430) / 2);
  assert.equal(n.resting + n.tef + n.everyday + n.active, n.burned);
  assert.equal(n.word, "deficit");
  assert.equal(n.partly, false);
  // A gap under 100 kcal a day is about even, not a verdict.
  const close = periodNumbers({
    days: [day("2026-10-01", 2000)],
    burned: [spent("2026-10-01", 2056)],
    bmr: resting,
  });
  assert.equal(close.word, "even");
  // A gap said "≈ 100" is inside the rule it's beside: the
  // rounded gap is judged.
  const edge = periodNumbers({
    days: [day("2026-10-01", 2000)],
    burned: [spent("2026-10-01", 2102.8)],
    bmr: resting,
  });
  assert.equal(edge.word, "even");
  // A day leaving some energy out: eaten is a lower bound.
  assert.equal(
    periodNumbers({
      days: [{ ...day("2026-10-01", 2000), energy_unknown: true }],
      burned: [spent("2026-10-01", 2500)],
      bmr: resting,
    }).partly,
    true,
  );
});

test("the balance's gap from a floor of eaten is a bound, never 'about even' over a possible surplus (U3-1)", () => {
  const words = (net, partly) => {
    const { word } = periodNumbers({
      days: [{ ...day("2026-10-01", 2000 + net), energy_unknown: partly }],
      burned: [spent("2026-10-01", 2000)],
      bmr: resting,
    });
    return gapText({ net, partly, word });
  };
  // Whole: no-break spaces, so a phone's line never breaks inside it.
  assert.equal(
    words(-484, false),
    "Deficit\u00A0≈\u00A0480\u00A0kcal\u00A0a\u00A0day",
  );
  assert.equal(
    words(250, false),
    "Surplus\u00A0≈\u00A0250\u00A0kcal\u00A0a\u00A0day",
  );
  assert.equal(
    words(-60, false),
    "About\u00A0even\u00A0(within\u00A0100\u00A0kcal\u00A0a\u00A0day)",
  );
  // Eaten a floor: the deficit is at most this, a surplus at least this;
  // about even may be a surplus.
  assert.equal(
    words(-484, true),
    "Deficit\u00A0≤\u00A0480\u00A0kcal\u00A0a\u00A0day",
  );
  assert.equal(
    words(250, true),
    "Surplus\u00A0≥\u00A0250\u00A0kcal\u00A0a\u00A0day",
  );
  assert.equal(
    words(-68, true),
    "About\u00A0even,\u00A0or\u00A0a\u00A0surplus",
  );
});

test("a min–max target is a field, the macro's target (item 21; owner 2026-10-14)", () => {
  const { marks } = macroSeries({
    days: [day("2026-03-02", 1500), day("2026-03-03", 2500)].map((d, i) => ({
      ...d,
      total: { ...d.total, protein: 80 + i * 20 },
    })),
    key: "protein",
    label: "Protein",
    target: { value: 90, min: 90, max: 120 },
    by: "day",
    say,
  });
  assert.deepEqual(shape(marks), [
    ["protein", "points"],
    ["protein", "trend"],
    ["target", "low"],
    ["target", "high"],
  ]);
  assert.deepEqual(
    marks.slice(2).map((m) => [m.label, m.value, m.target]),
    [
      ["Protein target", 90, true],
      ["Protein target", 120, true],
    ],
  );
  // Said once, as a range.
  assert.deepEqual(
    marks.filter((m) => m.text).map((m) => m.text),
    [`Protein target: ${say(90)}–${say(120)}`],
  );
});

test("a year is by week; a water-only day is no food day (QUAL-2)", () => {
  // Mon 2 – Wed 4 March: 1,800 and 2,200 eaten, Wednesday water only.
  const { keys, marks } = energySeries({
    days: [
      day("2026-03-02", 1800),
      day("2026-03-03", 2200),
      day("2026-03-04", 0),
    ],
    burned: [],
    target: null,
    by: "week",
    show: same,
    say,
  });
  assert.deepEqual(keys, ["2026-03-02"]);
  assert.deepEqual(marks[0].data, [2000]);
});

const points = (data) => ({ key: "w", kind: "points", data });
const at = (value, kind = "line", key = "target") => ({
  key,
  kind,
  target: true,
  value,
  data: [],
});

test("a far target line starts hidden; a near one shows", () => {
  // Data 79–80: its span is 1; a goal past 81 or under 78 would squash it.
  const marks = withHidden([points([79, 80]), at(78.5), at(82), at(77)]);
  assert.deepEqual(
    marks.slice(1).map((m) => m.hidden),
    [false, true, true],
  );
  // Zoomed to 1,500–1,600, a target at 2,000 would squash the data.
  assert.equal(withHidden([points([1500, 1600]), at(2000)])[1].hidden, true);
});

test("a field hides whole, only when both its edges are far", () => {
  const field = (lo, hi) => [at(lo, "low", "f"), at(hi, "high", "f")];
  const near = withHidden([points([79, 80]), ...field(78.5, 90)]);
  assert.deepEqual(
    near.slice(1).map((m) => m.hidden),
    [false, false],
  );
  const far = withHidden([points([79, 80]), ...field(85, 90)]);
  assert.deepEqual(
    far.slice(1).map((m) => m.hidden),
    [true, true],
  );
});

test("Body lines: goals to the tenth, the recommended BMI by age, the goal's BMI (item 20, TEST-5)", () => {
  const table = [
    [18, 18.5, 25],
    [65, 22, 27],
  ];
  const base = {
    keys: ["a"],
    table,
    unit: "kg",
    show: same,
    day: "2026-10-14",
  };
  assert.deepEqual(
    bodyLines({
      ...base,
      key: "weight",
      targets: { goal_weight: { value: 77.94 } },
      person: {},
    }).map((l) => [l.label, l.value, l.text]),
    [["Goal", 77.9, "Goal: 77.9 kg"]],
  );
  assert.deepEqual(
    bodyLines({ ...base, key: "weight", targets: {}, person: {} }),
    [],
  );
  const person = { birth_date: "1990-01-01", height_cm: 165 };
  assert.deepEqual(
    bodyLines({
      ...base,
      unit: "kg/m²",
      key: "bmi",
      targets: { goal_weight: { value: 60 } },
      person,
    }).map((l) => [l.key, l.kind, l.label, l.value]),
    [
      ["recommended", "low", "Recommended BMI", 18.5],
      ["recommended", "high", "Recommended BMI", 25],
      ["goal", "line", "Goal BMI", 22],
    ],
  );
  assert.deepEqual(bmiRange("1950-01-01", "2026-10-14", table), [22, 27]);
  assert.equal(bmiRange("2012-01-01", "2026-10-14", table), null);
  assert.equal(bmiRange(null, "2026-10-14", table), null);
});

test("Body's maintenance ends at Targets' maintenance: the trend's lead-in (QUAL-3)", async () => {
  const yesterday = shift(today(), -1);
  // 2,000 kcal a day for 40 days, a weigh-in a day falling 0.1 kg but
  // the days before the window's first a kilo up (the trend there reads
  // them).
  const days = Array.from({ length: 40 }, (_, i) =>
    day(shift(yesterday, -i), 2000),
  ).toReversed();
  const weights = Array.from({ length: 40 }, (_, i) => ({
    day: shift(yesterday, -i),
    kg: 80 + i * 0.1 + (i >= 28 ? 1 : 0),
  })).toReversed();
  const rows = {
    energy: days,
    weights,
    deviceDays: [],
    resting: [],
    activities: [],
  };
  const shared = {
    rows: (source, from, to) =>
      Promise.resolve(rows[source].filter((r) => r.day >= from && r.day <= to)),
  };
  const series = await maintenance({ from: yesterday, to: yesterday }, shared);
  const planned = plan({
    profile: {},
    byKey: {},
    days,
    weights,
    readings: [],
    deviceDays: [],
    activities: [],
    today: today(),
  });
  assert.equal(planned.maintenance.source, "balance");
  assert.equal(series.length, 1);
  assert.ok(
    Math.abs(series[0].kcal - planned.maintenance.kcal) < 1e-6,
    `${series[0].kcal} vs ${planned.maintenance.kcal}`,
  );
});

test("a Diary day's active energy nets a typed activity of resting (ARCH-5)", () => {
  const person = {
    sex: "female",
    birth_date: "1990-01-01",
    height_cm: 165,
  };
  const run = {
    day: "2026-03-04",
    kcal: 600,
    minutes: 60,
    kcal_source: null,
    type: "run",
  };
  const data = {
    day: "2026-03-04",
    weight: 60,
    device_day: null,
    activities: [run],
  };
  const { kcal: net, floor } = dayEnergy(data, person);
  // Mifflin–St Jeor about 1,295 kcal a day: 54 kcal of the hour.
  assert.ok(net > 540 && net < 550, String(net));
  // No active energy from the device: the activities' alone, a floor;
  // with it, the larger of the two, an estimate.
  assert.equal(floor, true);
  const device = { ...data, device_day: { active_kcal: 700 } };
  assert.deepEqual(dayEnergy(device, person), {
    kcal: 700,
    floor: false,
    estimated: false,
  });
  assert.equal(dayEnergy({ ...data, activities: [] }, person), null);
  // The day's served resting (DayView `resting`) nets one not yet sent:
  // 1,440 a day is 60 of the hour.
  assert.equal(
    dayEnergy(
      { ...data, resting: { kcal: 1440, origin: "com.fitbit.FitbitMobile" } },
      person,
    ).kcal,
    540,
  );
});

test("caffeine's and alcohol's series: the days the day knows them (TFA-H1)", () => {
  // Coffee carries next to no dry matter or energy: the server weighs
  // caffeine by what could hold it, so a day of food and coffee is known.
  // A day without either holds none, known.
  const days = [
    {
      day: "2026-10-01",
      total: { energy: 2000, caffeine: 190 },
      known: { dry: 400 },
    },
    {
      day: "2026-10-02",
      total: { energy: 1800, caffeine: 95 },
      known: { dry: 400, caffeine: 0.5 },
    },
    { day: "2026-10-03", total: { energy: 1900 }, known: { dry: 400 } },
    {
      day: "2026-10-04",
      total: { energy: 2500, alcohol: 24 },
      known: { dry: 500, alcohol: 0.4 },
    },
  ];
  const { caffeine, alcohol, energy } = eatenSeries(days);
  assert.deepEqual(
    [...caffeine.values],
    [
      ["2026-10-01", 190],
      ["2026-10-03", 0],
      ["2026-10-04", 0],
    ],
  );
  // Sober days are known: a pizza holds no alcohol.
  assert.deepEqual(alcohol.samples, ["2026-10-01", "2026-10-02", "2026-10-03"]);
  assert.equal(energy.samples.length, 4);
});

test("a zoomed axis ticks at round values, an edge only clear of them (E3-12, U3-8, B3-5)", () => {
  // Energy month 1,503–3,545: round 500s, the floor labelled, the top
  // (45 from 3,500) not, so no two labels collide.
  assert.deepEqual(zoomTicks(1503, 3545, 0), [1503, 2000, 2500, 3000, 3500]);
  // Weight 76.2–77.7 to a tenth, by 0.5: the top 0.2 from 77.5 unlabelled,
  // the floor 0.3 from 76.5 labelled.
  assert.deepEqual(zoomTicks(76.2, 77.7, 1), [76.2, 76.5, 77, 77.5]);
  // Whole units never step under 1 (BMI 24.5–25.6 to a tenth may).
  assert.equal(niceStep(2, 1), 1);
  assert.equal(niceStep(1.1), 0.5);
  assert.deepEqual(zoomTicks(24.5, 25.6, 1), [24.5, 25, 25.5]);
});

test("a zoomed axis spans at least its metric's minimum, round at both ends (B3-6)", () => {
  // Maintenance 2,153–2,155 kcal: no cliff, 100 kcal or more.
  const [lo, hi] = spanAtLeast(2153, 2155, 100);
  assert.ok(hi - lo >= 100 && lo <= 2153 && hi >= 2155, `${lo}–${hi}`);
  assert.equal(lo % 20, 0);
  assert.equal(hi % 20, 0);
  // RHR 53–55 bpm: at least 6.
  const [a, b] = spanAtLeast(53, 55, 6);
  assert.ok(b - a >= 6 && a <= 53 && b >= 55, `${a}–${b}`);
  // Wide enough already: the data's own.
  assert.deepEqual(spanAtLeast(1503, 3545, 100), [1503, 3545]);
  // A positive series stays at or above 0.
  assert.ok(spanAtLeast(2, 4, 20)[0] >= 0);
});

// Resting energy on 2026-10-02 Health Connect's, else Mifflin's.
const hc = (d) =>
  d === "2026-10-02"
    ? {
        kcal: 1700,
        source: "health_connect",
        origin: "com.sec.android.app.shealth",
      }
    : { kcal: 1700, source: "mifflin", origin: null };

test("energy balance: resting's sources over the period, counted", () => {
  const n = periodNumbers({
    days: [day("2026-10-01", 2000), day("2026-10-02", 2000)],
    burned: [spent("2026-10-01", 2070), spent("2026-10-02", 2070)],
    bmr: hc,
  });
  assert.deepEqual(n.restingFrom, {
    health_connect: 1,
    origin: "com.sec.android.app.shealth",
  });
  assert.deepEqual(
    periodNumbers({
      days: [day("2026-10-01", 2000)],
      burned: [spent("2026-10-01", 2070)],
      bmr: hc,
    }).restingFrom,
    { health_connect: 0, origin: null },
  );
});

test("a gap against measured maintenance is judged by the balance's rule; kJ in 50s (UX11-5, QUAL11-N2)", () => {
  // Eaten 2,000 against a weight trend's 2,308.
  assert.deepEqual(gapOf(2000 - 2308, false), {
    net: -308,
    partly: false,
    word: "deficit",
  });
  assert.equal(
    gapText(gapOf(-308, false)),
    "Deficit\u00A0≈\u00A0310\u00A0kcal\u00A0a\u00A0day",
  );
  assert.equal(gapOf(-60, false).word, "even");
  setRegistry([ENERGY], "kJ");
  // 480 kcal is 2,008 kJ: said 2,000.
  assert.equal(
    gapText(gapOf(-480, false)),
    "Deficit\u00A0≈\u00A02,000\u00A0kJ\u00A0a\u00A0day",
  );
  setRegistry([], "kcal");
});

const days = (a, b) => (Date.parse(b) - Date.parse(a)) / 864e5;

// A period still to come (a test's, centuries ahead) loads its own days
// and the window's, never every day between: the Summary's work is the
// period's, not its distance from today.
test("a far period's shared data never loads the days between", async () => {
  const asked = [];
  const before = globalThis.fetch;
  globalThis.fetch = (url) => {
    asked.push(url);
    const body = url.includes("/summary?")
      ? { days: [] }
      : url.includes("/device-days?")
        ? { days: [], resting: [] }
        : [];
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        headers: { "content-type": "application/json" },
      }),
    );
  };
  try {
    const p = period("week", "2383-08-05");
    const shared = await sharedSeries(p);
    assert.ok(shared.window.to <= today(), shared.window.to);
  } finally {
    globalThis.fetch = before;
  }
  const spans = asked
    .map((u) => u.match(/from=([\d-]+)&to=([\d-]+)/u))
    .filter(Boolean)
    .map(([u, a, b]) => [u, days(a, b)]);
  assert.ok(spans.length > 0);
  for (const [u, n] of spans) assert.ok(n < 400, `${u}: ${n} days`);
  // The period's weigh-ins from before it, as its resting energy carries
  // them.
  const farFrom = (path) =>
    asked
      .filter((u) => u.includes(`${path}?`) && u.endsWith("to=2383-08-07"))
      .map((u) => u.match(/from=([\d-]+)/u)[1])[0];
  assert.ok(farFrom("/weights") < farFrom("/summary"));
  // Today's are read too (a new profile's weight is logged today).
  assert.ok(
    asked.some((u) => /\/weights\?.*to=(.*)$/u.exec(u)?.[1] === today()),
  );
});
