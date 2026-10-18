// Health cues (web/health.mjs): traffic lights, energy split, nutrient
// density. Run with: node --test tests/

import assert from "node:assert/strict";
import test from "node:test";

import {
  density,
  energyPortion,
  lightsText,
  servingNote,
  trafficLights,
  unknownLights,
  verdictLine,
  weightGuessed,
} from "../web/health.mjs";
import { energySplit, setRegistry } from "../web/nutrients.mjs";

const n = (key, label, unit, goal, display = null) => ({
  key,
  label,
  unit,
  goal,
  category: "General",
  ...(display ? { display } : {}),
});
setRegistry(
  [
    n("energy", "Energy", "kcal", "about"),
    n("fat", "Fat", "g", "about"),
    n("saturated", "Saturated fat", "g", "at_most"),
    n("sugars", "Sugars", "g", "at_most", {
      label: "Sugars",
      unit: "g",
      factor: 1,
    }),
    n("sodium", "Sodium", "mg", "at_most", {
      label: "Salt",
      unit: "g",
      factor: 0.0025,
    }),
    n("protein", "Protein", "g", "at_least"),
    n("net_carbs", "Carbs", "g", "about"),
    n("fiber", "Fibre", "g", "at_least"),
    n("alcohol", "Alcohol", "g", "at_most"),
    n("vitamin_c", "Vitamin C", "mg", "at_least"),
    n("folate", "Folate", "µg", "at_least"),
    n("water", "Water", "g", "at_least"),
  ],
  "kcal",
);

const level = (per100, key, opts = {}) =>
  trafficLights(per100, opts).find((l) => l.key === key).level;

// Each [key, low ≤, high >] at the boundary and 0.01 past it.
function gradesBoundaries(table, drink) {
  for (const [key, low, high] of table) {
    const at = (v) => level({ [key]: v }, key, { drink });
    assert.equal(at(low), "low", `${key} ${low}`);
    assert.equal(at(low + 0.01), "medium", `${key} ${low + 0.01}`);
    assert.equal(at(high), "medium", `${key} ${high}`);
    assert.equal(at(high + 0.01), "high", `${key} ${high + 0.01}`);
  }
}

test("food thresholds grade each boundary", () => {
  gradesBoundaries(
    [
      ["fat", 3, 17.5],
      ["saturated", 1.5, 5],
      ["sugars", 5, 22.5],
    ],
    false,
  );
  // Salt in sodium mg: 0.3 g = 120 mg, 1.5 g = 600 mg.
  assert.equal(level({ sodium: 120 }, "sodium"), "low");
  assert.equal(level({ sodium: 120.01 }, "sodium"), "medium");
  assert.equal(level({ sodium: 600 }, "sodium"), "medium");
  assert.equal(level({ sodium: 600.01 }, "sodium"), "high");
});

test("drink thresholds grade each boundary", () => {
  gradesBoundaries(
    [
      ["fat", 1.5, 8.75],
      ["saturated", 0.75, 2.5],
      ["sugars", 2.5, 11.25],
    ],
    true,
  );
  const drink = { drink: true };
  assert.equal(level({ sodium: 120 }, "sodium", drink), "low");
  assert.equal(level({ sodium: 121 }, "sodium", drink), "medium");
  assert.equal(level({ sodium: 300 }, "sodium", drink), "medium");
  assert.equal(level({ sodium: 301 }, "sodium", drink), "high");
});

test("salt is read from sodium without float drift", () => {
  assert.equal(level({ sodium: 120 }, "sodium"), "low");
  assert.equal(level({ sodium: 121 }, "sodium"), "medium");
  assert.equal(level({ sodium: 600 }, "sodium"), "medium");
  assert.equal(level({ sodium: 601 }, "sodium"), "high");
  assert.equal(level({ sodium: 300 }, "sodium", { drink: true }), "medium");
  const salt = trafficLights({ sodium: 120 }).find((l) => l.key === "sodium");
  assert.equal(salt.value, 0.3);
  assert.equal(salt.label, "Salt");
});

