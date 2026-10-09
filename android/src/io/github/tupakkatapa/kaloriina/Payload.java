package io.github.tupakkatapa.kaloriina;

import java.net.URI;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.ZoneId;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.SortedMap;
import java.util.SortedSet;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * What the sync sends, without Android: the window of days, the
 * POST body, and the checks on what the page and the user hand the app.
 * {@code PayloadTest} covers it on the JVM.
 */
public final class Payload {
    /** Days the first sync sends, the most a normal one goes back, and a resync's. */
    static final int FIRST_DAYS = 30;
    static final int NORMAL_DAYS = 7;
    public static final int RESYNC_DAYS = 90;

    private static final long ID_MAX = 1L << 53;

    private static final Map<Integer, String> TYPES = Map.ofEntries(
            Map.entry(2, "Badminton"),
            Map.entry(4, "Biking"),
            Map.entry(5, "Stationary biking"),
            Map.entry(10, "Dancing"),
            Map.entry(20, "HIIT"),
            Map.entry(21, "Hiking"),
            Map.entry(27, "Pilates"),
            Map.entry(31, "Rowing"),
            Map.entry(33, "Running"),
            Map.entry(34, "Treadmill running"),
            Map.entry(38, "Skiing"),
            Map.entry(45, "Strength training"),
            Map.entry(48, "Open water swimming"),
            Map.entry(49, "Pool swimming"),
            Map.entry(53, "Walking"),
            Map.entry(57, "Yoga"),
            Map.entry(60, "Elliptical"),
            Map.entry(61, "Rowing machine"));

    private Payload() {}

    /** Days {@code from}..{@code to}, both included, in the phone's zone. */
    public static final class Window {
        public final LocalDate from;
        public final LocalDate to;

        public Window(LocalDate from, LocalDate to) {
            this.from = from;
            this.to = to;
        }

        /**
         * The window ending {@code today}: a resync's {@code resyncDays}; else the first sync's
         * 30 days; else the last 7, reaching back to the last successful {@code to} after a gap,
         * at most 30.
         */
        public static Window of(LocalDate today, LocalDate lastOkTo, int resyncDays) {
            if (resyncDays > 0) {
                return new Window(today.minusDays(resyncDays - 1L), today);
            }
            LocalDate earliest = today.minusDays(FIRST_DAYS - 1L);
            if (lastOkTo == null) {
                return new Window(earliest, today);
            }
            LocalDate from = today.minusDays(NORMAL_DAYS - 1L);
            if (lastOkTo.isBefore(from)) {
                from = lastOkTo;
            }
            return new Window(from.isBefore(earliest) ? earliest : from, today);
        }

        public long days() {
            return ChronoUnit.DAYS.between(from, to) + 1;
        }

        boolean contains(LocalDate day) {
            return !day.isBefore(from) && !day.isAfter(to);
        }
    }

    /** A sleep session and its stages, as Health Connect has them. */
    public record Sleep(Instant start, Instant end, List<Stage> stages) {}

    /** A sleep stage: Health Connect's type number over a span. */
    public record Stage(Instant start, Instant end, int type) {}

    /** One HRV (RMSSD) reading in milliseconds. */
    public record Reading(Instant at, double ms) {}

    /**
     * A night: its wake day, its span, minutes in bed and asleep, deep/REM/light (null
     * when the watch wrote none of those stages) and local "HH:MM" bed and wake times.
     */
    public record Night(LocalDate day, Instant start, Instant end, long inBed, long asleep,
            Long deep, Long rem, Long light, String bedtime, String wake) {}

    private static final Set<Integer> AWAKE = Set.of(1, 3, 7);
    private static final int LIGHT = 4;
    private static final int DEEP = 5;
    private static final int REM = 6;
    /** Sessions this close make one block; a block this long in bed is a night. */
    private static final Duration JOIN = Duration.ofHours(2);
    private static final long NIGHT_MIN = 180;
    private static final Set<Integer> DISTANCE_TYPES = Set.of(4, 5, 21, 33, 34, 48, 49, 53);

