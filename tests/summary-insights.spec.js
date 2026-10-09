// Summary insights: the quiet
// view switches, Habits one habit at a time, the stat tiles and the
// Highlights. The periods' data is mocked (September 2025 against August),
// so every number and sentence is exact.

import { test, expect } from "@playwright/test";
import { mockJson, ownProfile, unique } from "./helpers.js";

// A number and its unit as the app writes them (a no-break space).
const words = (text) =>
  new RegExp(`^${text.replace(/[().+]/g, "\\$&").replaceAll(" ", "\\s")}$`);

// Every day of [from, to] ("YYYY-MM-DD").
function daysOf(from, to) {
  const out = [from];
  while (out.at(-1) < to) {
    const d = new Date(`${out.at(-1)}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}
const weekday = (day) => new Date(`${day}T00:00:00Z`).getUTCDay();
const SAT = 6;
const FRI = 5;

// The rows a mocked list endpoint answers: those within the query's range.
const inRange = (rows, url) => {
  const q = new URL(url).searchParams;
  return rows.filter(
    (r) =>
      (!q.get("from") || r.day >= q.get("from")) &&
      (!q.get("to") || r.day <= q.get("to")),
  );
};

// `/summary` and `/habits/days` over `days` ([{day, total}]), the targets, Health Connect
// `steps` days, `sessions`; anything not given answers empty.
async function mock(
  page,
  { days = [], targets = [], steps = [], sessions = [] },
) {
  await mockJson(page, "**/api/profiles/*/summary?*", (real, url) => {
    const list = inRange(days, url);
    const keys = [...new Set(list.flatMap((d) => Object.keys(d.total)))];
    return {
      ...real,
      days_logged: list.length,
      average: Object.fromEntries(
        keys.map((k) => [
          k,
          list.reduce((t, d) => t + (d.total[k] ?? 0), 0) / list.length,
        ]),
      ),
      days: list,
    };
  });
  // The real list (registry defaults: steps, sleep) under the test's own.
  await mockJson(page, "**/api/profiles/*/targets", (real) => [
    ...real.filter((t) => !targets.some((x) => x.metric === t.metric)),
    ...targets,
  ]);
  await mockJson(page, "**/api/profiles/*/weights?*", () => []);
  await mockJson(page, "**/api/profiles/*/activity?*", (real, url) => ({
    ...real,
    days: inRange(steps, url),
    sessions: [],
  }));
  await mockJson(page, "**/api/profiles/*/sessions?*", (real, url) =>
    inRange(sessions, url),
  );
  await mockJson(page, "**/api/profiles/*/plans?*", () => []);
  await mockJson(page, "**/api/profiles/*/habits", () => []);
  // The built-ins as the server reads them from food: a row each eaten day.
  await mockJson(page, "**/api/profiles/*/habits/days?*", (real, url) =>
    inRange(days, url).flatMap((d) =>
      ["water", "alcohol", "caffeine"].map((habit) => ({
        habit,
        day: d.day,
        amount: d.total[habit] ?? 0,
      })),
    ),
  );
}

// Food, September 2025: Saturdays 2,900 kcal, other days 2,000; protein
// 120 g. August: 1,800 kcal and 100 g every day. 12,000 steps on the four
// Saturdays and Sep 1–3, 6,000 on the rest. Energy "about" 2,000 (1,800 –
// 3,000): nothing over.
const FOOD = {
  days: [
    ...daysOf("2025-08-01", "2025-08-31").map((day) => ({
      day,
      total: { energy: 1800, protein: 100, net_carbs: 250, fat: 70 },
    })),
    ...daysOf("2025-09-01", "2025-09-30").map((day) => ({
      day,
      total: {
        energy: weekday(day) === SAT ? 2900 : 2000,
        protein: 120,
        net_carbs: 250,
        fat: 70,
      },
    })),
  ],
  steps: daysOf("2025-09-01", "2025-09-30").map((day) => ({
    day,
    active_kcal: 300,
    steps: weekday(day) === SAT || day <= "2025-09-03" ? 12000 : 6000,
  })),
  targets: [{ metric: "energy", value: 2000, min: 1800, max: 3000 }],
};

// Training: August 2025 (7 workouts, 9 rest days in a row twice) against
// July (5), both 31 days.
const run = (day, i) => ({
  id: i + 1,
  day,
  name: "Run",
  minutes: 30,
  kcal: 200,
  sets: [],
});
const TRAINING = {
  sessions: [
    ...["07", "09", "21", "23", "25"].map((d) => `2025-07-${d}`),
    ...["01", "03", "05", "15", "17", "19", "29"].map((d) => `2025-08-${d}`),
  ].map(run),
};

// Habits: 2 drinks (24 g) every Friday and Saturday of August and
// September 2025, food logged every day.
const HABITS = {
  days: daysOf("2025-08-01", "2025-09-30").map((day) => ({
    day,
    total: {
      energy: 2000,
      alcohol: [FRI, SAT].includes(weekday(day)) ? 24 : 0,
    },
  })),
};

// The Section link of `tab` ("food"): current once its content is drawn.
const shown = (page, tab) =>
  page
    .getByRole("navigation", { name: "Section" })
    .getByRole("link", { name: tab[0].toUpperCase() + tab.slice(1) });

const highlights = (page) =>
  page.getByRole("list", { name: "Highlights" }).getByRole("listitem");

// ------------------------------------------------------------ the switch

// A computed colour as [r, g, b, alpha] (rgb()/rgba() or color(srgb …)).
function parse(c) {
  const srgb = c.match(
    /color\(srgb ([\d.e-]+) ([\d.e-]+) ([\d.e-]+)(?: \/ ([\d.e-]+))?\)/,
  );
  if (srgb)
    return [
      srgb[1] * 255,
      srgb[2] * 255,
      srgb[3] * 255,
      srgb[4] === undefined ? 1 : Number(srgb[4]),
    ];
  const n = c.match(/[\d.]+/g).map(Number);
  return [n[0], n[1], n[2], n[3] ?? 1];
}

// `top` composited over the opaque `under`.
const over = (top, under) => [
  ...[0, 1, 2].map((i) => top[i] * top[3] + under[i] * (1 - top[3])),
  1,
];

// WCAG relative luminance and contrast ratio.
const lum = (rgb) =>
  [0.2126, 0.7152, 0.0722].reduce((t, w, i) => {
    const v = rgb[i] / 255;
    return t + w * (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  }, 0);
const contrast = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].toSorted((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

// A view switch as computed: its class and background, the backgrounds
// behind it (innermost first), the theme's --fg and --muted, and per option
// its box, type, colour and pill.
const switchLook = (group) =>
  group.evaluate((node) => {
    const chain = [];
    for (let e = node; e; e = e.parentElement)
      chain.push(getComputedStyle(e).backgroundColor);
    const probe = document.createElement("span");
    document.body.append(probe);
    probe.style.color = "var(--fg)";
    const fg = getComputedStyle(probe).color;
    probe.style.color = "var(--muted)";
    const muted = getComputedStyle(probe).color;
    probe.remove();
    return {
      className: node.className,
      background: getComputedStyle(node).backgroundColor,
      chain,
      fg,
      muted,
      options: [...node.querySelectorAll(".button")].map((el) => {
        const s = getComputedStyle(el);
        const pill = getComputedStyle(el, "::before");
        const box = el.getBoundingClientRect();
        return {
          active: el.classList.contains("active"),
          width: box.width,
          height: box.height,
          fontSize: s.fontSize,
          weight: s.fontWeight,
          color: s.color,
          pill: pill.backgroundColor,
          pillHeight: Number.parseFloat(pill.height),
        };
      }),
    };
  });

async function expectQuiet(group) {
  await expect(group).toBeVisible();
  const look = await switchLook(group);
  expect(look.className).toBe("switch");
  expect(look.background).toBe("rgba(0, 0, 0, 0)");
  // The page behind: the first opaque background out from the switch.
  const page = look.chain.map(parse).find((c) => c[3] > 0) ?? [
    255, 255, 255, 1,
  ];
  expect(look.options.filter((o) => o.active)).toHaveLength(1);
  for (const o of look.options) {
    expect(o.width).toBeGreaterThanOrEqual(44);
    expect(o.height).toBeGreaterThanOrEqual(44);
    // --t-sm.
    expect(o.fontSize).toBe("14px");
    const behind = o.active ? over(parse(o.pill), page) : page;
    expect(contrast(parse(o.color), behind)).toBeGreaterThanOrEqual(4.5);
    if (o.active) {
      expect(o.weight).toBe("600");
      expect(o.color).toBe(look.fg);
      expect(Math.abs(o.pillHeight - 28)).toBeLessThanOrEqual(1);
    } else {
      expect(o.weight).toBe("400");
      expect(o.color).toBe(look.muted);
    }
  }
}

test("every Summary view switch is quiet; form choices stay segmented", async ({
  page,
}) => {
  await mock(page, FOOD);
  // A tracker, so the Habit switch shows without any food data.
  await mockJson(page, "**/api/profiles/*/habits", () => [
    {
      id: 1,
      name: "Snus",
      unit: "pouches",
      goal_value: null,
      goal_dir: "at_most",
      archived: false,
      rev: 1,
    },
  ]);
  // Body: two weigh-ins and the scale's body composition (the Chart switch).
  await page.unroute("**/api/profiles/*/weights?*");
  await mockJson(page, "**/api/profiles/*/weights?*", () => [
    { day: "2025-09-02", kg: 80 },
    { day: "2025-09-09", kg: 79.5 },
  ]);
  await mockJson(page, "**/api/profiles/*/scale?*", () => [
    { day: "2025-09-02", weight: 80, body_fat: 21, water: 55, muscle: 40 },
    {
      day: "2025-09-09",
      weight: 79.5,
      body_fat: 20.5,
      water: 55,
      muscle: 40,
    },
  ]);
  await page.setViewportSize({ width: 320, height: 800 });
  const groups = [
    ["/#/summary/food/month/2025-09-15", ["Period", "Energy by", "Calendar"]],
    ["/#/summary/body/month/2025-09-15", ["Period", "Weight by", "Chart"]],
    ["/#/summary/habits/month/2025-09-15", ["Period", "Habit"]],
  ];
  for (const scheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const [address, names] of groups) {
      await page.goto(address);
      // Drawn: the switch only this address has.
      await expect(
        page.getByRole("radiogroup", { name: names.at(-1) }),
      ).toBeVisible();
      for (const name of names) {
        const group =
          name === "Period"
            ? page.getByRole("navigation", { name })
            : page.getByRole("radiogroup", { name });
        await test.step(`${scheme} ${address} ${name}`, () =>
          expectQuiet(group));
      }
      // Everything stays on screen, the nutrient table included.
      expect(
        await page
          .locator("main *")
          .evaluateAll((list) =>
            list
              .filter(
                (n) =>
                  n.getBoundingClientRect().right > window.innerWidth + 0.5,
              )
              .map((n) => n.className),
          ),
        address,
      ).toEqual([]);
    }
  }
  // A form's choice keeps its tray.
  await page.goto("/#/profile/new");
  await expect(page.getByRole("radiogroup", { name: "Sex" })).toHaveClass(
    "segmented",
  );
});

// ------------------------------------------------------------ the picker

test("Habits shows one habit at a time, kept on this device", async ({
  page,
  request,
}, testInfo) => {
  const { tag } = unique(621, testInfo);
  const pid = await ownProfile(page, request, `Picker ${tag}`);
  const make = async (data) =>
    (
      await request.post(`/api/profiles/${pid}/habits`, {
        data: { unit: "pouches", ...data },
      })
    ).json();
  const snus = await make({ name: "Snus" });
  await make({ name: "Gum" });
  await make({ name: "Old", archived: true });
  await page.goto("/#/summary/habits/month/2025-09-15");
  const habits = page.getByRole("radiogroup", { name: "Habit" });
  const radio = (name) => habits.getByRole("radio", { name, exact: true });
  const caption = page.locator(".habits-summary caption");
  // The built-ins with a target (its recommended ones) or data, then the
  // active trackers.
  await expect(habits.getByRole("radio")).toHaveText([
    "Water",
    "Added sugar",
    "Salt",
    "Fruit and vegetables",
    "Snus",
    "Gum",
  ]);
  await expect(radio("Water")).toBeChecked();
  await expect(page.locator(".habits-summary table")).toHaveCount(1);
  await expect(caption).toHaveText("Water by day");

  // A pick repaints in place: no request, and the keyboard stays put.
  await page.waitForLoadState("networkidle");
  const asked = [];
  page.on("request", (r) => {
    if (new URL(r.url()).pathname.startsWith("/api/")) asked.push(r.url());
  });
  await radio("Added sugar").click();
  await expect(caption).toHaveText("Added sugar by day");
  await expect(radio("Added sugar")).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(caption).toHaveText("Salt by day");
  await expect(radio("Salt")).toBeFocused();
  await expect(page.locator(".habits-summary table")).toHaveCount(1);
  expect(asked).toEqual([]);

  // Kept on this device, by id.
  await radio("Snus").click();
  expect(await page.evaluate(() => localStorage.getItem("summary-habit"))).toBe(
    String(snus.id),
  );
  await page.reload();
  await expect(radio("Snus")).toBeChecked();
  await expect(caption).toHaveText("Snus by day");

  // Archived: gone from the switch, so Water again.
  const res = await request.put(`/api/profiles/${pid}/habits/${snus.id}`, {
    data: { ...snus, archived: true },
  });
  expect(res.ok()).toBeTruthy();
  await page.reload();
  await expect(radio("Water")).toBeChecked();
  await expect(radio("Snus")).toHaveCount(0);
});

// ------------------------------------------------------------- the tiles

test("tiles replace every stats line and wrap 2×2 on a phone", async ({
  page,
}) => {
  await mock(page, FOOD);
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto("/#/summary/food/month/2025-09-15");
  const tiles = page
    .getByRole("list", { name: "Energy" })
    .getByRole("listitem");
  await expect(tiles).toHaveText(
    [
      "30 of 30 days on target",
      "2,120 kcal a day",
      "0 days over",
      "+18 % vs last month",
    ].map(words),
  );
  const boxes = await tiles.evaluateAll((list) =>
    list.map((li) => {
      const value = li.querySelector(".tile-value");
      return {
        y: li.getBoundingClientRect().y,
        fits: li.scrollWidth <= li.clientWidth,
        lines: Math.round(
          value.getBoundingClientRect().height /
            Number.parseFloat(getComputedStyle(value).lineHeight),
        ),
      };
    }),
  );
  expect(boxes[0].y).toBe(boxes[1].y);
  expect(boxes[2].y).toBeGreaterThan(boxes[0].y);
  expect(boxes[2].y).toBe(boxes[3].y);
  for (const b of boxes) expect(b).toMatchObject({ fits: true, lines: 1 });

  // No run-on stats line is left on any subtab.
  const old = ".food-stats, .habit-stats, p.workout-summary, .weight-trend";
  await expect(page.locator(old)).toHaveCount(0);
  for (const tab of ["training", "habits", "body"]) {
    await page.goto(`/#/summary/${tab}/month/2025-09-15`);
    await expect(shown(page, tab)).toHaveAttribute("aria-current", "page");
    await expect(page.locator(old)).toHaveCount(0);
  }
});

