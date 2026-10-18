package io.github.tupakkatapa.kaloriina;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.function.BooleanSupplier;
import java.util.function.Function;
import java.util.function.LongSupplier;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * What the sync sends, without Android: the read of a window ({@link Batch}, its days in {@link
 * Window}, its kinds in {@link Kinds}), the records pages, the sync that sends one window and the
 * run that sends them all, and the checks on what the page and the user hand the app. {@code
 * PayloadTest} covers it on the JVM.
 */
public final class Payload {
    /** Days the first sync sends and the most a normal one goes back. */
    static final int FIRST_DAYS = 30;

    static final int NORMAL_DAYS = 7;

    /** The resyncs on offer, in days. */
    public static final int RESYNC_DAYS = 90;

    public static final int RESYNC_YEAR = 365;

    /**
     * Days per resync POST: inside the server's 92-day window, and few enough that one chunk's
     * Health Connect reads stay under their page cap.
     */
    public static final int CHUNK_DAYS = 30;

    /**
     * The most UTF-8 bytes in one records page: under the server's 1 MiB body cap ({@code
     * tests/fixtures/health/record-limits.json} pins both).
     */
    public static final int PAGE_BYTES = 768 * 1024;

    /**
     * The most UTF-8 bytes of a record's {@code data} sent as read: a bigger one is sent as the
     * server's flag ({@code model::records::kept_data}), so a record always fits a page.
     */
    public static final int RECORD_BYTES_MAX = 512 * 1024;

    /** The longest text a flag keeps, in UTF-8 bytes. */
    public static final int FLAG_TEXT_MAX = 200;

    /** Pages of 1000 one window read takes at most; more left is an incomplete window. */
    public static final int PAGES_MAX = 10;

    private static final long ID_MAX = 1L << 53;

    /**
     * Health Connect's exercise types by number (API 35), named; any other number is {@link
     * #ACTIVITY}. {@code tests/fixtures/health/exercise-types.json} pins it.
     */
    private static final Map<Integer, String> TYPES =
            Map.ofEntries(
                    Map.entry(1, "Badminton"),
                    Map.entry(2, "Baseball"),
                    Map.entry(3, "Basketball"),
                    Map.entry(4, "Biking"),
                    Map.entry(5, "Stationary biking"),
                    Map.entry(6, "Boot camp"),
                    Map.entry(7, "Boxing"),
                    Map.entry(8, "Calisthenics"),
                    Map.entry(9, "Cricket"),
                    Map.entry(10, "Dancing"),
                    Map.entry(11, "Exercise class"),
                    Map.entry(12, "Fencing"),
                    Map.entry(13, "American football"),
                    Map.entry(14, "Australian football"),
                    Map.entry(15, "Frisbee"),
                    Map.entry(16, "Golf"),
                    Map.entry(17, "Guided breathing"),
                    Map.entry(18, "Gymnastics"),
                    Map.entry(19, "Handball"),
                    Map.entry(20, "HIIT"),
                    Map.entry(21, "Hiking"),
                    Map.entry(22, "Ice hockey"),
                    Map.entry(23, "Ice skating"),
                    Map.entry(24, "Martial arts"),
                    Map.entry(25, "Paddling"),
                    Map.entry(26, "Paragliding"),
                    Map.entry(27, "Pilates"),
                    Map.entry(28, "Racquetball"),
                    Map.entry(29, "Rock climbing"),
                    Map.entry(30, "Roller hockey"),
                    Map.entry(31, "Rowing"),
                    Map.entry(32, "Rugby"),
                    Map.entry(33, "Running"),
                    Map.entry(34, "Treadmill running"),
                    Map.entry(35, "Sailing"),
                    Map.entry(36, "Scuba diving"),
                    Map.entry(37, "Skating"),
                    Map.entry(38, "Skiing"),
                    Map.entry(39, "Snowboarding"),
                    Map.entry(40, "Snowshoeing"),
                    Map.entry(41, "Soccer"),
                    Map.entry(42, "Softball"),
                    Map.entry(43, "Squash"),
                    Map.entry(44, "Stair climbing"),
                    Map.entry(45, "Strength training"),
                    Map.entry(46, "Stretching"),
                    Map.entry(47, "Surfing"),
                    Map.entry(48, "Open water swimming"),
                    Map.entry(49, "Pool swimming"),
                    Map.entry(50, "Table tennis"),
                    Map.entry(51, "Tennis"),
                    Map.entry(52, "Volleyball"),
                    Map.entry(53, "Walking"),
                    Map.entry(54, "Water polo"),
                    Map.entry(55, "Weightlifting"),
                    Map.entry(56, "Wheelchair"),
                    Map.entry(57, "Yoga"),
                    Map.entry(58, "Other activity"),
                    Map.entry(59, "Stair climbing machine"),
                    Map.entry(60, "Elliptical"),
                    Map.entry(61, "Rowing machine"));

