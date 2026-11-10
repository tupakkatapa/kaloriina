// Rules the page needs before /api/meta answers (the day's start) or in
// pure modules without it (lights, pace), held as constants on both sides:
// each read from the server's source and matched to the page's.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { MIN_KMH } from "../web/activities.mjs";
import { DAY_START } from "../web/dates.mjs";
import { MAX_ALCOHOL, THRESHOLDS } from "../web/health.mjs";

const rust = (path) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
// The one capture of `re` in `text`, as a number.
const number = (text, re) => {
  const found = text.match(re);
  assert.ok(found, `${re} not found`);
  return Number(found[1]);
};

test("the day starts at the server's hour", () => {
  assert.equal(
    number(rust("src/model/suggest.rs"), /pub const DAY_START: u32 = (\d+);/u),
    DAY_START,
  );
});

test("a food is alcoholic past the server's share", () => {
  assert.equal(
    number(rust("src/model/score.rs"), /const ALCOHOL_MAX: f64 = ([\d.]+);/u),
    MAX_ALCOHOL,
  );
});

test("a type has a pace from the server's speed", () => {
  const text = rust("src/model/activity.rs");
  const body = text.slice(text.indexOf("pub fn min_kmh"));
  const speeds = {};
  for (const [, types, kmh] of body
    .slice(0, body.indexOf("_ =>"))
    .matchAll(/((?:Self::\w+\s*\|?\s*)+)=> ([\d.]+)/gu))
    for (const [, name] of types.matchAll(/Self::(\w+)/gu))
      speeds[name.toLowerCase()] = Number(kmh);
  assert.deepEqual(speeds, MIN_KMH);
});

test("the lights' reds are the server's highs", () => {
  const text = rust("src/model/labels.rs");
  for (const [table, kind] of [
    ["FOOD", "food"],
    ["DRINK", "drink"],
  ]) {
    const body = text.slice(text.indexOf(`const ${table}: Table`));
    const red = (key) =>
      number(body, new RegExp(`\\("${key}", ([\\d.]+)\\)`, "u"));
    const high = (key) => THRESHOLDS[kind][key][1];
    assert.equal(red("fat"), high("fat"), kind);
    assert.equal(red("saturated"), high("saturated"), kind);
    assert.equal(red("sugars"), high("sugars"), kind);
    // Salt in grams, sodium in mg: salt is 2.5 × sodium.
    assert.equal(red("sodium") * 2.5, high("salt") * 1000, kind);
  }
});
