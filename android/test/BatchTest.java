import io.github.tupakkatapa.kaloriina.Batch;
import io.github.tupakkatapa.kaloriina.Kinds;
import io.github.tupakkatapa.kaloriina.Payload;
import io.github.tupakkatapa.kaloriina.Window;

import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/** One window's read as the JSON the server takes, and the kinds a sync reads. */
final class BatchTest {
    private static final ZoneId HELSINKI = PayloadTest.HELSINKI;
    private static final LocalDate TODAY = PayloadTest.TODAY;

    private BatchTest() {}

    static void all(String payload) {
        payload(payload);
        zones();
        incomplete();
        distance();
        heartRate();
        dayHeart();
        body();
        kinds();
    }

    private static void check(boolean ok, String what) {
        PayloadTest.check(ok, what);
    }

    private static void same(Object got, Object want, String what) {
        PayloadTest.same(got, want, what);
    }

    /** A day's values, each null. */
    private static final String NONE =
            "\"active_kcal\":null,\"total_kcal\":null,\"steps\":null,"
                    + "\"resting_hr\":null,\"avg_hr\":null,\"min_hr\":null,\"max_hr\":null";

    private static Batch week(ZoneId zone) {
        return new Batch(new Window(LocalDate.of(2026, 10, 2), TODAY), zone, "Pixel \"9\"");
    }

    private static void payload(String fixture) {
        Batch b = week(HELSINKI);
        b.day(LocalDate.of(2026, 10, 7), null, null);
        b.day(LocalDate.of(2026, 10, 8), Payload.whole(511.6), 9120L);
        b.day(LocalDate.of(2026, 10, 1), 1L, 1L);
        same(b.days(), 1, "empty and outside days are dropped");
        same(Payload.whole(511.499), 511L, "kcal round down");
        same(Payload.whole(511.5), 512L, "kcal round up");
        same(Payload.whole(null), null, "no energy");
        // 23:30 on the window's last day is in it; 00:10 the next day is not.
        b.session(
                "a-1",
                Instant.parse("2026-10-08T20:30:00Z"),
                Instant.parse("2026-10-08T20:50:00Z"),
                33,
                null,
                120L,
                null,
                null,
                1,
                null);
        b.session(
                "a-2",
                Instant.parse("2026-10-08T21:10:00Z"),
                Instant.parse("2026-10-08T21:40:00Z"),
                33,
                null,
                120L,
                null,
                null,
                1,
                null);
        same(b.sessions(), 1, "a session after the window's last day");
        b.session(
                "a-3",
                Instant.parse("2026-10-05T06:00:00Z"),
                Instant.parse("2026-10-05T07:00:00Z"),
                999,
                "  Tempo \"run\"\n\u0001 ",
                null,
                null,
                null,
                0,
                null);
        b.session(
                "a-4",
                Instant.parse("2026-10-05T08:00:00Z"),
                Instant.parse("2026-10-05T09:00:00Z"),
                999,
                "  ",
                null,
                310L,
                null,
                0,
                null);
        // Every field the server reads, once: heart, the records read, a distance workout.
        b.rhr(LocalDate.of(2026, 10, 8), 54L);
        b.heart(LocalDate.of(2026, 10, 8), 68L, 48L, 141L);
        b.total(LocalDate.of(2026, 10, 8), 2480L);
        b.read("SleepSession", null);
        b.read("SleepSession", "s-1");
        b.read("HeartRateVariabilityRmssd", null);
        b.weight("w-1", Instant.parse("2026-10-07T05:30:00Z"), 72.454, "com.withings.wiscale2");
        b.measure("body_fat", Instant.parse("2026-10-07T05:30:40Z"), 18.26);
        b.measure("bmr_kcal", Instant.parse("2026-10-07T05:29:00Z"), 1650.4);
        b.session(
                "a-5",
                Instant.parse("2026-10-06T15:00:00Z"),
                Instant.parse("2026-10-06T15:45:00Z"),
                53,
                "Evening walk",
                180L,
                null,
                4210L,
                2,
                new Payload.Heart(112L, 131L));
        // The fixture the server's suite POSTs (tests/api/device.rs): drift on
        // either side fails one of the two.
        same(b.json(), minified(fixture), "payload JSON equals tests/fixtures/health/payload.json");
        same(Payload.typeName(33), "Running", "a known type");
        same(Payload.typeName(999), "Activity", "an unknown type is an activity");
        same(Payload.typeName(-1), "Activity", "a negative type");
    }

