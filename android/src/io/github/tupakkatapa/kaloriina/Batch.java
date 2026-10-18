package io.github.tupakkatapa.kaloriina;

import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/**
 * One sync's read: its days, exercise sessions and weighings as the window's JSON, or nothing when
 * any read failed or a page was left unread (a partial window would delete days on the server). Its
 * days hold the phone's own values; nights, naps and HRV are the server's to make from the raw
 * records, so the window only lists the ids it read of the kinds it makes them from.
 */
public final class Batch {
    private final Window window;
    private final ZoneId zone;
    private final String device;
    private final TreeMap<LocalDate, Day> days = new TreeMap<>();
    private final List<String> sessions = new ArrayList<>();
    private final List<Weight> weights = new ArrayList<>();
    private final List<Measure> measures = new ArrayList<>();
    private final Map<String, List<String>> read = new LinkedHashMap<>();
    private String why;

    private record Weight(String key, Instant at, double kg, String origin) {}

    private record Measure(String field, Instant at, double value) {}

    /** A day's totals and heart rates, each null when Health Connect had none. */
    private static final class Day {
        Long activeKcal;
        Long totalKcal;
        Long steps;
        Long restingHr;
        Long avgHr;
        Long minHr;
        Long maxHr;
    }

    public Batch(Window window, ZoneId zone, String device) {
        this.window = window;
        this.zone = zone;
        this.device = device;
    }

    private Day at(LocalDate day) {
        return days.computeIfAbsent(day, d -> new Day());
    }

    /** A day's totals; outside the window it's left out. */
    public void day(LocalDate day, Long activeKcal, Long steps) {
        if (window.contains(day) && (activeKcal != null || steps != null)) {
            at(day).activeKcal = activeKcal;
            at(day).steps = steps;
        }
    }

    /** A day's total energy burned (kcal); outside the window it's left out. */
    public void total(LocalDate day, Long kcal) {
        if (window.contains(day) && kcal != null) {
            at(day).totalKcal = kcal;
        }
    }

    /** A day's resting heart rate (bpm); outside the window it's left out. */
    public void rhr(LocalDate day, Long bpm) {
        if (window.contains(day) && bpm != null) {
            at(day).restingHr = bpm;
        }
    }

    /** A day's heart rate (bpm): mean, lowest, highest; outside the window it's left out. */
    public void heart(LocalDate day, Long avg, Long min, Long max) {
        if (window.contains(day) && (avg != null || min != null || max != null)) {
            at(day).avgHr = avg;
            at(day).minHr = min;
            at(day).maxHr = max;
        }
    }

    /**
     * A record of {@code kind} the window read ({@link Kinds#DERIVED_FROM}): listed, so the server
     * lets go of one Health Connect no longer has. A kind read with none is listed empty.
     */
    public void read(String kind, String id) {
        List<String> ids = read.computeIfAbsent(kind, k -> new ArrayList<>());
        if (id != null) {
            ids.add(id);
        }
    }

    /**
     * An exercise session, on its start's day in the zone; outside the window it's left out. {@code
     * kcal} is its active energy; {@code kcalTotal} its total (resting included), read when a
     * device writes no active energy. Its distance is always sent: the server keeps it for a type
     * that covers ground.
     */
    public void session(
            String key,
            Instant start,
            Instant end,
            int type,
            CharSequence title,
            Long kcal,
            Long kcalTotal,
            Long distanceM,
            int recordingMethod,
            Payload.Heart hr) {
        LocalDate day = Payload.dayOf(start, zone);
        if (!window.contains(day)) {
            return;
        }
        String name = title == null ? "" : title.toString().strip();
        int method = recordingMethod >= 0 && recordingMethod <= 3 ? recordingMethod : 0;
        sessions.add(
                "{\"key\":"
                        + Payload.quoted(key)
                        + ",\"day\":"
                        + Payload.quoted(day.toString())
                        + ",\"start_at\":"
                        + Payload.quoted(start.toString())
                        + ",\"end_at\":"
                        + Payload.quoted(end.toString())
                        + ",\"type\":"
                        + type
                        + ",\"name\":"
                        + Payload.quoted(name.isEmpty() ? Payload.typeName(type) : name)
                        + ",\"kcal\":"
                        + kcal
                        + ",\"kcal_total\":"
                        + kcalTotal
                        + ",\"distance_m\":"
                        + Payload.within(distanceM, 0, 1_000_000)
                        + ",\"recording_method\":"
                        + method
                        + ",\"avg_hr\":"
                        + (hr == null ? null : hr.avg())
                        + ",\"max_hr\":"
                        + (hr == null ? null : hr.max())
                        + "}");
    }

    /** A weighing; its day in the zone must be in the window to be sent. */
    public void weight(String key, Instant at, double kg, String origin) {
        weights.add(new Weight(key, at, kg, origin));
    }

