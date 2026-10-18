// The app as a whole: navigation, focus, errors.

import { expect, test } from "@playwright/test";
import {
  entry,
  fixedToday,
  food,
  mockJson,
  ownProfile,
  settled,
  starts,
  todayInApp,
  unique,
} from "./helpers.js";

test("a failed action shows an error", async ({ page, request }, testInfo) => {
  const { day, tag } = unique(9, testInfo);
  const f = await food(request, { name: `Plum ${tag}` });
  await entry(request, { day, group: "Planned", food_id: f.id, grams: 50 });

  await page.route("**/api/profiles/*/entries/*", (route) =>
    route.fulfill({ status: 500, json: { error: "server on fire" } }),
  );
  await page.goto(`/#/day/${day}`);
  await page.getByRole("button", { name: `Mark Plum ${tag} eaten` }).click();
  await expect(page.getByRole("alert")).toContainText("server on fire");
});

test("the bottom tabs lead everywhere, Profile holds targets", async ({
  page,
}) => {
  await page.goto("/#/");
  const tabs = page.getByRole("navigation", { name: "Main" });
  await expect(tabs.getByRole("link")).toHaveCount(5);
  await tabs.getByRole("link", { name: "Profile: Me" }).click();
  await expect(page).toHaveURL(/#\/profile$/u);
  await page.getByRole("link", { name: /^Targets/u }).click();
  await expect(page.getByRole("heading", { name: "Targets" })).toBeVisible();
  await expect(tabs.getByRole("link", { name: "Profile: Me" })).toHaveAttribute(
    "aria-current",
    "page",
  );
});

test("a proxy login page instead of data says to reload", async ({ page }) => {
  await page.route("**/api/profiles/*/day/*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<h1>Log in</h1>",
    }),
  );
  await page.goto("/#/day/2031-05-05");
  await expect(page.getByRole("alert").first()).toContainText("reload");
});

test("moving between screens puts focus on the new heading", async ({
  page,
}) => {
  await page.goto("/#/");
  await page.getByRole("link", { name: "Foods" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Foods" }),
  ).toBeFocused();
  await expect(page.locator("main")).not.toHaveAttribute("aria-live", /.*/u);
});

test("Back closes an open dialog, which then does nothing", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag } = unique(962, testInfo);
  const f = await food(request, { name: `Fig ${tag}` });
  await entry(request, { day, group: "Eaten", food_id: f.id, grams: 50 });
  await page.goto(`/#/day/${day}`);
  await page.getByRole("link", { name: starts(`Fig ${tag}`) }).click();
  await page.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`#/day/${day}$`, "u"));
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: starts(`Fig ${tag}`) }),
  ).toBeVisible();

  await page.goto("/#/foods");
  await page.goto("/#/profile");
  await page.getByRole("button", { name: starts("Import a profile") }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/#\/foods$/u);
  await expect(page.locator("dialog[open]")).toHaveCount(0);
});

test("the window title names the screen and its tab", async ({ page }) => {
  await page.goto("/#/");
  await expect(page).toHaveTitle("Today · Diary · Kaloriina");
  await page.getByRole("link", { name: "Foods" }).click();
  await expect(page).toHaveTitle("Foods · Kaloriina");
  await page.goto("/#/targets");
  await expect(page).toHaveTitle("Targets · Profile · Kaloriina");
});

test("controls repeated per row have names of their own", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag } = unique(40, testInfo);
  const f = await food(request, {
    name: `Named ${tag}`,
    per100: { energy: 10 },
  });
  await request.post("/api/profiles/1/entries", {
    data: { day, group: "Planned", food_id: f.id, grams: 10 },
  });
  await page.goto(`/#/day/${day}`);
  await expect(
    page.getByRole("link", { name: "Add to Planned" }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Add to Eaten" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: `Mark Named ${tag} eaten` }),
  ).toBeVisible();
  await page.getByRole("link", { name: starts(`Named ${tag}`) }).click();
  await expect(page).toHaveURL(/#\/entry\/\d+$/u);
  await expect(
    page.getByRole("heading", { level: 1, name: `Named ${tag}` }),
  ).toBeVisible();
});

