// Scale sync: Profile → Connections, the diary's Log card and the Summary
// weight chart, fed through openScale sync's webhook as the phone posts it.
// Every test uses a profile of its own; readings are at 10:00 UTC, the same
// day in any server time zone the suite runs under.

import { expect, test } from "@playwright/test";
import {
  answer,
  fixedToday,
  ownProfile,
  setTarget,
  todayInApp,
  unique,
} from "./helpers.js";

const shift = (day, n) =>
  new Date(Date.parse(day) + n * 864e5).toISOString().slice(0, 10);

const hook = (pid) => `/api/profiles/${pid}/sync/openscale`;

// One measurement as WebhookSync's measurementToMap writes it.
const m = (id, userId, day, weight, comp = [0, 0, 0]) => ({
  id,
  userId,
  username: userId === 1 ? "Alex" : "Anna",
  date: `${day}T10:00:00.000Z`,
  weight,
  body_fat: comp[0],
  water: comp[1],
  muscle: comp[2],
});

// Lean and bone mass come in openScale's `values[]`.
const lean = (kg, bone) => ({
  values: [
    { key: "lbm", value: kg },
    { key: "bone", value: bone },
  ],
});

async function sync(request, pid, measurements) {
  const res = await request.post(hook(pid), {
    data: { event: "insert", measurements },
  });
  expect(res.status()).toBe(200);
  return res.json();
}

// Profile `pid` bound to openScale user 1 (Alex), with `readings` synced.
async function bound(request, pid, readings) {
  await sync(request, pid, readings);
  const res = await request.put(hook(pid), { data: { user_id: 1 } });
  expect(res.ok()).toBeTruthy();
  return sync(request, pid, readings);
}

const card = (page) => page.locator(".connections");

test("Connections shows the URL and how-to, then binds a user seen", async ({
  page,
  context,
  request,
}, testInfo) => {
  const { tag } = unique(490, testInfo);
  const pid = await ownProfile(page, request, `Scale ${tag}`);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/#/profile");
  await page.getByRole("link", { name: /Connections/u }).click();
  await expect(
    page.getByRole("heading", { name: "Connections" }),
  ).toBeVisible();
  const url = page.getByRole("textbox", { name: "Webhook URL" });
  await expect(url).toHaveValue(
    new RegExp(`/api/profiles/${pid}/sync/openscale$`, "u"),
  );
  await page.getByRole("button", { name: "Copy" }).click();
  await expect(page.getByText("Copied the webhook URL")).toBeVisible();
  // The setup steps fold inside the card, with the README's section.
  await expect(page.getByRole("heading", { name: "Set up" })).toHaveCount(0);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    await url.inputValue(),
  );
  const steps = card(page).locator(".card details li");
  await expect(steps.first()).toBeHidden();
  await card(page).getByText("How to set up", { exact: true }).click();
  await expect(steps).toHaveCount(5);
  await expect(steps.nth(4)).toHaveText(
    "Run a full sync in openScale sync to bring in your history.",
  );
  await expect(
    card(page).getByRole("link", { name: "openScale setup in the README" }),
  ).toHaveAttribute("href", /#openscale$/u);
  // The steps stay inside the card's edges.
  const inside = await page.evaluate(() => {
    const li = document.querySelector(".connections details li");
    const box = li.closest(".card").getBoundingClientRect();
    const r = li.getBoundingClientRect();
    return r.left >= box.left && r.right <= box.right;
  });
  expect(inside).toBe(true);
  await expect(card(page)).toContainText("Nothing received yet");

  // The phone syncs two users' readings: nothing applied until you choose.
  expect(
    await sync(request, pid, [
      m(1, 1, "2025-03-03", 80),
      m(2, 1, "2025-03-04", 79.8),
      m(3, 2, "2025-03-04", 60),
    ]),
  ).toEqual({ applied: 0, skipped: 0, ignored: 3 });
  // Coming back from openScale sync (the page hidden, then shown again)
  // shows its users without a reload.
  await page.evaluate(() => {
    for (const state of ["hidden", "visible"]) {
      Object.defineProperty(document, "visibilityState", {
        value: state,
        configurable: true,
      });
      document.dispatchEvent(new Event("visibilitychange"));
    }
  });
  await expect(
    page.getByText("Choose which openScale user is you", { exact: true }),
  ).toBeVisible();
  await expect(card(page)).toContainText(
    "Alex (1) · 2 readings in the last sync",
  );
  await page.getByRole("button", { name: "Use Alex (1)" }).click();
  await expect(card(page)).toContainText("Your openScale user: Alex (1)");

  // The next sync applies Alex's and names Anna's as ignored.
  await sync(request, pid, [
    m(1, 1, "2025-03-03", 80),
    m(2, 1, "2025-03-04", 79.8),
    m(3, 2, "2025-03-04", 60),
  ]);
  await page.reload();
  await expect(card(page).locator(".last-received")).toHaveText(
    /^Last received (just now|\d+ seconds? ago): 2 readings applied, 1 reading ignored \(not your user\)$/u,
  );
  await expect(card(page)).toContainText(
    "Ignored 1 reading from openScale user “Anna” (2)",
  );
  await page.goto("/#/profile");
  await expect(page.getByRole("link", { name: /Connections/u })).toContainText(
    "openScale: Alex (1)",
  );
});

