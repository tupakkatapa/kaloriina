// Spacing and type on the token scale: computed styles and boxes at
// 320, 393 and 1280 px. Rule-level findings are read off a probe of the class
// contract (the markup the screens build) put into the page; screen-level ones
// off the screens themselves.

import { expect, test } from "@playwright/test";
import {
  entry,
  fixedToday,
  food,
  ownProfile,
  todayInApp,
  unique,
  workout,
} from "./helpers.js";

// One today for the whole test, in the page and here.
test.beforeEach(({ page }) => fixedToday(page));

const px = (v) => Number.parseFloat(v);

// The class contract: one of each component, as the screens build it.
const PROBE = `
<section class="probe">
  <h2 id="h2">Section</h2>
  <h3 id="h3">Sub-heading</h3>
  <ul class="results card">
    <li><a class="result" id="result" href="#/probe"><span class="name">Morning run</span><span class="muted" id="result-detail">Tue, Oct 13 · 46 min · 8.2 km</span></a></li>
    <li><a class="result" id="result-1" href="#/probe"><span class="name">Oats</span><span class="muted" id="result-1-detail">34 kcal per 100 g</span></a></li>
  </ul>
  <ul class="menu card"><li><a class="menu-row" id="menu-row" href="#/probe"><span class="name">Habits</span><span class="muted">Trackers and their goals</span></a></li></ul>
  <section class="group" id="group">
    <header><h2>Planned</h2><span class="muted total">512 kcal</span><button type="button" class="select"><svg viewBox="0 0 24 24"></svg><span class="label">Select</span></button><a class="button icon" href="#/probe" aria-label="Add to Planned"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"></path></svg></a></header>
    <ul><li class="entry"><a class="entry-main" id="entry-main" href="#/probe"><span class="name">Porridge</span><span class="muted">1 bowl · 60 g</span><span class="kcal" id="kcal">228 kcal</span></a><button type="button" class="icon tick" id="tick" aria-label="Mark eaten">✓</button></li></ul>
  </section>
  <section class="group" id="group-bare"><header><h2>Log</h2><button type="button" class="icon" aria-label="Log on Mon, Oct 12"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"></path></svg></button></header>
    <ul class="log-rows"><li class="log-row" id="log-row"><span class="kind" id="kind">Planned</span><span class="result"><span class="name">Legs</span></span><span class="actions"><a class="button compact" id="start" href="#/probe">Start</a><button type="button" class="icon danger" id="remove" aria-label="Remove">✕</button><button type="button" class="icon tick" aria-label="Done">✓</button></span></li>
    <li class="log-row"><span class="kind">Hydration</span><span class="result hydration"><span class="name">1.2 L</span></span></li></ul>
  </section>
  <ul class="days"><li id="day-li"><span>Mon, Oct 12</span><span class="muted">A long note on the day that wraps onto a second line at a phone's width</span></li></ul>
  <div class="targets" id="targets"></div>
  <div class="picker" id="picker"></div>
  <form class="editor"><fieldset id="fieldset"><legend id="legend">Servings <select id="legend-select"><option>Portion</option></select></legend><label class="check"><input type="checkbox" id="checkbox"> Default</label></fieldset></form>
  <div class="filters card" id="filters"><fieldset><legend id="filter-legend">Kind</legend></fieldset></div>
  <div class="connections"><div class="card" id="connections-card"></div></div>
  <ul class="tiles" id="tiles">
    <li><button type="button" class="tile" aria-describedby="tt1"><b class="tile-value">12:05 AM–07:10 AM</b> <span class="tile-caption">asleep</span></button><span class="tile-long" id="tt1" role="tooltip">A night.</span></li>
    <li><button type="button" class="tile" aria-describedby="tt2"><b class="tile-value">66</b> <span class="tile-caption">Oct 12</span></button><span class="tile-long" id="tt2" role="tooltip">A day.</span></li>
    <li><button type="button" class="tile" aria-describedby="tt3"><b class="tile-value">1,234</b> <span class="tile-caption">kcal</span></button><span class="tile-long" id="tt3" role="tooltip">Energy.</span></li>
    <li><button type="button" class="tile" aria-describedby="tt4"><b class="tile-value">5</b> <span class="tile-caption">days</span></button><span class="tile-long" id="tt4" role="tooltip">Days.</span></li>
    <li id="lone"><button type="button" class="tile" aria-describedby="tt5"><b class="tile-value">8.2 km</b> <span class="tile-caption">run</span></button><span class="tile-long" id="tt5" role="tooltip">A run.</span></li>
  </ul>
  <div class="actions" id="actions"><a class="button" href="#/probe">New food</a><a class="button" href="#/probe">New recipe</a><a class="button" href="#/probe">New meal</a></div>
  <table class="grid goals" id="goals"><colgroup><col class="label"><col class="sign"><col><col class="share"></colgroup>
    <tbody><tr><th scope="row" id="grid-th">Protein</th><td><select id="sign"><option>≥</option></select></td><td><input id="grid-input" inputmode="decimal" value="120"></td><td>35 %<small id="grid-small">a day</small></td></tr></tbody></table>
  <span class="light l-low" id="light"><span class="dot"></span>Low fat</span>
  <ul class="highlights"><li class="tone-tip"><details><summary><svg id="hl-svg" viewBox="0 0 24 24"></svg><span class="card-text"><b class="headline">Headline</b><span class="numbers" id="hl-numbers">1 of 2</span></span></summary><div class="card-detail"><p>Text</p></div></details></li></ul>
  <div class="photo-add"><button type="button"><svg id="photo-svg" viewBox="0 0 24 24"></svg>Photo</button></div>
  <table class="cal"><tbody><tr><td class="cal-cell"><a href="#/probe"><span>12</span><span class="cal-mark" id="cal-mark">●</span></a></td></tr></tbody></table>
  <header class="title" id="section-head"><h2>Recent activities</h2><a class="button" href="#/probe" id="section-action">All activities</a></header>
  <div class="run-amount-row"><button type="button" class="icon" id="fewer" aria-label="Fewer">−</button><span class="run-amount">8</span><button type="button" class="icon" aria-label="More">+</button></div>
  <p><button type="button" class="icon" id="icon">‹</button></p>
</section>`;

