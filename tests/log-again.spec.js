// Logging again: select mode (Log again, Save as meal), Same as yesterday,
// entry times, and the Log card's measurements and note.

import { test, expect } from "@playwright/test";
import {
  unique,
  food,
  entry,
  ownProfile,
  starts,
  todayInApp,
  realDay,
} from "./helpers.js";

// A diary section by its heading ("Planned", "Eaten", "Log").
const section = (page, name) =>
  page.locator(".group", {
    has: page.getByRole("heading", { name, exact: true }),
  });

const dayAfter = (day, n) =>
  new Date(Date.parse(day) + n * 864e5).toISOString().slice(0, 10);

// Two foods eaten on `day` (profile 1, unless `profile`).
async function twoEaten(request, day, tag, profile = 1) {
  const oats = await food(request, {
    name: `Oats ${tag}`,
    per100: { energy: 400, protein: 10 },
  });
  const milk = await food(request, {
    name: `Milk ${tag}`,
    per100: { energy: 50, protein: 3 },
  });
  const log = (f, grams) =>
    entry(request, { day, group: "Consumed", food_id: f.id, grams }, profile);
  await log(oats, 50);
  await log(milk, 200);
  return { oats, milk };
}

test("select two, log them again on another day, and undo", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag } = unique(300, testInfo);
  await twoEaten(request, day, tag);
  const to = dayAfter(day, 3);

  await page.goto(`/#/day/${day}`);
  const eaten = section(page, "Eaten");
  await eaten.getByRole("button", { name: "Select from Eaten" }).click();
  await eaten.getByRole("checkbox", { name: `Oats ${tag}` }).check();
  await eaten.getByRole("checkbox", { name: `Milk ${tag}` }).check();
  await expect(eaten.locator(".select-bar")).toContainText("2 selected");
  await eaten.getByRole("button", { name: "Log again…" }).click();

  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Day").fill(to);
  // A day ahead defaults to Planned; this one was eaten.
  const group = dialog.getByRole("radiogroup", { name: "Group" });
  await expect(group.getByRole("radio", { name: "Planned" })).toBeChecked();
  await group.getByRole("radio", { name: "Eaten" }).click();
  await dialog.getByRole("button", { name: "Log 2 again" }).click();

  await expect(page).toHaveURL(new RegExp(`#/day/${to}$`));
  const there = section(page, "Eaten");
  await expect(there.locator(".entry")).toHaveCount(2);
  await expect(there).toContainText(`Oats ${tag}`);
  await expect(there).toContainText("200 g");
  await expect(page.locator("#toast")).toContainText("Logged 2 foods on");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(there.locator(".entry")).toHaveCount(0);
});

