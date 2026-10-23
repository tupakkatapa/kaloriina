// Profile → Connections: readings that come in by themselves. openScale sync
// posts each weigh-in to this profile's webhook; you choose which openScale
// user is you. The Android app syncs Health Connect's active
// energy, steps and synced activities. A Google Health Takeout export is
// imported (and removed) here; Home Assistant hears about workouts. Each
// card links to its setup in the README.

import {
  api,
  currentProfile,
  get,
  loadProfiles,
  meta,
  profileId,
  scoped,
} from "../api.mjs";
import { noun, plural } from "../format.mjs";
import { href, route } from "../nav.mjs";
import { importTakeout } from "../takeout.mjs";
import {
  busy,
  choice,
  confirmDialog,
  errorBox,
  field,
  fill,
  formDialog,
  h,
  notify,
  titleBar,
} from "../ui.mjs";

const SYNC = "/sync/openscale";
const HEALTH = "/sync/health";
const HA = "/hooks/home-assistant";
const GOOGLE = "/import/google-health";

// The README section that sets up a source (the public setup guide): a
// link on its own line, a tap target as a button is.
const README = "https://github.com/tupakkatapa/kaloriina";
const help = (anchor, text) =>
  h(
    "p",
    {},
    h(
      "a",
      {
        class: "help-link",
        href: `${README}#${anchor}`,
        target: "_blank",
        rel: "noopener",
      },
      text,
    ),
  );

// "Alex (1)": openScale's name and id, as its own settings show them.
const who = (u) => `${u.username || "Unnamed"} (${u.id})`;

// "2 minutes ago", "yesterday": English, as the prose around it.
export function ago(ms) {
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  const s = Math.round((ms - Date.now()) / 1000);
  for (const [unit, size] of [
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ])
    if (Math.abs(s) >= size) return rtf.format(Math.round(s / size), unit);
  return "just now";
}

// The Profile menu's line for Connections.
export const connectionsLine = (s) =>
  s.bound_user
    ? `openScale: ${who(s.bound_user)}`
    : s.seen_users.length > 0
      ? "openScale: choose your user"
      : "Sync your scale with openScale";

async function use(user, bound) {
  if (bound) {
    const ok = await confirmDialog(`Use ${who(user)} instead?`, {
      detail: `Readings kept from ${who(bound)} become ${who(user)}'s; one at a time ${who(user)} already has goes. A full sync in openScale sync brings in the rest.`,
      confirm: "Rebind",
    });
    if (!ok) return;
  }
  await api("PUT", scoped(SYNC), { user_id: user.id });
  await loadProfiles();
  notify(`openScale user ${who(user)} is you`);
  route();
}

async function disconnect() {
  const ok = await confirmDialog("Disconnect openScale?", {
    detail:
      "Kaloriina forgets which openScale user is you. Readings and weights stay; turn the webhook off in openScale sync.",
    confirm: "Disconnect",
  });
  if (!ok) return;
  await api("DELETE", scoped(SYNC));
  notify("Disconnected openScale");
  route();
}

// The users seen, each with a Use button (the bound one left out).
const userList = (s) =>
  h(
    "ul",
    { class: "menu card" },
    s.seen_users
      .filter((u) => u.id !== s.bound_user?.id)
      .map((u) =>
        h(
          "li",
          { class: "row" },
          h(
            "span",
            { class: "grow" },
            h("span", { class: "name" }, who(u)),
            u.ignored
              ? h(
                  "span",
                  { class: "muted" },
                  ` · ${plural(u.ignored, "reading")} in the last sync`,
                )
              : null,
          ),
          h(
            "button",
            {
              type: "button",
              "aria-label": `Use ${who(u)}`,
              onclick: busy(() => use(u, s.bound_user)),
            },
            "Use",
          ),
        ),
      ),
  );