const fat = (grams) =>
  trafficLights({ fat: 17 }, { grams }).find((l) => l.key === "fat");
const sugars = (grams) =>
  trafficLights({ sugars: 11 }, { drink: true, grams }).find(
    (l) => l.key === "sugars",
  );

test("portion rule only above 100 g / 150 ml", () => {
  assert.deepEqual(
    [fat(124).level, fat(124).portion],
    ["high", true],
    "21.08 g in 124 g",
  );
  assert.deepEqual([fat(123).level, fat(123).portion], ["medium", false]);
  assert.deepEqual([fat(null).level, fat(null).portion], ["medium", false]);
  // Below 100 g never, however much it holds.
  assert.equal(
    trafficLights({ fat: 90 }, { grams: 100 }).find((l) => l.key === "fat")
      .portion,
    false,
  );
  assert.deepEqual([sugars(150).level, sugars(150).portion], ["medium", false]);
  assert.deepEqual([sugars(151).level, sugars(151).portion], ["high", true]);
  // Already high per 100 g: not a portion red.
  assert.equal(
    trafficLights({ fat: 30 }, { grams: 500 }).find((l) => l.key === "fat")
      .portion,
    false,
  );
});

test("unknowns and alcohol", () => {
  const lights = trafficLights({ fat: 1 });
  assert.deepEqual(
    lights.map((l) => [l.key, l.level]),
    [
      ["fat", "low"],
      ["saturated", null],
      ["sugars", null],
      ["sodium", null],
    ],
  );
  assert.equal(trafficLights({ energy: 50, protein: 3 }), null);
  assert.equal(trafficLights({}), null);
  assert.equal(trafficLights(null), null);
  assert.ok(trafficLights({ fat: 0, alcohol: 0.95 }));
  assert.equal(trafficLights({ fat: 0, alcohol: 0.96 }), null);
});

test("lights read as one sentence", () => {
  assert.equal(
    lightsText(trafficLights({ fat: 1, saturated: 2, sugars: 30 })),
    "Per 100\u00A0g: fat low, sat. fat medium, sugars high, salt not given",
  );
  assert.equal(
    lightsText(
      trafficLights({ sugars: 1 }, { drink: true }),
      "Per 100 ml",
    ).startsWith("Per 100 ml: fat not given"),
    true,
  );
  assert.match(
    lightsText(trafficLights({ fat: 17 }, { grams: 124 })),
    /fat high in this amount/u,
  );
});

test("energy split", () => {
  const all = energySplit({
    protein: 10,
    net_carbs: 20,
    fiber: 5,
    fat: 10,
    alcohol: 2,
  });
  // 40 + 80 + 10 + 90 + 14 = 234 kcal.
  assert.deepEqual(
    all.parts.map((p) => [p.key, p.kcal]),
    [
      ["protein", 40],
      ["net_carbs", 80],
      ["fiber", 10],
      ["fat", 90],
      ["alcohol", 14],
    ],
  );
  assert.ok(Math.abs(all.parts[3].share - (90 / 234) * 100) < 1e-9);
  assert.deepEqual(all.missing, []);
  const rounded = all.parts.reduce((t, p) => t + Math.round(p.share), 0);
  assert.ok(Math.abs(rounded - 100) <= 1, String(rounded));
  // Without fibre and alcohol: silently none.
  const lean = energySplit({ protein: 25, net_carbs: 0, fat: 5 });
  assert.deepEqual(
    lean.parts.map((p) => p.key),
    ["protein", "fat"],
  );
  assert.deepEqual(lean.missing, []);
  // Fat missing: named.
  assert.deepEqual(energySplit({ protein: 1, net_carbs: 1 }).missing, ["Fat"]);
  assert.equal(energySplit({ fiber: 3, alcohol: 1, energy: 13 }), null);
  assert.equal(energySplit({ protein: 0, net_carbs: 0, fat: 0 }), null);
  assert.equal(energySplit(null), null);
});