// The probe on a screen at `width` (Foods: nothing of its own changes the
// probe), in the light or dark theme.
async function probe(page, width, theme = "light") {
  await page.addInitScript((t) => localStorage.setItem("theme", t), theme);
  await page.setViewportSize({ width, height: 900 });
  await page.goto("/#/foods");
  await expect(page.locator("main h1")).toBeVisible();
  await page.evaluate((html) => {
    document.querySelector(".probe")?.remove();
    document.querySelector("main").insertAdjacentHTML("beforeend", html);
  }, PROBE);
}

const style = (page, selector, prop, pseudo = null) =>
  page
    .locator(selector)
    .evaluate(
      (el, [p, ps]) => getComputedStyle(el, ps).getPropertyValue(p),
      [prop, pseudo],
    );

const box = (page, selector) => page.locator(selector).boundingBox();

// How many lines an element's text takes: one rect per line box.
const lines = (locator) =>
  locator.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    return new Set([...range.getClientRects()].map((r) => Math.round(r.top)))
      .size;
  });

// The gap between an element and the one before it.
const above = (locator) =>
  locator.evaluate(
    (el) =>
      el.getBoundingClientRect().top -
      el.previousElementSibling.getBoundingClientRect().bottom,
  );

// Each row: the name, the value as text, then − and + (icons, a tap
// each) at the right edge, every row's at the same x.
// The trackers' rows under `root`: the name, the value as text, then −
// and + (icons, a tap each) at the right edge, every row's at the same x.
async function stepperRows(root) {
  const rows = root.locator(".habit-row");
  await expect(rows).toHaveCount(2);
  return rows.evaluateAll((list) =>
    list.map((row) => {
      const r = row.getBoundingClientRect();
      const [less, more] = [
        row.querySelector("[data-part=less]"),
        row.querySelector("[data-part=more]"),
      ];
      const count = row.querySelector("[data-part=count]");
      const [l, m] = [less, more].map((b) => b.getBoundingClientRect());
      return {
        order: [...row.children]
          .map((c) => c.dataset.part ?? c.className)
          .slice(0, 4),
        svgs: [less, more].map((b) => b.querySelectorAll("svg").length),
        less: Math.round(l.left),
        right: Math.round(r.right - m.right),
        tap: Math.min(l.width, l.height, m.width, m.height) >= 44,
        value: count.getBoundingClientRect().right <= l.left,
      };
    }),
  );
}

