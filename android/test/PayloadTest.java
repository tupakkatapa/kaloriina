import io.github.tupakkatapa.kaloriina.Kinds;
import io.github.tupakkatapa.kaloriina.Payload;
import io.github.tupakkatapa.kaloriina.Payload.Outcome;
import io.github.tupakkatapa.kaloriina.Payload.ReadFailed;
import io.github.tupakkatapa.kaloriina.Payload.Rec;
import io.github.tupakkatapa.kaloriina.Window;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

/**
 * The phone's logic without a phone ({@code WindowTest} and {@code BatchTest} with it): {@code java
 * PayloadTest} exits non-zero on the first failed check.
 */
public final class PayloadTest {
    static final ZoneId HELSINKI = ZoneId.of("Europe/Helsinki");
    static final LocalDate TODAY = LocalDate.of(2026, 10, 8);
    private static int checks;

    private PayloadTest() {}

    static void check(boolean ok, String what) {
        checks++;
        if (!ok) {
            throw new AssertionError(what);
        }
    }

    static void same(Object got, Object want, String what) {
        check(Objects.equals(got, want), what + ": got " + got + ", want " + want);
    }

    /** {@code java PayloadTest <tests/fixtures/health>}: the fixtures the server's suite shares. */
    public static void main(String[] args) throws IOException, InterruptedException {
        if (args.length != 1) {
            throw new IllegalArgumentException("usage: PayloadTest <tests/fixtures/health>");
        }
        Path fixtures = Path.of(args[0]);
        WindowTest.all();
        BatchTest.all(Files.readString(fixtures.resolve("payload.json")));
        typesMatchTheJar(fixture(fixtures, "exercise-types.json"));
        recordLimits(fixture(fixtures, "record-limits.json"));
        outcome();
        plural();
        binding();
        syncEvent();
        checks();
        builder();
        pages();
        oversizedRecordIsFlaggedOnThePhone();
        golden();
        failedBodyReadWithholdsTheWindow();
        failedHeartReadWithholdsTheWindow();
        sessionTotalWithoutActiveEnergy();
        rawPagesComeBeforeTheWindow();
        sleepSessionsCarryTheirHeartRate();
        theWindowListsWhatItRead();
        sendStopsBetweenPages();
        rateLimitIsResumeLater();
        archiveFailureIsCountedApart();
        oneReadPerKind();
        runSendsEachWindowAndKeepsItsProgress();
        runStopsAtTheFailedChunkAndResumesThere();
        runWaitsOnTheReadLimitAndWhenStopped();
        System.out.println("PayloadTest: " + checks + " checks passed");
    }

    private static void outcome() {
        String counts = "{\"days\":1,\"sessions\":1,\"nights\":1,\"skipped\":0}";
        same(
                Payload.outcome(200, counts),
                new Outcome("1 day, 1 activity, 1 night", false, true),
                "200: done, counted");
        same(
                Payload.outcome(200, "{\"days\":3,\"sessions\":0,\"nights\":2,\"skipped\":1}"),
                new Outcome("3 days, 0 activities, 2 nights", false, true),
                "200: plurals");
        Outcome signIn = new Outcome("Sign in again: open the app", false, false);
        same(Payload.outcome(200, null), signIn, "200 that isn't JSON: a login page");
        same(Payload.outcome(401, null), signIn, "401");
        same(Payload.outcome(403, "{\"error\":\"Forbidden\"}"), signIn, "403");
        same(
                Payload.outcome(
                        400,
                        "{\"error\":\"Steps must be at most 100000"
                                + " (\\\"days\\\")\",\"code\":\"invalid\","
                                + "\"field\":\"days[0].steps\"}"),
                new Outcome("Steps must be at most 100000 (\"days\")", false, false),
                "400: the server's sentence, no retry");
        same(
                Payload.outcome(
                        404,
                        "{\"error\":\"Profile not"
                                + " found\",\"code\":\"not_found\",\"resource\":\"profile\"}"),
                new Outcome(
                        "Profile not found. Profile gone: choose a profile in Settings",
                        false,
                        false),
                "404: choose another profile");
        same(
                Payload.outcome(
                        413, "{\"error\":\"Request body too large\",\"code\":\"too_large\"}"),
                new Outcome("Request body too large", false, false),
                "413: no retry");
        same(
                Payload.outcome(409, "{\"code\":\"stale\"}"),
                new Outcome("HTTP 409", false, false),
                "an error without a sentence");
        same(
                Payload.outcome(500, "{\"error\":\"Internal error\",\"code\":\"internal\"}"),
                new Outcome("Server error (HTTP 500)", true, false),
                "500: the server answered, retry");
        same(
                Payload.outcome(502, null),
                new Outcome("Server error (HTTP 502)", true, false),
                "502 from a proxy");
        same(
                Payload.UNREACHABLE,
                new Outcome("Server unreachable", true, false),
                "no answer: retry");
    }

    private static void plural() {
        same(Payload.plural(1, "day"), "1 day", "one");
        same(Payload.plural(0, "night"), "0 nights", "none");
        same(Payload.plural(12, "workout"), "12 workouts", "many");
    }

    private static void binding() {
        same(
                Payload.lastOkAfterBind(1, 1, "2026-10-07"),
                "2026-10-07",
                "the same profile keeps it");
        same(Payload.lastOkAfterBind(1, 2, "2026-10-07"), null, "another profile starts over");
        same(Payload.lastOkAfterBind(0, 2, "2026-10-07"), null, "a first binding starts over");
    }