// Targets' "% of energy" is the food panel's split of the same grams
// (fibre 2 kcal/g, alcohol 7), whole %, as Targets shows it.
test("Targets share = panel split", () => {
  const table = [
    // protein, carbs, fat, fibre, alcohol g → whole % of each.
    [
      { protein: 150, net_carbs: 200, fat: 70, fiber: 30 },
      { protein: 29, net_carbs: 38, fiber: 3, fat: 30 },
    ],
    [
      { protein: 100, net_carbs: 250, fat: 60, fiber: 25, alcohol: 10 },
      { protein: 19, net_carbs: 49, fiber: 2, fat: 26, alcohol: 3 },
    ],
    [
      { protein: 120, net_carbs: 0, fat: 100 },
      { protein: 35, fat: 65 },
    ],
  ];
  for (const [grams, want] of table) {
    const shares = Object.fromEntries(
      energySplit(grams).parts.map((p) => [p.key, Math.round(p.share)]),
    );
    assert.deepEqual(shares, want, JSON.stringify(grams));
  }
});

const target = (metric, value, goal) => ({
  metric,
  value,
  min: goal === "at_most" ? null : value,
  max: goal === "at_least" ? null : goal === "about" ? value * 1.1 : value,
});

test("density ranks, cautions and skips", () => {
  const targets = [
    target("vitamin_c", 75, "at_least"),
    target("folate", 300, "at_least"),
    target("protein", 50, "at_least"),
    target("fiber", 25, "at_least"),
    target("water", 2000, "at_least"),
    target("fat", 70, "about"),
    target("sodium", 2000, "at_most"),
    target("saturated", 20, "at_most"),
    target("steps", 10000, "at_least"),
  ];
  const skip = "Too little energy to measure per 100\u00A0kcal";
  assert.deepEqual(density({ energy: 4, vitamin_c: 9 }, targets), { skip });
  assert.deepEqual(density({ vitamin_c: 9 }, targets), { skip });
  assert.ok(!density({ energy: 4.1, vitamin_c: 9 }, targets).skip);
  // Orange-ish: 50 kcal, 50 mg vitamin C, 30 µg folate, 1 g protein,
  // 2 g fibre, 1 mg sodium, lots of water; no fat.
  const d = density(
    {
      energy: 50,
      vitamin_c: 50,
      folate: 30,
      protein: 1,
      fiber: 2,
      water: 87,
      sodium: 1,
      fat: 0.1,
    },
    targets,
  );
  assert.equal(d.fair, 5);
  // Per 100 kcal: vitamin C 100 mg = 133 %, folate 60 µg = 20 %, fibre 4 g =
  // 16 %, protein 2 g = 4 % (under the fair 5 %): water and fat not ranked.
  assert.deepEqual(
    d.gives.map((g) => [g.key, Math.round(g.share)]),
    [
      ["vitamin_c", 133],
      ["folate", 20],
      ["fiber", 16],
    ],
  );
  assert.equal(d.gives[0].label, "Vitamin C");
  assert.deepEqual(d.cautions, []);
  // Energy target 2500: fair share 4 %, protein now counts.
  const more = density({ energy: 50, vitamin_c: 50, protein: 1 }, [
    ...targets,
    target("energy", 2500, "about"),
  ]);
  assert.equal(more.fair, 4);
  assert.deepEqual(
    more.gives.map((g) => g.key),
    ["vitamin_c", "protein"],
  );
  // At most 6, highest first.
  const many = Array.from({ length: 8 }, (_, i) =>
    target(`n${i}`, 1, "at_least"),
  );
  setRegistry(
    [
      n("energy", "Energy", "kcal", "about"),
      ...many.map((t) => n(t.metric, t.metric, "g", "at_least")),
    ],
    "kcal",
  );
  const top = density(
    Object.fromEntries([
      ["energy", 100],
      ...many.map((t, i) => [t.metric, i + 1]),
    ]),
    many,
  );
  assert.deepEqual(
    top.gives.map((g) => g.key),
    ["n7", "n6", "n5", "n4", "n3", "n2"],
  );
  // A nutrient the food doesn't give is skipped, not counted 0.
  assert.deepEqual(
    density({ energy: 100, n0: 5 }, many).gives.map((g) => g.key),
    ["n0"],
  );
});

