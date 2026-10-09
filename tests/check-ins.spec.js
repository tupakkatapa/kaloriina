// Daily check-ins: the Log card's
// row and prompt, the dialog, offline, and Summary → Body.
// Every test runs on a profile of its own (check-ins are per profile, one
// a day), so today is free in each.

import { test, expect } from "@playwright/test";
import { ownProfile, todayInApp, unique } from "./helpers.js";

const card = (page) =>
  page.locator(".group", {
    has: page.getByRole("heading", { name: "Log", exact: true }),
  });
const dialogOf = (page) => page.getByRole("dialog", { name: "Check-in" });
const scale = (dialog, label) =>
  dialog.getByRole("group", { name: `${label} · 1 low, 5 high` });
const chip = (dialog, name) =>
  dialog
    .getByRole("group", { name: "Tags" })
    .getByRole("button", { name, exact: true });
const prompt = (page) =>
  card(page).getByRole("button", { name: "How are you today?" });
const toast = (page) => page.locator("#toast .toast-text");
// Check-in writes fail as if offline.
const fail = (route) => route.abort();
const KEPT = "Saved on this device; it's sent when you're back online";

const yesterday = () =>
  new Date(Date.parse(todayInApp()) - 864e5).toISOString().slice(0, 10);

const put = (request, pid, day, data) =>
  request.put(`/api/profiles/${pid}/check-ins/${day}`, { data });
const listed = async (request, pid) =>
  (await request.get(`/api/profiles/${pid}/check-ins`)).json();

// The check-in writes the page sends.
function writes(page) {
  const sent = [];
  page.on("request", (r) => {
    if (r.method() !== "GET" && r.url().includes("/check-ins/"))
      sent.push(`${r.method()} ${new URL(r.url()).pathname}`);
  });
  return sent;
}

test(`today's Log card asks "How are you today?"; the dialog saves scales and tags; the row reads them`, async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(680, testInfo);
  const pid = await ownProfile(page, request, `Feel ${tag}`);
  const today = todayInApp();
  await page.goto(`/#/day/${today}`);
  await prompt(page).click();
  const dialog = dialogOf(page);
  // Opens on the first scale; no scale or tag is set.
  await expect(
    scale(dialog, "Mood").getByRole("button", { name: "1" }),
  ).toBeFocused();
  for (const [label, value] of [
    ["Mood", "4"],
    ["Energy", "3"],
    ["Stress", "2"],
  ]) {
    const button = scale(dialog, label).getByRole("button", { name: value });
    await button.click();
    await expect(button).toHaveAttribute("aria-pressed", "true");
  }
  await chip(dialog, "travel").click();
  await expect(chip(dialog, "travel")).toHaveAttribute("aria-pressed", "true");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(toast(page)).toHaveText("Saved check-in");
  await expect(
    card(page).getByRole("button", {
      name: "Change check-in, Mood 4 · Energy 3 · Stress 2 · travel",
    }),
  ).toHaveText("Mood 4 · Energy 3 · Stress 2 · travel");
  await expect(prompt(page)).toHaveCount(0);
  expect(await listed(request, pid)).toEqual([
    { day: today, mood: 4, energy: 3, stress: 2, tags: ["travel"] },
  ]);
});

test("tapping the pressed scale clears it; an empty Save with none sends nothing", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(681, testInfo);
  const pid = await ownProfile(page, request, `Clear ${tag}`);
  await page.goto(`/#/day/${todayInApp()}`);
  const sent = writes(page);
  await prompt(page).click();
  const dialog = dialogOf(page);
  const four = scale(dialog, "Mood").getByRole("button", { name: "4" });
  await four.click();
  await expect(four).toHaveAttribute("aria-pressed", "true");
  await four.click();
  await expect(four).toHaveAttribute("aria-pressed", "false");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
  await expect(prompt(page)).toBeVisible();
  expect(sent).toEqual([]);
  expect(await listed(request, pid)).toEqual([]);
});

