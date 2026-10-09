// The Profile tab: profiles, measurements, daily targets.

import { test, expect } from "@playwright/test";
import {
  unique,
  starts,
  answer,
  entry,
  food,
  ownProfile,
  headline,
  newProfile,
  todayInApp,
} from "./helpers.js";

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
  await page.getByLabel(/^Weight \(kg\)/).fill("65");
  await page.getByLabel("Activity").selectOption({ label: "Lightly active" });
  await page.getByRole("button", { name: "Save" }).click();
  await expect(tab(page, `Anna ${tag}`)).toBeVisible();

  await page.goto(`/#/day/${day}`);
  await expect(headline(page)).toHaveText(/^0\skcal$/);
  // EFSA: women before menopause, iron 16 mg; protein 0.83 g/kg.
  await expect(page.locator(".target", { hasText: "Iron" })).toContainText(
    /16\smg/,
  );
  await expect(page.locator(".target", { hasText: "Protein" })).toContainText(
    /54\sg/,
  );
});

test("recalculating targets follows a weight change", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(20, testInfo);
  const id = await ownProfile(page, request, `Bo ${tag}`);
  await page.goto(`/#/profile/${id}`);
  await page.getByLabel(/^Weight \(kg\)/).fill("100");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("status")).toContainText(`Saved Bo ${tag}`);
  await page.getByRole("link", { name: "Recalculate on Targets" }).click();
  await expect(page).toHaveURL(/#\/targets$/);
  await page.getByRole("button", { name: "Recalculate targets" }).click();
  expect(await answer(page, "Recalculate")).toBe("Recalculate targets?");
  await expect(page.getByText("Recalculated targets")).toBeVisible();
  const targets = await (
    await request.get(`/api/profiles/${id}/targets`)
  ).json();
  expect(targets.find((t) => t.metric === "protein").min).toBe(83);
});

test("deleting a profile asks first", async ({ page, request }, testInfo) => {
  const { tag } = unique(21, testInfo);
  const { id } = await newProfile(request, { name: `Cy ${tag}` });
  await page.goto(`/#/profile/${id}`);
  await page.getByRole("button", { name: "Delete" }).click();
  expect(await answer(page, "Delete")).toBe(`Delete Cy ${tag}?`);
  await expect(page).toHaveURL(/#\/profile$/);
  await expect(page.getByText(`Deleted Cy ${tag}`)).toBeVisible();
  expect((await request.get(`/api/profiles/${id}`)).status()).toBe(404);
});

test("targets show each macro's share of the energy target", async ({
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
    page.locator("tr", { hasText: name }).first().locator(".share");
  await expect(share("Protein")).toHaveText("20 %");
  await expect(share("Carbohydrate")).toHaveText("45 %");
  await expect(share("Fat")).toHaveText("30 %");
  // Live: editing energy re-derives the shares.
  await page.getByLabel("Energy target").fill("2500");
  await expect(share("Protein")).toHaveText("16 %");
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
    { day: todayInApp(), group: "Consumed", food_id: f.id, grams: 100 },
    other.id,
  );
  await ownProfile(page, request, `Mine ${tag}`);
  await page.goto("/#/profile");
  const current = page.locator("[aria-current=true]");
  await expect(current).toContainText(`Mine ${tag} ✓`);
  await expect(current).toContainText("In use");
  await page.getByRole("button", { name: `Use Other ${tag}` }).click();
  await expect(page).toHaveURL(/#\/$/);
  await expect(page.getByRole("status")).toContainText(
    `Now using Other ${tag}`,
  );
  await expect(page.getByText(`Kale ${tag}`)).toBeVisible();
  await expect(tab(page, `Other ${tag}`)).toBeVisible();
  await page.goto("/#/profile");
  await expect(page.locator("[aria-current=true]")).toContainText(
    `Other ${tag} ✓`,
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
  await page.getByLabel("Activity").selectOption({ label: "Not set" });
  const weight = page.getByLabel(/^Weight \(kg\)/);
  await expect(weight).toHaveValue("60");
  await expect(
    page.getByText(/^Last weighed .+\. Changing it logs today's weight\.$/),
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
  await page.getByRole("link", { name: /^Targets/ }).click();
  await expect(page.getByRole("heading", { name: "Targets" })).toBeVisible();
  const energy = page.getByLabel("Energy target");
  await energy.fill("2100");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved targets")).toBeVisible();
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
    page.getByText(/without them it starts without targets/),
  ).toBeVisible();
  await page.getByLabel("Name").fill(`Plain ${tag}`);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(tab(page, `Plain ${tag}`)).toBeVisible();
  await expect(page.locator(".actions-bar .status")).toHaveCount(0);
  await page.goto(`/#/day/${day}`);
  await expect(page.getByText(/^No targets yet\./)).toBeVisible();
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
  await expect(page.getByLabel(/^Weight \(kg\)/)).toHaveValue("80.25");
  await page.getByLabel("Height (cm)").fill("171");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(`Saved Grid ${tag}`)).toBeVisible();
  const saved = await (await request.get(`/api/profiles/${id}`)).json();
  expect(saved.height_cm).toBe(171);
  expect(saved.latest_weight_kg).toBe(80.25);
  expect(writes, "an unchanged weight isn't logged again").toEqual([]);

  // The Log card's weight dialog saves it as it is.
  await page.goto(`/#/day/${day}`);
  await page.getByRole("button", { name: /^Change weight/ }).click();
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
  const recalc = page.getByRole("button", { name: "Recalculate targets" });
  await expect(recalc).toBeDisabled();
  await expect(recalc).toHaveAccessibleDescription(
    "Needs sex, birth date, height, weight and activity (missing: weight)",
  );
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
    "Everything in this profile: diary, body, habits, workouts and targets",
  );
  await page.getByRole("link", { name: /^Targets/ }).click();
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
  const weekly = page.getByLabel("Workouts target");
  await expect(page.locator("tr", { has: weekly })).toContainText("a week");

  await page.getByLabel("Goal weight target").fill("58.5");
  await weekly.fill("3");
  await page.getByLabel("Sleep target").fill("7.5");
  const row = page.locator("tr", { hasText: `Pages ${tag}` });
  await row.getByRole("combobox").selectOption("at_least");
  await row.getByRole("spinbutton").fill("20");
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
  for (const name of ["Water (L)", "Added sugar (g)", "Salt (g)"])
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
    .locator("table.grid input[type=number]")
    .evaluateAll((els) => [
      ...new Set(
        els
          .filter((e) => e.offsetParent)
          .map((e) => Math.round(e.getBoundingClientRect().left)),
      ),
    ]);
  expect(xs).toHaveLength(1);
});