test.describe("tokens and type", () => {
  test.skip(({ isMobile }) => isMobile, "one run is enough");

  test("the four new tokens exist; h3 sits below h2", async ({ page }) => {
    await probe(page, 393);
    const tokens = await page.evaluate(() => {
      const s = getComputedStyle(document.documentElement);
      return ["--s8", "--row-pad", "--card-pad", "--icon"].map((t) =>
        s.getPropertyValue(t).trim(),
      );
    });
    // Computed: the aliases resolve to --s2 and --s3 --s4.
    expect(tokens).toEqual(["2rem", "0.5rem", "0.75rem 1rem", "1.25rem"]);
    // H2: the browser's 18.72/700 inverted the hierarchy.
    expect(px(await style(page, "#h3", "font-size"))).toBe(16);
    expect(await style(page, "#h3", "font-weight")).toBe("600");
    expect(px(await style(page, "#h2", "font-size"))).toBeGreaterThan(16);
    // H3: an editor card's legend is a card title, a filter's a sub-label.
    expect(px(await style(page, "#legend", "font-size"))).toBe(18);
    expect(px(await style(page, "#filter-legend", "font-size"))).toBe(16);
    // H6: a select in a legend reads like every other select.
    expect(await style(page, "#legend-select", "font-weight")).toBe("400");
  });

  test("nothing under 11 px; small text on the scale", async ({ page }) => {
    await probe(page, 393);
    // K1, K2, K3.
    expect(px(await style(page, "#cal-mark", "font-size"))).toBe(11);
    // A Highlight's numbers line at --t-sm.
    expect(px(await style(page, "#hl-numbers", "font-size"))).toBe(14);
    expect(px(await style(page, "#grid-small", "font-size"))).toBe(13);
    // L1: the chip's line height is the body's, its height from padding.
    expect(px(await style(page, "#light", "line-height"))).toBeCloseTo(
      14 * 1.45,
    );
  });
});