    private static final String ACTIVITY = "Activity";

    private Payload() {}

    /** The later of the stored last successful day and {@code to}: it never moves back. */
    public static String lastOkTo(String stored, LocalDate to) {
        return stored != null && LocalDate.parse(stored).isAfter(to) ? stored : to.toString();
    }

    /** One heart rate sample in bpm. */
    public record Sample(Instant at, long bpm) {}

    /** A session's mean and highest heart rate (whole bpm), null when none or out of bounds. */
    public record Heart(Long avg, Long max) {}

    /**
     * The heart rate over [{@code start}, {@code end}): the rounded mean and the highest sample.
     */
    public static Heart heart(List<Sample> samples, Instant start, Instant end) {
        long sum = 0;
        long n = 0;
        long max = 0;
        for (Sample s : samples) {
            if (!s.at().isBefore(start) && s.at().isBefore(end)) {
                sum += s.bpm();
                n++;
                max = Math.max(max, s.bpm());
            }
        }
        return n == 0
                ? new Heart(null, null)
                : new Heart(within(Math.round((double) sum / n), 20, 250), within(max, 20, 250));
    }

    /** Each metric's name for {@link Source#daily} and {@link Source#total}. */
    public static final String ACTIVE_KCAL = "active_kcal";

    public static final String STEPS = "steps";
    public static final String RESTING_HR = "resting_hr";
    public static final String TOTAL_KCAL = "total_kcal";
    public static final String AVG_HR = "avg_hr";
    public static final String MIN_HR = "min_hr";
    public static final String MAX_HR = "max_hr";
    public static final String DISTANCE_M = "distance_m";

    /** {@code v} when within {@code min..max}, else null. */
    static Long within(Long v, long min, long max) {
        return v != null && v >= min && v <= max ? v : null;
    }

    /** {@code v} rounded half up to {@code places} decimals. */
    static double round(double v, int places) {
        return BigDecimal.valueOf(v).setScale(places, RoundingMode.HALF_UP).doubleValue();
    }

    /** Whole kilocalories a day from Health Connect's basal metabolic rate in watts. */
    public static Long kcalPerDay(Double watts) {
        return watts == null ? null : Math.round(watts * 86_400 / 4184);
    }

    /** A whole number, half up; null stays null. */
    public static Long whole(Double v) {
        return v == null ? null : Math.round(v);
    }

    /**
     * One Health Connect record as plain values: its kind, id and span ({@code end} null for an
     * instant), and as {@code data} every field Health Connect has for it (metadata, times and
     * offsets, values with their unit in the key, series samples as-is), in order. Values are text,
     * numbers, booleans, instants, lists and maps.
     */
    public record Rec(
            String kind, String id, Instant start, Instant end, Map<String, Object> data) {}

    /** A page of records read, and the token of the next one (-1 when none is left). */
    public record Page(List<Rec> records, long next) {}

    /** A Health Connect read that failed: why, and what to say. */
    public static final class ReadFailed extends Exception {
        private static final long serialVersionUID = 1L;

        /** Access refused (not retried), the read quota spent (resumed later), or anything else. */
        public enum Why {
            DENIED,
            RATE_LIMITED,
            OTHER
        }

        public final Why why;

        public ReadFailed(Why why, String message) {
            super(message);
            this.why = why;
        }

        /** What a sync answers when a window read failed this way. */
        Outcome outcome() {
            return switch (why) {
                case DENIED ->
                        new Outcome(
                                "Health Connect access not granted: open Settings", false, false);
                case RATE_LIMITED -> RATE_LIMITED;
                case OTHER -> new Outcome(getMessage(), true, false);
            };
        }
    }