test("Rebind and Disconnect ask first", async ({ page, request }, testInfo) => {
  const { tag } = unique(491, testInfo);
  const pid = await ownProfile(page, request, `Rebind ${tag}`);
  await bound(request, pid, [
    m(1, 1, "2025-03-03", 80),
    m(2, 2, "2025-03-03", 60),
  ]);
  await page.goto("/#/connections");
  await page.getByRole("button", { name: "Rebind" }).click();
  await page.getByRole("button", { name: "Use Anna (2)" }).click();
  expect(await answer(page, "Cancel")).toBe("Use Anna (2) instead?");
  await expect(card(page)).toContainText("Your openScale user: Alex (1)");

  await page.getByRole("button", { name: "Disconnect" }).click();
  expect(await answer(page, "Disconnect")).toBe("Disconnect openScale?");
  await expect(card(page)).toContainText("Nothing received yet");
  // Readings and the weight they set stay.
  const weights = await (
    await request.get(`/api/profiles/${pid}/weights`)
  ).json();
  expect(weights).toContainEqual({ day: "2025-03-03", kg: 80 });
});

test("the Log card shows the scale's composition, and its weight as the value only, no ✕", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(492, testInfo);
  const pid = await ownProfile(page, request, `Body ${tag}`);
  await bound(request, pid, [m(1, 1, "2025-03-10", 80.4, [18.5, 55, 41])]);
  await page.goto("/#/day/2025-03-10");
  const body = page.locator("section.group", {
    has: page.getByRole("heading", { name: "Log", exact: true }),
  });
  await expect(body.locator(".composition")).toHaveText(
    "Body fat 18.5 % · Water 55 % · Muscle 41 %",
  );
  // No hint; the weight dialog says what a scale weight does.
  const weight = body.locator('.log-row[data-kind="weight"]');
  await expect(weight).toHaveText(/^Weight80\.4\skg$/u);
  await expect(body).not.toContainText("openScale");
  await expect(body.getByRole("button", { name: "Remove weight" })).toHaveCount(
    0,
  );

  // A typed weight keeps its ✕.
  await request.put(`/api/profiles/${pid}/weights/2025-03-11`, {
    data: { kg: 80 },
  });
  await page.goto("/#/day/2025-03-11");
  await expect(
    body.getByRole("button", { name: "Remove weight" }),
  ).toBeVisible();
  await expect(body.locator(".composition")).toHaveCount(0);
});

test("weight charts by each period's default, and switches to body composition", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(493, testInfo);
  const pid = await ownProfile(page, request, `Chart ${tag}`);
  await bound(request, pid, [
    { ...m(1, 1, "2025-03-03", 80.4, [18.5, 55, 41]), ...lean(62.1, 3.1) },
    { ...m(2, 1, "2025-03-05", 80.0, [18.2, 0, 0]), ...lean(62.0, 3.1) },
    m(3, 1, "2025-03-07", 79.8, [18.0, 0, 0]),
  ]);
  const section = page.locator("section.weight");
  // Every period charts these three weigh-ins by day: one week's, they are
  // one point by week or month, and two or more always show their trend.
  for (const kind of ["week", "month", "year"]) {
    const by = "day";
    await page.goto(`/#/summary/body/${kind}/2025-03-05`);
    // The address changes in place: wait for this period's view.
    await expect(
      page.locator('#period-pick a[aria-current="page"]'),
    ).toHaveText(kind[0].toUpperCase() + kind.slice(1));
    await expect(
      section.getByRole("heading", { name: `Weight by ${by}` }),
    ).toBeVisible();
  }
  await expect(
    section.getByRole("img", { name: /^Weight by day/u }),
  ).toBeVisible();
  // A month by day: each weigh-in and its trend.
  await page.goto("/#/summary/body/month/2025-03-05");
  await expect(
    section.getByRole("img", {
      name: "Weight by day: each weigh-in, faint, and the trend, in kg.",
    }),
  ).toBeVisible();
  const chart = section.getByRole("radiogroup", { name: "Chart", exact: true });
  // Water and muscle came once: too few to chart, but offered; the BMI
  // follows from the weigh-ins and the height, maintenance from the
  // profile. Eaten and burned are Food's chart.
  await expect(chart.getByRole("radio")).toHaveText([
    "Weight",
    "Body fat",
    "Muscle",
    "Water",
    "Lean mass",
    "Bone mass",
    "BMI",
    "Maintenance",
  ]);
  await chart.getByRole("radio", { name: "Lean mass" }).click();
  await expect(
    section.getByRole("img", {
      name: "Lean mass ≈ (scale) by day: each day's reading, faint, and the trend, in kg.",
    }),
  ).toBeVisible();
  await chart.getByRole("radio", { name: "Body fat" }).click();
  await expect(
    section.getByRole("heading", { name: "Body fat by day" }),
  ).toBeVisible();
  await expect(
    section.getByRole("img", {
      name: "Body fat ≈ (scale) by day: each day's reading, faint, and the trend, in %.",
    }),
  ).toBeVisible();
  // The BMI is the weight over the height²: the weight's trend again, so
  // its points alone, in its colour.
  await chart.getByRole("radio", { name: "BMI" }).click();
  const bmi = section.getByRole("img", {
    name: "BMI by day: each day's value, in kg/m².",
  });
  await expect(bmi).toBeVisible();
  await expect
    .poll(() =>
      bmi.evaluate((c) =>
        window.Chart.getChart(c)?.data.datasets.map((d) => d.kind),
      ),
    )
    .not.toContain("trend");
  await chart.getByRole("radio", { name: "Body fat" }).click();
  // A scale's share is its estimate, said in its legend, nothing under the
  // chart.
  await expect(section.locator(".chart-note")).toHaveCount(0);
  await expect
    .poll(() =>
      section
        .locator("canvas")
        .evaluate((c) =>
          window.Chart?.getChart(c)?.legend.legendItems.map((i) => i.text),
        ),
    )
    .toEqual(["Body fat ≈ (scale)"]);
});

