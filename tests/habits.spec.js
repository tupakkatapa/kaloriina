// Habits: counting in the diary's Log (card and sheet), Profile → Habits and
// the Summary calendars. Every test counts on a profile of its own (trackers
// are per profile).

import { expect, test } from "@playwright/test";
import {
  answer,
  entry,
  expectPartsWhole,
  fixedToday,
  food,
  ownProfile,
  starts,
  todayInApp,
  unique,
} from "./helpers.js";

// One today for the whole test, in the page and here.
test.beforeEach(({ page }) => fixedToday(page));

// A number and its unit as the app writes them (a no-break space).
const words = (text) =>
  new RegExp(
    `^${text.replaceAll(/[().]/gu, "\\$&").replaceAll(" ", "\\s")}$`,
    "u",
  );

const yesterday = () =>
  new Date(Date.parse(todayInApp()) - 864e5).toISOString().slice(0, 10);

async function tracker(request, pid, data) {
  const res = await request.post(`/api/profiles/${pid}/habits`, {
    data: { unit: "pouches", ...data },
  });
  expect(res.status()).toBe(201);
  return res.json();
}

const count = (request, pid, id, day, amount) =>
  request.put(`/api/profiles/${pid}/habits/${id}/days/${day}`, {
    data: { amount },
  });

const days = async (request, pid, from = "2000-01-01", to = "2100-01-01") =>
  (
    await request.get(`/api/profiles/${pid}/habits/days?from=${from}&to=${to}`)
  ).json();

const card = (page) =>
  page.locator(".group", {
    has: page.getByRole("heading", { name: "Log", exact: true }),
  });

// Eaten's foot: what the day's food held.
const totals = (page) =>
  page.getByRole("list", { name: "Day's totals from food" });

// A food of `per100` logged as eaten on `day`.
async function eat(request, pid, day, per100, grams, tag) {
  const f = await food(request, {
    name: `Drink ${tag} ${Object.keys(per100).join(" ")}`,
    per100: { energy: 40, ...per100 },
  });
  await entry(request, { day, group: "Eaten", food_id: f.id, grams }, pid);
}

test("the + Log sheet counts in place; the Log card then counts too, and sets any amount", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(470, testInfo);
  const pid = await ownProfile(page, request, `Counter ${tag}`);
  const snus = await tracker(request, pid, { name: "Snus" });
  await tracker(request, pid, { name: "Old", archived: true });
  const day = yesterday();
  await page.goto(`/#/day/${day}`);
  const log = card(page);
  // A past day: nothing counted, so no tracker row in the card.
  await expect(log.locator(".habit-row")).toHaveCount(0);
  await log.getByRole("button", { name: /^Log on /u }).click();
  const sheet = page.getByRole("dialog", { name: "Log" });
  // Only the active tracker, at 0; no built-ins in the sheet.
  await expect(sheet.locator(".habit-row")).toHaveCount(1);
  await expect(sheet.locator(".habit-builtins")).toHaveCount(0);
  const less = sheet.getByRole("button", { name: "One less Snus" });
  const more = sheet.getByRole("button", { name: "One more Snus" });
  const amount = sheet.getByRole("button", { name: /^Snus: /u });
  await expect(amount).toHaveText(words("0 pouches"));
  await expect(less).toBeDisabled();

  // In place: the keyboard stays on +, and the day isn't reopened.
  await page.evaluate(() => {
    window.sameScreen = document.querySelector("#app section");
  });
  await more.focus();
  await page.keyboard.press("Enter");
  await expect(amount).toHaveText(words("1 pouches"));
  await page.keyboard.press("Enter");
  await expect(amount).toHaveText(words("2 pouches"));
  await expect(more).toBeFocused();
  expect(
    await page.evaluate(
      () => window.sameScreen === document.querySelector("#app section"),
    ),
  ).toBe(true);
  expect(await days(request, pid)).toEqual([
    { habit: String(snus.id), day, amount: 2, known: true },
  ]);

  // Done: the card shows the count, in place, focus back on + Log.
  await sheet.getByRole("button", { name: "Done" }).click();
  await expect(sheet).toHaveCount(0);
  await expect(log.getByRole("button", { name: /^Log on /u })).toBeFocused();
  expect(
    await page.evaluate(
      () => window.sameScreen === document.querySelector("#app section"),
    ),
  ).toBe(true);
  const cardAmount = log.getByRole("button", { name: /^Snus: /u });
  const cardLess = log.getByRole("button", { name: "One less Snus" });
  await expect(cardAmount).toHaveText(words("2 pouches"));

  // Down to 0 in the card: the day's count goes (the row stays until the
  // day reloads).
  await cardLess.click();
  await expect(cardAmount).toHaveText(words("1 pouches"));
  await cardLess.click();
  await expect(cardAmount).toHaveText(words("0 pouches"));
  await expect(cardLess).toBeDisabled();
  expect(await days(request, pid)).toEqual([]);

  // The count opens a dialog for any amount.
  await cardAmount.click();
  const dialog = page.getByRole("dialog", { name: `Snus on` });
  await dialog.getByLabel("Amount (pouches)").fill("4.5");
  await dialog.getByRole("button", { name: "Set" }).click();
  await expect(dialog).toBeHidden();
  await expect(cardAmount).toHaveText(words("4.5 pouches"));
  expect(await days(request, pid)).toEqual([
    { habit: String(snus.id), day, amount: 4.5, known: true },
  ]);
  // It survives a reload (the Day view carries it); 0 removes it.
  await page.reload();
  await expect(cardAmount).toHaveText(words("4.5 pouches"));
  await cardAmount.click();
  await dialog.getByLabel("Amount (pouches)").fill("0");
  await dialog.getByRole("button", { name: "Set" }).click();
  await expect(cardAmount).toHaveText(words("0 pouches"));
  expect(await days(request, pid)).toEqual([]);
  await page.reload();
  await expect(log).toBeVisible();
  await expect(log.locator(".habit-row")).toHaveCount(0);
});