    /** Health Connect, as the sync reads it. */
    public interface Source {
        boolean granted(String permission);

        /** One page of {@code kind}'s records in [{@code from}, {@code to}) from {@code token}. */
        Page read(String kind, Instant from, Instant to, long token)
                throws ReadFailed, InterruptedException;

        /** Each local day's total of {@code metric} over {@code w}; a day without one is absent. */
        Map<LocalDate, Double> daily(String metric, Window w)
                throws ReadFailed, InterruptedException;

        /** {@code metric}'s total over [{@code from}, {@code to}), or null when none. */
        Double total(String metric, Instant from, Instant to)
                throws ReadFailed, InterruptedException;
    }

    /** The server, as the sync posts to it: {@code path} "" is the window, "/records" a page. */
    public interface Poster {
        Outcome post(String path, String body);
    }

    /** What a sync answers when the system stopped it between posts: retry. */
    public static final Outcome STOPPED = new Outcome("Stopped", true, false);

    /** What a sync answers when Health Connect's read quota is spent: not a failure, resumed. */
    public static final Outcome RATE_LIMITED =
            new Outcome("Waiting for Health Connect's read limit: resumes later", true, false);

    /**
     * Every record of {@code kind} in [{@code from}, {@code to}), at most {@link #PAGES_MAX} pages;
     * a page left unread marks {@code batch} incomplete, naming {@code what}. Kept into {@code
     * keep} when given.
     */
    private static List<Rec> readAll(
            Source hc,
            String kind,
            Instant from,
            Instant to,
            Batch batch,
            String what,
            List<Rec> keep)
            throws ReadFailed, InterruptedException {
        List<Rec> out = new ArrayList<>();
        long token = -1;
        int pages = 0;
        do {
            Page page = hc.read(kind, from, to, token);
            out.addAll(page.records());
            token = page.next();
            pages++;
        } while (token != -1 && pages < PAGES_MAX);
        batch.pageLeft(token, what);
        if (keep != null) {
            keep.addAll(out);
        }
        return out;
    }

    private static double number(Map<?, ?> data, String key) {
        return ((Number) data.get(key)).doubleValue();
    }

    /** The maps listed under {@code key} (samples, stages); none when absent. */
    private static List<Map<?, ?>> list(Map<?, ?> data, String key) {
        List<Map<?, ?>> out = new ArrayList<>();
        if (data.get(key) instanceof List<?> items) {
            for (Object item : items) {
                out.add((Map<?, ?>) item);
            }
        }
        return out;
    }

    private static Map<?, ?> metadata(Rec r) {
        return r.data().get("metadata") instanceof Map<?, ?> m ? m : Map.of();
    }

    /** The heart rate samples of HeartRate records. */
    static List<Sample> samples(List<Rec> records) {
        List<Sample> out = new ArrayList<>();
        for (Rec r : records) {
            for (Map<?, ?> s : list(r.data(), "samples")) {
                out.add(new Sample((Instant) s.get("time"), ((Number) s.get("bpm")).longValue()));
            }
        }
        return out;
    }

    private static final String SLEEP = "SleepSession";
    private static final String HRV = "HeartRateVariabilityRmssd";

    /**
     * Sleep session {@code r} with its mean heart rate ({@code avg_bpm}, whole bpm within 20..250;
     * none when unknown): measured here, as only the phone can, for the night the server makes.
     */
    static Rec sleepHeart(Rec r, Long bpm) {
        Long avg = within(bpm, 20, 250);
        if (avg == null) {
            return r;
        }
        Map<String, Object> data = new LinkedHashMap<>(r.data());
        data.put("avg_bpm", avg);
        return new Rec(r.kind(), r.id(), r.start(), r.end(), data);
    }

    /** What the window takes from a body record: a weighing, or a reading for one. */
    private static void body(Rec r, Batch batch) {
        Map<?, ?> d = r.data();
        switch (r.kind()) {
            case "Weight" ->
                    batch.weight(
                            r.id(),
                            r.start(),
                            number(d, "kg"),
                            (String) metadata(r).get("data_origin"));
            case "BodyFat" -> batch.measure("body_fat", r.start(), number(d, "percent"));
            case "LeanBodyMass" -> batch.measure("lbm_kg", r.start(), number(d, "kg"));
            case "BoneMass" -> batch.measure("bone_kg", r.start(), number(d, "kg"));
            case "BasalMetabolicRate" ->
                    batch.measure("bmr_kcal", r.start(), number(d, "kcal_per_day"));
            default -> {}
        }
    }

