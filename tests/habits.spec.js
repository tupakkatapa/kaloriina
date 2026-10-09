// Habits: counting in the diary's Log (card and sheet), Profile → Habits and the
// Summary calendars.
// Every test counts on a profile of its own (trackers are per profile).

import { test, expect } from "@playwright/test";
import {
  answer,
  entry,
  food,
  ownProfile,
  starts,
  todayInApp,
  unique,
} from "./helpers.js";

// A number and its unit as the app writes them (a no-break space).
const words = (text) =>
  new RegExp(`^${text.replace(/[().]/g, "\\$&").replaceAll(" ", "\\s")}$`);

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

// A food of `per100` logged as eaten on `day`.
async function eat(request, pid, day, per100, grams, tag) {
  const f = await food(request, {
    name: `Drink ${tag} ${Object.keys(per100).join(" ")}`,
    per100: { energy: 40, ...per100 },
  });
  await entry(request, { day, group: "Consumed", food_id: f.id, grams }, pid);
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
  await log.getByRole("button", { name: "+ Log" }).click();
  const sheet = page.getByRole("dialog", { name: "Log" });
  // Only the active tracker, at 0; no built-ins in the sheet.
  await expect(sheet.locator(".habit-row")).toHaveCount(1);
  await expect(sheet.locator(".habit-builtins")).toHaveCount(0);
  const less = sheet.getByRole("button", { name: "One less Snus" });
  const more = sheet.getByRole("button", { name: "One more Snus" });
  const amount = sheet.getByRole("button", { name: /^Snus: / });
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
    { habit: String(snus.id), day, amount: 2 },
  ]);

  // Done: the card shows the count, in place, focus back on + Log.
  await sheet.getByRole("button", { name: "Done" }).click();
  await expect(sheet).toHaveCount(0);
  await expect(log.getByRole("button", { name: "+ Log" })).toBeFocused();
  expect(
    await page.evaluate(
      () => window.sameScreen === document.querySelector("#app section"),
    ),
  ).toBe(true);
  const cardAmount = log.getByRole("button", { name: /^Snus: / });
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
    { habit: String(snus.id), day, amount: 4.5 },
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
  const amount = card(page).getByRole("button", { name: /^Snus: / });
  await expect(amount).toHaveText(words("10 pouches"));
  expect(
    // Within a pixel: widths round.
    await amount.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
  ).toBe(true);
});

test("the Log card shows the day's alcohol and caffeine; the sheet leads to Profile → Habits", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag } = unique(471, testInfo);
  const pid = await ownProfile(page, request, `Drinker ${tag}`);
  // 240 g: 24 g alcohol (2 drinks) and 240 mg caffeine.
  await eat(request, pid, day, { alcohol: 10, caffeine: 100 }, 240, tag);
  await page.goto(`/#/day/${day}`);
  await expect(card(page).locator(".habit-builtins")).toHaveText(
    words("Alcohol 2 drinks · Caffeine 240 mg"),
  );
  // One row of its own kind.
  await expect(
    card(page)
      .locator(".log-row", { has: page.locator(".habit-builtins") })
      .locator(".kind"),
  ).toHaveText("From food");
  await card(page).getByRole("button", { name: "+ Log" }).click();
  await page
    .getByRole("dialog", { name: "Log" })
    .getByRole("link", { name: starts("Manage habits…") })
    .click();
  await expect(page).toHaveURL(/#\/habits$/);
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // A day with nothing: the card and its hint, no list.
  const empty = new Date(Date.parse(day) + 864e5).toISOString().slice(0, 10);
  await page.goto(`/#/day/${empty}`);
  await expect(card(page)).toBeVisible();
  await expect(card(page)).toContainText("Nothing logged yet. Use + Log.");
  await expect(card(page).getByRole("list")).toHaveCount(0);
});

