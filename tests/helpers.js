// Shared by the UI specs: test data made through the API, and locators.

import { setTimeout as delay } from "node:timers/promises";
import { expect, test } from "@playwright/test";

import { plan } from "../web/energy.mjs";

// Per-test names, barcodes and days (see slots.mjs).
export { unique } from "./slots.mjs";

export const starts = (text) =>
  new RegExp(`^${text.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`, "u");

export async function food(request, body) {
  const res = await request.post("/api/foods", { data: body });
  expect(res.ok()).toBeTruthy();
  return res.json();
}

// The screen is live. While a screen loads (after a save, a dialog, a
// route) the old one stays shown, inert, and a fill still reaches it: wait
// for this before typing into what a save or an answer left.
export const settled = (page) =>
  expect(page.locator("#app")).not.toHaveAttribute("inert");

// The page is no wider than the window. Polled: a resize lays charts out
// again a frame or more later, so one measurement can still see the old one.
export const expectFits = (page) =>
  expect
    .poll(() =>
      page.evaluate(
        () => document.scrollingElement.scrollWidth <= window.innerWidth,
      ),
    )
    .toBe(true);

// Click the editor's Save and wait for its toast (`text`) and the screen
// it reloads: what's typed next reaches the saved screen, not the old one.
export async function save(page, text) {
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator("#toast")).toContainText(text);
  await settled(page);
}

// Answer the in-app confirmation that is open (or about to open) by
// clicking `button` ("Delete", "Leave", "Cancel"…); returns its question.
// Resolves once the screen it leaves is live again.
export async function answer(page, button) {
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const asked = await dialog.getByRole("heading").textContent();
  await dialog.getByRole("button", { name: button, exact: true }).click();
  await expect(dialog).toBeHidden();
  await settled(page);
  return asked;
}

export async function entry(request, data, profile = 1) {
  const res = await request.post(`/api/profiles/${profile}/entries`, { data });
  expect(res.ok()).toBeTruthy();
  return res.json();
}

// A profile made as the app makes one: the profile, then its weigh-in today
// (`weight_kg`, none when null), then the targets recommended once it has
// every measurement. Resolves to the profile as saved.
async function madeProfile(request, { weight_kg: kg = null, ...data }) {
  const res = await request.post("/api/profiles", { data });
  expect(res.ok()).toBeTruthy();
  const p = await res.json();
  if (kg !== null) {
    const put = await request.put(
      `/api/profiles/${p.id}/weights/${todayInApp()}`,
      { data: { kg } },
    );
    expect(put.ok()).toBeTruthy();
  }
  // The energy target is the app's model's (ADR 0020), as the app plans it
  // for a profile without history; `/recommended` scales with it.
  const today = todayInApp();
  const energy =
    kg === null
      ? null
      : plan({
          profile: { ...p, latest_weight_kg: kg },
          byKey: {},
          days: [],
          weights: [{ day: today, kg }],
          readings: [],
          deviceDays: [],
          activities: [],
          today,
        }).needed?.target;
  const recommended = await request.get(
    `/api/profiles/${p.id}/recommended${energy ? `?energy=${energy}` : ""}`,
  );
  if (recommended.ok()) {
    const list = await recommended.json();
    const put = await request.put(`/api/profiles/${p.id}/targets`, {
      data: {
        rev: p.rev,
        targets: [
          ...list.map(({ metric, value }) => ({ metric, value })),
          ...(energy ? [{ metric: "energy", value: energy }] : []),
        ],
      },
    });
    expect(put.ok()).toBeTruthy();
  }
  return (await request.get(`/api/profiles/${p.id}`)).json();
}

// Set one target (`null`: clear it), keeping the others the profile set.
export async function setTarget(request, pid, metric, value) {
  const { rev } = await (await request.get(`/api/profiles/${pid}`)).json();
  const list = await (await request.get(`/api/profiles/${pid}/targets`)).json();
  const res = await request.put(`/api/profiles/${pid}/targets`, {
    data: {
      rev,
      targets: [
        ...list
          .filter((t) => !t.default && t.metric !== metric)
          .map((t) => ({ metric: t.metric, value: t.value })),
        ...(value === null ? [] : [{ metric, value }]),
      ],
    },
  });
  expect(res.ok()).toBeTruthy();
}