    /**
     * The window's days, weighings and exercise sessions; the records of the kinds read for it go
     * into {@code keep} (they're sent raw, not read again), each sleep session with its mean heart
     * rate ({@code avg_bpm}: the server makes nights of them). Active energy, steps, resting heart
     * rate and the day's heart rate are one grouped aggregate each; sleep and HRV are read over the
     * window and the day before; each sleep session's heart rate, and each exercise session's
     * energy and distance, is one more aggregate; an exercise session's heart rate comes from the
     * samples read over its span. Any of these failing fails the read: a partial window would
     * delete data on the server.
     */
    public static Batch read(Window w, ZoneId zone, String device, Source hc, List<Rec> keep)
            throws ReadFailed, InterruptedException {
        Batch batch = new Batch(w, zone, device);
        Map<LocalDate, Double> energy = hc.daily(ACTIVE_KCAL, w);
        Map<LocalDate, Double> steps = hc.daily(STEPS, w);
        Map<LocalDate, Double> rhr = hc.daily(RESTING_HR, w);
        // Total energy and heart rate are optional grants: without them, no day has one.
        boolean totalGranted = hc.granted(Kinds.permission("TotalCaloriesBurned"));
        Map<LocalDate, Double> total = totalGranted ? hc.daily(TOTAL_KCAL, w) : Map.of();
        boolean hr = hc.granted(Kinds.permission("HeartRate"));
        Map<LocalDate, Double> avgHr = hr ? hc.daily(AVG_HR, w) : Map.of();
        Map<LocalDate, Double> minHr = hr ? hc.daily(MIN_HR, w) : Map.of();
        Map<LocalDate, Double> maxHr = hr ? hc.daily(MAX_HR, w) : Map.of();
        for (LocalDate d = w.from; !d.isAfter(w.to); d = d.plusDays(1)) {
            batch.day(d, whole(energy.get(d)), whole(steps.get(d)));
            batch.total(d, whole(total.get(d)));
            batch.rhr(d, whole(rhr.get(d)));
            batch.heart(d, whole(avgHr.get(d)), whole(minHr.get(d)), whole(maxHr.get(d)));
        }
        Instant start = w.start(zone);
        Instant before = w.from.minusDays(1).atStartOfDay(zone).toInstant();
        Instant end = w.end(zone);
        batch.read(SLEEP, null);
        for (Rec r : readAll(hc, SLEEP, before, end, batch, "sleep", null)) {
            batch.read(SLEEP, r.id());
            keep.add(hr ? sleepHeart(r, whole(hc.total(AVG_HR, r.start(), r.end()))) : r);
        }
        batch.read(HRV, null);
        for (Rec r : readAll(hc, HRV, before, end, batch, "HRV readings", keep)) {
            batch.read(HRV, r.id());
        }
        for (String kind : Kinds.BODY) {
            if (hc.granted(Kinds.permission(kind))) {
                if (Kinds.DERIVED_FROM.contains(kind)) {
                    batch.read(kind, null);
                }
                for (Rec r : readAll(hc, kind, start, end, batch, "body readings", keep)) {
                    body(r, batch);
                    if (Kinds.DERIVED_FROM.contains(kind)) {
                        batch.read(kind, r.id());
                    }
                }
            }
        }
        for (Rec s : readAll(hc, "ExerciseSession", start, end, batch, "exercise sessions", keep)) {
            Heart heart =
                    hr
                            ? heart(
                                    samples(
                                            readAll(
                                                    hc,
                                                    "HeartRate",
                                                    s.start(),
                                                    s.end(),
                                                    batch,
                                                    "heart rate",
                                                    null)),
                                    s.start(),
                                    s.end())
                            : null;
            Object method = metadata(s).get("recording_method");
            // A device that writes total energy only (no active) still gives the session its
            // energy: the span's total, which the server nets of resting like one typed.
            Long active = whole(hc.total(ACTIVE_KCAL, s.start(), s.end()));
            Long gross =
                    active == null && totalGranted
                            ? whole(hc.total(TOTAL_KCAL, s.start(), s.end()))
                            : null;
            batch.session(
                    s.id(),
                    s.start(),
                    s.end(),
                    ((Number) s.data().get("exercise_type")).intValue(),
                    (String) s.data().get("title"),
                    active,
                    gross,
                    whole(hc.total(DISTANCE_M, s.start(), s.end())),
                    method == null ? 0 : ((Number) method).intValue(),
                    heart);
        }
        return batch;
    }