test("a count on the Log card wraps inside its button at 320 px", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(964, testInfo);
  await page.setViewportSize({ width: 320, height: 800 });
  const pid = await ownProfile(page, request, `Narrow ${tag}`);
  const snus = await tracker(request, pid, { name: "Snus" });
  const day = yesterday();
  await count(request, pid, snus.id, day, 10);
  await page.goto(`/#/day/${day}`);
  const amount = card(page).getByRole("button", { name: /^Snus: /u });
  await expect(amount).toHaveText(words("10 pouches"));
  expect(
    // Within a pixel: widths round.
    await amount.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
  ).toBe(true);
});

test("Eaten's totals show the day's alcohol and caffeine; the Log sheet leads to Profile → Habits", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag } = unique(471, testInfo);
  const pid = await ownProfile(page, request, `Drinker ${tag}`);
  // 240 g: 24 g alcohol (2 drinks) and 240 mg caffeine.
  await eat(request, pid, day, { alcohol: 10, caffeine: 100 }, 240, tag);
  await page.goto(`/#/day/${day}`);
  await expect(totals(page).locator(".habit-builtins")).toHaveText(
    words("Alcohol 2 drinks · Caffeine 240 mg"),
  );
  // One row of its own kind.
  await expect(
    totals(page)
      .locator(".log-row", { has: page.locator(".habit-builtins") })
      .locator(".kind"),
  ).toHaveText("From food");
  await card(page)
    .getByRole("button", { name: /^Log on /u })
    .click();
  await page
    .getByRole("dialog", { name: "Log" })
    .getByRole("link", { name: starts("Manage habits…") })
    .click();
  await expect(page).toHaveURL(/#\/habits$/u);
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // A day with nothing: the card and its hint, no list.
  const empty = new Date(Date.parse(day) + 864e5).toISOString().slice(0, 10);
  await page.goto(`/#/day/${empty}`);
  await expect(card(page)).toBeVisible();
  await expect(card(page)).toContainText("Nothing logged.");
  await expect(card(page).getByRole("list")).toHaveCount(0);
});

