// The Profile tab: the profile in use (its measurements, which log its
// weight, its targets and export), the other profiles (and import), and
// this device's layout and energy unit.

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
import { go, href, route } from "../nav.mjs";
import {
  ENERGY_UNITS,
  GOAL_HINT,
  GOAL_SIGN,
  KCAL_PER_G,
  KEY_TARGETS,
  byCategory,
  energyShare,
  energyUnit,
  fmt,
  isNil,
  nutrient,
  ordered,
  plural,
  qty,
  rangeOf,
  setEnergyUnit,
  withUnit,
} from "../nutrients.mjs";
import {
  busy,
  categoryRow,
  choice,
  confirmDialog,
  editor,
  field,
  formDialog,
  h,
  notify,
  num,
  numberOrNull,
  titleBar,
} from "../ui.mjs";
import { ago, connectionsLine } from "./connections.mjs";

// A goal's row: its name and unit, which way it points, its number (a
// `note` under it), then `extra` cells.
const targetRow = (r, note = null, ...extra) =>
  h(
    "tr",
    {},
    h("th", { scope: "row" }, withUnit(r)),
    h("td", { class: "muted", title: GOAL_HINT[r.goal] }, GOAL_SIGN[r.goal]),
    h("td", {}, r.input, note ? h("small", { class: "muted" }, note) : null),
    ...extra,
  );

const PER = { day: "a day", week: "a week" };

// The Targets screen lists metrics by their registry `section`; any other
// section is a habit's goal.
const SECTIONS = { body: "Body", activity: "Activity", sleep: "Sleep" };

// What one goal row reads and writes: the stored value (`target`, null when
// unset) shown in its display unit. An input left as shown sends the stored
// value back unchanged; a default left alone stays a default. A built-in
// habit's goal reads as the habit does (its name and unit), a day's.
function goalRow(key, target) {
  const n = nutrient(key);
  const m = n ? null : meta.metrics.find((x) => x.key === key);
  const b = meta.habits?.find((x) => x.metric === key);
  const factor = b?.factor ?? m?.display.factor ?? 1;
  const r = b
    ? { key, label: b.name, unit: b.unit, goal: n?.goal ?? m.goal, per: "day" }
    : n
      ? { key, label: n.label, unit: n.unit, goal: n.goal, per: null }
      : {
          key,
          label: m.display.label,
          unit: m.display.unit,
          goal: m.goal,
          per: m.per,
        };
  const show = n && !b ? n.show : (v) => v * factor;
  r.store = n && !b ? n.store : (v) => v / factor;
  r.target = target ?? null;
  r.input = num({
    name: key,
    value: isNil(target) ? "" : String(+show(target.value).toFixed(3)),
    "aria-label": `${r.label} target`,
  });
  r.shown = r.input.value;
  return r;
}

// The row's target as sent, or null (left empty, or a default untouched).
function rowTarget(r) {
  if (r.input.value === "") return null;
  if (r.input.value !== r.shown)
    return { metric: r.key, value: r.store(Number(r.input.value)) };
  return r.target.default ? null : { metric: r.key, value: r.target.value };
}

// A tracker's goal: at least or at most an amount a day, saved on
// the habit itself. Its way shows as the other rows' glyph (≥ or ≤),
// named in words.
function trackerRow(habit) {
  const dir = h(
    "select",
    { name: `habit-${habit.id}-dir`, "aria-label": `${habit.name} goal` },
    ["at_least", "at_most"].map((v) =>
      h(
        "option",
        {
          value: v,
          selected: v === habit.goal_dir,
          "aria-label": GOAL_HINT[v],
        },
        GOAL_SIGN[v],
      ),
    ),
  );
  const input = num({
    name: `habit-${habit.id}`,
    value: habit.goal_value ?? "",
    max: meta.limits.habit_amount,
    "aria-label": `${habit.name} target`,
  });
  const before = [dir.value, input.value];
  return {
    node: h(
      "tr",
      {},
      h("th", { scope: "row" }, `${habit.name} (${habit.unit})`),
      h("td", {}, dir),
      h("td", {}, input, h("small", { class: "muted" }, PER.day)),
    ),
    // Changed: the whole habit with its new goal, else null.
    changed: () =>
      dir.value === before[0] && input.value === before[1]
        ? null
        : {
            name: habit.name,
            unit: habit.unit,
            archived: habit.archived,
            rev: habit.rev,
            goal_value: numberOrNull(input),
            goal_dir: dir.value,
          },
    habit,
    input,
  };
}

