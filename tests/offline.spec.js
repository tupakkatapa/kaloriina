// Offline: the outbox, its replay and the sync pill (service
// worker blocked, as everywhere), then the service worker itself (opted in).

import { setTimeout as delay } from "node:timers/promises";
import { expect, test } from "@playwright/test";
import {
  answer,
  entry,
  expectFits,
  fixedToday,
  food,
  newProfile,
  ownProfile,
  settled,
  starts,
  todayInApp,
  unique,
} from "./helpers.js";

// One today for the whole test, in the page and here.
test.beforeEach(({ page }) => fixedToday(page));

const pill = (page) => page.locator("#sync");

// `api()` from inside the page, as a screen calls it: its answer, or the
// error's code and message. The page's own module (beside its main.mjs,
// versioned or not), so the app's state is the one used.
const call = (page, ...args) =>
  page.evaluate(async (a) => {
    const main = document.querySelector('script[type="module"]').src;
    const { api } = await import(new URL("api.mjs", main));
    try {
      return { data: await api(...a) };
    } catch (err) {
      return { code: err.code, message: err.message };
    }
  }, args);

const flush = (page) =>
  page.evaluate(async () => {
    const main = document.querySelector('script[type="module"]').src;
    return (await import(new URL("api.mjs", main))).flush();
  });

// A server error's backoff over (outbox.mjs `wake`, as Send now).
const wake = (page) =>
  page.evaluate(async () => {
    const main = document.querySelector('script[type="module"]').src;
    (await import(new URL("outbox.mjs", main))).wake();
  });

const outbox = (page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem("outbox") ?? "[]"));

// How many entries of the day carry `uid`.
async function stored(request, day, uid) {
  const res = await request.get(`/api/profiles/1/day/${day}`);
  return JSON.stringify(await res.json()).split(`"${uid}"`).length - 1;
}

// A food logged (through the page) onto the day.
async function setup(page, request, slot, testInfo) {
  const { day, tag } = unique(slot, testInfo);
  const f = await food(request, {
    name: `Oats ${tag}`,
    per100: { energy: 380 },
  });
  await page.goto(`/#/day/${day}`);
  await expect(page.getByRole("heading", { name: "Eaten" })).toBeVisible();
  const body = (uid) => ({
    uid,
    day,
    group: "Eaten",
    food_id: f.id,
    grams: 50,
  });
  return { day, tag, f, body };
}

const ENTRIES = "/profiles/1/entries";

// A login proxy whose session expired: its own page, not the server.
const login = (route) =>
  route.fulfill({
    status: 200,
    contentType: "text/html",
    body: "<html><body>Proxy login</body></html>",
  });

test("an opted-in write made offline waits, shows, and is stored once back online", async ({
  page,
  context,
  request,
}, testInfo) => {
  const { day, tag, body } = await setup(page, request, 420, testInfo);
  await expect(pill(page)).toBeHidden();
  await context.setOffline(true);

  // Not opted in: it fails as it always did, and nothing waits.
  const plain = await call(page, "POST", ENTRIES, body(`plain-${tag}`));
  expect(plain.code).toBe("offline");
  expect(await outbox(page)).toEqual([]);
  await expect(pill(page)).toHaveText("Offline");

  // Opted in: it waits, and the form's key moves on as after a save.
  const queued = await page.evaluate(
    async ([path, make]) => {
      const main = document.querySelector('script[type="module"]').src;
      const { api, createId, isQueued } = await import(
        new URL("api.mjs", main)
      );
      const key = createId();
      const uid = key.get();
      try {
        await api(
          "POST",
          path,
          { ...make, uid },
          { queue: true, label: "Oats" },
        );
        return null;
      } catch (err) {
        return { queued: isQueued(err), uid, rotated: key.get() !== uid };
      }
    },
    [ENTRIES, body(null)],
  );
  expect(queued).toMatchObject({ queued: true, rotated: true });
  await expect(pill(page)).toHaveText("1 waiting");
  await expect(page.locator("#sync-badge")).toHaveText("1");
  const [item] = await outbox(page);
  expect(item).toMatchObject({ method: "POST", label: "Oats", attempts: 0 });

  // Back online: sent at once, stored once, the pill gone.
  await context.setOffline(false);
  await expect(pill(page)).toBeHidden();
  expect(await outbox(page)).toEqual([]);
  expect(await stored(request, day, queued.uid)).toBe(1);
});

