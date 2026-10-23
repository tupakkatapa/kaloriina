// The Profile tab: the profile in use (its measurements, which log its
// weight, and the way to its targets, connections and export), the other
// profiles, and this device's settings (screens/settings.mjs).

import { saveOnce } from "../actions.mjs";
import {
  api,
  currentProfile,
  get,
  loadProfiles,
  meta,
  profileId,
  profiles,
  scoped,
  useProfile,
} from "../api.mjs";
import { pretty, shift, today } from "../dates.mjs";
import { fmt, isNil, NBSP, plural } from "../format.mjs";
import { go, href } from "../nav.mjs";
import { KEY_TARGETS, nutrient, rangeOf } from "../nutrients.mjs";
import { menuRow } from "../rows.mjs";
import { complete, recommendFor } from "../targets.mjs";
import {
  busy,
  CHECK,
  choice,
  editor,
  field,
  h,
  icon,
  nameInput,
  notify,
  num,
  numberOrNull,
  titleBar,
  unitNum,
  unitValue,
} from "../ui.mjs";
import {
  feetInches,
  fromFeetInches,
  heightText,
  unitOf,
  unitQty,
  unitSystem,
} from "../units.mjs";
import { ago, connectionsLine } from "./connections.mjs";
import { importCronometer, importProfile, thisDevice } from "./settings.mjs";

// EFSA physical activity levels.
const ACTIVITY = [
  [1.4, "Sedentary"],
  [1.6, "Lightly active"],
  [1.8, "Active"],
  [2.0, "Very active"],
];

function ageOf(birth) {
  const [y, m, d] = birth.split("-").map(Number);
  const now = new Date();
  const month = now.getMonth() + 1;
  const hadBirthday = month > m || (month === m && now.getDate() >= d);
  return now.getFullYear() - y - (hadBirthday ? 0 : 1);
}

// Use another profile: its diary from today.
const switchTo = (o) =>
  busy(async () => {
    useProfile(o.id);
    await loadProfiles();
    go(href.today());
    notify(`Now using ${o.name}`);
  });

// Below this share of the database disk free, the row warns.
const LOW_DISK = 0.1;

// "Backups: last copy 3 hours ago". An error when the job needs looking
// at (no copy yet, or none in 48 hours: the server's `stale`) or the
// disk is nearly full; nothing when the server doesn't back up.
function backupRow({ configured, newest, stale, free_bytes, total_bytes }) {
  if (!configured) return null;
  const copy =
    newest == null ? "No backup copy yet" : `Last copy ${ago(newest)}`;
  const parts = [
    h(
      "span",
      stale ? { class: "error" } : {},
      `${copy}${stale ? ": check the backup job" : ""}`,
    ),
  ];
  const free = total_bytes ? free_bytes / total_bytes : null;
  if (free != null && free < LOW_DISK) {
    parts.push(
      " · ",
      h(
        "span",
        { class: "error" },
        `Disk space low: ${fmt(free * 100)}${NBSP}% free`,
      ),
    );
  }
  return menuRow({
    name: "Backups",
    detail: h("span", { class: "muted" }, parts),
  });
}

