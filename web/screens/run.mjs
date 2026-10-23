// Running a workout step by step, then saving what was done.

import {
  api,
  get,
  hookEvent,
  meta,
  profileId,
  scoped,
  stored,
  uid,
} from "../api.mjs";
import { pretty, today } from "../dates.mjs";
import { capitalized, countdown, plural } from "../format.mjs";
import { go, href, leaving } from "../nav.mjs";
import { readJson, writeJson } from "../prefs.mjs";
import { loadResting } from "../rows.mjs";
import {
  busy,
  choice,
  confirmDialog,
  editor,
  field,
  fill,
  h,
  icon,
  notesSection,
  notify,
  num,
  SOUND,
  titleBar,
} from "../ui.mjs";
import { inputText, readInput, toShown, unitOf } from "../units.mjs";
import {
  describe,
  describeSet,
  details,
  exerciseIds,
  fingerprint,
  harder,
  lastTime,
  lastTimeText,
  library,
  newRecords,
  swapExercise,
  unroll,
} from "../workouts.mjs";
import { activityForm } from "./activity-editor.mjs";

// A short tone; the run screen beeps the last seconds of a rest or hold.
// Browsers start audio only from a tap, so every run button calls
// `wakeAudio` first.
let audio = null;
function wakeAudio() {
  try {
    audio ??= new AudioContext();
    if (audio.state === "suspended") audio.resume();
  } catch {
    // Sound is a nicety: no audio device, no beep.
  }
}
// The run's sound toggle, an icon in its header (pressed: sound on; off,
// the speaker struck through). Muting stops the beeps only: vibration and
// the screen lock stay.
const SOUND_KEY = "sound";
const muted = () => localStorage.getItem(SOUND_KEY) === "off";
function soundToggle() {
  const paint = () =>
    fill(button, icon(muted() ? `${SOUND}M4 4l16 16` : SOUND)).setAttribute(
      "aria-pressed",
      String(!muted()),
    );
  const button = h("button", {
    type: "button",
    class: "icon sound",
    "aria-label": "Sound",
    onclick: () => {
      if (muted()) localStorage.removeItem(SOUND_KEY);
      else localStorage.setItem(SOUND_KEY, "off");
      paint();
    },
  });
  paint();
  return button;
}
function beep(ms = 120, hz = 880) {
  if (muted() || audio?.state !== "running") return;
  const tone = audio.createOscillator();
  const volume = audio.createGain();
  tone.frequency.value = hz;
  volume.gain.value = 0.2;
  tone.connect(volume).connect(audio.destination);
  tone.start();
  tone.stop(audio.currentTime + ms / 1000);
}

// Whether a step counts down: a timed exercise, a rest, an EMOM pad.
const timed = (s) => Boolean(s?.seconds) || s?.kind === "pad";

// A run left alone this long asks whether to resume or start over.
const STALE_MS = 12 * 60 * 60 * 1000;

// A run is kept on this device (localStorage: a phone kills a backgrounded
// app, and the run must survive that), per profile and workout.
const runPrefix = () => `run:${profileId}:`;
// The run kept for workout `id` (in progress, or finished but not saved).
// Unreadable reads as none: start over.
export const keptRunOf = (id) => readJson(runPrefix() + id, null);
const keepRun = (id, state) => writeJson(runPrefix() + id, state);
const dropRun = (id) => localStorage.removeItem(runPrefix() + id);

// The run waiting for this profile, the latest touched: {id, name, finished,
// at, touched}, or null. A Resume banner's source.
export function runWaiting() {
  const prefix = runPrefix();
  let latest = null;
  for (const key of Object.keys(localStorage)) {
    if (!key.startsWith(prefix)) continue;
    const kept = readJson(key, null);
    if (kept && !(kept.touched <= latest?.touched))
      latest = {
        id: Number(key.slice(prefix.length)),
        name: kept.name,
        finished: kept.finished,
        at: kept.at,
        touched: kept.touched,
      };
  }
  return latest;
}

