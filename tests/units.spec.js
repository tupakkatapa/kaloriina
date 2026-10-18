// US (imperial) units on a device: what reads and is typed in lb, ft·in,
// in, mi and fl oz, while the server keeps metric and a value left as
// shown is saved back exactly (no drift through rounding).

import { expect, test } from "@playwright/test";
import { shift } from "../web/dates.mjs";
import {
  answered,
  fixedToday,
  ownProfile,
  save,
  todayInApp,
  unique,
} from "./helpers.js";

// One today for the whole test, in the page and here.
test.beforeEach(({ page }) => fixedToday(page));

const us = (page) =>
  page.addInitScript(() => localStorage.setItem("units", "us"));

test("the profile reads and saves in lb and feet and inches", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(971, testInfo);
  await us(page);
  const pid = await ownProfile(page, request, `Imperial ${tag}`);
  await page.goto("/#/profile");
  // 165 cm and 60 kg.
  await expect(page.getByRole("link", { name: /^Profile\s/u })).toContainText(
    "5 ft 5 in · 132.3 lb",
  );

  await page.goto(`/#/profile/${pid}`);
  await expect(page.getByLabel("Height, feet")).toHaveValue("5");
  await expect(page.getByLabel("Height, inches")).toHaveValue("5");
  await expect(page.getByLabel("Weight (lb)")).toHaveValue("132.3");
  await expect(page.getByLabel("Weight goal (lb/week)")).toHaveValue("0");
  // Only the name changes: height and weight go back as stored.
  await page.getByLabel("Name", { exact: true }).fill(`Imperial 2 ${tag}`);
  // The form re-reads after Save: type into the new one (save() settles).
  await save(page, "Saved");
  const saved = await (await request.get(`/api/profiles/${pid}`)).json();
  expect(saved.height_cm).toBe(165);
  expect(saved.latest_weight_kg).toBe(60);

  // A new weight and height convert once.
  await expect(page.getByLabel("Weight (lb)")).toHaveValue("132.3");
  await page.getByLabel("Weight (lb)").fill("150");
  await page.getByLabel("Height, inches").fill("10");
  // The first save's toast may still show: wait on the weight this save
  // logs, its last write.
  const logged = answered(page, "PUT", "/weights/");
  await page.getByRole("button", { name: "Save" }).click();
  await logged;
  const changed = await (await request.get(`/api/profiles/${pid}`)).json();
  expect(changed.latest_weight_kg).toBeCloseTo(68.039, 3);
  expect(changed.height_cm).toBeCloseTo(177.8, 6);
});

test("the Log card and its dialogs read lb and in, and save as stored", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(972, testInfo);
  // Weights are logged up to tomorrow.
  const day = shift(todayInApp(), -3);
  await us(page);
  const pid = await ownProfile(page, request, `Card ${tag}`);
  const at = (path) => `/api/profiles/${pid}${path}`;
  await request.put(at(`/weights/${day}`), { data: { kg: 72.4 } });
  await request.put(at(`/measurements/${day}/waist`), { data: { value: 80 } });
  await page.goto(`/#/day/${day}`);
  const card = page.locator(".log-card");
  const weight = card.getByRole("button", {
    name: /^Change weight, 159\.6\slb/u,
  });
  await expect(weight).toBeVisible();
  await expect(
    card.getByRole("button", {
      name: /^Change measurements, Waist 31\.5\sin/u,
    }),
  ).toBeVisible();

  // Saved as shown: the weight stays 72.4 kg exactly.
  await weight.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Weight (lb)")).toHaveValue("159.6");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
  const weights = await (
    await request.get(at(`/weights?from=${day}&to=${day}`))
  ).json();
  expect(weights.map((w) => w.kg)).toEqual([72.4]);

  // Measurements: waist left alone, hips typed in inches.
  await card
    .getByRole("button", { name: /^Change measurements, Waist/u })
    .click();
  await expect(dialog.getByLabel("Waist (in)")).toHaveValue("31.5");
  await dialog.getByLabel("Hips (in)").fill("40");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
  const view = await (await request.get(at(`/day/${day}`))).json();
  const value = (kind) => view.measurements.find((m) => m.kind === kind)?.value;
  expect(value("waist")).toBe(80);
  expect(value("hips")).toBeCloseTo(101.6, 6);
});

test("a run reads in miles and saves its metres as they were", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag } = unique(973, testInfo);
  await us(page);
  const pid = await ownProfile(page, request, `Miles ${tag}`);
  const res = await request.post(`/api/profiles/${pid}/activities`, {
    data: {
      day,
      name: `Run ${tag}`,
      minutes: 25,
      sets: [],
      type: "run",
      distance_m: 5000,
    },
  });
  const run = await res.json();
  await page.goto(`/#/day/${day}`);
  await expect(
    page.locator(".activity-card").getByRole("link", { name: /^Run/u }),
  ).toContainText("3.11 mi");

  await page.goto(`/#/activity/${run.id}/edit`);
  await expect(page.getByLabel("Distance (mi)")).toHaveValue("3.11");
  await page.getByLabel("Name", { exact: true }).fill(`Run 2 ${tag}`);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.locator("#toast")).toContainText("Saved");
  const saved = await (
    await request.get(`/api/profiles/${pid}/activities/${run.id}`)
  ).json();
  expect(saved.distance_m).toBe(5000);
});

test("water is asked in fl oz, a glass and a bottle a tap away", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag } = unique(974, testInfo);
  await us(page);
  await ownProfile(page, request, `Ounces ${tag}`);
  await page.goto(`/#/add/${day}/Eaten`);
  await page.getByRole("button", { name: /^Water/u }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "8 fl oz" }).click();
  await expect(dialog.getByLabel("Amount (fl oz)")).toHaveValue("8");
});

// A Finnish browser types a decimal comma: it is a decimal, never dropped
// ("1,5" was stored as 15). A grouping separator is refused, not guessed.
test.describe("in a fi-FI browser", () => {
  test.use({ locale: "fi-FI" });

  test("a decimal comma is a decimal", async ({ page, request }, testInfo) => {
    const { day, tag } = unique(244, testInfo);
    const pid = await ownProfile(page, request, `Pilkku ${tag}`);
    const f = await (
      await request.post("/api/foods", {
        data: {
          name: `Oats ${tag}`,
          per100: { energy: 380 },
          servings: [{ label: "portion", grams: 150 }],
        },
      })
    ).json();
    await page.goto(`/#/log/${day}/Eaten/${f.id}`);
    await page.getByLabel("Quantity").fill("1,5");
    await page.getByRole("button", { name: "Add to Eaten" }).click();
    await expect(page).toHaveURL(new RegExp(`#/day/${day}`, "u"));
    const view = await (
      await request.get(`/api/profiles/${pid}/day/${day}`)
    ).json();
    expect(view.groups.flatMap((g) => g.entries).map((e) => e.grams)).toEqual([
      225,
    ]);

    await page.goto(`/#/profile/${pid}`);
    const weight = page.getByLabel("Weight (kg)");
    await weight.fill("1 234,5");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(weight).toHaveAttribute("aria-invalid", "true");
    await weight.fill("72,5");
    const logged = answered(page, "PUT", "/weights/");
    await page.getByRole("button", { name: "Save" }).click();
    await logged;
    const saved = await (await request.get(`/api/profiles/${pid}`)).json();
    expect(saved.latest_weight_kg).toBe(72.5);
  });
});