// A metric's or built-in's row: its period, and "Recommended" while a
// registry default applies.
const goalTr = (r) =>
  targetRow(
    r,
    [PER[r.per], r.target?.default ? "Recommended" : null]
      .filter(Boolean)
      .join(" · "),
  );
// Targets' tables share their columns, so inputs line up section to
// section: the name, which way it points, the number (then a share).
const cols = (...extra) =>
  h(
    "colgroup",
    {},
    h("col", { class: "label" }),
    h("col", { class: "sign" }),
    h("col"),
    extra,
  );
const table = (trs) =>
  h("table", { class: "grid goals" }, cols(), h("tbody", {}, trs));
const section = (title, trs) =>
  trs.length ? [h("h2", {}, title), table(trs)] : null;

const MEASUREMENTS = [
  ["sex", "sex"],
  ["birth date", "birth_date"],
  ["height", "height_cm"],
  ["weight", "latest_weight_kg"],
  ["activity", "activity"],
];

// What recommendations still need, by name ("weight").
const missing = (p) =>
  MEASUREMENTS.filter(([, key]) => isNil(p[key])).map(([name]) => name);

// Recalculate: replaces the targets a recommendation gives,
// keeps the goals it doesn't (goal weight, a habit's limit).
function recalcButton(profile, shell) {
  const lacking = missing(profile);
  const why = h(
    "p",
    { class: "muted", id: "recalc-why", hidden: !lacking.length },
    `Needs sex, birth date, height, weight and activity (missing: ${lacking.join(", ")})`,
  );
  const button = h(
    "button",
    {
      type: "button",
      disabled: lacking.length > 0,
      "aria-describedby": lacking.length ? "recalc-why" : null,
      onclick: busy(async () => {
        if (
          !(await confirmDialog("Recalculate targets?", {
            detail:
              "Sets energy, nutrients, steps and sleep to what's recommended for your measurements. Other goals stay as they are.",
            confirm: "Recalculate",
            danger: false,
          }))
        )
          return;
        try {
          const [recommended, list] = await Promise.all([
            get(scoped(`/recommended?day=${today()}`)),
            get(scoped("/targets")),
          ]);
          const fresh = new Set(recommended.map((t) => t.metric));
          await api("PUT", scoped("/targets"), {
            rev: profile.rev,
            targets: [
              ...list.filter((t) => !t.default && !fresh.has(t.metric)),
              ...recommended,
            ].map((t) => ({ metric: t.metric, value: t.value })),
          });
          shell.markClean();
          await route();
          notify("Recalculated targets");
        } catch (err) {
          shell.failed(err);
        }
      }),
    },
    "Recalculate targets",
  );
  return h("div", { class: "recalc" }, button, why);
}