    /**
     * A body reading ({@code body_fat} %, {@code lbm_kg}, {@code bone_kg}, {@code bmr_kcal} a day):
     * it goes with the weighing nearest it within 2 minutes, else nowhere.
     */
    public void measure(String field, Instant at, double value) {
        measures.add(new Measure(field, at, value));
    }

    /** A read failed: nothing is sent. */
    public void incomplete(String reason) {
        if (why == null) {
            why = reason;
        }
    }

    /** The read of {@code what} stopped with {@code nextPageToken} (-1 when none was left). */
    public void pageLeft(long nextPageToken, String what) {
        if (nextPageToken != -1) {
            incomplete("Health Connect had more " + what + " than one read");
        }
    }

    public String why() {
        return why;
    }

    /** The day items: values out of bounds left out, days with nothing left dropped. */
    private List<String> dayItems() {
        List<String> out = new ArrayList<>();
        for (Map.Entry<LocalDate, Day> e : days.entrySet()) {
            Day v = e.getValue();
            Long rhr = Payload.within(v.restingHr, 20, 250);
            Long avgHr = Payload.within(v.avgHr, 20, 250);
            Long minHr = Payload.within(v.minHr, 20, 250);
            Long maxHr = Payload.within(v.maxHr, 20, 250);
            Long total = Payload.within(v.totalKcal, 0, 30_000);
            if (v.activeKcal == null
                    && total == null
                    && v.steps == null
                    && rhr == null
                    && avgHr == null
                    && minHr == null
                    && maxHr == null) {
                continue;
            }
            out.add(
                    new Payload.Json()
                            .begin()
                            .put("day", e.getKey().toString())
                            .put("active_kcal", v.activeKcal)
                            .put("total_kcal", total)
                            .put("steps", v.steps)
                            .put("resting_hr", rhr)
                            .put("avg_hr", avgHr)
                            .put("min_hr", minHr)
                            .put("max_hr", maxHr)
                            .end()
                            .toString());
        }
        return out;
    }

    /** The weighings in the window, oldest first, each with its nearest body readings. */
    private List<String> bodyItems() {
        List<Weight> sorted = new ArrayList<>(weights);
        sorted.sort(Comparator.comparing(Weight::at));
        List<String> out = new ArrayList<>();
        for (Weight w : sorted) {
            LocalDate day = Payload.dayOf(w.at(), zone);
            if (window.contains(day)) {
                out.add(
                        new Payload.Json()
                                .begin()
                                .put("key", w.key())
                                .put("day", day.toString())
                                .put("at", w.at())
                                .put("kg", Payload.round(w.kg(), 2))
                                .put("body_fat", part(w, "body_fat", 1))
                                .put("lbm_kg", part(w, "lbm_kg", 2))
                                .put("bone_kg", part(w, "bone_kg", 2))
                                .put("bmr_kcal", part(w, "bmr_kcal", 0))
                                .put("origin", w.origin())
                                .end()
                                .toString());
            }
        }
        return out;
    }

    /** The {@code field} reading nearest {@code w} among those nearest it, rounded; or null. */
    private Number part(Weight w, String field, int places) {
        Measure best = null;
        for (Measure m : measures) {
            if (m.field().equals(field)
                    && nearest(m.at()) == w
                    && (best == null || gap(m.at(), w.at()) < gap(best.at(), w.at()))) {
                best = m;
            }
        }
        if (best == null) {
            return null;
        }
        if (places == 0) {
            return Math.round(best.value());
        }
        return Payload.round(best.value(), places);
    }

    /** The weighing nearest {@code at} within 2 minutes, or null. */
    private Weight nearest(Instant at) {
        Weight best = null;
        for (Weight w : weights) {
            if (gap(at, w.at()) <= 120 && (best == null || gap(at, w.at()) < gap(at, best.at()))) {
                best = w;
            }
        }
        return best;
    }

    private static long gap(Instant a, Instant b) {
        return Math.abs(Duration.between(a, b).getSeconds());
    }

    public int days() {
        return dayItems().size();
    }

    public int sessions() {
        return sessions.size();
    }

    /** The POST body, or null when the read was incomplete. */
    public String json() {
        if (why != null) {
            return null;
        }
        return "{\"from\":"
                + Payload.quoted(window.from.toString())
                + ",\"to\":"
                + Payload.quoted(window.to.toString())
                + ",\"device\":"
                + Payload.quoted(device)
                + ",\"days\":["
                + String.join(",", dayItems())
                + "],\"sessions\":["
                + String.join(",", sessions)
                + "],\"body\":["
                + String.join(",", bodyItems())
                + "],\"read\":"
                + new Payload.Json().value(read)
                + "}";
    }
}
