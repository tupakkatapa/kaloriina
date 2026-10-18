// Food tips and warnings (web/nutrient-warnings.mjs): low and high
// nutrients against their targets, the energy coverage a nutrient needs
// to be known, the adequate-intake wording, the names that follow, and
// the winter vitamin D tip by latitude and hemisphere.

import assert from "node:assert/strict";
import test from "node:test";

import { goodSourceMin, nutrientWarnings } from "../web/nutrient-warnings.mjs";
import { setRegistry } from "../web/nutrients.mjs";

setRegistry([
  {
    key: "energy",
    label: "Energy",
    unit: "kcal",
    goal: "about",
    category: "General",
  },
  {
    key: "iron",
    label: "Iron",
    unit: "mg",
    goal: "at_least",
    category: "Minerals",
  },
  {
    key: "fiber",
    label: "Fibre",
    unit: "g",
    goal: "at_least",
    category: "Carbs",
    ai: true,
  },
  {
    key: "ala",
    label: "ALA",
    unit: "g",
    goal: "at_least",
    category: "Fats",
    ai: true,
  },
  {
    key: "sodium",
    label: "Sodium",
    unit: "mg",
    goal: "at_most",
    category: "Minerals",
    display: { label: "Salt", unit: "g", factor: 2.5 / 1000 },
  },
  {
    key: "vitamin_b12",
    label: "Vitamin B12",
    unit: "µg",
    goal: "at_least",
    category: "Vitamins",
  },
  {
    key: "vitamin_d",
    label: "Vitamin D",
    unit: "IU",
    goal: "at_least",
    category: "Vitamins",
    ai: true,
    display: { label: "Vitamin D", unit: "µg", factor: 1 / 40 },
  },
]);

// `n` logged days' totals ([{day, total}]), each `total` (2000 kcal
// unless it says), every food eaten carrying every key in it.
const logged = (total, n = 28) =>
  Array.from({ length: n }, (_, i) => ({
    day: `2026-01-${String(i + 1).padStart(2, "0")}`,
    total: { energy: 2000, ...total },
  }));

// Thirty days of a January, 28 logged, each eating `average` (stored
// units); `more.days` replaces the logged days.
const base = (average, more = {}) => ({
  days: logged(average, more.logged ?? 28),
  elapsed: 30,
  through: "2026-01-30",
  targets: {
    energy: { value: 2000 },
    iron: { value: 16 },
    fiber: { value: 30 },
    sodium: { value: 2000, max: 2000 },
    vitamin_d: { value: 400 },
  },
  latitude: null,
  period: "in January",
  sources: {},
  ...more,
});
// Texts with plain spaces for the app's no-break ones.
const plain = (t) => t.replaceAll("\u00A0", " ");
// A card's row (ADR 0030): id, tone, headline, numbers.
const words = (list) =>
  list.map((r) => [r.id, r.tone, plain(r.headline), plain(r.numbers)]);

test("an at-least nutrient under 70 % of its target is low", () => {
  assert.deepEqual(
    words(nutrientWarnings(base({ iron: 9, fiber: 30, vitamin_d: 400 }))),
    [
      [
        "low:iron",
        "warning",
        "Iron intake low",
        "9 of 16 mg a day · in January",
      ],
    ],
  );
  // Intake, not status.
  assert.match(
    nutrientWarnings(base({ iron: 9, fiber: 30, vitamin_d: 400 }))[0].detail,
    /^Under 70\u00A0% of your target: intake, not status\. Mean over 28 logged days; foods carrying it made up 100\u00A0% of the food/u,
  );
  // 70 % exactly is fine.
  assert.deepEqual(
    nutrientWarnings(base({ iron: 11.2, fiber: 30, vitamin_d: 400 })),
    [],
  );
});

test("adequate-intake nutrients say below the recommended amount", () => {
  assert.deepEqual(
    words(nutrientWarnings(base({ iron: 16, fiber: 18, vitamin_d: 400 }))),
    [
      [
        "low:fiber",
        "warning",
        "Fibre below recommended",
        "18 of 30 g a day · in January",
      ],
    ],
  );
});

test("an at-most nutrient over its max is high; about-goals never warn", () => {
  assert.deepEqual(
    words(
      nutrientWarnings(
        base({
          iron: 16,
          fiber: 30,
          vitamin_d: 400,
          sodium: 2400,
          energy: 3500,
        }),
      ),
    ),
    [
      [
        "high:sodium",
        "warning",
        "Salt high",
        "6 g a day, limit 5 g · in January",
      ],
    ],
  );
});

test("a low nutrient suggests good sources, never what supplied the little", () => {
  const [r] = nutrientWarnings(
    base(
      { iron: 9, fiber: 30, vitamin_d: 400 },
      { sources: { iron: ["Liver", "Lentils", "Spinach", "Tofu"] } },
    ),
  );
  assert.match(
    plain(r.detail),
    /^Good sources: Liver · Lentils · Spinach\. Under 70 %/u,
  );
  assert.doesNotMatch(r.detail, /Most from/u);
  assert.deepEqual(r.link, { to: "sources", key: "iron" });
});

