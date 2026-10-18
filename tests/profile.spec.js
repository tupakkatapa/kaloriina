// The Profile tab: profiles, measurements, daily targets.

import { setTimeout as delay } from "node:timers/promises";
import { expect, test } from "@playwright/test";
import { mifflin } from "../web/expenditure.mjs";
import {
  answer,
  entry,
  fixedToday,
  food,
  newProfile,
  ownProfile,
  save,
  setTarget,
  settled,
  starts,
  todayInApp,
  unique,
} from "./helpers.js";

// One today for the whole test, in the page and here.
test.beforeEach(({ page }) => fixedToday(page));

const shift = (day, n) =>
  new Date(Date.parse(day) + n * 864e5).toISOString().slice(0, 10);

const tab = (page, name) =>
  page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: `Profile: ${name}` });

test("a failed targets save says why until edited again", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(41, testInfo);
  await ownProfile(page, request, `Saved ${tag}`);
  await page.route("**/api/profiles/*/targets", (route) =>
    route.request().method() === "PUT"
      ? route.fulfill({
          status: 400,
          json: {
            error: "Fibre must be 0–1000",
            code: "invalid",
            field: "fiber",
          },
        })
      : route.continue(),
  );
  await page.goto("/#/targets");
  await page.locator("summary", { hasText: "Other nutrients" }).click();
  const fibre = page.getByLabel("Fibre target", { exact: true });
  await fibre.fill("30");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("alert")).toHaveText("Fibre must be 0–1000");
  await expect(fibre).toHaveAttribute("aria-invalid", "true");
  await fibre.fill("35");
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("a new profile has its own diary and recommended targets", async ({
  page,
}, testInfo) => {
  const { day, tag } = unique(19, testInfo);
  await page.goto("/#/profile/new");
  await page.getByLabel("Name").fill(`Anna ${tag}`);
  await page
    .getByRole("radiogroup", { name: "Sex" })
    .getByRole("radio", { name: "Female" })
    .click();
  // 36 years old whatever year the tests run in (iron depends on age).
  await page
    .getByLabel("Birth date")
    .fill(`${new Date().getFullYear() - 36}-05-01`);
  await page.getByLabel("Height (cm)").fill("170");
  await page.getByLabel(/^Weight \(kg\)/u).fill("65");
  await page
    .getByLabel("Activity level")
    .selectOption({ label: "Lightly active" });
  await page.getByRole("button", { name: "Save" }).click();
  await expect(tab(page, `Anna ${tag}`)).toBeVisible();

  await page.goto(`/#/day/${day}`);
  await expect(page.locator(".headline")).toHaveText("Nothing logged");
  // EFSA: women before menopause, iron 16 mg; protein 0.83 g/kg.
  await expect(
    page.locator(".all-targets .target", { hasText: "Iron" }),
  ).toContainText(/16\smg/u);
  await expect(page.locator(".target", { hasText: "Protein" })).toContainText(
    /54\sg/u,
  );
});

test("recalculating targets follows a weight change", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(20, testInfo);
  const id = await ownProfile(page, request, `Bo ${tag}`);
  await page.goto(`/#/profile/${id}`);
  await page.getByLabel(/^Weight \(kg\)/u).fill("100");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("status")).toContainText(`Saved Bo ${tag}`);
  await page.getByRole("link", { name: "Recalculate on Targets" }).click();
  await expect(page).toHaveURL(/#\/targets$/u);
  await page.getByRole("button", { name: "Recalculate targets" }).click();
  expect(await answer(page, "Recalculate")).toBe("Recalculate targets?");
  await expect(page.getByText("Recalculated targets")).toBeVisible();
  const targets = await (
    await request.get(`/api/profiles/${id}/targets`)
  ).json();
  expect(targets.find((t) => t.metric === "protein").min).toBe(83);
  // Energy is the app's model's (ADR 0020), the target Needed energy plans:
  // no history, so resting energy × activity level; the macros scale with it.
  const me = await (await request.get(`/api/profiles/${id}`)).json();
  const want =
    Math.round((mifflin(me, 100, todayInApp()) * me.activity) / 10) * 10;
  expect(targets.find((t) => t.metric === "energy").value).toBe(want);
  // Fat: 30 % of that energy at 9 kcal a gram.
  expect(targets.find((t) => t.metric === "fat").value).toBeCloseTo(
    (want * 0.3) / 9,
    0,
  );
  // The share column says what it's a share of; a unit the name says
  // isn't repeated.
  await expect(
    page
      .locator("table.goals th")
      .getByRole("button", { name: "Share", exact: true }),
  ).toHaveAccessibleDescription("% of the energy target");
  await expect(
    page.getByRole("rowheader", { name: "Steps", exact: true }),
  ).toBeVisible();
});