    /** {@code json} without the whitespace between tokens (the fixture is formatted). */
    private static String minified(String json) {
        StringBuilder out = new StringBuilder();
        boolean inString = false;
        for (int i = 0; i < json.length(); i++) {
            char c = json.charAt(i);
            if (inString && c == '\\') {
                out.append(c).append(json.charAt(++i));
                continue;
            }
            if (c == '"') {
                inString = !inString;
            }
            if (inString || !Character.isWhitespace(c)) {
                out.append(c);
            }
        }
        return out.toString();
    }

    private static void zones() {
        // DST ends in Helsinki on 2026-10-25 at 04:00 (back to 03:00).
        LocalDate dstEnd = LocalDate.of(2026, 10, 25);
        same(
                Payload.dayOf(Instant.parse("2026-10-24T21:30:00Z"), HELSINKI),
                dstEnd,
                "00:30 (+03) on the day DST ends");
        same(
                Payload.dayOf(Instant.parse("2026-10-25T21:30:00Z"), HELSINKI),
                dstEnd,
                "23:30 (+02) the same day");
        Batch b = new Batch(new Window(dstEnd, dstEnd), HELSINKI, "Pixel 9");
        b.session(
                "dst",
                Instant.parse("2026-10-24T21:30:00Z"),
                Instant.parse("2026-10-24T22:30:00Z"),
                33,
                null,
                null,
                null,
                null,
                0,
                null);
        same(b.sessions(), 1, "a 00:30 session on the DST day is in it");
        // The same instant is another day in another zone.
        Instant late = Instant.parse("2026-10-07T22:30:00Z");
        same(Payload.dayOf(late, HELSINKI), TODAY, "in Helsinki");
        same(Payload.dayOf(late, ZoneId.of("Europe/London")), TODAY.minusDays(1), "in London");
        Batch london = new Batch(new Window(TODAY, TODAY), ZoneId.of("Europe/London"), "x");
        london.session("tz", late, late.plusSeconds(600), 33, null, null, null, null, 0, null);
        same(london.sessions(), 0, "a zone change moves a session's day");
    }

    private static void incomplete() {
        Batch b = week(HELSINKI);
        b.day(TODAY, 1L, 1L);
        check(b.json() != null, "a complete read posts");
        b.incomplete("Health Connect stopped answering");
        same(b.json(), null, "an incomplete read posts nothing");
        same(b.why(), "Health Connect stopped answering", "and says why");
        Batch paged = week(HELSINKI);
        paged.pageLeft(42L, "workouts");
        same(paged.json(), null, "a page token left is incomplete");
        Batch done = week(HELSINKI);
        done.pageLeft(-1L, "workouts");
        check(done.json() != null, "no page left is complete");
    }