export async function targets() {
  const [profile, list, habits] = await Promise.all([
    get(scoped("")),
    get(scoped("/targets")),
    get(scoped("/habits")),
  ]);
  const byKey = Object.fromEntries(list.map((t) => [t.metric, t]));
  // Built-in habits' goals (meta.habits) and metrics of no other section
  // are Habits rows; they leave Other nutrients.
  const habitKeys = [
    ...new Set([
      ...(meta.habits ?? []).map((x) => x.metric),
      ...meta.metrics.filter((m) => !SECTIONS[m.section]).map((m) => m.key),
    ]),
  ];
  const rows = [
    ...ordered().map((n) => n.key),
    ...meta.metrics.map((m) => m.key),
  ].map((key) => goalRow(key, byKey[key]));
  const rowOf = (key) => rows.find((r) => r.key === key);
  const trackers = habits.filter((x) => !x.archived).map(trackerRow);
  // What share of the energy target each macro target makes up.
  const shares = Object.fromEntries(
    Object.keys(KCAL_PER_G).map((k) => [
      k,
      h("span", { class: "share muted" }),
    ]),
  );
  const updateShares = () => {
    // Shares are of kcal; the energy input is in this device's unit.
    const energy = rowOf("energy").store(Number(rowOf("energy").input.value));
    for (const [key, el] of Object.entries(shares)) {
      const grams = rowOf(key).input.value;
      el.textContent =
        grams === "" || !energy
          ? ""
          : `${energyShare(key, Number(grams), energy)} %`;
    }
  };
  updateShares();
  const metricRows = (name) =>
    meta.metrics
      .filter((m) => m.section === name)
      .map((m) => goalTr(rowOf(m.key)));
  const otherRows = ordered()
    .filter((n) => !KEY_TARGETS.includes(n.key) && !habitKeys.includes(n.key))
    .map((n) => rowOf(n.key));
  const shell = editor({
    title: "Targets",
    back: href.profile(),
    body: [
      h("h2", {}, "Energy and macros"),
      h(
        "table",
        { class: "grid goals" },
        cols(h("col", { class: "share" })),
        h(
          "thead",
          {},
          h(
            "tr",
            {},
            h("th", {}, "Nutrient"),
            h("th", {}, h("span", { class: "sr-only" }, "Goal")),
            h("th", {}, "Target"),
            h("th", {}, "% of energy"),
          ),
        ),
        h(
          "tbody",
          {},
          KEY_TARGETS.map((key) =>
            targetRow(rowOf(key), null, h("td", {}, shares[key] ?? "")),
          ),
        ),
      ),
      Object.entries(SECTIONS).map(([key, title]) =>
        section(title, metricRows(key)),
      ),
      section("Habits", [
        ...habitKeys.map((key) => goalTr(rowOf(key))),
        ...trackers.map((t) => t.node),
      ]),
      h(
        "details",
        { class: "fold" },
        h("summary", {}, "Other nutrients"),
        table(
          byCategory(otherRows, (r) => nutrient(r.key)).map(([name, rs]) => [
            categoryRow(name, 3),
            rs.map((r) => targetRow(r)),
          ]),
        ),
      ),
      h(
        "p",
        { class: "muted" },
        "≥ at least · ≤ at most · ~ about (up to 10 % over is fine)",
      ),
    ],
    // Trackers first: their own revs move on, so saving again after a
    // refused targets list repeats them harmlessly.
    save: async () => {
      for (const t of trackers) {
        const body = t.changed();
        if (!body) continue;
        try {
          Object.assign(
            t.habit,
            await api("PUT", scoped(`/habits/${t.habit.id}`), {
              ...body,
              rev: t.habit.rev,
            }),
          );
        } catch (err) {
          // The server names its own field; on this screen it is the row's.
          throw Object.assign(err, { field: t.input.name });
        }
      }
      const saved = await api("PUT", scoped("/targets"), {
        rev: profile.rev,
        targets: rows.map(rowTarget).filter(Boolean),
      });
      return saved;
    },
    saved: () => "Saved targets",
  });
  shell.form.prepend(recalcButton(profile, shell));
  shell.form.addEventListener("input", updateShares);
  return shell.node;
}

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

// Recommendations need every measurement.
const complete = (p) => missing(p).length === 0;