test("save selected foods as a meal", async ({ page, request }, testInfo) => {
  const { day, tag } = unique(301, testInfo);
  const { oats } = await twoEaten(request, day, tag);

  await page.goto(`/#/day/${day}`);
  const eaten = section(page, "Eaten");
  await eaten.getByRole("button", { name: "Select from Eaten" }).click();
  await eaten.getByRole("checkbox", { name: `Oats ${tag}` }).check();
  await eaten.getByRole("button", { name: "Save as meal…" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name").fill(`Breakfast ${tag}`);
  await dialog.getByRole("button", { name: "Save as meal" }).click();
  await expect(page.locator("#toast")).toContainText(
    `Saved meal Breakfast ${tag}`,
  );
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await expect(page).toHaveURL(/#\/meal\/\d+$/);
  const id = page.url().match(/meal\/(\d+)/)[1];
  const meal = await (await request.get(`/api/meals/${id}`)).json();
  expect(meal.items.map((i) => [i.food_id, i.grams])).toEqual([[oats.id, 50]]);
});

test("imported rows can't be ticked; Done leaves select mode", async ({
  page,
}, testInfo) => {
  const { day, tag } = unique(302, testInfo);
  const row = (fields) => ({
    day,
    food_id: null,
    grams: null,
    serving: null,
    quantity: null,
    nutrients: null,
    created_at: "",
    source: null,
    time: null,
    ...fields,
  });
  await realDay(page, day, {
    groups: [
      { name: "Planned", entries: [], totals: {} },
      {
        name: "Consumed",
        entries: [
          row({
            id: 1,
            group: "Consumed",
            name: `Old ${tag}`,
            amount: "1 pc",
            imported: true,
            uid: "a",
          }),
          row({
            id: 2,
            group: "Consumed",
            name: `New ${tag}`,
            food_id: 1,
            grams: 100,
            amount: "100 g",
            nutrients: { energy: 100 },
            imported: false,
            uid: "b",
          }),
        ],
        totals: { energy: 100 },
      },
    ],
    total: {},
    consumed: {},
    targets: [],
  });
  await page.goto(`/#/day/${day}`);
  const eaten = section(page, "Eaten");
  await eaten.getByRole("button", { name: "Select from Eaten" }).click();
  await expect(
    eaten.getByRole("checkbox", { name: `Old ${tag}` }),
  ).toBeDisabled();
  await expect(eaten).toContainText("History can't be copied");
  await expect(
    eaten.getByRole("button", { name: "Log again…" }),
  ).toBeDisabled();
  await eaten.getByRole("checkbox", { name: `New ${tag}` }).check();
  await expect(eaten.getByRole("button", { name: "Log again…" })).toBeEnabled();
  await eaten.getByRole("button", { name: "Done" }).click();
  await expect(eaten.getByRole("checkbox")).toHaveCount(0);
  await expect(
    eaten.getByRole("button", { name: "Select from Eaten" }),
  ).toBeVisible();
});

test("the entry editor's Log again opens select mode with it ticked", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag } = unique(303, testInfo);
  const oats = await food(request, {
    name: `Oats ${tag}`,
    per100: { energy: 400 },
  });
  const {
    entries: [e],
  } = await entry(request, {
    day,
    group: "Planned",
    food_id: oats.id,
    grams: 50,
  });
  await page.goto(`/#/entry/${e.id}`);
  await page.getByRole("link", { name: "Log again" }).click();
  await expect(page).toHaveURL(new RegExp(`#/day/${day}\\?select=${e.id}$`));
  const planned = section(page, "Planned");
  await expect(
    planned.getByRole("checkbox", { name: `Oats ${tag}` }),
  ).toBeChecked();
  await expect(planned.locator(".select-bar")).toContainText("1 selected");
});

test("the finder repeats yesterday in one tap", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag } = unique(304, testInfo);
  const yesterday = dayAfter(day, -1);
  await twoEaten(request, yesterday, tag);

  await page.goto(`/#/add/${day}/Consumed`);
  const same = page.getByRole("button", { name: /^Same as yesterday/ });
  // 50 g of 400 kcal/100 g and 200 g of 50 kcal/100 g.
  await expect(same).toContainText("2 foods · 300 kcal");
  await same.click();
  await expect(page).toHaveURL(new RegExp(`#/day/${day}$`));
  await expect(section(page, "Eaten").locator(".entry")).toHaveCount(2);
  await expect(page.locator("#toast")).toContainText("Added 2 foods to Eaten");
});

test("an entry's time prefixes its row and clears", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag } = unique(307, testInfo);
  const oats = await food(request, {
    name: `Oats ${tag}`,
    per100: { energy: 400 },
  });
  const {
    entries: [e],
  } = await entry(request, {
    day,
    group: "Consumed",
    food_id: oats.id,
    grams: 50,
  });
  await page.goto(`/#/entry/${e.id}`);
  await page.getByLabel("Time eaten").fill("08:15");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator("#toast")).toContainText(`Saved Oats ${tag}`);
  await page.goto(`/#/day/${day}`);
  const row = section(page, "Eaten").locator(".entry");
  await expect(row).toContainText("08:15 · 50 g");

  await page.goto(`/#/entry/${e.id}`);
  await page.getByLabel("Time eaten").fill("");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await (await request.get(`/api/profiles/1/entries/${e.id}`)).json())
          .time,
    )
    .toBeNull();
});