test("Profile → Habits adds, edits, archives and deletes a tracker", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(472, testInfo);
  const pid = await ownProfile(page, request, `Keeper ${tag}`);
  await page.goto("/#/profile");
  const row = page.getByRole("link", { name: /^Habits/ });
  await expect(row).toHaveText(/\d+ built-ins and 0 of your own/);
  await row.click();
  await expect(page.getByRole("heading", { name: "Habits" })).toBeVisible();

  // Add: a name and a unit; the goal is set on Targets.
  await page.getByRole("link", { name: /^New habit/ }).click();
  await page.getByLabel("Name").fill("Snus");
  await page.getByLabel("Unit").fill("pouches");
  await expect(page.locator(".habit-goal")).toHaveText(
    "Goal: none · Set it on Targets once saved",
  );
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page).toHaveURL(/#\/habits$/);
  await expect(page.getByRole("link", { name: /^Snus/ })).toHaveText(
    /pouches$/,
  );
  // A goal set elsewhere shows on the list and, read-only, in the editor.
  const [made] = await (
    await request.get(`/api/profiles/${pid}/habits`)
  ).json();
  await request.put(`/api/profiles/${pid}/habits/${made.id}`, {
    data: { ...made, goal_value: 10, goal_dir: "at_least" },
  });
  await page.reload();
  await expect(page.getByRole("link", { name: /^Snus/ })).toHaveText(
    /pouches · at least 10 a day/,
  );

  // Rename and change the unit: the goal stays.
  await page.getByRole("link", { name: /^Snus/ }).click();
  await expect(page.locator(".habit-goal")).toHaveText(
    "Goal: at least 10 a day · Change on Targets",
  );
  await expect(
    page.getByRole("link", { name: "Change on Targets" }),
  ).toHaveAttribute("href", "#/targets");
  await page.getByLabel("Name").fill("Nicotine");
  await page.getByLabel("Unit").fill("pieces");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.locator("#toast")).toHaveText(/Saved Nicotine/);
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
  await page.getByRole("link", { name: /^Nicotine/ }).click();
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
  await page.getByRole("link", { name: /^Nicotine/ }).click();
  await page.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByRole("dialog")).toContainText(
    "Its 2 logged days go with it.",
  );
  expect(await answer(page, "Delete")).toBe("Delete Nicotine?");
  await expect(page).toHaveURL(/#\/habits$/);
  await expect(page.getByRole("link", { name: /^Nicotine/ })).toHaveCount(0);
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
    data: { name: "Snuff", unit: "pinches", rev: t.rev },
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
  const snus = await tracker(request, pid, {
    name: "Snus",
    goal_value: 5,
    goal_dir: "at_most",
  });
  // Snus on 4 days of 4 distinct amounts; Thu 10th logs only Snus.
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
  await expect(sat).toHaveClass(/\bshade-2\b/);
  await expect(sat).toHaveClass(/\bover\b/);
  await expect(sat).toContainText("2");
  const sun = cellOf(alcohol, `${MONTH}-06`);
  await expect(sun.getByRole("link")).toHaveAccessibleName(
    words("Sun, Sep 6: 0.5 drinks"),
  );
  await expect(sun).toHaveClass(/\bshade-1\b/);
  await expect(sun).not.toHaveClass(/\bover\b/);
  // Logged (Snus only) reads "none"; not logged at all is hatched.
  const thu = cellOf(alcohol, `${MONTH}-10`);
  await expect(thu.getByRole("link")).toHaveAccessibleName("Thu, Sep 10: none");
  await expect(thu).toHaveClass(/\bshade-0\b/);
  await expect(thu).not.toHaveClass(/\bnone\b/);
  const mon = cellOf(alcohol, `${MONTH}-07`);
  await expect(mon.getByRole("link")).toHaveAccessibleName(
    "Mon, Sep 7: nothing logged",
  );
  await expect(mon).toHaveClass(/\bnone\b/);
  await expect(
    alcohol.getByRole("list", { name: "Alcohol" }).getByRole("listitem"),
  ).toHaveText(
    [
      "0.6 drinks a week",
      "2 days with any",
      "2 most in a day (Sat, Sep 5)",
      "1 day over your limit",
    ].map(words),
  );
  await expect(alcohol.locator(".habit-legend li")).toHaveText(
    [
      "None",
      "≤ 1 drinks",
      "1–3 drinks",
      "3–5 drinks",
      "> 5 drinks",
      "nothing logged",
      "over your limit",
    ].map(words),
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
    await expect(c).toHaveClass(new RegExp(`\\b${shade}\\b`));
  }
  // Its quartiles (1, 2, 4) in the one legend grammar.
  await expect(snus.locator(".habit-legend li").first()).toHaveText("None");
  await expect(snus.locator(".habit-legend")).toContainText(/1–2\spouches/);
  // The pick is kept on this device.
  expect(await page.evaluate(() => localStorage.getItem("summary-habit"))).toBe(
    String(snusId),
  );
  await expect(await habitOf(page, "Gum")).toContainText("No Gum this month");

  // A key's note is its habit's alone; caffeine (no data, no target) isn't
  // offered.
  await expect(section.getByText(/A drink is 12 g/)).toHaveCount(0);
  await expect(
    habitSwitch(page).getByRole("radio", { name: "Caffeine" }),
  ).toHaveCount(0);

  // A day opens its diary.
  await habitOf(page, "Alcohol");
  await cellOf(alcohol, `${MONTH}-05`).getByRole("link").click();
  await expect(page).toHaveURL(new RegExp(`#/day/${MONTH}-05$`));
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
    cellOf(alcohol, `${MONTH}-12`).getByRole("link"),
  ).toHaveAccessibleName("Sat, Sep 12: none");
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
  await expect(sat).toHaveClass(/\bshade-2\b/);
  await expect(sat.getByRole("link")).toHaveCount(0);
  await expect(alcohol.getByRole("list", { name: "Alcohol" })).toContainText(
    /drinks a week/,
  );
  await (await habitOf(page, "Snus"))
    .getByRole("link", { name: "Sep", exact: true })
    .click();
  await expect(page).toHaveURL(
    new RegExp(`#/summary/habits/month/${MONTH}-01$`),
  );
});

