// The diary's Log card and its + Log sheet: rows, the sheet's focus and links,
// today's trackers, a count kept offline at `#/`, and how the sheet fits.
// Every test uses a profile of its own.

import { test, expect } from "@playwright/test";
import {
  exerciseIds,
  ownProfile,
  starts,
  todayInApp,
  unique,
  workout,
} from "./helpers.js";

const shift = (day, n) =>
  new Date(Date.parse(day) + n * 864e5).toISOString().slice(0, 10);

const logCard = (page) =>
  page.locator("section.group", {
    has: page.getByRole("heading", { name: "Log", exact: true }),
  });

const sheet = (page) => page.getByRole("dialog", { name: "Log" });

async function openSheet(page) {
  await logCard(page).getByRole("button", { name: "+ Log" }).click();
  await expect(sheet(page)).toBeVisible();
}

async function tracker(request, pid, name) {
  const res = await request.post(`/api/profiles/${pid}/habits`, {
    data: { name, unit: "pouches" },
  });
  expect(res.status()).toBe(201);
  return res.json();
}

// Writes fail as if offline; reads go through.
const fail = (route) =>
  route.request().method() === "GET" ? route.fallback() : route.abort();

const put = async (request, path, data) =>
  expect((await request.put(path, { data })).ok()).toBeTruthy();

test("rows: each kind in order, in a list, every control named", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(512, testInfo);
  const pid = await ownProfile(page, request, `Rows ${tag}`);
  const day = shift(todayInApp(), -3);
  const base = `/api/profiles/${pid}`;

  // Nothing yet: the heading, + Log and the hint, no list.
  await page.goto(`/#/day/${day}`);
  const card = logCard(page);
  await expect(card.getByRole("button", { name: "+ Log" })).toHaveAttribute(
    "aria-haspopup",
    "dialog",
  );
  await expect(card.locator("p.muted")).toHaveText(
    "Nothing logged yet. Use + Log.",
  );
  await expect(card.getByRole("list")).toHaveCount(0);

  const id = await exerciseIds(request);
  const w = await workout(request, {
    name: `Plan ${tag}`,
    steps: [{ kind: "exercise", exercise_id: id("Push-up"), reps: 5 }],
  });
  expect(
    (
      await request.post(`${base}/plans`, {
        data: { day, workout_id: w.id },
      })
    ).ok(),
  ).toBeTruthy();
  expect(
    (
      await request.post(`${base}/sessions`, {
        data: { day, name: `Walk ${tag}`, minutes: 30, kcal: 90 },
      })
    ).ok(),
  ).toBeTruthy();
  await put(request, `${base}/weights/${day}`, { kg: 72.4 });
  await put(request, `${base}/measurements/${day}/waist`, { value: 80 });
  const snus = await tracker(request, pid, "Snus");
  await put(request, `${base}/habits/${snus.id}/days/${day}`, { amount: 3 });
  await put(request, `${base}/notes/${day}`, { text: `Tired ${tag}` });
  await page.reload();

  await expect(card.locator(".log-row .kind")).toHaveText([
    "Planned workout",
    "Workout",
    "Weight",
    "Waist",
    "Note",
  ]);
  // Every row is a list item, the tracker between waist and note.
  const rows = card.getByRole("list").getByRole("listitem");
  await expect(rows).toHaveCount(6);
  await expect(rows.nth(4)).toHaveClass(/habit-row/);
  await expect(
    card.getByRole("button", { name: /^Change weight, 72\.4\skg/ }),
  ).toBeVisible();
  await expect(
    card.getByRole("button", { name: /^Change measurements, Waist 80\scm/ }),
  ).toBeVisible();
  await expect(
    card.getByRole("button", { name: starts(`Tired ${tag}`) }),
  ).toBeVisible();
  await expect(
    card.getByRole("link", { name: starts(`Walk ${tag}`) }),
  ).toContainText("90 kcal");
  const unnamed = await card.evaluate((el) =>
    [...el.querySelectorAll("a, button")]
      .filter((c) => !(c.getAttribute("aria-label") || c.textContent).trim())
      .map((c) => c.outerHTML),
  );
  expect(unnamed).toEqual([]);
});

