// Scale sync: Profile → Connections, the diary's Log card and the Summary
// weight chart, fed through openScale sync's webhook as the phone posts it.
// Every test uses a profile of its own; readings are at 10:00 UTC, the same
// day in any server time zone the suite runs under.

import { test, expect } from "@playwright/test";
import { answer, ownProfile, unique } from "./helpers.js";

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
  await page.getByRole("link", { name: /Connections/ }).click();
  await expect(
    page.getByRole("heading", { name: "Connections" }),
  ).toBeVisible();
  const url = page.getByRole("textbox", { name: "Webhook URL" });
  await expect(url).toHaveValue(
    new RegExp(`/api/profiles/${pid}/sync/openscale$`),
  );
  await page.getByRole("button", { name: "Copy" }).click();
  await expect(page.getByText("Copied the webhook URL")).toBeVisible();
  // The setup steps are on the card itself; no link out.
  await expect(page.getByRole("link", { name: "Sync your scale" })).toHaveCount(
    0,
  );
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    await url.inputValue(),
  );
  const steps = page.locator(".howto li");
  await expect(steps).toHaveCount(5);
  await expect(steps.nth(4)).toHaveText(
    "Run a full sync in openScale sync to bring in your history.",
  );
  await expect(card(page)).toContainText("Nothing received yet");

  // The phone syncs two users' readings: nothing applied until you choose.
  expect(
    await sync(request, pid, [
      m(1, 1, "2025-03-03", 80),
      m(2, 1, "2025-03-04", 79.8),
      m(3, 2, "2025-03-04", 60),
    ]),
  ).toEqual({ applied: 0, skipped: 0, ignored: 3 });
  await page.reload();
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
    /^Last received (just now|\d+ seconds? ago): 2 readings applied, 1 reading ignored \(not your user\)$/,
  );
  await expect(card(page)).toContainText(
    "Ignored 1 reading from openScale user “Anna” (2)",
  );
  await page.goto("/#/profile");
  await expect(page.getByRole("link", { name: /Connections/ })).toContainText(
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

test("the Log card shows the scale's composition and no ✕ on its weight", async ({
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
  await expect(body).toContainText(
    "From the scale: delete the reading in openScale to remove it.",
  );
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
    m(1, 1, "2025-03-03", 80.4, [18.5, 55, 41]),
    m(2, 1, "2025-03-05", 80.0, [18.2, 0, 0]),
    m(3, 1, "2025-03-07", 79.8, [18.0, 0, 0]),
  ]);
  const section = page.locator("section.weight");
  // A week by day, a month by week, a year by month (one week's weigh-ins:
  // a single point, no chart).
  for (const [kind, by] of [
    ["week", "day"],
    ["month", "week"],
    ["year", "month"],
  ]) {
    await page.goto(`/#/summary/body/${kind}/2025-03-05`);
    // The address changes in place: wait for this period's view.
    await expect(
      page
        .getByRole("navigation", { name: "Period" })
        .getByRole("link", { name: kind, exact: false }),
    ).toHaveAttribute("aria-current", "page");
    await expect(
      section.getByRole("heading", { name: `Weight by ${by}` }),
    ).toBeVisible();
  }
  await expect(section.getByRole("img")).toBeHidden();
  // A month by day: each weigh-in and its trend.
  await page.goto("/#/summary/body/month/2025-03-05");
  await section
    .getByRole("radiogroup", { name: "Weight by" })
    .getByRole("radio", { name: "Day" })
    .click();
  await expect(
    section.getByRole("img", {
      name: "Weight by day: each weigh-in and the 7-day trend.",
    }),
  ).toBeVisible();
  const chart = section.getByRole("radiogroup", { name: "Chart", exact: true });
  // Water and muscle came once: too few to chart, but offered.
  await expect(chart.getByRole("radio")).toHaveText([
    "Weight",
    "Body fat",
    "Water",
    "Muscle",
  ]);
  await chart.getByRole("radio", { name: "Body fat" }).click();
  await expect(
    section.getByRole("heading", { name: "Body fat by day" }),
  ).toBeVisible();
  await expect(
    section.getByRole("img", {
      name: "Body fat by day: each day's reading, in %.",
    }),
  ).toBeVisible();
});

test("typed weights alone chart without a metric choice", async ({
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
      name: "Weight by day: each weigh-in and the 7-day trend.",
    }),
  ).toBeVisible();
  await expect(section.getByRole("radiogroup", { name: "Chart" })).toHaveCount(
    0,
  );
});