test.describe("rows, cards, controls", () => {
  test.skip(({ isMobile }) => isMobile, "one run is enough");

  for (const width of [320, 393, 1280])
    test(`list rows share one density at ${width}`, async ({ page }) => {
      await probe(page, width);
      // R1: one row padding, a tap at least; two-line rows the same
      // height (a result's detail goes under its name on a phone).
      for (const s of ["#result", "#menu-row", "#entry-main"])
        expect(await style(page, s, "padding-top"), s).toBe("8px");
      const heights = [
        (await box(page, "#menu-row")).height,
        (await box(page, "#entry-main")).height,
      ];
      if (width < 1280) heights.push((await box(page, "#result")).height);
      for (const h of heights) expect(Math.abs(h - heights[0])).toBeLessThan(1);
      expect((await box(page, "#result-1")).height).toBeGreaterThanOrEqual(44);
      // R2: a wrapped detail reads from the left.
      expect(await style(page, "#result-detail", "text-align")).toBe("start");
      // R5: a day row keeps the row padding.
      expect(px(await style(page, "#day-li", "padding-top"))).toBe(8);
      // C1: every card's inset is --card-pad.
      for (const s of [
        "#targets",
        "#picker",
        "#group",
        "#fieldset",
        "#filters",
        "#connections-card",
      ])
        expect(
          [
            await style(page, s, "padding-top"),
            await style(page, s, "padding-left"),
          ],
          s,
        ).toEqual(["12px", "16px"]);
      // I3: a checkbox's gap is its label's.
      expect(await style(page, "#checkbox", "margin-left")).toBe("0px");
      // R4: a Log row's kind on one line.
      expect(await lines(page.locator("#kind"))).toBe(1);
    });

  test("tiles: values on the scale, no lone half tile", async ({ page }) => {
    for (const [width, size, cols] of [
      [320, 18, 2],
      [393, 18, 2],
      [1280, 22, 4],
    ]) {
      await probe(page, width);
      // T2: one size, on the scale, across the grid.
      const sizes = await page
        .locator("#tiles .tile-value")
        .evaluateAll((list) => list.map((v) => getComputedStyle(v).fontSize));
      expect(new Set(sizes), `${width}`).toEqual(new Set([`${size}px`]));
      // T1: fixed columns; on a phone the odd last tile spans the row.
      const columns = await style(page, "#tiles", "grid-template-columns");
      expect(columns.split(" ").length, `${width}`).toBe(cols);
      const tiles = await box(page, "#tiles");
      const lone = await box(page, "#lone");
      if (cols === 2)
        expect(Math.abs(lone.width - tiles.width)).toBeLessThan(1);
      // T3: a tile is a full tap.
      expect((await box(page, "#lone")).height).toBeGreaterThanOrEqual(44);
    }
  });

  test("row actions, icons, the tick, inputs and Run's ± on the scale", async ({
    page,
  }) => {
    await probe(page, 393);
    // B3: every icon glyph at --icon.
    for (const s of ["#icon", "#remove"])
      expect(px(await style(page, s, "font-size")), s).toBe(20);
    for (const s of ["#hl-svg", "#photo-svg"])
      expect(px(await style(page, s, "width")), s).toBe(20);
    // B1: text actions in a Log row are compact.
    expect(px(await style(page, "#start", "font-size"))).toBe(14);
    // B2: the tick's box is 2 rem, drawn inside a full tap; its row's kcal
    // centred with it.
    const tick = await box(page, "#tick");
    expect(tick.height).toBeGreaterThanOrEqual(44);
    expect(await style(page, "#tick", "border-top-width")).toBe("0px");
    expect(await style(page, "#tick", "width", "::before")).toBe("32px");
    const kcal = await box(page, "#kcal");
    const row = await box(page, "#entry-main");
    expect(
      Math.abs(kcal.y + kcal.height / 2 - (row.y + row.height / 2)),
    ).toBeLessThan(2);
    // I1: grid inputs at 16 px, so iOS doesn't zoom; I2: a goal select is a tap
    // wide.
    expect(px(await style(page, "#grid-input", "font-size"))).toBe(16);
    expect(px(await style(page, "#sign", "font-size"))).toBe(16);
    expect((await box(page, "#sign")).width).toBeGreaterThanOrEqual(44);
    // Y4: a grid's first column on the content's left edge.
    expect(await style(page, "#grid-th", "padding-left")).toBe("0px");
    const widths = await page
      .locator("#actions > *")
      .evaluateAll((list) =>
        list.map((b) => [
          Math.round(b.getBoundingClientRect().top),
          b.getBoundingClientRect().width,
        ]),
      );
    // B4: wrapped or not, every action as wide as the others.
    for (const [, w] of widths)
      expect(Math.abs(w - widths[0][1]), JSON.stringify(widths)).toBeLessThan(
        1,
      );
    // B5: Run's − and + are tonal and at least 56 px.
    const fewer = await box(page, "#fewer");
    expect(Math.min(fewer.width, fewer.height)).toBeGreaterThanOrEqual(56);
    expect(await style(page, "#fewer", "background-color")).not.toBe(
      "rgba(0, 0, 0, 0)",
    );
    // H5: a section heading's action is a text link, the heading one line.
    expect(await style(page, "#section-action", "font-weight")).toBe("400");
    await page.setViewportSize({ width: 320, height: 900 });
    expect(await lines(page.locator("#section-head h2"))).toBe(1);
  });

  test("Diary headers: one row at 393, the heading centred with its buttons", async ({
    page,
  }) => {
    for (const width of [320, 393]) {
      await probe(page, width);
      // G1: "+" beside the heading, not on a row of its own; a full tap.
      const add = await box(page, "#group header > a");
      const select = await box(page, "#group header .select");
      expect(Math.abs(add.y - select.y), `${width}`).toBeLessThan(1);
      expect(
        Math.min(add.width, add.height),
        `${width}`,
      ).toBeGreaterThanOrEqual(44);
      const h2 = await box(page, "#group-bare header > h2");
      const log = await box(page, "#group-bare header > button");
      expect(
        Math.abs(h2.y + h2.height / 2 - (log.y + log.height / 2)),
        `${width}`,
      ).toBeLessThan(1);
    }
  });

  test("a list row's detail: on a phone under the name from the left, on a wide screen right of it", async ({
    page,
  }) => {
    // One rule per width, not per how long the detail is.
    await probe(page, 393);
    const [name, detail] = await Promise.all([
      box(page, "#result-1 .name"),
      box(page, "#result-1-detail"),
    ]);
    expect(Math.abs(detail.x - name.x)).toBeLessThan(1);
    expect(detail.y).toBeGreaterThanOrEqual(name.y + name.height - 1);
    await probe(page, 1280);
    const [wide, row] = await Promise.all([
      box(page, "#result-1-detail"),
      box(page, "#result-1"),
    ]);
    expect(Math.abs(wide.x + wide.width - (row.x + row.width))).toBeLessThan(1);
  });

  test("dark cards have a visible edge", async ({ page }) => {
    await probe(page, 393, "dark");
    // C3: a 1 px ring in the line colour.
    expect(await style(page, "#targets", "box-shadow")).toMatch(
      /0px 0px 0px 1px/u,
    );
  });
});