test("density cautions at twice the fair share, and without targets", () => {
  setRegistry(
    [
      n("energy", "Energy", "kcal", "about"),
      n("sodium", "Sodium", "mg", "at_most", {
        label: "Salt",
        unit: "g",
        factor: 0.0025,
      }),
      n("saturated", "Saturated fat", "g", "at_most"),
    ],
    "kcal",
  );
  const targets = [
    target("sodium", 2000, "at_most"),
    target("saturated", 20, "at_most"),
  ];
  // Fair share 5 %: caution at ≥ 10 % per 100 kcal. 200 kcal: sodium 400 mg
  // = 200 mg per 100 kcal = 10 %; saturated 3.98 g = 1.99 g = 9.95 %.
  const d = density({ energy: 200, sodium: 400, saturated: 3.98 }, targets);
  assert.deepEqual(
    d.cautions.map((c) => [c.key, c.label, Math.round(c.share)]),
    [["sodium", "Salt", 10]],
  );
  assert.deepEqual(d.gives, []);
  assert.deepEqual(density({ energy: 200 }, []), { none: true });
  assert.deepEqual(density({ energy: 200 }, null), { none: true });
  assert.deepEqual(
    density({ energy: 200 }, [{ metric: "steps", value: 1e4, min: 1e4 }]),
    { none: true },
  );
});

const typedPer = (estimated) => ({ basis: { serving: "Burger", estimated } });
const holding = (...flags) => ({
  items: flags.map((weight_estimated) => ({ weight_estimated })),
});

test("density follows the energy unit: per 500 kJ", () => {
  setRegistry(
    [
      n("energy", "Energy", "kcal", "about"),
      n("sodium", "Sodium", "mg", "at_most"),
    ],
    "kJ",
  );
  assert.deepEqual(energyPortion(), {
    label: "500\u00A0kJ",
    kcal: 500 / 4.184,
  });
  assert.deepEqual(density({ energy: 1 }, []), {
    skip: "Too little energy to measure per 500\u00A0kJ",
  });
  // 500 kJ is 119.5 kcal: 5.98 % of 2000 kcal, and 200 kcal holding 400 mg
  // sodium gives 239 mg of it, 11.95 % of 2000 mg.
  const d = density({ energy: 200, sodium: 400 }, [
    target("sodium", 2000, "at_most"),
  ]);
  assert.equal(d.fair.toFixed(2), "5.98");
  assert.equal(d.cautions[0].share.toFixed(2), "11.95");
  setRegistry(
    [
      n("energy", "Energy", "kcal", "about"),
      n("sodium", "Sodium", "mg", "at_most", {
        label: "Salt",
        unit: "g",
        factor: 0.0025,
      }),
    ],
    "kcal",
  );
  assert.deepEqual(energyPortion(), { label: "100\u00A0kcal", kcal: 100 });
});

test("estimated weight gives no lights", () => {
  const per100 = { energy: 200, fat: 20, sodium: 400, protein: 10 };
  assert.ok(trafficLights(per100));
  // Per 100 g is a guess too: no lights, whatever the portion.
  assert.equal(trafficLights(per100, { estimated: true }), null);
  assert.equal(trafficLights(per100, { estimated: true, grams: 400 }), null);
  assert.equal(weightGuessed(typedPer(true)), true);
  assert.equal(weightGuessed(typedPer(false)), false);
  assert.equal(weightGuessed({ basis: null }), false);
  // A recipe or meal with any such item.
  assert.equal(weightGuessed(holding(false, true)), true);
  assert.equal(weightGuessed(holding(false, false)), false);
  // Split and density are per kcal: they still show.
  assert.ok(energySplit(per100));
  const targets = [target("sodium", 2000, "at_most")];
  assert.equal(density(per100, targets).cautions.length, 1);
});