    private static void syncEvent() {
        String on = "dispatchEvent(new CustomEvent(\"kaloriina-sync\",{detail:";
        same(Payload.syncEvent(true, "", ""), on + "{\"synced\":true}}))", "synced");
        same(Payload.syncEvent(false, "", ""), on + "{}}))", "no profile: nothing synced");
        same(
                Payload.syncEvent(true, "Server error (HTTP 502)", ""),
                on + "{\"error\":\"Server error (HTTP 502)\"}}))",
                "the run's error");
        same(
                Payload.syncEvent(true, "old", "Waiting for Health Connect's read limit"),
                on + "{\"note\":\"Waiting for Health Connect's read limit\"}}))",
                "a note is this run's, an error may be older");
        // The server's sentence goes into script: no quote, backslash or line
        // separator may end the string.
        same(
                Payload.syncEvent(true, "a\"b\\c\u2028d\ne'f", ""),
                on + "{\"error\":\"a\\\"b\\\\c\\u2028d\\ne'f\"}}))",
                "escaped");
    }

    private static void checks() {
        same(Payload.profileId("7"), 7L, "a profile id");
        same(Payload.profileId("9007199254740992"), 9_007_199_254_740_992L, "2^53");
        for (String bad :
                new String[] {null, "", "0", "-1", "1.5", "07x", "9007199254740993", " 7"}) {
            same(Payload.profileId(bad), null, "not a profile id: " + bad);
        }
        same(
                Payload.origin("https://kaloriina.example/#/day?x=1"),
                "https://kaloriina.example",
                "origin only");
        same(
                Payload.origin("HTTPS://Kaloriina.Example:443/"),
                "https://kaloriina.example",
                "default port");
        same(Payload.origin("https://10.0.0.2:8443"), "https://10.0.0.2:8443", "a port");
        for (String bad :
                new String[] {
                    null,
                    "http://kaloriina.example",
                    "kaloriina.example",
                    "https://",
                    "https://user@host",
                    "javascript:alert(1)",
                    "kaloriina-app://settings"
                }) {
            same(Payload.origin(bad), null, "not an origin: " + bad);
        }
    }

    private static void builder() {
        same(
                new Payload.Json()
                        .begin()
                        .put("s", "a\"b\\\n\u0001")
                        .put("n", null)
                        .put("small", 1.0E-7)
                        .put("big", 1.0E21)
                        .put("i", 3L)
                        .put("d", 72.50)
                        .put("neg", -0.5)
                        .put("nan", Double.NaN)
                        .put("t", true)
                        .put("at", Instant.parse("2026-10-08T05:00:00Z"))
                        .array("a")
                        .value(1)
                        .begin()
                        .put("x", false)
                        .end()
                        .beginArray()
                        .endArray()
                        .value("y")
                        .endArray()
                        .begin("o")
                        .end()
                        .end()
                        .toString(),
                "{\"s\":\"a\\\"b\\\\\\n\\u0001\",\"n\":null,\"small\":0.0000001,"
                        + "\"big\":1000000000000000000000,\"i\":3,\"d\":72.5,\"neg\":-0.5,"
                        + "\"nan\":null,\"t\":true,\"at\":\"2026-10-08T05:00:00Z\","
                        + "\"a\":[1,{\"x\":false},[],\"y\"],\"o\":{}}",
                "the builder: escapes, null, numbers without exponent, nesting");
        same(new Payload.Json().beginArray().endArray().toString(), "[]", "an empty array");
    }

    /** A server that answers every post with {@code answer} (by index) and keeps what came. */
    private static final class Spy implements Payload.Poster {
        final List<String> paths = new ArrayList<>();
        final List<String> bodies = new ArrayList<>();
        java.util.function.IntFunction<Outcome> answer = i -> new Outcome("1 day", false, true);

        @Override
        public Outcome post(String path, String body) {
            paths.add(path);
            bodies.add(body);
            return answer.apply(paths.size() - 1);
        }

        long pages() {
            return paths.stream().filter("/records"::equals).count();
        }
    }

    private static int bytes(String s) {
        return s.getBytes(StandardCharsets.UTF_8).length;
    }

    private static void pages() {
        Spy none = new Spy();
        Payload.Pager empty = new Payload.Pager("x", 100, none, () -> false);
        check(empty.finish(0, 0) && none.paths.isEmpty(), "nothing to send: no page");
        Spy counts = new Spy();
        Payload.Pager only = new Payload.Pager("x", 100, counts, () -> false);
        check(only.finish(2, 1), "the counts alone");
        same(
                counts.bodies,
                List.of("{\"device\":\"x\",\"records\":[],\"skipped\":2,\"failed\":1}"),
                "only counts: one empty page carries them");
        List<String> records = new ArrayList<>();
        for (int i = 0; i < 50; i++) {
            records.add("{\"id\":\"" + "é".repeat(i % 7) + i + "\"}");
        }
        int cap = 200;
        Spy spy = new Spy();
        Payload.Pager pager = new Payload.Pager("Pixel \"9\"", cap, spy, () -> false);
        for (String r : records) {
            check(pager.add(r), "added");
        }
        check(pager.finish(3, 0), "finished");
        check(spy.bodies.size() > 1, "paged");
        same(pager.records(), 50L, "records counted");
        StringBuilder all = new StringBuilder();
        String head = "{\"device\":\"Pixel \\\"9\\\"\",\"records\":[";
        for (int i = 0; i < spy.bodies.size(); i++) {
            String p = spy.bodies.get(i);
            boolean last = i == spy.bodies.size() - 1;
            String tail = last ? "],\"skipped\":3,\"failed\":0}" : "]}";
            check(p.startsWith(head) && p.endsWith(tail), "page " + i + " shape: " + p);
            check(bytes(p) <= cap, "page " + i + " within the cap: " + bytes(p));
            same(spy.paths.get(i), "/records", "a records page");
            String body = p.substring(head.length(), p.length() - tail.length());
            all.append(all.length() == 0 || body.isEmpty() ? "" : ",").append(body);
        }
        same(all.toString(), String.join(",", records), "every record once, in order");
    }

