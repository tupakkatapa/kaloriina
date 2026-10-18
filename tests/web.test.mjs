// Pure web helpers, without a browser: `node --import ./tests/tz.mjs --test
// tests/*.test.mjs`.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

import { amountText, unitLabel } from "../web/amount.mjs";
import { recipePer100 } from "../web/coverage.mjs";
import { nowTime, pretty, shift, today, weekStart } from "../web/dates.mjs";
import { fmtNum, plural, qty } from "../web/format.mjs";
import {
  barShares,
  byCategory,
  fmtUnit,
  guessed,
  inputValue,
  kcal,
  nutrient,
  per100Of,
  rangeOf,
  registry,
  scaled,
  searchedSources,
  setRegistry,
  summed,
} from "../web/nutrients.mjs";
import { SLOTS, unique } from "./slots.mjs";

// The days are calendar days in the owner's zone (tests/tz.mjs): a run
// without the preload would test another zone's dates.
test("node tests run in Europe/Helsinki", () => {
  assert.equal(
    Intl.DateTimeFormat().resolvedOptions().timeZone,
    "Europe/Helsinki",
    "run `node --import ./tests/tz.mjs --test tests/*.test.mjs`",
  );
});

setRegistry([
  {
    key: "energy",
    label: "Energy",
    unit: "kcal",
    goal: "about",
    category: "General",
  },
  {
    key: "net_carbs",
    label: "Carbs",
    unit: "g",
    goal: "about",
    category: "Carbs",
  },
  {
    key: "fiber",
    label: "Fibre",
    unit: "g",
    goal: "at_least",
    category: "Carbs",
  },
  {
    key: "protein",
    label: "Protein",
    unit: "g",
    goal: "at_least",
    category: "Protein",
  },
  {
    key: "vitamin_d",
    label: "Vitamin D",
    unit: "IU",
    goal: "at_least",
    category: "Vitamins",
    display: { label: "Vitamin D", unit: "µg", factor: 1 / 40 },
  },
  {
    key: "sodium",
    label: "Sodium",
    unit: "mg",
    goal: "at_most",
    category: "Minerals",
    display: { label: "Salt", unit: "g", factor: 2.5 / 1000 },
  },
]);

// Floats compared to six decimals.
const rounded = (o) =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, +v.toFixed(6)]));

test("display units from the server round-trip and relabel", () => {
  const salt = nutrient("sodium");
  assert.equal(salt.label, "Salt");
  assert.equal(salt.unit, "g");
  assert.equal(salt.show(500), 1.25, "500 mg sodium is 1.25 g salt");
  const vitd = nutrient("vitamin_d");
  assert.equal(vitd.show(600), 15, "600 IU is 15 µg");
  for (const key of ["sodium", "vitamin_d", "protein"])
    for (const v of [0, 0.4, 1, 12.5, 2300, 98765.4321]) {
      const n = nutrient(key);
      assert.ok(Math.abs(n.store(n.show(v)) - v) < 1e-9, `${key} ${v}`);
    }
});

test("targets read as one number with its direction", () => {
  const target = { value: 2000, min: 2000, max: 2200 };
  assert.equal(rangeOf("energy", target), "2,000", "about shows the number");
  assert.equal(
    rangeOf("protein", { value: 140 }),
    "≥\u00A0140",
    "the sign stays with its number",
  );
  assert.equal(rangeOf("sodium", { value: 2000 }), "≤\u00A05", "salt in g");
});

test("a target bar: eaten fills, planned continues it, both capped at the target", () => {
  assert.deepEqual(barShares(1240, 1580, 2000), { eaten: 62, planned: 17 });
  assert.deepEqual(barShares(500, 500, 2000), { eaten: 25, planned: 0 });
  // Planned past the target: the ghost stops at the bar's end.
  assert.deepEqual(barShares(1500, 2500, 2000), { eaten: 75, planned: 25 });
  // Eaten past it: a full bar, no room left for planned.
  assert.deepEqual(barShares(2500, 3000, 2000), { eaten: 100, planned: 0 });
  // A zero target never divides by zero.
  assert.deepEqual(barShares(0, 0, 0), { eaten: 0, planned: 0 });
});

test("numbers keep only the digits their size needs, units never apart", () => {
  assert.equal(fmtNum(2200), "2,200");
  assert.equal(fmtNum(26.2), "26");
  assert.equal(fmtNum(2.23), "2.2");
  assert.equal(fmtNum(0.256), "0.26");
  assert.equal(qty(26.2, "g"), "26\u00A0g");
  assert.equal(kcal(1899.6), "1,900\u00A0kcal");
  assert.equal(kcal(null), "–\u00A0kcal");
});