test("deleting a profile asks first", async ({ page, request }, testInfo) => {
  const { tag } = unique(21, testInfo);
  const { id } = await newProfile(request, { name: `Cy ${tag}` });
  await page.goto(`/#/profile/${id}`);
  await page.getByRole("button", { name: "Delete" }).click();
  expect(await answer(page, "Delete")).toBe(`Delete Cy ${tag}?`);
  await expect(page).toHaveURL(/#\/profile$/u);
  await expect(page.getByText(`Deleted Cy ${tag}`)).toBeVisible();
  expect((await request.get(`/api/profiles/${id}`)).status()).toBe(404);
});

test("targets show each macro's share of the energy target, the rest on energy's row (U3-3)", async ({
  page,
}) => {
  await page.route("**/api/profiles/*/targets", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({
          json: [
            { metric: "energy", value: 2000, min: 2000, max: 2200 },
            { metric: "protein", value: 100, min: 100, max: null },
            { metric: "net_carbs", value: 225, min: 225, max: 247.5 },
            { metric: "fat", value: 66.7, min: 66.7, max: 73.4 },
            { metric: "iron", value: 11, min: 11, max: null },
          ],
        })
      : route.continue(),
  );
  await page.goto("/#/targets");
  const share = (name) =>
    page.locator("tbody tr", { hasText: name }).first().locator(".share");
  // Of the 2,000 kcal target: 400, 900 and 600 kcal; 95 % of it planned.
  await expect(share("Protein")).toHaveText("20\u00A0%");
  await expect(share("Carbs")).toHaveText("45\u00A0%");
  await expect(share("Fat")).toHaveText("30\u00A0%");
  await expect(share("Energy")).toHaveText("95\u00A0%");
  // Live: editing a macro re-derives the shares (600 of 2,000 kcal), and
  // the macros now go over the target.
  await page.getByLabel("Protein target", { exact: true }).fill("150");
  await expect(share("Protein")).toHaveText("30\u00A0%");
  await expect(share("Energy")).toHaveText("105\u00A0%");
  // Everything else is folded away.
  await expect(page.getByLabel("Iron target")).toBeHidden();
});

test("a profile deleted elsewhere falls back to another one", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(35, testInfo);
  const id = await ownProfile(page, request, `Gone ${tag}`);
  await page.goto("/#/");
  await expect(tab(page, `Gone ${tag}`)).toBeVisible();
  await request.delete(`/api/profiles/${id}`);
  await page.getByRole("link", { name: "Summary" }).click();
  await expect(tab(page, `Gone ${tag}`)).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Something went wrong" }),
  ).toHaveCount(0);
});

test("recalculating keeps the goals it doesn't recommend", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(37, testInfo);
  const id = await ownProfile(page, request, `Calc ${tag}`);
  const { rev } = await (await request.get(`/api/profiles/${id}`)).json();
  const put = await request.put(`/api/profiles/${id}/targets`, {
    data: {
      rev,
      targets: [
        { metric: "goal_weight", value: 58 },
        { metric: "steps", value: 6000 },
        { metric: "protein", value: 10 },
      ],
    },
  });
  expect(put.ok()).toBeTruthy();
  await page.goto("/#/targets");
  await page.getByRole("button", { name: "Recalculate targets" }).click();
  await answer(page, "Recalculate");
  await expect(page.getByText("Recalculated targets")).toBeVisible();
  const targets = await (
    await request.get(`/api/profiles/${id}/targets`)
  ).json();
  const of = (key) => targets.find((t) => t.metric === key);
  expect(of("goal_weight").value).toBe(58);
  expect(of("steps").value).toBe(10000);
  // 0.83 g/kg at 60 kg.
  expect(of("protein").value).toBe(49.8);
});

