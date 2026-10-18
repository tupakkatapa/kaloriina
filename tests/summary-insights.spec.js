// Summary insights: the quiet
// view switches, Habits one habit at a time, the stat tiles and the
// Highlights. The periods' data is mocked (September 2025 against August),
// so every number and sentence is exact.

import { expect, test } from "@playwright/test";
import { mockJson, ownProfile, unique } from "./helpers.js";

// A number and its unit as the app writes them (a no-break space).
const words = (text) =>
  new RegExp(
    `^${text.replaceAll(/[().+]/gu, "\\$&").replaceAll(" ", "\\s")}$`,
    "u",
  );

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

// `/summary` and `/habits/days` over `days` ([{day, total}]), the targets,
// Health Connect `steps` days, `sessions`; anything not given answers empty.
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
  await mockJson(page, "**/api/profiles/*/device-days?*", (real, url) => ({
    ...real,
    days: inRange(steps, url),
    sessions: [],
  }));
  await mockJson(page, "**/api/profiles/*/activities?*", (real, url) =>
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

// Activity: August 2025 (7 workouts, 9 rest days in a row twice) against
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
  ].map((d, i) => run(d, i)),
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

// The Highlights stack's cards shown (the rest wait under "+N more"), and
// each one's headline.
const cards = (page) =>
  page.locator("section.highlight-stack > ul.highlights > li");
const highlights = (page) => cards(page).locator(".headline");
const numbers = (page) => cards(page).locator(".numbers");

// ---------------------------------------------------------- the switch

// A computed colour as [r, g, b, alpha] (rgb()/rgba() or color(srgb …)).
function parse(c) {
  const srgb = c.match(
    /color\(srgb ([\d.e-]+) ([\d.e-]+) ([\d.e-]+)(?: \/ ([\d.e-]+))?\)/u,
  );
  if (srgb)
    return [
      srgb[1] * 255,
      srgb[2] * 255,
      srgb[3] * 255,
      srgb[4] === undefined ? 1 : Number(srgb[4]),
    ];
  const n = c.match(/[\d.]+/gu).map(Number);
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
    {
      day: "2025-09-02",
      weight: 80,
      body_fat: 21,
      water: 55,
      muscle: 40,
      chosen: true,
    },
    {
      day: "2025-09-09",
      weight: 79.5,
      body_fat: 20.5,
      water: 55,
      muscle: 40,
      chosen: true,
    },
  ]);
  await page.setViewportSize({ width: 320, height: 800 });
  const groups = [
    ["/#/summary/food/month/2025-09-15", ["Period", "Calendar"]],
    ["/#/summary/body/month/2025-09-15", ["Period", "Chart"]],
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
        // The period switch lives in the title's popover.
        if (name === "Period") await page.locator(".period-title").click();
        const group =
          name === "Period"
            ? page.getByRole("navigation", { name })
            : page.getByRole("radiogroup", { name });
        await test.step(`${scheme} ${address} ${name}`, () =>
          expectQuiet(group));
        if (name === "Period") await page.keyboard.press("Escape");
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

// ---------------------------------------------------------- the picker

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
    "Hydration",
    "Added sugar",
    "Salt",
    "Fruit and vegetables",
    "Snus",
    "Gum",
  ]);
  await expect(radio("Hydration")).toBeChecked();
  await expect(page.locator(".habits-summary table")).toHaveCount(1);
  await expect(caption).toHaveText("Hydration by day");

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

  // Archived: gone from the switch, so Hydration again.
  const res = await request.put(`/api/profiles/${pid}/habits/${snus.id}`, {
    data: { ...snus, archived: true },
  });
  expect(res.ok()).toBeTruthy();
  await page.reload();
  await expect(radio("Hydration")).toBeChecked();
  await expect(radio("Snus")).toHaveCount(0);
});

// ----------------------------------------------------------- the tiles

