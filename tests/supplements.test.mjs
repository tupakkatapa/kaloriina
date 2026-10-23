// Supplements that need a meal with fat (vitamins A, D, E, K, a
// multivitamin, fish oil): a Diary note when the log proves none came
// within an hour. The days are the owner's, trimmed. `node --test tests/`.

import assert from "node:assert/strict";
import test from "node:test";

import { supplementNotes, supplementOf } from "../web/supplements.mjs";

let n = 0;
const e = (time, name, grams, fat, day = "2026-10-17", energy = 10) => ({
  key: String(++n),
  day,
  time,
  name,
  grams,
  nutrients: fat === null ? { energy } : { energy, fat },
});
const notes = (list, now = null) => [...supplementNotes(list, now).entries()];

const said = (name) => supplementOf(name)?.lead ?? null;

test("supplements that need fat are known by their names, Finnish or English", () => {
  assert.equal(
    said("Monivitamiini + elektrolyytti (ananas)"),
    "A multivitamin",
  );
  assert.equal(said("Monivitamiini appelsiini poretabletti"), "A multivitamin");
  assert.equal(said("Multivitamin gummies"), "A multivitamin");
  assert.equal(said("Tupla kalaöljykapseli"), "Fish oil");
  assert.equal(said("Omega-3 1000 mg"), "Fish oil");
  assert.equal(said("D-vitamiini 50 µg"), "Vitamin D");
  assert.equal(said("Vitamin D3 drops"), "Vitamin D");
  assert.equal(said("D3 + K2"), "Vitamin D");
  assert.equal(said("K2-vitamiini"), "Vitamin K");
  assert.equal(said("E-vitamiini"), "Vitamin E");
  assert.equal(said("A-vitamiini"), "Vitamin A");
  // Water-soluble, or no vitamin: nothing to say.
  for (const name of [
    "C-vitamiini",
    "B12-vitamiini",
    "Creatine monohydrate",
    "Elektrolyyttipore sitrus",
    "Kananmuna, paistettu",
    "Kalakeitto",
  ])
    assert.equal(supplementOf(name), null, name);
});

test("a meal with fat within the hour, either side, is enough", () => {
  // Oct 14: the protein bar 16 min after; Oct 16: the stew 4 min before.
  assert.deepEqual(
    notes([
      e("18:18", "Monivitamiini + elektrolyytti (ananas)", 708.3, null),
      e("18:34", "Soft Protein Bar", 55, 11),
      e("23:02", "Riisipiirakka (Polar 10%)", 182, 16.22),
      e("23:04", "Tupla kalaöljykapseli", 3, 2.13),
      e(null, "Pepsi Max", 500, 0),
    ]),
    [],
  );
  assert.deepEqual(
    notes([
      e("16:15", "Nistipata", 300, 16.17),
      e("16:19", "Monivitamiini + elektrolyytti (ananas)", 708.3, null),
    ]),
    [],
  );
});

test("none within the hour is said, on the supplement's entry", () => {
  // Oct 17: the multivitamin at 11:45 with creatine; food from 13:57.
  const vit = e("11:45", "Monivitamiini + elektrolyytti (ananas)", 708.3, null);
  assert.deepEqual(
    notes([
      e("11:45", "Creatine monohydrate", 3, null),
      vit,
      e("13:57", "Salaatti", 60, 0.825),
      e("14:58", "Lohifilee", 100, 14.4),
      e(null, "Limonadi", 266.25, 0),
    ]),
    [
      [
        vit.key,
        "A multivitamin works best with a meal that has fat: none within an hour",
      ],
    ],
  );
  // Fish oil's own fat is no meal.
  const oil = e("08:00", "Tupla kalaöljykapseli", 3, 2.13);
  assert.deepEqual(notes([oil]), [
    [
      oil.key,
      "Fish oil works best with a meal that has fat: none within an hour",
    ],
  ]);
  // Just under 5 g of fat within the hour.
  const d = e("08:00", "D-vitamiini", 0.2, null);
  assert.equal(notes([d, e("08:30", "Maito", 200, 4.9)]).length, 1);
  assert.equal(notes([d, e("08:30", "Maito", 200, 5)]).length, 0);
  // 61 minutes away is outside it.
  assert.equal(notes([d, e("09:01", "Juusto", 30, 8)]).length, 1);
  assert.equal(notes([d, e("09:00", "Juusto", 30, 8)]).length, 0);
  assert.equal(notes([d, e("07:00", "Juusto", 30, 8)]).length, 0);
});

test("a food with a vitamin in its name is food: its fat counts, it gets no note", () => {
  const d = e("08:00", "D-vitamiini", 0.2, null);
  // Omega-3 eggs, 170 kcal, are the meal.
  const eggs = e("08:10", "Omega-3 munat", 120, 12, "2026-10-17", 170);
  assert.deepEqual(notes([d, eggs]), []);
  assert.deepEqual(notes([eggs]), []);
  // D-vitamin milk alone, 80 kcal: no note on it.
  assert.deepEqual(
    notes([
      e("08:00", "Kevytmaito D-vitamiinilisätty", 200, 3, "2026-10-17", 80),
    ]),
    [],
  );
  // A tablet with no energy known is a supplement by its weight.
  const tablet = {
    key: "tab",
    day: "2026-10-17",
    time: "12:00",
    name: "Monivitamiini appelsiini poretabletti",
    grams: 4.3,
    nutrients: {},
  };
  assert.equal(notes([tablet]).length, 1);
  assert.deepEqual(notes([{ ...tablet, grams: 300 }]), []);
});

test("what the log can't prove isn't said", () => {
  const d = e("08:00", "D-vitamiini", 0.2, null);
  // No time on the supplement.
  assert.deepEqual(notes([e(null, "D-vitamiini", 0.2, null)]), []);
  // A food without a time could have been the meal.
  assert.deepEqual(notes([d, e(null, "Voileipä", 80, 6)]), []);
  // A food without a fat value within the hour could hold its weight in fat.
  assert.deepEqual(notes([d, e("08:10", "Punk IPA 5,4%", 440, null)]), []);
  // …but 3 g of creatine can't hold 5.
  assert.equal(notes([d, e("08:10", "Creatine", 3, null)]).length, 1);
  // Within the hour of 03:00, the day's edge, the meal may be on the next
  // day's page.
  assert.deepEqual(notes([e("02:30", "D-vitamiini", 0.2, null)]), []);
  assert.deepEqual(notes([e("03:40", "D-vitamiini", 0.2, null)]), []);
  // Today, before the hour is out, the meal may still come.
  const now = { day: "2026-10-17", time: "08:59" };
  assert.deepEqual(notes([d], now), []);
  assert.equal(notes([d], { ...now, time: "09:00" }).length, 1);
  assert.equal(notes([d], { day: "2026-10-18", time: "07:00" }).length, 1);
  // At 01:00 the day still runs: a dose at 00:30 may still get its meal.
  const late = e("00:30", "D-vitamiini", 0.2, null);
  assert.deepEqual(notes([late], { ...now, time: "01:00" }), []);
  assert.equal(notes([late], { ...now, time: "01:30" }).length, 1);
});

test("the day runs past midnight: a meal either side of it counts", () => {
  const d = e("23:30", "D-vitamiini", 0.2, null);
  assert.equal(notes([d]).length, 1);
  assert.deepEqual(notes([d, e("00:20", "Juusto", 30, 8)]), []);
});
