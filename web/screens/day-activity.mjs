// The diary day's Activity card, above the Log: the day's movement as its
// headline, then the workouts planned, the activities done, those a device
// recorded waiting for Add or Dismiss, and activities logged here still
// waiting to send. Its + logs an activity on the day (a day ahead: plans
// a workout).

import { keptHere } from "../actions.mjs";
import { activitiesMetres } from "../activities.mjs";
import { activitySheet, startLink } from "../activity-sheet.mjs";
import { activityType, get, profileId, scoped, uid, write } from "../api.mjs";
import { pretty, today } from "../dates.mjs";
import { activityText } from "../device.mjs";
import { fmt, isNil, plural, whole } from "../format.mjs";
import { go, goDay, href } from "../nav.mjs";
import { latest, waiting } from "../outbox.mjs";
import { activityBrief, logRow, pendingRow, result } from "../rows.mjs";
import { dayContext, dayEnergy } from "../series.mjs";
import { unitQty } from "../units.mjs";
import {
  empty,
  h,
  icon,
  PLUS,
  removeButton,
  tickButton,
  undoable,
} from "../ui.mjs";

// A workout planned on the day: its name opens the workout (back to the
// day); today Start runs it there (Resume, a run of it kept); ✕ drops the
// plan (with Undo); the planned tick, right as a planned food's, logs it
// done (the activity editor, from the workout), which claims the plan.
function plannedRow(day, plan) {
  const back = href.day(day);
  const row = logRow(
    "Planned",
    result({
      href: href.workout(plan.workout_id, back),
      name: plan.name,
    }),
    day === today()
      ? startLink(
          { id: plan.workout_id, name: plan.name },
          { day, cls: "button compact" },
        )
      : null,
    removeButton(`Remove the plan for ${plan.name}`, async () => {
      const label = `Remove the plan for ${plan.name}`;
      const done = await write(
        "DELETE",
        scoped(`/plans/${plan.id}`),
        undefined,
        label,
      );
      if (done.queued) return keptHere(done.queued, day);
      goDay(day);
      undoable(`Removed ${plan.name} from ${pretty(day)}`, async () => {
        const again = await write(
          "POST",
          scoped("/plans"),
          { day, workout_id: plan.workout_id, uid: uid() },
          plan.name,
        );
        if (again.queued) keptHere(again.queued, day);
        else goDay(day);
      });
    }),
    tickButton(`Log ${plan.name} done`, () =>
      go(href.activityEdit("new", { day, workout: plan.workout_id, back })),
    ),
  );
  row.classList.add("planned");
  return row;
}

// An activity done: its type, then its name over what it was ("Upper
// body" over "45 min · active 250 kcal", rows.mjs activityBrief); a name
// that only repeats the type is left out, the line its value. It opens its
// view, back to the day. Burned energy is shown, not taken off the energy
// target: the activity level behind it already counts it. `ctx` the day's
// (series.mjs dayContext), as the headline's.
function activityRow(day, s, ctx) {
  const type = activityType(s.type)?.label ?? "Activity";
  const line = activityBrief(s, ctx);
  const named = s.name && s.name !== type;
  return logRow(
    type,
    result({
      href: href.activityView(s.id, href.day(day)),
      name: named ? s.name : line,
      detail: named ? line : null,
      "aria-label": named ? null : `${type}, ${line}`,
    }),
  );
}

// An activity logged here, still on this device: its label, "Waiting to
// send" (or why it wasn't sent).
const queuedRow = (x) =>
  logRow(
    "Waiting",
    result({
      cls: "queued",
      name: x.label,
      detail: x.failed ? "Not sent" : "Waiting to send",
    }),
  );

// The day's activity creates still on this device.
export const queuedActivities = (day) =>
  waiting(profileId, day).filter(
    (x) => x.method === "POST" && x.path.endsWith("/activities"),
  );

