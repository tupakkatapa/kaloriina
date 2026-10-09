// Daily check-ins as text and numbers: a day's line, a period's stats and
// tag counts, the Highlights series and the tags the dialog offers. No DOM
// here, so `node --test` covers it.

// The scales, in order: [key, label].
export const METRICS = [
  ["mood", "Mood"],
  ["energy", "Energy"],
  ["stress", "Stress"],
];

const isSet = (v) => v !== null && v !== undefined;

// A tag as the server stores it: trimmed, inner spaces collapsed,
// lowercase.
export const normalTag = (t) => t.trim().split(/\s+/).join(" ").toLowerCase();

// `list` normalised, blanks and repeats dropped, order kept, at most `max`.
export const tagsOf = (list, max = Infinity) =>
  [...new Set(list.map(normalTag).filter(Boolean))].slice(0, max);

// "Mood 4 · Energy 3 · Stress 2 · travel": unset scales left out.
export const line = (c) =>
  [
    ...METRICS.filter(([key]) => isSet(c[key])).map(
      ([key, label]) => `${label} ${c[key]}`,
    ),
    ...(c.tags ?? []),
  ].join(" · ");

// The period's `metric`: its mean, how many days have it, and its highest
// and lowest value with the days that have it and the latest of them.
// Null when no day has it.
export function stats(list, metric) {
  const rated = list.filter((c) => isSet(c[metric]));
  if (!rated.length) return null;
  const values = rated.map((c) => c[metric]);
  const extreme = (value) => {
    const days = rated.filter((c) => c[metric] === value).map((c) => c.day);
    return { value, days: days.length, day: days.toSorted().at(-1) };
  };
  return {
    mean: values.reduce((t, v) => t + v, 0) / values.length,
    count: rated.length,
    highest: extreme(Math.max(...values)),
    lowest: extreme(Math.min(...values)),
  };
}

// [[tag, days]] over the period, most used first, then alphabetical.
export function tagCounts(list) {
  const counts = new Map();
  for (const c of list)
    for (const t of c.tags ?? []) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts].toSorted(
    ([a, n], [b, m]) => m - n || (a < b ? -1 : a > b ? 1 : 0),
  );
}

// Each scale as a web/insights.mjs series, "checkin:<key>": its samples
// are the days that have it. Scales no day has are left out.
export function series(list) {
  const out = {};
  for (const [key] of METRICS) {
    const rated = list.filter((c) => isSet(c[key]));
    if (rated.length)
      out[`checkin:${key}`] = {
        values: new Map(rated.map((c) => [c.day, c[key]])),
        samples: rated.map((c) => c.day),
      };
  }
  return out;
}

// The tags of your own in `list`, most used first (then alphabetical), at
// most `max`; built-ins left out.
export const customTags = (list, builtins, max = 12) =>
  tagCounts(list)
    .map(([t]) => t)
    .filter((t) => !builtins.includes(t))
    .slice(0, max);

// What the dialog offers: the built-ins, then the day's own tags, then
// `custom`, each once.
export const offered = (builtins, own, custom) => [
  ...new Set([...builtins, ...own, ...custom]),
];