    /**
     * One sync's read: its days and workouts as JSON, or nothing when any read failed or a page
     * was left unread (a partial window would delete days on the server).
     */
    public static final class Batch {
        private final Window window;
        private final ZoneId zone;
        private final String device;
        private final TreeMap<LocalDate, Day> days = new TreeMap<>();
        private final List<Sleep> sleeps = new ArrayList<>();
        private final List<Reading> readings = new ArrayList<>();
        private final List<String> sessions = new ArrayList<>();
        private String why;

        /** A day's totals and resting heart rate, each null when Health Connect had none. */
        private static final class Day {
            Long activeKcal;
            Long steps;
            Long restingHr;
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

        /** A day's resting heart rate (bpm); outside the window it's left out. */
        public void rhr(LocalDate day, Long bpm) {
            if (window.contains(day) && bpm != null) {
                at(day).restingHr = bpm;
            }
        }

        /** A sleep session, read over the window and the day before. */
        public void sleep(Sleep s) {
            sleeps.add(s);
        }

        /** An HRV reading, read over the same span as sleep. */
        public void hrv(Reading r) {
            readings.add(r);
        }

        /** A workout, on its start's day in the zone; outside the window it's left out. */
        public void session(String key, Instant start, Instant end, int type, CharSequence title,
                Long kcal, Long distanceM, int recordingMethod) {
            LocalDate day = dayOf(start, zone);
            if (!window.contains(day)) {
                return;
            }
            String name = title == null ? "" : title.toString().strip();
            Long distance = hasDistance(type) ? within(distanceM, 0, 1_000_000) : null;
            int method = recordingMethod >= 0 && recordingMethod <= 3 ? recordingMethod : 0;
            sessions.add("{\"key\":" + quoted(key) + ",\"day\":" + quoted(day.toString())
                    + ",\"start_at\":" + quoted(start.toString()) + ",\"end_at\":"
                    + quoted(end.toString()) + ",\"type\":" + type + ",\"name\":"
                    + quoted(name.isEmpty() ? typeName(type) : name) + ",\"kcal\":" + kcal
                    + ",\"distance_m\":" + distance + ",\"recording_method\":" + method + "}");
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

        /** The window's nights, each in bed at most 24 h (else not sent). */
        private SortedMap<LocalDate, Night> windowNights() {
            SortedMap<LocalDate, Night> out = Payload.nights(sleeps, zone, window);
            out.values().removeIf(n -> n.inBed() > 1440);
            return out;
        }

        /** Each day's HRV mean: a reading inside a night counts for its wake day. */
        private Map<LocalDate, Long> hrvDays() {
            List<Night> all = allNights(sleeps, zone);
            Map<LocalDate, double[]> sums = new TreeMap<>();
            for (Reading r : readings) {
                LocalDate day = all.stream()
                        .filter(n -> !r.at().isBefore(n.start()) && !r.at().isAfter(n.end()))
                        .map(Night::day)
                        .findFirst()
                        .orElse(dayOf(r.at(), zone));
                if (window.contains(day)) {
                    double[] s = sums.computeIfAbsent(day, d -> new double[2]);
                    s[0] += r.ms();
                    s[1]++;
                }
            }
            Map<LocalDate, Long> out = new TreeMap<>();
            sums.forEach((d, s) -> out.put(d, within(Math.round(s[0] / s[1]), 1, 500)));
            return out;
        }

        /** The day items: values out of bounds left out, days with nothing left dropped. */
        private List<String> dayItems() {
            SortedMap<LocalDate, Night> nights = windowNights();
            Map<LocalDate, Long> hrv = hrvDays();
            SortedSet<LocalDate> all = new TreeSet<>(days.keySet());
            all.addAll(nights.keySet());
            all.addAll(hrv.keySet());
            List<String> out = new ArrayList<>();
            for (LocalDate d : all) {
                Day v = days.getOrDefault(d, new Day());
                Long rhr = within(v.restingHr, 20, 250);
                Long ms = hrv.get(d);
                Night n = nights.get(d);
                if (v.activeKcal == null && v.steps == null && rhr == null && ms == null
                        && n == null) {
                    continue;
                }
                out.add("{\"day\":" + quoted(d.toString()) + ",\"active_kcal\":" + v.activeKcal
                        + ",\"steps\":" + v.steps + ",\"resting_hr\":" + rhr + ",\"hrv_ms\":" + ms
                        + ",\"asleep_min\":" + (n == null ? null : n.asleep())
                        + ",\"in_bed_min\":" + (n == null ? null : n.inBed())
                        + ",\"bedtime\":" + (n == null ? null : quoted(n.bedtime()))
                        + ",\"wake_time\":" + (n == null ? null : quoted(n.wake()))
                        + ",\"deep_min\":" + (n == null ? null : n.deep())
                        + ",\"rem_min\":" + (n == null ? null : n.rem())
                        + ",\"light_min\":" + (n == null ? null : n.light()) + "}");
            }
            return out;
        }

        public int days() {
            return dayItems().size();
        }

        public int nights() {
            return windowNights().size();
        }

        public int sessions() {
            return sessions.size();
        }

        /** The POST body, or null when the read was incomplete. */
        public String json() {
            if (why != null) {
                return null;
            }
            return "{\"from\":" + quoted(window.from.toString()) + ",\"to\":"
                    + quoted(window.to.toString()) + ",\"device\":" + quoted(device) + ",\"days\":["
                    + String.join(",", dayItems()) + "],\"sessions\":["
                    + String.join(",", sessions) + "]}";
        }
    }