test("a write whose answer was lost is stored once on replay", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag, body } = await setup(page, request, 421, testInfo);
  // The server stores it, but the answer never arrives.
  await page.route(
    "**/api/profiles/1/entries",
    async (route) => {
      await route.fetch();
      await route.abort();
    },
    { times: 1 },
  );
  const uid = `lost-${tag}`;
  const first = await call(page, "POST", ENTRIES, body(uid), { queue: true });
  expect(first.code).toBe("queued");
  expect(await stored(request, day, uid)).toBe(1);
  await flush(page);
  expect(await outbox(page)).toEqual([]);
  expect(await stored(request, day, uid)).toBe(1);
  await expect(pill(page)).toBeHidden();
});

test("a login page instead of the server asks to sign in again", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag, body } = await setup(page, request, 422, testInfo);
  await page.route("**/api/profiles/1/entries", login);
  const uid = `signin-${tag}`;
  expect(
    (await call(page, "POST", ENTRIES, body(uid), { queue: true })).code,
  ).toBe("queued");
  await expect(pill(page)).toHaveText("Sign in again");
  // Still the login page: kept, not counted (no answer from the server),
  // still asking.
  await flush(page);
  expect((await outbox(page))[0].attempts).toBe(0);
  await expect(pill(page)).toHaveText("Sign in again");
  await page.goto("/#/outbox");
  await expect(page.getByRole("alert")).toContainText("sign in");

  // Signed in again: Send now stores it.
  await page.unroute("**/api/profiles/1/entries", login);
  await page.getByRole("button", { name: "Send now" }).click();
  await expect(page.getByText("Nothing waits")).toBeVisible();
  await expect(pill(page)).toBeHidden();
  expect(await stored(request, day, uid)).toBe(1);
});

test("an item fails after 5 tries or a refusal, and can be discarded", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag, body } = await setup(page, request, 423, testInfo);
  let calls = 0;
  await page.route("**/api/profiles/1/entries", (route) =>
    calls++ === 0
      ? route.abort()
      : route.fulfill({
          // A proxy's 503 first (the server restarting): no try spent.
          status: calls === 2 ? 503 : 500,
          contentType: "application/json",
          body: JSON.stringify({ error: "Down for maintenance" }),
        }),
  );
  const uid = `tries-${tag}`;
  await call(page, "POST", ENTRIES, body(uid), { queue: true, label: "Oats" });
  await flush(page);
  expect((await outbox(page))[0]).toMatchObject({ attempts: 0, failed: null });
  for (let i = 1; i <= 4; i++) {
    await flush(page);
    expect((await outbox(page))[0]).toMatchObject({
      attempts: i,
      failed: null,
    });
    // outbox_backoff: the next try waits; a flush before then sends nothing.
    await flush(page);
    expect((await outbox(page))[0].attempts).toBe(i);
    await wake(page);
  }
  await flush(page);
  expect((await outbox(page))[0]).toMatchObject({
    attempts: 5,
    failed: "Down for maintenance",
  });
  await expect(pill(page)).toHaveText("1 failed");

  // A refusal (4xx) fails at once: a retry wouldn't change it.
  await page.unrouteAll();
  await page.route("**/api/profiles/1/entries", (route) => route.abort(), {
    times: 1,
  });
  await call(
    page,
    "POST",
    ENTRIES,
    { ...body(`refused-${tag}`), grams: -1 },
    {
      queue: true,
      label: "Bad oats",
    },
  );
  await flush(page);
  expect((await outbox(page)).map((x) => x.attempts)).toEqual([5, 0]);
  await expect(pill(page)).toHaveText("2 failed");

  await pill(page).click();
  await expect(
    page.getByRole("heading", { name: "Waiting to send" }),
  ).toBeVisible();
  await expect(page.getByText("Not sent: Down for maintenance")).toBeVisible();
  // Nothing left to send.
  await expect(page.getByRole("button", { name: "Send now" })).toHaveCount(0);
  for (const label of ["Oats", "Bad oats"]) {
    await page.getByRole("button", { name: `Discard ${label}` }).click();
    expect(await answer(page, "Discard")).toBe(`Discard "${label}"?`);
  }
  await expect(page.getByText("Nothing waits")).toBeVisible();
  await expect(pill(page)).toBeHidden();
  expect(await stored(request, day, uid)).toBe(0);
});

test("a live write supersedes the waiting one for its path", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = await setup(page, request, 424, testInfo);
  // A weight is for today or before; a profile of its own keeps today free.
  const { id } = await newProfile(request, { name: `Weigh ${tag}` });
  const day = todayInApp();
  const path = `/profiles/${id}/weights/${day}`;
  await page.route(`**/api${path}`, (route) => route.abort(), { times: 1 });
  expect(
    (await call(page, "PUT", path, { kg: 70 }, { queue: true })).code,
  ).toBe("queued");
  await expect(pill(page)).toHaveText("1 waiting");
  // Edited again, online: the newer weight stands and the old one is dropped.
  expect((await call(page, "PUT", path, { kg: 71 })).code).toBeUndefined();
  expect(await outbox(page)).toEqual([]);
  await expect(pill(page)).toBeHidden();
  const saved = await (
    await request.get(`/api/profiles/${id}/day/${day}`)
  ).json();
  expect(saved.weight).toBe(71);
});