// Which openScale user is you; nothing before any reading (lastReceived
// says so).
function binding(s) {
  if (s.seen_users.length === 0) return null;
  if (!s.bound_user)
    return [
      h("p", { class: "attention" }, "Choose which openScale user is you"),
      userList(s),
    ];
  const others = s.seen_users.filter((u) => u.id !== s.bound_user.id);
  const list = userList(s);
  list.hidden = true;
  return [
    h(
      "p",
      { class: "row" },
      h("span", { class: "grow" }, `Your openScale user: ${who(s.bound_user)}`),
      others.length > 0
        ? h(
            "button",
            {
              type: "button",
              onclick: (e) => {
                list.hidden = false;
                e.currentTarget.remove();
              },
            },
            "Rebind",
          )
        : null,
    ),
    list,
    others
      .filter((u) => u.ignored)
      .map((u) =>
        h(
          "p",
          { class: "muted" },
          `Ignored ${plural(u.ignored, "reading")} from openScale user “${u.username || "Unnamed"}” (${u.id})`,
        ),
      ),
  ];
}

function lastReceived(s) {
  if (!s.last_seen)
    return h(
      "p",
      { class: "muted last-received" },
      "Nothing received yet: set up openScale sync below, then weigh yourself.",
    );
  const r = s.last_result;
  const counts = [
    r.applied ? `${plural(r.applied, "reading")} applied` : null,
    r.skipped ? `${plural(r.skipped, "reading")} skipped (invalid)` : null,
    r.ignored
      ? `${plural(r.ignored, "reading")} ignored (not your user)`
      : null,
  ].filter(Boolean);
  return h(
    "p",
    { class: "last-received" },
    `Last received ${ago(s.last_seen)}: ${counts.join(", ") || "nothing new"}`,
  );
}

// ------------------------------------------------------ Health Connect

// "Last sync 2 hours ago: 7 days, 3 activities (Pixel 9)", with a hint when
// it's over a day old or two phones take turns.
function lastSync(s) {
  if (!s.last_seen)
    return h("p", { class: "muted last-sync" }, "Nothing synced yet");
  const r = s.last_result;
  const age = Date.now() - s.last_seen;
  return [
    h(
      "p",
      { class: "last-sync" },
      `Last sync ${ago(s.last_seen)}: ${plural(r.days, "day")}, ${plural(r.nights ?? 0, "night")}, ${plural(r.sessions, "activity", "activities")}${r.device ? ` (${r.device})` : ""}${r.skipped > 0 ? ` · ${plural(r.skipped, "item")} skipped (invalid)` : ""}`,
    ),
    age > 864e5
      ? h(
          "p",
          { class: "attention" },
          `No sync for ${plural(Math.floor(age / 864e5), "day")}. Open the app's Settings to see why.`,
        )
      : null,
    r.device && r.previous_device && r.device !== r.previous_device
      ? h(
          "p",
          { class: "attention" },
          `Synced from ${r.device} and ${r.previous_device}. Activities aren't removed while two phones sync.`,
        )
      : null,
  ];
}

// Add synced activities as they come, or ask; switching to auto adds the
// ones waiting, so a shown count is read again.
async function setWorkouts(mode, waiting) {
  try {
    await api("PUT", scoped(`${HEALTH}/workouts`), { mode });
    notify(
      mode === "auto"
        ? "Activities from Health Connect are added"
        : "Activities from Health Connect wait for you",
    );
    if (waiting > 0) route();
  } catch (err) {
    notify(err.message);
    route();
  }
}

// "2 activities from Health Connect wait: see Activity", a link there; null
// when none do.
const waitingLine = (n) =>
  n > 0
    ? h(
        "p",
        { class: "waiting" },
        h(
          "a",
          { href: href.activity() },
          `${plural(n, "activity", "activities")} from Health Connect ${noun(n, "waits", "wait")}: see Activity`,
        ),
      )
    : null;

async function removeSynced() {
  const ok = await confirmDialog("Remove synced data?", {
    detail:
      "Removes synced days, sleep and the activities the app added. Activities you logged keep the synced details. The raw records kept from Health Connect go too. The app sends it again on its next sync: stop syncing in the app first.",
    confirm: "Remove",
  });
  if (!ok) return;
  await api("DELETE", scoped(HEALTH));
  notify("Removed synced data");
  route();
}