test("an unlisted activity level survives saving", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(38, testInfo);
  const { id } = await newProfile(request, {
    name: `Act ${tag}`,
    activity: 1.5,
  });
  await page.goto(`/#/profile/${id}`);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(`Saved Act ${tag}`)).toBeVisible();
  const saved = await (await request.get(`/api/profiles/${id}`)).json();
  expect(saved.activity).toBe(1.5);
});

test("the profiles list marks the one in use and switches", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(160, testInfo);
  const other = await newProfile(request, { name: `Other ${tag}` });
  const f = await food(request, {
    name: `Kale ${tag}`,
    per100: { energy: 50 },
  });
  await entry(
    request,
    { day: todayInApp(), group: "Eaten", food_id: f.id, grams: 100 },
    other.id,
  );
  await ownProfile(page, request, `Mine ${tag}`);
  await page.goto("/#/profile");
  const current = page.locator("[aria-current=true]");
  await expect(current).toContainText(`Mine ${tag}`);
  await expect(current.locator(".name svg")).toHaveCount(1);
  await expect(current).toContainText("In use");
  await page.getByRole("button", { name: `Use Other ${tag}` }).click();
  await expect(page).toHaveURL(/#\/$/u);
  await expect(page.getByRole("status")).toContainText(
    `Now using Other ${tag}`,
  );
  await expect(page.getByText(`Kale ${tag}`)).toBeVisible();
  await expect(tab(page, `Other ${tag}`)).toBeVisible();
  await page.goto("/#/profile");
  await expect(page.locator("[aria-current=true]")).toContainText(
    `Other ${tag}`,
  );
});

test("the profile editor saves unset choices and logs a weight change", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(161, testInfo);
  const id = await ownProfile(page, request, `Edit ${tag}`);
  await page.goto(`/#/profile/${id}`);
  await expect(page.getByRole("heading", { name: "Profile" })).toBeVisible();
  const sex = page.getByRole("radiogroup", { name: "Sex" });
  await expect(sex.getByRole("radio", { name: "Female" })).toBeChecked();
  await sex.getByRole("radio", { name: "Not set" }).click();
  await page.getByLabel("Activity level").selectOption({ label: "Not set" });
  const weight = page.getByLabel(/^Weight \(kg\)/u);
  await expect(weight).toHaveValue("60");
  await expect(
    page.getByText(/^Last weighed .+\. Changing it logs today's weight\.$/u),
  ).toBeVisible();
  await weight.fill("62.5");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(`Saved Edit ${tag}`)).toBeVisible();
  let saved = await (await request.get(`/api/profiles/${id}`)).json();
  expect(saved.sex).toBeNull();
  expect(saved.activity).toBeNull();
  const weights = await (
    await request.get(`/api/profiles/${id}/weights`)
  ).json();
  expect(weights).toContainEqual(
    expect.objectContaining({ day: todayInApp(), kg: 62.5 }),
  );

  await expect(sex.getByRole("radio", { name: "Not set" })).toBeChecked();
  await sex.getByRole("radio", { name: "Male", exact: true }).click();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(
    sex.getByRole("radio", { name: "Male", exact: true }),
  ).toBeChecked();
  await expect
    .poll(async () => (await request.get(`/api/profiles/${id}`)).json())
    .toMatchObject({ sex: "male" });
  saved = await (await request.get(`/api/profiles/${id}`)).json();
  expect(saved.activity).toBeNull();
});