test("tiles replace every stats line and wrap two a row on a phone", async ({
  page,
}) => {
  await mock(page, FOOD);
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto("/#/summary/food/month/2025-09-15");
  const tiles = page
    .getByRole("list", { name: "Energy", exact: true })
    .locator(".tile");
  await expect(tiles).toHaveText(
    ["30 of 30 days on target", "0 days over", "+18 % vs the month before"].map(
      (x) => words(x),
    ),
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
  for (const b of boxes) expect(b).toMatchObject({ fits: true, lines: 1 });

  // No run-on stats line is left on any subtab.
  const old = ".food-stats, .habit-stats, p.activity-summary, .weight-trend";
  await expect(page.locator(old)).toHaveCount(0);
  for (const tab of ["activity", "habits", "body"]) {
    await page.goto(`/#/summary/${tab}/month/2025-09-15`);
    await expect(shown(page, tab)).toHaveAttribute("aria-current", "page");
    await expect(page.locator(old)).toHaveCount(0);
  }
});

// ------------------------------------------------------ the Highlights

test("Highlights show real patterns and nothing else", async ({
  page,
  request,
}, testInfo) => {
  await mock(page, { ...FOOD, sessions: TRAINING.sessions });
  // Food, September: the strongest three, first on the subtab; Energy's
  // own change is its tile, not a Highlight.
  await page.goto("/#/summary/food/month/2025-09-15");
  await expect(highlights(page)).toHaveText([
    "Steps → energy eaten",
    "Energy highest Sat",
    "Protein up 20 %",
  ]);
  await expect(numbers(page)).toHaveText(
    [
      "On 10,000+ step days you ate ~514 kcal more (7 vs 23 days) · Sep 1 – 30",
      "2,900 kcal vs 2,120 kcal average · Sep 1 – 30",
      "120 g vs 100 g a day · Sep 1 – 30 vs the month before",
    ].map((x) => words(x)),
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
  await expect(highlights(page)).toHaveText([
    "Steps → energy eaten",
    "Energy highest Sat",
    "Energy up 18 %",
  ]);
  await expect(
    page.getByRole("list", { name: "Protein" }).locator(".tile").last(),
  ).toHaveText(words("+20 % vs the month before"));

  // A week has too few Saturdays to name one (Protein is still picked, so
  // its change is the tile and Energy's the Highlight).
  await page.goto("/#/summary/food/week/2025-09-01");
  await expect(highlights(page)).toHaveText([words("Energy up 18 %")]);
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
  await expect(
    page.getByRole("heading", { name: "Daily averages" }),
  ).toBeVisible();
  await expect(page.locator("ul.highlights")).toHaveCount(0);

  // Activity, August against July.
  await page.goto("/#/summary/activity/month/2025-08-15");
  await expect(highlights(page)).toHaveText([
    "Long gap without activity",
    "More activities",
  ]);
  await expect(numbers(page)).toHaveText([
    words("9 days in a row · Aug 6 – 14"),
    words("2 more activities than the month before · Aug 1 – 31"),
  ]);

  // Habits: alcohol's weekdays and its change, before "N days logged".
  await page.unroute("**/api/profiles/*/summary?*");
  await mock(page, HABITS);
  await page.goto("/#/summary/habits/month/2025-09-15");
  await expect(highlights(page)).toHaveText([
    "Alcohol mostly Fri, Sat",
    "Alcohol down 17 %",
  ]);
  expect(
    await page
      .locator("section.highlight-stack")
      .evaluate((n) => n.closest(".insights").nextElementSibling.textContent),
  ).toBe("30 days with a habit logged");

  // Body: the BMI fact alone (165 cm, 79.5 kg); the goal is a tile, without
  // a projection in a past month.
  // Discovery may still be reading through a mock.
  await page.unrouteAll({ behavior: "ignoreErrors" });
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
    page.getByRole("list", { name: "Goal" }).locator(".tile"),
  ).toHaveText(words("70 kg goal"));
  await expect(page.locator("li.goal-projection")).toBeVisible();
  await expect(highlights(page)).toHaveText(["BMI 29.2"]);
  await expect(numbers(page)).toHaveText([
    "overweight (WHO, adults) · weigh-in of Sep 9",
  ]);
  await expect(page.locator("ul.highlights li")).toHaveClass("tone-fact");
});

test("the period and the period before come from one union read each", async ({
  page,
}) => {
  await mock(page, { ...FOOD, sessions: TRAINING.sessions });
  const asked = [];
  page.on("request", (r) => {
    const url = new URL(r.url());
    const path = url.pathname.replace(/^\/api\/profiles\/\d+/u, "");
    if (url.pathname.startsWith("/api/profiles/"))
      asked.push(`${path}?${url.searchParams}`);
  });
  const sep = "from=2025-09-01&to=2025-09-30";
  const aug = "from=2025-08-01&to=2025-08-31";
  // Each shared source once, over the period and the 90 days correlations
  // read (web/series.mjs): August is inside it, so it's sliced, not asked.
  const union = "from=2025-07-03&to=2025-09-30";
  for (const [tab, wanted, never] of [
    [
      "food",
      [`/summary?${union}`, `/device-days?${union}`],
      [`/summary?${sep}`, `/summary?${aug}`],
    ],
    [
      "activity",
      [`/activities?${union}`],
      [`/activities?${sep}`, `/activities?${aug}`],
    ],
    ["habits", [`/habits/days?${sep}`, `/habits/days?${aug}`], []],
  ]) {
    asked.length = 0;
    await page.goto(`/#/summary/${tab}/month/2025-09-15`);
    await expect(shown(page, tab)).toHaveAttribute("aria-current", "page");
    await page.waitForLoadState("networkidle");
    for (const w of wanted) expect(asked, tab).toContain(w);
    for (const w of never) expect(asked, tab).not.toContain(w);
    expect(
      asked.filter((a) => a.startsWith(`/summary?${union}`)),
      tab,
    ).toHaveLength(1);
  }
});

// --------------------------------------------------------------- sleep

test("sleep ↔ energy shows on Food; Body loads 12 requests, 13 with a goal", async ({
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
      // The night and its naps, as the server sums them.
      total_asleep_min: day <= "2025-09-10" ? 380 : 480,
      asleep_min: day <= "2025-09-10" ? 380 : 480,
      in_bed_min: 500,
      bedtime: "23:30",
      wake_time: "07:00",
    })),
  });
  await page.goto("/#/summary/food/month/2025-09-15");
  await expect(highlights(page)).toContainText(["Sleep → energy eaten"]);
  // The pre-registered test of the pair, not the contrast it covers,
  // at its strongest lag.
  await expect(numbers(page)).toContainText([
    words(
      "Energy eaten 400 kcal lower the next day after sleep of at least 8 h (20 vs 10 days) · 90 days to Sep 30",
    ),
  ]);

  // Body: its measurements and notes; shared (web/series.mjs), the
  // targets, and the activity, check-ins, summary, sessions, weigh-ins and
  // scale over one union range each, which every other read of the period
  // (the energy model's included) is sliced from; a goal adds the recent
  // weigh-ins (about today, outside a past period's range). Highlights add
  // their hidden and pinned ids and the habits the discovery tier reads.
  // Discovery may still be reading through a mock.
  await page.unrouteAll({ behavior: "ignoreErrors" });
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
    "/activities",
    "/check-ins",
    "/device-days",
    "/habits",
    "/habits/days",
    "/insights/prefs",
    "/measurements",
    "/notes",
    "/scale",
    "/summary",
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
      // The night and its naps, as the server sums them.
      total_asleep_min: day <= "2025-09-10" ? 380 : 480,
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
  await expect(highlights(page)).toHaveText(["Sleep → mood"]);
  // The pre-registered test of the pair, not the contrast it covers.
  await expect(numbers(page)).toHaveText([
    words(
      "Mood 1 higher the next day after sleep of at least 8 h (20 vs 10 days) · 90 days to Sep 30",
    ),
  ]);
});

