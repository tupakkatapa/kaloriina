// All time's perspectives (web/fun.mjs): each constant and what it turns
// a total into. `node --test tests/`.

import assert from "node:assert/strict";
import test from "node:test";

import { aboutLine, FUN, perspectives } from "../web/fun.mjs";

test("each perspective's constant", () => {
  assert.equal(FUN.coffeeMg, 95);
  assert.equal(FUN.ethanolGPerL, 789);
  assert.equal(FUN.potatoG, 170);
  assert.equal(FUN.cowBeefKg, 200);
  assert.equal(FUN.eggKcal, 70);
  assert.equal(FUN.bananaKcal, 105);
  assert.equal(FUN.marathonKm, 42.195);
  assert.equal(FUN.earthKm, 40_075);
  // A McDonald's double cheeseburger (US nutrition facts), not 550.
  assert.equal(FUN.burgerKcal, 450);
});

const ALL = {
  caffeine_mg: 950,
  alcohol_g: 789,
  potato_g: 1700,
  beef_g: 400_000,
  classes_known: true,
  kcal_eaten: 7000,
  distance_m: 84_390,
  asleep_min: 2880,
};
// Texts with plain spaces for the app's no-break ones.
const plain = (t) => t.replaceAll(" ", " ");

test("perspectives: totals as cups, litres, potatoes, cows, eggs and more", () => {
  const p = Object.fromEntries(
    perspectives(ALL, 11_000).map((x) => [x.key, x.value]),
  );
  assert.equal(p.coffee, 10);
  assert.equal(p.ethanol, 1);
  assert.equal(p.potatoes, 10);
  assert.equal(p.cows, 2);
  assert.equal(p.eggs, 100);
  assert.equal(p.bananas, 7000 / 105);
  assert.equal(p.marathons, 2);
  assert.equal(p.asleep, 2);
  assert.equal(p.burgers, 11_000 / 450);
});

test("perspectives leave out what is under 1, zero or unknown", () => {
  // 84 km is 0.002 times around the Earth: noise.
  assert.deepEqual(
    perspectives({ ...ALL, caffeine_mg: 0, beef_g: 100_000 }, null).map(
      (x) => x.key,
    ),
    ["ethanol", "potatoes", "eggs", "bananas", "marathons", "asleep"],
  );
  // Before the foods' classes are known, beef and potatoes can't be told.
  assert.deepEqual(
    perspectives({ ...ALL, classes_known: false }, null)
      .map((x) => x.key)
      .filter((k) => k === "cows" || k === "potatoes"),
    [],
  );
});

test("a perspective's words follow its count; alcohol is a volume (unitQty)", () => {
  const said = (stats) =>
    Object.fromEntries(
      perspectives(stats, 450).map((x) => [
        x.key,
        plain(`${x.shown} ${x.text}`),
      ]),
    );
  const one = said({ ...ALL, caffeine_mg: 95, beef_g: 200_000 });
  assert.equal(one.coffee, "1 cup of coffee, in caffeine");
  // Beef and potatoes are always a floor (foods without a class add none);
  // burgers are the energy model's estimate, mostly resting energy.
  assert.equal(one.cows, "≥ 1 cow's worth of beef");
  assert.equal(
    one.burgers,
    "≈ 1 burger's worth of energy used, mostly resting",
  );
  assert.equal(one.ethanol, "1 L of pure alcohol");
  assert.equal(said(ALL).coffee, "10 cups of coffee, in caffeine");
});

test("the About line says the constants of the perspectives shown only", () => {
  const shown = perspectives({ ...ALL, classes_known: false }, null);
  const line = plain(aboutLine(shown));
  assert.match(line, /^About: a cup of coffee 95 mg caffeine, /u);
  assert.doesNotMatch(line, /potato|cow|burger/u);
  assert.equal(aboutLine([]), null);
});

test("a total `/stats` marks at least reads ≥; the rest as it is", () => {
  const said = (stats) =>
    Object.fromEntries(
      perspectives(stats, null).map((x) => [x.key, plain(x.shown)]),
    );
  const floor = said({ ...ALL, at_least: ["caffeine", "alcohol"] });
  assert.equal(floor.coffee, "≥ 10");
  assert.equal(floor.ethanol, "≥ 1 L");
  assert.equal(floor.eggs, "100");
  assert.equal(said(ALL).coffee, "10");
  assert.equal(said(ALL).ethanol, "1 L");
});

test("each perspective says which total it is again: its tile's long text", () => {
  const far = { ...ALL, distance_m: 100_000_000 };
  const list = perspectives(far, 11_000);
  assert.equal(list.length, 10);
  assert.deepEqual(
    list.filter((x) => !x.long).map((x) => x.key),
    [],
  );
});
