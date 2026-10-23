// Pull to refresh on a phone (web/pull.mjs, web/refresh.mjs), as real
// touches through CDP: from the top of a screen, down past the threshold.

import { devices, expect, test } from "@playwright/test";
import { food, ownProfile, unique } from "./helpers.js";

// One finger from (x, y) moved by (dx, dy) in ten steps; `fingers` 2 puts
// a second one 100 px to its right.
async function drag(page, { x = 200, y = 150, dx = 0, dy = 300, fingers = 1 }) {
  const cdp = await page.context().newCDPSession(page);
  const t0 = 1_800_000_000;
  const at = (i) =>
    Array.from({ length: fingers }, (_, id) => ({
      x: x + id * 100 + (dx * i) / 10,
      y: y + (dy * i) / 10,
      id,
    }));
  const send = (type, touchPoints, i) =>
    cdp.send("Input.dispatchTouchEvent", {
      type,
      touchPoints,
      timestamp: t0 + i * 0.03,
    });
  await send("touchStart", at(0), 0);
  for (let i = 1; i <= 10; i += 1) await send("touchMove", at(i), i);
  await send("touchEnd", [], 10);
  await cdp.detach();
}

const toast = (page) => page.locator("#toast");
const clearToast = (page) =>
  page.evaluate(() => {
    const t = document.querySelector("#toast");
    t.hidden = true;
    t.textContent = "";
  });

// `api()` from inside the page, as a screen calls it.
const call = (page, ...args) =>
  page.evaluate(async (a) => {
    const main = document.querySelector('script[type="module"]').src;
    const { api } = await import(new URL("api.mjs", main));
    try {
      return { data: await api(...a) };
    } catch (err) {
      return { code: err.code };
    }
  }, args);

const outbox = (page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem("outbox") ?? "[]"));

test.skip(({ isMobile }) => !isMobile, "touch only");

test("a pull sends what waits, re-reads the screen and says so", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag } = unique(768, testInfo);
  const pid = await ownProfile(page, request, `Pull ${tag}`);
  const [oats, rye] = await Promise.all(
    ["Oats", "Rye"].map((n) =>
      food(request, { name: `${n} ${tag}`, per100: { energy: 380 } }),
    ),
  );
  const body = (f, uid) => ({
    uid,
    day,
    group: "Eaten",
    food_id: f.id,
    grams: 50,
  });
  await page.goto(`/#/day/${day}`);
  await expect(page.getByRole("heading", { name: "Eaten" })).toBeVisible();

  // Oats waits in the outbox (writes fail as if offline) ...
  const entries = `**/api/profiles/${pid}/entries`;
  await page.route(entries, (r) => r.abort("internetdisconnected"));
  const path = `/profiles/${pid}/entries`;
  expect(
    await call(page, "POST", path, body(oats, crypto.randomUUID()), {
      queue: true,
      label: "Oats",
    }),
  ).toEqual({ code: "queued" });
  await page.unroute(entries);
  // ... and Rye is logged elsewhere meanwhile.
  const res = await request.post(`/api${path}`, {
    data: body(rye, crypto.randomUUID()),
  });
  expect(res.ok()).toBeTruthy();
  await expect(page.getByText(`Rye ${tag}`)).toHaveCount(0);

  await drag(page, {});
  await expect(toast(page)).toHaveText("Updated");
  expect(await outbox(page)).toEqual([]);
  await expect(page.getByText(`Oats ${tag}`)).toBeVisible();
  await expect(page.getByText(`Rye ${tag}`)).toBeVisible();
  expect(await page.evaluate(() => scrollY)).toBe(0);
  await expect(page.locator("#pull")).not.toHaveClass(/refreshing/u);
});

test("short, sideways, two-finger, scrolled-down or in-dialog drags don't refresh", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag } = unique(769, testInfo);
  await ownProfile(page, request, `No pull ${tag}`);
  await page.goto(`/#/day/${day}`);
  await expect(page.getByRole("heading", { name: "Eaten" })).toBeVisible();
  const quiet = async (what) => {
    await page.waitForTimeout(400);
    await expect(toast(page), what).toBeHidden();
  };

  await drag(page, { dy: 80 });
  await quiet("short of the threshold");
  await drag(page, { dy: 160 });
  await quiet("still short of it");
  await drag(page, { dx: 160, dy: 60 });
  await quiet("sideways");
  await drag(page, { fingers: 2 });
  await quiet("two fingers");

  await page.evaluate(() => scrollTo(0, 300));
  expect(await page.evaluate(() => scrollY)).toBeGreaterThan(0);
  await drag(page, {});
  await quiet("scrolled down");
  await page.evaluate(() => scrollTo(0, 0));

  await page.evaluate(() => {
    const d = document.createElement("dialog");
    d.textContent = "A dialog";
    document.body.append(d);
    d.showModal();
  });
  await drag(page, {});
  await quiet("a dialog open");
});