test("the pill sits above the tabs on a phone and in the sidebar on a desktop", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "one run is enough");
  // A failed item: it stays put (online, a waiting one would be sent).
  await page.addInitScript(() =>
    localStorage.setItem(
      "outbox",
      JSON.stringify([
        {
          key: "k",
          method: "POST",
          path: "/x",
          body: null,
          uid: null,
          label: "Oats",
          queuedAt: new Date().toISOString(),
          attempts: 5,
          failed: "Down",
        },
      ]),
    ),
  );
  const tabs = page.getByRole("navigation", { name: "Main" });
  for (const width of [320, 393, 1440]) {
    await page.setViewportSize({ width, height: 800 });
    for (const hash of ["#/", "#/outbox", "#/food/new"]) {
      await page.goto(`/${hash}`);
      // The screen itself, not the one before it (screens load on demand).
      await settled(page);
      await expect(pill(page)).toHaveText("1 failed");
      const box = await pill(page).boundingBox();
      const nav = await tabs.boundingBox();
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      if (width < 1024) {
        // Over the page, clear of the tabs and of an editor's Save bar.
        expect(box.y + box.height).toBeLessThanOrEqual(nav.y);
        const bar = page.locator(".actions-bar");
        if (await bar.count())
          expect(box.y + box.height).toBeLessThanOrEqual(
            (await bar.boundingBox()).y,
          );
        await expect(page.locator("#sync-badge")).toHaveText("1");
      } else {
        // A row of the sidebar.
        expect(box.y).toBeGreaterThanOrEqual(nav.y);
        expect(box.y + box.height).toBeLessThanOrEqual(nav.y + nav.height);
        await expect(page.locator("#sync-badge")).toBeHidden();
      }
      await expectFits(page);
    }
  }
});

// ---------------------------------------------------------------------
// The screens that opt in: a write that can't get through is kept, the day
// shows it as waiting, and it's stored once it gets through.

const section = (page, name) =>
  page.locator(".group", {
    has: page.getByRole("heading", { name, exact: true }),
  });
const waitingRows = (page) =>
  section(page, "Waiting to send").locator(".entry");
// A create waiting in the group it goes to, not counted yet.
const queuedIn = (page, group) =>
  section(page, group).locator(".entry", { hasText: "Waiting to send" });

// Writes fail as if offline; reads go through.
const fail = (route) =>
  route.request().method() === "GET" ? route.fallback() : route.abort();

// Writes to `glob` fail as if offline (reads still work) until `release()`,
// which lets them through and sends what waited.
async function hold(page, glob) {
  await page.route(glob, fail);
  return async () => {
    await page.unroute(glob, fail);
    await flush(page);
  };
}

const KEPT = "Saved in this browser; it's sent when you're back online";

test("a food logged while writes fail waits on its day, then is stored", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag, f } = await setup(page, request, 428, testInfo);
  await page.goto(`/#/log/${day}/Eaten/${f.id}`);
  const release = await hold(page, "**/api/profiles/1/entries");
  await page.getByRole("button", { name: "Add to Eaten" }).click();
  await expect(page).toHaveURL(new RegExp(`#/day/${day}$`, "u"));
  await expect(page.locator("#toast")).toHaveText(KEPT);
  await expect(queuedIn(page, "Eaten")).toHaveText([
    `Oats ${tag}Waiting to send · not counted yet`,
  ]);
  await expect(pill(page)).toHaveText("1 waiting");
  await expect(section(page, "Eaten").locator("a.entry-main")).toHaveCount(0);

  await release();
  await expect(section(page, "Eaten").locator(".entry")).toHaveText([
    new RegExp(`^Oats ${tag}`, "u"),
  ]);
  await expect(section(page, "Waiting to send")).toHaveCount(0);
  await expect(pill(page)).toBeHidden();
});