// "Pull day in progress · Resume": the run waiting (`runWaiting`), for the
// Diary and Activity; null without one. A run kept for a workout deleted
// since is dropped, never linked.
export async function runBanner() {
  const run = runWaiting();
  if (!run) return null;
  try {
    await get(`/workouts/${run.id}`);
  } catch (err) {
    // Unreachable says nothing about the workout: the run still waits.
    if (err.status === 404) {
      dropRun(run.id);
      return null;
    }
  }
  return h(
    "p",
    { class: "run-banner" },
    h(
      "span",
      {},
      run.finished
        ? `${run.name} done, not saved yet`
        : `${run.name} in progress`,
    ),
    h(
      "a",
      { class: "button primary", href: href.run(run.id) },
      run.finished ? "Save" : "Resume",
    ),
  );
}

// The run kept for workout `id`, if it's for these exact steps.
function keptRun(id, fp) {
  const kept = keptRunOf(id);
  return kept?.fp === fp ? kept : null;
}

// The activities that did any of the exercises `ids`, oldest first, each
// with only their sets: what you did last time and the bests a new record
// beats, from each exercise's history (never every activity ever). One that
// can't be read (offline: the worker keeps no history) is none: the run
// goes on without its last time.
async function historyOf(ids) {
  const done = new Map();
  const all = await Promise.all(
    [...ids].map((x) =>
      get(scoped(`/exercises/${x}/history`)).catch(() => ({ days: [] })),
    ),
  );
  for (const { days } of all)
    for (const d of days) {
      if (!done.has(d.activity_id))
        done.set(d.activity_id, { id: d.activity_id, day: d.day, sets: [] });
      done.get(d.activity_id).sets.push(...d.sets);
    }
  return [...done.values()].toSorted(
    (a, b) => a.day.localeCompare(b.day) || a.id - b.id,
  );
}

