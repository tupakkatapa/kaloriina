// Connections' help links point at the README's setup sections (D17: the
// README is the public guide), one per source.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// README.md's anchors for user setup: the README is the public setup guide.
const ANCHORS = [
  "android",
  "openscale",
  "home-assistant",
  "google-health",
  "contributing",
  "licence",
];

test("every Connections help link is a README setup anchor", () => {
  const src = readFileSync(
    new URL("../web/screens/connections.mjs", import.meta.url),
    "utf8",
  );
  // `help("openscale", …)` and the `${README}#android` link.
  const used = [
    ...src.matchAll(/help\("([^"]+)"/gu),
    ...src.matchAll(/\$\{README\}#([a-z-]+)/gu),
  ].map((m) => m[1]);
  assert.ok(src.includes('"https://github.com/tupakkatapa/kaloriina"'));
  for (const a of used) assert.ok(ANCHORS.includes(a), a);
  assert.deepEqual([...new Set(used)].toSorted(), [
    "android",
    "google-health",
    "home-assistant",
    "openscale",
  ]);
});

// The help text says what each connection does now: Home Assistant hears a
// start and a finish only (no "saved" event); device energy never raises the
// energy target, but steps count toward the steps target and resting energy
// feeds the plan; the Google Health import reads HRV too.
test("Connections' copy is true of what each connection does", () => {
  const src = readFileSync(
    new URL("../web/screens/connections.mjs", import.meta.url),
    "utf8",
  );
  assert.ok(src.includes("when a workout starts or finishes,"));
  assert.ok(!src.includes("or is saved"));
  assert.ok(!src.includes("never added to your targets"));
  assert.ok(
    src.includes(
      "Active energy never raises your energy target; steps count toward the steps target.",
    ),
  );
  assert.ok(src.includes("resting energy"));
  assert.ok(src.includes("heart rate and HRV are read from it"));
});