    /**
     * Read one window, then POST its raw records a page at a time as they are read (the window's
     * own kinds first, then each other kind over the whole window), then the window: the server
     * makes the window's nights and resting energy from those records, so they come first. It
     * succeeds only when the window did; it stops between pages and reads when {@code stopped}. A
     * failed window read posts nothing; a failed read of a kind only archived is counted and the
     * rest still go; a spent read quota stops it to resume later.
     */
    public static Outcome sync(
            Window w, ZoneId zone, String device, Source hc, Poster post, BooleanSupplier stopped)
            throws InterruptedException {
        List<Rec> kept = new ArrayList<>();
        Batch batch;
        try {
            batch = read(w, zone, device, hc, kept);
        } catch (ReadFailed e) {
            return e.outcome();
        }
        String body = batch.json();
        if (body == null) {
            return new Outcome(batch.why(), true, false);
        }
        Pager pager = new Pager(device, PAGE_BYTES, post, stopped);
        for (Rec r : kept) {
            if (!pager.add(record(r))) {
                return pager.halted();
            }
        }
        Kinds.Granted kinds = Kinds.of(hc::granted);
        int failed = 0;
        Instant start = w.start(zone);
        Instant end = w.end(zone);
        for (String kind : kinds.read()) {
            if (Kinds.WINDOW_KINDS.contains(kind)) {
                continue;
            }
            try {
                long token = -1;
                do {
                    if (stopped.getAsBoolean()) {
                        return STOPPED;
                    }
                    Page page = hc.read(kind, start, end, token);
                    for (Rec r : page.records()) {
                        if (!pager.add(record(r))) {
                            return pager.halted();
                        }
                    }
                    token = page.next();
                } while (token != -1);
            } catch (ReadFailed e) {
                if (e.why == ReadFailed.Why.RATE_LIMITED) {
                    return RATE_LIMITED;
                }
                failed++;
            }
        }
        if (!pager.finish(kinds.skipped(), failed)) {
            return pager.halted();
        }
        if (stopped.getAsBoolean()) {
            return STOPPED;
        }
        Outcome window = post.post("", body);
        if (!window.succeeded()) {
            return window;
        }
        return new Outcome(
                window.message()
                        + ", "
                        + plural(pager.records(), "record")
                        + (failed == 0 ? "" : " (" + plural(failed, "read") + " failed)"),
                false,
                true);
    }

    /**
     * Where a run keeps its progress ({@code Store} is the app's): the last successful day, a
     * resync's next day, and the status the app shows.
     */
    public interface Store {
        String lastOkTo();

        String resyncNext();

        void resyncNext(String day);

        void succeeded(LocalDate to, String counts, long at);

        void failed(String error);

        void note(String note);
    }

    /**
     * One run of the sync ({@code resync} days a chunk at a time, else the normal window), each
     * window posted by {@code sync}: whether to retry it with backoff. A resync posts its chunks
     * oldest first and stops at the first that fails; its progress is kept, so a retry resumes at
     * that chunk (each chunk replaces only its own days on the server, and records are upserts, so
     * a repeat is harmless). The last successful day never moves back.
     */
    public static boolean run(
            LocalDate today,
            int resync,
            Store store,
            Function<Window, Outcome> sync,
            LongSupplier clock) {
        List<Window> windows = Window.forRun(today, resync, store.lastOkTo(), store.resyncNext());
        for (int i = 0; i < windows.size(); i++) {
            Window w = windows.get(i);
            Outcome out = sync.apply(w);
            if (out.equals(STOPPED)) {
                return true;
            }
            if (out.equals(RATE_LIMITED)) {
                store.note(out.message());
                return true;
            }
            if (!out.succeeded()) {
                store.failed(
                        i == 0
                                ? out.message()
                                : "Resynced "
                                        + windows.get(0).from
                                        + " to "
                                        + windows.get(i - 1).to
                                        + ", stopped at "
                                        + w.from
                                        + ": "
                                        + out.message());
                return out.retry();
            }
            if (resync > 0) {
                store.resyncNext(w.to.plusDays(1).toString());
            }
            store.succeeded(
                    w.to,
                    windows.size() == 1
                            ? out.message()
                            : out.message() + " (" + w.from + " to " + w.to + ")",
                    clock.getAsLong());
        }
        if (resync > 0) {
            store.resyncNext(null);
        }
        return false;
    }

