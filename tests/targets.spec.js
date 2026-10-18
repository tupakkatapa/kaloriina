// Profile → Targets: Needed energy's resting energy names its source
// (Health Connect's app, else Mifflin–St Jeor), Recalculate
// says what it still needs, and the recommendations' carbohydrate floor.

import { expect, test } from "@playwright/test";
import {
  expectFits,
  fixedToday,
  newProfile,
  ownProfile,
  save,
  settled,
  syncHealth,
  todayInApp,
  unique,
} from "./helpers.js";

// One today for the whole test, in the page and here.
test.beforeEach(({ page }) => fixedToday(page));

// A basal metabolic rate as the phone keeps it raw: `kcal` a day on `day`,
// written by app `origin`.
const bmr = (id, day, kcal, origin) => {
  const at = `${day}T06:00:00Z`;
  return {
    kind: "BasalMetabolicRate",
    id,
    start: at,
    data: {
      time: at,
      zone_offset: "Z",
      kcal_per_day: kcal,
      metadata: { data_origin: origin },
    },
  };
};

const neededTiles = (page) =>
  page
    .locator(".needed-energy")
    .getByRole("list", { name: "Needed energy" })
    .locator(".tile");

test("Targets' resting energy is Health Connect's, its app named (owner item 4)", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(1134, testInfo);
  const pid = await ownProfile(page, request, `Resting ${tag}`);
  const day = todayInApp();
  const page1 = await request.post(`/api/profiles/${pid}/sync/health/records`, {
    data: {
      device: "Galaxy S24",
      records: [bmr(`bmr-${tag}`, day, 1720, "com.sec.android.app.shealth")],
    },
  });
  expect(page1.ok()).toBeTruthy();
  await page.goto("/#/targets");
  await expect(page.locator(".resting-from")).toHaveText(
    /^Resting energy ≈ 1,720\skcal a day, from Health Connect \(Samsung Health\)\.$/u,
  );
  // The model plans from it: maintenance is 1,720 × the activity level.
  await expect(neededTiles(page).first()).toHaveText(
    /^≈ 2,750\skcal\s*maintenance a day/u,
  );
  await expect(neededTiles(page).nth(2)).toHaveText(
    /^≈ 1,720\skcal\s*resting a day$/u,
  );
});

test("Mifflin's line says Health Connect sent none only after a sync", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(1135, testInfo);
  const pid = await ownProfile(page, request, `Formula ${tag}`);
  const line = page.locator(".resting-from");
  await page.goto("/#/targets");
  await expect(line).toHaveText(
    /^Resting energy by Mifflin–St Jeor from your weight, height, age and sex: /u,
  );
  const day = todayInApp();
  const sync = await syncHealth(request, pid, {
    from: day,
    to: day,
    days: [{ day, steps: 4000 }],
  });
  expect(sync.ok()).toBeTruthy();
  await page.reload();
  await expect(line).toHaveText(
    /^Resting energy by Mifflin–St Jeor from your weight, height, age and sex \(Health Connect sent none\): /u,
  );
});

test("Recalculate says only what it still needs (UX11-N1.2)", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(1136, testInfo);
  const { id } = await newProfile(request, {
    name: `Bare ${tag}`,
    sex: null,
    birth_date: null,
    height_cm: null,
    weight_kg: null,
    activity: null,
  });
  await page.addInitScript(
    (pid) => localStorage.setItem("profile", String(pid)),
    id,
  );
  await page.goto("/#/targets");
  const recalc = page
    .locator("header.title")
    .getByRole("button", { name: "Recalculate targets" });
  await expect(recalc).toHaveAccessibleDescription(
    "Needs your sex, birth date, height, weight and activity level",
  );
});

test("recommended carbohydrate never under 45 % of energy (TEST11-13)", async ({
  request,
}, testInfo) => {
  const { tag } = unique(1137, testInfo);
  // 120 kg: protein 99.6 g is 27 % of 1,500 kcal, which leaves carbs 43 %
  // (163 g); floored at 45 %, 168.75 g, whole from 100 g up.
  const { id } = await newProfile(request, {
    name: `Heavy ${tag}`,
    weight_kg: 120,
  });
  const list = await (
    await request.get(
      `/api/profiles/${id}/recommended?day=${todayInApp()}&energy=1500`,
    )
  ).json();
  expect(list.find((t) => t.metric === "net_carbs").value).toBe(169);
});

test("Targets suggests a steps target from your last 28 days; Use saves it, or only types it beside unsaved edits", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(790, testInfo);
  const pid = await ownProfile(page, request, `Steps ${tag}`);
  const today = todayInApp();
  const back = (n) =>
    new Date(Date.parse(today) - n * 864e5).toISOString().slice(0, 10);
  // 20 days of 3,800–4,200 (median 4,000), and today's 95 so far.
  const days = Array.from({ length: 20 }, (_, i) => ({
    day: back(i + 1),
    steps: 3800 + (i % 5) * 100,
  }));
  const sync = await syncHealth(request, pid, {
    from: back(20),
    to: today,
    days: [...days, { day: today, steps: 95 }],
  });
  expect(sync.ok()).toBeTruthy();
  const steps = async () =>
    (await (await request.get(`/api/profiles/${pid}/targets`)).json()).find(
      (t) => t.metric === "steps",
    ).value;
  await page.goto("/#/targets");
  const offer = page.locator(".steps-offer");
  await expect(offer).toHaveText(
    /^Your median: 4,000\ssteps a day over the last 28 days\. Suggested: 5,000 \(\+1,000 a day, up to 10,000\)\.\s*Use 5,000$/u,
  );
  const use = page.getByRole("button", {
    name: "Use 5,000 steps as your target",
  });
  await expectFits(page);
  // Beside an unsaved edit, Use only types it: Save saves both.
  await page.getByLabel("Protein target").fill("130");
  await use.click();
  await expect(page.getByLabel("Steps target")).toHaveValue("5000");
  expect(await steps()).toBe(10_000);
  await save(page, "Saved targets");
  expect(await steps()).toBe(5000);
  await expect(offer).toHaveCount(0);
  // Set back by hand, a clean form: one tap saves.
  await page.getByLabel("Steps target").fill("10000");
  await save(page, "Saved targets");
  await use.click();
  await expect(page.locator("#toast")).toContainText("Saved targets");
  await settled(page);
  expect(await steps()).toBe(5000);
  await expect(offer).toHaveCount(0);
});