test.describe("screens", () => {
  test.skip(({ isMobile }) => isMobile, "one run is enough");

  test("titles at 320: an editor's in two lines, the period's in one", async ({
    page,
    request,
  }, testInfo) => {
    const { tag, day } = unique(80, testInfo);
    const pid = await ownProfile(page, request, `Titles ${tag}`);
    // 40 characters: past the length that used to shrink by a class.
    const name = `Oat flakes wholegrain with honey ${tag}`;
    expect(name).toHaveLength(40);
    const f = await food(request, { name, per100: { energy: 360 } });
    await page.setViewportSize({ width: 320, height: 800 });
    // H1: the editor's title, word-level breaks.
    await page.goto(`/#/food/${f.id}`);
    const h1 = page.locator(".title h1");
    await expect(h1).toHaveText(name);
    expect(await lines(h1)).toBeLessThanOrEqual(2);
    expect(await style(page, ".title h1", "hyphens")).toBe("auto");
    // H4: the Summary period, ▾ with it.
    await page.goto(`/#/summary/food/week/${day}`);
    const title = page.locator(".period-title");
    await expect(title).toBeVisible();
    expect(await lines(title)).toBe(1);
    // K4: a year's one-letter weekdays fit their mini cells.
    await entry(
      request,
      { day, group: "Eaten", food_id: f.id, grams: 100 },
      pid,
    );
    await page.goto(`/#/summary/food/year/${day}`);
    await expect(page.locator(".cal.mini").first()).toBeVisible();
    const over = await page
      .locator(".cal.mini th > span")
      .evaluateAll(
        (list) =>
          list.filter(
            (s) =>
              s.getBoundingClientRect().width >
              s.parentElement.getBoundingClientRect().width + 0.5,
          ).length,
      );
    expect(over).toBe(0);
  });

  test("the headline's dot never leads a line", async ({
    page,
    request,
  }, testInfo) => {
    const { tag } = unique(81, testInfo);
    const pid = await ownProfile(page, request, `Dot ${tag}`);
    const day = todayInApp();
    const f = await food(request, {
      name: `Dot meal ${tag}`,
      per100: { energy: 900 },
    });
    for (const group of ["Eaten", "Planned"])
      await entry(request, { day, group, food_id: f.id, grams: 120 }, pid);
    await page.setViewportSize({ width: 320, height: 800 });
    await page.goto("/#/");
    const planned = page.locator(".headline > span").last();
    await expect(planned).toHaveText(/with planned$/u);
    // G2: the "·" is drawn before the part, outside the headline's box when
    // the part starts a line (clipped), between the parts when not.
    expect(await planned.textContent()).not.toMatch(/·/u);
    expect(
      await style(page, ".headline > span:last-child", "content", "::before"),
    ).toMatch(/^"·"/u);
    expect(await style(page, ".headline", "overflow-x")).toBe("clip");
    const [line, part] = await Promise.all([
      box(page, ".headline"),
      planned.boundingBox(),
    ]);
    expect(part.x).toBe(line.x);
  });

  test("Run's − and + read as the primary control", async ({
    page,
    request,
  }, testInfo) => {
    const { tag } = unique(82, testInfo);
    await ownProfile(page, request, `Run ${tag}`);
    const all = await (await request.get("/api/exercises")).json();
    const w = await workout(request, {
      name: `Run probe ${tag}`,
      steps: [
        {
          kind: "exercise",
          exercise_id: all.find((e) => e.name === "Push-up").id,
          reps: 8,
        },
      ],
    });
    await page.setViewportSize({ width: 393, height: 800 });
    await page.goto(`/#/workout/${w.id}/run`);
    const fewer = page.locator(".run-amount-row > button").first();
    await expect(fewer).toBeVisible();
    const b = await fewer.boundingBox();
    expect(Math.min(b.width, b.height)).toBeGreaterThanOrEqual(56);
  });

  test("desktop: one page width, settings at overlay width, sections apart", async ({
    page,
    request,
  }, testInfo) => {
    const { tag, day } = unique(83, testInfo);
    const pid = await ownProfile(page, request, `Desk ${tag}`);
    const f = await food(request, {
      name: `Desk food ${tag}`,
      per100: { energy: 200 },
    });
    await entry(
      request,
      { day, group: "Eaten", food_id: f.id, grams: 100 },
      pid,
    );
    await page.setViewportSize({ width: 1280, height: 900 });
    const rem = 16;
    // Y1: a list screen fills the page's 60 rem, as every screen does.
    await page.goto("/#/foods");
    await expect(page.locator("main .result").first()).toBeVisible();
    expect((await box(page, "main > section")).width).toBe(60 * rem);
    // Y1: the Diary in one column, the targets above the groups.
    await page.goto(`/#/day/${day}`);
    await expect(page.locator(".split")).toHaveCount(0);
    const targets = await box(page, ".targets.main");
    const eaten = await page
      .locator("section.group", {
        has: page.getByRole("heading", { name: "Eaten" }),
      })
      .boundingBox();
    expect(targets.y + targets.height).toBeLessThanOrEqual(eaten.y);
    // Y2: Profile's segmented settings no wider than an overlay.
    await page.goto("/#/profile");
    const layout = page.getByRole("radiogroup", {
      name: "Layout in this browser",
    });
    await expect(layout).toBeVisible();
    expect((await layout.boundingBox()).width).toBeLessThanOrEqual(28 * rem);
    // Y3: Summary's sections and Profile's headings 32 px from what's above
    // them, a heading's content 8 under it.
    expect(await above(page.locator("main > section > h2").nth(1))).toBe(32);
    expect(await above(page.locator("main > section > h2 + *").nth(1))).toBe(8);
    await page.goto(`/#/summary/food/month/${day}`);
    const calendar = page.locator("main > section > section.food-calendar");
    await expect(calendar).toBeVisible();
    expect(await above(calendar)).toBe(32);
    // K5: a year's month links are full taps.
    await page.goto(`/#/summary/food/year/${day}`);
    const month = page.locator(".cal.mini caption > a").first();
    await expect(month).toBeVisible();
    expect((await month.boundingBox()).height).toBeGreaterThanOrEqual(44);
  });

  test("Profile editor's bar holds only full taps", async ({
    page,
    request,
  }, testInfo) => {
    const { tag } = unique(84, testInfo);
    const pid = await ownProfile(page, request, `Bar ${tag}`);
    await page.setViewportSize({ width: 393, height: 800 });
    await page.goto(`/#/profile/${pid}`);
    // B6: Recalculate on Targets, a tap tall like Delete beside it.
    const link = page.locator(".actions-bar").getByRole("link", {
      name: "Recalculate on Targets",
    });
    await expect(link).toBeVisible();
    expect((await link.boundingBox()).height).toBeGreaterThanOrEqual(44);
  });

  test("the Log card is compact: nothing expands, and the trackers' − + share one right column in the card and the sheet", async ({
    page,
    request,
  }, testInfo) => {
    const { tag } = unique(66, testInfo);
    const pid = await ownProfile(page, request, `Steppers ${tag}`);
    for (const name of ["Snus", "Coffee with a long name"]) {
      const res = await request.post(`/api/profiles/${pid}/habits`, {
        data: { name, unit: name === "Snus" ? "pouches" : "cups" },
      });
      expect(res.status()).toBe(201);
    }
    await page.setViewportSize({ width: 393, height: 800 });
    await page.goto("/#/");
    const card = page.locator(".log-card");
    await expect(card.locator("details")).toHaveCount(0);
    for (const rows of [
      await stepperRows(card),
      await (async () => {
        await card.getByRole("button", { name: /^Log on /u }).click();
        return stepperRows(page.getByRole("dialog", { name: "Log" }));
      })(),
    ]) {
      for (const row of rows)
        expect(row).toMatchObject({
          order: ["name", "count", "less", "more"],
          svgs: [1, 1],
          right: 0,
          tap: true,
          value: true,
        });
      expect(rows[0].less).toBe(rows[1].less);
    }
  });
});