    private static void distance() {
        same(Payload.whole(8234.6), 8235L, "metres rounded");
        Batch b = new Batch(new Window(TODAY, TODAY), HELSINKI, "x");
        b.session(
                "r",
                Instant.parse("2026-10-08T14:00:00Z"),
                Instant.parse("2026-10-08T14:46:00Z"),
                33,
                null,
                410L,
                null,
                8235L,
                2,
                null);
        b.session(
                "s",
                Instant.parse("2026-10-08T16:00:00Z"),
                Instant.parse("2026-10-08T16:46:00Z"),
                45,
                null,
                null,
                null,
                500L,
                1,
                null);
        b.session(
                "far",
                Instant.parse("2026-10-08T17:00:00Z"),
                Instant.parse("2026-10-08T17:46:00Z"),
                33,
                null,
                null,
                null,
                2_000_000L,
                9,
                null);
        same(
                b.json(),
                "{\"from\":\"2026-10-08\",\"to\":\"2026-10-08\",\"device\":\"x\","
                    + "\"days\":[],\"sessions\":["
                    + "{\"key\":\"r\",\"day\":\"2026-10-08\",\"start_at\":\"2026-10-08T14:00:00Z\","
                    + "\"end_at\":\"2026-10-08T14:46:00Z\",\"type\":33,\"name\":\"Running\","
                    + "\"kcal\":410,\"kcal_total\":null,\"distance_m\":8235,\"recording_method\":2,\"avg_hr\":null,\"max_hr\":null},"
                    + "{\"key\":\"s\",\"day\":\"2026-10-08\",\"start_at\":\"2026-10-08T16:00:00Z\",\"end_at\":\"2026-10-08T16:46:00Z\",\"type\":45,\"name\":\"Strength"
                    + " training\","
                    + "\"kcal\":null,\"kcal_total\":null,\"distance_m\":500,\"recording_method\":1,\"avg_hr\":null,\"max_hr\":null},"
                    + "{\"key\":\"far\",\"day\":\"2026-10-08\",\"start_at\":\"2026-10-08T17:00:00Z\","
                    + "\"end_at\":\"2026-10-08T17:46:00Z\",\"type\":33,\"name\":\"Running\","
                    + "\"kcal\":null,\"kcal_total\":null,\"distance_m\":null,\"recording_method\":0,\"avg_hr\":null,\"max_hr\":null}"
                    + "],\"body\":[],\"read\":{}}",
                "distanceIsAlwaysSent: the server keeps it by type; recording method");
    }

    private static void heartRate() {
        Instant s = Instant.parse("2026-10-08T14:00:00Z");
        Instant e = s.plusSeconds(1800);
        same(Payload.heart(List.of(), s, e), new Payload.Heart(null, null), "no samples");
        List<Payload.Sample> samples =
                List.of(
                        new Payload.Sample(s.minusSeconds(1), 200),
                        new Payload.Sample(s, 120),
                        new Payload.Sample(s.plusSeconds(60), 141),
                        new Payload.Sample(s.plusSeconds(120), 130),
                        new Payload.Sample(e, 190));
        same(
                Payload.heart(samples, s, e),
                new Payload.Heart(130L, 141L),
                "from [start, end): 130.33 rounds down, the sample at end is out");
        same(
                Payload.heart(
                        List.of(new Payload.Sample(s, 120), new Payload.Sample(s, 121)), s, e),
                new Payload.Heart(121L, 121L),
                "120.5 rounds up");
        same(
                Payload.heart(List.of(new Payload.Sample(s, 19), new Payload.Sample(s, 15)), s, e),
                new Payload.Heart(null, null),
                "out of bounds: null");
        same(
                Payload.heart(
                        List.of(new Payload.Sample(s, 240), new Payload.Sample(s, 260)), s, e),
                new Payload.Heart(250L, null),
                "a max over 250 is null, the mean kept");
    }

    private static void dayHeart() {
        Window w = new Window(LocalDate.of(2026, 10, 8), LocalDate.of(2026, 10, 9));
        LocalDate d = LocalDate.of(2026, 10, 9);
        Batch only = new Batch(w, HELSINKI, "x");
        only.heart(d, 70L, null, null);
        same(
                only.json(),
                "{\"from\":\"2026-10-08\",\"to\":\"2026-10-09\",\"device\":\"x\","
                        + "\"days\":[{\"day\":\"2026-10-09\","
                        + NONE.replace("\"avg_hr\":null", "\"avg_hr\":70")
                        + "}],\"sessions\":[],\"body\":[],\"read\":{}}",
                "a day with only heart rate is sent");
        Batch out = new Batch(w, HELSINKI, "x");
        out.heart(LocalDate.of(2026, 10, 10), 70L, 50L, 120L);
        same(out.days(), 0, "heart rate outside the window is dropped");
        // Out of bounds: the field goes, the day stays.
        Batch bad = new Batch(w, HELSINKI, "x");
        bad.day(d, 100L, null);
        bad.heart(d, 251L, 19L, 300L);
        bad.rhr(d, 300L);
        bad.total(d, 40_000L);
        same(
                bad.json(),
                "{\"from\":\"2026-10-08\",\"to\":\"2026-10-09\",\"device\":\"x\","
                        + "\"days\":[{\"day\":\"2026-10-09\","
                        + NONE.replace("\"active_kcal\":null", "\"active_kcal\":100")
                        + "}],\"sessions\":[],\"body\":[],\"read\":{}}",
                "heart rate out of 20..250, RHR 300 and 40,000 kcal are left out");
    }