test("a weight logged while writes fail waits, then is stored", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(430, testInfo);
  // A weight is for today or before; a profile of its own keeps the day free.
  const day = new Date(Date.parse(todayInApp()) - 864e5)
    .toISOString()
    .slice(0, 10);
  const pid = await ownProfile(page, request, `Scale ${tag}`);
  await page.goto(`/#/day/${day}`);
  const release = await hold(page, `**/api/profiles/${pid}/weights/*`);
  const dialog = page.getByRole("dialog");
  await section(page, "Log")
    .getByRole("button", { name: /^Log on /u })
    .click();
  await dialog.getByRole("button", { name: starts("Weight") }).click();
  await dialog.getByLabel("Weight (kg)").fill("72.4");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(page.locator("#toast")).toHaveText(KEPT);
  await expect(waitingRows(page)).toHaveText([
    /^Weight 72\.4\skgWaiting to send$/u,
  ]);

  await release();
  await expect
    .poll(async () =>
      (
        await request.get(`/api/profiles/${pid}/weights?from=${day}&to=${day}`)
      ).json(),
    )
    .toEqual([{ day, kg: 72.4 }]);
  await expect(section(page, "Waiting to send")).toHaveCount(0);
});

test("nap_delete_queues_offline: a nap removed while writes fail waits, then goes", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(367, testInfo);
  const day = new Date(Date.parse(todayInApp()) - 864e5)
    .toISOString()
    .slice(0, 10);
  const pid = await ownProfile(page, request, `Nap ${tag}`);
  const uid = crypto.randomUUID();
  const nap = await request.post(`/api/profiles/${pid}/naps`, {
    data: {
      uid,
      day,
      start_at: `${day}T10:00:00Z`,
      end_at: `${day}T10:30:00Z`,
    },
  });
  expect(nap.ok()).toBeTruthy();
  await page.goto(`/#/day/${day}`);
  // A hand nap is the Sleep card's row.
  const sleep = page.locator(".sleep-card");
  await expect(sleep.locator(".nap")).toHaveCount(1);
  const release = await hold(page, `**/api/profiles/${pid}/naps/*`);
  await sleep.getByRole("button", { name: starts("Remove nap") }).click();
  await expect(page.locator("#toast")).toHaveText(KEPT);
  // Taken off the card while its removal waits (the card goes with it).
  await expect(page.locator(".sleep-card .nap")).toHaveCount(0);
  await expect(pill(page)).toHaveText("1 waiting");

  await release();
  await expect
    .poll(async () =>
      (
        await (await request.get(`/api/profiles/${pid}/day/${day}`)).json()
      ).naps.filter((n) => n.uid === uid),
    )
    .toEqual([]);
  await expect(pill(page)).toBeHidden();
});