// ------------------------------------------------- tones, correlations

test("Highlights wear their tone; low iron warns with good sources", async ({
  page,
}) => {
  // September 2025, every day logged: 9 mg of iron against 16.
  const sep = daysOf("2025-09-01", "2025-09-30");
  await mock(page, {
    days: sep.map((day) => ({ day, total: { energy: 2000, iron: 9 } })),
    targets: [{ metric: "iron", value: 16, min: 16, max: null }],
  });
  // Good sources, not what supplied the little; a name twice is one food.
  const asked = [];
  await mockJson(page, "**/api/profiles/*/foods/rich?*", (real, url) => {
    asked.push(new URL(url).searchParams.get("nutrient"));
    return ["Liver, cooked", "Liver, cooked", "Lentils", "Spinach", "Tofu"].map(
      (name, i) => ({ food_id: i + 1, name, per_100kcal: 5 - i, eaten: false }),
    );
  });
  await page.goto("/#/summary/food/month/2025-09-15");
  const item = cards(page).and(page.locator(".tone-warning"));
  // The tone is named for a screen reader.
  await expect(item.locator("summary")).toHaveText(
    /^Warning: Iron intake low9 of 16\smg a day · Sep 1\s–\s30$/u,
  );
  await item.locator("summary").click();
  await expect(item.locator(".card-detail p")).toHaveText(
    /^Good sources: Liver, cooked · Lentils · Spinach\. Under 70\u00A0% of your target: intake, not status\./u,
  );
  expect(asked).toContain("iron");
  await expect(item.locator("svg")).toBeVisible();
  // Each tone its own colour, none the accent's.
  const colours = await page.evaluate(() =>
    ["fact", "correlation", "tip", "warning", "accent"].map((t) =>
      getComputedStyle(document.documentElement)
        .getPropertyValue(t === "accent" ? "--accent" : `--tone-${t}`)
        .trim(),
    ),
  );
  expect(new Set(colours).size).toBe(5);
  expect(
    await item.evaluate(
      (li) => getComputedStyle(li.querySelector("summary > svg")).color,
    ),
  ).toBe(
    await page.evaluate(() => {
      const probe = document.createElement("span");
      probe.style.color = "var(--tone-warning)";
      document.body.append(probe);
      const c = getComputedStyle(probe).color;
      probe.remove();
      return c;
    }),
  );
  // Correlations have no card of their own.
  await expect(page.locator("details.correlations")).toHaveCount(0);
});

