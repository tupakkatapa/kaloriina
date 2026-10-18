// A nutrient bar's eaten and planned amounts are its tooltip (web/tips.mjs):
// a phone shows it on a tap, above the bar, clear of the thumb (a native
// title never shows on a phone); a desktop on hover or keyboard focus.

import { expect, test } from "@playwright/test";
import { entry, food, ownProfile, unique } from "./helpers.js";

const DAY = "2026-09-08";

async function day(page, request, tag) {
  const pid = await ownProfile(page, request, `Bars ${tag}`);
  const f = await food(request, {
    name: `Rice ${tag}`,
    per100: { energy: 130, protein: 3, carbs: 28, fat: 0.3 },
  });
  await entry(
    request,
    { day: DAY, group: "Eaten", food_id: f.id, grams: 500 },
    pid,
  );
  await entry(
    request,
    { day: DAY, group: "Planned", food_id: f.id, grams: 300 },
    pid,
  );
  await page.goto(`/#/day/${DAY}`);
  return page.locator(".targets-page:not([inert]) .target.k-energy");
}

const words = [
  /^Eaten 650\skcal$/u,
  /^Planned 390\skcal · 1,040\skcal with planned$/u,
];

test("a tap on a bar shows what is eaten and planned above it", async ({
  page,
  request,
}, testInfo) => {
  test.skip(!testInfo.project.use.isMobile, "A tap is a phone's");
  const { tag } = unique(78, testInfo);
  const energy = await day(page, request, tag);
  const bar = energy.getByRole("img", { name: /^Energy:/u });
  const tip = energy.getByRole("tooltip");
  await expect(tip).toBeHidden();
  await bar.tap();
  await expect(tip).toBeVisible();
  await expect(tip.locator("span")).toHaveText(words);
  const t = await tip.boundingBox();
  const b = await bar.boundingBox();
  expect(t.y + t.height).toBeLessThanOrEqual(b.y + 0.5);
  // Its words are the bar's description too.
  await expect(bar).toHaveAccessibleDescription(/^Eaten 650\skcal/u);
  await page.getByRole("heading", { name: "Eaten" }).tap();
  await expect(tip).toBeHidden();
});

test("a desktop bar shows its amounts on hover and keyboard focus", async ({
  page,
  request,
}, testInfo) => {
  test.skip(testInfo.project.use.isMobile, "Hover is a pointer's");
  const { tag } = unique(79, testInfo);
  const energy = await day(page, request, tag);
  const bar = energy.getByRole("img", { name: /^Energy:/u });
  const tip = energy.getByRole("tooltip");
  await bar.hover();
  await expect(tip.locator("span")).toHaveText(words);
  await page.mouse.move(0, 0);
  await expect(tip).toBeHidden();
  await page.keyboard.press("Tab");
  await bar.focus();
  await expect(tip).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(tip).toBeHidden();
});