test("targets save, and a stale save offers to reload", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(162, testInfo);
  const id = await ownProfile(page, request, `Targets ${tag}`);
  await page.goto("/#/profile");
  await page.getByRole("link", { name: /^Targets/u }).click();
  await expect(page.getByRole("heading", { name: "Targets" })).toBeVisible();
  // A slow re-read after Save and Reload, as under load: until it is
  // shown, the old form stays (inert), and a fill into it is lost.
  await page.route(`**/api/profiles/${id}/habits`, async (route) => {
    await delay(300);
    await route.continue();
  });
  const energy = page.getByLabel("Energy target", { exact: true });
  await energy.fill("2100");
  await save(page, "Saved targets");
  const value = async () =>
    (await (await request.get(`/api/profiles/${id}/targets`)).json()).find(
      (t) => t.metric === "energy",
    ).value;
  expect(await value()).toBe(2100);
  await expect(energy).toHaveValue("2100");

  // Changed elsewhere meanwhile: the profile's rev moves on.
  const p = await (await request.get(`/api/profiles/${id}`)).json();
  const put = await request.put(`/api/profiles/${id}`, {
    data: { ...p, height_cm: 166 },
  });
  expect(put.ok()).toBeTruthy();
  await energy.fill("2300");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  expect(await value()).toBe(2100);
  await page.getByRole("button", { name: "Reload" }).click();
  await settled(page);
  await expect(energy).toHaveValue("2100");
  await energy.fill("2300");
  await page.getByRole("button", { name: "Save" }).click();
  // The first save's toast may still show: wait for the value itself.
  await expect.poll(value).toBe(2300);
});

// How a menu row looks: its box, where and how its two lines sit, chevron.
const looks = (row) =>
  row.evaluate((el) => {
    const s = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    const name = el.querySelector(".name");
    const detail = el.querySelector(".muted");
    return {
      background: s.backgroundColor,
      border: s.borderTopWidth,
      width: box.width,
      x: box.x,
      nameX: name.getBoundingClientRect().x - box.x,
      detailX: detail.getBoundingClientRect().x - box.x,
      name: getComputedStyle(name).font,
      detail: getComputedStyle(detail).font,
      chevron: getComputedStyle(el, "::after").content,
    };
  });

test("other profiles' rows look like the menu's other rows", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(180, testInfo);
  await newProfile(request, { name: `Row ${tag}` });
  await ownProfile(page, request, `Self ${tag}`);
  await page.goto("/#/profile");
  const link = await looks(
    page.getByRole("link", { name: starts("New profile") }),
  );
  const button = await looks(
    page.getByRole("button", { name: `Use Row ${tag}` }),
  );
  expect(button).toEqual(link);
  // The one in use leads nowhere: no chevron.
  const current = await looks(page.locator(".menu-row[aria-current=true]"));
  expect(current.chevron).toBe("none");
});

test("a new profile may skip its measurements, then starts without targets", async ({
  page,
}, testInfo) => {
  const { day, tag } = unique(189, testInfo);
  await page.goto("/#/profile/new");
  await expect(
    page.getByText(/without them it starts without targets/u),
  ).toBeVisible();
  await page.getByLabel("Name").fill(`Plain ${tag}`);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(tab(page, `Plain ${tag}`)).toBeVisible();
  await expect(page.locator(".actions-bar .status")).toHaveCount(0);
  await page.goto(`/#/day/${day}`);
  await expect(page.getByText(/^No targets yet:/u)).toBeVisible();
});

test("a scale weight off the 0.1 grid saves", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(860, testInfo);
  const id = await ownProfile(page, request, `Grid ${tag}`);
  const day = todayInApp();
  const put = await request.put(`/api/profiles/${id}/weights/${day}`, {
    data: { kg: 80.25 },
  });
  expect(put.ok()).toBeTruthy();
  const writes = [];
  page.on("request", (r) => {
    if (r.method() === "PUT" && r.url().includes("/weights/"))
      writes.push(r.url());
  });

  // The profile: another field changes, the weight stays as stored.
  await page.goto(`/#/profile/${id}`);
  await expect(page.getByLabel(/^Weight \(kg\)/u)).toHaveValue("80.25");
  await page.getByLabel("Height (cm)").fill("171");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(`Saved Grid ${tag}`)).toBeVisible();
  const saved = await (await request.get(`/api/profiles/${id}`)).json();
  expect(saved.height_cm).toBe(171);
  expect(saved.latest_weight_kg).toBe(80.25);
  expect(writes, "an unchanged weight isn't logged again").toEqual([]);

  // The Log card's weight dialog saves it as it is.
  await page.goto(`/#/day/${day}`);
  await page.getByRole("button", { name: /^Change weight/u }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Weight (kg)")).toHaveValue("80.25");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
});

