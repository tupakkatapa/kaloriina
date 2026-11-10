// The app's words, checked over its sources: `node --test tests/`.

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const ROOT = new URL("..", import.meta.url).pathname;

// Every text file under `dir` (relative to the repo), recursively.
function files(dir) {
  const at = join(ROOT, dir);
  if (!existsSync(at)) return [];
  if (statSync(at).isFile()) return [dir];
  return readdirSync(at).flatMap((name) =>
    name === "vendor" ? [] : files(join(dir, name)),
  );
}

test("data from Health Connect comes from a device, never a watch", () => {
  // Frozen migrations keep their words; "stopwatch" and "swatch" aren't
  // watches. docs/howto and docs/tutorial are checked where they are there
  // (they aren't packaged).
  const allowed = new Set([
    "src/db/migrations.rs",
    "tests/vocabulary.test.mjs",
  ]);
  const sources = ["web", "src", "android/src", "tests", "README.md"];
  // A source that isn't there passes vacuously: each must be scanned.
  for (const dir of sources)
    assert.ok(files(dir).length > 0, `${dir}: no files`);
  const found = [...sources, "docs/howto", "docs/tutorial"]
    .flatMap((x) => files(x))
    .filter((f) => !allowed.has(f))
    .flatMap((f) =>
      readFileSync(join(ROOT, f), "utf8")
        .split("\n")
        .flatMap((line, i) =>
          /(?<!stop|s)watch/iu.test(line)
            ? [`${f}:${i + 1}: ${line.trim()}`]
            : [],
        ),
    );
  assert.deepEqual(found, []);
});

// Lines of the app's own files under `dirs` matching `re`, as
// "file:line: text"; each dir must hold files.
function hits(dirs, re) {
  for (const dir of dirs) assert.ok(files(dir).length > 0, `${dir}: no files`);
  return dirs
    .flatMap((x) => files(x))
    .flatMap((f) =>
      readFileSync(join(ROOT, f), "utf8")
        .split("\n")
        .flatMap((line, i) =>
          re.test(line) ? [`${f}:${i + 1}: ${line.trim()}`] : [],
        ),
    );
}

test("one word per thing: activity, burned, Eaten (ADR 0020, D2, D3)", () => {
  // A recorded session is an activity, never training; energy spent is
  // burned; the group is Eaten (`Consumed` is only read, server-side);
  // what keeps your weight is maintenance, a Body series, never
  // "TDEE".
  assert.deepEqual(
    hits(
      ["web"],
      /\btraining\b|used a day|\bTDEE\b|\bYou use\b|\bConsumed\b/iu,
    ),
    [],
  );
  // A count of sessions is of activities: "workout" counts templates only,
  // which the app never counts in copy.
  assert.deepEqual(hits(["web"], /(plural|noun)\([^)]*"workout"/u), []);
});

test("a deliberate shortcut is marked `ponytail:` bare, one way", () => {
  const self = "tests/vocabulary.test.mjs";
  assert.deepEqual(
    hits(["web", "src", "tests", "android/src"], /`ponytail:`/u).filter(
      (hit) => !hit.startsWith(`${self}:`),
    ),
    [],
  );
});

test("abbreviations expand from one list: the split is built from ABBR", () => {
  const ui = readFileSync(join(ROOT, "web/ui.mjs"), "utf8");
  assert.ok(ui.includes("Object.keys(ABBR)"), "the regex reads ABBR's keys");
  assert.ok(!ui.includes(".split(/\\b("), "no list of its own");
});

test("a unit stays on its number's line: NBSP between them", () => {
  // `qty`/`withUnit` or `${NBSP}`, never a plain space: "18 %" must not
  // break across a phone's lines. Comments may.
  const plain = /(\}|\d) (%|bpm|ms|min|kcal|Cal|kJ|kg|g|ml|L|h)(?!\w)/u;
  assert.deepEqual(
    hits(["web"], plain).filter(
      (hit) =>
        hit.split(":")[0].endsWith(".mjs") &&
        !/^[^:]+:\d+: (\/\/|\*)/u.test(hit),
    ),
    [],
  );
});

// A line less its `${…}` substitutions (code, not words), innermost first.
const withoutCode = (line) => {
  let s = line;
  for (let was = ""; was !== s; )
    [was, s] = [s, s.replaceAll(/\$\{[^{}]*\}/gu, "")];
  return s;
};