    /**
     * The records route's bodies, built and posted as records come: each page at most {@code
     * maxBytes} of UTF-8 ({@link #record} keeps every record under it), the counts of kinds not
     * granted ({@code skipped}) and reads that failed ({@code failed}) on the last. Nothing at all,
     * no page.
     */
    public static final class Pager {
        /** Room kept for the last page's counts. */
        private static final int TAIL = 64;

        private final String device;
        private final int maxBytes;
        private final Poster post;
        private final BooleanSupplier stopped;
        private StringBuilder page;
        private int size;
        private long records;
        private Outcome halted;

        public Pager(String device, int maxBytes, Poster post, BooleanSupplier stopped) {
            this.device = device;
            this.maxBytes = maxBytes;
            this.post = post;
            this.stopped = stopped;
        }

        /** Add a record, posting the page it doesn't fit; false when a post failed or stopped. */
        public boolean add(String record) {
            int bytes = utf8(record);
            if (page != null && size + 1 + bytes + TAIL > maxBytes && !flush("]}")) {
                return false;
            }
            if (page == null) {
                page = new StringBuilder("{\"device\":" + quoted(device) + ",\"records\":[");
                size = utf8(page.toString()) + bytes;
            } else {
                page.append(',');
                size += 1 + bytes;
            }
            page.append(record);
            records++;
            return true;
        }

        /** Post the last page with the counts; false when it failed or stopped. */
        public boolean finish(int skipped, int failed) {
            if (page == null && skipped == 0 && failed == 0) {
                return true;
            }
            if (page == null) {
                page = new StringBuilder("{\"device\":" + quoted(device) + ",\"records\":[");
            }
            return flush("],\"skipped\":" + skipped + ",\"failed\":" + failed + "}");
        }

        private boolean flush(String tail) {
            if (stopped.getAsBoolean()) {
                halted = STOPPED;
                return false;
            }
            Outcome sent = post.post("/records", page.append(tail).toString());
            page = null;
            if (!sent.succeeded()) {
                halted = sent;
                return false;
            }
            return true;
        }

        /** Why a post stopped the pages. */
        public Outcome halted() {
            return halted;
        }

        /** Records added. */
        public long records() {
            return records;
        }
    }

    /**
     * A raw record as the records route takes it: its kind, id, span and data. Data over {@link
     * #RECORD_BYTES_MAX} goes as the server's flag: {@code truncated}, its size in {@code bytes},
     * and its top-level values that aren't lists, maps or long text.
     */
    public static String record(Rec r) {
        String data = new Json().value(r.data()).toString();
        int bytes = utf8(data);
        if (bytes > RECORD_BYTES_MAX) {
            Map<String, Object> flag = new LinkedHashMap<>();
            flag.put("truncated", true);
            flag.put("bytes", bytes);
            r.data()
                    .forEach(
                            (k, v) -> {
                                boolean scalar = !(v instanceof Map || v instanceof List);
                                boolean small =
                                        !(v instanceof CharSequence s)
                                                || utf8(s.toString()) <= FLAG_TEXT_MAX;
                                if (scalar && small) {
                                    flag.putIfAbsent(k, v);
                                }
                            });
            data = new Json().value(flag).toString();
        }
        return new Json()
                        .begin()
                        .put("kind", r.kind())
                        .put("id", r.id())
                        .put("start", r.start())
                        .put("end", r.end())
                        .key("data")
                        .toString()
                + data
                + "}";
    }

    private static int utf8(String s) {
        return s.getBytes(StandardCharsets.UTF_8).length;
    }

    /**
     * A JSON writer in order: values, keys, objects and arrays, commas put in for it. Numbers are
     * written without exponent (NaN and infinities as null); text, instants and offsets as strings;
     * maps and lists as objects and arrays.
     */
    public static final class Json {
        private final StringBuilder out = new StringBuilder();