test("Add tag: Enter adds a pressed chip, leftover text counts, the cap disables the rest", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(682, testInfo);
  const pid = await ownProfile(page, request, `Tags ${tag}`);
  // A tag of your own from yesterday: offered, unpressed.
  await put(request, pid, yesterday(), { tags: ["extra"] });
  const today = todayInApp();
  await page.goto(`/#/day/${today}`);
  await prompt(page).click();
  const dialog = dialogOf(page);
  const input = dialog.getByRole("textbox", { name: "Add tag" });
  await expect(chip(dialog, "extra")).toHaveAttribute("aria-pressed", "false");
  // Enter adds the tag as the server will store it, and doesn't save.
  await input.fill("  Gym   Crew ");
  await input.press("Enter");
  await expect(chip(dialog, "gym crew")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(input).toHaveValue("");
  await expect(dialog).toBeVisible();
  // The same again is the same chip.
  await input.fill("GYM CREW");
  await input.press("Enter");
  await expect(chip(dialog, "gym crew")).toHaveCount(1);
  // Eight: the rest can't be picked.
  for (const name of ["sick", "poor sleep", "sore", "travel", "social"])
    await chip(dialog, name).click();
  await input.fill("late");
  await input.press("Enter");
  await expect(input).toBeEnabled();
  await chip(dialog, "period").click();
  await expect(chip(dialog, "extra")).toBeDisabled();
  await expect(input).toBeDisabled();
  // One unpressed: room again.
  await chip(dialog, "late").click();
  await expect(chip(dialog, "extra")).toBeEnabled();
  // Text left in the box counts on Save.
  await input.fill("Night Out");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(toast(page)).toHaveText("Saved check-in");
  const [, saved] = await listed(request, pid);
  expect(saved.tags.toSorted()).toEqual(
    [
      "gym crew",
      "night out",
      "period",
      "poor sleep",
      "sick",
      "social",
      "sore",
      "travel",
    ].toSorted(),
  );
});

test("editing a day keeps a tag that isn't otherwise offered", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(683, testInfo);
  const pid = await ownProfile(page, request, `Keep ${tag}`);
  // Over a year ago: not among the year's custom tags.
  const day = "2024-01-10";
  await put(request, pid, day, { mood: 2, tags: ["sick", "rare one"] });
  await page.goto(`/#/day/${day}`);
  await card(page)
    .getByRole("button", { name: "Change check-in, Mood 2 · sick · rare one" })
    .click();
  const dialog = dialogOf(page);
  await expect(chip(dialog, "rare one")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(
    scale(dialog, "Mood").getByRole("button", { name: "2" }),
  ).toHaveAttribute("aria-pressed", "true");
  await scale(dialog, "Stress").getByRole("button", { name: "5" }).click();
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(toast(page)).toHaveText("Saved check-in");
  expect(await listed(request, pid)).toEqual([
    { day, mood: 2, energy: null, stress: 5, tags: ["sick", "rare one"] },
  ]);
});

test("a past day has no prompt; + Log → Check-in opens the same dialog", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(685, testInfo);
  const pid = await ownProfile(page, request, `Past ${tag}`);
  // Long past: nothing else logged (the profile's weight is on its own).
  const day = "2024-02-01";
  await page.goto(`/#/day/${day}`);
  await expect(card(page).getByRole("heading", { name: "Log" })).toBeVisible();
  await expect(prompt(page)).toHaveCount(0);
  await expect(card(page)).toContainText("Nothing logged yet. Use + Log.");
  await card(page).getByRole("button", { name: "+ Log" }).click();
  await page
    .getByRole("dialog", { name: "Log" })
    .getByRole("button", { name: "Check-in" })
    .click();
  const dialog = dialogOf(page);
  await scale(dialog, "Energy").getByRole("button", { name: "3" }).click();
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(
    card(page).getByRole("button", { name: "Change check-in, Energy 3" }),
  ).toBeVisible();
  expect((await listed(request, pid)).map((c) => c.day)).toEqual([day]);
});

test("emptying the dialog removes it; ✕ removes it and Undo brings back its tags", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(686, testInfo);
  const pid = await ownProfile(page, request, `Empty ${tag}`);
  const today = todayInApp();
  const mine = {
    day: today,
    mood: 4,
    energy: null,
    stress: null,
    tags: ["travel", "my own"],
  };
  await put(request, pid, today, mine);
  await page.goto(`/#/day/${today}`);
  const row = card(page).getByRole("button", { name: /^Change check-in/ });
  await row.click();
  const dialog = dialogOf(page);
  await scale(dialog, "Mood").getByRole("button", { name: "4" }).click();
  await chip(dialog, "travel").click();
  await chip(dialog, "my own").click();
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(toast(page)).toHaveText("Removed check-in");
  await expect(prompt(page)).toBeVisible();
  expect(await listed(request, pid)).toEqual([]);

  await put(request, pid, today, mine);
  await page.reload();
  await card(page).getByRole("button", { name: "Remove check-in" }).click();
  await expect(toast(page)).toHaveText("Removed check-in");
  await expect(prompt(page)).toBeVisible();
  expect(await listed(request, pid)).toEqual([]);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(row).toHaveText("Mood 4 · travel · my own");
  expect(await listed(request, pid)).toEqual([mine]);
});