    /** A HeartRate record of {@code n} samples, as the phone reads it. */
    private static Rec heartRecord(String id, Instant start, int n) {
        List<Object> samples = new ArrayList<>();
        for (int i = 0; i < n; i++) {
            Map<String, Object> s = new LinkedHashMap<>();
            s.put("time", start.plusSeconds(i));
            s.put("bpm", 60L + i % 90);
            samples.add(s);
        }
        Map<String, Object> data = envelope(start, start.plusSeconds(n));
        data.put("samples", samples);
        return new Rec("HeartRate", id, start, start.plusSeconds(n), data);
    }

    /** What every interval record's data starts with (SyncJob.rec). */
    private static Map<String, Object> envelope(Instant start, Instant end) {
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("start_time", start);
        data.put("start_zone_offset", "+03:00");
        data.put("end_time", end);
        data.put("end_zone_offset", "+03:00");
        Map<String, Object> meta = new LinkedHashMap<>();
        meta.put("id", "m");
        meta.put("data_origin", "com.example");
        meta.put("recording_method", 2L);
        meta.put("device", null);
        data.put("metadata", meta);
        return data;
    }

    private static void oversizedRecordIsFlaggedOnThePhone() {
        Instant t = Instant.parse("2026-10-08T00:00:00Z");
        Rec big = heartRecord("h", t, 60_000);
        String json = Payload.record(big);
        check(bytes(json) < Payload.PAGE_BYTES, "a flagged record fits a page: " + bytes(json));
        check(
                json.startsWith(
                        "{\"kind\":\"HeartRate\",\"id\":\"h\",\"start\":\"2026-10-08T00:00:00Z\","
                            + "\"end\":\"2026-10-08T16:40:00Z\",\"data\":{\"truncated\":true,\"bytes\":"),
                "flagged like the server's kept_data: " + json.substring(0, 200));
        check(
                json.endsWith(
                        ",\"start_time\":\"2026-10-08T00:00:00Z\",\"start_zone_offset\":\"+03:00\","
                            + "\"end_time\":\"2026-10-08T16:40:00Z\",\"end_zone_offset\":\"+03:00\"}}"),
                "its top-level scalars kept, no samples, no metadata: " + json);
        int full = bytes(new Payload.Json().value(big.data()).toString());
        check(full > 2 * 1024 * 1024, "the data is over 2 MiB: " + full);
        check(json.contains("\"bytes\":" + full + ","), "its size is the data's");
        Spy spy = new Spy();
        Payload.Pager pager = new Payload.Pager("x", Payload.PAGE_BYTES, spy, () -> false);
        Rec small = heartRecord("s", t, 10);
        for (Rec r : List.of(small, big, small)) {
            check(pager.add(Payload.record(r)), "added");
        }
        check(pager.finish(0, 0), "finished");
        for (String p : spy.bodies) {
            check(bytes(p) <= Payload.PAGE_BYTES, "every page within PAGE_BYTES: " + bytes(p));
        }
        String text = "x".repeat(Payload.FLAG_TEXT_MAX + 1);
        Rec labelled = heartRecord("l", t, 60_000);
        labelled.data().put("title", text);
        labelled.data().put("short", "y".repeat(Payload.FLAG_TEXT_MAX));
        String flagged = Payload.record(labelled);
        check(
                !flagged.contains(text) && flagged.contains("\"short\":\"y"),
                "text over the flag's cap is dropped, at it kept");
        same(Payload.record(small).contains("truncated"), false, "a small record goes as read");
    }

