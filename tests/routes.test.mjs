// The route grammar (review D9): one address per screen, no aliases, and
// every hash built through `href` (web/nav.mjs). main.mjs needs a DOM, so
// its route patterns are read from its source.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

const main = readFileSync("web/main.mjs", "utf8");
const parts = Object.fromEntries(
  [...main.matchAll(/^const (DAY|ID|NEW_OR_ID|GROUP) = "(.+)";$/gmu)].map(
    ([, name, source]) => [name, JSON.parse(`"${source}"`)],
  ),
);
// Every `at(...)` pattern main.mjs registers, as the regex it builds.
const routes = [...main.matchAll(/\bat\(\s*[`"]([^`"]+)[`"],?\s*\)/gu)].map(
  ([, pattern]) =>
    new RegExp(
      `^#${pattern.replaceAll(/\$\{(\w+)\}/gu, (_, name) => parts[name])}$`,
      "u",
    ),
);
const opens = (hash) => routes.some((re) => re.test(hash));

test("the route patterns are read", () => {
  assert.ok(routes.length > 30);
  for (const hash of [
    "#/activity",
    "#/summary/activity/week/2045-06-15",
    "#/entry/daily-3-2045-06-15",
    "#/workout/3/run",
    "#/exercise/3/edit",
  ])
    assert.ok(opens(hash), hash);
});

test("old addresses and aliases open nothing (D7, D9)", () => {
  for (const hash of [
    "#/workouts",
    "#/summary/training",
    "#/summary/training/week/2045-06-15",
    "#/daily-items/3",
    "#/daily-items/3/days/2045-06-15",
    // A day is the Diary's (refactor round, D7).
    "#/summary/body/day/2045-06-15",
    "#/summary/day/2045-06-15",
  ])
    assert.ok(!opens(hash), hash);
});

test("every hash is built by `href`", () => {
  const files = readdirSync("web", { recursive: true })
    .filter((f) => f.endsWith(".mjs"))
    .filter((f) => f !== "nav.mjs" && f !== "main.mjs");
  const hits = files.flatMap((f) =>
    readFileSync(`web/${f}`, "utf8")
      .split("\n")
      .flatMap((line, i) =>
        // A hash literal outside a comment (a check that a value is one,
        // `startsWith("#/")`, builds nothing), or a query glued onto one.
        (/[`"]#\//u.test(line.replace(/\/\/.*$/u, "")) &&
          !/startsWith\("#\/"\)/u.test(line)) ||
        /\$\{href\.\w+\([^}]*\)\}\?/u.test(line)
          ? [`${f}:${i + 1}: ${line.trim()}`]
          : [],
      ),
  );
  assert.deepEqual(hits, []);
});
