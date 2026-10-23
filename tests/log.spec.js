// The diary's Log card and its + Log sheet: rows, the sheet's focus and links,
// today's trackers, a count kept offline at `#/`, and how the sheet fits.
// Every test uses a profile of its own.

import { expect, test } from "@playwright/test";
import {
  exerciseIds,
  expectFits,
  fixedToday,
  ownProfile,
  starts,
  todayInApp,
  unique,
  workout,
} from "./helpers.js";

// One today for the whole test, in the page and here.
test.beforeEach(({ page }) => fixedToday(page));

const shift = (day, n) =>
  new Date(Date.parse(day) + n * 864e5).toISOString().slice(0, 10);

const logCard = (page) =>
  page.locator("section.group", {
    has: page.getByRole("heading", { name: "Log", exact: true }),
  });

// Eaten's foot: what the day's food held, Hydration first.
const totals = (page) =>
  page.getByRole("list", { name: "Day's totals from food" });

const sheet = (page) => page.getByRole("dialog", { name: "Log" });

async function openSheet(page) {
  await logCard(page)
    .getByRole("button", { name: /^Log on /u })
    .click();
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

  // Nothing yet: the heading, + and the hint, no list.
  await page.goto(`/#/day/${day}`);
  const card = logCard(page);
  await expect(card.getByRole("button", { name: /^Log on /u })).toHaveAttribute(
    "aria-haspopup",
    "dialog",
  );
  await expect(card.locator("p.muted")).toHaveText("Nothing logged.");
  await expect(card.getByRole("list")).toHaveCount(0);

  // Activities are the Activity card's, never the Log's.
  expect(
    (
      await request.post(`${base}/activities`, {
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
    "Weight",
    "Waist",
    "Note",
  ]);
  await expect(card).not.toContainText(`Walk ${tag}`);
  // Every row is a list item, the tracker between waist and note; no
  // sub-heads.
  const rows = card.locator(".log-rows > *");
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(2)).toHaveClass(/habit-row/u);
  await expect(card.locator(".log-head")).toHaveCount(0);
  await expect(
    card.getByRole("button", { name: /^Change weight, 72\.4\skg/u }),
  ).toBeVisible();
  await expect(
    card.getByRole("button", { name: /^Change measurements, Waist 80\scm/u }),
  ).toBeVisible();
  await expect(
    card.getByRole("button", { name: starts(`Tired ${tag}`) }),
  ).toBeVisible();
  const unnamed = await card.evaluate((el) =>
    [...el.querySelectorAll("a, button")]
      .filter((c) => !(c.getAttribute("aria-label") || c.textContent).trim())
      .map((c) => c.outerHTML),
  );
  expect(unnamed).toEqual([]);
});