export async function profileHub() {
  await loadProfiles();
  const p = currentProfile();
  const [targetList, habits, sync, backups, feedback] = await Promise.all([
    get(scoped("/targets")),
    get(scoped("/habits")),
    get(scoped("/sync/openscale")),
    // Its status is a nicety: a failed read hides the row, not the hub.
    get("/backups").catch(() => ({ configured: false })),
    get("/feedback").catch(() => null),
  ]);
  const own = habits.filter((x) => !x.archived).length;
  const byKey = Object.fromEntries(targetList.map((t) => [t.metric, t]));
  // In this device's units; redrawn when they change.
  const bodyLine = () =>
    complete(p)
      ? [
          p.sex === "female" ? "Female" : "Male",
          `${ageOf(p.birth_date)} years`,
          heightText(p.height_cm),
          unitQty(p.latest_weight_kg, "kg", 1),
        ].join(" · ")
      : "Measurements missing";
  // In this device's energy unit; redrawn when it changes.
  const targetsLine = () =>
    KEY_TARGETS.filter((k) => byKey[k])
      .map(
        (k) =>
          // "~" as Targets marks an about target.
          `${nutrient(k).label} ${nutrient(k).goal === "about" ? `~${NBSP}` : ""}${rangeOf(k, byKey[k])} ${nutrient(k).unit}`,
      )
      .join(" · ") || "No targets yet";
  const targetsRow = menuRow({
    href: href.targets(),
    name: "Targets",
    detail: targetsLine(),
  });
  const profileRow = menuRow({
    href: href.profileEdit(p.id),
    name: "Profile",
    detail: bodyLine(),
  });
  return h(
    "section",
    {},
    titleBar(p.name),
    h(
      "ul",
      { class: "menu card" },
      profileRow,
      targetsRow,
      menuRow({
        href: href.habits(),
        name: "Habits",
        detail: `${plural(meta.habits.length, "built-in")} and ${own} of your own`,
      }),
      menuRow({
        href: href.connections(),
        name: "Connections",
        detail: connectionsLine(sync),
      }),
      menuRow({
        href: href.stats(),
        name: "All time",
        detail: "Your totals since the first day, in coffee cups and marathons",
      }),
      // The server names the file (kaloriina-<name>-<date>.json).
      menuRow({
        href: `/api/profiles/${p.id}/export`,
        download: "",
        name: `Export ${p.name}`,
        detail:
          "Everything in this profile: Diary, Body, habits, activities and targets",
      }),
      menuRow({
        onclick: busy(importCronometer),
        name: "Import from Cronometer…",
        detail: "Your diary history from its export",
      }),
      backupRow(backups),
      menuRow({
        href: href.feedback(),
        name: "Feedback",
        detail: feedback?.open
          ? `${feedback.open} waiting to be read`
          : "Report a bug or suggest an idea",
      }),
    ),
    h("h2", {}, "Profiles"),
    h(
      "ul",
      { class: "menu card" },
      profiles.map((o) =>
        o.id === p.id
          ? menuRow({
              cls: "current",
              "aria-current": "true",
              name: [o.name, " ", icon(CHECK)],
              detail: "In use",
            })
          : menuRow({
              onclick: switchTo(o),
              "aria-label": `Use ${o.name}`,
              name: o.name,
              detail: complete(o) ? "Switch to" : "Measurements missing",
            }),
      ),
      menuRow({
        href: href.profileEdit("new"),
        name: "New profile",
        detail: "Its own diary and targets",
      }),
      menuRow({
        onclick: busy(importProfile),
        name: "Import a profile…",
        detail: "From a file saved with Export",
      }),
    ),
    h(
      "p",
      { class: "muted" },
      "Profiles have no passwords: anyone who can open Kaloriina sees all of them.",
    ),
    thisDevice({
      onEnergy: () => {
        targetsRow.querySelector(".muted").textContent = targetsLine();
      },
      onUnits: () => {
        profileRow.querySelector(".muted").textContent = bodyLine();
        targetsRow.querySelector(".muted").textContent = targetsLine();
      },
    }),
  );
}

// The latest weigh-in's day up to tomorrow (as the profile's weight), or
// null.
async function lastWeighed(id) {
  const list = await get(`/profiles/${id}/weights?to=${shift(today(), 1)}`);
  return list.at(-1)?.day ?? null;
}

// The weight field's hint: where its value comes from and what a change
// does.
function weightHint(isNew, day) {
  if (isNew) return "Logged as today's weight.";
  if (!day) return "No weigh-in yet: entering one logs today's weight.";
  return `Last weighed ${pretty(day)}. Changing it logs today's weight.`;
}

// The height field for a stored `cm`: centimetres, or feet and inches under
// US units. `value()` is the height in cm (null when empty), `cm` itself
// while left as shown.
function heightInput(cm) {
  const [min, max] = meta.limits.height_cm;
  if (unitSystem() !== "us") {
    const input = unitNum({
      name: "height_cm",
      value: cm,
      unit: "cm",
      min,
      max,
    });
    return { label: "Height (cm)", node: input, value: () => unitValue(input) };
  }
  const [ft, inches] = isNil(cm) ? ["", ""] : feetInches(cm).map(String);
  const feet = num({
    name: "height_ft",
    value: ft,
    step: 1,
    max: 9,
    "aria-label": "Height, feet",
  });
  const rest = num({
    name: "height_in",
    value: inches,
    max: 11.9,
    "aria-label": "Height, inches",
  });
  return {
    label: "Height (ft, in)",
    node: h("div", { class: "row" }, feet, rest),
    value: () =>
      feet.value === ft && rest.value === inches
        ? (cm ?? null)
        : feet.value === "" && rest.value === ""
          ? null
          : fromFeetInches(Number(feet.value), Number(rest.value)),
  };
}