// Night i's minutes asleep: 6–8 h, spread over the weekdays.
const asleep = (i) => 360 + ((i * 37) % 120);

test("a correlation over the 90 days joins Body's Highlights; one a contrast says stays out", async ({
  page,
}) => {
  // Jul 3 – Sep 30 2025: each night's sleep, the next day's mood following
  // it and the day's stress against it, whatever the weekday.
  const days = daysOf("2025-07-03", "2025-09-30");
  await mock(page, {
    steps: days.map((day, i) => ({
      day,
      total_asleep_min: asleep(i),
      asleep_min: asleep(i),
    })),
  });
  await mockJson(page, "**/api/profiles/*/check-ins?*", (real, url) =>
    inRange(
      days.map((day, i) => ({
        day,
        mood: asleep(i) >= 420 ? 4 : 3,
        energy: null,
        // The day before the night: sleep, a night's outcome, is read at
        // lag 1 only (web/correlate.mjs NIGHT).
        stress: asleep(i + 1) >= 420 ? 2 : 4,
        tags: [],
      })),
      url,
    ),
  );
  await page.goto("/#/summary/body/month/2025-09-15");
  // Sleep ↔ mood is said by its contrast (its correlation stays out);
  // stress ↔ sleep, no contrast of its own, by the pre-registered tier; the
  // discovery tier adds stress ↔ next day's mood.
  await expect(highlights(page)).toHaveText([
    "Sleep → mood",
    "Stress → sleep",
    "Possible pattern",
  ]);
  const item = cards(page).nth(1);
  await expect(item).toHaveClass("tone-correlation");
  await expect(item.locator("summary .sr-only")).toHaveText("Correlation: ");
  await item.locator("summary").click();
  await expect(item.locator(".card-detail p")).toHaveText(
    /^Spearman ρ [−-]0\.\d\d over \d+ days, sleep read the night after,/u,
  );
  // Said once: "the night after stress of at least 4", not "after after".
  await expect(item.locator(".numbers")).toHaveText(
    /^Sleep 59\smin lower the night after stress of at least 4 \(45 vs 44 days\) · 90 days to Sep 30$/u,
  );
  await expect(page.locator("details.correlations")).toHaveCount(0);
});

