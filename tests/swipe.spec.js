// Swipes on a phone (web/swipe.mjs), as real touches through CDP with
// fixed timestamps: one finger changes the day, two the Summary subtab.

import { expect, test } from "@playwright/test";
import { ownProfile, unique } from "./helpers.js";

const dayAfter = (day, n) =>
  new Date(Date.parse(day) + n * 864e5).toISOString().slice(0, 10);

// A touch gesture: `fingers` start at their points and move by (dx, 0)
// in five steps over `ms`, with timestamps set (not the clock's).
async function swipe(page, fingers, dx, ms = 200) {
  const cdp = await page.context().newCDPSession(page);
  const t0 = 1_800_000_000;
  const at = (i) =>
    fingers.map(({ x, y }, id) => ({ x: x + (dx * i) / 5, y, id }));
  const send = (type, touchPoints, i) =>
    cdp.send("Input.dispatchTouchEvent", {
      type,
      touchPoints,
      timestamp: t0 + (ms / 1000) * (i / 5),
    });
  await send("touchStart", at(0), 0);
  for (let i = 1; i <= 5; i += 1) await send("touchMove", at(i), i);
  await send("touchEnd", [], 5);
  await cdp.detach();
}

test.skip(({ isMobile }) => !isMobile, "touch only");

test("one finger follows ‹ ›; from an edge or too slow it doesn't", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag } = unique(766, testInfo);
  await ownProfile(page, request, `Swipe ${tag}`);
  await page.goto(`/#/day/${day}`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  const mid = { x: 200, y: 400 };

  await swipe(page, [mid], -120);
  await expect(page).toHaveURL(new RegExp(`#/day/${dayAfter(day, 1)}$`, "u"));
  // The next day loads with the screen inert (a swipe then does nothing,
  // as a tap would): swipe again once it has.
  await expect(page.locator("#app")).not.toHaveAttribute("inert");
  await swipe(page, [mid], 120);
  await expect(page).toHaveURL(new RegExp(`#/day/${day}$`, "u"));
  await expect(page.locator("#app")).not.toHaveAttribute("inert");

  // The system's back strip, and a slow drag: nothing.
  await swipe(page, [{ x: 10, y: 400 }], 150);
  await swipe(page, [mid], -120, 900);
  await page.waitForTimeout(300);
  await expect(page).toHaveURL(new RegExp(`#/day/${day}$`, "u"));
});

test("two fingers change the Summary subtab", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag } = unique(767, testInfo);
  await ownProfile(page, request, `Subtab ${tag}`);
  await page.goto(`/#/summary/food/month/${day}`);
  const current = page.locator('.subtabs [aria-current="page"]');
  await expect(current).toHaveText("Food");
  // On the period's heading: charts below are their own (no swipe).
  const box = await page.locator(".summary .day-nav").boundingBox();
  const y = box.y + box.height / 2;
  const pair = [
    { x: 150, y },
    { x: 250, y },
  ];
  await swipe(page, pair, -120);
  await expect(current).toHaveText("Body");
  await expect(page).toHaveURL(new RegExp(`#/summary/body/month/${day}$`, "u"));
  await swipe(page, pair, 120);
  await expect(current).toHaveText("Food");
});

test("one finger below the content and not on the tab bar", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag } = unique(969, testInfo);
  await ownProfile(page, request, `Below ${tag}`);
  await page.goto(`/#/day/${day}`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  // The strip between the screen's end and the tab bar: the page's, not
  // the screen's (#app).
  const { below, bar } = await page.evaluate(() => {
    const app = document.querySelector("#app").getBoundingClientRect();
    const tabs = document.querySelector(".tabs").getBoundingClientRect();
    return {
      below: (Math.max(app.bottom, 0) + tabs.top) / 2,
      bar: tabs.top + tabs.height / 2,
    };
  });
  expect(
    await page.evaluate(
      (y) =>
        document
          .querySelector("#app")
          .contains(document.elementFromPoint(200, y)),
      below,
    ),
  ).toBe(false);

  await swipe(page, [{ x: 200, y: below }], -120);
  await expect(page).toHaveURL(new RegExp(`#/day/${dayAfter(day, 1)}$`, "u"));
  await expect(page.locator("#app")).not.toHaveAttribute("inert");

  // The tab bar is its own.
  await swipe(page, [{ x: 200, y: bar }], 120);
  await page.waitForTimeout(300);
  await expect(page).toHaveURL(new RegExp(`#/day/${dayAfter(day, 1)}$`, "u"));
});