// Inside the app (its user agent says so), a link to its settings naming
// this profile; the app checks it and asks before syncing to it.
// Elsewhere, where to get the app.
const appLink = () =>
  navigator.userAgent.includes("KaloriinaAndroid/")
    ? h(
        "p",
        {},
        h(
          "a",
          {
            class: "button",
            href: `kaloriina-app://settings?profile=${profileId}`,
          },
          "App settings",
        ),
      )
    : h(
        "p",
        {},
        h(
          "a",
          { href: `${README}#android`, target: "_blank", rel: "noopener" },
          "Install the Android app",
        ),
        " to sync from Health Connect.",
      );

const healthCard = (s, waiting) => [
  h("h2", {}, "Health Connect"),
  h(
    "div",
    { class: "card stack health" },
    h(
      "p",
      { class: "muted" },
      "Active and resting energy, steps, sleep, heart rate and activities from Health Connect on your phone, through Kaloriina's Android app. The activities count as activities done, and resting energy, when the phone has it, is the energy model's; the rest shows in the Diary and Summary. Active energy never raises your energy target; steps count toward the steps target.",
    ),
    field(
      "Synced activities",
      choice({
        name: "synced-workouts",
        label: "Synced activities",
        options: [
          ["auto", "Add automatically"],
          ["ask", "Ask me"],
        ],
        value: s.workouts,
        onChange: (mode) => setWorkouts(mode, waiting.length),
      }),
      {
        hint: "Walks your device noticed on its own wait here until you add them.",
      },
    ),
    lastSync(s),
    waitingLine(waiting.length),
    appLink(),
    s.last_seen
      ? h(
          "p",
          {},
          h(
            "button",
            { type: "button", class: "danger", onclick: busy(removeSynced) },
            "Remove synced data",
          ),
        )
      : null,
  ),
];

// How the hook's last call went: "Last call: Workout finished, 2 minutes ago:
// OK" or what went wrong. The events are the server's (ADR 0024).
const lastCall = (r) => {
  const what = meta.hook_events.find((e) => e.key === r.event)?.label ?? "Test";
  const how = r.ok ? "OK" : (r.error ?? `Home Assistant answered ${r.status}`);
  return `Last call: ${what}, ${ago(r.at)}: ${how}`;
};

async function removeHook() {
  const ok = await confirmDialog("Remove the Home Assistant hook?", {
    detail: "Workouts no longer tell Home Assistant anything.",
    confirm: "Remove",
  });
  if (!ok) return;
  await api("DELETE", scoped(HA));
  notify("Removed the Home Assistant hook");
  route();
}