// Metres as km to a tenth, as Summary's.
const km = (m) => unitQty(m / 1000, "km", 1);

// The day's distance: the device's ("6.1 km"),
// all it counted, walking too; under its activities' (activitiesMetres)
// the device missed some, so the day went at least theirs ("≥ 8.2 km");
// without the device's, theirs alone, said as such ("5.2 km in
// activities"). Null without either.
function dayDistance(data) {
  const device = data.device_day?.distance_m ?? null;
  const metres = activitiesMetres(data.activities ?? []);
  if (!isNil(device) && device >= metres) return km(device);
  if (!metres) return null;
  return isNil(device) ? `${km(metres)} in activities` : `≥ ${km(metres)}`;
}

// "6.1 km · 8,412 steps of 10,000 · active 420 of 600 kcal": the day's
// distance (dayDistance), its steps and active energy (as the
// Summary counts it, web/series.mjs dayEnergy: a device's measured, else
// its activities' alone a floor) against their targets, its parts. Null
// on a day with none (resting energy alone isn't movement).
function headline(data) {
  const steps = data.device_day?.steps ?? null;
  const active = dayEnergy(data);
  const distance = dayDistance(data);
  if (isNil(steps) && !active && !distance) return null;
  const target = (metric) =>
    data.targets.find((t) => t.metric === metric)?.value ?? null;
  const stepsGoal = target("steps");
  const energy = active
    ? activityText(
        {
          active_kcal: active.kcal,
          floor: active.floor,
          estimated: active.estimated,
        },
        target("active_kcal"),
      )?.value.replace(/^Active/u, "active")
    : null;
  return [
    distance,
    isNil(steps)
      ? null
      : `${plural(steps, "step")}${isNil(stepsGoal) ? "" : ` of ${fmt(stepsGoal)}`}`,
    energy,
  ]
    .filter(Boolean)
    .map((x) => whole(x));
}

// The day's rows, in order.
function rows(day, data) {
  const ctx = dayContext(data);
  return [
    ...(data.plans ?? [])
      // A removal waiting to send has taken it already.
      .filter((p) => latest(scoped(`/plans/${p.id}`))?.method !== "DELETE")
      .map((p) => plannedRow(day, p)),
    ...(data.activities ?? []).map((s) => activityRow(day, s, ctx)),
    ...(data.pending_activities ?? []).map((p) =>
      pendingRow(p, () => goDay(day)),
    ),
    ...queuedActivities(day).map((x) => queuedRow(x)),
  ];
}

// "+": up to today, the activity sheet for the day (each way back to it);
// a day ahead has nothing done yet, so it plans one.
function plus(day) {
  const on = pretty(day);
  if (day > today())
    return h(
      "a",
      {
        class: "button icon",
        href: href.plan(day),
        "aria-label": `Plan a workout on ${on}`,
      },
      icon(PLUS),
    );
  return h(
    "button",
    {
      type: "button",
      class: "icon",
      "data-add": true,
      "aria-haspopup": "dialog",
      "aria-label": `Log an activity on ${on}`,
      onclick: async () =>
        activitySheet({
          // Offline and never read: the sheet still offers every type.
          workouts: await get("/workouts").catch(() => []),
          day,
          back: href.day(day),
        }),
    },
    icon(PLUS),
  );
}

export function activityCard(day, data) {
  const list = rows(day, data);
  const parts = headline(data);
  return h(
    "section",
    { class: "group activity-card" },
    h(
      "header",
      {},
      h("h2", {}, "Activity"),
      // Each part whole, the "·" drawn before it (the Diary's headline's
      // rule): a line never starts with one.
      parts?.length
        ? h(
            "p",
            { class: "muted total headline" },
            parts.map((part) => h("span", {}, part)),
          )
        : null,
      plus(day),
    ),
    list.length > 0
      ? h("ul", { class: "log-rows" }, list)
      : empty(day > today() ? "Nothing planned." : "Nothing logged."),
  );
}