test("one_registration_gives_row_and_button: a day record's section places its rows", async ({
  page,
}) => {
  await page.goto("/#/");
  await expect(page.locator(".log-card")).toBeVisible();
  const placed = await page.evaluate(async () => {
    const main = document.querySelector('script[type="module"]').src;
    const { cardSections } = await import(new URL("screens/log.mjs", main));
    // A new record, registered once: its section gives it rows, after what
    // the section shows already.
    const rec = {
      kind: "x",
      section: "Day",
      label: "X",
      keys: () => [null],
      path: () => "/x",
      fromDay: () => null,
      row: () => "x row",
    };
    const day = cardSections([rec]).find(([head]) => head === "Day")[1];
    let unknown = null;
    try {
      cardSections([{ ...rec, section: "Elsewhere" }]);
    } catch (err) {
      unknown = err.message;
    }
    return { rows: day.flatMap((row) => row({})), unknown };
  });
  expect(placed.rows).toEqual(["x row", undefined]);
  expect(placed.unknown).toBe("x: no section Elsewhere");
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
  await expect(card.getByRole("button", { name: /^Snus: /u })).toHaveText(
    /^0\spouches$/u,
  );
  // One tap counts, right in the card.
  await card.getByRole("button", { name: "One more Snus" }).click();
  await expect(card.getByRole("button", { name: /^Snus: /u })).toHaveText(
    /^1\spouches$/u,
  );

  await page.goto(`/#/day/${shift(todayInApp(), -1)}`);
  await expect(card.getByRole("button", { name: /^Log on /u })).toBeVisible();
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
  await expect(page.locator("#toast")).toContainText("Saved in this browser");
  await expect(page).toHaveURL(/#\/$/u);
  await expect(sheet(page)).toBeVisible();
  await expect(more).toBeFocused();
  const row = sheet(page).locator(".habit-row");
  await expect(row.getByRole("button", { name: /^Snus: /u })).toHaveText(
    /^1\spouches$/u,
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
    logCard(page).getByRole("button", { name: /^Snus: /u }),
  ).toHaveText(/^1\spouches$/u);
  await expect(
    logCard(page).getByRole("button", { name: /^Log on /u }),
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
  const add = logCard(page).getByRole("button", { name: /^Log on /u });
  await openSheet(page);
  await expect(page.locator("#log-sheet-title")).toHaveText("Log");
  // Activities are the Activity card's +: the Log's starts at Weight.
  const first = sheet(page).getByRole("button", { name: starts("Weight") });
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

  // Each row's chevron is an icon, centred on its row.
  await openSheet(page);
  const row = sheet(page).locator(".menu-row").first();
  const chevron = row.locator("svg.chevron");
  await expect(chevron).toHaveCount(1);
  const [r, c] = [await row.boundingBox(), await chevron.boundingBox()];
  expect(Math.abs(r.y + r.height / 2 - (c.y + c.height / 2))).toBeLessThan(2);
  await sheet(page).getByRole("button", { name: "Done" }).click();

  // No activity rows: those are the Activity card's.
  await openSheet(page);
  for (const name of [
    "Log an activity",
    "Plan a workout",
    "Start a saved workout",
  ])
    await expect(
      sheet(page).getByRole("link", { name: starts(name) }),
    ).toHaveCount(0);
  await sheet(page).getByRole("button", { name: "Done" }).click();

  // Each per-day record: its own dialog naming the day, the sheet closed.
  for (const [item, title] of [
    ["Weight", /^Weight on /u],
    ["Measurements", /^Measurements on /u],
    ["Check-in", /^Check-in on /u],
    ["Note", /^Note on /u],
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
        overflow: d.scrollWidth > d.clientWidth,
      };
    });
    expect(fit.small, `${width}px`).toEqual([]);
    expect(fit.overflow, `${width}px`).toBe(false);
    await expectFits(page);
    if (width < 480) {
      expect(fit.left).toBeCloseTo(0, 0);
      expect(fit.width).toBeCloseTo(fit.vw, 0);
      expect(Math.abs(fit.bottom - fit.vh)).toBeLessThanOrEqual(1);
    } else expect(Math.abs(fit.centre - fit.vw / 2)).toBeLessThanOrEqual(2);
    await sheet(page).getByRole("button", { name: "Done" }).click();
  }
});

// ---------------------------------------------------------------------
// Per-day records (DAY_LOGS): one way to remove, undo, title and refocus.

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
      starts("Saved in this browser"),
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
  await expect(card.getByRole("button", { name: /^Log on /u })).toBeFocused();
});

test("hydration: its own row in Eaten's totals against the water target, more on an active day, the value only", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(54, testInfo);
  const pid = await ownProfile(page, request, `Hydrated ${tag}`);
  const day = shift(todayInApp(), -2);
  const base = `/api/profiles/${pid}`;
  const { rev } = await (await request.get(base)).json();
  await put(request, `${base}/targets`, {
    rev,
    targets: [
      { metric: "water", value: 2000 },
      { metric: "sodium", value: 2000 },
      { metric: "potassium", value: 3500 },
    ],
  });
  // Beer: 450 ml of water less 10 ml a gram of its 20 g alcohol.
  const beer = await (
    await request.post("/api/foods", {
      data: {
        name: `Beer ${tag}`,
        per100: { water: 90, alcohol: 4, sodium: 40, potassium: 50 },
      },
    })
  ).json();
  expect(
    (
      await request.post(`${base}/entries`, {
        data: { day, group: "Eaten", food_id: beer.id, grams: 500 },
      })
    ).ok(),
  ).toBeTruthy();
  // An hour's run: the goal shows 0.5 L more.
  expect(
    (
      await request.post(`${base}/activities`, {
        data: { day, name: "Run", minutes: 60, type: "run" },
      })
    ).ok(),
  ).toBeTruthy();

  await page.goto(`/#/day/${day}`);
  const row = totals(page).locator(".log-row", {
    has: page.locator(".hydration"),
  });
  await expect(row.locator(".kind")).toHaveText("Hydration");
  // The goal says why it isn't the target.
  await expect(row.locator(".name")).toHaveText(
    /^250\sml\sof\s2\.5\sL\s\(2\sL\s\+\sactivity\)$/u,
  );
  // No "Approximate", no + Water, nothing to open.
  await expect(row.locator(".hydration > *")).toHaveCount(1);
  await expect(row.locator("details, button")).toHaveCount(0);
  // Hydration isn't repeated in From food; salt, no longer Hydration's
  // detail, is From food's.
  await expect(totals(page).locator(".habit-builtins")).toHaveText(
    /^Alcohol\s1\.7\sdrinks · Salt\s0\.5\sg$/u,
  );
  // At 320 px the value stays one line beside its kind.
  await page.setViewportSize({ width: 320, height: 800 });
  const [kind, value] = await Promise.all([
    row.locator(".kind").boundingBox(),
    row.locator(".hydration").boundingBox(),
  ]);
  expect(Math.abs(kind.y - value.y)).toBeLessThan(kind.height + 1);
});