// A profile of the test's own, current in the page: tests that change
// targets would otherwise race on the shared profile 1.
export async function ownProfile(page, request, name) {
  const { id } = await madeProfile(request, {
    name,
    sex: "female",
    birth_date: "1990-01-01",
    height_cm: 165,
    weight_kg: 60,
    activity: 1.6,
    goal_kg_per_week: 0,
  });
  await page.addInitScript(
    (pid) => localStorage.setItem("profile", String(pid)),
    id,
  );
  return id;
}

export const headline = (page) => page.locator(".headline strong");

// A day's totals in a summary response.
export const dayTotal = (d, energy) => ({ day: d, total: { energy } });

// Exercises by name, for workouts made through the API.
export async function exerciseIds(request) {
  const all = await (await request.get("/api/exercises")).json();
  return (name) => all.find((e) => e.name === name).id;
}

export async function workout(request, data) {
  const res = await request.post("/api/workouts", { data });
  expect(res.ok()).toBeTruthy();
  return res.json();
}

// A step's one-line title, by its path ("1.0").
export const stepTitle = (page, path) =>
  page.locator(`[data-path="${path}"] > .step-head summary .name`);

// Pick an exercise in the open picker by searching for it.
export async function pickExercise(page, query, name) {
  await page.getByLabel("Search exercises").fill(query);
  await page
    .locator(".step-picker")
    .getByRole("button", { name: starts(name) })
    .click();
}

// A profile made through the API (not made current): `data` overrides the
// measurements (`weight_kg`: its weigh-in today).
export const newProfile = (request, data) =>
  madeProfile(request, {
    sex: "male",
    birth_date: "1985-01-01",
    height_cm: 180,
    weight_kg: 80,
    activity: 1.6,
    goal_kg_per_week: 0,
    ...data,
  });

// The page's next `method` request to a URL containing `path` answered: a
// save's own write, to wait on when its toast reads like one the last save
// left showing. Take it before the click that sends it.
export const answered = (page, method, path) =>
  page.waitForResponse(
    (r) => r.request().method() === method && r.url().includes(path),
  );

// Requests to `glob` by `method`: the first reaches the server, and its
// answer is lost on the way back (as when the connection drops).
export async function loseFirstAnswer(page, method, glob) {
  let first = true;
  await page.route(glob, async (route) => {
    if (first && route.request().method() === method) {
      first = false;
      await route.fetch();
      await route.abort();
    } else await route.fallback();
  });
}

// The day each test pinned with `fixedToday`, by test.
const pinned = new Map();

// Today as the page sees it (the projects pin Helsinki time): the test's
// pinned day once `fixedToday` ran, else the wall clock's.
export function todayInApp() {
  let id = null;
  try {
    id = test.info().testId;
  } catch {
    // Outside a test (a spec's top level): the wall clock.
  }
  return (
    pinned.get(id) ??
    new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Helsinki" })
  );
}

// Today stays one day for the whole test, in the page and in the
// test, even across Helsinki midnight. The page's clock starts at that
// day's noon and runs on (`page.clock.install`), so its timers still fire;
// call it before the page loads. Resolves to the day.
export async function fixedToday(page) {
  const day = todayInApp();
  pinned.set(test.info().testId, day);
  await page.clock.install({ time: new Date(`${day}T12:00:00+02:00`) });
  return day;
}

// The server's real answer to a mocked request, with `patch` over it: an
// object spread over the real one, or a function `(real, url)` giving the
// answer. A mock so keeps every field the server sends, and its request must
// be one the server accepts.
async function realJson(route, patch) {
  const res = await route.fetch();
  expect(res.ok(), `${route.request().url()}: ${res.status()}`).toBeTruthy();
  const real = await res.json();
  return typeof patch === "function"
    ? patch(real, route.request().url())
    : { ...real, ...patch };
}

// Playwright's errors for a page or context that is gone. When a test ends,
// its context is closed before the page reads as closed, so `isClosed()`
// alone misses a request still in flight then.
const GONE = /has been closed|has been disposed/u;

// Answer requests matching `pattern` with `realJson`'s patched answer. A
// request still in flight when the test ends (the screen reloading after
// its last check) finds the page gone: nobody waits for its answer.
export const mockJson = (page, pattern, patch) =>
  page.route(pattern, async (route) => {
    try {
      await route.fulfill({ json: await realJson(route, patch) });
    } catch (err) {
      if (!page.isClosed() && !GONE.test(err.message)) throw err;
    }
  });