// Goes through a workout step by step: reps wait for Done (− / + record
// what you actually did, and the weight used can change), rests and timed
// steps count down by themselves and beep their last 3 seconds. Finish
// ends early with what was done. Progress is kept on the device, so a
// reload, a detour or a killed app resumes — only for the same steps: an
// edited workout starts over. Leaving doesn't ask: it keeps running, and
// the Resume banner leads back. At the end the activity is saved to the
// diary.
export async function workoutRun(id, params) {
  // This navigation's teardown, taken before loading: if you leave while it
  // loads, nothing starts.
  const { signal } = leaving;
  const [workout, exercises] = await Promise.all([
    get(`/workouts/${id}`),
    get("/exercises"),
    loadResting(),
  ]);
  const history = await historyOf(exerciseIds(workout.steps));
  if (signal.aborted) return null;
  const byId = new Map(exercises.map((e) => [e.id, e]));
  const steps = unroll(workout.steps, byId);
  const fp = fingerprint(steps);
  const kept = params.get("fresh") ? null : keptRun(id, fp);
  if (kept && !kept.finished && Date.now() - kept.touched > STALE_MS)
    return staleRun(workout, kept, steps.length);
  const state = kept ?? {
    fp,
    name: workout.name,
    at: 0,
    startedAt: Date.now(),
    // Started from a plan (`?day=`): saved on that day.
    day: params.get("day") ?? today(),
    // What was done at each step: reps as adjusted, seconds as held, kg.
    done: steps.map(() => ({})),
    finished: false,
  };
  const keep = () => {
    state.touched = Date.now();
    keepRun(id, state);
  };
  // A run starting (not resumed) tells Home Assistant; kept at once, a
  // reload resumes it instead of starting again.
  if (!kept) {
    keep();
    hookEvent("workout_started", { workout: workout.name });
  }
  if (state.finished)
    return finishScreen({
      workout,
      run: steps,
      exercises,
      history,
      state,
      keep,
    });
  // When each step was first shown: an EMOM round counts from its first.
  state.shownAt ??= [];

  // When the current timed step ends; the seconds left when paused.
  let deadline = 0;
  let left = 0;
  let paused = false;
  let shown = null;
  let lock = null;
  const step = () => steps[state.at];
  const done = () => state.done[state.at];

  // A note of the workout's, above the step after it (workouts.mjs unroll).
  const note = h("p", { class: "run-note" });
  const where = h("p", { class: "muted run-where" });
  const what = h("h2", { class: "run-what", "aria-live": "polite" });
  const extra = h("p", { class: "run-extra" });
  const amountText = h("p", { class: "run-amount" });
  const last = h("p", { class: "muted run-last" });
  const reps = () => done().reps ?? step().reps;
  const changeReps = (by) => {
    done().reps = Math.max(0, reps() + by);
    amountText.textContent = `× ${reps()}`;
    keep();
  };
  const fewer = h(
    "button",
    {
      type: "button",
      class: "icon",
      "aria-label": "One rep fewer",
      onclick: () => changeReps(-1),
    },
    "−",
  );
  const more = h(
    "button",
    {
      type: "button",
      class: "icon",
      "aria-label": "One rep more",
      onclick: () => changeReps(1),
    },
    "+",
  );
  // In this device's units; left as shown, the step's kg stay as they
  // were (`shownKg`, what the step showed).
  let shownKg = null;
  const weight = num({
    max: Math.ceil(toShown(meta.limits.kg, "kg")),
    "aria-label": `Weight used (${unitOf("kg")})`,
    // Emptied: no weight used (null), never the plan's again.
    oninput: () => {
      done().kg = readInput(weight.value, shownKg, "kg");
      keep();
    },
  });
  const weightRow = h(
    "label",
    { class: "row run-weight" },
    h("span", {}, "Weight"),
    weight,
    h("span", {}, unitOf("kg")),
  );
  const next = h("p", { class: "muted" });
  const progress = h("progress", {
    max: steps.length,
    value: 0,
    "aria-label": "Progress",
  });
  const tap = (fn) => () => {
    wakeAudio();
    fn();
  };

  const remaining = () =>
    paused ? left : Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
  // Leaving a step records it: a timed one the seconds actually held (all
  // of them when it ran out), only when held at all, never fewer than held
  // before (Back onto it, then Skip).
  const record = () => {
    if (step()?.kind !== "exercise") return;
    if (step().seconds) {
      const held = step().seconds - remaining();
      if (held <= 0) return;
      done().seconds = Math.max(done().seconds ?? 0, held);
    } else done().reps ??= step().reps;
    done().reached = true;
  };
  const finish = () => {
    stop();
    state.finished = true;
    // Its time ends now: a finish screen opened later says the same.
    state.endedAt ??= Date.now();
    keep();
    hookEvent("workout_finished", { workout: workout.name });
    go(href.run(id));
  };

  const back = h(
    "button",
    { type: "button", onclick: tap(() => show(state.at - 1)) },
    "Back",
  );
  const pause = h(
    "button",
    {
      type: "button",
      onclick: tap(() => {
        if (paused) {
          deadline = Date.now() + left * 1000;
          paused = false;
          pause.textContent = "Pause";
        } else {
          left = remaining();
          paused = true;
          pause.textContent = "Resume";
        }
      }),
    },
    "Pause",
  );
  const doneButton = h(
    "button",
    {
      type: "button",
      class: "primary",
      onclick: tap(() => {
        record();
        show(state.at + 1);
      }),
    },
    "Done",
  );
  const finishEarly = h(
    "button",
    {
      type: "button",
      class: "link",
      onclick: busy(async () => {
        if (
          await confirmDialog("Finish now?", {
            detail: "What you've done so far is kept; the rest is skipped.",
            confirm: "Finish",
            danger: false,
          })
        ) {
          // Seconds already held count; a reps step not marked Done doesn't.
          if (step()?.seconds) record();
          finish();
        }
      }),
    },
    "Finish",
  );
  const screen = h(
    "div",
    { class: "run" },
    progress,
    note,
    where,
    what,
    extra,
    h("div", { class: "run-amount-row" }, fewer, amountText, more),
    weightRow,
    last,
    next,
    h("div", { class: "actions run-controls" }, back, pause, doneButton),
    // The workout's notes, folded on every step: open them when wanted.
    notesSection(workout.notes, { fold: true }),
    h("p", {}, finishEarly),
  );

  const tick = () => {
    if (!timed(step()) || paused) return;
    const s = remaining();
    if (s !== shown) {
      shown = s;
      amountText.textContent = countdown(s);
      if (s > 0 && s <= 3) beep();
    }
    if (s === 0) {
      beep(400, 660);
      navigator.vibrate?.(300);
      record();
      show(state.at + 1);
    }
  };
  const timer = setInterval(tick, 200);
  // Keep the screen on while it runs; the lock drops when the page hides.
  // A lock granted after you left is let go at once.
  const wake = () =>
    navigator.wakeLock
      ?.request("screen")
      .then((l) => {
        if (signal.aborted) l.release();
        else lock = l;
      })
      .catch(() => {});
  const onVisible = () => document.visibilityState === "visible" && wake();
  function stop() {
    clearInterval(timer);
    lock?.release();
    document.removeEventListener("visibilitychange", onVisible);
  }
  wake();
  document.addEventListener("visibilitychange", onVisible);
  signal.addEventListener("abort", stop, { once: true });
  // Space is Done (or Skip) from a keyboard: not held down, not in a
  // dialog, not where Space types or presses something of its own.
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== " " || e.repeat || document.querySelector("dialog[open]"))
        return;
      if (
        e.target.closest?.(
          "input, textarea, select, button, a, [contenteditable]",
        )
      )
        return;
      e.preventDefault();
      doneButton.click();
    },
    { signal },
  );

  function show(index) {
    state.at = Math.max(0, index);
    if (state.at >= steps.length) return finish();
    keep();
    const s = step();
    const e = byId.get(s.exercise_id);
    state.shownAt[state.at] ??= Date.now();
    paused = false;
    shown = null;
    progress.value = state.at;
    note.textContent = noteText(s);
    note.hidden = !s.notes;
    where.textContent = [`Step ${state.at + 1} of ${steps.length}`, s.round]
      .filter(Boolean)
      .join(" · ");
    what.textContent =
      s.label ??
      { rest: "Rest", pad: "Next round" }[s.kind] ??
      e?.name ??
      "Exercise";
    extra.textContent = s.kind === "exercise" ? capitalized(details(s, e)) : "";
    if (s.seconds) deadline = Date.now() + s.seconds * 1000;
    // An EMOM round ends `every` seconds after its first step began.
    if (s.kind === "pad")
      deadline =
        (state.shownAt[state.at - s.steps] ?? Date.now()) + s.every * 1000;
    amountText.textContent = s.reps ? `× ${reps()}` : countdown(remaining());
    const before = s.kind === "exercise" && lastTime(history, s.exercise_id);
    last.textContent = before
      ? `Last time (${pretty(before.day)}): ${lastTimeText(before)}`
      : "";
    fewer.hidden = more.hidden = !s.reps;
    // The weight used, where the exercise takes one.
    const weighted =
      s.kind === "exercise" && (e?.load ?? "optional") !== "none";
    weightRow.hidden = !weighted;
    shownKg = "kg" in done() ? done().kg : (s.kg ?? null);
    weight.value = inputText(shownKg, "kg");
    const after = steps[state.at + 1];
    next.textContent = after
      ? `Next: ${[noteText(after), describe(after, byId)].filter(Boolean).join(" · ")}`
      : s.notesAfter
        ? `Next: ${noteText({ notes: s.notesAfter })}`
        : "Last step";
    pause.hidden = !timed(s);
    pause.textContent = "Pause";
    doneButton.textContent = timed(s) ? "Skip" : "Done";
    back.disabled = state.at === 0;
    tick();
  }

  show(state.at);
  return h(
    "section",
    { class: "run-screen" },
    titleBar(workout.name, href.workout(id), soundToggle()),
    screen,
  );
}