    /** {@code v} when within {@code min..max}, else null. */
    static Long within(Long v, long min, long max) {
        return v != null && v >= min && v <= max ? v : null;
    }

    /** Whole minutes covered by the union of {@code spans} ({start, end}): overlaps count once. */
    public static long unionMinutes(List<Instant[]> spans) {
        List<Instant[]> sorted = new ArrayList<>(spans);
        sorted.removeIf(s -> !s[1].isAfter(s[0]));
        sorted.sort(Comparator.comparing((Instant[] s) -> s[0]));
        long seconds = 0;
        Instant from = null;
        Instant to = null;
        for (Instant[] s : sorted) {
            if (to == null || s[0].isAfter(to)) {
                if (to != null) {
                    seconds += Duration.between(from, to).getSeconds();
                }
                from = s[0];
                to = s[1];
            } else if (s[1].isAfter(to)) {
                to = s[1];
            }
        }
        if (to != null) {
            seconds += Duration.between(from, to).getSeconds();
        }
        return Math.round(seconds / 60.0);
    }

    /** Sleep sessions in blocks: sorted, those ≤ 2 h apart joined. */
    static List<List<Sleep>> blocks(List<Sleep> sleeps) {
        List<Sleep> sorted = new ArrayList<>(sleeps);
        sorted.sort(Comparator.comparing(Sleep::start));
        List<List<Sleep>> out = new ArrayList<>();
        Instant end = null;
        for (Sleep s : sorted) {
            if (end == null || s.start().isAfter(end.plus(JOIN))) {
                out.add(new ArrayList<>());
                end = s.end();
            } else if (s.end().isAfter(end)) {
                end = s.end();
            }
            out.get(out.size() - 1).add(s);
        }
        return out;
    }

    private static Night night(List<Sleep> block, ZoneId zone) {
        Instant start = block.get(0).start();
        Instant end = block.stream().map(Sleep::end).max(Comparator.naturalOrder()).orElse(start);
        List<Instant[]> bed = new ArrayList<>();
        List<Instant[]> awake = new ArrayList<>();
        Map<Integer, List<Instant[]>> kinds = new HashMap<>();
        for (Sleep s : block) {
            bed.add(new Instant[] {s.start(), s.end()});
            for (Stage st : s.stages()) {
                Instant[] span = {
                    st.start().isBefore(start) ? start : st.start(),
                    st.end().isAfter(end) ? end : st.end()
                };
                if (AWAKE.contains(st.type())) {
                    awake.add(span);
                } else if (st.type() == LIGHT || st.type() == DEEP || st.type() == REM) {
                    kinds.computeIfAbsent(st.type(), t -> new ArrayList<>()).add(span);
                }
            }
        }
        long inBed = unionMinutes(bed);
        boolean staged = !kinds.isEmpty();
        java.util.function.IntFunction<Long> kind =
                t -> staged ? unionMinutes(kinds.getOrDefault(t, List.of())) : null;
        return new Night(dayOf(end, zone), start, end, inBed,
                Math.max(0, inBed - unionMinutes(awake)), kind.apply(DEEP), kind.apply(REM),
                kind.apply(LIGHT), clock(start, zone), clock(end, zone));
    }