test("Log again while writes fail waits on the day it goes to, then is stored", async ({
  page,
  request,
}, testInfo) => {
  const { day, f } = await setup(page, request, 431, testInfo);
  await entry(request, { day, group: "Eaten", food_id: f.id, grams: 50 });
  await entry(request, { day, group: "Eaten", food_id: f.id, grams: 80 });
  const to = new Date(Date.parse(day) + 3 * 864e5).toISOString().slice(0, 10);
  await page.reload();
  const eaten = section(page, "Eaten");
  await eaten.getByRole("button", { name: "Select from Eaten" }).click();
  for (const box of await eaten.getByRole("checkbox").all()) await box.check();
  const release = await hold(page, "**/api/profiles/1/entries");
  await eaten.getByRole("button", { name: "Log again…" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Day").fill(to);
  await dialog
    .getByRole("radiogroup", { name: "Group" })
    .getByRole("radio", { name: "Eaten" })
    .click();
  await dialog.getByRole("button", { name: "Log 2 again" }).click();
  await expect(page).toHaveURL(new RegExp(`#/day/${to}$`, "u"));
  await expect(page.locator("#toast")).toHaveText(KEPT);
  await expect(queuedIn(page, "Eaten")).toHaveText([
    "Log again · 2 foodsWaiting to send · not counted yet",
  ]);

  await release();
  await expect(section(page, "Eaten").locator(".entry")).toHaveCount(2);
  await expect(section(page, "Waiting to send")).toHaveCount(0);
});

// A flush (as a GET's answer starts one) whose POST is on the wire, `end`ing
// it once a second flush has been asked for: the outbox once both are done.
async function flushDuringFlush(page, end) {
  let entered;
  const onWire = new Promise((r) => {
    entered = r;
  });
  let open;
  const gate = new Promise((r) => {
    open = r;
  });
  // The first POST is held, then ends as `end` says; later ones go through.
  let held = false;
  await page.route("**/api/profiles/1/entries", async (route) => {
    if (route.request().method() === "GET") return route.abort();
    if (held) return route.continue();
    held = true;
    entered();
    await gate;
    await end(route);
  });
  const background = flush(page);
  await onWire;
  // Asked for in the page before the first ends (not just sent there).
  await page.evaluate(async () => {
    const main = document.querySelector('script[type="module"]').src;
    globalThis.second = (await import(new URL("api.mjs", main))).flush();
  });
  open();
  await Promise.all([background, page.evaluate(() => globalThis.second)]);
  const left = await outbox(page);
  await page.unrouteAll({ behavior: "ignoreErrors" });
  return left;
}

// Queued while the server can't be reached. Reads fail too, until
// `flushDuringFlush` is done: an answered one starts a flush of its own,
// which would send what that second flush must.
async function queueOne(page, request, slot, testInfo) {
  const { day, body } = await setup(page, request, slot, testInfo);
  await page.route("**/api/**", (route) => route.abort());
  const uid = crypto.randomUUID();
  expect(
    (await call(page, "POST", ENTRIES, body(uid), { queue: true })).code,
  ).toBe("queued");
  return { day, uid };
}

test("a flush asked for while a failing one is on the wire still sends", async ({
  page,
  request,
}, testInfo) => {
  const { day, uid } = await queueOne(page, request, 960, testInfo);
  // The writes come back while the first pass's POST fails as offline: the
  // second flush (Send now, `online`) runs once that pass stops.
  expect(await flushDuringFlush(page, (route) => route.abort())).toEqual([]);
  expect(await stored(request, day, uid)).toBe(1);
});

test("a flush asked for during a server error counts one try", async ({
  page,
  request,
}, testInfo) => {
  await queueOne(page, request, 961, testInfo);
  expect(
    await flushDuringFlush(page, (route) =>
      route.fulfill({ status: 500, json: { error: "boom" } }),
    ),
  ).toMatchObject([{ attempts: 1 }]);
});

test.describe("with the service worker", () => {
  test.use({ serviceWorkers: "allow" });

  // Open the day, let the worker take over, and load it once through it.
  async function cached(page, request, slot, testInfo) {
    const { day, tag, f } = await setup(page, request, slot, testInfo);
    await entry(request, { day, group: "Eaten", food_id: f.id, grams: 50 });
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    await expect(page.getByText(`Oats ${tag}`)).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() => Boolean(navigator.serviceWorker.controller)),
      )
      .toBe(true);
    return { day, tag };
  }

  test("offline, the app and a day seen before still open", async ({
    page,
    context,
    request,
  }, testInfo) => {
    const { tag } = await cached(page, request, 425, testInfo);
    await context.setOffline(true);
    await page.reload();
    await expect(page.getByText(`Oats ${tag}`)).toBeVisible();
    await expect(pill(page)).toHaveText("Offline");
    await context.setOffline(false);
  });

  test("a login page is never served from the cache", async ({
    page,
    context,
    request,
  }, testInfo) => {
    const { day, tag } = await cached(page, request, 426, testInfo);
    // The proxy's login expired: it answers the app and the day with its
    // own page.
    await context.route(`**/api/profiles/1/day/${day}`, login);
    await page.reload();
    await expect(page.getByText("The server sent a page")).toBeVisible();
    await context.route((url) => url.pathname === "/", login);
    await page.reload();
    await expect(page.getByText("Proxy login")).toBeVisible();
    await context.unrouteAll();

    // Offline, the app and the day are the last real ones.
    await context.setOffline(true);
    await page.reload();
    await expect(page.getByText(`Oats ${tag}`)).toBeVisible();
    await expect(page.getByText("Proxy login")).toHaveCount(0);
    await context.setOffline(false);
  });

  test("sw_deadline: with every request held the day opens offline in 5 s, and goes online when they're let through", async ({
    page,
    context,
    request,
  }, testInfo) => {
    const { tag } = await cached(page, request, 1068, testInfo);
    // A hung connection (lie-fi, a stuck server): nothing answers.
    const held = [];
    await context.route("**/*", (route) => {
      held.push(route);
    });
    const start = Date.now();
    const left = () => Math.max(1, 5_000 - (Date.now() - start));
    await page.reload({ waitUntil: "commit", timeout: left() });
    await expect(page.getByText(`Oats ${tag}`)).toBeVisible({
      timeout: left(),
    });
    await expect(pill(page)).toHaveText("Offline", { timeout: left() });
    // The connection comes back: the same page goes online, unreloaded.
    await page.evaluate(() => {
      window.unreloaded = true;
    });
    await Promise.all(held.map((route) => route.continue()));
    await context.unroute("**/*");
    await expect(pill(page)).toBeHidden();
    expect(await page.evaluate(() => window.unreloaded)).toBe(true);
    await expect(page.getByText(`Oats ${tag}`)).toBeVisible();
  });

  test("sw_forget: deleting a profile drops its cached days", async ({
    page,
    request,
  }, testInfo) => {
    const { tag } = unique(1042, testInfo);
    const { id } = await newProfile(request, { name: `Gone ${tag}` });
    const { day } = await cached(page, request, 1042, testInfo);
    const cachedFor = (pid) =>
      page.evaluate(
        async (p) =>
          (await (await caches.open("kaloriina")).keys()).filter((r) =>
            new URL(r.url).pathname.startsWith(`/api/profiles/${p}/`),
          ).length,
        pid,
      );
    await page.evaluate(
      ([p, d]) => fetch(`/api/profiles/${p}/day/${d}`),
      [id, day],
    );
    await expect.poll(() => cachedFor(id)).toBe(1);
    await page.goto(`/#/profile/${id}`);
    await page.getByRole("button", { name: "Delete" }).click();
    await answer(page, "Delete");
    await expect.poll(() => cachedFor(id)).toBe(0);
    expect(await cachedFor(1)).toBeGreaterThan(0);
  });
});