test("a high nutrient names what it mostly came from", () => {
  const [r] = nutrientWarnings(
    base(
      { iron: 16, fiber: 30, vitamin_d: 400, sodium: 2400 },
      { sources: { sodium: ["Rye bread", "Ham", "Cheese", "Olives"] } },
    ),
  );
  assert.match(plain(r.detail), /^Most from Rye bread · Ham · Cheese\. Mean/u);
});

test("names with commas stay apart, once each, three at most", () => {
  // The owner's report: Fineli names carry commas, and one food's name
  // twice read as four foods.
  const potato = "Peruna, kuorineen, keitetty, suolaa";
  const peeled = "Peruna, kuorittu, keitetty, suolaa";
  const gravy = "Ruskeakastike (Sika-nauta 9.5%)";
  const [r] = nutrientWarnings(
    base(
      { iron: 16, fiber: 30, vitamin_d: 400, sodium: 2400 },
      { sources: { sodium: [potato, potato, peeled, gravy, "Ham"] } },
    ),
  );
  assert.ok(
    plain(r.detail).startsWith(`Most from ${potato} · ${peeled} · ${gravy}. `),
    r.detail,
  );
});

test("a label keeps its acronym and a food its name mid-sentence", () => {
  const [r] = nutrientWarnings(
    base(
      { iron: 16, fiber: 30, vitamin_d: 400, vitamin_b12: 1 },
      {
        targets: { ...base().targets, vitamin_b12: { value: 2.4 } },
        sources: { vitamin_b12: ["Oatly"] },
      },
    ),
  );
  assert.equal(plain(r.headline), "Vitamin B12 intake low");
  assert.ok(plain(r.detail).startsWith("Good sources: Oatly. "), r.detail);
});

test("a good source holds twice the target's share of energy per 100 kcal", () => {
  // 16 mg in 2000 kcal is 0.8 mg per 100 kcal: good is 1.6.
  assert.equal(goodSourceMin("iron", base().targets), 1.6);
  // Without an energy target, 2000 kcal stands in.
  assert.equal(goodSourceMin("iron", { iron: { value: 16 } }), 1.6);
});

test("too few logged days, or under 70 % of the elapsed, say nothing", () => {
  const low = { iron: 9, fiber: 30, vitamin_d: 400 };
  assert.deepEqual(nutrientWarnings(base(low, { logged: 6, elapsed: 7 })), []);
  assert.deepEqual(
    nutrientWarnings(base(low, { logged: 20, elapsed: 30 })),
    [],
  );
  assert.equal(
    nutrientWarnings(base(low, { logged: 7, elapsed: 7 })).length,
    1,
  );
});

const TIP = ["Vitamin D in winter", "10 µg a day advised · in January"];
const lowD = { iron: 16, fiber: 30, vitamin_d: 300 };

test("vitamin D: a northern winter at 37° or more tips, instead of the warning", () => {
  assert.deepEqual(words(nutrientWarnings(base(lowD, { latitude: 60.2 }))), [
    ["tip:vitamin-d", "tip", ...TIP],
  ]);
  // October counts, April doesn't.
  assert.equal(
    nutrientWarnings(base(lowD, { latitude: 60.2, through: "2026-10-15" }))
      .length,
    1,
  );
  assert.deepEqual(
    nutrientWarnings(base(lowD, { latitude: 60.2, through: "2026-04-15" })),
    [],
  );
  // 36.9° is not far enough north; no latitude, no tip.
  assert.deepEqual(nutrientWarnings(base(lowD, { latitude: 36.9 })), []);
  assert.deepEqual(nutrientWarnings(base(lowD)), []);
});

test("vitamin D: the southern winter is April to September", () => {
  assert.deepEqual(nutrientWarnings(base(lowD, { latitude: -37.8 })), []);
  assert.equal(
    nutrientWarnings(base(lowD, { latitude: -37.8, through: "2026-07-10" }))[0]
      .id,
    "tip:vitamin-d",
  );
});

test("vitamin D: enough eaten, no tip", () => {
  assert.deepEqual(
    nutrientWarnings(base({ ...lowD, vitamin_d: 400 }, { latitude: 60.2 })),
    [],
  );
});

test("fortified milk keeps the tip, and the warning outside winter", () => {
  // Intake under the target is the rule: a source's name never silences
  // it (Fineli names fortified milk "D-vitaminoitu").
  for (const name of [
    "Maito, rasvaton, D-vitaminoitu",
    "Milk, skimmed, vitamin D fortified",
  ]) {
    const sources = { vitamin_d: [name, "Salmon"] };
    assert.deepEqual(
      nutrientWarnings(base(lowD, { latitude: 60.2, sources })).map(
        (r) => r.id,
      ),
      ["tip:vitamin-d"],
      name,
    );
    assert.deepEqual(
      nutrientWarnings(
        base(
          { ...lowD, vitamin_d: 200 },
          { latitude: 60.2, through: "2026-06-30", sources },
        ),
      ).map((r) => r.id),
      ["low:vitamin_d"],
      name,
    );
  }
});

