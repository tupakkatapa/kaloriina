// Repeating daily: an entry's "Repeat daily" switch. A due day is a
// planned entry row (no id: its address is `#/entry/daily-{item}-{day}`)
// with the entry editor (Delete skips the day, Eaten ticks it, the switch
// off stops it); ticks and skips wait offline (ADR 0023).

import { expect, test } from "@playwright/test";
import {
  answer,
  entry,
  food,
  ownProfile,
  save,
  starts,
  unique,
} from "./helpers.js";

const section = (page, name) =>
  page.locator(".group", {
    has: page.getByRole("heading", { name, exact: true }),
  });

const dayAfter = (day, n) =>
  new Date(Date.parse(day) + n * 864e5).toISOString().slice(0, 10);

// A profile of the test's own (a series shows on every later day) with
// Creatine eaten on `day`, repeated daily from `day` unless `repeat` is
// false: the profile and the entry (its series in `repeat`).
async function creatine(page, request, day, tag, { repeat = true } = {}) {
  const pid = await ownProfile(page, request, `Daily ${tag}`);
  const f = await food(request, {
    name: `Creatine ${tag}`,
    per100: { creatine: 100, energy: 400 },
  });
  const {
    entries: [e],
  } = await entry(
    request,
    { day, group: "Eaten", food_id: f.id, grams: 5 },
    pid,
  );
  if (!repeat) return { pid, entry: e };
  const res = await request.patch(`/api/profiles/${pid}/entries/${e.id}`, {
    data: { repeat: { start: day } },
  });
  expect(res.ok()).toBeTruthy();
  return { pid, entry: await res.json() };
}

test("a due row is a planned entry row", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag } = unique(574, testInfo);
  const { entry: e } = await creatine(page, request, day, tag);
  const name = `Creatine ${tag}`;
  const next = dayAfter(day, 1);

  await page.goto(`/#/day/${next}`);
  const planned = section(page, "Planned");
  const row = planned.locator(".entry", { hasText: name });
  // Name, "Daily" and amount, energy; its ✓ the one button; it opens at
  // its day's address, as an entry opens at its id.
  await expect(row.locator(".muted")).toHaveText("Daily · 5 g");
  await expect(row.locator(".kcal")).toHaveText("20 kcal");
  await expect(row.getByRole("button")).toHaveCount(1);
  await expect(row.locator("a.entry-main")).toHaveAttribute(
    "href",
    `#/entry/daily-${e.repeat.id}-${next}`,
  );
  await expect(planned.locator("header .total")).toContainText("20 kcal");
  // The tick in Eaten is the same row, its own address.
  await page.goto(`/#/day/${day}`);
  const tick = section(page, "Eaten").locator(".entry", { hasText: name });
  await expect(tick.locator(".muted")).toHaveText("Daily · 5 g");
  await expect(tick.locator("a.entry-main")).toHaveAttribute(
    "href",
    `#/entry/${e.id}`,
  );
  // Selecting lists entries only: a due day has nothing to copy yet.
  await page.goto(`/#/day/${next}`);
  await expect(planned.getByRole("button", { name: /^Select/u })).toHaveCount(
    0,
  );
});

test("repeat an entry daily, then tick it, skip it, edit it and stop it", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag } = unique(760, testInfo);
  const { entry: e } = await creatine(page, request, day, tag, {
    repeat: false,
  });
  const name = `Creatine ${tag}`;
  const next = dayAfter(day, 1);

  await page.goto(`/#/entry/${e.id}`);
  const repeat = page.getByRole("checkbox", { name: "Repeat daily" });
  await expect(repeat).not.toBeChecked();
  await repeat.check();
  await save(page, `${name} repeats daily`);

  // The next day: due in Planned as a planned entry is, with its tick.
  await page.goto(`/#/day/${next}`);
  const planned = section(page, "Planned");
  const row = planned.locator(".entry", { hasText: name });
  await expect(row).toContainText("Daily · 5 g");
  await row.getByRole("button", { name: `Mark ${name} eaten` }).click();
  await expect(section(page, "Eaten")).toContainText(name);
  await expect(row).toHaveCount(0);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(row).toHaveCount(1);
  await expect(section(page, "Eaten").locator(".entry")).toHaveCount(0);

  // Opened, it is the entry editor: amount, group (no time while
  // Planned), the food's ☆ and Edit, Repeat daily on.
  await row.getByRole("link", { name: new RegExp(name, "u") }).click();
  await expect(page).toHaveURL(new RegExp(`#/entry/daily-\\d+-${next}$`, "u"));
  await expect(page.getByRole("heading", { name })).toBeVisible();
  await expect(page.getByLabel("Quantity")).toBeVisible();
  await expect(page.getByLabel("Time eaten")).toBeHidden();
  const group = page.getByRole("radiogroup", { name: "Group" });
  await expect(group.getByRole("radio", { name: "Planned" })).toBeChecked();
  await expect(page.getByRole("link", { name: "Edit food" })).toBeVisible();
  await expect(repeat).toBeChecked();

  // Delete skips the day, with Undo.
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  expect(await answer(page, "Delete")).toMatch(starts(`Delete ${name} from `));
  await expect(page).toHaveURL(new RegExp(`#/day/${next}$`, "u"));
  await expect(page.locator("#toast")).toContainText(`Skipped ${name}`);
  await expect(row).toHaveCount(0);
  await expect(planned).toContainText("Nothing planned.");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(row).toHaveCount(1);

  // A new amount on Save: every un-ticked day follows.
  await row.getByRole("link", { name: new RegExp(name, "u") }).click();
  await page.getByLabel("Quantity").fill("10");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator("#toast")).toContainText(`Saved ${name}`);
  await expect(page).toHaveURL(new RegExp(`#/day/${next}$`, "u"));
  await page.goto(`/#/day/${dayAfter(day, 2)}`);
  await expect(row).toContainText("Daily · 10 g");

  // Repeat daily off ends it.
  await row.locator(".entry-main").click();
  await repeat.uncheck();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator("#toast")).toContainText(
    `Stopped repeating ${name}`,
  );
  await expect(page).toHaveURL(new RegExp(`#/day/${dayAfter(day, 2)}$`, "u"));
  await expect(row).toHaveCount(0);
});