test("a habit counted while writes fail waits, then is stored once", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(488, testInfo);
  const day = new Date(Date.parse(todayInApp()) - 864e5)
    .toISOString()
    .slice(0, 10);
  const pid = await ownProfile(page, request, `Counted ${tag}`);
  const res = await request.post(`/api/profiles/${pid}/habits`, {
    data: { name: "Snus", unit: "pouches" },
  });
  const snus = await res.json();
  await page.goto(`/#/day/${day}`);
  const release = await hold(page, `**/api/profiles/${pid}/habits/*/days/*`);
  await section(page, "Log")
    .getByRole("button", { name: /^Log on /u })
    .click();
  const sheet = page.getByRole("dialog", { name: "Log" });
  await sheet.getByRole("button", { name: "One more Snus" }).click();
  await expect(page.locator("#toast")).toHaveText(KEPT);
  await expect(waitingRows(page)).toHaveText([
    /^Snus 1\spouchesWaiting to send$/u,
  ]);
  // The sheet stays open and says the count waits.
  await expect(sheet.getByRole("button", { name: /^Snus: /u })).toHaveText(
    /^1\spouches$/u,
  );
  await expect(sheet.locator(".habit-row")).toContainText("Waiting to send");
  // The card counts what waits.
  await sheet.getByRole("button", { name: "Done" }).click();
  await expect(sheet).toHaveCount(0);
  await expect(
    section(page, "Log").getByRole("button", { name: /^Snus: /u }),
  ).toHaveText(/^1\spouches$/u);
  await expect(pill(page)).toHaveText("1 waiting");

  await release();
  await expect(section(page, "Waiting to send")).toHaveCount(0);
  expect(
    await (
      await request.get(
        `/api/profiles/${pid}/habits/days?from=${day}&to=${day}`,
      )
    ).json(),
  ).toEqual([{ habit: String(snus.id), day, amount: 1, known: true }]);
  await expect(pill(page)).toBeHidden();
});

// ---------------------------------------------------------------------
// What waits is what the day shows; offline time never spends a write's
// tries; replays and live writes go one at a time.

const yesterday = () =>
  new Date(Date.parse(todayInApp()) - 864e5).toISOString().slice(0, 10);

const dayOf = async (request, pid, day) =>
  (await request.get(`/api/profiles/${pid}/day/${day}`)).json();

test("a queued weight/note/measurement shows in the Log card", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(740, testInfo);
  const day = yesterday();
  const pid = await ownProfile(page, request, `Overlay ${tag}`);
  const base = `/api/profiles/${pid}`;
  for (const [path, data] of [
    [`weights/${day}`, { kg: 70 }],
    [`notes/${day}`, { text: "old note" }],
    [`measurements/${day}/waist`, { value: 80 }],
  ])
    expect((await request.put(`${base}/${path}`, { data })).ok()).toBeTruthy();
  await page.goto(`/#/day/${day}`);
  const card = section(page, "Log");
  await expect(card.getByRole("button", { name: "old note" })).toBeVisible();
  await page.route(`**${base}/{weights,notes,measurements}/**`, fail);
  const dialog = page.getByRole("dialog");

  await card.getByRole("button", { name: starts("Change weight") }).click();
  await dialog.getByLabel("Weight (kg)").fill("72.4");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(page.locator("#toast")).toHaveText(KEPT);
  await expect(
    card.getByRole("button", { name: /^Change weight, 72\.4\skg$/u }),
  ).toBeVisible();
  // Its dialog opens on the waiting value, not the server's.
  await card.getByRole("button", { name: starts("Change weight") }).click();
  await expect(dialog.getByLabel("Weight (kg)")).toHaveValue("72.4");
  await dialog.getByRole("button", { name: "Cancel" }).click();

  await card.getByRole("button", { name: "old note" }).click();
  await dialog.getByRole("textbox").fill("gym note");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(card.getByRole("button", { name: "gym note" })).toBeVisible();

  await card
    .getByRole("button", { name: starts("Change measurements") })
    .click();
  await dialog.getByLabel("Waist (cm)").fill("81");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(
    card.getByRole("button", { name: /^Change measurements, Waist 81\scm$/u }),
  ).toBeVisible();
  await expect(waitingRows(page)).toHaveCount(3);

  await page.unroute(`**${base}/{weights,notes,measurements}/**`, fail);
  await flush(page);
  await expect(section(page, "Waiting to send")).toHaveCount(0);
  expect(await dayOf(request, pid, day)).toMatchObject({
    weight: 72.4,
    note: "gym note",
    measurements: [{ kind: "waist", value: 81 }],
  });
});