test("no session in the web app's strings: activity, workout, exercise", () => {
  // The glossary (batch 3): "Session" left the UI and the API. A string
  // literal in web/ never says it; `${…}` substitutions are code (the
  // phone's `/sync/health` counts keep `sessions`), comments may.
  const literal = /(["'`])(?:(?!\1).)*session(?:(?!\1).)*\1/iu;
  assert.deepEqual(
    hits(["web"], /session/iu).filter((hit) => {
      const line = hit.replace(/^[^:]+:\d+: /u, "");
      return !/^(\/\/|\*|\/\*)/u.test(line) && literal.test(withoutCode(line));
    }),
    [],
  );
});

test("no session in the web app's code: activities are `activity`", () => {
  // ADR 0027: an activity is never a session, in a binding or a comment
  // either. The phone's `/sync/health` report keeps its `sessions` count;
  // the outbox still reads writes queued under the retired `/sessions`
  // route until that translation goes.
  const wire = [/^web\/screens\/connections\.mjs:\d+: .*\br\.sessions\b/u];
  assert.deepEqual(
    hits(["web"], /\bsessions?\b/u).filter(
      (hit) =>
        !hit.startsWith("web/outbox.mjs:") && !wire.some((re) => re.test(hit)),
    ),
    [],
  );
});

// A source line that is code, not a comment.
const isCode = (l) => !/^\s*(\/\/|\*|\/\*)/u.test(l);
const code = (hit) => !/^[^:]+:\d+: (\/\/|\*|\/\*)/u.test(hit);

test("activity energy says ≈ in one place: energy-text.mjs", () => {
  // Measured activity energy (a device's active, a total netted) reads
  // without "≈"; an estimate with it, and only energy-text.mjs decides.
  // A "≈" with an activity-energy word in the same template or call (that
  // line or the two after it) anywhere else is a second rule. Model
  // quantities keep their own "≈" ("more active a day": the activity
  // level's share of maintenance).
  const home = "web/energy-text.mjs";
  const near = [];
  for (const f of files("web").filter((x) => x.endsWith(".mjs"))) {
    if (f === home) continue;
    const lines = readFileSync(join(ROOT, f), "utf8").split("\n");
    for (const [i, line] of lines.entries()) {
      if (!isCode(line) || !line.includes("≈")) continue;
      const span = lines
        .slice(i, i + 3)
        .filter((x) => isCode(x))
        .join("\n");
      if (/\bactive\b/iu.test(span) && !/more active a day/u.test(span))
        near.push(`${f}:${i + 1}: ${line.trim()}`);
    }
  }
  assert.deepEqual(near, []);
});

test("an energy input is set in kcal through setEnergy, never a raw .value", () => {
  // Its value is in this device's unit (kJ or kcal): a stored kcal
  // written raw reads as kJ and saves a quarter of itself.
  assert.deepEqual(
    hits(["web"], /\b(energy|kcal)\.value\s*=(?!=)/u).filter((x) => code(x)),
    [],
  );
});

test("comments and test names cite no review findings or owner decisions", () => {
  // docs/ isn't in the repository: a finding's ID or an owner's dated
  // decision points nowhere, and the comment or name says the reason
  // instead. ADRs are cited by number ("ADR 0021"), which this leaves alone.
  const tag =
    /\b(?:[A-Z][A-Z\d]{0,7}-[A-Z]{0,2}\d+(?:\.\d+)?|PR\d+-[a-z]+-\d+)\b|\bOwner \(/u;
  const words = new Set(["UTF-8"]);
  // Where a line's comment or a test's name starts.
  const said = /\/\/|\/\*|^\s*\*|\btest\(\s*["'`]/u;
  const sources = ["web", "src", "tests", "android/src", "android/test"];
  for (const dir of sources)
    assert.ok(files(dir).length > 0, `${dir}: no files`);
  const found = sources
    .flatMap((dir) => files(dir))
    .filter((f) => /\.(m?js|rs|java|css|html)$/u.test(f))
    .flatMap((f) =>
      readFileSync(join(ROOT, f), "utf8")
        .split("\n")
        .flatMap((line, i) => {
          const at = line.search(said);
          const hit = at === -1 ? null : tag.exec(line.slice(at));
          return hit && !words.has(hit[0])
            ? [`${f}:${i + 1}: ${line.trim()}`]
            : [];
        }),
    );
  assert.deepEqual(found, []);
});