test("actions in a right column, Start fitting at 320 px", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(762, testInfo);
  const pid = await ownProfile(page, request, `Columns ${tag}`);
  // Today: the plan has its Start.
  const day = todayInApp();
  const base = `/api/profiles/${pid}`;
  const id = await exerciseIds(request);
  const w = await workout(request, {
    name: `Upper body ${tag}`,
    steps: [{ kind: "exercise", exercise_id: id("Push-up"), reps: 5 }],
  });
  expect(
    (
      await request.post(`${base}/plans`, { data: { day, workout_id: w.id } })
    ).ok(),
  ).toBeTruthy();
  await put(request, `${base}/weights/${day}`, { kg: 72.4 });
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto(`/#/day/${day}`);
  const card = logCard(page);
  const activity = page.locator(".activity-card");
  // Weight and today's check-in ask (hydration is Eaten's).
  await expect(card.locator(".log-row")).toHaveCount(2);
  await expect(activity.locator(".log-row")).toHaveCount(1);

  await put(request, `${base}/measurements/${day}/waist`, { value: 80 });
  await put(request, `${base}/notes/${day}`, { text: `Tired ${tag}` });
  await page.reload();
  await expect(card.locator(".log-row")).toHaveCount(4);
  // The plan: Start, ✕ and the planned tick, one line, right of the value.
  const plan = activity.locator(".log-row.planned .actions");
  expect(
    await plan
      .locator("a, button")
      .evaluateAll((els) => els.map((e) => e.getAttribute("aria-label"))),
  ).toEqual([
    `Start Upper body ${tag}`,
    `Remove the plan for Upper body ${tag}`,
    `Log Upper body ${tag} done`,
  ]);
  const boxes = await page.evaluate(() =>
    [
      ...document.querySelectorAll(
        ":is(.log-card, .activity-card, .day-totals) .log-row",
      ),
    ].map((row) => {
      const r = row.getBoundingClientRect();
      const value = row.querySelector(".result").getBoundingClientRect();
      const actions = row.querySelector(".actions")?.getBoundingClientRect();
      const tops = [...row.querySelectorAll(".actions > *")].map(
        (c) => c.getBoundingClientRect().top,
      );
      return {
        right: actions ? Math.round(r.right - actions.right) : 0,
        apart: actions ? actions.left >= value.right - 1 : true,
        oneLine: new Set(tops).size <= 1,
        fits: row.scrollWidth <= row.clientWidth,
      };
    }),
  );
  expect(boxes).toHaveLength(6);
  for (const b of boxes)
    expect(b).toEqual({ right: 0, apart: true, oneLine: true, fits: true });

  // The tick logs the plan done: the activity editor, from the workout.
  await activity
    .getByRole("button", { name: `Log Upper body ${tag} done` })
    .click();
  await expect(page.getByRole("combobox", { name: "Workout" })).toHaveValue(
    String(w.id),
  );
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
    `Upper body ${tag}`,
  );
});

// An activity's row is its type, then its name over what it
// was; a name that only repeats the type is left out.
test("an activity's row is its type, its name over its line", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(1022, testInfo);
  const pid = await ownProfile(page, request, `Kind ${tag}`);
  const day = shift(todayInApp(), -2);
  for (const data of [
    { name: "Walk", type: "walk", minutes: 30, kcal: 90 },
    { name: "Upper body", minutes: 45, kcal: 200 },
  ]) {
    const res = await request.post(`/api/profiles/${pid}/activities`, {
      data: { day, sets: [], ...data },
    });
    expect(res.status()).toBe(201);
  }
  await page.goto(`/#/day/${day}`);
  const rows = page.locator(".activity-card .log-row");
  await expect(rows.locator(".kind")).toHaveText(["Walk", "Workout"]);
  await expect(rows.locator(".result .name")).toHaveText([
    /^30\smin · active\s\d+\skcal$/u,
    "Upper body",
  ]);
  await expect(rows.nth(1).locator(".result .muted")).toHaveText(
    /^45\smin · active\s\d+\skcal$/u,
  );
  await expect(rows.first().getByRole("link")).toHaveAttribute(
    "href",
    /^#\/activity\/\d+/u,
  );
});