// Home Assistant: its address and webhook id (kept, never shown again),
// which workout events it gets, a test call and how the last call went.
function homeAssistantCard(hook) {
  const status = h("div", { role: "status" });
  const url = h("input", {
    name: "url",
    type: "url",
    required: true,
    value: hook?.url ?? "",
    placeholder: "http://homeassistant.local:8123",
    maxLength: meta.limits.hook_url,
  });
  // A secret: typed hidden, never offered from the browser's saved logins.
  const id = h("input", {
    name: "webhook_id",
    type: "password",
    required: !hook,
    autocomplete: "new-password",
    placeholder: hook ? "Saved: leave empty to keep" : "",
    maxLength: meta.limits.hook_id,
  });
  const boxes = meta.hook_events.map(({ key, label }) =>
    h(
      "label",
      { class: "check" },
      h("input", {
        type: "checkbox",
        value: key,
        checked: Boolean(hook?.events.includes(key)),
      }),
      ` ${label}`,
    ),
  );
  const save = busy(async (e) => {
    e.preventDefault();
    try {
      await api("PUT", scoped(HA), {
        url: url.value,
        ...(id.value ? { webhook_id: id.value } : {}),
        events: boxes
          .map((b) => b.querySelector("input"))
          .filter((b) => b.checked)
          .map((b) => b.value),
      });
    } catch (err) {
      fill(status, errorBox(err));
      return;
    }
    notify("Saved the Home Assistant hook");
    route();
  });
  const test = busy(async () => {
    try {
      const { result } = await api("POST", scoped(`${HA}/events`), {
        event: "test",
      });
      fill(status, h("p", {}, lastCall(result)));
    } catch (err) {
      fill(status, errorBox(err));
    }
  });
  return h(
    "form",
    { class: "card stack home-assistant", onsubmit: save },
    h(
      "p",
      { class: "muted" },
      "Tell Home Assistant when a workout starts or finishes, so its automations can set the scene. Only while this browser is online.",
    ),
    field("Home Assistant URL", url),
    field("Webhook ID", id, {
      hint: "The id of the automation's Webhook trigger.",
    }),
    help("home-assistant", "How to set up Home Assistant"),
    h(
      "div",
      { role: "group", "aria-label": "Send when" },
      h("span", { class: "muted" }, "Send when"),
      boxes,
    ),
    hook?.last_result
      ? h("p", { class: "muted last-call" }, lastCall(hook.last_result))
      : null,
    status,
    h(
      "div",
      { class: "actions" },
      h("button", { class: "primary" }, "Save"),
      hook ? h("button", { type: "button", onclick: test }, "Send test") : null,
      hook
        ? h(
            "button",
            { type: "button", class: "danger", onclick: busy(removeHook) },
            "Remove",
          )
        : null,
    ),
  );
}

// ------------------------------------------------------- Google Health

// An error the dialog shows at its file input.
const fileError = (message) =>
  Object.assign(new Error(message), { field: "files" });

// "Added 2 activities, 1 nap; filled 5 days (3 nights); kept 900 raw rows;
// 1 already here; 4 rows skipped; 1 file too big to send": every count the
// import gives.
function importedText(c) {
  const added = [
    c.activities ? plural(c.activities, "activity", "activities") : null,
    c.naps ? plural(c.naps, "nap") : null,
  ].filter(Boolean);
  const parts = [
    added.length > 0 ? `Added ${added.join(", ")}` : null,
    c.days
      ? `filled ${plural(c.days, "day")}${c.nights ? ` (${plural(c.nights, "night")})` : ""}`
      : null,
    c.records ? `kept ${plural(c.records, "raw row")}` : null,
    c.kept ? `${c.kept} already here` : null,
    c.skipped ? `${plural(c.skipped, "row")} skipped (unreadable)` : null,
    c.too_big ? `${plural(c.too_big, "file")} too big to send` : null,
  ].filter(Boolean);
  if (parts.length === 0) return "Nothing new in the export";
  const text = parts.join("; ");
  return text[0].toUpperCase() + text.slice(1);
}

// Google Health from a Google Takeout zip into the profile in use: only its
// activity files are read out of the zip and sent, heart rate in batches
// of its own (each one shown as it goes); the server fills gaps.
async function importGoogleHealth() {
  const zips = h("input", {
    type: "file",
    name: "files",
    accept: ".zip,application/zip",
    multiple: true,
  });
  const progress = h("p", { class: "muted", role: "status" });
  const counts = await formDialog("Import from Google Health", {
    body: [
      h(
        "p",
        { class: "muted" },
        "In Google Takeout, export Google Health, then choose the zip (every part, if it came in several).",
      ),
      field("Takeout zip", zips, {
        hint: "Activities, sleep, steps, active energy, heart rate and HRV are read from it; its other health files are kept as they are.",
      }),
      h(
        "p",
        { class: "muted" },
        `It fills gaps in ${currentProfile().name}'s activity: what Health Connect synced and what you logged here stays as it is. Importing again adds nothing.`,
      ),
      progress,
    ],
    submit: "Import",
    run: async () => {
      if (zips.files.length === 0) throw fileError("Choose the Takeout zip.");
      let sent = 0;
      try {
        return await importTakeout(
          [...zips.files],
          meta.limits.import_bytes,
          (files) => {
            sent += 1;
            progress.textContent = `Sending part ${sent}…`;
            return api("POST", scoped(GOOGLE), { files });
          },
        );
      } catch (e) {
        if (e.code === "too_large")
          throw fileError(
            "Too much for one upload: run kaloriina import-google-health on the server.",
          );
        // Not the server's: the zip couldn't be read.
        throw e.status === undefined ? fileError(e.message) : e;
      } finally {
        progress.textContent = "";
      }
    },
  });
  if (!counts) return;
  notify(importedText(counts));
}