test("recalculate explains what's missing", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(861, testInfo);
  const { id } = await newProfile(request, {
    name: `Light ${tag}`,
    weight_kg: null,
  });
  await page.addInitScript(
    (pid) => localStorage.setItem("profile", String(pid)),
    id,
  );
  await page.goto("/#/targets");
  // An icon in the title's row.
  const recalc = page
    .locator("header.title")
    .getByRole("button", { name: "Recalculate targets" });
  await expect(recalc).toBeDisabled();
  await expect(recalc).toHaveText("");
  await expect(recalc).toHaveAccessibleDescription("Needs your weight");
  const put = await request.put(`/api/profiles/${id}/weights/${todayInApp()}`, {
    data: { kg: 100 },
  });
  expect(put.ok()).toBeTruthy();
  await page.reload();
  await expect(recalc).toBeEnabled();
  await recalc.click();
  await answer(page, "Recalculate");
  await expect(page.getByText("Recalculated targets")).toBeVisible();
  // The screen shows what was saved.
  await expect(page.getByLabel("Protein target")).toHaveValue("83");
});

test("every goal lives on Targets", async ({ page, request }, testInfo) => {
  const { tag } = unique(862, testInfo);
  const id = await ownProfile(page, request, `Goals ${tag}`);
  // No targets at all: the registry defaults apply.
  const { rev } = await (await request.get(`/api/profiles/${id}`)).json();
  const cleared = await request.put(`/api/profiles/${id}/targets`, {
    data: { rev, targets: [] },
  });
  expect(cleared.ok()).toBeTruthy();
  const habit = await (
    await request.post(`/api/profiles/${id}/habits`, {
      data: { name: `Pages ${tag}`, unit: "pages", goal_value: 5 },
    })
  ).json();
  await page.goto("/#/profile");
  await expect(
    page.getByRole("link", { name: starts(`Export Goals ${tag}`) }),
  ).toContainText(
    "Everything in this profile: Diary, Body, habits, activities and targets",
  );
  await page.getByRole("link", { name: /^Targets/u }).click();
  await expect(page.getByRole("heading", { name: "Targets" })).toBeVisible();
  for (const section of [
    "Energy and macros",
    "Body",
    "Activity",
    "Sleep",
    "Habits",
  ])
    await expect(page.getByRole("heading", { name: section })).toBeVisible();

  // Registry defaults show filled, marked as such; each row says its period.
  const steps = page.getByLabel("Steps target");
  await expect(steps).toHaveValue("10000");
  await expect(page.locator("tr", { has: steps })).toContainText("Recommended");
  await expect(page.locator("tr", { has: steps })).toContainText("a day");
  await expect(page.getByLabel("Sleep target")).toHaveValue("7");
  const weekly = page.getByLabel("Activities target");
  await expect(page.locator("tr", { has: weekly })).toContainText("a week");

  await page.getByLabel("Goal weight target").fill("58.5");
  await weekly.fill("3");
  await page.getByLabel("Sleep target").fill("7.5");
  const row = page.locator("tr", { hasText: `Pages ${tag}` });
  await row.getByRole("combobox").selectOption("at_least");
  await row.getByRole("textbox").fill("20");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved targets")).toBeVisible();

  const targets = await (
    await request.get(`/api/profiles/${id}/targets`)
  ).json();
  const of = (key) => targets.find((t) => t.metric === key);
  expect(of("goal_weight").value).toBe(58.5);
  expect(of("workouts_per_week").value).toBe(3);
  expect(of("sleep_min").value).toBe(450);
  expect(of("steps"), "a default left alone stays a default").toMatchObject({
    value: 10000,
    default: true,
  });
  const habits = await (await request.get(`/api/profiles/${id}/habits`)).json();
  expect(habits.find((x) => x.id === habit.id)).toMatchObject({
    goal_value: 20,
    goal_dir: "at_least",
  });
});