test("Profile → Habits adds, edits, archives and deletes a tracker", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(472, testInfo);
  const pid = await ownProfile(page, request, `Keeper ${tag}`);
  await page.goto("/#/profile");
  const row = page.getByRole("link", { name: /^Habits/u });
  await expect(row).toHaveText(/\d+ built-ins and 0 of your own/u);
  await row.click();
  await expect(page.getByRole("heading", { name: "Habits" })).toBeVisible();

  // Add: a name and a unit; the goal is set on Targets.
  await page.getByRole("link", { name: /^New habit/u }).click();
  await page.getByLabel("Name").fill("Snus");
  await page.getByLabel("Unit").fill("pouches");
  await expect(page.locator(".habit-goal")).toHaveText(
    "Goal: none · Set it on Targets once saved",
  );
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page).toHaveURL(/#\/habits$/u);
  await expect(page.getByRole("link", { name: /^Snus/u })).toHaveText(
    /pouches$/u,
  );
  // A goal set elsewhere shows on the list and, read-only, in the editor.
  const [made] = await (
    await request.get(`/api/profiles/${pid}/habits`)
  ).json();
  await request.put(`/api/profiles/${pid}/habits/${made.id}`, {
    data: { ...made, goal_value: 10, goal_dir: "at_least" },
  });
  await page.reload();
  await expect(page.getByRole("link", { name: /^Snus/u })).toHaveText(
    /pouches · at least 10 a day/u,
  );

  // Rename and change the unit: the goal stays.
  await page.getByRole("link", { name: /^Snus/u }).click();
  await expect(page.locator(".habit-goal")).toHaveText(
    "Goal: at least 10 a day · Change on Targets",
  );
  await expect(
    page.getByRole("link", { name: "Change on Targets" }),
  ).toHaveAttribute("href", "#/targets");
  await page.getByLabel("Name").fill("Nicotine");
  await page.getByLabel("Unit").fill("pieces");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.locator("#toast")).toHaveText(/Saved Nicotine/u);
  await expect(page.getByRole("heading", { name: "Nicotine" })).toBeVisible();
  const [saved] = await (
    await request.get(`/api/profiles/${pid}/habits`)
  ).json();
  expect(saved).toMatchObject({
    name: "Nicotine",
    unit: "pieces",
    goal_value: 10,
    goal_dir: "at_least",
    archived: false,
  });

  // A taken name is refused at the name.
  await tracker(request, pid, { name: "Coffee" });
  await page.getByLabel("Name").fill("coffee");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByLabel("Name")).toHaveAttribute("aria-invalid", "true");
  await page.getByLabel("Name").fill("Nicotine");

  // Archive: it leaves the list's top for Archived; and back.
  const archived = async () =>
    (await (await request.get(`/api/profiles/${pid}/habits`)).json()).find(
      (x) => x.id === saved.id,
    ).archived;
  await page
    .getByRole("radiogroup", { name: "Status" })
    .getByRole("radio", { name: "Archived" })
    .click();
  await page.getByRole("button", { name: "Save" }).click();
  await expect.poll(archived).toBe(true);
  await page.getByRole("link", { name: "Back" }).click();
  await expect(page.getByRole("heading", { name: "Archived" })).toBeVisible();
  await page.getByRole("link", { name: /^Nicotine/u }).click();
  await page
    .getByRole("radiogroup", { name: "Status" })
    .getByRole("radio", { name: "Active" })
    .click();
  await page.getByRole("button", { name: "Save" }).click();
  await expect.poll(archived).toBe(false);
  await page.getByRole("link", { name: "Back" }).click();
  await expect(page.getByRole("heading", { name: "Archived" })).toHaveCount(0);

  // Delete: the confirm says how many logged days go with it.
  await count(request, pid, saved.id, yesterday(), 3);
  await count(request, pid, saved.id, todayInApp(), 1);
  await page.getByRole("link", { name: /^Nicotine/u }).click();
  await page.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByRole("dialog")).toContainText(
    "Its 2 logged days go with it.",
  );
  expect(await answer(page, "Delete")).toBe("Delete Nicotine?");
  await expect(page).toHaveURL(/#\/habits$/u);
  await expect(page.getByRole("link", { name: /^Nicotine/u })).toHaveCount(0);
  expect(await days(request, pid)).toEqual([]);
});

test("a stale tracker edit offers Reload", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(473, testInfo);
  const pid = await ownProfile(page, request, `Stale ${tag}`);
  const t = await tracker(request, pid, { name: "Snus" });
  await page.goto(`/#/habit/${t.id}`);
  await page.getByLabel("Unit").fill("cans");
  // Changed elsewhere meanwhile.
  await request.put(`/api/profiles/${pid}/habits/${t.id}`, {
    data: { ...t, name: "Snuff", unit: "pinches" },
  });
  await page.getByRole("button", { name: "Save" }).click();
  await page.getByRole("button", { name: "Reload" }).click();
  await expect(page.getByLabel("Name")).toHaveValue("Snuff");
  await expect(page.getByLabel("Unit")).toHaveValue("pinches");
});

