// Every editor works the same way (the one editor shell): leaving with
// unsaved changes asks first, and Save says exactly what it saved.

import { test, expect } from "@playwright/test";
import {
  unique,
  food,
  answer,
  entry,
  exerciseIds,
  ownProfile,
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
        { day, group: "Consumed", food_id: f.id, grams: 50 },
        pid,
      );
      return { url: `/#/entry/${e.id}` };
    },
    field: "Quantity",
    value: () => "80",
    savedAfter: (tag) => `Saved Plum ${tag}`,
  },
  {
    kind: "session",
    slot: 195,
    open: async ({ page, request, tag, day }) => {
      const pid = await ownProfile(page, request, `Session ${tag}`);
      const s = await (
        await request.post(`/api/profiles/${pid}/sessions`, {
          data: { day, name: `Swim ${tag}`, minutes: 30 },
        })
      ).json();
      return { url: `/#/session/${s.id}` };
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
      return { url: `/#/workout/${w.id}` };
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
    expect(await answer(page, "Cancel")).toBe("Leave without saving?");
    expect(page.url()).toBe(here);
    await expect(input).toHaveValue(ed.value(tag));

    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.locator("#toast .toast-text")).toHaveText(
      ed.savedAfter(tag),
    );
  });
