// Water: the Water row atop the Add screen's list, the Water habit, Profile →
// Habits' water food, and water in ml or L everywhere. Every test works on a
// profile of its own.

import { expect, test } from "@playwright/test";
import { expectPartsWhole, food, ownProfile, unique } from "./helpers.js";

// A number and its unit as the app writes them (a no-break space).
const words = (text) =>
  new RegExp(
    `^${text.replaceAll(/[().+]/gu, "\\$&").replaceAll(" ", "\\s")}$`,
    "u",
  );

const KEPT = "Saved in this browser; it's sent when you're back online";

// Writes fail as if offline; reads go through.
const fail = (route) =>
  route.request().method() === "GET" ? route.fallback() : route.abort();

const dayOf = async (request, pid, day) =>
  (await request.get(`/api/profiles/${pid}/day/${day}`)).json();

// The day's eaten entries, as [name, grams].
const eaten = async (request, pid, day) =>
  (await dayOf(request, pid, day)).groups
    .filter((g) => g.name === "Eaten")
    .flatMap((g) => g.entries)
    .map((e) => [e.name, e.grams]);

const card = (page) =>
  page.locator(".group", {
    has: page.getByRole("heading", { name: "Log", exact: true }),
  });

// Eaten's foot: what the day's food held, Hydration first.
const totals = (page) =>
  page.getByRole("list", { name: "Day's totals from food" });

// Send the outbox now, through the page's own api.mjs (beside its main.mjs,
// versioned or not).
const flush = (page) =>
  page.evaluate(async () => {
    const main = document.querySelector('script[type="module"]').src;
    return (await import(new URL("api.mjs", main))).flush();
  });

// The Add screen's Water row, first in its list.
const waterRow = (page) =>
  page
    .locator(".finder-results > ul")
    .getByRole("button", { name: /^Water\b/u });

async function addWater(page, ml) {
  await waterRow(page).click();
  const dialog = page.getByRole("dialog", { name: "Water to Eaten" });
  await expect(dialog.getByLabel("Amount (ml)")).toBeFocused();
  await dialog.getByLabel("Amount (ml)").fill(String(ml));
  await dialog.getByRole("button", { name: "Add" }).click();
  await expect(dialog).toBeHidden();
}

test("Water asks ml, logs the water food to the group, and Undo takes it back", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag } = unique(610, testInfo);
  const pid = await ownProfile(page, request, `Drinks ${tag}`);
  await page.goto(`/#/add/${day}/Eaten`);
  // A row atop the list, not a button in the title bar.
  await expect(page.locator("header.title").getByRole("button")).toHaveCount(0);
  await expect(
    page.locator(".finder-results .results").first().locator("li").first(),
  ).toContainText("Water");
  await waterRow(page).click();
  const dialog = page.getByRole("dialog", { name: "Water to Eaten" });
  const ml = dialog.getByLabel("Amount (ml)");
  // Empty by default, required, and bounded by the served limits.
  await expect(ml).toHaveValue("");
  await expect(ml).toHaveAttribute("min", "1");
  await expect(ml).toHaveAttribute("max", "5000");
  await dialog.getByRole("button", { name: "Add" }).click();
  await expect(dialog).toBeVisible();
  await ml.fill("6000");
  await dialog.getByRole("button", { name: "Add" }).click();
  await expect(dialog).toBeVisible();
  expect(await eaten(request, pid, day)).toEqual([]);
  // Cancel logs nothing.
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  expect(await eaten(request, pid, day)).toEqual([]);

  await addWater(page, 330);
  await expect(page).toHaveURL(new RegExp(`#/day/${day}$`, "u"));
  const toast = page.locator("#toast");
  await expect(toast).toContainText("Added Water 330 ml to Eaten");
  expect(await eaten(request, pid, day)).toEqual([["Water", 330]]);
  // Eaten's totals say how much water the day held, against the
  // profile's recommended 2 L.
  await expect(totals(page).locator(".hydration .name")).toHaveText(
    words("330 ml of 2 L"),
  );

  await toast.getByRole("button", { name: "Undo" }).click();
  await expect
    .poll(async () => (await eaten(request, pid, day)).length)
    .toBe(0);

  // Only the group's Add screen has it, not the Foods tab.
  await page.goto("/#/foods");
  await expect(page.getByLabel("Search foods")).toBeVisible();
  await expect(waterRow(page)).toHaveCount(0);
});

