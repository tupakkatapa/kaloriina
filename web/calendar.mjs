// A Summary calendar: a period's days as a Monday-first table, each cell
// shaded by its step of the section's `--hue`, with its amount, marks and
// words; a day after today is plain. A week is one row, a month its grid,
// a year 12 mini months of colour only whose captions open the month.

import { monthGrid, weekRow, yearMonths } from "./calendar-grid.mjs";
import { today } from "./dates.mjs";
import { href } from "./nav.mjs";
import { h } from "./ui.mjs";

// Names built once, not per table or day. 1 January 2024 was a Monday.
const WEEKDAY = new Intl.DateTimeFormat(undefined, { weekday: "short" });
const WEEKDAYS = Array.from({ length: 7 }, (_, i) =>
  WEEKDAY.format(new Date(2024, 0, 1 + i)),
);
const MONTH = new Intl.DateTimeFormat(undefined, { month: "short" });
const monthName = (ym) => MONTH.format(new Date(`${ym}-01T12:00`));

// A day's cell: its shade, hatched when nothing was logged, outlined when over;
// today, still going, outlined alone. `link` holds the visible day, amount and
// marks; without it the cell is colour and words for screen readers only (the
// year's mini months). A day after `now` hasn't happened: its date and marks (a
// plan), no shade or link.
function cell(s, day, link, now) {
  if (!day) return h("td", { class: "pad" });
  if (day > now) {
    const mark = link && s.marks(day);
    return h(
      "td",
      { class: "cal-cell future", "data-day": day },
      link
        ? h(
            "span",
            { class: "cal-day" },
            h("span", { class: "cal-dim" }, String(Number(day.slice(8)))),
            mark
              ? h("span", { class: "cal-mark", "aria-hidden": "true" }, mark)
              : null,
            mark ? h("span", { class: "sr-only" }, s.label(day)) : null,
          )
        : null,
    );
  }
  const label = s.label(day);
  // Today is still going: outlined, not shaded; unless its value
  // is already final (`s.final`: last night's sleep, a check-in made), then
  // shaded and outlined.
  const isToday = day === now;
  const shaded = !isToday || Boolean(s.final?.(day));
  const attrs = {
    class: [
      "cal-cell",
      shaded ? `shade-${s.step(day)}` : null,
      shaded && s.unlogged(day) ? "none" : null,
      shaded && s.over(day) ? "over" : null,
      isToday ? "today" : null,
    ]
      .filter(Boolean)
      .join(" "),
    "data-day": day,
  };
  if (!link)
    return h(
      "td",
      { ...attrs, title: label },
      h("span", { class: "sr-only" }, label),
    );
  const mark = s.marks(day);
  return h(
    "td",
    attrs,
    h(
      "a",
      { href: href.day(day), "aria-label": label, title: label },
      h("span", { class: "cal-dim" }, String(Number(day.slice(8)))),
      h("span", { class: "cal-amount" }, s.amount(day)),
      mark
        ? h("span", { class: "cal-mark", "aria-hidden": "true" }, mark)
        : null,
    ),
  );
}

function table(s, weeks, caption, className, link = true) {
  const now = today();
  return h(
    "table",
    { class: `cal ${className}${link ? "" : " mini"}` },
    h("caption", {}, caption),
    h(
      "thead",
      {},
      h(
        "tr",
        {},
        WEEKDAYS.map((n) =>
          h(
            "th",
            { scope: "col", "aria-label": link ? null : n },
            link ? n : h("span", { "aria-hidden": "true" }, n[0]),
          ),
        ),
      ),
    ),
    h(
      "tbody",
      {},
      weeks.map((w) =>
        h(
          "tr",
          {},
          w.map((d) => cell(s, d, link, now)),
        ),
      ),
    ),
  );
}

// The period `kind` from `from` for `series` ({amount, step, unlogged,
// over, marks, label, final?}, each a function of the day; `final(day)`
// true when today's value won't change). `monthLink(month)` is
// where a year's month caption leads; a day opens it in the Diary.
export function calendarView({
  kind,
  from,
  caption,
  series,
  monthLink,
  className,
}) {
  if (kind === "week")
    return table(series, [weekRow(from)], caption, className);
  if (kind === "month")
    return table(series, monthGrid(from.slice(0, 7)), caption, className);
  return h(
    "div",
    { class: "cal-year" },
    yearMonths(Number(from.slice(0, 4))).map(({ month, weeks }) =>
      table(
        series,
        weeks,
        h("a", { href: monthLink(month) }, monthName(month)),
        className,
        false,
      ),
    ),
  );
}
