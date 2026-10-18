// Correlations (web/correlate.mjs): ranks with ties, Spearman's ρ, the
// weekday demean, the pair gate (n ≥ 28) and the Benjamini–Hochberg cut;
// one phrase per time (`when`); the discovery tier's gates.

import assert from "node:assert/strict";
import test from "node:test";

import {
  bh,
  correlations,
  demean,
  discover,
  mannWhitney,
  ranks,
  spearman,
  touching,
  when,
} from "../web/correlate.mjs";
import { shift } from "../web/dates.mjs";

const THROUGH = "2025-09-30";
// `n` days ending THROUGH, oldest first.
const days = (n) =>
  Array.from({ length: n }, (_, i) => shift(THROUGH, i - n + 1));
const series = (pairs) => ({
  values: new Map(pairs),
  samples: pairs.map(([d]) => d),
});
// A fixed pseudo-random sequence in [0, 1) (mulberry32).
function random(seed) {
  // 32-bit state and output: the typed slots wrap as mulberry32's `| 0`
  // and `>>> 0` do.
  const a = new Int32Array([seed, 0]);
  const out = new Uint32Array(a.buffer, 4, 1);
  return () => {
    a[0] += 0x6d2b79f5;
    let t = Math.imul(a[0] ^ (a[0] >>> 15), 1 | a[0]);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    a[1] = t ^ (t >>> 14);
    return out[0] / 4294967296;
  };
}
// Sleep on `n` days (ending THROUGH) and the same days' mood following it
// with noise `noise` (0: exactly).
function linked(n, noise = 0.3, seed = 1) {
  const r = random(seed);
  const sleep = days(n).map((d) => [d, 360 + r() * 180]);
  const mood = sleep.map(([d, v]) => [d, (v - 360) / 60 + noise * 6 * r()]);
  return { sleep: series(sleep), "checkin:mood": series(mood) };
}

test("Mann–Whitney: scipy's asymptotic p with continuity, rank-biserial r", () => {
  // scipy.stats.mannwhitneyu([1..5], [6..10], method="asymptotic"):
  // U 0, p 0.01219; r −1 (every one of `a` lower).
  const r = mannWhitney([1, 2, 3, 4, 5], [6, 7, 8, 9, 10]);
  assert.equal(Math.round(r.p * 1e5) / 1e5, 0.01219);
  assert.equal(r.r, -1);
  // Ties shrink the variance; one constant pooled sample says nothing.
  assert.deepEqual(mannWhitney([3, 3], [3, 3]), { p: 1, r: 0 });
});

test("ranks: ties share their average rank", () => {
  assert.deepEqual(ranks([10, 20, 20, 30]), [1, 2.5, 2.5, 4]);
  assert.deepEqual(ranks([3, 1, 2]), [3, 1, 2]);
});

test("spearman: monotone is ±1, ties ranked, a constant side is null", () => {
  assert.equal(spearman([1, 2, 3, 4], [10, 20, 40, 80]), 1);
  assert.equal(spearman([1, 2, 3, 4], [4, 3, 2, 1]), -1);
  // Pearson on the ranks [1, 2.5, 2.5, 4] and [1, 2, 3, 4].
  assert.ok(Math.abs(spearman([1, 2, 2, 3], [1, 2, 3, 4]) - 0.9487) < 1e-4);
  assert.equal(spearman([5, 5, 5, 5], [1, 2, 3, 4]), null);
});

test("demean: each weekday's mean is taken out", () => {
  // Saturdays 10 higher than the other days: all 0 after.
  const s = series(
    days(28).map((d) => [
      d,
      new Date(`${d}T00:00:00Z`).getUTCDay() === 6 ? 20 : 10,
    ]),
  );
  assert.ok([...demean(s).values.values()].every((v) => v === 0));
});

test("27 paired days say nothing, 28 can", () => {
  assert.deepEqual(correlations(linked(27), THROUGH), []);
  const found = correlations(linked(28), THROUGH);
  assert.deepEqual(
    found.map((r) => [r.id, r.tone]),
    [["corr:sleep:checkin-mood:0", "correlation"]],
  );
  // A card (ADR 0030): the contrast of a median split, ρ and n in the
  // detail. Sleep at lag 0 is the night before: mood "the next day".
  const [r] = found;
  assert.equal(r.headline, "Sleep → mood");
  assert.match(
    r.numbers,
    /^Mood [\d.]+ higher the next day after sleep over .+ \(\d+ vs \d+ days\) · 90 days to Sep 30$/u,
  );
  assert.match(
    r.detail,
    /^Spearman ρ 0\.\d\d over 28 days, mood read the next day/u,
  );
  assert.equal(r.n, 28);
  assert.deepEqual(
    [r.link.to, r.link.x, r.link.y, r.link.lag],
    ["chart", "sleep", "checkin:mood", 0],
  );
});