    private static void golden() {
        Instant t = Instant.parse("2026-10-08T05:00:00Z");
        Map<String, Object> steps = envelope(t, t.plusSeconds(60));
        steps.put("count", 72L);
        same(
                Payload.record(new Rec("Steps", "st", t, t.plusSeconds(60), steps)),
                "{\"kind\":\"Steps\",\"id\":\"st\",\"start\":\"2026-10-08T05:00:00Z\","
                        + "\"end\":\"2026-10-08T05:01:00Z\",\"data\":{\"start_time\":"
                        + "\"2026-10-08T05:00:00Z\",\"start_zone_offset\":\"+03:00\","
                        + "\"end_time\":\"2026-10-08T05:01:00Z\",\"end_zone_offset\":\"+03:00\","
                        + "\"metadata\":{\"id\":\"m\",\"data_origin\":\"com.example\","
                        + "\"recording_method\":2,\"device\":null},\"count\":72}}",
                "Steps: an interval with its count");
        Map<String, Object> weight = new LinkedHashMap<>();
        weight.put("time", t);
        weight.put("zone_offset", "+03:00");
        weight.put("kg", 72.45);
        same(
                Payload.record(new Rec("Weight", "w", t, null, weight)),
                "{\"kind\":\"Weight\",\"id\":\"w\",\"start\":\"2026-10-08T05:00:00Z\",\"end\":null,"
                        + "\"data\":{\"time\":\"2026-10-08T05:00:00Z\",\"zone_offset\":\"+03:00\","
                        + "\"kg\":72.45}}",
                "Weight: an instant, no end");
        same(
                Payload.record(heartRecord("h", t, 2)),
                "{\"kind\":\"HeartRate\",\"id\":\"h\",\"start\":\"2026-10-08T05:00:00Z\","
                        + "\"end\":\"2026-10-08T05:00:02Z\",\"data\":{\"start_time\":"
                        + "\"2026-10-08T05:00:00Z\",\"start_zone_offset\":\"+03:00\","
                        + "\"end_time\":\"2026-10-08T05:00:02Z\",\"end_zone_offset\":\"+03:00\","
                        + "\"metadata\":{\"id\":\"m\",\"data_origin\":\"com.example\","
                        + "\"recording_method\":2,\"device\":null},\"samples\":["
                        + "{\"time\":\"2026-10-08T05:00:00Z\",\"bpm\":60},"
                        + "{\"time\":\"2026-10-08T05:00:01Z\",\"bpm\":61}]}}",
                "HeartRate: its samples as-is");
        Map<String, Object> exercise = new LinkedHashMap<>();
        exercise.put("exercise_type", 33L);
        exercise.put("title", null);
        exercise.put("laps", List.of(Map.of("length_meters", 400.0)));
        exercise.put("segments", List.of());
        same(
                new Payload.Json().value(exercise).toString(),
                "{\"exercise_type\":33,\"title\":null,\"laps\":[{\"length_meters\":400}],"
                        + "\"segments\":[]}",
                "ExerciseSession: nulls, nested lists and maps");
    }

    private static final class FakeHc implements Payload.Source {
        final Map<String, List<Rec>> records = new HashMap<>();
        final Map<String, ReadFailed.Why> failing = new HashMap<>();
        final Set<String> granted = new HashSet<>();
        final Map<String, Integer> reads = new HashMap<>();

        /** Each metric's total over any span; absent: none. */
        final Map<String, Double> totals = new HashMap<>();

        int pageSize = 1000;

        /** The required permissions are held (SyncJob checks them first). */
        FakeHc() {
            grant("EXERCISE", "STEPS");
        }

        FakeHc grant(String... kinds) {
            for (String k : kinds) {
                granted.add("android.permission.health.READ_" + k);
            }
            return this;
        }

        FakeHc add(Rec r) {
            records.computeIfAbsent(r.kind(), k -> new ArrayList<>()).add(r);
            return this;
        }

        @Override
        public boolean granted(String permission) {
            return granted.contains(permission);
        }

        @Override
        public Payload.Page read(String kind, Instant from, Instant to, long token)
                throws ReadFailed {
            reads.merge(kind, 1, Integer::sum);
            if (failing.containsKey(kind)) {
                throw new ReadFailed(failing.get(kind), "Health Connect: " + kind);
            }
            List<Rec> in = new ArrayList<>();
            for (Rec r : records.getOrDefault(kind, List.of())) {
                Instant end = r.end() == null ? r.start() : r.end();
                if (r.start().isBefore(to) && !end.isBefore(from)) {
                    in.add(r);
                }
            }
            int at = token == -1 ? 0 : (int) token;
            int next = Math.min(in.size(), at + pageSize);
            return new Payload.Page(in.subList(at, next), next < in.size() ? next : -1);
        }

        @Override
        public Map<LocalDate, Double> daily(String metric, Window w) {
            return Map.of(TODAY, 100.0);
        }

        @Override
        public Double total(String metric, Instant from, Instant to) {
            return totals.get(metric);
        }
    }

    private static final Window DAY = new Window(TODAY, TODAY);

    private static Rec weighing(String id, Instant at, double kg) {
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("time", at);
        data.put("metadata", Map.of("data_origin", "com.example"));
        data.put("kg", kg);
        return new Rec("Weight", id, at, null, data);
    }

    private static Rec exercise(String id, Instant start, Instant end) {
        Map<String, Object> data = envelope(start, end);
        data.put("exercise_type", 33L);
        data.put("title", null);
        return new Rec("ExerciseSession", id, start, end, data);
    }

    private static Rec steps(String id, Instant at) {
        Map<String, Object> data = envelope(at, at.plusSeconds(60));
        data.put("count", 10L);
        return new Rec("Steps", id, at, at.plusSeconds(60), data);
    }

    private static Outcome sync(FakeHc hc, Spy spy, java.util.function.BooleanSupplier stopped)
            throws InterruptedException {
        return Payload.sync(DAY, HELSINKI, "x", hc, spy, stopped);
    }

    private static void failedBodyReadWithholdsTheWindow() throws InterruptedException {
        FakeHc hc =
                new FakeHc()
                        .grant("WEIGHT")
                        .add(weighing("w", Instant.parse("2026-10-08T05:00:00Z"), 72));
        Spy ok = new Spy();
        check(sync(hc, ok, () -> false).succeeded(), "a weighing read: sent");
        check(
                ok.bodies.get(ok.bodies.size() - 1).contains("\"key\":\"w\""),
                "the weighing in the window");
        hc.failing.put("Weight", ReadFailed.Why.OTHER);
        Spy spy = new Spy();
        Outcome out = sync(hc, spy, () -> false);
        same(
                out,
                new Outcome("Health Connect: Weight", true, false),
                "a failed body read fails the window, retried");
        same(spy.paths, List.of(), "and nothing is posted: the server keeps its weigh-ins");
        hc.failing.clear();
        hc.pageSize = 1;
        for (int i = 0; i < Payload.PAGES_MAX; i++) {
            hc.add(weighing("w" + i, Instant.parse("2026-10-08T06:00:00Z").plusSeconds(i), 72));
        }
        Spy paged = new Spy();
        check(
                !sync(hc, paged, () -> false).succeeded() && paged.paths.isEmpty(),
                "a body page left unread withholds the window");
    }