export async function profileEditor(id) {
  const isNew = id === "new";
  const [p, weighed] = isNew
    ? [
        {
          name: "",
          sex: null,
          birth_date: null,
          height_cm: null,
          latest_weight_kg: null,
          activity: null,
          goal_kg_per_week: 0,
          goal_date: null,
          latitude: null,
        },
        null,
      ]
    : await Promise.all([get(`/profiles/${id}`), lastWeighed(id)]);
  const name = nameInput({ max: meta.limits.label, value: p.name });
  const sex = choice({
    name: "sex",
    label: "Sex",
    options: [
      ["", "Not set"],
      ["female", "Female"],
      ["male", "Male"],
    ],
    value: p.sex ?? "",
  });
  const birth = h("input", {
    type: "date",
    name: "birth_date",
    value: p.birth_date ?? "",
  });
  // No `step` on weights and heights: any value the server stored saves
  // again, and one left as shown is sent back unrounded.
  const height = heightInput(p.height_cm);
  const weight = unitNum({
    name: "weight_kg",
    value: p.latest_weight_kg,
    unit: "kg",
    min: meta.limits.body_kg[0],
    max: meta.limits.body_kg[1],
  });
  const weightBefore = weight.value;
  // A value set elsewhere (the API takes any in `meta.limits.activity`)
  // stays selectable, so saving never quietly changes it.
  const levels =
    isNil(p.activity) || ACTIVITY.some(([v]) => v === p.activity)
      ? ACTIVITY
      : [[p.activity, `Custom (${fmt(p.activity, 2)})`], ...ACTIVITY];
  const activity = h(
    "select",
    { name: "activity" },
    h("option", { value: "" }, "Not set"),
    levels.map(([v, label]) =>
      h("option", { value: v, selected: v === p.activity }, label),
    ),
  );
  const goal = unitNum({
    name: "goal_kg_per_week",
    value: p.goal_kg_per_week,
    unit: "kg",
    min: meta.limits.goal_kg_per_week[0],
    max: meta.limits.goal_kg_per_week[1],
  });
  // After today, as the server takes it: a passed one stored before must be
  // cleared or moved on to save.
  const goalDate = h("input", {
    type: "date",
    name: "goal_date",
    value: p.goal_date ?? "",
    min: shift(today(), 1),
  });
  // One decimal, as the server keeps it.
  const latitude = num({
    name: "latitude",
    value: p.latitude ?? "",
    min: meta.limits.latitude[0],
    max: meta.limits.latitude[1],
    step: 0.1,
  });
  const youth = h("p", { class: "note" });
  const checkAge = () => {
    youth.textContent =
      birth.value && ageOf(birth.value) < 18
        ? "Under 18: targets use adult reference values."
        : "";
    youth.hidden = !youth.textContent;
  };
  birth.addEventListener("input", checkAge);
  checkAge();
  const body = () => ({
    name: name.value,
    sex: sex.value || null,
    birth_date: birth.value || null,
    height_cm: height.value(),
    activity: activity.value === "" ? null : Number(activity.value),
    goal_kg_per_week: unitValue(goal) ?? 0,
    goal_date: goalDate.value || null,
    latitude: numberOrNull(latitude),
    day: today(),
    ...(isNew ? {} : { rev: p.rev }),
  });
  // The weight is the weight log's: a change logs today's; left as shown
  // (or emptied) it writes nothing.
  const logWeight = (pid) => {
    if (weight.value === weightBefore || weight.value === "") return null;
    return api("PUT", `/profiles/${pid}/weights/${today()}`, {
      kg: unitValue(weight),
      set_at: Date.now(),
    });
  };
  const send = saveOnce("/profiles");
  const shell = editor({
    title: isNew ? "New profile" : "Profile",
    back: href.profile(),
    body: [
      field("Name", name),
      field("Sex", sex),
      field("Birth date", birth),
      youth,
      h(
        "div",
        { class: "pair" },
        field(height.label, height.node),
        field(`Weight (${unitOf("kg")})`, weight, {
          hint: weightHint(isNew, weighed),
        }),
      ),
      field("Activity level", activity),
      h(
        "div",
        { class: "pair" },
        field(`Weight goal (${unitOf("kg")}/week)`, goal, {
          hint: "Below 0 to lose, above 0 to gain.",
        }),
        field("Or reach it by", goalDate, {
          hint: "Your goal weight or body fat (Targets) by this day; while it's ahead it sets the pace.",
        }),
      ),
      field("Latitude (optional)", latitude, {
        hint: "Your latitude to a tenth of a degree (e.g. 51.5 for London; negative south of the equator): for the winter vitamin D tip.",
      }),
      isNew
        ? h(
            "p",
            { class: "muted" },
            "Targets start from EU (EFSA) recommendations for these measurements; without them it starts without targets. Fill them in later and recalculate, or set targets yourself.",
          )
        : null,
    ],
    // Targets are the profile in use's.
    secondary:
      Number(id) === profileId
        ? [
            h(
              "a",
              { class: "button", href: href.targets() },
              "Recalculate on Targets",
            ),
          ]
        : [],
    save: async () => {
      if (!isNew) {
        const saved = await send(body(), Number(id));
        await logWeight(id);
        await loadProfiles();
        return saved;
      }
      const saved = await send(body());
      useProfile(saved.id);
      const logged = await logWeight(saved.id);
      await recommendFor({ ...saved, latest_weight_kg: logged?.kg ?? null });
      await loadProfiles();
      return saved;
    },
    after: (saved) => (isNew ? href.today() : href.profileEdit(saved.id)),
    remove:
      isNew || profiles.length === 1
        ? null
        : {
            ask: `Delete ${p.name}?`,
            detail:
              "Its whole Diary, weights, activities and targets go with it. This can't be undone.",
            run: async () => {
              await api("DELETE", `/profiles/${id}`);
              // Its days cached for offline go too (sw.js).
              navigator.serviceWorker?.controller?.postMessage({
                forget: p.id,
              });
              await loadProfiles();
            },
            after: href.profile(),
            done: `Deleted ${p.name}`,
          },
  });
  return shell.node;
}