test("five offline flushes keep the write", async ({
  page,
  context,
  request,
}, testInfo) => {
  const { tag } = unique(741, testInfo);
  const day = yesterday();
  const pid = await ownProfile(page, request, `Gym ${tag}`);
  const path = `/profiles/${pid}/notes/${day}`;
  await page.goto(`/#/day/${day}`);
  await context.setOffline(true);
  expect(
    (await call(page, "PUT", path, { text: "gym note" }, { queue: true })).code,
  ).toBe("queued");
  // What the 30 s timer does in 2.5 minutes without a network.
  for (let i = 0; i < 5; i++) await flush(page);
  expect((await outbox(page))[0]).toMatchObject({ attempts: 0, failed: null });
  await context.setOffline(false);
  await flush(page);
  await expect.poll(() => outbox(page)).toEqual([]);
  expect((await dayOf(request, pid, day)).note).toBe("gym note");
});

test("a replay held mid-flight can't overwrite a live write", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(742, testInfo);
  const day = yesterday();
  const pid = await ownProfile(page, request, `Race ${tag}`);
  const path = `/profiles/${pid}/notes/${day}`;
  await page.goto(`/#/day/${day}`);
  // The first write can't get through (it waits); the replay's request is
  // held on the wire; meanwhile the note is saved again, live (as a screen
  // saves it); then the replay lands.
  let release;
  let arrived;
  const held = new Promise((r) => {
    arrived = r;
  });
  let writes = 0;
  await page.route(`**/api${path}`, async (route) => {
    writes += 1;
    if (writes === 1) return route.abort();
    if (writes === 2) {
      arrived();
      await new Promise((r) => {
        release = r;
      });
    }
    return route.continue();
  });
  expect(
    (await call(page, "PUT", path, { text: "old" }, { queue: true })).code,
  ).toBe("queued");
  const replay = flush(page);
  await held;
  const live = call(page, "PUT", path, { text: "new" }, { queue: true });
  await page.waitForTimeout(300);
  release();
  await replay;
  expect((await live).code).toBeUndefined();
  await expect
    .poll(async () => (await dayOf(request, pid, day)).note)
    .toBe("new");
});

test("two tabs replay PUT then DELETE once, in order", async ({
  page,
  context,
  request,
}, testInfo) => {
  const { tag } = unique(743, testInfo);
  const day = yesterday();
  const pid = await ownProfile(page, request, `Tabs ${tag}`);
  const path = `/profiles/${pid}/weights/${day}`;
  await page.goto(`/#/day/${day}`);
  const other = await context.newPage();
  await other.goto(`/#/day/${day}`);
  await context.setOffline(true);
  expect(
    (await call(page, "PUT", path, { kg: 70 }, { queue: true })).code,
  ).toBe("queued");
  expect(
    (await call(page, "DELETE", path, undefined, { queue: true })).code,
  ).toBe("queued");

  // Back online, both tabs replay at once (each on "online", and again).
  const seen = [];
  await context.route(`**/api${path}`, async (route) => {
    seen.push(route.request().method());
    await delay(100);
    await route.continue();
  });
  await context.setOffline(false);
  await Promise.all([flush(page), flush(other)]);
  await expect.poll(() => outbox(page)).toEqual([]);
  expect(seen).toEqual(["PUT", "DELETE"]);
  expect((await dayOf(request, pid, day)).weight ?? null).toBeNull();
});

// The server failing (a 500: a proxy's 503 would wait uncounted).
const down = (route) =>
  route.fulfill({
    status: 500,
    contentType: "application/json",
    body: JSON.stringify({ error: "Down for maintenance" }),
  });

