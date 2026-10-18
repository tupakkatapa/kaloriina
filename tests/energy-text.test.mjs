// Activity energy phrases move whole: a line breaks only between the parts
// of a line (" · "), never inside "active ≈ 392 kcal" or "280 total".

import assert from "node:assert/strict";
import test from "node:test";

import {
  activeEnergyText,
  activeKcalText,
  activeMark,
} from "../web/energy-text.mjs";
import { setRegistry } from "../web/nutrients.mjs";

const ENERGY = { key: "energy", label: "Energy", unit: "kcal" };
// NBSP shown as "_", so a plain space is a place a line may break.
const shown = (text) => text?.replaceAll(" ", "_") ?? null;

test("activity energy phrases are held together by NBSPs, parts split by ' · '", () => {
  setRegistry([ENERGY], "kcal");
  assert.deepEqual(
    [
      { active: 410, total: null, estimated: false },
      { active: 247, total: 280, estimated: false },
      { active: null, total: 355, estimated: false },
      { active: 288, total: null, estimated: true },
    ].map((e) => shown(activeEnergyText(e))),
    [
      "active_410_kcal",
      "active_247_kcal · 280_total",
      "355_kcal_total",
      "active_≈_288_kcal",
    ],
  );
  // This week's (and a day's) "active ≈ 392 kcal", "active ≥ 90 kcal".
  assert.equal(
    shown(activeKcalText(392, activeMark({ estimated: true }))),
    "active_≈_392_kcal",
  );
  assert.equal(
    shown(activeKcalText(90, activeMark({ floor: true }))),
    "active_≥_90_kcal",
  );
  assert.equal(shown(activeKcalText(1234)), "active_1,234_kcal");
  setRegistry([], "kcal");
});
