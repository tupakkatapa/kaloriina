// The Google Health files Kaloriina reads, out of a Google Takeout zip
// without unpacking the rest: the zip's directory says where each file
// lies, and only those are inflated (DecompressionStream), counting the
// bytes as they come so a zip bomb stops at the limit. The server reads the
// formats (src/google_health.rs); this only picks the files by name and
// cuts them into uploads.
// ponytail: no zip64: Takeout's 2 GB parts never need it; a bigger
// archive is refused by name.

// Mirrors `kind()` in src/google_health.rs; tests/fixtures/takeout-names.json
// is checked against both.
const WANTED =
  /(?:^|\/)(?:(?:UserExercises|UserSleeps|UserSleepStages|steps|active_energy_burned)_[^/]*|heart_rate_\d[^/]*|daily_resting_heart_rate|daily_heart_rate_variability)\.csv$/u;
// Per-second heart rate outgrows one upload: it goes in batches of its own.
const HEART = /(?:^|\/)heart_rate_\d[^/]*\.csv$/u;
// A per-sample file's date (`oxygen_saturation_2026-09-01.csv`).
const DATED = /_\d{4}-\d\d-\d\d/u;
// What a heart rate batch needs besides: the nights its means are over.
const SLEEP = /(?:^|\/)UserSleeps_[^/]*\.csv$/u;

export const isHeart = (name) => HEART.test(name);

// Mirrors `other()` in src/google_health.rs: the other health files, kept
// raw only (sent in batches of their own).
export function isRaw(name) {
  const folders = name.split("/");
  const file = folders.pop();
  if (!file.endsWith(".csv") || WANTED.test(name)) return false;
  return (
    folders.includes("Health Fitness Data_GoogleData") ||
    (folders.some((f) => f.endsWith("_GoogleData")) && !DATED.test(file))
  );
}

export const wanted = (name) => WANTED.test(name) || isRaw(name);

const u16 = (v, at) => v.getUint16(at, true);
const u32 = (v, at) => v.getUint32(at, true);

const view = async (blob, from, to) =>
  new DataView(await blob.slice(from, to).arrayBuffer());

// Every entry of the zip `blob`: its name, compression, packed size and
// where its local header starts.
async function entries(blob) {
  // The end record: 22 bytes and a comment of up to 64 KiB.
  const from = Math.max(0, blob.size - 22 - 0xffff);
  const tail = await view(blob, from, blob.size);
  let end = tail.byteLength - 22;
  while (end >= 0 && u32(tail, end) !== 0x06054b50) end--;
  if (end < 0) throw new Error("This isn't a zip file.");
  const count = u16(tail, end + 10);
  const at = u32(tail, end + 16);
  if (count === 0xffff || at === 0xffffffff)
    throw new Error("Zips over 4 GB aren't read: export in 2 GB parts.");
  const dir = await view(blob, at, at + u32(tail, end + 12));
  const names = new TextDecoder();
  const out = [];
  for (let n = 0, p = 0; n < count; n++) {
    if (u32(dir, p) !== 0x02014b50) throw new Error("The zip is broken.");
    const length = u16(dir, p + 28);
    out.push({
      name: names.decode(
        new Uint8Array(dir.buffer, dir.byteOffset + p + 46, length),
      ),
      method: u16(dir, p + 10),
      packed: u32(dir, p + 20),
      local: u32(dir, p + 42),
    });
    p += 46 + length + u16(dir, p + 30) + u16(dir, p + 32);
  }
  return out;
}

// Too much for the browser: an error the import dialog shows at its file
// input (`field`, as the server names it).
const tooMuch = () =>
  Object.assign(
    new Error(
      "Too much Google Health data for the browser: run kaloriina import-google-health on the server.",
    ),
    { field: "files" },
  );