async function removeGoogleHealth() {
  const ok = await confirmDialog("Remove imported Google Health data?", {
    detail:
      "Removes the days, sleep, activities and raw rows Google Health imports brought. What Health Connect synced and what you logged stay. Importing again brings them back.",
    confirm: "Remove",
  });
  if (!ok) return;
  await api("DELETE", scoped(GOOGLE));
  notify("Removed imported Google Health data");
  route();
}

const googleCard = () => [
  h("h2", {}, "Google Health"),
  h(
    "div",
    { class: "card stack google-health" },
    h(
      "p",
      { class: "muted" },
      "Activities, sleep, steps, active energy and heart rate from a Google Takeout export: it fills the gaps Health Connect left.",
    ),
    h(
      "div",
      { class: "actions" },
      h(
        "button",
        { type: "button", onclick: busy(importGoogleHealth) },
        "Import from Google Health…",
      ),
      h(
        "button",
        { type: "button", class: "danger", onclick: busy(removeGoogleHealth) },
        "Remove imported data",
      ),
    ),
    help("google-health", "How to export from Google Takeout"),
  ),
];

export async function connections() {
  const [s, health, waiting, hook] = await Promise.all([
    get(scoped(SYNC)),
    get(scoped(HEALTH)),
    get(scoped(`${HEALTH}/workouts`)),
    get(scoped(HA)),
  ]);
  const url = `${location.origin}/api/profiles/${profileId}${SYNC}`;
  const input = h("input", {
    readOnly: true,
    value: url,
    "aria-label": "Webhook URL",
    onfocus: (e) => e.target.select(),
  });
  const copy = busy(async () => {
    try {
      await navigator.clipboard.writeText(url);
      notify("Copied the webhook URL");
    } catch {
      input.focus();
      notify("Copy the selected URL");
    }
  });
  return h(
    "section",
    { class: "connections" },
    titleBar("Connections", href.profile()),
    h("h2", {}, "openScale"),
    h(
      "div",
      { class: "card stack" },
      h(
        "p",
        { class: "muted" },
        "Your scale's weigh-ins, through openScale sync's webhook.",
      ),
      h(
        "div",
        { class: "row" },
        input,
        h("button", { type: "button", onclick: copy }, "Copy"),
      ),
      lastReceived(s),
      h(
        "details",
        { class: "fold" },
        h("summary", {}, "How to set up"),
        h(
          "ol",
          {},
          h(
            "li",
            {},
            "Install openScale sync next to openScale (F-Droid or Google Play).",
          ),
          h(
            "li",
            {},
            "In openScale sync, open Webhook, turn it on and paste the URL above.",
          ),
          h(
            "li",
            {},
            "Authorization header: what your HTTPS proxy's login needs (e.g. Basic …), or empty. The phone must trust the proxy's certificate.",
          ),
          h(
            "li",
            {},
            "Press Test, then weigh yourself, and choose which openScale user is you below.",
          ),
          h(
            "li",
            {},
            "Run a full sync in openScale sync to bring in your history.",
          ),
        ),
        help("openscale", "openScale setup in the README"),
      ),
      binding(s),
      s.last_seen || s.bound_user
        ? h(
            "p",
            {},
            h(
              "button",
              { type: "button", class: "danger", onclick: busy(disconnect) },
              "Disconnect",
            ),
          )
        : null,
    ),
    healthCard(health, waiting),
    googleCard(),
    h("h2", {}, "Home Assistant"),
    homeAssistantCard(hook),
  );
}
