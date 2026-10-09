// What every Summary subtab shares, loaded once per period: the
// profile's goals by metric, Health Connect's days, the check-ins, and the
// cross-domain Highlights series made from them. A subtab adds only its own
// domain's series; a new shared source is one entry here.

import { get, scoped } from "./api.mjs";
import { series as checkInSeries } from "./check-ins.mjs";
import { sleepSeries } from "./insights.mjs";

// The days of Health Connect `days` that have `key`, as a series.
const present = (days, key) => {
  const have = days.filter((d) => d[key] !== null && d[key] !== undefined);
  return {
    values: new Map(have.map((d) => [d.day, d[key]])),
    samples: have.map((d) => d.day),
  };
};

// The period `p`'s shared data: `targets` (metric → {value, min, max,
// default?}, registry defaults included), `activity` (Health Connect days),
// `checkIns`, and `series` ({sleep, steps, checkin:*}).
export async function sharedSeries(p) {
  const range = `from=${p.from}&to=${p.to}`;
  const [targets, activity, checkIns] = await Promise.all([
    get(scoped("/targets")),
    get(scoped(`/activity?${range}`)),
    get(scoped(`/check-ins?${range}`)),
  ]);
  return {
    targets: Object.fromEntries(targets.map((t) => [t.metric, t])),
    activity: activity.days,
    checkIns,
    series: {
      sleep: sleepSeries(activity.days),
      steps: present(activity.days, "steps"),
      ...checkInSeries(checkIns),
    },
  };
}
