// Profile's settings for this browser (layout, theme, energy unit, units,
// nutrition label) and its importers (a profile export, Cronometer).

import {
  api,
  currentProfile,
  loadProfiles,
  meta,
  scoped,
  uid,
  useProfile,
} from "../api.mjs";
import { NBSP, plural } from "../format.mjs";
import { go, href, route } from "../nav.mjs";
import { setEnergyUnit, setLabelStyle } from "../nutrients.mjs";
import { LAYOUT_KEY, THEME_KEY } from "../prefs.mjs";
import { choice, field, formDialog, h, nameInput, notify } from "../ui.mjs";
import {
  ENERGY_UNITS,
  energyUnit,
  LABEL_STYLES,
  labelStyle,
  setUnitSystem,
  UNIT_SYSTEMS,
  unitSystem,
} from "../units.mjs";

// Phone or desktop layout for this device; layout.js applies it.
function layoutSwitch() {
  return choice({
    name: "layout",
    label: "Layout in this browser",
    options: [
      ["auto", "Auto"],
      ["phone", "Phone"],
      ["desktop", "Desktop"],
    ],
    value: localStorage.getItem(LAYOUT_KEY) ?? "auto",
    onChange: (value) => {
      localStorage.setItem(LAYOUT_KEY, value);
      document.dispatchEvent(new Event("layoutchange"));
    },
  });
}

// Light or dark for this device; layout.js applies it.
function themeSwitch() {
  return choice({
    name: "theme",
    label: "Theme",
    options: [
      ["system", "System"],
      ["light", "Light"],
      ["dark", "Dark"],
    ],
    value: localStorage.getItem(THEME_KEY) ?? "system",
    onChange: (value) => {
      localStorage.setItem(THEME_KEY, value);
      document.dispatchEvent(new Event("themechange"));
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

// Metric or US (imperial) units on this device.
function unitsSwitch(onChange) {
  return choice({
    name: "units",
    label: "Units",
    options: UNIT_SYSTEMS,
    value: unitSystem(),
    onChange: (value) => {
      setUnitSystem(value);
      onChange();
    },
  });
}

// The EU or US nutrition label on this device: how values read and are
// typed (ADR 0018's basis), never what's stored.
function labelSwitch() {
  return choice({
    name: "label-style",
    label: "Nutrition label",
    options: LABEL_STYLES,
    value: labelStyle(),
    onChange: setLabelStyle,
  });
}

// Import a profile export as a new profile: the file, then its name
// (the file's, unless changed). Resolves to the new profile, or null. An
// import sent again (its answer lost) answers the profile it made.
function importDialog() {
  let data = null;
  // One per dialog: every Import press in it is the same import.
  const key = uid();
  const file = h("input", {
    type: "file",
    name: "file",
    accept: ".json,application/json",
    required: true,
  });
  const name = nameInput({ max: meta.limits.label });
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
      return api("POST", `/profiles/import?uid=${key}`, {
        ...data,
        profile: { ...data.profile, name: name.value },
      });
    },
  });
}

export async function importProfile() {
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
export async function importCronometer() {
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
      if (servings.files.length === 0 && summary.files.length === 0)
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

// The "This browser" section: each switch with its hint; `onEnergy` and
// `onUnits` redraw what shows in those units.
export const thisDevice = ({ onEnergy, onUnits }) => [
  h("h2", {}, "This browser"),
  field("Layout in this browser", layoutSwitch(), {
    hint: "Auto follows the window's width.",
  }),
  field("Theme", themeSwitch(), {
    hint: "System follows this device's light or dark setting.",
  }),
  field("Energy in", energySwitch(onEnergy), {
    hint: "Inputs say which unit they take.",
  }),
  field("Units", unitsSwitch(onUnits), {
    hint: "Weight, height, distance and drinks; stored metric.",
  }),
  field("Nutrition label", labelSwitch(), {
    hint: `EU: per 100${NBSP}g, carbs net of fibre, salt. US: per serving, total carbs with fibre, sodium, % Daily Value.`,
  }),
];
