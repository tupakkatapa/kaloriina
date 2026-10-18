// Every editor works the same way (the one editor shell): leaving with
// unsaved changes asks first, and Save says exactly what it saved.

import { expect, test } from "@playwright/test";
import {
  answer,
  entry,
  exerciseIds,
  food,
  loseFirstAnswer,
  ownProfile,
  starts,
  unique,
  workout,
} from "./helpers.js";

// Each editor: its slot, how to open one (made through the API), the field
// to change and the toast its Save shows.
const EDITORS = [
  {
    kind: "food",
    slot: 191,
    open: async ({ request, tag }) => {
      const f = await food(request, {
        name: `Food ${tag}`,
        per100: { energy: 100 },
      });
      return { url: `/#/food/${f.id}` };
    },
    field: "Name",
    value: (tag) => `Food ${tag} renamed`,
    savedAfter: (tag) => `Saved Food ${tag} renamed`,
  },
  {
    kind: "recipe",
    slot: 192,
    open: async ({ request, tag }) => {
      const f = await food(request, { name: `Flour ${tag}` });
      const r = await (
        await request.post("/api/recipes", {
          data: {
            name: `Recipe ${tag}`,
            items: [{ food_id: f.id, grams: 100 }],
          },
        })
      ).json();
      return { url: `/#/recipe/${r.id}` };
    },
    field: "Name",
    value: (tag) => `Recipe ${tag} renamed`,
    savedAfter: (tag) => `Saved Recipe ${tag} renamed`,
  },
  {
    kind: "meal",
    slot: 193,
    open: async ({ request, tag }) => {
      const f = await food(request, { name: `Egg ${tag}` });
      const m = await (
        await request.post("/api/meals", {
          data: { name: `Meal ${tag}`, items: [{ food_id: f.id, grams: 60 }] },
        })
      ).json();
      return { url: `/#/meal/${m.id}` };
    },
    field: "Name",
    value: (tag) => `Meal ${tag} renamed`,
    savedAfter: (tag) => `Saved Meal ${tag} renamed`,
  },
  {
    kind: "entry",
    slot: 194,
    open: async ({ page, request, tag, day }) => {
      const pid = await ownProfile(page, request, `Entry ${tag}`);
      const f = await food(request, { name: `Plum ${tag}` });
      const {
        entries: [e],
      } = await entry(
        request,
        { day, group: "Eaten", food_id: f.id, grams: 50 },
        pid,
      );
      return { url: `/#/entry/${e.id}` };
    },
    field: "Quantity",
    value: () => "80",
    savedAfter: (tag) => `Saved Plum ${tag}`,
  },
  {
    kind: "activity",
    slot: 195,
    open: async ({ page, request, tag, day }) => {
      const pid = await ownProfile(page, request, `Activity ${tag}`);
      const s = await (
        await request.post(`/api/profiles/${pid}/activities`, {
          data: { day, name: `Swim ${tag}`, minutes: 30 },
        })
      ).json();
      return { url: `/#/activity/${s.id}/edit` };
    },
    field: "Name",
    value: (tag) => `Swim ${tag} long`,
    savedAfter: (tag) => `Saved Swim ${tag} long`,
  },
  {
    kind: "exercise",
    slot: 196,
    open: async ({ request, tag }) => {
      const e = await (
        await request.post("/api/exercises", {
          data: { name: `Lift ${tag}`, measure: "reps" },
        })
      ).json();
      return { url: `/#/exercise/${e.id}/edit` };
    },
    field: "Name",
    value: (tag) => `Lift ${tag} heavy`,
    savedAfter: (tag) => `Saved Lift ${tag} heavy`,
  },
  {
    kind: "workout",
    slot: 197,
    open: async ({ request, tag }) => {
      const id = await exerciseIds(request);
      const w = await workout(request, {
        name: `Circuit ${tag}`,
        steps: [{ kind: "exercise", exercise_id: id("Pull-up"), reps: 5 }],
      });
      return { url: `/#/workout/${w.id}/edit` };
    },
    field: "Name",
    value: (tag) => `Circuit ${tag} long`,
    savedAfter: (tag) => `Saved Circuit ${tag} long`,
  },
  {
    kind: "profile",
    slot: 198,
    open: async ({ page, request, tag }) => {
      const pid = await ownProfile(page, request, `Me ${tag}`);
      return { url: `/#/profile/${pid}` };
    },
    field: "Name",
    value: (tag) => `Me ${tag} too`,
    savedAfter: (tag) => `Saved Me ${tag} too`,
  },
  {
    kind: "targets",
    slot: 199,
    open: async ({ page, request, tag }) => {
      await ownProfile(page, request, `Aims ${tag}`);
      return { url: "/#/targets" };
    },
    field: "Energy target",
    value: () => "2345",
    savedAfter: () => "Saved targets",
  },
];

for (const ed of EDITORS)
  test(`the ${ed.kind} editor asks before leaving unsaved changes and says what it saved`, async ({
    page,
    request,
  }, testInfo) => {
    const { day, tag } = unique(ed.slot, testInfo);
    const { url } = await ed.open({ page, request, tag, day });
    await page.goto(url);
    const input = page.getByLabel(ed.field, { exact: true });
    await expect(input).toBeVisible();
    await input.fill(ed.value(tag));

    // Leaving asks; Cancel keeps the edit where it was.
    const here = page.url();
    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: "Summary" })
      .click();
    expect(await answer(page, "Stay")).toBe("Leave without saving?");
    expect(page.url()).toBe(here);
    await expect(input).toHaveValue(ed.value(tag));

    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.locator("#toast .toast-text")).toHaveText(
      ed.savedAfter(tag),
    );
  });