test("nutrients group by category in registry order", () => {
  const list = ["protein", "fiber", "energy", "net_carbs"].map((x) =>
    nutrient(x),
  );
  assert.deepEqual(
    byCategory(list).map(([c, items]) => [c, items.map((n) => n.key)]),
    [
      ["General", ["energy"]],
      ["Carbs", ["net_carbs", "fiber"]],
      ["Protein", ["protein"]],
    ],
  );
});

test("days shift across daylight saving and weeks start on Monday", () => {
  // Europe/Helsinki springs forward on 2026-03-29.
  assert.equal(shift("2026-03-28", 1), "2026-03-29");
  assert.equal(shift("2026-03-29", 1), "2026-03-30");
  assert.equal(shift("2026-10-25", -1), "2026-10-24");
  assert.equal(
    weekStart("2026-03-29"),
    "2026-03-23",
    "Sunday belongs to the week before",
  );
  assert.equal(weekStart("2026-03-30"), "2026-03-30");
  assert.match(today(), /^\d{4}-\d{2}-\d{2}$/u);
  assert.match(pretty("2026-03-30", false), /Mar 30/u);
});

test("an entry added or moved to Eaten today takes the device's time", () => {
  const before = new Date();
  const time = nowTime(today());
  assert.match(time, /^\d{2}:\d{2}$/u);
  const minutes = Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
  const then = before.getHours() * 60 + before.getMinutes();
  assert.ok(minutes - then <= 1 && minutes >= then, `${time} is now`);
  assert.equal(nowTime(shift(today(), -1)), null, "past days: no time");
  assert.equal(nowTime(shift(today(), 1)), null, "future days: no time");
});

test("counts read naturally", () => {
  assert.equal(plural(1, "item"), "1 item");
  assert.equal(plural(3, "day"), "3 days");
  assert.equal(plural(0, "day"), "0 days");
});

test("amounts scale, add up, and spread over a recipe's cooked weight", () => {
  assert.deepEqual(scaled({ energy: 380, protein: 13 }, 50), {
    energy: 190,
    protein: 6.5,
  });
  assert.deepEqual(summed([{ energy: 100 }, { energy: 50, fat: 2 }]), {
    energy: 150,
    fat: 2,
  });
  const parts = [
    { per100: { energy: 360 }, grams: 200 },
    { per100: { energy: 0, fat: 10 }, grams: 100 },
  ];
  // 720 kcal and 10 g fat over the 300 g of ingredients, or over 240 g cooked.
  assert.deepEqual(rounded(recipePer100(parts)), {
    energy: 240,
    fat: 3.333333,
  });
  assert.deepEqual(rounded(recipePer100(parts, 240)), {
    energy: 300,
    fat: 4.166667,
  });
  assert.deepEqual(recipePer100([]), {});
});

test("kJ on this device: energy reads, targets and inputs follow", () => {
  const served = registry;
  setRegistry(served, "kJ");
  try {
    assert.equal(kcal(1900), "7,950\u00A0kJ");
    assert.equal(kcal(null), "–\u00A0kJ");
    assert.equal(fmtUnit("energy", 100), "418\u00A0kJ");
    assert.equal(rangeOf("energy", { value: 2000 }), "8,368");
    assert.equal(inputValue("energy", 100), "418.4");
    const stored = nutrient("energy").store(418.4);
    assert.ok(Math.abs(stored - 100) < 1e-9, "stored in kcal");
    assert.equal(fmtUnit("sodium", 500), "1.3\u00A0g", "others unchanged");
  } finally {
    setRegistry(served, "kcal");
  }
  assert.equal(kcal(1900), "1,900\u00A0kcal");
});

test("unique() days stay 62 days apart across projects, retries and repeats", () => {
  const days = [];
  for (const name of ["chromium", "firefox"]) {
    for (let repeatEachIndex = 0; repeatEachIndex < 2; repeatEachIndex++) {
      for (let retry = 0; retry < 3; retry++) {
        for (let slot = 0; slot < SLOTS; slot++) {
          const info = {
            project: { name, retries: 2 },
            retry,
            repeatEachIndex,
          };
          days.push(Date.parse(unique(slot, info).day));
        }
      }
    }
  }
  days.sort((a, b) => a - b);
  const gap = Math.min(...days.slice(1).map((d, i) => (d - days[i]) / 864e5));
  assert.ok(gap >= 62, `closest two days are ${gap} days apart`);
  assert.throws(
    () =>
      unique(SLOTS, {
        project: { name: "chromium" },
        retry: 0,
        repeatEachIndex: 0,
      }),
    RangeError,
  );
});