// Phone or desktop layout for this device; layout.js applies it.
function layoutSwitch() {
  return choice({
    name: "layout",
    label: "Layout on this device",
    options: [
      ["auto", "Auto"],
      ["phone", "Phone"],
      ["desktop", "Desktop"],
    ],
    value: localStorage.getItem("layout") ?? "auto",
    onChange: (value) => {
      localStorage.setItem("layout", value);
      document.dispatchEvent(new Event("layoutchange"));
    },
  });
}

// Energy in kcal or kJ on this device; inputs say which unit they take.
function energySwitch(onChange) {
  return choice({
    name: "energy-unit",
    label: "Energy in",
    options: ENERGY_UNITS.map((u) => [u, u]),
    value: energyUnit(),
    onChange: (value) => {
      setEnergyUnit(value);
      onChange();
    },
  });
}

// Import a profile export as a new profile: the file, then its name
// (the file's, unless changed). Resolves to the new profile, or null.
function importDialog() {
  let data = null;
  const file = h("input", {
    type: "file",
    name: "file",
    accept: ".json,application/json",
    required: true,
  });
  const name = h("input", {
    name: "name",
    required: true,
    maxLength: meta.limits.label,
  });
  file.addEventListener("change", async () => {
    try {
      data = JSON.parse(await file.files[0].text());
    } catch {
      data = null;
    }
    if (typeof data?.profile?.name === "string") name.value = data.profile.name;
  });
  return formDialog("Import a profile", {
    body: [
      field("Export file", file, {
        hint: "A file saved with Export: everything in that profile.",
      }),
      field("Name", name, {
        hint: "It comes in as a new profile. Foods and exercises it uses join the shared ones.",
      }),
    ],
    submit: "Import",
    run: () => {
      if (!data?.profile)
        throw Object.assign(
          new Error("That file isn't a Kaloriina profile export."),
          { field: "file" },
        );
      return api("POST", "/profiles/import", {
        ...data,
        profile: { ...data.profile, name: name.value },
      });
    },
  });
}

async function importProfile() {
  const saved = await importDialog();
  if (!saved) return;
  await route();
  notify(`Imported ${saved.name}`, {
    action: {
      label: "Use",
      run: async () => {
        useProfile(saved.id);
        await loadProfiles();
        go(href.today());
      },
    },
  });
}

// Cronometer history into the profile in use: either export file or both.
// The inputs are named as the API's fields, so an error focuses its file.
async function importCronometer() {
  const [servings, summary] = ["servings", "summary"].map((name) =>
    h("input", { type: "file", name, accept: ".csv,text/csv" }),
  );
  const report = await formDialog("Import from Cronometer", {
    body: [
      h(
        "p",
        { class: "muted" },
        "Export your data from Cronometer, then choose servings.csv, dailysummary.csv or both.",
      ),
      field("Servings", servings, {
        hint: "servings.csv: what you ate, food by food.",
      }),
      field("Daily summary", summary, {
        hint: "dailysummary.csv: each day's nutrients.",
      }),
      h(
        "p",
        { class: "muted" },
        `Days in the files replace history imported earlier for those days, in ${currentProfile().name}'s diary. Entries you logged here are never touched.`,
      ),
    ],
    submit: "Import",
    run: async () => {
      if (!servings.files.length && !summary.files.length)
        throw Object.assign(new Error("Choose at least one file."), {
          field: "servings",
        });
      return api("POST", scoped("/import/cronometer"), {
        // A file not chosen is left out (undefined).
        servings: await servings.files[0]?.text(),
        summary: await summary.files[0]?.text(),
      });
    },
  });
  if (!report) return;
  notify(
    `Imported ${plural(report.entries, "entry", "entries")} over ${plural(report.days, "day")}`,
  );
}

// Use another profile: its diary from today.
const switchTo = (o) =>
  busy(async () => {
    useProfile(o.id);
    await loadProfiles();
    go(href.today());
    notify(`Now using ${o.name}`);
  });

const menuRow = (to, title, detail) =>
  h(
    "li",
    {},
    h(
      "a",
      { class: "menu-row", href: to },
      h("span", { class: "name" }, title),
      h("span", { class: "muted" }, detail),
    ),
  );