        private Json next() {
            if (out.length() > 0) {
                char last = out.charAt(out.length() - 1);
                if (last != '{' && last != '[' && last != ':') {
                    out.append(',');
                }
            }
            return this;
        }

        public Json key(String k) {
            next().out.append(quoted(k)).append(':');
            return this;
        }

        public Json value(Object v) {
            if (v instanceof Map<?, ?> m) {
                begin();
                m.forEach((k, x) -> put(k.toString(), x));
                return end();
            }
            if (v instanceof List<?> l) {
                beginArray();
                l.forEach(this::value);
                return endArray();
            }
            next();
            if (v == null) {
                out.append("null");
            } else if (v instanceof Double || v instanceof Float) {
                double d = ((Number) v).doubleValue();
                out.append(
                        Double.isFinite(d)
                                ? BigDecimal.valueOf(d).stripTrailingZeros().toPlainString()
                                : "null");
            } else if (v instanceof Number || v instanceof Boolean) {
                out.append(v);
            } else {
                out.append(quoted(v.toString()));
            }
            return this;
        }

        public Json put(String k, Object v) {
            return key(k).value(v);
        }

        public Json begin() {
            next().out.append('{');
            return this;
        }

        public Json begin(String k) {
            return key(k).begin();
        }

        public Json end() {
            out.append('}');
            return this;
        }

        public Json beginArray() {
            next().out.append('[');
            return this;
        }

        public Json array(String k) {
            return key(k).beginArray();
        }

        public Json endArray() {
            out.append(']');
            return this;
        }

        @Override
        public String toString() {
            return out.toString();
        }
    }

    /** The local day {@code at} falls on in {@code zone}. */
    public static LocalDate dayOf(Instant at, ZoneId zone) {
        return at.atZone(zone).toLocalDate();
    }

    /** An exercise session's name from its Health Connect exercise type. */
    public static String typeName(int type) {
        return TYPES.getOrDefault(type, ACTIVITY);
    }

    /** The last successful day to keep after binding {@code next}: another profile starts over. */
    public static String lastOkAfterBind(long bound, long next, String lastOkTo) {
        return bound == next ? lastOkTo : null;
    }

    /** A profile id the page named: digits only, 1..2^53; else null. */
    public static Long profileId(String text) {
        if (text == null
                || text.isEmpty()
                || text.length() > 16
                || !text.chars().allMatch(c -> c >= '0' && c <= '9')) {
            return null;
        }
        long id = Long.parseLong(text);
        return id >= 1 && id <= ID_MAX ? id : null;
    }

    /**
     * {@code https://host[:port]} of an https URL (lower case, default port dropped); else null.
     */
    public static String origin(String url) {
        if (url == null) {
            return null;
        }
        URI u;
        try {
            u = new URI(url.strip());
        } catch (java.net.URISyntaxException e) {
            return null;
        }
        if (!"https".equalsIgnoreCase(u.getScheme())
                || u.getHost() == null
                || u.getRawUserInfo() != null) {
            return null;
        }
        String host = u.getHost().toLowerCase(Locale.ROOT);
        int port = u.getPort();
        return "https://" + host + (port == -1 || port == 443 ? "" : ":" + port);
    }

    /**
     * What a sync POST's answer means: the status line to show, whether to retry with backoff, and
     * whether the window was stored.
     */
    public record Outcome(String message, boolean retry, boolean succeeded) {}

    /** No answer at all (an I/O error): the network, so retry. */
    public static final Outcome UNREACHABLE = new Outcome("Server unreachable", true, false);

    /**
     * The outcome of HTTP {@code code} with {@code json}, the body when it is JSON (else null):
     * stored and counted; a server error, retried; a login page or refusal of the network's
     * sign-in, "sign in"; any other refusal shows the server's sentence and isn't retried.
     */
    public static Outcome outcome(int code, String json) {
        Map<String, String> body = json == null ? null : flatObject(json);
        if (code == 200 && body != null) {
            return new Outcome(
                    plural(count(body, "days"), "day")
                            + ", "
                            + plural(count(body, "sessions"), "activity", "activities")
                            + ", "
                            + plural(count(body, "nights"), "night"),
                    false,
                    true);
        }
        if (code >= 500) {
            return new Outcome("Server error (HTTP " + code + ")", true, false);
        }
        if (body == null || code == 401 || code == 403 || code == 407) {
            return new Outcome("Sign in again: open the app", false, false);
        }
        String error = body.getOrDefault("error", "HTTP " + code);
        return new Outcome(
                code == 404 ? error + ". Profile gone: choose a profile in Settings" : error,
                false,
                false);
    }