// -------------------------------------------------------- the Highlights

test("Highlights show real patterns and nothing else", async ({
  page,
  request,
}, testInfo) => {
  await mock(page, { ...FOOD, sessions: TRAINING.sessions });
  // Food, September: the strongest three, first on the subtab; Energy's
  // own change is its tile, not a Highlight.
  await page.goto("/#/summary/food/month/2025-09-15");
  await expect(highlights(page)).toHaveText(
    [
      "On days with 10,000+ steps you eat 514 kcal more",
      "Saturdays run highest: 2,900 kcal vs 2,120 kcal on average",
      "Protein up 20 % from last month",
    ].map(words),
  );
  const first = await page
    .locator("section.summary > :not(nav, header)")
    .first()
    .evaluate((n) => n.querySelector("ul.highlights") !== null);
  expect(first).toBe(true);
  // Picking Protein moves its change to the tile; Energy's comes back.
  await page
    .getByRole("radiogroup", { name: "Calendar" })
    .getByRole("radio", { name: "Protein" })
    .click();
  await expect(highlights(page)).toHaveText(
    [
      "On days with 10,000+ steps you eat 514 kcal more",
      "Saturdays run highest: 2,900 kcal vs 2,120 kcal on average",
      "Energy up 18 % from last month",
    ].map(words),
  );
  await expect(
    page.getByRole("list", { name: "Protein" }).getByRole("listitem").last(),
  ).toHaveText(words("+20 % vs last month"));

  // A week has too few Saturdays to name one (Protein is still picked, so
  // its change is the tile and Energy's the Highlight).
  await page.goto("/#/summary/food/week/2025-09-01");
  await expect(highlights(page)).toHaveText([
    words("Energy up 18 % from last week"),
  ]);
  await expect(page.locator("ul.highlights")).not.toContainText("run highest");

  // October: 5 days logged is no month to compare.
  await page.unroute("**/api/profiles/*/summary?*");
  await mockJson(page, "**/api/profiles/*/summary?*", (real, url) => {
    const list = inRange(
      [
        ...FOOD.days,
        ...daysOf("2025-10-01", "2025-10-05").map((day) => ({
          day,
          total: { energy: 2500, protein: 150 },
        })),
      ],
      url,
    );
    return { ...real, days_logged: list.length, average: {}, days: list };
  });
  await page.goto("/#/summary/food/month/2025-10-15");
  await expect(page.getByText("5 days logged")).toBeVisible();
  await expect(page.locator("ul.highlights")).toHaveCount(0);

  // Training, August against July.
  await page.goto("/#/summary/training/month/2025-08-15");
  await expect(highlights(page)).toHaveText([
    "Longest gap without training: 9 days",
    "2 more workouts than last month",
  ]);

  // Habits: alcohol's weekdays and its change, before "N days logged".
  await page.unroute("**/api/profiles/*/summary?*");
  await mock(page, HABITS);
  await page.goto("/#/summary/habits/month/2025-09-15");
  await expect(highlights(page)).toHaveText([
    "Alcohol mostly on Fridays and Saturdays",
    "Alcohol down 17 % from last month",
  ]);
  expect(
    await page
      .locator("ul.highlights")
      .evaluate((n) => n.nextElementSibling.textContent),
  ).toBe("30 days logged");

  // Body: no rule yet; the goal is a tile, without a projection in a past
  // month.
  await page.unrouteAll();
  const { tag } = unique(622, testInfo);
  const pid = await ownProfile(page, request, `Goal ${tag}`);
  const { rev } = await (await request.get(`/api/profiles/${pid}`)).json();
  await request.put(`/api/profiles/${pid}/targets`, {
    data: { rev, targets: [{ metric: "goal_weight", value: 70 }] },
  });
  for (const [day, kg] of [
    ["2025-09-02", 80],
    ["2025-09-09", 79.5],
  ])
    await request.put(`/api/profiles/${pid}/weights/${day}`, { data: { kg } });
  // A new document, so the profile of its own is current.
  await page.goto("/#/summary/body/month/2025-09-15");
  await page.reload();
  await expect(
    page.getByRole("list", { name: "Goal" }).getByRole("listitem"),
  ).toHaveText(words("70 kg goal"));
  await expect(page.locator("li.goal-projection")).toBeVisible();
  await expect(page.locator("ul.highlights")).toHaveCount(0);
});