// The notes a step carries (workouts.mjs unroll), each "Warm-up · 5 min
// easy rowing" (its name, its text), one after another; "" without.
const noteText = (s) =>
  (s.notes ?? [])
    .map((n) => [n.name, n.text?.trim()].filter(Boolean).join(" · "))
    .join(" · ");

// A run left alone for hours: resume where it was, or start over.
function staleRun(workout, kept, length) {
  return h(
    "section",
    { class: "run-screen" },
    titleBar(workout.name, href.workout(workout.id)),
    h("h2", {}, "Resume this workout?"),
    h(
      "p",
      { class: "muted" },
      `Started ${pretty(kept.day)}, at step ${kept.at + 1} of ${length}.`,
    ),
    h(
      "div",
      { class: "actions" },
      h(
        "button",
        {
          type: "button",
          onclick: () => {
            kept.touched = Date.now();
            keepRun(workout.id, kept);
            go(href.run(workout.id));
          },
        },
        "Resume",
      ),
      h(
        "button",
        {
          type: "button",
          class: "primary",
          onclick: () => {
            dropRun(workout.id);
            go(href.run(workout.id));
          },
        },
        "Start over",
      ),
    ),
  );
}

// The exercises whose every planned set hit its target (reps or seconds),
// each with its next harder variants (`harder`); those with none are left
// out.
function readyForHarder(run, state, exercises) {
  const byId = new Map(exercises.map((e) => [e.id, e]));
  const hit = new Map();
  for (const [i, s] of run.entries()) {
    if (s.kind !== "exercise") continue;
    const d = state.done[i];
    const ok =
      d.reached && (s.seconds ? d.seconds >= s.seconds : d.reps >= s.reps);
    hit.set(s.exercise_id, (hit.get(s.exercise_id) ?? true) && ok);
  }
  return [...hit]
    .filter(([, ok]) => ok)
    .map(([id]) => byId.get(id))
    .filter(Boolean)
    .map((exercise) => ({ exercise, options: harder(exercise, exercises) }))
    .filter((r) => r.options.length);
}