    private static void body() {
        Batch b = new Batch(new Window(TODAY, TODAY), HELSINKI, "x");
        Instant t = Instant.parse("2026-10-08T05:00:00Z");
        b.weight("w-a", t, 80.005, "com.health.openscale.pro");
        b.weight("w-b", t.plusSeconds(200), 79.9, "com.example");
        b.weight("w-out", Instant.parse("2026-10-07T20:00:00Z"), 81, "com.example");
        b.measure("body_fat", t.plusSeconds(90), 20.04);
        b.measure("body_fat", t.plusSeconds(30), 21.0);
        b.measure("lbm_kg", t.plusSeconds(121), 60.0);
        b.measure("bone_kg", t.plusSeconds(180), 3.333);
        b.measure("bmr_kcal", t.minusSeconds(500), 1700.0);
        same(
                b.json(),
                "{\"from\":\"2026-10-08\",\"to\":\"2026-10-08\",\"device\":\"x\","
                        + "\"days\":[],\"sessions\":[],\"body\":["
                        + "{\"key\":\"w-a\",\"day\":\"2026-10-08\",\"at\":\"2026-10-08T05:00:00Z\","
                        + "\"kg\":80.01,\"body_fat\":21,\"lbm_kg\":null,\"bone_kg\":null,"
                        + "\"bmr_kcal\":null,\"origin\":\"com.health.openscale.pro\"},"
                        + "{\"key\":\"w-b\",\"day\":\"2026-10-08\",\"at\":\"2026-10-08T05:03:20Z\","
                        + "\"kg\":79.9,\"body_fat\":null,\"lbm_kg\":60,\"bone_kg\":3.33,"
                        + "\"bmr_kcal\":null,\"origin\":\"com.example\"}],\"read\":{}}",
                "body: nearest weight within 120 s, each part once, rounded; outside days out");
        same(Payload.kcalPerDay(80.0), 1652L, "80 W is 1652 kcal a day");
        same(Payload.kcalPerDay(null), null, "no BMR");
    }

    private static final String HC = "android.permission.health.";

    private static void kinds() {
        Set<String> core = new HashSet<>();
        for (String p :
                new String[] {
                    "READ_ACTIVE_CALORIES_BURNED",
                    "READ_STEPS",
                    "READ_EXERCISE",
                    "READ_SLEEP",
                    "READ_RESTING_HEART_RATE",
                    "READ_HEART_RATE_VARIABILITY",
                    "READ_DISTANCE"
                }) {
            core.add(HC + p);
        }
        Kinds.Granted none = Kinds.of(core::contains);
        same(
                none.read(),
                List.of(
                        "Steps",
                        "ActiveCaloriesBurned",
                        "Distance",
                        "ExerciseSession",
                        "SleepSession",
                        "RestingHeartRate",
                        "HeartRateVariabilityRmssd",
                        "CyclingPedalingCadence",
                        "StepsCadence"),
                "optional permissions skipped: the core kinds and those under core permissions");
        same(none.skipped(), 20, "every optional permission not granted is one skipped");
        Set<String> some = new HashSet<>(core);
        some.add(HC + "READ_WEIGHT");
        some.add(HC + "READ_HEART_RATE");
        Kinds.Granted two = Kinds.of(some::contains);
        check(
                two.read().contains("Weight")
                        && two.read().contains("HeartRate")
                        && !two.read().contains("BodyFat"),
                "granted optional kinds are read");
        same(two.skipped(), 18, "the rest skipped");
        same(Kinds.OPTIONAL.size(), 22, "22 optional kinds");
        same(
                Kinds.OPTIONAL.stream()
                        .map(Kinds.Kind::permission)
                        .filter(p -> !core.contains(p))
                        .distinct()
                        .count(),
                20L,
                "20 optional permissions beyond the core");
        check(
                Kinds.OPTIONAL.stream().noneMatch(k -> k.permission().endsWith("ROUTES")),
                "routes are never asked for");
    }
}