// The owner's report: ALA in every day's total, yet only the foods with
// 30 % of the energy (cooking oil) carried it; potatoes and gravy had
// none. The 0.07 g was a fraction of the day, not intake.
const ala = { ala: 0.07 };
const alaTargets = { ...base().targets, ala: { value: 1.3 } };
const fineDays = { iron: 16, fiber: 30, vitamin_d: 400 };

test("under 80 % of the food from foods that carry a key, it doesn't warn", () => {
  const days = logged({ ...fineDays, ...ala }).map((d) => ({
    ...d,
    known: { ala: 0.3, dry: 400 },
  }));
  assert.deepEqual(
    nutrientWarnings(base(fineDays, { days, targets: alaTargets })),
    [],
  );
  // 80 % of it known: the mean is known enough to warn.
  const most = days.map((d) => ({ ...d, known: { ala: 0.8, dry: 400 } }));
  assert.deepEqual(
    nutrientWarnings(base(fineDays, { days: most, targets: alaTargets })).map(
      (r) => r.id,
    ),
    ["low:ala"],
  );
});

test("coverage is over the period's food, a day without the key adding none", () => {
  // No food carries iron on the days without it.
  const none = { fiber: 30, vitamin_d: 400 };
  const without = (n, from) =>
    logged(none, n).map((d, i) => ({
      ...d,
      day: `2026-01-${String(from + i).padStart(2, "0")}`,
    }));
  // Iron on 22 of 28 days, each alike: 79 % of the food.
  const some = [...logged({ ...none, iron: 2 }, 22), ...without(6, 23)];
  assert.deepEqual(nutrientWarnings(base(none, { days: some })), []);
  // On 23 of them: 82 %. The mean is over every logged day, one without
  // iron adding 0 (dailyMean): 2 × 23 / 28, a floor ("≥") short of full
  // coverage.
  const most = [...logged({ ...none, iron: 2 }, 23), ...without(5, 24)];
  assert.deepEqual(words(nutrientWarnings(base(none, { days: most }))), [
    [
      "low:iron",
      "warning",
      "Iron intake low",
      "≥ 1.6 of 16 mg a day · in January",
    ],
  ]);
  // Big days weigh more, by their dry matter: 5 days of 1,200 g without
  // iron, 23 of 400 g with.
  const heavy = [
    ...logged({ ...none, iron: 2 }, 23).map((d) => ({
      ...d,
      known: { dry: 400 },
    })),
    ...without(5, 24).map((d) => ({ ...d, known: { dry: 1200 } })),
  ];
  assert.deepEqual(nutrientWarnings(base(none, { days: heavy })), []);
  // No logged food carries iron at all: nothing known, nothing warns.
  assert.deepEqual(nutrientWarnings(base(none)), []);
});

test("no Infinity margin: a known 0 ranks as strongly as it can, finitely", () => {
  const [r] = nutrientWarnings(base({ iron: 0, fiber: 30, vitamin_d: 400 }));
  assert.equal(r.id, "low:iron");
  assert.ok(Number.isFinite(r.margin), String(r.margin));
  const [some] = nutrientWarnings(base({ iron: 1, fiber: 30, vitamin_d: 400 }));
  assert.ok(r.margin >= some.margin, `${r.margin} < ${some.margin}`);
});

test("vitamin D below 70 % outside winter is an adequate-intake warning in µg", () => {
  assert.deepEqual(
    words(
      nutrientWarnings(
        base(
          { ...lowD, vitamin_d: 200 },
          { latitude: 60.2, through: "2026-06-30" },
        ),
      ),
    ),
    [
      [
        "low:vitamin_d",
        "warning",
        "Vitamin D below recommended",
        "5 of 10 µg a day · in January",
      ],
    ],
  );
});

test("known but short of full coverage, a low reads as at least (≥)", () => {
  // 90 % of each day's food carried iron: judged, but a floor.
  const days = logged({ iron: 9, fiber: 30, vitamin_d: 400 }).map((d) => ({
    ...d,
    known: { iron: 0.9, dry: 400 },
  }));
  assert.deepEqual(words(nutrientWarnings(base({}, { days }))), [
    [
      "low:iron",
      "warning",
      "Iron intake low",
      "≥ 9 of 16 mg a day · in January",
    ],
  ]);
  // Each card carries the shape the Highlights rank (ADR 0030).
  const [r] = nutrientWarnings(base({}, { days }));
  assert.deepEqual(Object.keys(r).toSorted(), [
    "detail",
    "headline",
    "id",
    "link",
    "margin",
    "numbers",
    "tone",
  ]);
  assert.match(
    r.detail,
    /made up 90\u00A0% of the food \(80\u00A0% is needed/u,
  );
});