// September 2026: Tue 1 – Wed 30.
const MONTH = "2026-09";

async function calendarSetup(page, request, slot, testInfo) {
  const { tag } = unique(slot, testInfo);
  const pid = await ownProfile(page, request, `Calendar ${tag}`);
  // Alcohol at most 12 g (1 drink), its only target.
  const { rev } = await (await request.get(`/api/profiles/${pid}`)).json();
  const res = await request.put(`/api/profiles/${pid}/targets`, {
    data: { rev, targets: [{ metric: "alcohol", value: 12 }] },
  });
  expect(res.ok()).toBeTruthy();
  // Sat 5th: 2 drinks (over); Sun 6th: half a drink.
  await eat(request, pid, `${MONTH}-05`, { alcohol: 10 }, 240, tag);
  await eat(request, pid, `${MONTH}-06`, { alcohol: 1 }, 600, tag);
  // Thu 10th: food without alcohol, so alcohol's "none" (a built-in's day
  // is logged by its food).
  await eat(request, pid, `${MONTH}-10`, { alcohol: 0 }, 100, tag);
  const snus = await tracker(request, pid, {
    name: "Snus",
    goal_value: 5,
    goal_dir: "at_most",
  });
  // Snus on 4 days of 4 distinct amounts; Sat 12th logs only Snus.
  for (const [d, n] of [
    ["05", 1],
    ["09", 4],
    ["10", 8],
    ["12", 2],
  ])
    await count(request, pid, snus.id, `${MONTH}-${d}`, n);
  return { pid, snus };
}

// The Summary's Habit switch, and one habit picked on it: its numbers,
// calendar and key.
const habitSwitch = (page) => page.getByRole("radiogroup", { name: "Habit" });
async function habitOf(page, name) {
  const radio = habitSwitch(page).getByRole("radio", { name, exact: true });
  await radio.click();
  await expect(radio).toBeChecked();
  return page.locator(".habits-summary .habit");
}
const cellOf = (scope, day) =>
  scope.locator(`.habit-cal td[data-day="${day}"]`);

test("an unknown day is a floor, never a 0: means over the known days (AC2-1)", async ({
  page,
  request,
}, testInfo) => {
  const { pid } = await calendarSetup(page, request, 1002, testInfo);
  // Tue 15th: beer beside a lager without its alcohol set: the beer's 20 g
  // came with 500 of the 900 g that could hold alcohol, so the day's
  // alcohol isn't known (ADR 0030: bread beside it would hold none).
  const { tag } = unique(1002, testInfo);
  await eat(request, pid, `${MONTH}-15`, { alcohol: 4 }, 500, tag);
  const lager = await food(request, {
    name: `Lager 5% ${tag}`,
    per100: { energy: 43 },
    servings: [{ label: "0,33 l can", grams: 330 }],
  });
  await entry(
    request,
    { day: `${MONTH}-15`, group: "Eaten", food_id: lager.id, grams: 400 },
    pid,
  );
  await page.goto(`/#/summary/habits/month/${MONTH}-01`);
  const alcohol = await habitOf(page, "Alcohol");
  await expect(
    alcohol.getByRole("list", { name: "Alcohol" }).locator(".tile"),
  ).toHaveText(
    [
      "5.8 drinks a week",
      "≥ 3 days with any",
      "≥ 2 drinks most in a day (Sat, Sep 5)",
      "≥ 2 days over your limit",
    ].map((x) => words(x)),
  );
  // Which days the mean is over: its long text.
  await expect(
    alcohol.getByRole("list", { name: "Alcohol" }).locator(".tile").first(),
  ).toHaveAccessibleDescription(
    "Your average a week over 3 known days of 4 with food logged.",
  );
  const tue = cellOf(alcohol, `${MONTH}-15`);
  await expect(tue.getByRole("link")).toHaveAccessibleName(
    words("Tue, Sep 15: ≥ 1.7 drinks, not all known, over"),
  );
  await expect(tue).toHaveClass(/\bnone\b/u);
});