test("a fruit entry shows in Log card, Summary, Targets", async ({
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
  await expect(page.locator("#toast")).toHaveText(/Saved/);
  expect(
    (await (await request.get(`/api/foods/${apple.id}`)).json()).category,
  ).toBe("fruit_veg");

  const day = "2026-08-12";
  await entry(
    request,
    { day, group: "Consumed", food_id: apple.id, grams: 300 },
    pid,
  );
  await page.goto(`/#/day/${day}`);
  await expect(card(page).locator(".habit-builtins")).toHaveText(
    words("Fruit and vegetables 300 g"),
  );

  // Summary: against the recommended 500 g a day, 300 g is over half.
  await page.goto(`/#/summary/habits/month/${day}`);
  const fruit = await habitOf(page, "Fruit and vegetables");
  await expect(cellOf(fruit, day).getByRole("link")).toHaveAccessibleName(
    words("Wed, Aug 12: 300 g"),
  );
  await expect(cellOf(fruit, day)).toHaveClass(/\bshade-2\b/);

  // Targets: its goal is a Habits row; 250 g a day makes the day a reached one.
  await page.goto("/#/targets");
  const input = page.getByLabel("Fruit and vegetables target");
  await expect(input).toHaveValue("500");
  await input.fill("250");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.locator("#toast")).toHaveText(/Saved/);
  await page.goto(`/#/summary/habits/month/${day}`);
  const reached = await habitOf(page, "Fruit and vegetables");
  await expect(cellOf(reached, day)).toHaveClass(/\bshade-4\b/);
  await expect(
    reached.getByRole("list", { name: "Fruit and vegetables" }),
  ).toContainText("1 day at your target");
});