    private static void failedHeartReadWithholdsTheWindow() throws InterruptedException {
        Instant s = Instant.parse("2026-10-08T14:00:00Z");
        FakeHc hc =
                new FakeHc()
                        .grant("HEART_RATE")
                        .add(exercise("e", s, s.plusSeconds(1800)))
                        .add(heartRecord("h", s, 3));
        Spy ok = new Spy();
        check(sync(hc, ok, () -> false).succeeded(), "heart rate read: sent");
        check(
                ok.bodies.get(ok.bodies.size() - 1).contains("\"avg_hr\":61,\"max_hr\":62}"),
                "the workout's heart rate from its span: " + ok.bodies);
        hc.failing.put("HeartRate", ReadFailed.Why.OTHER);
        Spy spy = new Spy();
        check(!sync(hc, spy, () -> false).succeeded(), "a failed heart rate read fails");
        same(spy.paths, List.of(), "nothing posted: the workout keeps its heart rate");
        Spy none = new Spy();
        FakeHc ungranted = new FakeHc().add(exercise("e", s, s.plusSeconds(1800)));
        check(
                sync(ungranted, none, () -> false).succeeded()
                        && ungranted.reads.get("HeartRate") == null,
                "heart rate not granted: not read, the workout goes without");
    }

    /**
     * A device that writes total energy only (no active): a session sends its span's total as
     * {@code kcal_total}; with active energy, or without the grant, total isn't read.
     */
    private static void sessionTotalWithoutActiveEnergy() throws InterruptedException {
        Instant s = Instant.parse("2026-10-08T14:00:00Z");
        FakeHc hc =
                new FakeHc()
                        .grant("TOTAL_CALORIES_BURNED")
                        .add(exercise("e", s, s.plusSeconds(2820)));
        hc.totals.put(Payload.TOTAL_KCAL, 402.6);
        Spy spy = new Spy();
        check(sync(hc, spy, () -> false).succeeded(), "sent");
        check(
                window(spy).contains("\"kcal\":null,\"kcal_total\":403,"),
                "the span's total, no active: " + window(spy));
        hc.totals.put(Payload.ACTIVE_KCAL, 250.0);
        Spy active = new Spy();
        sync(hc, active, () -> false);
        check(
                window(active).contains("\"kcal\":250,\"kcal_total\":null,"),
                "active energy wins: " + window(active));
        FakeHc ungranted = new FakeHc().add(exercise("e", s, s.plusSeconds(2820)));
        ungranted.totals.put(Payload.TOTAL_KCAL, 402.6);
        Spy none = new Spy();
        sync(ungranted, none, () -> false);
        check(
                window(none).contains("\"kcal\":null,\"kcal_total\":null,"),
                "total energy not granted: none " + window(none));
    }

    /** The window's body: the last post (raw pages go first). */
    private static String window(Spy spy) {
        int at = spy.paths.lastIndexOf("");
        check(at == spy.paths.size() - 1, "the window is posted last: " + spy.paths);
        return spy.bodies.get(at);
    }

    /**
     * The raw pages go before the window, so the server makes the window's nights from them; a
     * refused page sends no window, and a refused window is the answer.
     */
    private static void rawPagesComeBeforeTheWindow() throws InterruptedException {
        Instant t = Instant.parse("2026-10-07T21:00:00Z");
        FakeHc hc =
                new FakeHc()
                        .grant("SLEEP")
                        .add(sleepRec("s-1", t, t.plusSeconds(8 * 3600)))
                        .add(steps("s", Instant.parse("2026-10-08T05:00:00Z")));
        Spy spy = new Spy();
        check(sync(hc, spy, () -> false).succeeded(), "sent");
        same(spy.paths, List.of("/records", ""), "the records page, then the window");
        check(
                spy.bodies.get(0).contains("\"kind\":\"SleepSession\",\"id\":\"s-1\""),
                "the night's session in the page: " + spy.bodies.get(0));
        Spy refused = new Spy();
        refused.answer = i -> new Outcome("Profile not found", false, false);
        same(
                sync(hc, refused, () -> false),
                new Outcome("Profile not found", false, false),
                "a refused page is the answer");
        same(refused.paths, List.of("/records"), "no window after a refused page");
        Spy noWindow = new Spy();
        noWindow.answer =
                i ->
                        i == 1
                                ? new Outcome("Profile not found", false, false)
                                : new Outcome("ok", false, true);
        same(
                sync(hc, noWindow, () -> false),
                new Outcome("Profile not found", false, false),
                "the window's refusal is the answer");
    }

    /** A sleep session record (SyncJob.rec's shape), no stages. */
    private static Rec sleepRec(String id, Instant start, Instant end) {
        Map<String, Object> data = envelope(start, end);
        data.put("stages", List.of());
        return new Rec("SleepSession", id, start, end, data);
    }