test("the month calendar shades, hatches, outlines and links each day", async ({
  page,
  request,
}, testInfo) => {
  const {
    pid,
    snus: { id: snusId },
  } = await calendarSetup(page, request, 474, testInfo);
  // Made after Snus, so after it whatever its name.
  await tracker(request, pid, { name: "Gum" });
  await page.goto(`/#/summary/habits/month/${MONTH}-01`);
  const section = page.locator(".habits-summary");
  // The Habits subtab names it; its heading is for screen readers only.
  await expect(section.getByRole("heading", { name: "Habits" })).toHaveClass(
    "sr-only",
  );
  // One habit at a time: the built-ins with data or a target, then trackers
  // by age.
  await expect(habitSwitch(page).getByRole("radio")).toHaveText([
    "Alcohol",
    "Snus",
    "Gum",
  ]);
  await expect(section.locator(".habit")).toHaveCount(1);
  const alcohol = await habitOf(page, "Alcohol");
  // A Monday-first table with labelled cells.
  const table = alcohol.getByRole("table");
  await expect(table.getByRole("columnheader")).toHaveText([
    "Mon",
    "Tue",
    "Wed",
    "Thu",
    "Fri",
    "Sat",
    "Sun",
  ]);
  const sat = cellOf(alcohol, `${MONTH}-05`);
  await expect(sat.getByRole("link")).toHaveAccessibleName(
    words("Sat, Sep 5: 2 drinks, over"),
  );
  await expect(sat).toHaveClass(/\bshade-2\b/u);
  await expect(sat).toHaveClass(/\bover\b/u);
  await expect(sat).toContainText("2");
  const sun = cellOf(alcohol, `${MONTH}-06`);
  await expect(sun.getByRole("link")).toHaveAccessibleName(
    words("Sun, Sep 6: 0.5 drinks"),
  );
  await expect(sun).toHaveClass(/\bshade-1\b/u);
  await expect(sun).not.toHaveClass(/\bover\b/u);
  // Food logged, no alcohol, reads "none"; no food logged is hatched,
  // Snus or not.
  const thu = cellOf(alcohol, `${MONTH}-10`);
  await expect(thu.getByRole("link")).toHaveAccessibleName("Thu, Sep 10: none");
  await expect(thu).toHaveClass(/\bshade-0\b/u);
  await expect(thu).not.toHaveClass(/\bnone\b/u);
  for (const [d, name] of [
    ["07", "Mon, Sep 7"],
    ["12", "Sat, Sep 12"],
  ]) {
    const unlogged = cellOf(alcohol, `${MONTH}-${d}`);
    await expect(unlogged.getByRole("link")).toHaveAccessibleName(
      `${name}: nothing logged`,
    );
    await expect(unlogged).toHaveClass(/\bnone\b/u);
  }
  await expect(
    alcohol.getByRole("list", { name: "Alcohol" }).locator(".tile"),
  ).toHaveText(
    [
      "5.8 drinks a week",
      "2 days with any",
      "2 drinks most in a day (Sat, Sep 5)",
      "1 day over your limit",
    ].map((x) => words(x)),
  );
  // Over the days with food logged (an unlogged day is missing, not 0).
  await expect(
    alcohol.getByRole("list", { name: "Alcohol" }).locator(".tile").first(),
  ).toHaveAccessibleDescription(
    "Your average a week over 3 days with food logged.",
  );
  await expect(alcohol.locator(".habit-legend li")).toHaveText(
    [
      "0",
      "≤ 1 drinks",
      "1–3 drinks",
      "3–5 drinks",
      "> 5 drinks",
      // One word for empty everywhere.
      "Nothing logged",
      "over your limit",
    ].map((x) => words(x)),
  );
  // What a drink is, under its key alone.
  await expect(alcohol.locator(".habit-legend")).toContainText(
    "A drink is 12 g of alcohol.",
  );

  // Snus: shaded by its own quartiles, outlined over its limit of 5.
  const snus = await habitOf(page, "Snus");
  for (const [d, label, shade] of [
    ["05", "Sat, Sep 5: 1 pouches", "shade-1"],
    ["12", "Sat, Sep 12: 2 pouches", "shade-2"],
    ["09", "Wed, Sep 9: 4 pouches", "shade-3"],
    ["10", "Thu, Sep 10: 8 pouches, over", "shade-4"],
  ]) {
    const c = cellOf(snus, `${MONTH}-${d}`);
    await expect(c.getByRole("link")).toHaveAccessibleName(words(label));
    await expect(c).toHaveClass(new RegExp(`\\b${shade}\\b`, "u"));
  }
  // Its quartiles (1, 2, 4) in the one legend grammar.
  await expect(snus.locator(".habit-legend li").first()).toHaveText("0");
  await expect(snus.locator(".habit-legend")).toContainText(/1–2\spouches/u);
  // The pick is kept on this device.
  expect(await page.evaluate(() => localStorage.getItem("summary-habit"))).toBe(
    String(snusId),
  );
  await expect(await habitOf(page, "Gum")).toContainText("No Gum this month");

  // A key's note is its habit's alone; caffeine (no data, no target) isn't
  // offered.
  await expect(section.getByText(/A drink is 12 g/u)).toHaveCount(0);
  await expect(
    habitSwitch(page).getByRole("radio", { name: "Caffeine" }),
  ).toHaveCount(0);

  // A day opens the Diary.
  await habitOf(page, "Alcohol");
  await cellOf(alcohol, `${MONTH}-05`).getByRole("link").click();
  await expect(page).toHaveURL(new RegExp(`#/day/${MONTH}-05$`, "u"));
});