test("the spinner, refreshing, sits clear of the screen's title", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag } = unique(1143, testInfo);
  await ownProfile(page, request, `Held pull ${tag}`);
  await page.goto(`/#/day/${day}`);
  await expect(page.getByRole("heading", { name: "Eaten" })).toBeVisible();
  let release;
  const held = new Promise((r) => {
    release = r;
  });
  await page.route("**/api/**", async (r) => {
    await held;
    await r.continue();
  });
  await drag(page, {});
  const spinner = page.locator("#pull");
  await expect(spinner).toHaveClass(/refreshing/u);
  // The spinner's travel and the page's room for it settled.
  await page.waitForTimeout(400);
  const a = await spinner.boundingBox();
  const b = await page.locator(".day-nav h1").boundingBox();
  release();
  expect(
    a.y + a.height <= b.y || b.y + b.height <= a.y,
    JSON.stringify({ spinner: a, title: b }),
  ).toBe(true);
  await expect(toast(page)).toHaveText("Updated");
});

test.describe("in the Android app", () => {
  test.use({
    userAgent: `${devices["Pixel 5"].userAgent} KaloriinaAndroid/1`,
  });

  // The app's WebView takes `kaloriina-app://` addresses itself, so the page
  // never leaves (MainActivity's shouldOverrideUrlLoading): here too, each
  // kept in `asked`. Chromium would start a navigation instead, and under
  // load it dropped the next drag's touchend.
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      window.asked = [];
      navigation.addEventListener("navigate", (e) => {
        if (!e.destination.url.startsWith("kaloriina-app:")) return;
        window.asked.push(e.destination.url);
        e.preventDefault();
      });
    });
  });

  // The app's answer, as its evaluateJavascript sends it, until the page
  // shows one (the page listens once its outbox is sent).
  const answer = (page, detail) =>
    expect
      .poll(async () => {
        await page.evaluate(
          (d) =>
            dispatchEvent(new CustomEvent("kaloriina-sync", { detail: d })),
          detail,
        );
        return toast(page).isVisible();
      })
      .toBe(true);

  test("a pull waits for the phone's Health Connect sync and says how it went", async ({
    page,
    request,
  }, testInfo) => {
    const { day, tag } = unique(770, testInfo);
    await ownProfile(page, request, `App pull ${tag}`);
    await page.goto(`/#/day/${day}`);
    await expect(page.getByRole("heading", { name: "Eaten" })).toBeVisible();

    await drag(page, {});
    await answer(page, { synced: true });
    await expect(toast(page)).toHaveText("Synced");
    expect(await page.evaluate(() => window.asked)).toEqual([
      "kaloriina-app://sync",
    ]);
    await expect(page.locator("#app")).toBeVisible();

    await clearToast(page);
    await drag(page, {});
    const error = 'Health Connect access not granted: open Settings ("Steps")';
    await answer(page, { error });
    await expect(toast(page)).toContainText(error);
    await expect(toast(page)).toHaveAttribute("role", "alert");
  });
});

test("every tab's screen refreshes", async ({ page, request }, testInfo) => {
  const { tag } = unique(771, testInfo);
  await ownProfile(page, request, `Tabs pull ${tag}`);
  for (const hash of [
    "#/",
    "#/summary",
    "#/activity",
    "#/foods",
    "#/profile",
  ]) {
    await page.goto(`/${hash}`);
    await expect(page.locator("#app h1")).toBeVisible();
    await expect(page.locator("#app")).not.toHaveAttribute("inert");
    await clearToast(page);
    // From the title: a screen's controls (Foods' search) own their touches.
    const title = await page.locator("#app h1").boundingBox();
    await drag(page, { y: title.y + title.height / 2 });
    await expect(toast(page), hash).toHaveText("Updated");
  }
});
