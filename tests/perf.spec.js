// App shell and performance budgets: the app's files live under
// /v/<build>/ and are never asked for twice; an upgrade keeps the app
// opening offline; a phone renders the Summary within budget.

import { expect, test } from "@playwright/test";
import { ownProfile } from "./helpers.js";

const buildOf = (html) => /"\/v\/([^/"]+)\//u.exec(html)[1];
const diary = (page) => page.getByRole("heading", { name: "Eaten" });

// The paths the page asks the server for from now on: not those its
// memory or disk cache (or a service worker) answers.
async function network(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  const paths = [];
  const cached = new Set();
  cdp.on("Network.requestServedFromCache", ({ requestId }) =>
    cached.add(requestId),
  );
  cdp.on("Network.responseReceived", ({ requestId, response }) => {
    if (
      cached.has(requestId) ||
      response.fromDiskCache ||
      response.fromServiceWorker ||
      response.fromPrefetchCache
    )
      return;
    paths.push(new URL(response.url).pathname);
  });
  return paths;
}

test("app files are immutable under /v/", async ({ page, request }) => {
  const build = buildOf(await (await request.get("/")).text());
  const files = [];
  page.on("request", (r) => {
    const { pathname } = new URL(r.url());
    if (pathname !== "/" && !pathname.startsWith("/api/")) files.push(pathname);
  });
  await page.goto("/");
  await expect(diary(page)).toBeVisible();
  expect(files.length).toBeGreaterThan(10);
  for (const p of files) expect(p).toMatch(new RegExp(`^/v/${build}/`, "u"));

  const res = await request.get(`/v/${build}/main.mjs`);
  expect(res.headers()["cache-control"]).toBe(
    "public, max-age=31536000, immutable",
  );
  const page1 = await request.get("/");
  expect(page1.headers()["cache-control"]).toBe("no-cache");
  expect(page1.headers().etag).toBe(`"${build}"`);
  expect((await request.get("/v/0123456789abcdef/main.mjs")).status()).toBe(
    404,
  );
});

// Warm: every app file comes from the browser's cache, so opening the
// Diary costs the page's revalidation and the reads the screen makes.
const DIARY_READS = [
  "/",
  "/api/meta",
  "/api/profiles",
  "/api/profiles/:id/day/:day",
  "/api/profiles/:id/habits",
];