// Entry `e` of `blob` inflated, refused past `room` bytes: {name, text, bytes}.
async function inflate(blob, e, room) {
  const head = await view(blob, e.local, e.local + 30);
  const from = e.local + 30 + u16(head, 26) + u16(head, 28);
  let stream = blob.slice(from, from + e.packed).stream();
  if (e.method === 8)
    stream = stream.pipeThrough(new DecompressionStream("deflate-raw"));
  else if (e.method !== 0)
    throw new Error(`${e.name}: compression ${e.method} isn't read.`);
  let bytes = 0;
  const counted = stream.pipeThrough(
    new TransformStream({
      transform(chunk, out) {
        bytes += chunk.byteLength;
        if (bytes > room) throw tooMuch();
        out.enqueue(chunk);
      },
    }),
  );
  const text = await new Response(counted).text();
  return { name: e.name, text, bytes };
}

// The wanted entries of the zips `blobs` (Takeout splits a big export into
// parts), split: heart rate, the files kept raw only, and the rest.
async function pick(blobs) {
  const heart = [];
  const raw = [];
  const rest = [];
  for (const blob of blobs)
    for (const e of await entries(blob)) {
      if (isHeart(e.name)) heart.push({ blob, e });
      else if (isRaw(e.name)) raw.push({ blob, e });
      else if (wanted(e.name)) rest.push({ blob, e });
    }
  return { heart, raw, rest };
}

// `picked` inflated, `room` bytes at most in all.
async function inflateAll(picked, room) {
  const files = [];
  for (const { blob, e } of picked) {
    const f = await inflate(blob, e, room);
    room -= f.bytes;
    files.push(f);
  }
  return files;
}

// The rest's share of `limit` (the server's `import_bytes`): JSON escaping
// grows a body a little.
const firstRoom = (limit) => Math.floor(limit * 0.9);

// The uploads the zips `blobs` make, one at a time: every file read first,
// then the heart rate files in batches of at most half of `limit` (the
// server's `import_bytes`), each with the sleep files, then the files kept
// raw only, as many as fit the first's share a batch; one that never fits
// is left out, named to `skip`. The server merges each day per column, so
// the batches compose.
export async function* takeoutBatches(blobs, limit, skip = () => {}) {
  const { heart, raw, rest } = await pick(blobs);
  const first = await inflateAll(rest, firstRoom(limit));
  if (first.length > 0 || (heart.length === 0 && raw.length === 0)) yield first;
  const sleeps = first.filter((f) => SLEEP.test(f.name));
  const room = Math.floor(limit / 2) - sleeps.reduce((n, f) => n + f.bytes, 0);
  let batch = [];
  let used = 0;
  for (const { blob, e } of heart) {
    const f = await inflate(blob, e, room);
    if (used + f.bytes > room) {
      yield [...sleeps, ...batch];
      [batch, used] = [[], 0];
    }
    batch.push(f);
    used += f.bytes;
  }
  if (batch.length > 0) yield [...sleeps, ...batch];
  yield* rawBatches(raw, firstRoom(limit), skip);
}

// The files `picked` in batches of at most `room` bytes; one bigger is
// named to `skip`.
async function* rawBatches(picked, room, skip) {
  let batch = [];
  let used = 0;
  for (const { blob, e } of picked) {
    let f;
    try {
      f = await inflate(blob, e, room);
    } catch (err) {
      if (err.field !== "files") throw err;
      skip(e.name);
      continue;
    }
    if (used + f.bytes > room) {
      yield batch;
      [batch, used] = [[], 0];
    }
    batch.push(f);
    used += f.bytes;
  }
  if (batch.length > 0) yield batch;
}

// Post every upload of the zips `blobs` with `post(files)`; the counts
// added up, with `too_big` the files left out.
// ponytail: a heart rate batch re-sends the sleep files, so a bad sleep
// row counts as skipped once a batch; count per file kind if it misleads.
export async function importTakeout(blobs, limit, post) {
  const total = {};
  const skip = () => {
    total.too_big = (total.too_big ?? 0) + 1;
  };
  for await (const files of takeoutBatches(blobs, limit, skip)) {
    const counts = await post(files.map(({ name, text }) => ({ name, text })));
    for (const [k, v] of Object.entries(counts)) total[k] = (total[k] ?? 0) + v;
  }
  return total;
}
