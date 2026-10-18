// Every stat tile is {value, short, long} (web/tiles.mjs `tiles`): the
// short line under the value, the long one its tooltip (web/tips.mjs) and
// description (aria-describedby), shown on hover and keyboard focus on a
// desktop, above the tile on a tap on a phone.

import { expect, test } from "@playwright/test";
import { entry, food, ownProfile, syncHealth, unique } from "./helpers.js";

// September 2026, over: every Summary subtab has whole days.
const MONTH = "2026-09-01";
const days = ["2026-09-07", "2026-09-08", "2026-09-09"];

// A profile with a little of everything the tiles count: food, weigh-ins,
// an activity, device days with steps, sleep and heart, a check-in.
async function seeded(page, request, tag) {
  const pid = await ownProfile(page, request, `Tiles ${tag}`);
  const f = await food(request, {
    name: `Stew ${tag}`,
    per100: { energy: 150, protein: 8, carbs: 15, fat: 5, water: 70 },
  });
  for (const [i, day] of days.entries()) {
    await entry(
      request,
      { day, group: "Eaten", food_id: f.id, grams: 900 + i * 100 },
      pid,
    );
    await request.put(`/api/profiles/${pid}/weights/${day}`, {
      data: { kg: 60 - i * 0.2 },
    });
    await request.put(`/api/profiles/${pid}/check-ins/${day}`, {
      data: { mood: 3 + (i % 2), tags: [] },
    });
  }
  const res = await request.post(`/api/profiles/${pid}/activities`, {
    data: {
      day: days[1],
      type: "run",
      name: "Running",
      minutes: 30,
      distance_m: 5000,
      sets: [],
    },
  });
  expect(res.status()).toBe(201);
  const synced = await syncHealth(request, pid, {
    from: days[0],
    to: days.at(-1),
    device: "Pixel 9",
    days: days.map((day, i) => ({
      day,
      steps: 8000 + i * 1000,
      active_kcal: 400,
      resting_hr: 55 + i,
      hrv_ms: 45,
      avg_hr: 70,
      min_hr: 50,
      max_hr: 140,
      bedtime: "23:00",
      wake_time: "07:00",
      asleep_min: 450,
    })),
  });
  expect(synced.status()).toBe(200);
  return pid;
}

// Fails the test on an error the page logs or throws (a tile without its
// long text logs one).
function trapErrors(page) {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  return errors;
}

// Each tile on the page: its description's text, "" when it has none, and
// how many elements carry that id.
const described = (page) =>
  page.locator("ul.tiles > li").evaluateAll((items) =>
    items.map((li) => {
      const id = li.querySelector(".tile")?.getAttribute("aria-describedby");
      const found = id ? document.querySelectorAll(`[id="${id}"]`) : [];
      return {
        tile: li.querySelector(".tile-value")?.textContent ?? li.textContent,
        long: found[0]?.textContent.trim() ?? "",
        ids: found.length,
      };
    }),
  );

test("every tile on every screen explains itself", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(64, testInfo);
  await seeded(page, request, tag);
  const errors = trapErrors(page);
  for (const route of [
    `#/summary/food/month/${MONTH}`,
    `#/summary/body/month/${MONTH}`,
    `#/summary/activity/month/${MONTH}`,
    `#/summary/habits/month/${MONTH}`,
    `#/summary/activity/week/${days[0]}`,
    "#/stats",
    "#/targets",
  ]) {
    // A fresh page each: the screen left stays shown while the next loads.
    await page.goto(`/${route}`);
    await page.reload();
    await expect(page.locator("ul.tiles").first()).toBeVisible();
    const tiles = await described(page);
    expect(tiles.length, route).toBeGreaterThan(0);
    for (const t of tiles) {
      expect(t.long, `${route}: ${t.tile}`).not.toBe("");
      expect(t.ids, `${route}: ${t.tile}`).toBe(1);
    }
  }
  expect(errors).toEqual([]);
});

test("a desktop tile shows its long text on hover and focus, Esc hides it", async ({
  page,
  request,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "chromium",
    "Hover is a pointer's: the phone's tap is the next test",
  );
  const { tag } = unique(62, testInfo);
  await seeded(page, request, tag);
  await page.goto(`/#/summary/activity/month/${MONTH}`);
  const items = page.getByRole("list", { name: "Activities" }).locator("li");
  const first = items.first();
  const tip = first.getByRole("tooltip");
  await expect(tip).toBeHidden();
  await first.getByRole("button").hover();
  await expect(tip).toBeVisible();
  // Its description is the tooltip's text.
  await expect(first.getByRole("button")).toHaveAccessibleDescription(
    (await tip.textContent()).trim(),
  );
  // Over the tip itself it stays (no gap to cross).
  await tip.hover();
  await expect(tip).toBeVisible();
  // Esc dismisses it while the pointer is still there.
  await page.keyboard.press("Escape");
  await expect(tip).toBeHidden();
  await page.mouse.move(0, 0);
  await expect(tip).toBeHidden();
  // Keyboard focus shows it too.
  await page.keyboard.press("Tab");
  await first.getByRole("button").focus();
  await expect(tip).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(tip).toBeHidden();
  // Hovering another shows that one alone.
  await items.nth(1).getByRole("button").hover();
  await expect(items.nth(1).getByRole("tooltip")).toBeVisible();
});

test("a phone tile shows its long text above it on a tap, one at a time", async ({
  page,
  request,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "mobile-chromium",
    "A tap is a phone's: the desktop's hover is the test before",
  );
  const { tag } = unique(63, testInfo);
  await seeded(page, request, tag);
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto(`/#/summary/activity/month/${MONTH}`);
  const items = page.getByRole("list", { name: "Activities" }).locator("li");
  const [a, b] = [items.nth(0), items.nth(1)];
  await a.getByRole("button").tap();
  await expect(a.getByRole("tooltip")).toBeVisible();
  // Above the tile (a thumb covers what is under the touch), on the screen.
  const box = await a.getByRole("tooltip").boundingBox();
  const tile = await a.boundingBox();
  expect(box.y + box.height).toBeLessThanOrEqual(tile.y + 0.5);
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(320);
  // Another tap on it closes it.
  await a.getByRole("button").tap();
  await expect(a.getByRole("tooltip")).toBeHidden();
  // One at a time.
  await a.getByRole("button").tap();
  await b.getByRole("button").tap();
  await expect(a.getByRole("tooltip")).toBeHidden();
  await expect(b.getByRole("tooltip")).toBeVisible();
  // A tap outside closes it.
  await page.getByRole("heading", { name: "Activities" }).tap();
  await expect(b.getByRole("tooltip")).toBeHidden();
});