test("today lists every active tracker; other days only counted ones", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(513, testInfo);
  const pid = await ownProfile(page, request, `Today ${tag}`);
  await tracker(request, pid, "Snus");
  await page.goto("/#/");
  const card = logCard(page);
  await expect(card.getByRole("button", { name: /^Snus: / })).toHaveText(
    /^0\spouches$/,
  );
  // One tap counts, right in the card.
  await card.getByRole("button", { name: "One more Snus" }).click();
  await expect(card.getByRole("button", { name: /^Snus: / })).toHaveText(
    /^1\spouches$/,
  );

  await page.goto(`/#/day/${shift(todayInApp(), -1)}`);
  await expect(card.getByRole("button", { name: "+ Log" })).toBeVisible();
  await expect(card.locator(".habit-row")).toHaveCount(0);
});

test("a count kept offline at #/ keeps the address and the open sheet", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(514, testInfo);
  const pid = await ownProfile(page, request, `Kept ${tag}`);
  await tracker(request, pid, "Snus");
  await page.goto("/#/");
  const glob = `**/api/profiles/${pid}/habits/*/days/*`;
  await page.route(glob, fail);
  await openSheet(page);
  const more = sheet(page).getByRole("button", { name: "One more Snus" });
  await more.click();
  await expect(page.locator("#toast")).toContainText("Saved on this device");
  await expect(page).toHaveURL(/#\/$/);
  await expect(sheet(page)).toBeVisible();
  await expect(more).toBeFocused();
  const row = sheet(page).locator(".habit-row");
  await expect(row.getByRole("button", { name: /^Snus: / })).toHaveText(
    /^1\spouches$/,
  );
  await expect(row).toContainText("Waiting to send");

  // Sent: the note goes.
  await page.unroute(glob, fail);
  await page.evaluate(async () => {
    const main = document.querySelector('script[type="module"]').src;
    return (await import(new URL("api.mjs", main))).flush();
  });
  await expect(row).not.toContainText("Waiting to send");
  await sheet(page).getByRole("button", { name: "Done" }).click();
  await expect(
    logCard(page).getByRole("button", { name: /^Snus: / }),
  ).toHaveText(/^1\spouches$/);
  await expect(
    logCard(page).getByRole("button", { name: "+ Log" }),
  ).toBeFocused();
});

test("trackers failing to load say so in the card and the sheet", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(515, testInfo);
  await ownProfile(page, request, `Fail ${tag}`);
  await page.route("**/api/profiles/*/habits", (route) =>
    route.fulfill({ status: 500, json: { error: "habits on fire" } }),
  );
  await page.goto(`/#/day/${shift(todayInApp(), -1)}`);
  await expect(logCard(page)).toContainText("Habits couldn't load");
  await openSheet(page);
  await expect(sheet(page).getByRole("alert")).toHaveText("habits on fire");
});