test("the week is a row of 7; the year 12 months that open", async ({
  page,
  request,
}, testInfo) => {
  await calendarSetup(page, request, 475, testInfo);
  await page.goto(`/#/summary/habits/week/${MONTH}-09`);
  const alcohol = await habitOf(page, "Alcohol");
  await expect(alcohol.getByRole("row")).toHaveCount(2);
  await expect(alcohol.locator("td.cal-cell")).toHaveCount(7);
  await expect(
    cellOf(alcohol, `${MONTH}-10`).getByRole("link"),
  ).toHaveAccessibleName("Thu, Sep 10: none");
  // A built-in is a common noun mid-sentence; a tracker keeps its name.
  await expect(alcohol).toContainText("No alcohol this week");

  await page.goto(`/#/summary/habits/year/${MONTH}-09`);
  // 12 mini months for each habit: Alcohol and Snus.
  for (const name of ["Snus", "Alcohol"])
    await expect((await habitOf(page, name)).getByRole("table")).toHaveCount(
      12,
    );
  // Colour only on screen; words for readers, and no links per day.
  const sat = cellOf(alcohol, `${MONTH}-05`);
  await expect(sat).toHaveText(words("Sat, Sep 5: 2 drinks, over"));
  await expect(sat).toHaveClass(/\bshade-2\b/u);
  await expect(sat.getByRole("link")).toHaveCount(0);
  await expect(alcohol.getByRole("list", { name: "Alcohol" })).toContainText(
    /drinks a week/u,
  );
  await (await habitOf(page, "Snus"))
    .getByRole("link", { name: "Sep", exact: true })
    .click();
  await expect(page).toHaveURL(
    new RegExp(`#/summary/habits/month/${MONTH}-01$`, "u"),
  );
});

test("a fruit entry shows in Eaten's totals, Summary, Targets", async ({
  page,
  request,
}, testInfo) => {
  // A category set in the food editor feeds the built-in.
  const { tag } = unique(840, testInfo);
  const pid = await ownProfile(page, request, `Fruit ${tag}`);
  const apple = await food(request, {
    name: `Apple ${tag}`,
    per100: { energy: 52 },
  });
  await page.goto(`/#/food/${apple.id}`);
  await page
    .getByLabel("Category")
    .selectOption({ label: "Fruit and vegetables" });
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.locator("#toast")).toHaveText(/Saved/u);
  expect(
    (await (await request.get(`/api/foods/${apple.id}`)).json()).category,
  ).toBe("fruit_veg");

  const day = "2026-08-12";
  await entry(
    request,
    { day, group: "Eaten", food_id: apple.id, grams: 300 },
    pid,
  );
  await page.goto(`/#/day/${day}`);
  await expect(totals(page).locator(".habit-builtins")).toHaveText(
    words("Fruit and vegetables 300 g"),
  );

  // Summary: against the recommended 500 g a day, 300 g is over half.
  await page.goto(`/#/summary/habits/month/${day}`);
  const fruit = await habitOf(page, "Fruit and vegetables");
  await expect(cellOf(fruit, day).getByRole("link")).toHaveAccessibleName(
    words("Wed, Aug 12: 300 g"),
  );
  await expect(cellOf(fruit, day)).toHaveClass(/\bshade-2\b/u);

  // Targets: its goal is a Habits row; 250 g a day makes the day a reached one.
  await page.goto("/#/targets");
  const input = page.getByLabel("Fruit and vegetables target");
  await expect(input).toHaveValue("500");
  await input.fill("250");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.locator("#toast")).toHaveText(/Saved/u);
  await page.goto(`/#/summary/habits/month/${day}`);
  const reached = await habitOf(page, "Fruit and vegetables");
  await expect(cellOf(reached, day)).toHaveClass(/\bshade-4\b/u);
  await expect(
    reached.getByRole("list", { name: "Fruit and vegetables" }),
  ).toContainText("1 day at your target");
});