test("Targets' habit rows read as the habits do and line up at 320 px", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(963, testInfo);
  await page.setViewportSize({ width: 320, height: 800 });
  const id = await ownProfile(page, request, `Rows ${tag}`);
  await request.post(`/api/profiles/${id}/habits`, {
    data: { name: `Snus ${tag}`, unit: "pouches", goal_value: 5 },
  });
  await page.goto("/#/targets");
  const habits = page.locator("table.grid").nth(4);
  // Named as everywhere else, in the habit's unit, each a day's goal.
  for (const name of ["Hydration (L)", "Added sugar (g)", "Salt (g)"])
    await expect(
      habits.getByRole("rowheader", { name, exact: true }),
    ).toBeVisible();
  for (const row of await habits.getByRole("row").all())
    await expect(row).toContainText("a day");
  // A tracker's way is a glyph, as on the built-in rows, named in words.
  const dir = habits.getByRole("combobox", { name: `Snus ${tag} goal` });
  await expect(dir.getByRole("option")).toHaveText(["≥", "≤"]);
  await expect(dir.getByRole("option", { name: "at least" })).toHaveCount(1);
  const box = await dir.boundingBox();
  expect(await dir.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(
    true,
  );
  expect(box.width).toBeLessThan(60);
  // Every section's inputs start at one x.
  const xs = await page
    .locator("table.grid input[inputmode=decimal]")
    .evaluateAll((els) => [
      ...new Set(
        els
          .filter((e) => e.offsetParent)
          .map((e) => Math.round(e.getBoundingClientRect().left)),
      ),
    ]);
  expect(xs).toHaveLength(1);
});

// The page's own colours and its form controls' (`color-scheme`).
const colours = (page) =>
  page.evaluate(() => {
    const css = getComputedStyle(document.documentElement);
    return {
      bg: css.getPropertyValue("--bg").trim(),
      scheme: css.colorScheme,
    };
  });
const LIGHT = { bg: "#f5f5f2", scheme: "light" };
const DARK = { bg: "#121211", scheme: "dark" };
const theme = (page, name) =>
  page
    .getByRole("radiogroup", { name: "Theme" })
    .getByRole("radio", { name })
    .click();

test("a dark theme overrides a light system's and is there from the first paint", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(990, testInfo);
  await ownProfile(page, request, `Dark ${tag}`);
  // The root's classes once the page is parsed, before main.mjs runs.
  await page.addInitScript(() =>
    document.addEventListener("readystatechange", () => {
      if (document.readyState === "interactive")
        window.parsedClasses = document.documentElement.className;
    }),
  );
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/#/profile");
  await expect.poll(() => colours(page)).toEqual(LIGHT);
  await theme(page, "Dark");
  await expect.poll(() => colours(page)).toEqual(DARK);

  await page.reload();
  await expect(
    page.getByRole("radiogroup", { name: "Theme" }).getByRole("radio", {
      name: "Dark",
    }),
  ).toHaveAttribute("aria-checked", "true");
  expect(await page.evaluate(() => window.parsedClasses)).toContain("dark");
  expect(await colours(page)).toEqual(DARK);
});

test("a light theme overrides a dark system's; System follows it", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(991, testInfo);
  await ownProfile(page, request, `Light ${tag}`);
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/#/profile");
  await expect.poll(() => colours(page)).toEqual(DARK);
  await theme(page, "Light");
  await expect.poll(() => colours(page)).toEqual(LIGHT);
  await page.emulateMedia({ colorScheme: "light" });
  await page.emulateMedia({ colorScheme: "dark" });
  expect(await colours(page)).toEqual(LIGHT);

  await theme(page, "System");
  await expect.poll(() => colours(page)).toEqual(DARK);
  await page.emulateMedia({ colorScheme: "light" });
  await expect.poll(() => colours(page)).toEqual(LIGHT);
});

