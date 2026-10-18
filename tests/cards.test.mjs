// One of each: the nutrient card and the macro energy split are built in
// one place each, checked over web/: `node --test tests/`.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const WEB = new URL("../web", import.meta.url).pathname;

// Every module under web/ (vendor aside), relative to it.
const modules = (dir = "") =>
  readdirSync(join(WEB, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = join(dir, e.name);
    if (e.isDirectory()) return e.name === "vendor" ? [] : modules(rel);
    return e.name.endsWith(".mjs") ? [rel] : [];
  });

const having = (re) =>
  modules().filter((f) => re.test(readFileSync(join(WEB, f), "utf8")));

test("the targets fold is built once", () => {
  assert.deepEqual(having(/["']all-targets["']/u), ["bars.mjs"]);
  assert.match(readFileSync(join(WEB, "bars.mjs"), "utf8"), /Other nutrients/u);
  // The Diary's day and Summary Food's Daily averages take the whole card
  // (one card, one verdict path).
  assert.deepEqual(having(/\b(targetsCard|nutrientCard)\(/u), [
    "bars.mjs",
    "screens/diary.mjs",
    "screens/summary-food.mjs",
  ]);
  assert.deepEqual(having(/\botherNutrients\(/u), ["bars.mjs"]);
  assert.deepEqual(having(/\btargetsCard\b/u), ["bars.mjs"]);
});

test("one macro energy split", () => {
  assert.deepEqual(having(/\benergyShare\b/u), []);
  assert.deepEqual(having(/export function energySplit\b/u), ["nutrients.mjs"]);
  // Targets' "% of the energy target" is the split's kcal, not a formula
  // of its own.
  assert.match(
    readFileSync(join(WEB, "screens/targets.mjs"), "utf8"),
    /\benergySplit\(/u,
  );
});