test("the sheet: focus, Esc and Done, its links, and its dialogs", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(516, testInfo);
  await ownProfile(page, request, `Sheet ${tag}`);
  const day = shift(todayInApp(), -1);
  await page.goto(`/#/day/${day}`);
  const add = logCard(page).getByRole("button", { name: "+ Log" });
  await openSheet(page);
  await expect(page.locator("#log-sheet-title")).toHaveText("Log");
  const first = sheet(page).getByRole("link", {
    name: starts("Log a workout done"),
  });
  await expect(first).toBeFocused();
  // Tab never reaches the page behind.
  for (let i = 0; i < 15; i += 1) {
    await page.keyboard.press("Tab");
    expect(
      await page.evaluate(() => {
        const d = document.querySelector("dialog.sheet");
        return (
          d.contains(document.activeElement) ||
          document.activeElement === document.body
        );
      }),
    ).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(sheet(page)).toHaveCount(0);
  await expect(add).toBeFocused();
  await openSheet(page);
  await sheet(page).getByRole("button", { name: "Done" }).click();
  await expect(sheet(page)).toHaveCount(0);
  await expect(add).toBeFocused();

  // The workout links.
  await openSheet(page);
  for (const [name, href] of [
    ["Log a workout done", `#/session/new?day=${day}`],
    ["Plan a workout", `#/plan/${day}`],
    ["Start a saved workout", `#/plan/${day}?start=1`],
  ])
    await expect(
      sheet(page).getByRole("link", { name: starts(name) }),
    ).toHaveAttribute("href", href);
  await first.click();
  await expect(page).toHaveURL(new RegExp(`#/session/new\\?day=${day}$`));
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // Each per-day record: its own dialog naming the day, the sheet closed.
  for (const [item, title] of [
    ["Weight", /^Weight on /],
    ["Measurements", /^Measurements on /],
    ["Check-in", /^Check-in on /],
    ["Note", /^Note on /],
  ]) {
    await page.goto(`/#/day/${day}`);
    await openSheet(page);
    await sheet(page)
      .getByRole("button", { name: starts(item) })
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(1);
    await expect(page.getByRole("dialog", { name: title })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  }

  // A day ahead: nothing that can't be written ahead.
  await page.goto(`/#/day/${shift(todayInApp(), 2)}`);
  await openSheet(page);
  for (const item of ["Weight", "Measurements", "Note"])
    await expect(
      sheet(page).getByRole("button", { name: starts(item) }),
    ).toHaveCount(0);
});

test("Start a saved workout lists those with steps and runs one on the day", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(517, testInfo);
  await ownProfile(page, request, `Starter ${tag}`);
  const id = await exerciseIds(request);
  const w = await workout(request, {
    name: `Go ${tag}`,
    steps: [{ kind: "exercise", exercise_id: id("Push-up"), reps: 5 }],
  });
  // The API never stores one without steps: answer one beside it.
  await page.route("**/api/workouts", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const res = await route.fetch();
    const list = await res.json();
    return route.fulfill({
      response: res,
      json: [
        ...list,
        { ...w, id: w.id + 100000, name: `Go ${tag} empty`, steps: [] },
      ],
    });
  });
  const day = shift(todayInApp(), -1);
  await page.goto(`/#/day/${day}`);
  await openSheet(page);
  await sheet(page)
    .getByRole("link", { name: starts("Start a saved workout") })
    .click();
  await expect(
    page.getByRole("heading", { level: 1, name: /^Start a workout · / }),
  ).toBeVisible();
  await page.getByLabel("Search your workouts").fill(`Go ${tag}`);
  const picks = page.locator(".picker").getByRole("button", {
    name: starts(`Go ${tag}`),
  });
  await expect(picks).toHaveText([`Go ${tag}`]);
  await picks.click();
  await expect(page).toHaveURL(
    new RegExp(`#/workout/${w.id}/run\\?day=${day}$`),
  );
});

test("the sheet fits: a bottom sheet on phones, centred on a desktop", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(518, testInfo);
  const pid = await ownProfile(page, request, `Fit ${tag}`);
  await tracker(request, pid, "Layout tracker with a long name to wrap");
  const day = shift(todayInApp(), -1);
  for (const width of [320, 393, 1440]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(`/#/day/${day}`);
    await openSheet(page);
    const fit = await page.evaluate(() => {
      const d = document.querySelector("dialog.sheet");
      const box = d.getBoundingClientRect();
      const small = [...d.querySelectorAll("a, button, input")]
        .map((el) => [el, el.getBoundingClientRect()])
        .filter(([, r]) => r.width < 44 || r.height < 44)
        .map(([el]) => el.outerHTML.slice(0, 80));
      return {
        left: box.left,
        width: box.width,
        bottom: box.bottom,
        centre: box.left + box.width / 2,
        vw: innerWidth,
        vh: innerHeight,
        small,
        overflow:
          d.scrollWidth > d.clientWidth ||
          document.scrollingElement.scrollWidth > innerWidth,
      };
    });
    expect(fit.small, `${width}px`).toEqual([]);
    expect(fit.overflow, `${width}px`).toBe(false);
    if (width < 480) {
      expect(fit.left).toBeCloseTo(0, 0);
      expect(fit.width).toBeCloseTo(fit.vw, 0);
      expect(Math.abs(fit.bottom - fit.vh)).toBeLessThanOrEqual(1);
    } else expect(Math.abs(fit.centre - fit.vw / 2)).toBeLessThanOrEqual(2);
    await sheet(page).getByRole("button", { name: "Done" }).click();
  }
});

// ---------------------------------------------------------------------------
// Per-day records (DAY_RECORDS): one way to remove, undo, title and refocus.

const pretty = (day) =>
  new Date(`${day}T12:00:00`).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });

test("every record removes with a queued Undo", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(745, testInfo);
  const pid = await ownProfile(page, request, `Undo ${tag}`);
  const day = shift(todayInApp(), -2);
  const base = `/api/profiles/${pid}`;
  const records = [
    ["weight", `weights/${day}`, { kg: 70.5 }, "Remove weight"],
    ["waist", `measurements/${day}/waist`, { value: 80 }, "Remove waist"],
    ["check-in", `check-ins/${day}`, { mood: 4, tags: [] }, "Remove check-in"],
    ["note", `notes/${day}`, { text: `Note ${tag}` }, "Remove note"],
  ];
  for (const [, path, data] of records)
    await put(request, `${base}/${path}`, data);
  const read = async () => (await request.get(`${base}/day/${day}`)).json();
  const full = await read();
  await page.goto(`/#/day/${day}`);
  const card = logCard(page);
  const toast = page.locator("#toast");
  for (const [name, path, , remove] of records) {
    await card.getByRole("button", { name: remove, exact: true }).click();
    await expect(toast.locator(".toast-text")).toHaveText(`Removed ${name}`);
    await expect(
      card.getByRole("button", { name: remove, exact: true }),
    ).toHaveCount(0);
    // Undo goes through the outbox: offline, it waits, then is stored.
    const glob = `**${base}/${path}`;
    await page.route(glob, fail);
    await toast.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(toast.locator(".toast-text")).toHaveText(
      starts("Saved on this device"),
    );
    await expect(
      card.getByRole("button", { name: remove, exact: true }),
    ).toBeVisible();
    await page.unroute(glob, fail);
    await page.evaluate(async () => {
      const main = document.querySelector('script[type="module"]').src;
      return (await import(new URL("api.mjs", main))).flush();
    });
  }
  await expect.poll(read).toMatchObject({
    weight: full.weight,
    measurements: full.measurements,
    check_in: full.check_in,
    note: full.note,
  });
});

test("dialogs name the day", async ({ page, request }, testInfo) => {
  const { tag } = unique(746, testInfo);
  await ownProfile(page, request, `Titles ${tag}`);
  const day = shift(todayInApp(), -1);
  await page.goto(`/#/day/${day}`);
  for (const item of ["Weight", "Measurements", "Check-in", "Note"]) {
    await openSheet(page);
    await sheet(page)
      .getByRole("button", { name: starts(item) })
      .click();
    await expect(page.getByRole("dialog")).toHaveAccessibleName(
      `${item} on ${pretty(day)}`,
    );
    await page.keyboard.press("Escape");
  }
});

test("an emptied note is removed", async ({ page, request }, testInfo) => {
  const { tag } = unique(747, testInfo);
  const pid = await ownProfile(page, request, `Empty ${tag}`);
  const day = shift(todayInApp(), -1);
  const text = `Long day ${tag}`;
  await put(request, `/api/profiles/${pid}/notes/${day}`, { text });
  const note = async () =>
    (await (await request.get(`/api/profiles/${pid}/day/${day}`)).json()).note;
  await page.goto(`/#/day/${day}`);
  await logCard(page).getByRole("button", { name: text }).click();
  const dialog = page.getByRole("dialog");
  // Several lines, named by the dialog alone.
  const box = dialog.getByRole("textbox", { name: `Note on ${pretty(day)}` });
  await expect(box).toHaveJSProperty("tagName", "TEXTAREA");
  await expect(box).toHaveJSProperty("rows", 3);
  await box.fill("  ");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(page.locator("#toast .toast-text")).toHaveText("Removed note");
  await expect.poll(note).toBeNull();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect.poll(note).toBe(text);
});

test("focus returns to the row after save", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(748, testInfo);
  const pid = await ownProfile(page, request, `Focus ${tag}`);
  const day = shift(todayInApp(), -1);
  await put(request, `/api/profiles/${pid}/notes/${day}`, { text: "first" });
  await page.goto(`/#/day/${day}`);
  const card = logCard(page);
  await card.getByRole("button", { name: "first" }).click();
  await page.getByRole("dialog").getByRole("textbox").fill("second");
  await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
  await expect(card.getByRole("button", { name: "second" })).toBeFocused();

  // From the sheet, the new row takes focus.
  await openSheet(page);
  await sheet(page)
    .getByRole("button", { name: starts("Weight") })
    .click();
  await page.getByRole("dialog").getByLabel("Weight (kg)").fill("71");
  await page.getByRole("dialog").getByLabel("Weight (kg)").press("Enter");
  await expect(
    card.getByRole("button", { name: starts("Change weight") }),
  ).toBeFocused();

  // Removed: + Log holds it.
  await card.getByRole("button", { name: "Remove note", exact: true }).click();
  await expect(card.getByRole("button", { name: "+ Log" })).toBeFocused();
});