// The server's start-up WARN threshold (src/main.rs `STALE_MS`).
const STALE_BACKUP_MS = 48 * 3600 * 1000;

// "Backups: last copy 3 hours ago", a warning past 48 hours; nothing
// without a copy: a server without --backup-dir answers `null` too.
function backupRow({ newest }) {
  if (newest == null) return null;
  const stale = Date.now() - newest > STALE_BACKUP_MS;
  return h(
    "li",
    {},
    h(
      "div",
      { class: "menu-row" },
      h("span", { class: "name" }, "Backups"),
      h(
        "span",
        { class: stale ? "muted error" : "muted" },
        `Last copy ${ago(newest)}${stale ? ": check the backup job" : ""}`,
      ),
    ),
  );
}

export async function profileHub() {
  await loadProfiles();
  const p = currentProfile();
  const [targetList, habits, sync, backups] = await Promise.all([
    get(scoped("/targets")),
    get(scoped("/habits")),
    get(scoped("/sync/openscale")),
    // Its status is a nicety: a failed read hides the row, not the hub.
    get("/backups").catch(() => ({ newest: null })),
  ]);
  const own = habits.filter((x) => !x.archived).length;
  const byKey = Object.fromEntries(targetList.map((t) => [t.metric, t]));
  const body = complete(p)
    ? [
        p.sex === "female" ? "Female" : "Male",
        `${ageOf(p.birth_date)} years`,
        qty(p.height_cm, "cm", 0),
        qty(p.latest_weight_kg, "kg", 1),
      ].join(" · ")
    : "Measurements missing";
  // In this device's energy unit; redrawn when it changes.
  const targetsLine = () =>
    KEY_TARGETS.filter((k) => byKey[k])
      .map(
        (k) =>
          `${nutrient(k).label} ${rangeOf(k, byKey[k])} ${nutrient(k).unit}`,
      )
      .join(" · ") || "No targets yet";
  const targetsRow = menuRow(href.targets(), "Targets", targetsLine());
  return h(
    "section",
    {},
    titleBar(p.name),
    h(
      "ul",
      { class: "menu card" },
      menuRow(href.profileEdit(p.id), "Profile", body),
      targetsRow,
      menuRow(
        href.habits(),
        "Habits",
        `${plural(meta.habits.length, "built-in")} and ${own} of your own`,
      ),
      menuRow(href.connections(), "Connections", connectionsLine(sync)),
      h(
        "li",
        {},
        // The server names the file (kaloriina-<name>-<date>.json).
        h(
          "a",
          {
            class: "menu-row",
            href: `/api/profiles/${p.id}/export`,
            download: "",
          },
          h("span", { class: "name" }, `Export ${p.name}`),
          h(
            "span",
            { class: "muted" },
            "Everything in this profile: diary, body, habits, workouts and targets",
          ),
        ),
      ),
      h(
        "li",
        {},
        h(
          "button",
          {
            class: "menu-row",
            type: "button",
            onclick: busy(importCronometer),
          },
          h("span", { class: "name" }, "Import from Cronometer…"),
          h("span", { class: "muted" }, "Your diary history from its export"),
        ),
      ),
      backupRow(backups),
    ),
    h("h2", {}, "Profiles"),
    h(
      "ul",
      { class: "menu card" },
      profiles.map((o) =>
        h(
          "li",
          {},
          o.id === p.id
            ? h(
                "div",
                { class: "menu-row current", "aria-current": "true" },
                h("span", { class: "name" }, `${o.name} ✓`),
                h("span", { class: "muted" }, "In use"),
              )
            : h(
                "button",
                {
                  class: "menu-row",
                  type: "button",
                  "aria-label": `Use ${o.name}`,
                  onclick: switchTo(o),
                },
                h("span", { class: "name" }, o.name),
                h(
                  "span",
                  { class: "muted" },
                  complete(o) ? "Switch to" : "Measurements missing",
                ),
              ),
        ),
      ),
      menuRow(
        href.profileEdit("new"),
        "New profile",
        "Its own diary and targets",
      ),
      h(
        "li",
        {},
        h(
          "button",
          { class: "menu-row", type: "button", onclick: busy(importProfile) },
          h("span", { class: "name" }, "Import a profile…"),
          h("span", { class: "muted" }, "From a file saved with Export"),
        ),
      ),
    ),
    h(
      "p",
      { class: "muted" },
      "Profiles have no passwords: anyone who can open Kaloriina sees all of them.",
    ),
    h("h2", {}, "This device"),
    field("Layout on this device", layoutSwitch(), {
      hint: "Auto follows the window's width.",
    }),
    field(
      "Energy in",
      energySwitch(() => {
        targetsRow.querySelector(".muted").textContent = targetsLine();
      }),
      { hint: "Inputs say which unit they take." },
    ),
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
  if (!day) return "No weigh-in yet. Entering one logs today's weight.";
  return `Last weighed ${pretty(day)}. Changing it logs today's weight.`;
}

// Targets recommended for a profile just made, once it has every
// measurement: the same calls as Recalculate on Targets.
async function recommendFor(p) {
  if (!complete(p)) return;
  const recommended = await get(`/profiles/${p.id}/recommended?day=${today()}`);
  await api("PUT", `/profiles/${p.id}/targets`, {
    rev: p.rev,
    targets: recommended.map((t) => ({ metric: t.metric, value: t.value })),
  });
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
        },
        null,
      ]
    : await Promise.all([get(`/profiles/${id}`), lastWeighed(id)]);
  const name = h("input", {
    name: "name",
    value: p.name,
    required: true,
    maxLength: meta.limits.label,
  });
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
  // No `step` on kg and cm: any value the server stored saves again, and
  // the prefill is the stored value, unrounded.
  const height = num({
    name: "height_cm",
    value: p.height_cm ?? "",
    min: meta.limits.height_cm[0],
    max: meta.limits.height_cm[1],
  });
  const weight = num({
    name: "weight_kg",
    value: p.latest_weight_kg ?? "",
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
  const goal = num({
    name: "goal_kg_per_week",
    value: p.goal_kg_per_week,
    min: meta.limits.goal_kg_per_week[0],
    max: meta.limits.goal_kg_per_week[1],
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
    height_cm: numberOrNull(height),
    activity: activity.value === "" ? null : Number(activity.value),
    goal_kg_per_week: numberOrNull(goal) ?? 0,
    day: today(),
    ...(isNew ? {} : { rev: p.rev }),
  });
  // The weight is the weight log's: a change logs today's; left as shown
  // (or emptied) it writes nothing.
  const logWeight = async (pid) => {
    if (weight.value === weightBefore || weight.value === "") return null;
    return api("PUT", `/profiles/${pid}/weights/${today()}`, {
      kg: Number(weight.value),
      set_at: Date.now(),
    });
  };
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
        field("Height (cm)", height),
        field("Weight (kg)", weight, { hint: weightHint(isNew, weighed) }),
      ),
      field("Activity", activity),
      field("Weight goal (kg/week)", goal, {
        hint: "Below 0 to lose, above 0 to gain.",
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
        ? [h("a", { href: href.targets() }, "Recalculate on Targets")]
        : [],
    save: async () => {
      if (!isNew) {
        const saved = await api("PUT", `/profiles/${id}`, body());
        await logWeight(id);
        await loadProfiles();
        return saved;
      }
      const saved = await api("POST", "/profiles", body());
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
              "Its whole diary, weights, workouts done and targets go with it. This can't be undone.",
            run: async () => {
              await api("DELETE", `/profiles/${id}`);
              await loadProfiles();
            },
            after: href.profile(),
            done: `Deleted ${p.name}`,
          },
  });
  return shell.node;
}