// The run is over: what was done, on the day it started, ready to save.
// Exercises done in full offer their next harder variants: picked ones
// replace them in the workout once the activity is saved (with Undo).
function finishScreen({ workout, run, exercises, history, state, keep }) {
  const byId = new Map(exercises.map((e) => [e.id, e]));
  const sets = run.flatMap((s, i) => {
    const d = state.done[i];
    if (s.kind !== "exercise" || !d.reached) return [];
    const weight = "kg" in d ? d.kg : s.kg;
    return [
      {
        exercise_id: s.exercise_id,
        name: byId.get(s.exercise_id)?.name ?? "Exercise",
        ...(s.seconds
          ? { seconds: d.seconds ?? s.seconds }
          : { reps: d.reps ?? s.reps }),
        ...(weight ? { kg: weight } : {}),
        ...(s.side ? { side: s.side } : {}),
      },
    ];
  });
  // Whole minutes, at least one (as the form saves it).
  const took = Math.max(
    1,
    Math.round(((state.endedAt ?? Date.now()) - state.startedAt) / 60000),
  );
  // The activity form, filled with the run: started then, on its day.
  const form = activityForm(
    {
      day: state.day,
      name: workout.name,
      minutes: Math.min(meta.limits.activity_minutes, took),
      kcal: workout.kcal,
      sets,
      type: "workout",
      start_at: new Date(state.startedAt).toISOString(),
    },
    { lib: library(exercises) },
  );
  // The id this save is made under, kept with the run: saving twice (a
  // retry, a second tap after a reload) saves once.
  state.uid ??= uid();
  keep();
  const ready = readyForHarder(run, state, exercises);
  const picks = ready.map(({ exercise, options }) => ({
    exercise,
    options,
    control: choice({
      name: `harder-${exercise.id}`,
      label: `Next time, instead of ${exercise.name}`,
      options: [["", "Keep"], ...options.map((o) => [String(o.id), o.name])],
    }),
  }));
  const harderPart =
    picks.length > 0
      ? h(
          "fieldset",
          { class: "harder" },
          h("legend", {}, "Ready for harder"),
          h(
            "p",
            { class: "muted" },
            "Every set hit its target. Next time, in this workout:",
          ),
          picks.map((p) => field(p.exercise.name, p.control)),
        )
      : null;
  // What the save did besides saving, for its one toast.
  let outcome = null;

  // Swap the picked exercises in the workout as it is now; null if none
  // were picked. A workout changed since this screen opened isn't touched.
  async function swap(chosen) {
    const fresh = await get(`/workouts/${workout.id}`);
    if (fresh.rev !== workout.rev) {
      Object.assign(workout, fresh);
      return { stale: true };
    }
    let next = fresh.steps;
    for (const { exercise, to } of chosen)
      next = swapExercise(next, exercise.id, to);
    // The workout as read, whole (a PUT replaces it): only the steps change.
    const body = (list, rev) => ({ ...fresh, steps: list, rev });
    try {
      const saved = await api(
        "PUT",
        `/workouts/${workout.id}`,
        body(next, fresh.rev),
      );
      return {
        undo: () =>
          api("PUT", `/workouts/${workout.id}`, body(fresh.steps, saved.rev)),
      };
    } catch (err) {
      if (err.code !== "stale") throw err;
      Object.assign(workout, await get(`/workouts/${workout.id}`));
      return { stale: true };
    }
  }

  const discard = h(
    "button",
    {
      type: "button",
      onclick: busy(async () => {
        if (
          !(await confirmDialog("Discard this workout?", {
            detail: "It won't be saved to the Diary.",
            confirm: "Discard",
          }))
        )
          return;
        dropRun(workout.id);
        go(href.activity());
      }),
    },
    "Don't save",
  );
  const { node } = editor({
    title: workout.name,
    back: href.workout(workout.id),
    body: [
      h("h2", { class: "run-done" }, "Workout done"),
      h(
        "p",
        { class: "muted" },
        `${plural(sets.length, "set")} in ${plural(took, "minute")}.`,
      ),
      ...form.fields,
      harderPart,
    ],
    saveLabel: "Save to diary",
    secondary: [discard],
    save: async () => {
      const body = { ...form.body(), uid: state.uid, workout_id: workout.id };
      let activity = body;
      const queued =
        (await stored(async () => {
          activity = await api("POST", scoped("/activities"), body, {
            queue: true,
            label: workout.name,
          });
        })) !== true;
      const chosen = picks
        .filter((p) => p.control.value)
        .map((p) => ({
          exercise: p.exercise,
          to: p.options.find((o) => String(o.id) === p.control.value),
        }));
      outcome = { chosen, queued, swapped: null };
      if (chosen.length > 0 && !queued) {
        const result = await swap(chosen);
        if (result.stale) {
          // Saved (a second Save sends the same uid: saved once), but the
          // workout moved on: show the picks again over its new version.
          notify("Workout changed; pick again", { error: true });
          return;
        }
        outcome.swapped = result;
      }
      dropRun(workout.id);
      return activity;
    },
    after: (activity) => href.day(activity.day),
    saved: (s) => {
      const { chosen, queued, swapped } = outcome;
      const records = newRecords(history, s);
      const message = [
        `Saved ${s.name} to ${pretty(s.day)}`,
        swapped
          ? `next time: ${chosen.map((c) => c.to.name).join(", ")}`
          : null,
        queued && chosen.length > 0
          ? "Saved in this browser; change the workout when online"
          : null,
        records.length > 0
          ? `New record${records.length > 1 ? "s" : ""}: ${records.map((x) => describeSet(x)).join(", ")}`
          : null,
      ]
        .filter(Boolean)
        .join(" · ");
      return swapped ? { message, undo: swapped.undo } : message;
    },
  });
  return node;
}