test("a custom tag added once is offered again on another day", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(687, testInfo);
  await ownProfile(page, request, `Custom ${tag}`);
  await page.goto(`/#/day/${yesterday()}`);
  await card(page).getByRole("button", { name: "+ Log" }).click();
  await page
    .getByRole("dialog", { name: "Log" })
    .getByRole("button", { name: "Check-in" })
    .click();
  const dialog = dialogOf(page);
  await dialog.getByRole("textbox", { name: "Add tag" }).fill("Beach Day");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(toast(page)).toHaveText("Saved check-in");

  await page.goto(`/#/day/${todayInApp()}`);
  await prompt(page).click();
  await expect(chip(dialogOf(page), "beach day")).toHaveAttribute(
    "aria-pressed",
    "false",
  );
});

test("a queued check-in prefills the dialog and hides the prompt", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(688, testInfo);
  const pid = await ownProfile(page, request, `Queued ${tag}`);
  await page.goto(`/#/day/${todayInApp()}`);
  await page.route("**/api/profiles/*/check-ins/*", fail);
  await prompt(page).click();
  let dialog = dialogOf(page);
  await scale(dialog, "Mood").getByRole("button", { name: "5" }).click();
  await chip(dialog, "social").click();
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(page.locator("#toast")).toContainText(KEPT);
  // The server has none, yet the row reads what waits.
  expect(await listed(request, pid)).toEqual([]);
  await expect(prompt(page)).toHaveCount(0);
  const row = card(page).getByRole("button", {
    name: "Change check-in, Mood 5 · social",
  });
  await row.click();
  dialog = dialogOf(page);
  await expect(
    scale(dialog, "Mood").getByRole("button", { name: "5" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(chip(dialog, "social")).toHaveAttribute("aria-pressed", "true");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await page.unroute("**/api/profiles/*/check-ins/*", fail);
});

test("a check-in made offline waits and is sent once back", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(689, testInfo);
  const pid = await ownProfile(page, request, `Offline ${tag}`);
  const today = todayInApp();
  await page.goto(`/#/day/${today}`);
  const stored = [];
  page.on("response", (r) => {
    if (r.request().method() === "PUT" && r.url().includes("/check-ins/"))
      stored.push(r.status());
  });
  await page.route("**/api/profiles/*/check-ins/*", fail);
  await prompt(page).click();
  const dialog = dialogOf(page);
  await scale(dialog, "Stress").getByRole("button", { name: "2" }).click();
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(page.locator("#toast")).toContainText(KEPT);
  const waiting = page.locator(".group", {
    has: page.getByRole("heading", { name: "Waiting to send" }),
  });
  await expect(waiting).toContainText("Check-in");

  await page.unroute("**/api/profiles/*/check-ins/*", fail);
  await page.evaluate(async () => {
    const main = document.querySelector('script[type="module"]').src;
    return (await import(new URL("api.mjs", main))).flush();
  });
  await expect
    .poll(() => listed(request, pid))
    .toEqual([{ day: today, mood: null, energy: null, stress: 2, tags: [] }]);
  await expect(waiting).toHaveCount(0);
  // Sent once: the server answered one PUT.
  expect(stored).toEqual([200]);
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem("outbox"))),
  ).toEqual([]);
});

// March 2025: five check-ins.
const MARCH = [
  { day: "2025-03-03", mood: 5, energy: 2, stress: 1, tags: ["travel"] },
  { day: "2025-03-04", mood: 2, energy: 4, tags: ["travel", "sick"] },
  { day: "2025-03-05", mood: 5, energy: 3 },
  { day: "2025-03-06", mood: 2, stress: 3, tags: ["social"] },
  { day: "2025-03-07", tags: ["sick", "travel"] },
];