    /**
     * The night's heart rate is an aggregate only the phone can take: each sleep session goes with
     * its mean ({@code avg_bpm}, whole, in bounds), when heart rate is granted.
     */
    private static void sleepSessionsCarryTheirHeartRate() throws InterruptedException {
        Instant t = Instant.parse("2026-10-07T21:00:00Z");
        FakeHc hc =
                new FakeHc()
                        .grant("SLEEP", "HEART_RATE")
                        .add(sleepRec("s-1", t, t.plusSeconds(8 * 3600)));
        hc.totals.put(Payload.AVG_HR, 54.6);
        Spy spy = new Spy();
        check(sync(hc, spy, () -> false).succeeded(), "sent");
        check(
                spy.bodies.get(0).contains("\"stages\":[],\"avg_bpm\":55}"),
                "the session's mean heart rate: " + spy.bodies.get(0));
        hc.totals.put(Payload.AVG_HR, 300.0);
        Spy wild = new Spy();
        sync(hc, wild, () -> false);
        check(!wild.bodies.get(0).contains("avg_bpm"), "out of bounds: none " + wild.bodies.get(0));
        FakeHc ungranted = new FakeHc().grant("SLEEP").add(sleepRec("s-1", t, t.plusSeconds(60)));
        ungranted.totals.put(Payload.AVG_HR, 54.6);
        Spy none = new Spy();
        sync(ungranted, none, () -> false);
        check(!none.bodies.get(0).contains("avg_bpm"), "heart rate not granted: none");
    }

    /**
     * The window lists the ids it read of the kinds the server makes days from (a kind read empty,
     * listed empty; one not granted, not listed), and its days hold no night.
     */
    private static void theWindowListsWhatItRead() throws InterruptedException {
        Instant t = Instant.parse("2026-10-07T21:00:00Z");
        FakeHc hc = new FakeHc().grant("SLEEP").add(sleepRec("s-1", t, t.plusSeconds(8 * 3600)));
        Spy spy = new Spy();
        check(sync(hc, spy, () -> false).succeeded(), "sent");
        String body = window(spy);
        check(
                body.endsWith(
                        ",\"read\":{\"SleepSession\":[\"s-1\"],"
                                + "\"HeartRateVariabilityRmssd\":[]}}"),
                "the ids read: " + body);
        check(!body.contains("in_bed_min") && !body.contains("naps"), "no night: " + body);
        FakeHc bmr = new FakeHc().grant("SLEEP", "BASAL_METABOLIC_RATE");
        Spy granted = new Spy();
        sync(bmr, granted, () -> false);
        check(
                window(granted).contains(",\"BasalMetabolicRate\":[]}"),
                "a granted kind read empty is listed empty: " + window(granted));
    }

    /** A store that keeps what a run tells it (the app's keeps it in its settings). */
    private static final class FakeStore implements Payload.Store {
        String lastOkTo;
        String resyncNext;
        String failed;
        String note;
        final List<String> succeeded = new ArrayList<>();

        @Override
        public String lastOkTo() {
            return lastOkTo;
        }

        @Override
        public String resyncNext() {
            return resyncNext;
        }

        @Override
        public void resyncNext(String day) {
            resyncNext = day;
        }

        @Override
        public void succeeded(LocalDate to, String counts, long at) {
            lastOkTo = Payload.lastOkTo(lastOkTo, to);
            succeeded.add(to + " " + counts + " " + at);
        }

        @Override
        public void failed(String error) {
            failed = error;
        }

        @Override
        public void note(String note) {
            this.note = note;
        }
    }

    /** A run posts each window in order and keeps its progress. */
    private static void runSendsEachWindowAndKeepsItsProgress() {
        FakeStore store = new FakeStore();
        List<Window> sent = new ArrayList<>();
        boolean retry =
                Payload.run(
                        TODAY,
                        0,
                        store,
                        w -> {
                            sent.add(w);
                            return new Outcome("1 day", false, true);
                        },
                        () -> 7L);
        check(!retry, "done");
        same(sent, List.of(Window.of(TODAY, null)), "the first sync's window");
        same(store.succeeded, List.of(TODAY + " 1 day 7"), "kept as done");
        same(store.lastOkTo, TODAY.toString(), "the last successful day");
        List<Window> resync = new ArrayList<>();
        Payload.run(
                TODAY,
                Payload.RESYNC_DAYS,
                store,
                w -> {
                    resync.add(w);
                    return new Outcome("ok", false, true);
                },
                () -> 8L);
        same(
                resync,
                Window.chunks(TODAY, Payload.RESYNC_DAYS, Payload.CHUNK_DAYS),
                "a resync's chunks, oldest first");
        same(store.resyncNext, null, "a finished resync leaves nothing to resume");
        same(store.lastOkTo, TODAY.toString(), "a chunk never moves the last day back");
        check(
                store.succeeded.get(1).contains(" (" + resync.get(0).from + " to "),
                "a chunk's counts name its days: " + store.succeeded.get(1));
    }