test("measurements save in one dialog; the note is a Log row with ✕ and Undo", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(308, testInfo);
  // Notes and measurements can't be written ahead: today, in a profile of
  // the test's own.
  const day = todayInApp();
  const pid = await ownProfile(page, request, `Notes ${tag}`);
  const read = async () =>
    (await request.get(`/api/profiles/${pid}/day/${day}`)).json();
  const log = section(page, "Log");
  const dialog = page.getByRole("dialog");
  const sheet = async (item) => {
    await log.getByRole("button", { name: "+ Log" }).click();
    await dialog.getByRole("button", { name: starts(item) }).click();
  };

  await page.goto(`/#/day/${day}`);
  await sheet("Measurements");
  await expect(dialog.getByLabel("Waist (cm)")).toBeFocused();
  await dialog.getByLabel("Waist (cm)").fill("81.5");
  await dialog.getByLabel("Chest (cm)").fill("96");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect
    .poll(async () => (await read()).measurements)
    .toEqual([
      { kind: "waist", value: 81.5 },
      { kind: "chest", value: 96 },
    ]);
  // One row per kind measured.
  const rows = log.locator(".log-row");
  await expect(rows.filter({ hasText: /^Waist/ })).toHaveText(
    /^Waist81\.5\scm✕$/,
  );
  await expect(rows.filter({ hasText: /^Chest/ })).toHaveText(/^Chest96\scm✕$/);
  await expect(rows.filter({ hasText: /^Hips/ })).toHaveCount(0);

  // A row opens the dialog at its kind; emptied, it's removed.
  await log
    .getByRole("button", { name: /^Change measurements, Waist/ })
    .click();
  await expect(dialog.getByLabel("Waist (cm)")).toBeFocused();
  await expect(dialog.getByLabel("Waist (cm)")).toHaveValue("81.5");
  await dialog.getByLabel("Waist (cm)").fill("");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect
    .poll(async () => (await read()).measurements)
    .toEqual([{ kind: "chest", value: 96 }]);
  await expect(rows.filter({ hasText: /^Waist/ })).toHaveCount(0);

  // The note: a row named by its text, with ✕ and Undo.
  const text = `Slept badly ${tag}`;
  await sheet("Note");
  await dialog.getByRole("textbox", { name: "Note" }).fill(text);
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect.poll(async () => (await read()).note).toBe(text);
  await expect(log.getByRole("button", { name: starts(text) })).toBeVisible();

  await log.getByRole("button", { name: "Remove note" }).click();
  await expect.poll(async () => (await read()).note).toBeNull();
  await expect(log.getByRole("button", { name: starts(text) })).toHaveCount(0);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect.poll(async () => (await read()).note).toBe(text);
  await expect(log.getByRole("button", { name: starts(text) })).toBeVisible();
});

test("select all, then delete the selected after one confirm", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag } = unique(808, testInfo);
  const pid = await ownProfile(page, request, `Delete ${tag}`);
  await twoEaten(request, day, tag, pid);
  // On a small phone the header keeps one row: Select is an icon there.
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto(`/#/day/${day}`);
  const eaten = section(page, "Eaten");
  const select = eaten.getByRole("button", { name: "Select from Eaten" });
  const add = eaten.getByRole("link", { name: "Add to Eaten" });
  expect(Math.round((await select.boundingBox()).y)).toBe(
    Math.round((await add.boundingBox()).y),
  );
  await select.click();
  const all = eaten.getByRole("checkbox", { name: "Select all" });
  await all.check();
  await expect(eaten.locator(".select-bar")).toContainText("2 selected");
  await all.uncheck();
  await expect(eaten.locator(".select-bar")).toContainText("0 selected");
  await all.check();
  await eaten.getByRole("button", { name: "Delete…" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading")).toHaveText("Delete 2 entries?");
  await dialog.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.locator("#toast")).toContainText("Deleted 2 entries");
  await expect(eaten.locator(".entry")).toHaveCount(0);
  const data = await (
    await request.get(`/api/profiles/${pid}/day/${day}`)
  ).json();
  expect(data.groups.flatMap((g) => g.entries)).toEqual([]);
});
