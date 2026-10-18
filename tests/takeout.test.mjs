// The Takeout zip reader (web/takeout.mjs): only the Google Health files
// the server reads come out, inflated or stored, across a split export.

import assert from "node:assert/strict";
import test from "node:test";

import { readFileSync } from "node:fs";

import {
  importTakeout,
  isHeart,
  takeoutBatches,
  wanted,
} from "../web/takeout.mjs";
import { makeZip } from "./zip.mjs";

const GH = "Takeout/Google Health";
const MiB = 1024 * 1024;

// The first upload: every wanted file but heart rate.
const firstUpload = async (blobs, limit) =>
  (await takeoutBatches(blobs, limit).next()).value;

test("only the wanted files come out, from every part", async () => {
  const one = makeZip([
    { name: `${GH}/Global Export Data/steps-2026-09-01.json`, text: "[]" },
    {
      name: `${GH}/Health Fitness Data_GoogleData/UserExercises_2026-05-31.csv`,
      text: "exercise_id\n1\n".repeat(50),
    },
    {
      name: `${GH}/Physical Activity_GoogleData/Daily Resting Heart Rate/daily_resting_heart_rate.csv`,
      text: "timestamp,beats per minute\n",
      stored: true,
    },
    { name: `${GH}/Paired Devices/Devices.csv`, text: "x" },
  ]);
  // A comment after the end record is allowed.
  const plain = makeZip([
    { name: `${GH}/x/steps_2026-10-01.csv`, text: "timestamp,steps\n" },
  ]);
  plain.writeUInt16LE(5, plain.length - 2);
  const two = Buffer.concat([plain, Buffer.from("hello")]);
  const files = await firstUpload([new Blob([one]), new Blob([two])], MiB);
  assert.deepEqual(
    files.map((f) => [f.name.split("/").pop(), f.text.length]),
    [
      ["UserExercises_2026-05-31.csv", 14 * 50],
      ["daily_resting_heart_rate.csv", 27],
      ["steps_2026-10-01.csv", 16],
    ],
  );
  assert.equal(files[1].text, "timestamp,beats per minute\n");
});

test("names follow the shared list (tests/fixtures/takeout-names.json)", () => {
  const names = JSON.parse(
    readFileSync(new URL("fixtures/takeout-names.json", import.meta.url)),
  );
  for (const name of names.read) {
    assert.ok(wanted(name), name);
    assert.ok(!isHeart(name), name);
  }
  for (const name of names.heart_rate) assert.ok(isHeart(name), name);
  for (const name of names.ignored) assert.ok(!wanted(name), name);
});

const sleeps = { name: `${GH}/x/UserSleeps_2026-05-31.csv`, text: "sleep\n" };
const heart = (day, bytes) => ({
  name: `${GH}/Heart Rate/heart_rate_${day}.csv`,
  text: "1".repeat(bytes),
});

test("heart rate goes in batches, each with the sleep files", async () => {
  const zip = makeZip([
    { name: `${GH}/x/steps_2026-09-01.csv`, text: "steps\n" },
    sleeps,
    heart("2026-09-01", 3 * MiB),
    heart("2026-09-02", 3 * MiB),
    heart("2026-09-03", 3 * MiB),
  ]);
  const batches = [];
  for await (const files of takeoutBatches([new Blob([zip])], 16 * MiB))
    batches.push(files.map((f) => f.name.split("/").pop()));
  // The rest first; then at most half the limit a batch.
  assert.deepEqual(batches, [
    ["steps_2026-09-01.csv", "UserSleeps_2026-05-31.csv"],
    [
      "UserSleeps_2026-05-31.csv",
      "heart_rate_2026-09-01.csv",
      "heart_rate_2026-09-02.csv",
    ],
    ["UserSleeps_2026-05-31.csv", "heart_rate_2026-09-03.csv"],
  ]);
});

test("each batch is posted and the counts add up", async () => {
  const zip = makeZip([
    sleeps,
    heart("2026-09-01", 15),
    heart("2026-09-02", 15),
  ]);
  const posted = [];
  const counts = await importTakeout([new Blob([zip])], 64, (files) => {
    posted.push(files.length);
    assert.deepEqual(Object.keys(files[0]), ["name", "text"]);
    return Promise.resolve({ days: 1, records: files.length });
  });
  assert.deepEqual(posted, [1, 2, 2]);
  assert.deepEqual(counts, { days: 3, records: 5 });
});

test("inflating stops at the limit, with what to do", async () => {
  // A zip bomb's worth: tiny packed, big inflated.
  const zip = makeZip([
    { name: `${GH}/x/steps_1.csv`, text: "0".repeat(2 * MiB) },
  ]);
  assert.ok(zip.length < 64 * 1024);
  await assert.rejects(
    firstUpload([new Blob([zip])], MiB),
    (e) => e.field === "files" && /import-google-health/u.test(e.message),
  );
  await assert.rejects(
    takeoutBatches(
      [new Blob([makeZip([heart("1", 2 * MiB)])])],
      2 * MiB,
    ).next(),
    /import-google-health/u,
  );
});

test("something else than a zip says so", async () => {
  await assert.rejects(
    firstUpload([new Blob(["just text, no zip"])], MiB),
    /isn't a zip/u,
  );
});