    /** Every block ≥ 3 h in bed, whatever its day. */
    static List<Night> allNights(List<Sleep> sleeps, ZoneId zone) {
        List<Night> out = new ArrayList<>();
        for (List<Sleep> block : blocks(sleeps)) {
            Night n = night(block, zone);
            if (n.inBed() >= NIGHT_MIN) {
                out.add(n);
            }
        }
        return out;
    }

    /** The window's nights by wake day; the longest wins a day. */
    public static SortedMap<LocalDate, Night> nights(List<Sleep> sleeps, ZoneId zone, Window w) {
        SortedMap<LocalDate, Night> out = new TreeMap<>();
        for (Night n : allNights(sleeps, zone)) {
            if (w.contains(n.day())) {
                out.merge(n.day(), n, (a, b) -> a.inBed() >= b.inBed() ? a : b);
            }
        }
        return out;
    }

    /** Local "HH:MM" of {@code at}. */
    private static String clock(Instant at, ZoneId zone) {
        LocalTime t = at.atZone(zone).toLocalTime();
        return String.format(Locale.ROOT, "%02d:%02d", t.getHour(), t.getMinute());
    }

    /** Whether a workout of this Health Connect type has a distance worth reading. */
    public static boolean hasDistance(int type) {
        return DISTANCE_TYPES.contains(type);
    }

    /** Whole metres from Health Connect's length. */
    public static Long metres(Double m) {
        return m == null ? null : Math.round(m);
    }

    /** The local day {@code at} falls on in {@code zone}. */
    public static LocalDate dayOf(Instant at, ZoneId zone) {
        return at.atZone(zone).toLocalDate();
    }

    /** Whole kilocalories from Health Connect's calories. */
    public static Long kcal(Double calories) {
        return calories == null ? null : Math.round(calories / 1000.0);
    }

    /** A workout's name from its Health Connect exercise type. */
    public static String typeName(int type) {
        return TYPES.getOrDefault(type, "Workout");
    }

    /** The last successful day to keep after binding {@code next}: another profile starts over. */
    public static String lastOkAfterBind(long bound, long next, String lastOkTo) {
        return bound == next ? lastOkTo : null;
    }

    /** A profile id the page named: digits only, 1..2^53; else null. */
    public static Long profileId(String text) {
        if (text == null || text.isEmpty() || text.length() > 16
                || !text.chars().allMatch(c -> c >= '0' && c <= '9')) {
            return null;
        }
        long id = Long.parseLong(text);
        return id >= 1 && id <= ID_MAX ? id : null;
    }

    /** {@code https://host[:port]} of an https URL (lower case, default port dropped); else null. */
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
        if (!"https".equalsIgnoreCase(u.getScheme()) || u.getHost() == null
                || u.getRawUserInfo() != null) {
            return null;
        }
        String host = u.getHost().toLowerCase(Locale.ROOT);
        int port = u.getPort();
        return "https://" + host + (port == -1 || port == 443 ? "" : ":" + port);
    }

    /**
     * What a sync POST's answer means: the status line to show, whether to retry with backoff,
     * and whether the window was stored.
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
            return new Outcome(plural(count(body, "days"), "day") + ", "
                    + plural(count(body, "sessions"), "workout") + ", "
                    + plural(count(body, "nights"), "night"), false, true);
        }
        if (code >= 500) {
            return new Outcome("Server error (HTTP " + code + ")", true, false);
        }
        if (body == null || code == 401 || code == 403 || code == 407) {
            return new Outcome("Sign in again: open the app", false, false);
        }
        String error = body.getOrDefault("error", "HTTP " + code);
        return new Outcome(code == 404 ? error + ". Profile gone: choose a profile in Settings"
                : error, false, false);
    }

    /** "1 day", "2 days": the word's plural is its singular plus "s". */
    public static String plural(long n, String word) {
        return n + " " + word + (n == 1 ? "" : "s");
    }

    private static long count(Map<String, String> body, String key) {
        try {
            return Long.parseLong(body.getOrDefault(key, "0"));
        } catch (NumberFormatException e) {
            return 0;
        }
    }

    private static final Pattern MEMBER = Pattern.compile(
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
            out.putIfAbsent(unquoted(m.group(1)),
                    m.group(2) != null ? unquoted(m.group(2)) : m.group(3));
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