// Day i's alcohol in a 5-day rhythm, its steps in a 13-day one.
const alcohol = (i) => ((i * 3) % 5) * 10;
const stepsOn = (i) => 4000 + ((i * 5) % 13) * 500;

// Owner (2026-10-14): "Alcohol → HRV" and "Possible pattern: Higher alcohol
// tends to go with lower HRV the night after" were one finding twice; the
// discovery tier keeps to what no card says.
test("a pattern a pre-registered card already states is not discovered again", async ({
  page,
}) => {
  // Jul 3 – Sep 30 2025: alcohol in a 5-day rhythm and HRV the night after
  // lower with it; steps in a 13-day one and resting heart rate the night
  // after higher with them, a pattern no card says.
  const days = daysOf("2025-07-03", "2025-09-30");
  await mock(page, {
    days: days.map((day, i) => ({
      day,
      total: { energy: 2000, alcohol: alcohol(i) },
    })),
    steps: days.map((day, i) => ({
      day,
      steps: stepsOn(i),
      hrv_ms: i ? 70 - alcohol(i - 1) / 2 : 70,
      resting_hr: i ? 50 + Math.round(stepsOn(i - 1) / 1000) : 50,
    })),
  });
  await page.goto("/#/summary/body/month/2025-09-15");
  await expect(highlights(page)).toContainText(["Alcohol → HRV"]);
  // Discovery is done once its pattern shows.
  await expect(numbers(page).filter({ hasText: /^Higher steps/u })).toHaveCount(
    1,
  );
  await expect(
    numbers(page).filter({ hasText: /alcohol tends to go with/iu }),
  ).toHaveCount(0);
});

// A discovery that failed (offline once) is no "nothing found"
// for the session: the stack says so, and Retry looks again.
test("a failed discovery says so, and Retry finds the pattern", async ({
  page,
}) => {
  const days = daysOf("2025-07-03", "2025-09-30");
  await mock(page, {
    steps: days.map((day, i) => ({
      day,
      total_asleep_min: asleep(i),
      asleep_min: asleep(i),
    })),
  });
  await mockJson(page, "**/api/profiles/*/check-ins?*", (real, url) =>
    inRange(
      days.map((day, i) => ({
        day,
        mood: asleep(i) >= 420 ? 4 : 3,
        energy: null,
        stress: asleep(i + 1) >= 420 ? 2 : 4,
        tags: [],
      })),
      url,
    ),
  );
  // The habits list, which discovery reads, fails once.
  let failed = false;
  await page.route("**/api/profiles/*/habits", (route) => {
    if (failed) return route.fallback();
    failed = true;
    return route.abort("internetdisconnected");
  });
  await page.goto("/#/summary/body/month/2025-09-15");
  const stack = page.locator(".insights");
  await expect(stack.getByRole("alert")).toContainText(
    "Can't reach the server",
  );
  await expect(highlights(page)).toHaveText(["Sleep → mood", "Stress → sleep"]);
  await stack.getByRole("button", { name: "Retry" }).click();
  await expect(highlights(page)).toHaveText([
    "Sleep → mood",
    "Stress → sleep",
    "Possible pattern",
  ]);
  await expect(stack.getByRole("alert")).toHaveCount(0);
});
