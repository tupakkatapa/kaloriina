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

// The tile's number and the Highlight under it, as the Training subtab
// shows them: 9 workouts in September against 6 in August.
const TRAINING = `
  import { fmt } from "${web}nutrients.mjs";
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
      workouts: month("2025-09-01", 30, ["01", "03", "05", "10", "12", "17", "19", "24", "26"]),
    },
    prev: { workouts: month("2025-08-01", 31, ["04", "08", "13", "18", "22", "27"]) },
  };
  console.log(fmt(9 / (30 / 7), 1));
  console.log(highlights("training", ctx).map((r) => r.text).join("\\n"));
`;

test("fi-FI: the tile and its Highlight share the decimal mark", () => {
  const [tile, ...lines] = run("fi_FI", TRAINING).split("\n");
  assert.equal(tile, "2,1");
  assert.ok(
    lines.includes("0,7 more workouts a week than last month"),
    lines.join(" | "),
  );
});

test("en-US: the same screen reads with points", () => {
  const [tile, ...lines] = run("en_US", TRAINING).split("\n");
  assert.equal(tile, "2.1");
  assert.ok(lines.includes("0.7 more workouts a week than last month"));
});