    /**
     * The script that answers the page's pull to refresh ({@code web/refresh.mjs}) once a sync run
     * ended: a {@code kaloriina-sync} event whose detail is {@code {"note"}} (Health Connect's read
     * limit: this run's), else {@code {"error"}} (the last failure), else {@code {"synced"}};
     * {@code {}} when no profile is bound, so nothing synced. The text is a JSON string, so a
     * server's sentence can't end it.
     */
    public static String syncEvent(boolean bound, String error, String note) {
        String detail;
        if (!bound) {
            detail = "{}";
        } else if (!note.isEmpty()) {
            detail = "{\"note\":" + quoted(note) + "}";
        } else if (!error.isEmpty()) {
            detail = "{\"error\":" + quoted(error) + "}";
        } else {
            detail = "{\"synced\":true}";
        }
        return "dispatchEvent(new CustomEvent(\"kaloriina-sync\",{detail:" + detail + "}))";
    }

    /** "1 day", "2 days": the word's plural is its singular plus "s". */
    public static String plural(long n, String word) {
        return plural(n, word, word + "s");
    }

    /** "1 activity", "2 activities". */
    public static String plural(long n, String one, String many) {
        return n + " " + (n == 1 ? one : many);
    }

    private static long count(Map<String, String> body, String key) {
        try {
            return Long.parseLong(body.getOrDefault(key, "0"));
        } catch (NumberFormatException e) {
            return 0;
        }
    }

    private static final Pattern MEMBER =
            Pattern.compile(
                    "\"((?:[^\"\\\\]|\\\\.)*)\"\\s*:\\s*(?:\"((?:[^\"\\\\]|\\\\.)*)\"|([^,}\\s]+))");

    /**
     * A flat JSON object's members as text (strings unescaped, other values as written), or null
     * when {@code json} isn't an object. Nested values aren't read: the server's answers here are
     * flat.
     */
    static Map<String, String> flatObject(String json) {
        String s = json.strip();
        if (!s.startsWith("{") || !s.endsWith("}")) {
            return null;
        }
        Map<String, String> out = new HashMap<>();
        Matcher m = MEMBER.matcher(s);
        while (m.find()) {
            out.putIfAbsent(
                    unquoted(m.group(1)), m.group(2) != null ? unquoted(m.group(2)) : m.group(3));
        }
        return out;
    }

    /** A JSON string's content with its escapes resolved. */
    private static String unquoted(String s) {
        StringBuilder out = new StringBuilder();
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c != '\\' || i + 1 == s.length()) {
                out.append(c);
                continue;
            }
            char e = s.charAt(++i);
            switch (e) {
                case 'n' -> out.append('\n');
                case 'r' -> out.append('\r');
                case 't' -> out.append('\t');
                case 'b' -> out.append('\b');
                case 'f' -> out.append('\f');
                case 'u' -> {
                    String hex = s.substring(i + 1, Math.min(i + 5, s.length()));
                    if (hex.length() == 4
                            && hex.chars().allMatch(h -> Character.digit(h, 16) >= 0)) {
                        out.append((char) Integer.parseInt(hex, 16));
                        i += 4;
                    } else {
                        out.append(e);
                    }
                }
                default -> out.append(e);
            }
        }
        return out.toString();
    }

    /** A JSON string: quotes, backslashes and control characters escaped. */
    static String quoted(String s) {
        StringBuilder out = new StringBuilder("\"");
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"' -> out.append("\\\"");
                case '\\' -> out.append("\\\\");
                case '\n' -> out.append("\\n");
                case '\r' -> out.append("\\r");
                case '\t' -> out.append("\\t");
                default -> {
                    if (c < 0x20 || c == 0x2028 || c == 0x2029) {
                        out.append(String.format(Locale.ROOT, "\\u%04x", (int) c));
                    } else {
                        out.append(c);
                    }
                }
            }
        }
        return out.append('"').toString();
    }
}
