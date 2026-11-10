// A nutrient bar's eaten and planned amounts are its tooltip (web/tips.mjs):
// a phone shows it on a tap, above the bar, clear of the thumb (a native
// title never shows on a phone); a desktop on hover or keyboard focus.

import { expect, test } from "@playwright/test";
import { entry, food, ownProfile, realDay, unique } from "./helpers.js";

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

// A day where 90 % of the food carried iron (targeted) and 50 % fat (no
// target): only the share under KNOWN (80 %) reads "≥"; both tips say it.
async function partial(page, request, slot, testInfo) {
  const { day: date, tag } = unique(slot, testInfo);
  await ownProfile(page, request, `Floor ${tag}`);
  const total = { energy: 2000, protein: 100, iron: 9, fat: 60, sugars: 30 };
  await realDay(page, date, {
    total,
    eaten: total,
    known: { iron: 0.9, fat: 0.5, dry: 400 },
    targets: [
      { metric: "energy", value: 2200, min: 2090, max: 2310 },
      { metric: "protein", value: 120, min: 120, max: null },
      { metric: "iron", value: 11, min: 11, max: null },
    ],
  });
  await page.goto(`/#/day/${date}`);
  await page.locator("details.all-targets > summary").click();
  const row = (name) =>
    page.locator(".target", { has: page.getByText(name, { exact: true }) });
  return {
    iron: row("Iron").last(),
    fat: row("Fat").first(),
    sugars: row("Sugars").first(),
  };
}

const show = (testInfo, el) =>
  testInfo.project.use.isMobile ? el.tap() : el.hover();

test("only a share under 80 % reads ≥; an untargeted floor's track tip says why", async ({
  page,
  request,
}, testInfo) => {
  const { iron, fat } = await partial(page, request, 1229, testInfo);
  await expect(iron.locator(".target-label")).toHaveText(/^Iron9\smg/u);
  await expect(fat.locator(".target-label")).toHaveText(/^Fat≥\s60\sg/u);
  await expect(fat.locator("[title]")).toHaveCount(0);
  const tip = fat.getByRole("tooltip");
  await show(testInfo, fat.locator(".bar"));
  await expect(tip).toContainText(
    /At least: only 50\s%\sof the day's food has a value for it/u,
  );
  await show(testInfo, iron.getByRole("img", { name: /^Iron:/u }));
  await expect(tip).toBeHidden();
  await expect(iron.getByRole("tooltip")).toContainText(
    /At least: only 90\s%\sof the day's food has a value for it/u,
  );
});

test("an untargeted row known in full has no tip and no Tab stop", async ({
  page,
  request,
}, testInfo) => {
  const { sugars } = await partial(page, request, 1220, testInfo);
  await expect(sugars.locator(".target-label")).toHaveText(/^Sugars30\sg/u);
  await expect(sugars.getByRole("tooltip")).toHaveCount(0);
  await expect(sugars.locator(".bar")).not.toHaveAttribute("tabindex");
});
