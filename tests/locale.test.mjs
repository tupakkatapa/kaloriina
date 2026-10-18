// Numbers follow the device's locale everywhere, Highlights included: a
// Finnish phone reads one decimal mark on a whole screen. The formatters
// are built once per page, so each case runs in a process of its own
// locale.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

const web = new URL("../web/", import.meta.url).href;

// What `script` prints, run as a module under `locale`.
const run = (locale, script) =>
  execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, LC_ALL: `${locale}.UTF-8`, TZ: "Europe/Helsinki" },
    encoding: "utf8",
  }).trim();

// The tile's number and the Highlight under it, as the Activity subtab
// shows them: 9 workouts in September against 6 in August.
const TRAINING = `
  import { fmt } from "${web}format.mjs";
  import { highlights } from "${web}insights.mjs";
  import { shift } from "${web}dates.mjs";
  const month = (from, n, on) => {
    const samples = Array.from({ length: n }, (_, i) => shift(from, i));
    return {
      values: new Map(samples.map((d) => [d, on.includes(d.slice(8)) ? 1 : 0])),
      samples,
    };
  };
  const ctx = {
    kind: "month",
    from: "2025-09-01",
    to: "2025-09-30",
    last: "2099-01-01",
    before: { from: "2025-08-01", to: "2025-08-31" },
    targets: { steps: { value: 10000 } },
    series: {
      activities: month("2025-09-01", 30, ["01", "03", "05", "10", "12", "17", "19", "24", "26"]),
    },
    prev: { activities: month("2025-08-01", 31, ["04", "08", "13", "18", "22", "27"]) },
  };
  console.log(fmt(9 / (30 / 7), 1));
  console.log(highlights("activity", ctx).map((r) => r.numbers).join("\\n"));
`;

test("fi-FI: the tile and its Highlight share the decimal mark", () => {
  const [tile, ...lines] = run("fi_FI", TRAINING).split("\n");
  assert.equal(tile, "2,1");
  assert.ok(
    lines.some((l) =>
      l.startsWith("0,7 more activities a week than the month before · "),
    ),
    lines.join(" | "),
  );
});

test("en-US: the same screen reads with points", () => {
  const [tile, ...lines] = run("en_US", TRAINING).split("\n");
  assert.equal(tile, "2.1");
  assert.ok(
    lines.some((l) =>
      l.startsWith("0.7 more activities a week than the month before · "),
    ),
    lines.join(" | "),
  );
});

// US units read in the device's locale too: a Finnish phone set to US
// units writes "176,4 lb", and its input takes what it shows.
const UNITS = `
  import { distanceText, inputText, unitQty } from "${web}units.mjs";
  console.log(unitQty(80, "kg", 1, "us"));
  console.log(distanceText(5000, "us"));
  console.log(inputText(80, "kg", "us"));
`;

test("fi-FI: US units take the comma; inputs stay machine numbers", () => {
  assert.deepEqual(run("fi_FI", UNITS).split("\n"), [
    "176,4 lb",
    "3,11 mi",
    "176.4",
  ]);
});

// One decimal separator, `,` or `.`, whatever the locale: what is typed is
// what is stored. A grouping separator is refused (NaN), never guessed.
test("parseNum: a comma or a point is the decimal separator", async () => {
  const { parseNum } = await import(`${web}units.mjs`);
  for (const [text, want] of [
    ["1,5", 1.5],
    ["1.5", 1.5],
    [" 72,5 ", 72.5],
    ["15", 15],
    [",5", 0.5],
    ["1,", 1],
    ["-0,5", -0.5],
    ["−2,5", -2.5],
    // A comma before three digits is a decimal only after a 0.
    ["0,125", 0.125],
    ["1,25", 1.25],
    ["1,2345", 1.2345],
    ["", null],
    ["  ", null],
  ])
    assert.equal(parseNum(text), want, JSON.stringify(text));
  for (const text of [
    "1 234,5",
    "1,234.5",
    "1.234,5",
    "1,2,3",
    // The app's own thousands ("5,000"): never read as a decimal.
    "1,000",
    "2,200",
    "12,000",
    "1,046",
    "−1,000",
    "abc",
    "1e3",
    ",",
    "-",
  ])
    assert.ok(Number.isNaN(parseNum(text)), JSON.stringify(text));
});

// A clock time reads per the Units setting, never the browser locale's
// hour cycle (Metric, the default here: 24-hour).
const CLOCK = `
  import { clockAt, clockOf, timeValue } from "${web}dates.mjs";
  const at = new Date(2026, 9, 12, 19, 5).getTime();
  console.log(clockAt(at));
  console.log(timeValue(at));
  console.log(clockOf("23:40"));
`;

test("clockAt and clockOf ignore the locale's hour cycle; timeValue stays data", () => {
  for (const locale of ["fi_FI", "en_US"])
    assert.deepEqual(run(locale, CLOCK).split("\n"), [
      "19:05",
      "19:05",
      "23:40",
    ]);
});

// A Finnish phone groups thousands with a no-break space, the same space
// that joins a number to its unit: nothing may split formatted text back
// apart, so 1 512 of 2 500 kcal keeps every digit.
const ENERGY = `
  import { activityText } from "${web}device.mjs";
  import { maintenanceText } from "${web}expenditure.mjs";
  import { kcalParts } from "${web}nutrients.mjs";
  console.log(activityText({ active_kcal: 1512 }, 2500).value);
  console.log(maintenanceText({ kcal: 2250, spread: 1180 }));
  console.log(JSON.stringify(kcalParts(12345)));
`;

test("fi-FI: energy with thousands keeps its digits and its unit", () => {
  const s = "\u00A0";
  assert.deepEqual(run("fi_FI", ENERGY).split("\n"), [
    `Active${s}1${s}512${s}of${s}2${s}500${s}kcal`,
    `≈ 2${s}250${s}kcal (± 1${s}180)`,
    JSON.stringify({ value: `12${s}345`, unit: "kcal" }),
  ]);
});

// Hours group their thousands as every other number does.
const HOURS = `
  import { duration } from "${web}dates.mjs";
  console.log(duration(62679));
  console.log(duration(45));
`;

test("duration: thousands of hours grouped in the device's locale (UX11-15)", () => {
  const s = " ";
  assert.deepEqual(run("en_US", HOURS).split("\n"), [
    `1,044${s}h 39${s}min`,
    `45${s}min`,
  ]);
  assert.deepEqual(run("fi_FI", HOURS).split("\n"), [
    `1${s}044${s}h 39${s}min`,
    `45${s}min`,
  ]);
});

// A food's hydration note reads water as the device does: fl oz
// under US units, its basis ("per 100 g") as it is.
const HYDRATION_US = `
  globalThis.localStorage = { getItem: (k) => (k === "units" ? "us" : null) };
  const { hydrationText } = await import("${web}nutrients.mjs");
  const { hydrationOf } = await import("${web}coverage.mjs");
  console.log(hydrationText(hydrationOf({ water: 38 }, false)));
  console.log(hydrationText({ water: 92.5, alcohol: 40 }, { grams: 330, unit: "ml" }));
`;

test("hydration note: fl oz under US units (QUAL11-19)", () => {
  const s = " ";
  assert.deepEqual(run("en_US", HYDRATION_US).split("\n"), [
    `Hydration: 1.3${s}fl oz per 100${s}g`,
    `Hydration: 5.8${s}fl oz (water 10.3${s}fl oz, alcohol −4.5${s}fl oz) in this amount, 1.8${s}fl oz (water 3.1${s}fl oz, alcohol −1.4${s}fl oz) per 100${s}ml`,
  ]);
});