test("Summary → Body: the calendar switches Mood · Energy · Stress, with tiles and tag counts; the pick is kept", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(690, testInfo);
  const pid = await ownProfile(page, request, `Body ${tag}`);
  for (const { day, ...c } of MARCH) await put(request, pid, day, c);
  await page.goto("/#/summary/body/month/2025-03-15");
  const section = page.locator("section.check-ins");
  await expect(
    section.getByRole("heading", { name: "Check-ins" }),
  ).toBeVisible();
  await expect(
    section.getByRole("list", { name: "Check-ins" }).getByRole("listitem"),
  ).toHaveText(["3.5 mood", "3.0 energy", "2.0 stress", "5 check-ins"]);
  const pick = section.getByRole("radiogroup", { name: "Check-in calendar" });
  await expect(pick.getByRole("radio")).toHaveText([
    "Mood",
    "Energy",
    "Stress",
  ]);
  await expect(pick.getByRole("radio", { name: "Mood" })).toBeChecked();
  const cal = section.locator("table.check-in-cal");
  await expect(cal.locator("caption")).toHaveText("Mood by day");
  await expect(cal.locator('[data-day="2025-03-03"]')).toHaveClass(
    /\bshade-4\b/,
  );
  await expect(cal.locator('[data-day="2025-03-03"] .cal-amount')).toHaveText(
    "5",
  );
  await expect(cal.locator('[data-day="2025-03-04"]')).toHaveClass(
    /\bshade-1\b/,
  );
  // A day with a check-in but no mood: plain; without one: hatched.
  await expect(cal.locator('[data-day="2025-03-07"]')).toHaveClass(
    "cal-cell shade-0",
  );
  await expect(cal.locator('[data-day="2025-03-08"]')).toHaveClass(
    "cal-cell shade-0 none",
  );
  const extremes = section.getByRole("list", {
    name: "Mood, highest and lowest",
  });
  await expect(extremes.getByRole("listitem")).toHaveText([
    "5 highest mood, on 2 days, latest Mar 5",
    "2 lowest mood, on 2 days, latest Mar 6",
  ]);
  await expect(extremes.getByRole("link", { name: "Mar 5" })).toHaveAttribute(
    "href",
    "#/day/2025-03-05",
  );
  await expect(
    section.getByRole("list", { name: "Tags" }).getByRole("listitem"),
  ).toHaveText(["travel3", "sick2", "social1"]);

  await pick.getByRole("radio", { name: "Energy" }).click();
  await expect(cal.locator("caption")).toHaveText("Energy by day");
  await expect(extremes).toHaveCount(0);
  await expect(
    section.getByRole("list", { name: "Energy, highest and lowest" }),
  ).toContainText("4 highest energy, on 1 day, latest Mar 4");
  await page.reload();
  await expect(
    section
      .getByRole("radiogroup", { name: "Check-in calendar" })
      .getByRole("radio", { name: "Energy" }),
  ).toBeChecked();
  await expect(section.locator("table.check-in-cal caption")).toHaveText(
    "Energy by day",
  );
});

test("Summary → Body: a kept pick with no data falls back", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(691, testInfo);
  const pid = await ownProfile(page, request, `Fallback ${tag}`);
  await put(request, pid, "2025-04-02", { energy: 4 });
  await put(request, pid, "2025-04-03", { energy: 2, tags: ["sore"] });
  await page.addInitScript(() =>
    localStorage.setItem("checkin-metric", "stress"),
  );
  await page.goto("/#/summary/body/month/2025-04-15");
  const section = page.locator("section.check-ins");
  // One scale: no switch, its calendar.
  await expect(section.locator("table.check-in-cal caption")).toHaveText(
    "Energy by day",
  );
  await expect(section.getByRole("radiogroup")).toHaveCount(0);
});

test("the check-in dialog fits 320 and 393 px: one row per scale, every target at least 44 px", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(692, testInfo);
  await ownProfile(page, request, `Fit ${tag}`);
  for (const width of [320, 393]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(`/#/day/${todayInApp()}`);
    await prompt(page).click();
    const dialog = dialogOf(page);
    await expect(dialog).toBeVisible();
    const found = await dialog.evaluate((d) => {
      const out = [];
      if (d.scrollWidth > d.clientWidth) out.push(`overflows ${d.scrollWidth}`);
      for (const g of d.querySelectorAll('[role="group"].switch')) {
        const tops = new Set(
          [...g.querySelectorAll("button")].map((b) =>
            Math.round(b.getBoundingClientRect().top),
          ),
        );
        if (tops.size !== 1) out.push(`${g.getAttribute("aria-label")} wraps`);
      }
      for (const el of d.querySelectorAll("button, input:not([type=hidden])")) {
        const r = el.getBoundingClientRect();
        if (
          r.height < 43.5 ||
          (el.matches(".switch > button") && r.width < 43.5)
        )
          out.push(
            `small ${Math.round(r.width)}×${Math.round(r.height)}: ${el.textContent || el.getAttribute("aria-label")}`,
          );
      }
      return out;
    });
    expect(found, `${width}px`).toEqual([]);
    await dialog.getByRole("button", { name: "Cancel" }).click();
  }
});