test("unique() days stay real dates for --repeat-each 20", () => {
  const days = [];
  for (const name of ["chromium", "mobile-chromium"]) {
    for (let repeatEachIndex = 0; repeatEachIndex < 20; repeatEachIndex++) {
      for (let slot = 0; slot < SLOTS; slot++) {
        const info = {
          project: { name, retries: 0 },
          retry: 0,
          repeatEachIndex,
        };
        const { day } = unique(slot, info);
        assert.match(
          day,
          /^\d{4}-\d{2}-\d{2}$/u,
          `${name} ${repeatEachIndex} ${slot}`,
        );
        days.push(Date.parse(day));
      }
    }
  }
  days.sort((a, b) => a - b);
  const gap = Math.min(...days.slice(1).map((d, i) => (d - days[i]) / 864e5));
  assert.ok(gap >= 62, `closest two days are ${gap} days apart`);
  assert.throws(
    () =>
      unique(SLOTS - 1, {
        project: { name: "chromium", retries: 0 },
        retry: 0,
        repeatEachIndex: 23,
      }),
    RangeError,
    "past the year 9999",
  );
});

// The slots a spec line names, each with whom it belongs to: `test` (the
// test it sits in: `unique(N, …)` or a helper's `…, N, testInfo` /
// `testInfo, N`) or `row` (a table a loop makes tests of: `slot: N`, or
// `["kind", N]` inside `for (const [kind, slot] of [`, as `inTable` says).
export function slotsOf(line, inTable = false) {
  const of = (re, owner) =>
    [...line.matchAll(re)].map((m) => `${m[1]} ${owner}`);
  const found = new Set([
    ...of(/unique\(\s*(\d+)/gu, "test"),
    ...of(/(\d+),\s*testInfo\b/gu, "test"),
    ...of(/\btestInfo,\s*(\d+)/gu, "test"),
    ...of(/\bslot:\s*(\d+)/gu, "row"),
    ...(inTable ? of(/^\s*\[\s*"[^"]*",\s*(\d+)\s*\]/gu, "row") : []),
  ]);
  return [...found].map((x) => {
    const [slot, owner] = x.split(" ");
    return { slot, owner };
  });
}

test("every way a spec passes a slot is read", () => {
  const slots = (line) => slotsOf(line).map((s) => `${s.slot} ${s.owner}`);
  assert.deepEqual(slots("const { tag } = unique(12, testInfo);"), ["12 test"]);
  assert.deepEqual(slots("await setup(page, request, 420, testInfo);"), [
    "420 test",
  ]);
  assert.deepEqual(slots("runToFinish(page, request, testInfo, 330);"), [
    "330 test",
  ]);
  assert.deepEqual(slots("    slot: 191,"), ["191 row"]);
  const row = slotsOf('  ["recipe", 870],', true);
  assert.deepEqual(row, [{ slot: "870", owner: "row" }]);
  assert.deepEqual(slots('  ["05", 1],'), [], "a table of something else");
  assert.deepEqual(slots("const n = 5;"), []);
});

test("no two tests share a unique() slot", () => {
  // A slot is a test's own days, names and barcodes: two tests on one slot
  // write into each other's data when they run in parallel.
  const dir = new URL(".", import.meta.url);
  const specs = readdirSync(dir).filter((f) => f.endsWith(".spec.js"));
  assert.ok(specs.length > 0, "no spec files to check");
  const owners = new Map();
  for (const name of specs) {
    let at = 0;
    let inTable = false;
    const lines = readFileSync(new URL(name, dir), "utf8").split("\n");
    for (const [i, line] of lines.entries()) {
      if (/^test(\.\w+)?\(/u.test(line)) at += 1;
      if (/^for \(const \[\w+, slot\] of \[/u.test(line)) inTable = true;
      else if (line.startsWith("])")) inTable = false;
      for (const { slot, owner: kind } of slotsOf(line, inTable)) {
        const owner =
          kind === "test" ? `${name} test ${at}` : `${name}:${i + 1}`;
        const seen = owners.get(slot) ?? owner;
        assert.equal(seen, owner, `slot ${slot}: ${seen} and ${owner}`);
        owners.set(slot, owner);
      }
    }
  }
  assert.ok(owners.size > 0, "no slots found in the specs");
});

test("a search covers the offered databases the saved filters don't hide", () => {
  const own = ["custom", "recipe"];
  const all = [...own, "fineli", "off"];
  assert.deepEqual(searchedSources(own, {}), own);
  assert.deepEqual(searchedSources(all, { hidden: ["off"] }), [
    "custom",
    "recipe",
    "fineli",
  ]);
  // One imported since the save is searched.
  assert.deepEqual(searchedSources(all, { hidden: ["recipe"] }), [
    "custom",
    "fineli",
    "off",
  ]);
  // Only `hidden` is read: a save from before it (`sources`) hides nothing.
  assert.deepEqual(
    searchedSources(all, { sources: ["custom", "fineli"] }),
    all,
  );
  // Hiding all there is hides nothing.
  assert.deepEqual(searchedSources(own, { hidden: own }), own);
  assert.deepEqual(searchedSources(own, null), own);
});

// Typed per a serving of `grams`, kept per 100 g, shown per it again.
const typedBack = (key, typed, grams) => {
  const per100 = per100Of({ [key]: nutrient(key).store(typed) }, grams);
  return inputValue(key, scaled(per100, grams)[key]);
};

test("per-serving values round-trip through per 100 g", () => {
  assert.equal(typedBack("energy", 540, 210), "540");
  assert.equal(typedBack("energy", 540, 37.3), "540");
  assert.equal(typedBack("sodium", 0.1, 37), "0.1", "salt in g");
  assert.equal(typedBack("protein", 23.7, 3), "23.7");
  assert.deepEqual(per100Of({ energy: 540 }, 200), { energy: 270 });
  const served = registry;
  setRegistry(served, "kJ");
  try {
    assert.equal(typedBack("energy", 2260, 210), "2260");
  } finally {
    setRegistry(served, "kcal");
  }
});

test("estimated weights read ≈", () => {
  const burger = {
    servings: [{ label: "Burger", grams: 210 }],
    basis: { serving: "Burger", estimated: true },
  };
  assert.equal(guessed(burger), true);
  assert.equal(guessed({ ...burger, basis: { serving: "Burger" } }), false);
  assert.equal(guessed({ weight_estimated: true }), true);
  assert.equal(guessed(null), false);
  assert.equal(unitLabel(burger.servings[0], true), "Burger (≈210\u00A0g)");
  assert.equal(unitLabel(burger.servings[0], false), "Burger (210\u00A0g)");
  const entry = {
    grams: 420,
    serving: "Burger",
    quantity: 2,
    weight_estimated: true,
  };
  assert.equal(amountText(entry), "2 × Burger (≈420\u00A0g)");
  assert.equal(
    amountText({ ...entry, weight_estimated: false }),
    "2 × Burger (420\u00A0g)",
  );
  assert.equal(
    amountText({ grams: 150, weight_estimated: true }),
    "≈150\u00A0g",
  );
});

// Every app module (vendored code aside) and what it imports statically,
// as paths under web/.
const WEB = new URL("../web/", import.meta.url);
const MODULES = [
  ...readdirSync(WEB).filter((f) => f.endsWith(".mjs")),
  ...readdirSync(new URL("screens/", WEB))
    .filter((f) => f.endsWith(".mjs"))
    .map((f) => `screens/${f}`),
];
const TEXTS = new Map(
  MODULES.map((m) => [m, readFileSync(new URL(m, WEB), "utf8")]),
);
const DEPS = new Map(
  MODULES.map((m) => [
    m,
    [
      ...TEXTS.get(m).matchAll(
        /^\} from "(\.[^"]+)";|^import [^;]*? from "(\.[^"]+)";/gmsu,
      ),
    ].map((x) =>
      new URL(x[1] ?? x[2], new URL(m, WEB)).href.slice(WEB.href.length),
    ),
  ]),
);

test("web modules form a DAG", () => {
  assert.ok(MODULES.length > 1, "web/: no modules");
  // Depth-first: a module reached again while still on the path closes a
  // cycle.
  const done = new Set();
  const visit = (m, path) => {
    if (path.includes(m))
      assert.fail(`cycle: ${[...path.slice(path.indexOf(m)), m].join(" → ")}`);
    if (done.has(m)) return;
    for (const d of DEPS.get(m) ?? []) visit(d, [...path, m]);
    done.add(m);
  };
  for (const m of MODULES) visit(m, []);
});

// The screen an import path from a screen names, if it names one.
const screenOf = (path) =>
  /^(?:\.\/|\.\.\/screens\/)([\w-]+)\.mjs$/u.exec(path)?.[1];

test("screens import screens only to compose them", () => {
  // A part two screens share (a row, a search, a domain rule) lives in a
  // web/ module; a screen imports another screen only to show it, or a
  // piece of it, inside its own.
  const composes = {
    // The Activity tab and the Diary show the running workout's banner.
    "activity → run": ["runBanner"],
    "diary → amount-view": ["amountView", "repeatFrom"],
    "diary → day-activity": ["activityCard"],
    "diary → day-details": ["sleepCard"],
    "diary → log": ["logCard", "napRows"],
    "diary → outbox": ["waitingSection"],
    "diary → run": ["runBanner"],
    "finder → amount-view": ["amountView", "itemRow", "repeatFrom"],
    // The recipe and meal editors pick their parts in the Finder.
    "foods → finder": ["finder"],
    "profile → connections": ["ago", "connectionsLine"],
    "profile → settings": ["importCronometer", "importProfile", "thisDevice"],
    "run → activity-editor": ["activityForm"],
    "summary → summary-activity": ["*"],
    "summary → summary-body": ["*"],
    "summary → summary-food": ["*"],
    "summary → summary-habits": ["*"],
    "summary-activity → summary-highlights": ["highlightStack"],
    // Its Cardio load section, read and drawn (ADR 0034).
    "summary-activity → summary-load": ["cardioSection", "loadCardio"],
    "summary-body → summary-charts": ["seriesChart"],
    "summary-body → summary-highlights": ["highlightStack"],
    "summary-food → summary-charts": ["seriesChart"],
    "summary-food → summary-highlights": ["highlightStack"],
    "summary-habits → habits": ["habitsSection"],
    "summary-habits → summary-highlights": ["highlightStack"],
    "summary-highlights → summary-charts": ["pairChart"],
  };
  const parts = MODULES.filter((m) => m.startsWith("screens/")).flatMap((m) =>
    [
      ...TEXTS.get(m).matchAll(
        /^import (?:\{([^}]*)\}|\* as \w+) from "([^"]+)";/gmu,
      ),
    ].flatMap(([, names, from]) => {
      const to = screenOf(from);
      if (!to) return [];
      const edge = `${m.slice("screens/".length, -".mjs".length)} → ${to}`;
      const allowed = composes[edge] ?? [];
      return (names?.split(",") ?? ["*"])
        .map((n) => n.trim().split(/\s+as\s+/u)[0])
        .filter((n) => n && !allowed.includes(n))
        .map((n) => `${edge}: ${n}`);
    }),
  );
  assert.deepEqual(parts, []);
});

// Where a spec types into a form between a Save click and the next wait:
// the screen a save reloads stays shown, inert, until the new one is built,
// and a fill reaches the old form (lost, or a flake). A wait is an
// `await expect(…)`, `save(` (helpers.js) or `settled(`.
function typedBeforeSettle(text) {
  const click = /name: "Save"(?:, exact: true)? \}\)\s*\.click\(/gu;
  const wait = /await expect\(|\bsave\(|\bsettled\(/u;
  const typed = /\.(?:fill|type|pressSequentially)\(/u;
  return [...text.matchAll(click)].flatMap((m) => {
    const after = text.slice(m.index + m[0].length);
    const until = after.search(wait);
    const span = until === -1 ? after : after.slice(0, until);
    const at = span.search(typed);
    if (at === -1) return [];
    const line = text.slice(0, m.index + m[0].length + at).split("\n").length;
    return [line];
  });
}

test("typedBeforeSettle: a fill after Save waits for the screen", () => {
  const save = 'await page.getByRole("button", { name: "Save" }).click();\n';
  assert.deepEqual(typedBeforeSettle(`${save}await f.fill("1");\n`), [2]);
  assert.deepEqual(
    typedBeforeSettle(`${save}await expect(t).toBeVisible();\nf.fill("1");`),
    [],
  );
  assert.deepEqual(
    typedBeforeSettle(`${save}await settled(page);\nf.type("1");`),
    [],
  );
});

test("no spec types into a form a Save may still be replacing", () => {
  const dir = new URL("./", import.meta.url);
  const found = readdirSync(dir)
    .filter((f) => f.endsWith(".spec.js"))
    .flatMap((f) =>
      typedBeforeSettle(readFileSync(new URL(f, dir), "utf8")).map(
        (n) => `tests/${f}:${n}`,
      ),
    );
  assert.deepEqual(found, []);
});