// Owner (2026-10-14): a kind never runs into its value, whatever the font.
// The owner's system-ui is a wide one; a monospace font stands in for it.
test("no row's kind overlaps its value, at a phone's width or a desktop's", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(1050, testInfo);
  const pid = await ownProfile(page, request, `Kinds ${tag}`);
  const day = shift(todayInApp(), -2);
  const base = `/api/profiles/${pid}`;
  const id = await exerciseIds(request);
  const w = await workout(request, {
    name: `0.3.0 ${tag}`,
    steps: [{ kind: "exercise", exercise_id: id("Push-up"), reps: 5 }],
  });
  expect(
    (
      await request.post(`${base}/plans`, { data: { day, workout_id: w.id } })
    ).ok(),
  ).toBeTruthy();
  await put(request, `${base}/weights/${day}`, { kg: 72.4 });
  await put(request, `${base}/notes/${day}`, { text: `Tired ${tag}` });
  await page.addInitScript(() =>
    document.addEventListener("DOMContentLoaded", () =>
      document.head.append(
        Object.assign(document.createElement("style"), {
          textContent: ":root { font-family: monospace; }",
        }),
      ),
    ),
  );
  for (const width of [320, 393, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/#/day/${day}`);
    await expect(
      page.locator(".activity-card .log-row .kind").first(),
    ).toHaveText("Planned");
    const overlaps = await page.evaluate(() =>
      [
        ...document.querySelectorAll(
          ":is(.log-card, .activity-card, .day-totals) .log-row",
        ),
      ].flatMap((row) => {
        const k = row.querySelector(".kind").getBoundingClientRect();
        const v = row.querySelector(".kind + *").getBoundingClientRect();
        // Text overflowing its box: the box a kind's ink takes.
        const ink = row.querySelector(".kind");
        const right = k.left + ink.scrollWidth;
        const apart =
          right <= v.left + 0.5 ||
          k.bottom <= v.top + 0.5 ||
          v.bottom <= k.top + 0.5;
        return apart ? [] : [`${ink.textContent} over ${v.width}`];
      }),
    );
    expect(overlaps, `${width}px`).toEqual([]);
  }
});

// A measurement's limits in US units, rounded inward, so a value
// at either end the form takes is one the server takes.
test("US measurements: the bounds round inward and their ends save", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(1091, testInfo);
  const pid = await ownProfile(page, request, `Inches ${tag}`);
  await page.addInitScript(() => localStorage.setItem("units", "us"));
  const day = shift(todayInApp(), -1);
  await page.goto(`/#/day/${day}`);
  await openSheet(page);
  await sheet(page)
    .getByRole("button", { name: starts("Measurements") })
    .click();
  const dialog = page.getByRole("dialog", { name: /^Measurements on /u });
  const waist = dialog.getByLabel("Waist (in)");
  await expect(waist).toHaveAttribute("min", "7.9");
  await expect(waist).toHaveAttribute("max", "118.1");
  await waist.fill("118.1");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
  await expect
    .poll(async () => {
      const d = await (
        await request.get(`/api/profiles/${pid}/day/${day}`)
      ).json();
      return d.measurements.find((m) => m.kind === "waist")?.value;
    })
    .toBeCloseTo(299.97, 1);
});

test("a week without a weight, today's card asks to weigh in; with reminders off it doesn't", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(1167, testInfo);
  const pid = await ownProfile(page, request, `Scale ${tag}`);
  const day = todayInApp();
  // The profile's own weigh-in today goes: none in the week.
  const base = `/api/profiles/${pid}/weights`;
  expect((await request.delete(`${base}/${day}`)).ok()).toBeTruthy();
  const weighIn = logCard(page).getByRole("button", { name: "Weigh in" });
  // The tests' default is off.
  await page.goto(`/#/day/${day}`);
  await expect(logCard(page)).toBeVisible();
  await expect(weighIn).toHaveCount(0);

  await page.evaluate(() => localStorage.setItem("reminders", "true"));
  await page.reload();
  await weighIn.click();
  await expect(
    page.getByRole("dialog", { name: /^Weight on /u }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  // Only today asks.
  await page.goto(`/#/day/${shift(day, -1)}`);
  await expect(logCard(page)).toBeVisible();
  await expect(weighIn).toHaveCount(0);

  // A weight 7 days back is recent enough.
  await put(request, `${base}/${shift(day, -7)}`, {
    kg: 60,
  });
  const asked = page.waitForResponse((r) => r.url().includes("/weights?from="));
  await page.goto(`/#/day/${day}`);
  await asked;
  await expect(logCard(page)).toBeVisible();
  await expect(weighIn).toHaveCount(0);
});