// A slow editor build that a newer navigation superseded never takes the
// guard: the editor shown still asks.
test("a slow earlier editor doesn't steal the guard", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(243, testInfo);
  const slow = await food(request, { name: `Slow ${tag}` });
  const fast = await food(request, { name: `Fast ${tag}` });
  let release;
  const held = new Promise((r) => {
    release = r;
  });
  await page.route(`**/api/foods/${slow.id}`, async (route) => {
    await held;
    await route.fallback();
  });
  await page.goto("/#/foods");
  await expect(page.locator("h1")).toBeVisible();
  await page.evaluate((id) => {
    location.hash = `#/food/${id}`;
  }, slow.id);
  const late = page.waitForResponse(`**/api/foods/${slow.id}`);
  await page.evaluate((id) => {
    location.hash = `#/food/${id}`;
  }, fast.id);
  const name = page.getByLabel("Name", { exact: true });
  await expect(name).toHaveValue(`Fast ${tag}`);
  // The superseded build finishes now, after the one shown.
  release();
  await (await late).finished();
  for (let i = 0; i < 3; i += 1)
    await page.evaluate(() => new Promise(requestAnimationFrame));
  await name.fill(`Fast ${tag} renamed`);
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Summary" })
    .click();
  expect(await answer(page, "Stay")).toBe("Leave without saving?");
  await expect(name).toHaveValue(`Fast ${tag} renamed`);
});

// Leaving an editor with nothing unsaved goes straight on: the address is
// never put back to the editor's on the way (only a question needs that).
// A reload meanwhile (the browser reads the address on its own side)
// reloaded the editor left: foods.spec's "carbs known one way only" did
// under load.
test("leaving a clean editor never puts its address back", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(1151, testInfo);
  const from = await food(request, { name: `From ${tag}` });
  const to = await food(request, { name: `To ${tag}` });
  await page.goto(`/#/food/${from.id}`);
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
    `From ${tag}`,
  );
  await page.evaluate(() => {
    window.addresses = [];
    const replace = history.replaceState.bind(history);
    history.replaceState = (state, unused, url) => {
      window.addresses.push(String(url));
      replace(state, unused, url);
    };
  });
  await page.evaluate((id) => {
    location.hash = `#/food/${id}`;
  }, to.id);
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
    `To ${tag}`,
  );
  expect(await page.evaluate(() => window.addresses)).toEqual([]);
});

// Pick food `name` into a recipe's or meal's items.
async function pickItem(page, name) {
  await page.getByLabel("Search foods to add").fill(name);
  await page.getByRole("button", { name: starts(name) }).click();
}

// Each editor that creates: its slot, its new form, the create's address,
// how to fill it and how many records hold a name.
const CREATES = [
  {
    kind: "food",
    slot: 1106,
    url: "/#/food/new",
    glob: "**/api/foods",
    fill: (page) =>
      page.getByLabel("Energy (kcal)", { exact: true }).fill("100"),
    count: async (request, name) =>
      (
        await (
          await request.get(
            `/api/profiles/1/foods?${new URLSearchParams({ q: name, sources: "custom" })}`,
          )
        ).json()
      ).filter((f) => f.name === name).length,
  },
  {
    kind: "recipe",
    slot: 1110,
    url: "/#/recipe/new",
    glob: "**/api/recipes",
    fill: (page, tag) => pickItem(page, `Item ${tag}`),
    count: async (request, name) =>
      (
        await (
          await request.get(
            `/api/profiles/1/foods?${new URLSearchParams({ q: name, sources: "recipe" })}`,
          )
        ).json()
      ).filter((f) => f.name === name).length,
  },
  {
    kind: "meal",
    slot: 1116,
    url: "/#/meal/new",
    glob: "**/api/meals",
    fill: (page, tag) => pickItem(page, `Item ${tag}`),
    count: async (request, name) =>
      (await (await request.get("/api/meals")).json()).filter(
        (m) => m.name === name,
      ).length,
  },
  {
    kind: "habit",
    slot: 1118,
    url: "/#/habit/new",
    glob: "**/api/profiles/*/habits",
    fill: (page) => page.getByLabel("Unit").fill("cups"),
    count: async (request, name) =>
      (await (await request.get("/api/profiles/1/habits")).json()).filter(
        (h) => h.name === name,
      ).length,
  },
  {
    kind: "profile",
    slot: 1120,
    url: "/#/profile/new",
    glob: "**/api/profiles",
    fill: async () => {},
    count: async (request, name) =>
      (await (await request.get("/api/profiles")).json()).filter(
        (p) => p.name === name,
      ).length,
  },
];

// A create whose answer was lost, saved again, is one record.
for (const ed of CREATES)
  test(`the ${ed.kind} editor's Save sent again after its answer was lost creates one`, async ({
    page,
    request,
  }, testInfo) => {
    const { tag } = unique(ed.slot, testInfo);
    await food(request, { name: `Item ${tag}`, per100: { energy: 50 } });
    const name = `Once ${ed.kind} ${tag}`;
    await page.goto(ed.url);
    await page.getByLabel("Name", { exact: true }).fill(name);
    await ed.fill(page, tag);
    await loseFirstAnswer(page, "POST", ed.glob);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Can't reach the server")).toBeVisible();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.locator("#toast")).toContainText(`Saved ${name}`);
    expect(await ed.count(request, name)).toBe(1);
  });