test("creatine from the seeded food", async ({ page, request }, testInfo) => {
  // Slots 920–929 are this plan's; 920 is this test's.
  const { day, tag } = unique(920, testInfo);
  const pid = await ownProfile(page, request, `Creatine ${tag}`);
  const [tub] = await (
    await request.get(`/api/profiles/${pid}/foods?q=creatine`)
  ).json();
  expect(tub.name).toBe("Creatine monohydrate");
  expect(tub.servings).toEqual([{ label: "Dose", grams: 3 }]);

  // No goal and no data: not offered (a month with nothing logged).
  const empty = "2029-01-01";
  await page.goto(`/#/summary/habits/month/${empty}`);
  await expect(habitSwitch(page).getByRole("radio").first()).toBeVisible();
  await expect(
    habitSwitch(page).getByRole("radio", { name: "Creatine", exact: true }),
  ).toHaveCount(0);

  // One dose eaten: Eaten's From food row, and offered with data.
  await entry(
    request,
    { day, group: "Eaten", food_id: tub.id, serving: "Dose", quantity: 1 },
    pid,
  );
  await page.goto(`/#/day/${day}`);
  await expect(totals(page).locator(".habit-builtins")).toHaveText(
    words("Creatine 3 g"),
  );
  await page.goto(`/#/summary/habits/month/${day}`);
  await habitOf(page, "Creatine");

  // Targets: a Habits row, unset (no recommended goal); 3 g a day offers
  // it with no data too.
  await page.goto("/#/targets");
  const input = page.getByLabel("Creatine target");
  await expect(input).toHaveValue("");
  await input.fill("3");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.locator("#toast")).toHaveText(/Saved/u);
  await page.goto(`/#/summary/habits/month/${empty}`);
  await habitOf(page, "Creatine");
});

test("Hydration: a spirit's alcohol takes its water back, never more; the calendar says what counts", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag } = unique(55, testInfo);
  const pid = await ownProfile(page, request, `Spirits ${tag}`);
  await page.clock.setFixedTime(new Date(`${day}T12:00:00Z`).getTime() + 864e5);
  // Vodka: 24 ml water, 13.2 g alcohol → 0, not −108. Tea: 398 ml.
  await eat(request, pid, day, { water: 60, alcohol: 33 }, 40, tag);
  await eat(request, pid, day, { water: 99.5 }, 400, tag);
  await page.goto(`/#/summary/habits/month/${day.slice(0, 8)}01`);
  const hydration = page.locator(".habits-summary .habit-water");
  await expect(hydration.locator("caption")).toHaveText("Hydration by day");
  await expect(
    hydration.locator(`.habit-cal td[data-day="${day}"]`).getByRole("link"),
  ).toHaveAccessibleName(/: 398\sml$/u);
  await expect(hydration).toContainText(
    "Water in what you eat and drink (a drink without a water value, estimated), less alcohol's effect.",
  );
});

// From food is a line of parts: at a phone's widths it wraps between them
// only, never inside "Salt ≥ 1.1 g" or "Fruit and vegetables ≥ 180 g".
test("From food wraps between its parts only on a phone", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag } = unique(1165, testInfo);
  const pid = await ownProfile(page, request, `Parts ${tag}`);
  const f = await food(request, {
    name: `Juice ${tag}`,
    category: "fruit_veg",
    per100: { energy: 40, alcohol: 5, caffeine: 50, sodium: 250 },
  });
  await entry(request, { day, group: "Eaten", food_id: f.id, grams: 180 }, pid);
  // A food without them: what's counted is a floor.
  await eat(request, pid, day, {}, 100, tag);
  await page.goto(`/#/day/${day}`);
  const text = totals(page).locator(".habit-builtins");
  await expect(text).toContainText("Fruit and vegetables");
  await expectPartsWhole(text, (t) => t.split(" · "));
});
