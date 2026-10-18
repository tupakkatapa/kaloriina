// The shared kit is the one place its parts are built: rows in
// web/rows.mjs, widgets and dialogs in web/ui.mjs. `node --test tests/`.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

const WEB = new URL("../web/", import.meta.url);

// Modules that adopt the kit in round 2 of the refactor; each package's patch
// takes its own out, and the set ends empty.
const PENDING = new Set();

// Every app module (vendored code aside), as `screens/x.mjs` or `x.mjs`.
const modules = [
  ...readdirSync(WEB).filter((f) => f.endsWith(".mjs")),
  ...readdirSync(new URL("screens/", WEB))
    .filter((f) => f.endsWith(".mjs"))
    .map((f) => `screens/${f}`),
];

// "file:line: text" for each match of `re` (global) outside `home` and the
// pending modules.
function builtOutside(re, home) {
  return modules
    .filter((m) => m !== home && !PENDING.has(m))
    .flatMap((m) => {
      const text = readFileSync(new URL(m, WEB), "utf8");
      return [...text.matchAll(re)].map((x) => {
        const line = text.slice(0, x.index).split("\n").length;
        return `${m}:${line}: ${x[0].replaceAll(/\s+/gu, " ")}`;
      });
    });
}

// A class attribute (or a ternary picking one) holding one of `names`.
const classOf = (names) =>
  new RegExp(
    `class:\\s*(?:[^,\\n]*\\?\\s*)?"(?:[^"]*\\s)?(?:${names.join("|")})(?:\\s[^"]*)?"`,
    "gu",
  );

test("the pending modules are still there to convert", () => {
  for (const m of PENDING) assert.ok(modules.includes(m), `${m}: gone`);
});

test("rows are built in rows.mjs", () => {
  assert.deepEqual(
    builtOutside(
      classOf(["result", "menu-row", "row-with-action", "starred-row", "days"]),
      "rows.mjs",
    ),
    [],
  );
});

test("widgets are built in ui.mjs", () => {
  assert.deepEqual(
    [
      classOf(["day-nav", "chip"]),
      /class:\s*"muted (?:empty|none)"/gu,
      // A name's cap is the server's: nameInput({max}) sets it.
      /maxLength:\s*meta\.limits\.(?:name|label)\b/gu,
      /label:\s*"Undo"/gu,
    ].flatMap((re) => builtOutside(re, "ui.mjs")),
    [],
  );
});

test("every dialog is a modal() from ui.mjs", () => {
  assert.deepEqual(
    builtOutside(/(?:h\(\s*|createElement\(\s*)"dialog"/gu, "ui.mjs"),
    [],
  );
});

test("one entry row and one entry editor", () => {
  assert.deepEqual(
    builtOutside(
      /\b(?:dueRow|pickRow|eatenRow|dueEditor|dailyItemRedirect|dailyItem)\b/gu,
      "rows.mjs",
    ),
    [],
  );
});

test("Summary has no Day: no subtab renders or loads one", () => {
  assert.deepEqual(builtOutside(/\b(?:renderDay|loadDay)\b/gu, null), []);
});

test("every tile has its long text: a long: beside each short:", () => {
  // A tile is {value, short, long} (tiles.mjs `tiles`); the modules that
  // build tiles (call `tiles(`, or hand tiles to one: habits.mjs) give
  // each `short:` its `long:`. Old [value, caption] tuples carry neither,
  // so a module calling `tiles(` must have a `short:`. (All time's
  // perspectives carry `long` from fun.mjs; fun.test.mjs checks each.)
  const builders = modules.filter((m) => {
    const text = readFileSync(new URL(m, WEB), "utf8");
    return m !== "tiles.mjs" && (/\btiles\(/u.test(text) || m === "habits.mjs");
  });
  assert.ok(builders.length >= 8, builders.join(", "));
  const missing = builders.flatMap((m) => {
    const code = readFileSync(new URL(m, WEB), "utf8")
      .split("\n")
      .filter((l) => !/^\s*\/\//u.test(l))
      .join("\n");
    const shorts = code.match(/\bshort:/gu)?.length ?? 0;
    const longs = code.match(/\blong:/gu)?.length ?? 0;
    return shorts === 0 || shorts !== longs
      ? [`${m}: ${shorts} short, ${longs} long`]
      : [];
  });
  assert.deepEqual(missing, []);
});

// The braces-balanced text from the "{" at `start`.
function balanced(text, start) {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  return text.slice(start);
}

test("nothing a phone needs hides in a title: a tooltip is tips.mjs", () => {
  // A native title never shows on a phone. An h() element's `title:` is
  // fine beside an "aria-label" in the same attributes (a pointer's
  // duplicate of what a screen reader hears); else it must be listed here
  // with why a phone loses nothing.
  const allowed = {
    // An abbreviation's words: the standard <abbr>; a tile's long text
    // spells HRV and RHR out on a phone.
    "ui.mjs": /title: ABBR\[part\]/u,
    // A floor's "≥" is visible; which share of the food carried it is a
    // pointer's extra, and read out (sr-only).
    "bars.mjs": /title: shown\.hint/u,
    "nutrition-panel.mjs": /title: shown\.hint/u,
    "screens/diary.mjs": /title: "Some energy unknown"/u,
    // The sign (≥, ≤, =) is visible; its words are a pointer's extra.
    "screens/targets.mjs": /title: GOAL_HINT\[r\.goal\]/u,
    // A day with no link repeats its own sr-only label.
    "calendar.mjs": /title: label/u,
  };
  const bare = modules.flatMap((m) => {
    const text = readFileSync(new URL(m, WEB), "utf8");
    return [...text.matchAll(/\bh\(\s*"[a-z0-9]+",\s*\{/gu)]
      .map((x) => balanced(text, x.index + x[0].length - 1))
      .filter(
        (attrs) =>
          /\btitle:/u.test(attrs) &&
          !/"aria-label"/u.test(attrs) &&
          !allowed[m]?.test(attrs),
      )
      .map((attrs) => `${m}: ${attrs.replaceAll(/\s+/gu, " ")}`);
  });
  assert.deepEqual(bare, []);
});