test("Water made while writes fail waits on its day, then is stored once", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag } = unique(611, testInfo);
  const pid = await ownProfile(page, request, `Offline ${tag}`);
  await page.goto(`/#/add/${day}/Eaten`);
  await expect(waterRow(page)).toBeVisible();
  const glob = `**/api/profiles/${pid}/entries`;
  await page.route(glob, fail);
  await addWater(page, 500);
  await expect(page).toHaveURL(new RegExp(`#/day/${day}$`, "u"));
  await expect(page.locator("#toast")).toHaveText(KEPT);
  // In its group, said not counted yet; not again at the bottom.
  const waiting = page
    .locator(".group", { has: page.getByRole("heading", { name: "Eaten" }) })
    .locator(".entry", { hasText: "Waiting to send" });
  await expect(waiting).toHaveText([
    /^Water 500\sml\s*Waiting to send · not counted yet$/u,
  ]);
  await expect(
    page.getByRole("heading", { name: "Waiting to send" }),
  ).toHaveCount(0);
  expect(await eaten(request, pid, day)).toEqual([]);

  await page.unroute(glob, fail);
  await flush(page);
  await expect(waiting).toHaveCount(0);
  expect(await eaten(request, pid, day)).toEqual([["Water", 500]]);
  // Sent again (a lost answer), it's still stored once.
  await flush(page);
  expect(await eaten(request, pid, day)).toEqual([["Water", 500]]);
});

test("Profile → Habits picks the water food + Water logs, and goes back to the default", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag } = unique(612, testInfo);
  const pid = await ownProfile(page, request, `Picky ${tag}`);
  await food(request, {
    name: `Spring water ${tag}`,
    per100: { water: 99.8, energy: 0 },
  });
  await page.goto("/#/habits");
  const section = page.locator(".water-food");
  await expect(
    section.getByRole("heading", { name: "Water food" }),
  ).toBeVisible();
  await expect(section.locator(".water-food-current")).toHaveText(
    "Water (default)",
  );
  await expect(
    section.getByRole("button", { name: "Use the default" }),
  ).toHaveCount(0);
  await section.getByLabel("Water food").fill(`Spring water ${tag}`);
  await section
    .getByRole("button", { name: new RegExp(`^Spring water ${tag}`, "u") })
    .click();
  await expect(section.locator(".water-food-current")).toHaveText(
    `Spring water ${tag}`,
  );
  await expect(page.locator("#toast")).toContainText(
    `Water now logs Spring water ${tag}`,
  );

  // The pick is the profile's: the Add screen logs it.
  await page.goto(`/#/add/${day}/Eaten`);
  await addWater(page, 250);
  await expect(page.locator("#toast")).toContainText(
    "Added Water 250 ml to Eaten",
  );
  expect(await eaten(request, pid, day)).toEqual([
    [`Spring water ${tag}`, 250],
  ]);

  await page.goto("/#/habits");
  await section.getByRole("button", { name: "Use the default" }).click();
  await expect(section.locator(".water-food-current")).toHaveText(
    "Water (default)",
  );
  const saved = await (
    await request.get(`/api/profiles/${pid}/water-food`)
  ).json();
  expect(saved).toMatchObject({ chosen: false, food: { name: "Water" } });
});

test("the Hydration habit: Eaten's totals line and the Summary calendar, shaded against the target", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag } = unique(613, testInfo);
  const pid = await ownProfile(page, request, `Hydrated ${tag}`);
  // The day is yesterday: a calendar leaves days after today plain.
  await page.clock.setFixedTime(new Date(`${day}T12:00:00Z`).getTime() + 864e5);
  const drink = await food(request, {
    name: `Juice ${tag}`,
    per100: { energy: 40, water: 95, alcohol: 1.2 },
  });
  // 2000 g: 1.9 L of water and 24 g of alcohol (2 drinks), eaten: the
  // alcohol takes back 240 ml, 1.66 L hydrates; planned water doesn't count.
  const log = (group, grams) =>
    request.post(`/api/profiles/${pid}/entries`, {
      data: { day, group, food_id: drink.id, grams },
    });
  expect((await log("Eaten", 2000)).ok()).toBeTruthy();
  expect((await log("Planned", 1000)).ok()).toBeTruthy();
  await page.goto(`/#/day/${day}`);
  await expect(totals(page).locator(".habit-builtins")).toHaveText(
    words("Alcohol 2 drinks"),
  );
  await expect(totals(page).locator(".hydration .name")).toHaveText(
    words("1.7 L of 2 L"),
  );

  // The profile's recommended 2 L target ("at least"): 1.7 L is under it.
  const month = `/#/summary/habits/month/${day.slice(0, 8)}01`;
  await page.goto(month);
  // Hydration is the habit shown first.
  const water = page.locator(".habits-summary .habit-water");
  const legend = water.locator(".habit-legend");
  const cell = water.locator(`.habit-cal td[data-day="${day}"]`);
  await expect(cell).toHaveClass(/\bshade-3\b/u);
  await expect(cell.getByRole("link")).toHaveAccessibleName(/: 1\.7\sL$/u);
  // Shaded against the day's goal, which grows with activity: the key
  // says how far toward it, not the plain target's litres.
  await expect(legend).toContainText("the day's goal met");
  await expect(water.getByRole("list", { name: "Hydration" })).toContainText(
    /1\.7\sL a day/u,
  );

  // A 1.6 L target is reached: the darkest step, never "over".
  const targets = async (list) => {
    const p = await (await request.get(`/api/profiles/${pid}`)).json();
    const res = await request.put(`/api/profiles/${pid}/targets`, {
      data: { rev: p.rev, targets: list },
    });
    expect(res.ok()).toBeTruthy();
  };
  await targets([{ metric: "water", value: 1600 }]);
  await page.reload();
  await expect(cell).toHaveClass(/\bshade-4\b/u);
  await expect(legend).toContainText("the day's goal met");
  await expect(legend).not.toContainText("over your limit");
  await expect(water.locator(".cal-cell.over")).toHaveCount(0);

  // No target: fixed steps (≤ 1 L / 1–1.5 L / 1.5–2 L / > 2 L).
  await targets([]);
  await page.reload();
  await expect(cell).toHaveClass(/\bshade-3\b/u);
  await expect(legend).toContainText(/1–1\.5\sL/u);
  await expect(legend).not.toContainText("(target)");
});