    /** A chunk that fails stops the run, kept so the retry resumes at it. */
    private static void runStopsAtTheFailedChunkAndResumesThere() {
        FakeStore store = new FakeStore();
        List<Window> chunks = Window.chunks(TODAY, Payload.RESYNC_DAYS, Payload.CHUNK_DAYS);
        List<Window> sent = new ArrayList<>();
        boolean retry =
                Payload.run(
                        TODAY,
                        Payload.RESYNC_DAYS,
                        store,
                        w -> {
                            sent.add(w);
                            return sent.size() == 2
                                    ? Payload.UNREACHABLE
                                    : new Outcome("ok", false, true);
                        },
                        () -> 1L);
        check(retry, "the network: retried");
        same(sent, chunks.subList(0, 2), "stopped at the failed chunk");
        same(store.resyncNext, chunks.get(1).from.toString(), "kept: resume there");
        same(
                store.failed,
                "Resynced "
                        + chunks.get(0).from
                        + " to "
                        + chunks.get(0).to
                        + ", stopped at "
                        + chunks.get(1).from
                        + ": Server unreachable",
                "says where");
        List<Window> again = new ArrayList<>();
        Payload.run(
                TODAY,
                Payload.RESYNC_DAYS,
                store,
                w -> {
                    again.add(w);
                    return new Outcome("ok", false, true);
                },
                () -> 2L);
        same(again, chunks.subList(1, 3), "the retry resumes at the failed chunk");
        FakeStore first = new FakeStore();
        check(
                !Payload.run(
                        TODAY, 0, first, w -> new Outcome("Profile gone", false, false), () -> 1L),
                "a refusal isn't retried");
        same(first.failed, "Profile gone", "a lone window's failure says only why");
    }

    /** A spent read quota is a note, not a failure; a stop is retried; both keep the progress. */
    private static void runWaitsOnTheReadLimitAndWhenStopped() {
        FakeStore store = new FakeStore();
        check(
                Payload.run(TODAY, 0, store, w -> Payload.RATE_LIMITED, () -> 1L),
                "the read limit: resumed later");
        same(store.note, Payload.RATE_LIMITED.message(), "noted, not failed");
        same(store.failed, null, "no failure");
        FakeStore stopped = new FakeStore();
        check(
                Payload.run(TODAY, Payload.RESYNC_DAYS, stopped, w -> Payload.STOPPED, () -> 1L),
                "stopped: retried");
        same((Object) stopped.succeeded, List.of(), "nothing kept as done");
        same(stopped.resyncNext, null, "nothing advanced");
    }

    private static void sendStopsBetweenPages() throws InterruptedException {
        FakeHc hc = new FakeHc();
        Instant t = Instant.parse("2026-10-08T05:00:00Z");
        for (int i = 0; i < 3; i++) {
            hc.add(heartRecord("h" + i, t.plusSeconds(3600L * i), 8_000)).grant("HEART_RATE");
        }
        Spy all = new Spy();
        check(sync(hc, all, () -> false).succeeded(), "all of it sent");
        check(all.pages() > 1, "in more than one page: " + all.pages());
        Spy spy = new Spy();
        Outcome out = sync(hc, spy, () -> spy.pages() >= 1);
        same(out, Payload.STOPPED, "stopped after the first page");
        same(spy.pages(), 1L, "no second page");
        Spy before = new Spy();
        same(sync(hc, before, () -> true), Payload.STOPPED, "stopped before the first page");
        same(before.paths, List.of(), "nothing posted");
        Spy failing = new Spy();
        failing.answer =
                i ->
                        i == 0
                                ? new Outcome("Server error (HTTP 500)", true, false)
                                : new Outcome("ok", false, true);
        same(
                sync(hc, failing, () -> false),
                new Outcome("Server error (HTTP 500)", true, false),
                "a failed page fails the sync");
        same(failing.paths, List.of("/records"), "and nothing after it, the window neither");
    }

    private static void rateLimitIsResumeLater() throws InterruptedException {
        FakeHc hc = new FakeHc().add(steps("s", Instant.parse("2026-10-08T05:00:00Z")));
        hc.failing.put("Steps", ReadFailed.Why.RATE_LIMITED);
        Spy spy = new Spy();
        Outcome out = sync(hc, spy, () -> false);
        same(out, Payload.RATE_LIMITED, "a spent quota on a records read: resume later");
        check(out.retry() && !out.succeeded(), "retried later, not stored as done");
        FakeHc window = new FakeHc();
        window.failing.put("SleepSession", ReadFailed.Why.RATE_LIMITED);
        Spy none = new Spy();
        same(sync(window, none, () -> false), Payload.RATE_LIMITED, "on a window read too");
        same(none.paths, List.of(), "with nothing posted");
        FakeHc denied = new FakeHc();
        denied.failing.put("ExerciseSession", ReadFailed.Why.DENIED);
        same(
                sync(denied, new Spy(), () -> false),
                new Outcome("Health Connect access not granted: open Settings", false, false),
                "access refused: not retried");
    }

    private static void archiveFailureIsCountedApart() throws InterruptedException {
        FakeHc hc =
                new FakeHc()
                        .grant("HEIGHT", "VO2_MAX")
                        .add(steps("s", Instant.parse("2026-10-08T05:00:00Z")));
        hc.failing.put("Height", ReadFailed.Why.OTHER);
        hc.failing.put("Vo2Max", ReadFailed.Why.OTHER);
        Spy spy = new Spy();
        Outcome out = sync(hc, spy, () -> false);
        same(
                out,
                new Outcome("1 day, 1 record (2 reads failed)", false, true),
                "a kind only archived: the window and the rest still go, failures named");
        String last = spy.bodies.get(spy.bodies.size() - 2);
        check(
                last.endsWith("],\"skipped\":18,\"failed\":2}"),
                "not granted and failed apart on the last page: " + last);
    }