// Answer the day `day` (any profile) with the real day and `patch` over it.
export const realDay = (page, day, patch) =>
  mockJson(page, `**/api/profiles/*/day/${day}`, patch);

// The screen's activity reads, any not bounded by a first day or a count.
export function unbounded(page) {
  const seen = [];
  page.on("request", (r) => {
    const url = new URL(r.url());
    const read = r.method() === "GET" && url.pathname.endsWith("/activities");
    const bounded = ["from", "limit"].some((k) => url.searchParams.has(k));
    if (read && !bounded) seen.push(url.pathname + url.search);
  });
  return seen;
}

// Health Connect as the phone posts it: the server makes nights,
// naps, stage spans and HRV from the raw records, so a test's night goes as
// the sleep session it would be read as, a page before the window.

/** Helsinki's offset at `ms` ("+03:00"). */
function helsinkiOffset(ms) {
  const name = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Helsinki",
    timeZoneName: "longOffset",
  })
    .formatToParts(new Date(ms))
    .find((p) => p.type === "timeZoneName").value;
  return name === "GMT" ? "+00:00" : name.slice(3);
}

/** An offset ("+03:00") in minutes. */
const offsetMinutes = (o) =>
  (o[0] === "-" ? -1 : 1) * (Number(o.slice(1, 3)) * 60 + Number(o.slice(4)));

/** `local` ("2026-09-02T07:00") in Helsinki, as an instant and its offset. */
function helsinki(local) {
  const wall = Date.parse(`${local}:00Z`);
  let at = wall - offsetMinutes(helsinkiOffset(wall)) * 60_000;
  at = wall - offsetMinutes(helsinkiOffset(at)) * 60_000;
  return { ms: at, offset: helsinkiOffset(at) };
}

const iso = (ms) => new Date(ms).toISOString().replace(".000Z", "Z");
const STAGE_TYPES = { awake: 1, light: 4, deep: 5, rem: 6, unknown: 2 };

/** A raw sleep session from `start` to `end` (ms; Helsinki offsets). */
function sleepSession(id, start, end, stages, bpm) {
  const data = {
    start_time: iso(start),
    start_zone_offset: helsinkiOffset(start),
    end_time: iso(end),
    end_zone_offset: helsinkiOffset(end),
    stages: stages.map(([a, b, type]) => ({
      start_time: iso(a),
      end_time: iso(b),
      type,
    })),
  };
  if (bpm != null) data.avg_bpm = bpm;
  return { kind: "SleepSession", id, start: iso(start), end: iso(end), data };
}

/**
 * A day item's night (`bedtime` to `wake_time`, Helsinki), its naps and its
 * HRV and night heart rate, as the raw records the phone keeps. The night's
 * spans are its `stages`; else, with stage minutes, its first minutes past
 * `asleep_min` awake, then `deep_min`, `rem_min` and `light_min`; else none
 * (asleep all the time in bed). A nap with `asleep_min` is awake first,
 * then light.
 */
function rawOf(d) {
  const out = [];
  if (d.bedtime && d.wake_time) {
    const end = helsinki(`${d.day}T${d.wake_time}`).ms;
    let start = helsinki(`${d.day}T${d.bedtime}`).ms;
    if (start >= end) start -= 86_400_000;
    const stages = (d.stages ?? []).map((x) => [
      Date.parse(x.start),
      Date.parse(x.end),
      STAGE_TYPES[x.stage],
    ]);
    if (!d.stages && (d.deep_min ?? d.rem_min ?? d.light_min) != null) {
      let at = start;
      const inBed = (end - start) / 60_000;
      for (const [minutes, type] of [
        [inBed - (d.asleep_min ?? inBed), 1],
        [d.deep_min ?? 0, 5],
        [d.rem_min ?? 0, 6],
        [d.light_min ?? 0, 4],
      ]) {
        if (minutes > 0) stages.push([at, at + minutes * 60_000, type]);
        at += minutes * 60_000;
      }
    }
    out.push(
      sleepSession(`night-${d.day}`, start, end, stages, d.sleep_avg_hr),
    );
    if (d.hrv_ms != null) {
      const mid = iso((start + end) / 2);
      out.push({
        kind: "HeartRateVariabilityRmssd",
        id: `hrv-${d.day}`,
        start: mid,
        data: {
          time: mid,
          zone_offset: helsinkiOffset(Date.parse(mid)),
          ms: d.hrv_ms,
        },
      });
    }
  }
  for (const n of d.naps ?? []) {
    const [start, end] = [Date.parse(n.start_at), Date.parse(n.end_at)];
    const asleep = end - (n.asleep_min ?? 0) * 60_000;
    const stages =
      n.asleep_min == null
        ? []
        : [
            [start, asleep, 1],
            [asleep, end, 4],
          ].filter(([a, b]) => b > a);
    out.push(sleepSession(n.key, start, end, stages));
  }
  return out;
}

