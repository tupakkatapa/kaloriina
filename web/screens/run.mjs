// Running a workout step by step, then saving what was done.

import { api, get, meta, scoped, stored, uid, weightKg } from "../api.mjs";
import { iso, pretty } from "../dates.mjs";
import { go, href, leaving } from "../nav.mjs";
import { capitalized, plural } from "../nutrients.mjs";
import {
  busy,
  confirmDialog,
  choice,
  editor,
  field,
  h,
  notify,
  num,
  numberOrNull,
  titleBar,
} from "../ui.mjs";
import {
  countdown,
  describe,
  describeSet,
  details,
  fingerprint,
  harder,
  kcalFor,
  lastTime,
  lastTimeText,
  newRecords,
  runKey,
  swapExercise,
  unroll,
} from "../workouts.mjs";

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
// The one label of the run's mute toggle (pressed: muted). Muting stops
// the beeps only: vibration and the screen lock stay.
const SOUND_LABEL = "Sound off";
const SOUND_KEY = "sound";
const muted = () => localStorage.getItem(SOUND_KEY) === "off";
function soundToggle() {
  const button = h(
    "button",
    {
      type: "button",
      class: "sound",
      "aria-pressed": String(muted()),
      onclick: () => {
        if (muted()) localStorage.removeItem(SOUND_KEY);
        else localStorage.setItem(SOUND_KEY, "off");
        button.setAttribute("aria-pressed", String(muted()));
      },
    },
    SOUND_LABEL,
  );
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

// The run kept for workout `id`, if it's for these exact steps.
function keptRun(id, fp) {
  try {
    const kept = JSON.parse(sessionStorage.getItem(runKey(id)));
    return kept?.fp === fp ? kept : null;
  } catch {
    return null; // unreadable: start over
  }
}

// Goes through a workout step by step: reps wait for Done (− / + record
// what you actually did, and the weight used can change), rests and timed
// steps count down by themselves and beep their last 3 seconds. Finish
// ends early with what was done. Progress is kept for the tab's life, so a
// reload or a detour resumes — only for the same steps: an edited workout
// starts over. At the end the session is saved to the diary.
export async function workoutRun(id, params) {
  // This navigation's teardown, taken before loading: if you leave while it
  // loads, nothing starts.
  const { signal } = leaving;
  // Every session so far: what you did last time, and the bests a new
  // record beats.
  const [workout, exercises, history] = await Promise.all([
    get(`/workouts/${id}`),
    get("/exercises"),
    get(scoped("/sessions")),
  ]);
  if (signal.aborted) return null;
  const byId = new Map(exercises.map((e) => [e.id, e]));
  const steps = unroll(workout.steps, byId);
  const fp = fingerprint(steps);
  const kept = params.get("fresh") ? null : keptRun(id, fp);
  if (kept && !kept.finished && Date.now() - kept.touched > STALE_MS)
    return staleRun(workout, kept, steps.length);
  const state = kept ?? {
    fp,
    at: 0,
    startedAt: Date.now(),
    // Started from a plan (`?day=`): saved on that day.
    day: params.get("day") ?? iso(new Date()),
    // What was done at each step: reps as adjusted, seconds as held, kg.
    done: steps.map(() => ({})),
    finished: false,
  };
  const keep = () => {
    state.touched = Date.now();
    sessionStorage.setItem(runKey(id), JSON.stringify(state));
  };
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

  let deadline = 0; // when the current timed step ends
  let left = 0; // seconds left when paused
  let paused = false;
  let shown = null;
  let lock = null;
  const step = () => steps[state.at];
  const done = () => state.done[state.at];

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
  const weight = num({
    step: "any",
    min: 0,
    max: meta.limits.kg,
    "aria-label": "Weight used (kg)",
    oninput: () => {
      done().kg = numberOrNull(weight) ?? undefined;
      keep();
    },
  });
  const weightRow = h(
    "label",
    { class: "row run-weight" },
    h("span", {}, "Weight"),
    weight,
    h("span", {}, "kg"),
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
  // Leaving a step records it: a timed one keeps the seconds actually held
  // (all of them when it ran out).
  const record = () => {
    if (step()?.kind !== "exercise") return;
    if (step().seconds) done().seconds = step().seconds - remaining();
    else done().reps ??= step().reps;
    done().reached = true;
  };
  const finish = () => {
    stop();
    state.finished = true;
    keep();
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
          if (step()?.seconds && remaining() < step().seconds) record();
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
    where,
    what,
    extra,
    h("div", { class: "run-amount-row" }, fewer, amountText, more),
    weightRow,
    last,
    next,
    h("div", { class: "actions run-controls" }, back, pause, doneButton),
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
    where.textContent = [`Step ${state.at + 1} of ${steps.length}`, s.round]
      .filter(Boolean)
      .join(" · ");
    what.textContent =
      { rest: "Rest", pad: "Next round" }[s.kind] ?? e?.name ?? "Exercise";
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
    weight.value = done().kg ?? s.kg ?? "";
    const after = steps[state.at + 1];
    next.textContent = after ? `Next: ${describe(after, byId)}` : "Last step";
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
            sessionStorage.setItem(runKey(workout.id), JSON.stringify(kept));
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
            sessionStorage.removeItem(runKey(workout.id));
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
// replace them in the workout once the session is saved (with Undo).
function finishScreen({ workout, run, exercises, history, state, keep }) {
  const byId = new Map(exercises.map((e) => [e.id, e]));
  const sets = run.flatMap((s, i) => {
    const d = state.done[i];
    if (s.kind !== "exercise" || !d.reached) return [];
    const weight = d.kg ?? s.kg;
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
  const took = Math.round((Date.now() - state.startedAt) / 60000);
  const minutes = Math.min(meta.limits.minutes, Math.max(1, took));
  const day = h("input", {
    type: "date",
    name: "day",
    required: true,
    value: state.day,
  });
  const time = num({
    name: "minutes",
    value: minutes,
    step: 1,
    min: 1,
    max: meta.limits.minutes,
    required: true,
  });
  const energy = num({
    name: "kcal",
    value: workout.kcal ?? "",
    step: 1,
    min: 0,
    max: meta.limits.kcal,
  });
  const estimate = () => {
    const est = kcalFor(numberOrNull(time) ?? 0, weightKg());
    energy.placeholder = est === null ? "" : `≈ ${est}`;
  };
  time.addEventListener("input", estimate);
  estimate();
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
  const harderPart = picks.length
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
    const body = (list, rev) => ({
      name: fresh.name,
      minutes: fresh.minutes,
      kcal: fresh.kcal,
      steps: list,
      rev,
    });
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
            detail: "It won't be saved to the diary.",
            confirm: "Discard",
          }))
        )
          return;
        sessionStorage.removeItem(runKey(workout.id));
        go(href.workouts());
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
      field("Day", day),
      h(
        "div",
        { class: "pair" },
        field("Duration (min)", time),
        field("Energy (kcal)", energy, {
          hint: "Empty: estimated from the duration and your weight.",
        }),
      ),
      harderPart,
    ],
    saveLabel: "Save to diary",
    secondary: [discard],
    save: async () => {
      const body = {
        uid: state.uid,
        day: day.value,
        workout_id: workout.id,
        name: workout.name,
        minutes: Number(time.value),
        kcal: numberOrNull(energy),
        sets,
        // When it began, if it's the day it's saved on.
        ...(iso(new Date(state.startedAt)) === day.value
          ? { start_at: new Date(state.startedAt).toISOString() }
          : {}),
      };
      let session = body;
      const queued =
        (await stored(async () => {
          session = await api("POST", scoped("/sessions"), body, {
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
      if (chosen.length && !queued) {
        const result = await swap(chosen);
        if (result.stale) {
          // Saved (a second Save sends the same uid: saved once), but the
          // workout moved on: show the picks again over its new version.
          notify("Workout changed; pick again", { error: true });
          return undefined;
        }
        outcome.swapped = result;
      }
      sessionStorage.removeItem(runKey(workout.id));
      return session;
    },
    after: (session) => href.day(session.day),
    saved: (s) => {
      const { chosen, queued, swapped } = outcome;
      const records = newRecords(history, { ...s, sets });
      const message = [
        `Saved ${s.name} to ${pretty(s.day)}`,
        swapped
          ? `next time: ${chosen.map((c) => c.to.name).join(", ")}`
          : null,
        queued && chosen.length
          ? "Saved on this device; change the workout when online"
          : null,
        records.length
          ? `New record${records.length > 1 ? "s" : ""}: ${records.map(describeSet).join(", ")}`
          : null,
      ]
        .filter(Boolean)
        .join(" · ");
      return swapped
        ? { message, action: { label: "Undo", run: swapped.undo } }
        : message;
    },
  });
  return node;
}