    private static void oneReadPerKind() throws InterruptedException {
        FakeHc hc = new FakeHc();
        for (Kinds.Kind k : Kinds.OPTIONAL) {
            hc.granted.add(k.permission());
        }
        Instant t = Instant.parse("2026-10-08T05:00:00Z");
        hc.add(exercise("e1", t, t.plusSeconds(600)))
                .add(exercise("e2", t.plusSeconds(3600), t.plusSeconds(4200)));
        Window month = new Window(TODAY.minusDays(29), TODAY);
        check(Payload.sync(month, HELSINKI, "x", hc, new Spy(), () -> false).succeeded(), "synced");
        Map<String, Integer> want = new HashMap<>();
        for (String k : Kinds.of(hc::granted).read()) {
            want.put(k, 1);
        }
        // A workout's heart rate is read over its span: one read each.
        want.put("HeartRate", 1 + 2);
        same(hc.reads, want, "30 days: each kind read once over the window, not once a day");
    }

    // The shared fixtures.

    private static Map<?, ?> fixture(Path dir, String name) throws IOException {
        return (Map<?, ?>) MiniJson.parse(Files.readString(dir.resolve(name)));
    }

    private static List<Map<?, ?>> maps(Object list) {
        List<Map<?, ?>> out = new ArrayList<>();
        for (Object o : (List<?>) list) {
            out.add((Map<?, ?>) o);
        }
        return out;
    }

    private static void typesMatchTheJar(Map<?, ?> fixture) {
        List<Map<?, ?>> types = maps(fixture.get("types"));
        same(types.size(), 62, "every type in the API 35 jar, 0 to 61");
        for (Map<?, ?> t : types) {
            int hc = ((Long) t.get("hc")).intValue();
            same(Payload.typeName(hc), t.get("name"), "type " + hc + " (" + t.get("jar") + ")");
        }
        same(Payload.typeName(62), "Activity", "a number the jar hasn't: an activity");
    }

    private static void recordLimits(Map<?, ?> fixture) {
        same(fixture.get("page_bytes"), (long) Payload.PAGE_BYTES, "the phone's page");
        same(
                fixture.get("health_record_bytes_max"),
                (long) Payload.RECORD_BYTES_MAX,
                "the record cap the phone flags at is the server's");
        same(fixture.get("flag_text_bytes_max"), (long) Payload.FLAG_TEXT_MAX, "a flag's text");
        check(
                Payload.PAGE_BYTES < (Long) fixture.get("health_bytes_max"),
                "a page fits the server's body cap");
        check(
                Payload.RECORD_BYTES_MAX + 4096 < Payload.PAGE_BYTES,
                "a record at the cap fits a page with its envelope");
    }

    /** A JSON reader for the fixtures: objects, arrays, strings, numbers, true, false, null. */
    private static final class MiniJson {
        private final String s;
        private int i;

        private MiniJson(String s) {
            this.s = s;
        }

        static Object parse(String text) {
            MiniJson p = new MiniJson(text);
            Object v = p.value();
            p.ws();
            p.check(p.i == p.s.length());
            return v;
        }

        private void ws() {
            while (i < s.length() && Character.isWhitespace(s.charAt(i))) {
                i++;
            }
        }

        private Object value() {
            ws();
            char c = s.charAt(i);
            if (c == '{') {
                Map<String, Object> m = new LinkedHashMap<>();
                i++;
                ws();
                if (s.charAt(i) == '}') {
                    i++;
                    return m;
                }
                do {
                    ws();
                    String k = string();
                    ws();
                    expect(':');
                    m.put(k, value());
                    ws();
                } while (s.charAt(i++) == ',');
                check(s.charAt(i - 1) == '}');
                return m;
            }
            if (c == '[') {
                List<Object> a = new ArrayList<>();
                i++;
                ws();
                if (s.charAt(i) == ']') {
                    i++;
                    return a;
                }
                do {
                    a.add(value());
                    ws();
                } while (s.charAt(i++) == ',');
                check(s.charAt(i - 1) == ']');
                return a;
            }
            if (c == '"') {
                return string();
            }
            for (String word : new String[] {"true", "false", "null"}) {
                if (s.startsWith(word, i)) {
                    i += word.length();
                    return word.equals("null") ? null : Boolean.valueOf(word);
                }
            }
            int start = i;
            while (i < s.length() && "+-0123456789.eE".indexOf(s.charAt(i)) >= 0) {
                i++;
            }
            String n = s.substring(start, i);
            return n.matches("-?\\d+") ? (Object) Long.valueOf(n) : (Object) Double.valueOf(n);
        }

        private String string() {
            expect('"');
            StringBuilder out = new StringBuilder();
            while (s.charAt(i) != '"') {
                char c = s.charAt(i++);
                if (c != '\\') {
                    out.append(c);
                    continue;
                }
                char e = s.charAt(i++);
                switch (e) {
                    case 'n' -> out.append('\n');
                    case 't' -> out.append('\t');
                    case 'r' -> out.append('\r');
                    case 'b' -> out.append('\b');
                    case 'f' -> out.append('\f');
                    case 'u' -> {
                        out.append((char) Integer.parseInt(s.substring(i, i + 4), 16));
                        i += 4;
                    }
                    default -> out.append(e);
                }
            }
            i++;
            return out.toString();
        }

        private void expect(char c) {
            check(s.charAt(i++) == c);
        }

        private void check(boolean ok) {
            if (!ok) {
                throw new IllegalArgumentException("bad JSON at " + i);
            }
        }
    }
}