test("salt is read with the served sodium factor; US lights say the US words", () => {
  const served = (factor) => [
    n("fat", "Fat", "g", "about"),
    n("saturated", "Saturated fat", "g", "at_most"),
    {
      ...n("sugars", "Sugars", "g", "at_most"),
      display_us: { label: "Total sugars", unit: "g", factor: 1 },
    },
    {
      ...n("sodium", "Sodium", "mg", "at_most", {
        label: "Salt",
        unit: "g",
        factor,
      }),
      display_us: { label: "Sodium", unit: "mg", factor: 1 },
    },
  ];
  // 400 mg of sodium is 1 g of salt (medium) at the EU factor; at a
  // factor twice that it would read 2 g (high): the server's number counts.
  setRegistry(served(0.0025), "kcal", "eu");
  assert.equal(trafficLights({ sodium: 400 })[3].level, "medium");
  setRegistry(served(0.005), "kcal", "eu");
  assert.equal(trafficLights({ sodium: 400 })[3].level, "high");
  setRegistry(served(0.0025), "kcal", "us");
  assert.deepEqual(
    trafficLights({ fat: 1, saturated: 1, sugars: 1, sodium: 1 }).map(
      (l) => l.label,
    ),
    ["Fat", "Saturated fat", "Total sugars", "Sodium"],
  );
  setRegistry(served(0.0025), "kcal", "eu");
  assert.deepEqual(
    trafficLights({ fat: 1, saturated: 1, sugars: 1, sodium: 1 }).map(
      (l) => l.label,
    ),
    ["Fat", "Sat. fat", "Sugars", "Salt"],
  );
});

// Labels are the server's (src/model/labels.rs,
// tests/fixtures/label-cases.json); the client only says what a verdict was
// judged without, and why it is what it is.
test("no verdict while a value the score needs isn't known", () => {
  const all = { energy: 50, fat: 2, saturated: 0, sugars: 1, sodium: 40 };
  assert.deepEqual(unknownLights(all), []);
  assert.deepEqual(unknownLights({ ...all, sugars: null }), ["sugars"]);
  assert.deepEqual(unknownLights({ fat: 2 }), [
    "energy",
    "sat. fat",
    "sugars",
    "salt",
  ]);
  // At most 1 g of fat, saturates can't score: they aren't needed.
  assert.deepEqual(unknownLights({ fat: 1 }), ["energy", "sugars", "salt"]);
  // A recipe's sugars from a quarter of its food aren't known.
  const recipe = { ...all, energy: 200 };
  assert.deepEqual(unknownLights(recipe, { sugars: 0.25, dry: 40 }), [
    "sugars",
  ]);
  assert.deepEqual(unknownLights(recipe, { sugars: 0.8, dry: 40 }), []);
});

// Last: it sets a registry of its own.
const us = (label, short = label) => ({ label, short, unit: "g", factor: 1 });
test("energy split: labels are the registry's, as the label style says them (QUAL-7)", () => {
  setRegistry(
    [
      n("protein", "Protein", "g", "at_least"),
      {
        ...n("net_carbs", "Carbs", "g", "about"),
        display: us("Carbs"),
        display_us: us("Net carbs", "Carbs"),
      },
      { ...n("fiber", "Fibre", "g", "at_least"), display_us: us("Fiber") },
      n("fat", "Fat", "g", "about"),
    ],
    "kcal",
    "us",
  );
  assert.deepEqual(
    energySplit({ protein: 1, net_carbs: 1, fiber: 1, fat: 1 }).parts.map(
      (p) => p.label,
    ),
    ["Protein", "Carbs", "Fiber", "Fat"],
  );
});

// With energy known, each part is a share of the energy, and what
// no given macro explains is "Unknown"; never 69 % protein for a food
// that is 55 % protein.
test("energy split: shares of the energy, the rest unknown (UX11-6)", () => {
  // Greek yoghurt: 109 kcal, 15 g protein, 3 g fat, carbs not given.
  const yoghurt = energySplit({ energy: 109, protein: 15, fat: 3 });
  assert.deepEqual(
    yoghurt.parts.map((p) => [p.label, Math.round(p.share)]),
    [
      ["Protein", 55],
      ["Fat", 25],
      ["Unknown", 20],
    ],
  );
  assert.deepEqual(yoghurt.missing, ["Carbs"]);
  // Every macro given: shares of their sum, as before (a label's rounding
  // is no unknown).
  const full = energySplit({ energy: 120, protein: 10, net_carbs: 10, fat: 4 });
  assert.deepEqual(
    full.parts.map((p) => p.key),
    ["protein", "net_carbs", "fat"],
  );
  // Energy not given: the macros' sum, as before.
  assert.deepEqual(
    energySplit({ protein: 15, fat: 3 }).parts.map((p) => Math.round(p.share)),
    [69, 31],
  );
});