test("Repeat daily off stops the series, ticks stay", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag } = unique(891, testInfo);
  const { entry: e } = await creatine(page, request, day, tag);
  const name = `Creatine ${tag}`;
  const next = dayAfter(day, 1);

  // The due day's editor, at its address: Eaten ticks it.
  await page.goto(`/#/entry/daily-${e.repeat.id}-${next}`);
  await page
    .getByRole("radiogroup", { name: "Group" })
    .getByRole("radio", { name: "Eaten" })
    .click();
  await page.getByLabel("Time eaten").fill("08:15");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator("#toast")).toContainText(`Moved ${name} to Eaten`);
  await expect(page).toHaveURL(new RegExp(`#/day/${next}$`, "u"));
  const eaten = section(page, "Eaten");
  await expect(eaten).toContainText(name);
  await expect(eaten.locator(".entry")).toContainText(/8:15/u);
  await expect(
    section(page, "Planned").locator(".entry", { hasText: name }),
  ).toHaveCount(0);
  // Ticked, the day's address opens the tick.
  await page.goto(`/#/entry/daily-${e.repeat.id}-${next}`);
  await expect(page).toHaveURL(/#\/entry\/\d+$/u);

  // The tick's editor: Repeat daily off stops the series; both ticks stay
  // (unlinked: the switch is off on them).
  const repeat = page.getByRole("checkbox", { name: "Repeat daily" });
  await expect(repeat).toBeChecked();
  await repeat.uncheck();
  await save(page, `Stopped repeating ${name}`);
  for (const d of [day, next]) {
    await page.goto(`/#/day/${d}`);
    const tick = section(page, "Eaten").locator(".entry", { hasText: name });
    await expect(tick).toHaveCount(1);
    await expect(tick).not.toContainText("Daily");
  }
  await page.goto(`/#/day/${dayAfter(day, 2)}`);
  await expect(section(page, "Planned")).toContainText("Nothing planned.");
  await page.goto(`/#/entry/${e.id}`);
  await expect(repeat).not.toBeChecked();
});

test("a tick offline waits, and the due row hides meanwhile", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag } = unique(761, testInfo);
  const { pid } = await creatine(page, request, day, tag);
  const name = `Creatine ${tag}`;
  const next = dayAfter(day, 1);

  await page.goto(`/#/day/${next}`);
  const planned = section(page, "Planned");
  // Offline for the tick's POST until the flag says otherwise: unrouting
  // instead could strand a replay the app sends meanwhile mid-interception,
  // holding its outbox pass until the request times out.
  let offline = true;
  await page.route(`**/api/profiles/${pid}/entries`, (route) =>
    offline && route.request().method() === "POST"
      ? route.abort()
      : route.fallback(),
  );
  await planned.getByRole("button", { name: `Mark ${name} eaten` }).click();
  await expect(page.locator("#toast")).toContainText("Saved in this browser");
  await expect(planned.locator(".entry", { hasText: name })).toHaveCount(0);
  // Waiting in the group it goes to, not counted yet.
  await expect(
    section(page, "Eaten").locator(".entry", { hasText: "Waiting to send" }),
  ).toContainText(name);

  // Back online, the tick is sent: an Eaten entry, still not due.
  offline = false;
  await page.evaluate(() => dispatchEvent(new Event("online")));
  await expect(section(page, "Eaten")).toContainText(name);
  await expect(planned.locator(".entry", { hasText: name })).toHaveCount(0);
});

test("a skip offline waits, and the due row hides meanwhile", async ({
  page,
  request,
}, testInfo) => {
  const { day, tag } = unique(575, testInfo);
  const { pid, entry: e } = await creatine(page, request, day, tag);
  const name = `Creatine ${tag}`;
  const next = dayAfter(day, 1);
  const key = `daily-${e.repeat.id}-${next}`;

  await page.goto(`/#/entry/${key}`);
  let offline = true;
  await page.route(`**/api/profiles/${pid}/entries/${key}`, (route) =>
    offline && route.request().method() === "DELETE"
      ? route.abort()
      : route.fallback(),
  );
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await answer(page, "Delete");
  await expect(page).toHaveURL(new RegExp(`#/day/${next}$`, "u"));
  await expect(page.locator("#toast")).toContainText("Saved in this browser");
  const planned = section(page, "Planned");
  await expect(planned.locator(".entry", { hasText: name })).toHaveCount(0);
  await expect(section(page, "Waiting to send")).toContainText(`Skip ${name}`);

  // Back online, the skip is sent: still not due.
  offline = false;
  await page.evaluate(() => dispatchEvent(new Event("online")));
  await expect(section(page, "Waiting to send")).toHaveCount(0);
  await page.reload();
  await expect(planned).toContainText("Nothing planned.");
});