test("Targets: bedtime as a clock, and needed energy for a goal weight by a date, offered not set", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(56, testInfo);
  const pid = await ownProfile(page, request, `Goal ${tag}`);
  const base = `/api/profiles/${pid}`;
  const me = await (await request.get(base)).json();
  // −2 kg in 8 weeks: 15,400 kcal over 56 days, 275 a day.
  const res = await request.put(base, {
    data: { ...me, goal_date: shift(todayInApp(), 56) },
  });
  expect(res.ok()).toBeTruthy();
  await setTarget(request, pid, "goal_weight", 58);
  const energy = async () =>
    (await (await request.get(`${base}/targets`)).json()).find(
      (t) => t.metric === "energy",
    ).value;
  const before = await energy();

  await page.goto("/#/targets");
  const bed = page.getByLabel("Bedtime target");
  // The shared time field: typed in either hour cycle, read back as data.
  await expect(bed).toHaveAttribute("inputmode", "text");
  await bed.fill("23:45");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved targets")).toBeVisible();
  const bedtime = (await (await request.get(`${base}/targets`)).json()).find(
    (t) => t.metric === "bedtime",
  );
  expect([bedtime.value, bedtime.min, bedtime.max]).toEqual([1425, 1395, 15]);

  // No history: maintenance is resting energy × the activity level (as
  // Recalculate's); the goal takes 275 a day off it.
  await page.goto("/#/targets");
  const section = page.locator(".needed-energy");
  const figures = section
    .getByRole("list", { name: "Needed energy" })
    .locator(".tile");
  await expect(figures.first()).toHaveText(
    /^≈ [\d,]+\skcal\s*maintenance a day$/u,
  );
  await expect(figures.first()).toHaveAccessibleDescription(
    "What keeps your weight where it is, a day: from your measurements and activity level (PAL 1.6).",
  );
  await expect(section.locator(".needed-pace")).toHaveText(
    /^Your goal: −0\.25\skg a week\.$/u,
  );
  // Resting energy is said with its formula, one for every day.
  const resting = Math.round(mifflin(me, 60, todayInApp()) / 10) * 10;
  await expect(figures.nth(2)).toHaveText(
    new RegExp(
      `^≈ ${resting.toLocaleString("en-US")}\\skcal\\s*resting a day$`,
      "u",
    ),
  );
  await expect(section.locator(".resting-from")).toHaveText(
    /^Resting energy by Mifflin–St Jeor from your weight, height, age and sex/u,
  );
  const offer = section.getByRole("button", { name: /^Energy target → /u });
  const maintenance = mifflin(me, 60, todayInApp()) * me.activity;
  const want = Math.round((maintenance - 275) / 10) * 10;
  await expect(offer).toHaveText(
    new RegExp(`→ ${want.toLocaleString("en-US")}\\skcal$`, "u"),
  );
  expect(await energy()).toBe(before);
  await offer.click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Set target" })
    .click();
  await expect.poll(energy).toBe(want);
});

test("Targets: a goal no body reaches says so under it; an unrealistic one is only said", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(601, testInfo);
  await ownProfile(page, request, `Problems ${tag}`);
  await page.goto("/#/targets");
  const fat = page.getByLabel("Goal body fat target");
  const muscle = page.getByLabel("Goal muscle target");
  const muscleProblem = page.locator("#goal_muscle-problem");
  await expect(muscleProblem).toBeHidden();
  // 50 % muscle with 30 % fat leaves too little for bone, organs and water.
  await fat.fill("30");
  await muscle.fill("50");
  await expect(muscleProblem).toHaveText(
    "At most 43.4 % with 30 % body fat: bone, organs and water are the rest.",
  );
  await expect(muscleProblem).toHaveClass("error");
  await expect(muscle).toHaveAccessibleDescription(/^At most 43\.4\u00A0%/u);
  await muscle.fill("40");
  await expect(muscleProblem).toBeHidden();
  // Below a woman's essential fat.
  await fat.fill("10");
  await expect(page.locator("#goal_body_fat-problem")).toHaveText(
    "At least 12 %: below is essential fat for women.",
  );
  // Under resting energy: allowed, said in muted words.
  await page.getByLabel("Energy target", { exact: true }).fill("900");
  const energy = page.locator("#energy-problem");
  await expect(energy).toHaveText(
    /^Under [\d,]+\skcal, your resting energy: hard to keep/u,
  );
  await expect(energy).toHaveClass("muted");
});

test("Profile: the goal date can't be today or before", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(602, testInfo);
  const pid = await ownProfile(page, request, `Goal date ${tag}`);
  await page.goto(`/#/profile/${pid}`);
  const date = page.getByLabel("Or reach it by");
  await expect(date).toHaveAttribute("min", shift(todayInApp(), 1));
  await date.fill(todayInApp());
  expect(await date.evaluate((el) => el.validity.rangeUnderflow)).toBe(true);
  await date.fill(shift(todayInApp(), 30));
  expect(await date.evaluate((el) => el.validity.valid)).toBe(true);
});