test("when: one phrase per time", () => {
  // A night-read cause (sleep, filed under its wake day).
  assert.equal(when("sleep", "checkin:mood", 0), "the next day");
  assert.equal(when("sleep", "checkin:mood", 1), "the day after next");
  // A night-read outcome: the night after the cause's day.
  assert.equal(when("steps", "sleep", 1), "the night after");
  assert.equal(when("steps", "hrv_ms", 2), "the second night after");
  // Resting HR reads as the day it is filed under.
  assert.equal(when("alcohol", "resting_hr", 1), "the next day");
  // Otherwise the days between.
  assert.equal(when("caffeine", "checkin:stress", 0), "the same day");
  assert.equal(when("caffeine", "checkin:stress", 1), "the next day");
  assert.equal(when("caffeine", "checkin:stress", 2), "two days later");
});

// `x` on `n` days ending THROUGH and `y` following it `lag` days later.
function lagged(x, y, n, lag, seed = 1) {
  const r = random(seed);
  const xs = days(n).map((d) => [d, r() * 10]);
  const at = new Map(xs);
  const ys = days(n).map((d) => [
    d,
    (at.get(shift(d, -lag)) ?? r() * 10) + r(),
  ]);
  return { [x]: series(xs), [y]: series(ys) };
}

test("a night-read outcome tests lag 1 only: the night after (IS-3)", () => {
  // Sleep following the steps of the day before: found at lag 1, one test.
  const after = correlations(lagged("steps", "sleep", 60, 1), THROUGH);
  assert.deepEqual(
    after.map((r) => [r.id, r.tests]),
    [["corr:steps:sleep:1", 1]],
  );
  assert.match(after[0].detail, /sleep read the night after/u);
  // Sleep filed under the same day as the steps: that night came first, so
  // lag 0 isn't tested and nothing is said.
  assert.deepEqual(correlations(lagged("steps", "sleep", 60, 0), THROUGH), []);
});

test("contrast line: a night-read outcome says the night after its cause once (TEST-4)", () => {
  const found = correlations(lagged("steps", "sleep", 60, 1), THROUGH);
  assert.match(found[0].numbers, /the night after steps /u);
  assert.doesNotMatch(found[0].numbers, /after after/u);
});

// ----------------------------------------------------------- discovery

test("discovery: n ≥ 42 paired days, one card per pair at its strongest lag", async () => {
  assert.deepEqual(
    await discover(lagged("fibre", "checkin:mood", 41, 0), THROUGH),
    [],
  );
  const found = await discover(lagged("fibre", "checkin:mood", 42, 0), THROUGH);
  assert.deepEqual(
    found.map((r) => [r.id, r.tone, r.headline, r.lag, r.discovered]),
    [
      [
        "pattern:checkin:mood~fibre",
        "correlation",
        "Possible pattern",
        0,
        true,
      ],
    ],
  );
  // Never causal. 42 days pair at lag 0 only (one test).
  assert.match(
    found[0].numbers,
    /^Higher fibre tends to go with higher mood the same day · 90 days to Sep 30$/u,
  );
  assert.equal(found[0].tests, 1);
  assert.match(found[0].detail, /each half: /u);
  assert.match(
    found[0].detail,
    /q ≤ 0\.05\. A pattern worth following, not a cause\.$/u,
  );
  // Mood following fibre a day later: the same id, at lag 1; lag 0 is
  // tested once for the pair (5 tests: lags 0–2 one way, 1–2 the other).
  assert.deepEqual(
    (await discover(lagged("fibre", "checkin:mood", 60, 1), THROUGH)).map(
      (r) => [r.id, r.x, r.lag, r.tests],
    ),
    [["pattern:checkin:mood~fibre", "fibre", 1, 5]],
  );
});

test("discovery: coupled pairs and pre-registered pairs are skipped", async () => {
  // Energy and alcohol (both food), steps and activity minutes (both
  // movement): linked by definition.
  assert.deepEqual(
    await discover(lagged("energy", "alcohol", 90, 0), THROUGH),
    [],
  );
  assert.deepEqual(
    await discover(lagged("steps", "minutes", 90, 0), THROUGH),
    [],
  );
  // A series' own `groups` couple it too.
  const own = lagged("protein", "fibre", 90, 0);
  assert.equal((await discover(own, THROUGH)).length, 1);
  own.protein.groups = ["food"];
  own.fibre.groups = ["food"];
  assert.deepEqual(await discover(own, THROUGH), []);
  // Sleep → mood is pre-registered: left to `correlations`.
  const registered = lagged("sleep", "checkin:mood", 90, 0);
  assert.deepEqual(await discover(registered, THROUGH), []);
  assert.equal(correlations(registered, THROUGH).length, 1);
});