test("Try again resends a write that failed on server errors", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(744, testInfo);
  const day = yesterday();
  const pid = await ownProfile(page, request, `Again ${tag}`);
  const path = `/profiles/${pid}/notes/${day}`;
  await page.goto(`/#/day/${day}`);
  // Down for maintenance; the first write can't get through at all.
  await page.route(`**/api${path}`, down);
  await page.route(`**/api${path}`, (route) => route.abort(), { times: 1 });
  expect(
    (
      await call(
        page,
        "PUT",
        path,
        { text: "kept" },
        { queue: true, label: "Note" },
      )
    ).code,
  ).toBe("queued");
  // Five server errors in a row (a flush running already counts too).
  await expect
    .poll(async () => {
      await wake(page);
      await flush(page);
      return (await outbox(page))[0].failed;
    })
    .toBe("Down for maintenance");
  await expect(pill(page)).toHaveText("1 failed");
  await page.unroute(`**/api${path}`, down);

  await pill(page).click();
  await expect(page.getByText("Not sent: Down for maintenance")).toBeVisible();
  await page.getByRole("button", { name: "Try again Note" }).click();
  await expect(page.getByText("Nothing waits")).toBeVisible();
  expect((await dayOf(request, pid, day)).note).toBe("kept");
});

// A page left open across a server upgrade: answers name the build
// that served them.
const newerBuild = async (route) => {
  const res = await route.fetch();
  await route.fulfill({
    response: res,
    headers: { ...res.headers(), "x-kaloriina-build": "newer" },
  });
};
// Mid-reload there's no page to ask: not yet.
const reloaded = (page) =>
  page.evaluate(() => !window.unreloaded).catch(() => false);

test("stale_build_reloads: an answer from a newer build reloads on the next screen", async ({
  page,
}, testInfo) => {
  const { day } = unique(1040, testInfo);
  await page.goto(`/#/day/${day}`);
  await expect(page.getByRole("heading", { name: "Eaten" })).toBeVisible();
  await page.evaluate(() => {
    window.unreloaded = true;
  });
  await page.route("**/api/**", newerBuild);
  // Marked stale; the screen in use stays as it is.
  await call(page, "GET", "/meta");
  expect(await reloaded(page)).toBe(false);
  await page.evaluate(() => {
    location.hash = "#/foods";
  });
  await expect.poll(() => reloaded(page)).toBe(true);
  await expect(page).toHaveURL(/#\/foods$/u);
  await expect(
    page.getByRole("heading", { name: "Foods", exact: true }),
  ).toBeVisible();

  // Coming back to the app reloads too, unless a dialog is open: then a
  // toast offers it.
  await call(page, "GET", "/meta");
  await page.evaluate(() => {
    window.unreloaded = true;
    const d = document.createElement("dialog");
    document.body.append(d);
    d.showModal();
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(page.locator("#toast")).toContainText("Updated");
  expect(await reloaded(page)).toBe(false);
  await page.evaluate(() => {
    document.querySelector("dialog[open]").close();
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(() => reloaded(page)).toBe(true);
  // The reloaded page's reads may still be in the route: nobody waits.
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("charts_failed_says_so: a chart library that won't load says Reload", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag } = unique(1041, testInfo);
  const f = await food(request, {
    name: `Oats ${tag}`,
    per100: { energy: 380 },
  });
  await entry(request, { day, group: "Eaten", food_id: f.id, grams: 50 });
  await page.route("**/vendor/chart.umd.min.js", (route) =>
    route.fulfill({ status: 404, body: "" }),
  );
  await page.goto(`/#/summary/week/${day}`);
  await expect(page.getByText("Charts didn't load.").first()).toBeVisible();
  await expect(page.locator("#app canvas")).toHaveCount(0);
});

test("lww_pinned: a queued day write replayed after another device's wins", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(1069, testInfo);
  const day = yesterday();
  const pid = await ownProfile(page, request, `Last ${tag}`);
  const path = `/profiles/${pid}/notes/${day}`;
  await page.goto(`/#/day/${day}`);
  // This device can't reach the note (any replay waits) until let through.
  let reachable = false;
  await page.route(`**/api${path}`, (route) =>
    reachable ? route.continue() : route.abort(),
  );
  expect(
    (await call(page, "PUT", path, { text: "phone" }, { queue: true })).code,
  ).toBe("queued");
  // Another device saves the day's note meanwhile.
  expect(
    (await request.put(`/api${path}`, { data: { text: "desktop" } })).ok(),
  ).toBe(true);
  // Last write wins (ADR 0008): the replay, sent last, is what the day keeps.
  reachable = true;
  await flush(page);
  await expect.poll(() => outbox(page)).toEqual([]);
  expect((await dayOf(request, pid, day)).note).toBe("phone");
});
