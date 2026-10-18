// One view of an amount of a food or recipe: logging it (`#/log`) and its
// logged entry (`#/entry`) are the same screen, one column at every width.
// They differ only in the line under the name, the entry's Group switch
// and buttons (Delete, Log again, Save; to log: Copy food or recipe, Add to
// Eaten / Planned).

import { expect, test } from "@playwright/test";
import { entry, food, ownProfile, unique } from "./helpers.js";

// What a screen shows, in order: its title, field labels, buttons and
// section headings, with the nutrition panel's parts by class.
const outline = (page) =>
  page
    .locator("main > section")
    .evaluate((s) =>
      [
        ...s.querySelectorAll(
          "h1, h2, .field > span, label.check, button:not(.icon), a.button, .nutrition-panel > *",
        ),
      ]
        .filter((el) => el.checkVisibility())
        .map((el) =>
          el.parentElement.classList.contains("nutrition-panel")
            ? `.${el.className}`
            : el.textContent.trim(),
        ),
    );

const LOG = ["Copy food", "Copy recipe", "Add to Eaten", "Add to Planned"];
const ENTRY = ["Group", "Planned", "Eaten", "Delete", "Log again", "Save"];
const without = (list, drop) => list.filter((x) => !drop.includes(x));

// Both screens of `id` logged as `e`: the same outline but for their own
// fields and buttons; the verdict alone in the header, no amount line under
// the amount, no "Optional"; one column.
async function same(page, id, e) {
  await page.goto(`/#/log/${id}`);
  await expect(
    page.getByRole("button", { name: "Add to Eaten" }),
  ).toBeVisible();
  const log = await outline(page);
  await page.goto(`/#/entry/${e.id}`);
  await expect(page.getByRole("link", { name: "Log again" })).toBeVisible();
  const ent = await outline(page);
  expect(without(ent, ENTRY)).toEqual(without(log, LOG));
  for (const route of [`/#/log/${id}`, `/#/entry/${e.id}`]) {
    await page.goto(route);
    const section = page.locator("main > section");
    await expect(section.locator(".nutrition-panel .lights")).toBeVisible();
    await expect(section.locator(".title ~ form .light")).toHaveText([
      "Healthy",
    ]);
    await expect(section.getByText("Optional", { exact: true })).toHaveCount(0);
    await expect(section.getByText(/^\S+\s(g|ml) · /u)).toHaveCount(0);
    await expect(
      section.getByRole("checkbox", { name: "Repeat daily" }),
    ).toBeVisible();
    // One column: the panel as wide as the form, under it.
    const form = await section.locator("form").boundingBox();
    const panel = await section.locator(".nutrition-panel").boundingBox();
    expect(Math.abs(panel.x - form.x)).toBeLessThan(1);
    expect(Math.abs(panel.width - form.width)).toBeLessThan(1);
    expect(panel.y).toBeGreaterThan(form.y + form.height - 1);
  }
  return log;
}

const LEAN = {
  energy: 110,
  protein: 23,
  fat: 1.5,
  saturated: 0.4,
  sugars: 0,
  sodium: 60,
};

test("a food's log screen and its entry are one view", async ({
  page,
  request,
}, testInfo) => {
  const { tag, day } = unique(0, testInfo);
  const f = await food(request, { name: `Chicken ${tag}`, per100: LEAN });
  const {
    entries: [e],
  } = await entry(request, { day, group: "Eaten", food_id: f.id, grams: 80 });
  const log = await same(page, f.id, e);
  expect(log).not.toContain("Ingredients");
});

test("a recipe's log screen and its entry are one view, ingredients in both", async ({
  page,
  request,
}, testInfo) => {
  const { tag, day } = unique(28, testInfo);
  const f = await food(request, { name: `Breast ${tag}`, per100: LEAN });
  const r = await (
    await request.post("/api/recipes", {
      data: {
        name: `Stew ${tag}`,
        items: [{ food_id: f.id, grams: 200 }],
      },
    })
  ).json();
  const {
    entries: [e],
  } = await entry(request, { day, group: "Eaten", food_id: r.id, grams: 100 });
  const log = await same(page, r.id, e);
  expect(log).toContain("Ingredients");
  await expect(
    page.locator(".recipe-items").getByRole("link", { name: /^Breast/u }),
  ).toBeVisible();
});

test("Repeat daily on the log screen logs a series", async ({
  page,
  request,
}, testInfo) => {
  const { tag, day } = unique(30, testInfo);
  const pid = await ownProfile(page, request, `Repeat ${tag}`);
  const f = await food(request, { name: `Shake ${tag}`, per100: LEAN });
  await page.goto(`/#/log/${day}/Eaten/${f.id}`);
  await page.getByRole("checkbox", { name: "Repeat daily" }).check();
  await page.getByRole("button", { name: "Add to Eaten" }).click();
  await expect(page).toHaveURL(new RegExp(`#/day/${day}`, "u"));
  const next = new Date(Date.parse(day) + 864e5).toISOString().slice(0, 10);
  const due = async () =>
    (
      await (await request.get(`/api/profiles/${pid}/day/${next}`)).json()
    ).groups
      .find((g) => g.name === "Planned")
      .entries.map((x) => [x.name, x.kind]);
  // Its day is ahead of today: the series starts on it.
  expect(await due()).toEqual([[`Shake ${tag}`, "due"]]);
  // Undo takes the series with the entry.
  await page.locator("#toast").getByRole("button", { name: "Undo" }).click();
  await expect.poll(due).toEqual([]);
});