test("Eaten's Hydration row is its value only", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag } = unique(813, testInfo);
  const pid = await ownProfile(page, request, `Hydration ${tag}`);
  const base = `/api/profiles/${pid}`;
  const { rev } = await (await request.get(base)).json();
  await request.put(`${base}/targets`, {
    data: {
      rev,
      targets: [
        { metric: "water", value: 2000 },
        { metric: "sodium", value: 2000 },
        { metric: "potassium", value: 3500 },
      ],
    },
  });
  const drink = await food(request, {
    name: `Broth ${tag}`,
    per100: { water: 90, sodium: 40, potassium: 50 },
  });
  await request.post(`${base}/entries`, {
    data: { day, group: "Eaten", food_id: drink.id, grams: 500 },
  });
  // An hour's run: the day's goal is 0.5 L more.
  await request.post(`${base}/activities`, {
    data: { day, name: "Run", minutes: 60, type: "run" },
  });
  await page.goto(`/#/day/${day}`);
  // The value only, the goal's activity part included; no
  // disclosure, no "Approximate", no + Water. Salt is From food's.
  const row = totals(page).locator(".log-row", {
    has: page.locator(".hydration"),
  });
  // Why the day's goal isn't the target, on the row.
  await expect(row.locator(".hydration")).toHaveText(
    words("450 ml of 2.5 L (2 L + activity)"),
  );
  await expect(totals(page).locator("details")).toHaveCount(0);
  await expect(row.getByRole("button")).toHaveCount(0);
  await expect(totals(page)).not.toContainText("Approximate");
  await expect(totals(page).locator(".habit-builtins")).toContainText(
    words("Salt 0.5 g"),
  );
});

test("Water offers the last amount and 250 / 500 ml", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag } = unique(804, testInfo);
  const pid = await ownProfile(page, request, `Chips ${tag}`);
  await page.goto(`/#/add/${day}/Eaten`);
  await waterRow(page).click();
  const dialog = page.getByRole("dialog", { name: "Water to Eaten" });
  const ml = dialog.getByLabel("Amount (ml)");
  await dialog.getByRole("button", { name: "500 ml" }).click();
  await expect(ml).toHaveValue("500");
  await dialog.getByRole("button", { name: "250 ml" }).click();
  await expect(ml).toHaveValue("250");
  await dialog.getByRole("button", { name: "Add" }).click();
  await expect(dialog).toBeHidden();
  expect(await eaten(request, pid, day)).toEqual([["Water", 250]]);
  // Next time, the last amount is filled in.
  await page.goto(`/#/add/${day}/Eaten`);
  await waterRow(page).click();
  await expect(ml).toHaveValue("250");
});