/**
 * Post Health Connect's window `body` to profile `pid` as the phone does:
 * its days' nights, naps and HRV as raw records first (a page), then the
 * window. A day's HRV without its night (a phone sends HRV only with the
 * night it was read in) comes as an export's daily value instead, a Google
 * Health import. The window's answer.
 */
export async function syncHealth(request, pid, body) {
  const days = body.days ?? [];
  const records = days.flatMap((x) => rawOf(x));
  if (records.length > 0) {
    const page = await request.post(
      `/api/profiles/${pid}/sync/health/records`,
      {
        data: { device: body.device ?? "Pixel 9", records },
      },
    );
    expect(page.ok()).toBeTruthy();
  }
  const hrv = days.filter(
    (d) => d.hrv_ms != null && !(d.bedtime && d.wake_time),
  );
  if (hrv.length > 0) {
    const text = [
      "timestamp,average heart rate variability milliseconds",
      ...hrv.map((d) => `${d.day}T12:00:00Z,${d.hrv_ms}`),
    ].join("\n");
    const imported = await postImport(
      request,
      `/api/profiles/${pid}/import/google-health`,
      { files: [{ name: "daily_heart_rate_variability.csv", text }] },
    );
    expect(imported.ok()).toBeTruthy();
  }
  return request.post(`/api/profiles/${pid}/sync/health`, { data: body });
}

// A server takes one import at a time (503 busy, "Another import is
// running"), and every spec's imports share the one test server: a busy
// import is sent again, as a person would. `postImport` through the API;
// `importsTakeTurns` for the page's imports (profile, Cronometer, Google
// Health), routed before any of the test's own routes.
export async function postImport(request, url, data) {
  for (;;) {
    const res = await request.post(url, { data });
    if (res.status() !== 503) return res;
    await delay(500);
  }
}

export const importsTakeTurns = (page) =>
  page.route(
    (url) => /\/import(\/|$)/u.test(url.pathname),
    async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      for (;;) {
        const res = await route.fetch();
        if (res.status() !== 503) return route.fulfill({ response: res });
        await delay(500);
      }
    },
  );

// A line of parts never breaks inside a part, at every phone width (320 to
// 393 px, so some line break falls where a part is). `partsOf` cuts the
// element's text (no-break spaces read as spaces) into its parts, in order.
export async function expectPartsWhole(locator, partsOf) {
  const text = (await locator.textContent()).replaceAll("\u00A0", " ");
  const parts = partsOf(text);
  expect(parts.join(""), text).not.toBe("");
  const widths = Array.from({ length: 25 }, (_, i) => 320 + i * 3);
  for (const width of [...widths, 393]) {
    await locator.page().setViewportSize({ width, height: 800 });
    const lines = await locator.evaluate((el, cut) => {
      // Its one text, within the result's markup.
      const node = document
        .createTreeWalker(el, NodeFilter.SHOW_TEXT)
        .nextNode();
      const range = document.createRange();
      let at = 0;
      return cut.map((part) => {
        at = node.textContent.replaceAll("\u00A0", " ").indexOf(part, at);
        range.setStart(node, at);
        range.setEnd(node, at + part.length);
        at += part.length;
        const tops = [...range.getClientRects()].map((r) => Math.round(r.top));
        return `${part}: ${new Set(tops).size}`;
      });
    }, parts);
    expect(lines, `at ${width} px`).toEqual(parts.map((x) => `${x}: 1`));
  }
}