test("discovery: |ρ| ≥ 0.5 where the pre-registered tier names 0.4", async () => {
  // ρ ≈ 0.47: a pre-registered pair, not a discovery.
  const weak = linked(90, 1);
  assert.equal(correlations(weak, THROUGH).length, 1);
  const unregistered = {
    fibre: weak.sleep,
    "checkin:mood": weak["checkin:mood"],
  };
  assert.deepEqual(await discover(unregistered, THROUGH), []);
});

test("discovery: a pattern only one half shows isn't replicated", async () => {
  // Linked closely over the first 45 days, loosely over the last 45: ρ ≈
  // 0.59 over all 90 (past every other gate), 0.27 in the second half.
  const r = random(159);
  const xs = days(90).map((d) => [d, r() * 10]);
  const ys = xs.map(([d, x], i) => [d, x + (i < 45 ? 0.05 : 2) * 10 * r()]);
  const s = { fibre: series(xs), "checkin:mood": series(ys) };
  const a = demean(s.fibre);
  const b = demean(s["checkin:mood"]);
  const rho = (list) =>
    spearman(
      list.map(([d]) => a.values.get(d)),
      list.map(([d]) => b.values.get(d)),
    );
  assert.ok(rho(xs) >= 0.5, `ρ ${rho(xs)}`);
  assert.ok(rho(xs.slice(45)) < 0.3, `second half ${rho(xs.slice(45))}`);
  assert.deepEqual(await discover(s, THROUGH), []);
});

test("only the trailing 90 days count", () => {
  // 120 linked days, then 90 of them shuffled so the link is gone.
  const r = random(7);
  const s = linked(120);
  const recent = new Set(days(90));
  const mood = s["checkin:mood"];
  for (const d of recent) mood.values.set(d, r() * 3);
  assert.deepEqual(correlations(s, THROUGH), []);
});

test("a constant series is skipped, not tested", () => {
  const s = linked(60);
  s.steps = series(days(60).map((d) => [d, 8000]));
  // Only sleep ↔ mood is tested (two lags): its p stands against m = 2.
  const found = correlations(s, THROUGH);
  assert.equal(found.length, 1);
  assert.equal(found[0].tests, 2);
});

test("a weekday rhythm both share is no correlation", () => {
  // Weekends: long sleep and high mood; within a weekday, unrelated.
  const r = random(3);
  const pairs = days(84).map((d) => {
    const weekend = [0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay());
    return [d, weekend ? 1 : 0];
  });
  const sleep = series(pairs.map(([d, w]) => [d, 420 + w * 120 + r() * 30]));
  const mood = series(pairs.map(([d, w]) => [d, 3 + w * 1.5 + r() * 0.5]));
  assert.deepEqual(correlations({ sleep, "checkin:mood": mood }, THROUGH), []);
});

test("|ρ| under 0.4 stays quiet", () => {
  // ρ ≈ 0.36 with p ≈ 0.001: BH passes it, the |ρ| gate alone holds it.
  assert.deepEqual(correlations(linked(90, 1.5), THROUGH), []);
  // ρ ≈ 0.47: past the gate, found.
  assert.equal(correlations(linked(90, 1), THROUGH).length, 1);
});

test("Benjamini–Hochberg: the largest k with p(k) ≤ k/m · q passes", () => {
  // m = 5, q = 0.1: bars 0.02, 0.04, 0.06, 0.08, 0.1.
  assert.deepEqual(bh([0.01, 0.09, 0.03, 0.5, 0.05]), [
    true,
    false,
    true,
    false,
    true,
  ]);
  assert.deepEqual(bh([0.03, 0.05]), [true, true]);
  // Step-up, not step-down: p(1) over its bar (0.05) still passes with
  // p(2) under its own (0.1).
  assert.deepEqual(bh([0.06, 0.07]), [true, true]);
  assert.deepEqual(bh([0.06, 0.2]), [false, false]);
  assert.deepEqual(bh([]), []);
  // Discovery's q 0.05: bars 0.025, 0.05.
  assert.deepEqual(bh([0.04, 0.06], 0.05), [false, false]);
  assert.deepEqual(bh([0.02, 0.05], 0.05), [true, true]);
});

test("touching: a subtab lists the pairs of its domain", () => {
  const found = correlations(linked(60), THROUGH);
  assert.equal(touching(found, "body").length, 1);
  assert.equal(touching(found, "food").length, 0);
  assert.equal(touching(found, "activity").length, 0);
});