test("+ Log has Water, and water reads in ml or L everywhere", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag } = unique(901, testInfo);
  const pid = await ownProfile(page, request, `Sheet ${tag}`);
  await page.goto(`/#/day/${day}`);
  const fromSheet = async (ml) => {
    await card(page)
      .getByRole("button", { name: /^Log on /u })
      .click();
    const sheet = page.getByRole("dialog", { name: "Log" });
    await sheet.getByRole("button", { name: /^Hydration\b/u }).click();
    await expect(sheet).toBeHidden();
    const dialog = page.getByRole("dialog", { name: "Water to Eaten" });
    await dialog.getByLabel("Amount (ml)").fill(String(ml));
    await dialog.getByRole("button", { name: "Add" }).click();
    await expect(dialog).toBeHidden();
  };
  await fromSheet(1200);
  const toast = page.locator("#toast");
  await expect(toast).toContainText(/Added Water 1\.2\sL to Eaten/u);
  await fromSheet(330);
  await expect(toast).toContainText(/Added Water 330\sml to Eaten/u);
  expect(await eaten(request, pid, day)).toEqual([
    ["Water", 1200],
    ["Water", 330],
  ]);
  // One unit rule: the entries as Eaten's totals line, never grams.
  const eatenGroup = page.locator(".group", {
    has: page.getByRole("heading", { name: "Eaten" }),
  });
  await expect(eatenGroup.locator(".entry .muted")).toHaveText([
    words("1.2 L"),
    words("330 ml"),
  ]);
  await expect(totals(page).locator(".hydration .name")).toHaveText(
    words("1.5 L of 2 L"),
  );
});

test("Water without a water food leads to Habits to pick one", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag } = unique(965, testInfo);
  const pid = await ownProfile(page, request, `Dry ${tag}`);
  await page.route(`**/api/profiles/${pid}/water-food`, (route) =>
    route.fulfill({ json: { food: null } }),
  );
  await page.goto(`/#/add/${day}/Eaten`);
  await waterRow(page).click();
  const dialog = page.getByRole("dialog", { name: "Water to Eaten" });
  await dialog.getByLabel("Amount (ml)").fill("250");
  await dialog.getByRole("button", { name: "Add" }).click();
  await expect(dialog.getByRole("alert")).toHaveText(
    "No water food yet: pick one in Habits.",
  );
  await dialog.getByRole("link", { name: "Habits" }).click();
  await expect(page).toHaveURL(/#\/habits$/u);
  await expect(page.locator("dialog[open]")).toHaveCount(0);
});

// In US units the limits read, attribute and check alike, each
// rounded inward, so the hint never names a value it refuses.
test("US water: the hint's ends are accepted, past them refused", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag } = unique(1090, testInfo);
  const pid = await ownProfile(page, request, `Ounces ${tag}`);
  await page.addInitScript(() => localStorage.setItem("units", "us"));
  await page.goto(`/#/add/${day}/Eaten`);
  await waterRow(page).click();
  const dialog = page.getByRole("dialog", { name: "Water to Eaten" });
  const oz = dialog.getByLabel("Amount (fl oz)");
  await expect(dialog.getByText(words("0.1–169 fl oz"))).toBeVisible();
  await expect(oz).toHaveAttribute("min", "0.1");
  await expect(oz).toHaveAttribute("max", "169");
  await oz.fill("169.1");
  await dialog.getByRole("button", { name: "Add" }).click();
  await expect(dialog).toBeVisible();
  await oz.fill("169");
  await dialog.getByRole("button", { name: "Add" }).click();
  await expect(dialog).toBeHidden();
  await expect
    .poll(async () => (await eaten(request, pid, day)).map(([, g]) => g))
    .toEqual([expect.closeTo(4998, 0)]);
});

// Hydration's value is three parts, "≥ 402 ml", "of 2.5 L" and "(2 L +
// activity)": at a phone's widths it wraps between them only.
test("Hydration wraps between its parts only on a phone", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag } = unique(1166, testInfo);
  const pid = await ownProfile(page, request, `Hydration parts ${tag}`);
  const base = `/api/profiles/${pid}`;
  const { rev } = await (await request.get(base)).json();
  await request.put(`${base}/targets`, {
    data: { rev, targets: [{ metric: "water", value: 2000 }] },
  });
  for (const [name, per100] of [
    [`Broth ${tag}`, { water: 90 }],
    // No water value, not a drink: the day's hydration is a floor.
    [`Crackers ${tag}`, { energy: 400 }],
  ]) {
    const f = await food(request, { name, per100 });
    await request.post(`${base}/entries`, {
      data: { day, group: "Eaten", food_id: f.id, grams: 450 },
    });
  }
  await request.post(`${base}/activities`, {
    data: { day, name: "Run", minutes: 60, type: "run" },
  });
  await page.goto(`/#/day/${day}`);
  const value = totals(page).locator(".hydration");
  await expect(value).toContainText("activity)");
  await expectPartsWhole(value, (t) =>
    /^(.+?) (of \S+ \S+) (\(.+\))$/u.exec(t).slice(1),
  );
});