test("typed weights alone chart, with what they make in the switch", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(494, testInfo);
  const pid = await ownProfile(page, request, `Plain ${tag}`);
  for (const [day, kg] of [
    ["2025-03-03", 70],
    ["2025-03-05", 69.8],
  ])
    await request.put(`/api/profiles/${pid}/weights/${day}`, {
      data: { kg },
    });
  await page.goto("/#/summary/body/week/2025-03-05");
  const section = page.locator("section.weight");
  await expect(
    section.getByRole("img", {
      name: "Weight by day: each weigh-in, faint, and the trend, in kg.",
    }),
  ).toBeVisible();
  // No scale: weight, and the BMI and maintenance the profile makes of it.
  await expect(
    section.getByRole("radiogroup", { name: "Chart" }).getByRole("radio"),
  ).toHaveText(["Weight", "BMI", "Maintenance"]);
});

test("a goal weight dashes across the Body chart, its date stretching the axis", async ({
  page,
  request,
}, testInfo) => {
  await fixedToday(page);
  const { tag } = unique(600, testInfo);
  const pid = await ownProfile(page, request, `Goal line ${tag}`);
  const base = `/api/profiles/${pid}`;
  const now = todayInApp();
  const goalDate = shift(now, 56);
  // Today's 60 kg (the profile's) and yesterday's 63: the goal, 58, sits
  // within twice their spread, so it charts as a line.
  await request.put(`${base}/weights/${shift(now, -1)}`, { data: { kg: 63 } });
  const me = await (await request.get(base)).json();
  expect(
    (await request.put(base, { data: { ...me, goal_date: goalDate } })).ok(),
  ).toBeTruthy();
  await setTarget(request, pid, "goal_weight", 58);
  // The year holding today reaches out to the goal date, 8 weeks ahead.
  await page.goto(`/#/summary/body/year/${now}`);
  const img = page
    .locator("section.weight")
    .getByRole("img", { name: /^Weight by /u });
  await expect(img).toHaveAccessibleName(
    /\. Dashed: the lines the list below names\.$/u,
  );
  await expect(page.locator("section.weight ul.sr-only li").last()).toHaveText(
    /^Goal: 58\skg$/u,
  );
  await expect
    .poll(() => img.evaluate((c) => Boolean(window.Chart?.getChart(c))))
    .toBe(true);
  const drawn = await img.evaluate((c) => {
    const chart = window.Chart.getChart(c);
    const set = (label) => chart.data.datasets.find((d) => d.label === label);
    const goal = chart.data.datasets.find((d) => d.label.startsWith("Goal"));
    return {
      labels: chart.data.labels.length,
      points: chart.data.datasets[0].data.filter((v) => v !== null).length,
      goal: { values: [...new Set(goal.data)], dash: goal.borderDash },
      path: set("Path to the goal").data.filter((v) => v !== null),
      marker: chart.config.plugins.map((x) => x.id),
    };
  });
  // One label past the weigh-ins: the goal date's, marked by its line.
  expect(drawn.labels).toBe(drawn.points + 1);
  expect(drawn.marker).toContain("goalDate");
  expect(drawn.goal.values).toEqual([58]);
  expect(drawn.goal.dash.length).toBeGreaterThan(0);
  // From the trend's latest value to the goal at the goal date.
  expect(drawn.path).toHaveLength(2);
  expect(drawn.path[1]).toBe(58);
});