test("a warm open asks only for the page and the screen's reads", async ({
  page,
}) => {
  await page.goto("/");
  await expect(diary(page)).toBeVisible();
  await page.goto("about:blank");
  const paths = await network(page);
  await page.goto("/");
  await expect(diary(page)).toBeVisible();
  const generic = paths.map((p) =>
    p.replace(/\/\d+\//u, "/:id/").replace(/\d{4}-\d{2}-\d{2}/u, ":day"),
  );
  expect(generic.toSorted()).toEqual(DIARY_READS);
});

test.describe("with the service worker", () => {
  test.use({ serviceWorkers: "allow" });

  test("upgrade, then offline still opens", async ({ page, context }) => {
    const html = await (await page.request.get("/")).text();
    const now = buildOf(html);
    const old = "0123456789abcdef";
    // The build before: the same page and files at its own address.
    await context.route(
      (url) => url.pathname === "/",
      (route) =>
        route.fulfill({
          contentType: "text/html; charset=utf-8",
          body: html.replaceAll(`/v/${now}/`, `/v/${old}/`),
        }),
    );
    await context.route(`**/v/${old}/**`, async (route) =>
      route.fulfill({
        response: await route.fetch({
          url: route.request().url().replace(`/v/${old}/`, `/v/${now}/`),
        }),
      }),
    );
    const builds = () =>
      page.evaluate(async () => {
        const keys = await (await caches.open("kaloriina")).keys();
        const all = keys.map((r) => new URL(r.url).pathname.split("/"));
        return [...new Set(all.filter((p) => p[1] === "v").map((p) => p[2]))];
      });

    await page.goto("/");
    await expect(diary(page)).toBeVisible();
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    await expect(diary(page)).toBeVisible();
    await expect.poll(builds).toEqual([old]);

    // The upgrade: the server's page loads this build.
    await context.unrouteAll();
    await page.reload();
    await expect(diary(page)).toBeVisible();
    await expect.poll(builds).toEqual([now]);

    await context.setOffline(true);
    await page.reload();
    await expect(diary(page)).toBeVisible();
    await context.setOffline(false);
  });
});

// A year of one person's diary, through the API: foods carrying every
// nutrient, 8 entries, a weigh-in, a check-in and a counted habit a day,
// a workout every other day.
const YEAR = 2025;
const days = Array.from({ length: 365 }, (_, i) =>
  new Date(Date.UTC(YEAR, 0, 1 + i)).toISOString().slice(0, 10),
);

async function seedYear(request, pid) {
  const { nutrients } = await (await request.get("/api/meta")).json();
  const send = async (method, url, data) => {
    const res = await request.fetch(`/api${url}`, { method, data });
    expect(res.ok(), `${method} ${url}: ${await res.text()}`).toBe(true);
    return res.json();
  };
  const foods = [];
  for (let f = 0; f < 60; f++) {
    // Small, so a food stays within the per-100 caps (carbs and its parts).
    const per100 = Object.fromEntries(
      nutrients.map((n, k) => [n.key, 1 + ((f + k) % 9)]),
    );
    // Total carbohydrate is carbohydrate plus fibre (else 400).
    per100.carbs = per100.net_carbs + per100.fiber;
    foods.push(await send("POST", "/foods", { name: `Perf ${f}`, per100 }));
  }
  const habit = await send("POST", `/profiles/${pid}/habits`, {
    name: "Coffee",
    unit: "cups",
  });
  const p = `/profiles/${pid}`;
  // A week of days at a time: the server takes them in parallel.
  for (let w = 0; w < days.length; w += 7)
    await Promise.all(
      days.slice(w, w + 7).flatMap((day, i) => [
        ...Array.from({ length: 8 }, (_, e) =>
          send("POST", `${p}/entries`, {
            day,
            group: "Eaten",
            food_id: foods[(w + i * 7 + e * 13) % foods.length].id,
            grams: 120,
          }),
        ),
        send("PUT", `${p}/weights/${day}`, { kg: 80 + ((w + i) % 30) / 10 }),
        send("PUT", `${p}/check-ins/${day}`, {
          mood: 1 + (i % 5),
          energy: 1 + (i % 3),
          stress: 1 + (i % 4),
          tags: ["work"],
        }),
        send("PUT", `${p}/habits/${habit.id}/days/${day}`, {
          amount: 1 + (i % 4),
        }),
        ...((w + i) % 2
          ? []
          : [
              send("POST", `${p}/activities`, {
                day,
                name: "Run",
                type: "run",
                minutes: 40,
                distance_m: 8000,
              }),
            ]),
      ]),
    );
}

// The milliseconds the router took to fetch and build a screen (nav.mjs's
// "render <path>" measure), the median of 3 opens, on a 4× slower CPU.
async function renderMs(page, path) {
  const runs = [];
  for (const day of [15, 16, 17]) {
    const hash = `#/summary/${path}/${YEAR}-06-${day}`;
    await page.evaluate((h) => (location.hash = h), hash);
    const ms = () =>
      page.evaluate(
        (h) => performance.getEntriesByName(`render ${h}`)[0]?.duration,
        hash,
      );
    await expect.poll(ms).toBeGreaterThan(0);
    runs.push(await ms());
  }
  return runs.toSorted((a, b) => a - b)[1];
}

// Budgets: a Summary month opens in 300 ms
// on a phone, network and page included; a Food year in 750 ms.
const BUDGETS = [
  ["food/month", 300],
  ["body/month", 300],
  ["activity/month", 300],
  ["habits/month", 300],
  ["food/year", 750],
];

test("a phone renders each Summary month within budget", async ({
  page,
  request,
}, testInfo) => {
  // Timing needs a quiet machine: run it on its own (KALORIINA_PERF=1),
  // like the server bench (tests/bench.rs).
  test.skip(
    !process.env.KALORIINA_PERF || testInfo.project.name !== "chromium",
    "opt-in, chromium",
  );
  test.setTimeout(300_000);
  const pid = await ownProfile(page, request, "Perf year");
  await seedYear(request, pid);
  await page.goto(`/#/summary/food/month/${YEAR}-05-15`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  const over = [];
  for (const [path, budget] of BUDGETS) {
    const ms = await renderMs(page, path);
    console.log(`${path}: ${ms.toFixed(0)} ms (budget ${budget} ms)`);
    if (ms > budget) over.push(`${path} ${ms.toFixed(0)} ms > ${budget}`);
  }
  expect(over).toEqual([]);
});

// Pattern discovery (web/correlate.mjs `discover`) runs in slices.
// After a Summary navigation's first second (its render and charts), no
// task of a 4× slower phone runs over 50 ms in the next 3 s.
test("Summary's pattern discovery never holds the main thread over 50 ms", async ({
  page,
  request,
}, testInfo) => {
  test.skip(
    !process.env.KALORIINA_PERF || testInfo.project.name !== "chromium",
    "opt-in, chromium",
  );
  test.setTimeout(300_000);
  const pid = await ownProfile(page, request, "Perf patterns");
  await seedYear(request, pid);
  await page.goto(`/#/summary/body/month/${YEAR}-05-15`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  for (const month of ["06", "09"]) {
    const long = await page.evaluate(async (hash) => {
      const tasks = [];
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) tasks.push(e);
      }).observe({ type: "longtask" });
      const start = performance.now();
      location.hash = hash;
      await new Promise((done) => {
        setTimeout(done, 4000);
      });
      return tasks
        .filter((e) => e.startTime > start + 1000 && e.duration > 50)
        .map((e) => Math.round(e.duration));
    }, `#/summary/body/month/${YEAR}-${month}-15`);
    expect(long, month).toEqual([]);
  }
});
