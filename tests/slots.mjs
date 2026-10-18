// `unique()` without Playwright, so `web.test.mjs` can check its promise.

// Slots a spec may use: 0 to SLOTS - 1.
export const SLOTS = 1167;

// Both projects share one server and database. Each test passes its own
// slot number, so every test/project pair gets distinct names, barcodes and a
// day at least 62 days from any other (week and month views never overlap),
// across retries and repeats too: each run gets its own block of days.
// Tags are fixed width (slot, project, run), so no name is a prefix of
// another, repeats included.
export function unique(slot, testInfo) {
  if (!Number.isInteger(slot) || slot < 0 || slot >= SLOTS) {
    throw new RangeError(`unique(): slot ${slot} is outside 0–${SLOTS - 1}`);
  }
  const p = testInfo.project.name === "chromium" ? 0 : 1;
  // Each retry and repeat runs on the same server, so it gets its own run;
  // runs are numbered densely (the config's retries, not a guess), so the
  // years up to 9999 hold 20 of them: `--repeat-each 20` without retries.
  const tries = (testInfo.project.retries ?? 0) + 1;
  const run = testInfo.repeatEachIndex * tries + testInfo.retry;
  const n = run * SLOTS * 2 + slot * 2 + p;
  const d = new Date(Date.UTC(2030, 0, 1 + n * 62));
  if (d.getUTCFullYear() > 9999) {
    throw new RangeError(`unique(): run ${run} is past the year 9999`);
  }
  const tag = `t${String(slot).padStart(3, "0")}${"dm"[p]}${String(run).padStart(2, "0")}`;
  return {
    day: d.toISOString().slice(0, 10),
    tag,
    barcode: String(4_000_000_000_000 + n),
  };
}