// The verdict's reasons are the server's (`labels.why`); the line names
// them: what counts against an Unhealthy food, for a Healthy one, and
// both for OK (ADR 0033).
const reason = (key, text, positive = false) => ({ key, text, positive });
const SALT = reason("sodium", "salt");
const VEG = reason("fruit_veg", "fruit & veg", true);
const food = (verdict, why) => ({ labels: { verdict, why } });
test("the verdict line says why", () => {
  assert.equal(
    verdictLine(food("ok", [SALT, VEG]), "OK"),
    "OK: salt, but fruit & veg",
  );
  assert.equal(
    verdictLine(
      food("unhealthy", [
        reason("sugars", "sugar"),
        reason("energy", "calories"),
        VEG,
      ]),
      "Unhealthy",
    ),
    "Unhealthy: sugar, calories",
  );
  assert.equal(
    verdictLine(
      food("healthy", [
        SALT,
        reason("fiber", "fibre", true),
        reason("protein", "protein", true),
      ]),
      "Healthy",
    ),
    "Healthy: fibre, protein",
  );
  assert.equal(verdictLine(food("ok", [SALT]), "OK"), "OK: salt");
  assert.equal(verdictLine(food("ok", [VEG]), "OK"), "OK: fruit & veg");
  assert.equal(verdictLine(food("healthy", []), "Healthy"), null);
  assert.equal(verdictLine(food(null, []), null), null);
  assert.equal(verdictLine({}, null), null);
});

// What a typical serving (the food's first, under 100 g) holds of what
// counts against it, as a share of the EU reference intake: the score is
// per 100 g, the serving is context (ADR 0033).
test("the serving note puts the score's negatives in a serving", () => {
  const pickles = {
    per100: { energy: 12, sugars: 0, saturated: 0, sodium: 1200 },
    servings: [{ label: "Slice", grams: 5 }],
    labels: { verdict: "ok", why: [SALT, VEG] },
  };
  // 60 mg of sodium is 0.15 g of salt, 2.5 % of 6 g.
  assert.equal(
    servingNote(pickles),
    "Slice (5\u00A0g): 3\u00A0% of a day's salt",
  );
  // The largest share wins: 30 g of sugar is a third of 90 g.
  const bar = {
    per100: { energy: 400, sugars: 50, saturated: 5, sodium: 100 },
    servings: [{ label: "Bar", grams: 60 }],
    labels: {
      verdict: "unhealthy",
      why: [reason("sugars", "sugar"), reason("saturated", "sat. fat")],
    },
  };
  assert.equal(servingNote(bar), "Bar (60\u00A0g): 33\u00A0% of a day's sugar");
  // Under 1 %: said so, not "0 %".
  const crumb = { ...pickles, servings: [{ label: "Crumb", grams: 1 }] };
  assert.equal(
    servingNote(crumb),
    "Crumb (1\u00A0g): under 1\u00A0% of a day's salt",
  );
  // None for Healthy, a serving of 100 g or more, no serving, or no
  // nutrient against it.
  assert.equal(
    servingNote({ ...pickles, labels: { verdict: "healthy", why: [VEG] } }),
    null,
  );
  assert.equal(
    servingNote({ ...pickles, servings: [{ label: "Jar", grams: 100 }] }),
    null,
  );
  assert.equal(servingNote({ ...pickles, servings: [] }), null);
  assert.equal(
    servingNote({
      ...pickles,
      labels: { verdict: "ok", why: [reason("sweeteners", "sweeteners")] },
    }),
    null,
  );
});