test("the previous period loads beside the period, one request each", async ({
  page,
}) => {
  await mock(page, { ...FOOD, sessions: TRAINING.sessions });
  const asked = [];
  page.on("request", (r) => {
    const url = new URL(r.url());
    const path = url.pathname.replace(/^\/api\/profiles\/\d+/, "");
    if (url.pathname.startsWith("/api/profiles/"))
      asked.push(`${path}?${url.searchParams}`);
  });
  const sep = "from=2025-09-01&to=2025-09-30";
  const aug = "from=2025-08-01&to=2025-08-31";
  for (const [tab, wanted] of [
    ["food", [`/summary?${sep}`, `/summary?${aug}`, `/activity?${sep}`]],
    ["training", [`/sessions?${sep}`, `/sessions?${aug}`]],
    ["habits", [`/habits/days?${sep}`, `/habits/days?${aug}`]],
  ]) {
    asked.length = 0;
    await page.goto(`/#/summary/${tab}/month/2025-09-15`);
    await expect(shown(page, tab)).toHaveAttribute("aria-current", "page");
    await page.waitForLoadState("networkidle");
    for (const w of wanted) expect(asked, tab).toContain(w);
  }
});

// ------------------------------------------------- sleep

test("sleep ↔ energy shows on Food; Body loads 7 requests, 8 with a goal", async ({
  page,
  request,
}, testInfo) => {
  // September 2025: nights under 7 h on the 1st–10th, each such day eating
  // 2,400 kcal; 8 h nights and 2,000 kcal after. No steps.
  const sep = daysOf("2025-09-01", "2025-09-30");
  await mock(page, {
    days: sep.map((day) => ({
      day,
      total: { energy: day <= "2025-09-10" ? 2400 : 2000 },
    })),
    steps: sep.map((day) => ({
      day,
      asleep_min: day <= "2025-09-10" ? 380 : 480,
      in_bed_min: 500,
      bedtime: "23:30",
      wake_time: "07:00",
    })),
  });
  await page.goto("/#/summary/food/month/2025-09-15");
  await expect(highlights(page)).toContainText([
    words("After nights under 7 h you eat 400 kcal more"),
  ]);

  // Body: the period's weigh-ins, scale, measurements and notes, and the
  // shared targets, activity and check-ins; a goal adds the recent
  // weigh-ins.
  await page.unrouteAll();
  const { tag } = unique(655, testInfo);
  const pid = await ownProfile(page, request, `Budget ${tag}`);
  const prefix = `/api/profiles/${pid}`;
  const asked = [];
  page.on("request", (r) => {
    const { pathname } = new URL(r.url());
    if (pathname.startsWith(prefix)) asked.push(pathname.slice(prefix.length));
  });
  for (const [day, kg] of [
    ["2025-09-02", 80],
    ["2025-09-09", 79.5],
  ])
    await request.put(`${prefix}/weights/${day}`, { data: { kg } });
  const body = [
    "/activity",
    "/check-ins",
    "/measurements",
    "/notes",
    "/scale",
    "/targets",
    "/weights",
  ];
  for (const [goal, wanted] of [
    [null, body],
    [70, [...body, "/weights"].toSorted()],
  ]) {
    const { rev } = await (await request.get(prefix)).json();
    await request.put(`${prefix}/targets`, {
      data: {
        rev,
        targets: goal === null ? [] : [{ metric: "goal_weight", value: goal }],
      },
    });
    await page.goto("/#/summary/body/month/2025-09-15");
    await page.reload();
    await expect(page.locator("section.weight")).toBeVisible();
    await page.waitForLoadState("networkidle");
    asked.length = 0;
    await page.reload();
    await expect(page.locator("section.weight")).toBeVisible();
    await page.waitForLoadState("networkidle");
    expect(asked.toSorted(), String(goal)).toEqual(wanted);
  }
});

test("Body shows a sleep ↔ mood highlight from seeded data", async ({
  page,
}) => {
  // September 2025: nights under 7 h on the 1st–10th, each such day rated
  // mood 3; 8 h nights and mood 4 after.
  const sep = daysOf("2025-09-01", "2025-09-30");
  await mock(page, {
    steps: sep.map((day) => ({
      day,
      asleep_min: day <= "2025-09-10" ? 380 : 480,
      in_bed_min: 500,
      bedtime: "23:30",
      wake_time: "07:00",
    })),
  });
  await mockJson(page, "**/api/profiles/*/check-ins?*", (real, url) =>
    inRange(
      sep.map((day) => ({
        day,
        mood: day <= "2025-09-10" ? 3 : 4,
        energy: null,
        stress: null,
        tags: [],
      })),
      url,
    ),
  );
  await page.goto("/#/summary/body/month/2025-09-15");
  await expect(highlights(page)).toHaveText([
    words("After nights under 7 h you rate your mood 1 lower"),
  ]);
});