test("an unknown address says so and leads back", async ({ page }) => {
  await page.goto("/#/nowhere");
  await expect(
    page.getByRole("heading", { level: 1, name: "Not found" }),
  ).toBeVisible();
  await expect(
    page.getByText("There's no screen at this address."),
  ).toBeVisible();
  await page.getByRole("link", { name: "Go to today" }).click();
  await expect(page).toHaveURL(/#\/$/u);
  await expect(page.locator(".headline")).toBeVisible();
});

for (const [address, what, back, tab] of [
  ["#/food/999999", "food", "Go to Foods", /#\/foods$/u],
  ["#/recipe/999999", "recipe", "Go to Foods", /#\/foods$/u],
  ["#/workout/999999", "workout", "Go to Activity", /#\/activity$/u],
  ["#/activity/999999", "activity", "Go to today", /#\/$/u],
  ["#/log/999999", "food", "Go to Foods", /#\/foods$/u],
  ["#/habit/999999", "habit", "Go to Profile", /#\/profile$/u],
])
  test(`a missing ${what} (${address}) shows a not-found screen`, async ({
    page,
  }) => {
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`/${address}`);
    await expect(
      page.getByRole("heading", { level: 1, name: "Not found" }),
    ).toBeVisible();
    await expect(
      page.getByText(`This ${what} doesn't exist (any more).`),
    ).toBeVisible();
    await page.getByRole("link", { name: back }).click();
    await expect(page).toHaveURL(tab);
    expect(errors).toEqual([]);
  });

test("toasts and editor errors read exactly their words", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(165, testInfo);
  const f = await food(request, {
    name: `Exact bread ${tag}`,
    per100: { energy: 250 },
  });
  await page.goto(`/#/food/${f.id}`);
  const name = page.getByLabel("Name", { exact: true });
  await expect(name).toHaveValue(`Exact bread ${tag}`);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  // Nothing but the message: no stray text from empty parts.
  await expect(page.locator("#toast .toast-text")).toHaveText(
    `Saved Exact bread ${tag}`,
  );
  await expect(page.locator("#toast")).not.toContainText("null");
  // The toast comes as the saved food's screen reloads.
  await settled(page);
  await page.getByLabel("Barcode", { exact: true }).fill("12");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const status = page.locator(".actions-bar .status");
  await expect(status).toContainText("Barcode must be 4–32 digits");
  await expect(status).not.toContainText("null");
});

test("an editor's actions tab in the order they show, Save last", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(181, testInfo);
  const f = await food(request, {
    name: `Order ${tag}`,
    per100: { energy: 100 },
  });
  await page.goto(`/#/food/${f.id}`);
  const buttons = page.locator(".actions-bar > button");
  await expect(buttons.last()).toHaveText("Save");
  // Reading order (row by row, left to right) is the DOM's, so Tab follows
  // what you see.
  const boxes = await Promise.all(
    (await buttons.all()).map((b) => b.boundingBox()),
  );
  for (let i = 1; i < boxes.length; i++) {
    const [a, b] = [boxes[i - 1], boxes[i]];
    expect(b.y > a.y + 1 || (Math.abs(b.y - a.y) <= 1 && b.x > a.x)).toBe(true);
  }
  // Enter in a field still saves.
  const energy = page.getByLabel("Energy (kcal)");
  await energy.fill("120");
  await energy.press("Enter");
  await expect(page.locator("#toast .toast-text")).toHaveText(
    `Saved Order ${tag}`,
  );
});

test("an activity opened from the Activity tab stays in that tab", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag } = unique(187, testInfo);
  const pid = await ownProfile(page, request, `Tabs ${tag}`);
  const res = await request.post(`/api/profiles/${pid}/activities`, {
    data: { day, name: `Swim ${tag}`, minutes: 30 },
  });
  expect(res.ok()).toBeTruthy();
  const tabs = page.getByRole("navigation", { name: "Main" });
  await page.goto("/#/activities");
  await page.getByRole("link", { name: starts(`Swim ${tag}`) }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: `Swim ${tag}` }),
  ).toBeVisible();
  await expect(tabs.getByRole("link", { name: "Activity" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  // Back returns where it was opened.
  await page.getByRole("link", { name: "Back" }).click();
  await expect(page).toHaveURL(/#\/activities$/u);
  // The same from the Activity tab's own list.
  await page.goto("/#/activity");
  // The full list shows the same link: wait for the Activity tab itself.
  await expect(
    page.getByRole("heading", { level: 1, name: "Activity", exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: starts(`Swim ${tag}`) }).click();
  await expect(tabs.getByRole("link", { name: "Activity" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await page.getByRole("link", { name: "Back" }).click();
  await expect(page).toHaveURL(/#\/activity$/u);

  // From the diary it is a diary screen.
  await page.goto(`/#/day/${day}`);
  await page.getByRole("link", { name: starts(`Swim ${tag}`) }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: `Swim ${tag}` }),
  ).toBeVisible();
  await expect(tabs.getByRole("link", { name: "Diary" })).toHaveAttribute(
    "aria-current",
    "page",
  );
});

test("an editor reports an invalid field the way the server's are", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(188, testInfo);
  const f = await food(request, {
    name: `Valid ${tag}`,
    per100: { energy: 100 },
  });
  await page.goto(`/#/food/${f.id}`);
  const name = page.getByLabel("Name", { exact: true });
  await name.fill("");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  // In the status line, not a browser bubble.
  await expect(page.locator("form.editor")).toHaveAttribute("novalidate", "");
  await expect(
    page.locator(".actions-bar .status").getByRole("alert"),
  ).toHaveText(/^Name: \S/u);
  await expect(name).toHaveAttribute("aria-invalid", "true");
  await expect(name).toBeFocused();
  // Editing clears the report.
  await name.fill(`Valid ${tag}`);
  await expect(page.locator(".actions-bar .status")).toBeEmpty();
});

test("a slow screen shows progress and blocks the old one", async ({
  page,
}) => {
  await page.goto("/#/foods");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Foods");
  // Activity's first read of the workouts is held until released.
  let release;
  let arrived;
  const held = new Promise((r) => {
    arrived = r;
  });
  await page.route("**/api/profiles/*/workouts", async (route) => {
    arrived();
    await new Promise((r) => {
      release = r;
    });
    await route.continue();
  });
  await page.evaluate(() => {
    location.hash = "#/activity";
  });
  await held;
  const app = page.locator("#app");
  // The old screen can't be used while the new one loads; after a moment
  // it says so, with a bar that moves on the compositor (transform only).
  expect(await app.evaluate((el) => el.inert)).toBe(true);
  await expect(app).toHaveAttribute("aria-busy", "true");
  expect(
    await app.evaluate((el) => {
      const s = getComputedStyle(el, "::before");
      return [s.animationName, s.position];
    }),
  ).toEqual(["loading", "fixed"]);
  release();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Activity");
  await expect(app).not.toHaveAttribute("aria-busy");
  expect(await app.evaluate((el) => el.inert)).toBe(false);
  // Each render is measured, by its address.
  expect(
    await page.evaluate(() =>
      performance.getEntriesByType("measure").map((m) => m.name),
    ),
  ).toEqual(expect.arrayContaining(["render #/foods", "render #/activity"]));
});

test("every address builder has a route", async ({ page }) => {
  await page.goto("/#/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  const missing = await page.evaluate(async () => {
    const main = document.querySelector('script[type="module"]').src;
    const { href, routes } = await import(new URL("nav.mjs", main));
    const d = "2030-01-01";
    const samples = {
      today: [],
      day: [d],
      select: [d, 1],
      add: [d, "Eaten"],
      log: [d, "Eaten", 1],
      logMeal: [d, "Eaten", 1],
      scan: [d, "Eaten"],
      entry: [1],
      activityEdit: [1],
      activityView: [1],
      plan: [d],
      outbox: [],
      foods: [],
      food: [{ id: 1, source: "custom" }],
      newFood: [],
      merge: [1],
      recipe: [1],
      meal: [1],
      summary: ["week", d, "body"],
      sources: ["energy", d, d],
      activity: [],
      activities: [],
      exercises: [],
      exercise: [1],
      exerciseEdit: [1],
      workout: [1],
      workoutEdit: [1],
      run: [1],
      records: [],
      profile: [],
      profileEdit: [1],
      targets: [],
      habits: [],
      habit: [1],
      connections: [],
      stats: [],
      feedback: [],
    };
    const out = [];
    for (const [name, build] of Object.entries(href)) {
      const address = build(...(samples[name] ?? [])).split("?")[0];
      if (!routes.some((r) => r.re.test(address))) out.push(address);
    }
    // From the Foods tab: no day, no group.
    for (const address of [href.log(d, null, 1), href.logMeal(d, null, 1)])
      if (!routes.some((r) => r.re.test(address))) out.push(address);
    return {
      out,
      unsampled: Object.keys(href).filter((k) => !(k in samples)),
    };
  });
  expect(missing.out).toEqual([]);
  expect(missing.unsampled).toEqual([]);
});

test("the server's rules come from /api/meta: the check-in scale, which types take a distance", async ({
  page,
  request,
}, testInfo) => {
  await fixedToday(page);
  const { tag } = unique(750, testInfo);
  await ownProfile(page, request, `Rules ${tag}`);
  // A server whose scale is 1–3 and whose walks take no distance.
  await mockJson(page, "**/api/meta", (real) => ({
    ...real,
    limits: { ...real.limits, check_in_scale: [1, 3] },
    activity_types: real.activity_types.map((t) => ({
      ...t,
      distance: t.key !== "walk",
    })),
  }));
  const day = todayInApp();
  await page.goto(`/#/day/${day}`);
  await page.getByRole("button", { name: "How are you today?" }).click();
  const mood = page
    .getByRole("dialog")
    .getByRole("group", { name: "Mood · 1 low, 3 high" });
  await expect(mood.getByRole("button")).toHaveText(["1", "2", "3"]);
  await page.keyboard.press("Escape");

  await page.goto(`/#/activity/new?day=${day}`);
  await page
    .getByRole("combobox", { name: "Workout", exact: true })
    .selectOption({ label: "Something else (a run, a ride…)" });
  const type = page.getByRole("combobox", { name: "Type", exact: true });
  const distance = page.getByLabel("Distance (km)");
  await type.selectOption({ label: "Walk" });
  await expect(distance).toBeHidden();
  // Every other whole-session type takes one, "Something else" too.
  for (const label of ["Run", "Other"]) {
    await type.selectOption({ label });
    await expect(distance).toBeVisible();
  }
});
