import io.github.tupakkatapa.kaloriina.Payload;
import io.github.tupakkatapa.kaloriina.Payload.Batch;
import io.github.tupakkatapa.kaloriina.Payload.Outcome;
import io.github.tupakkatapa.kaloriina.Payload.Window;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.util.List;
import java.util.Objects;

/**
 * The phone's logic without a phone:
 * {@code java PayloadTest} exits non-zero on the first failed check.
 */
public final class PayloadTest {
    private static final ZoneId HELSINKI = ZoneId.of("Europe/Helsinki");
    private static final LocalDate TODAY = LocalDate.of(2026, 10, 8);
    private static int checks;

    private PayloadTest() {}

    private static void check(boolean ok, String what) {
        checks++;
        if (!ok) {
            throw new AssertionError(what);
        }
    }

    private static void same(Object got, Object want, String what) {
        check(Objects.equals(got, want), what + ": got " + got + ", want " + want);
    }

    /** {@code java PayloadTest <tests/fixtures/health/payload.json>}. */
    public static void main(String[] args) throws IOException {
        if (args.length != 1) {
            throw new IllegalArgumentException("usage: PayloadTest <payload.json fixture>");
        }
        window();
        payload(Files.readString(Path.of(args[0])));
        outcome();
        plural();
        zones();
        incomplete();
        binding();
        checks();
        interval();
        sleep();
        heart();
        distance();
        System.out.println("PayloadTest: " + checks + " checks passed");
    }

    private static void window() {
        same(Window.of(TODAY, null, 0).days(), 30L, "first sync");
        same(Window.of(TODAY, null, 0).from, LocalDate.of(2026, 9, 9), "first sync starts");
        same(Window.of(TODAY, TODAY, 0).days(), 7L, "normal");
        same(Window.of(TODAY, TODAY.minusDays(1), 0).days(), 7L, "a day behind");
        same(Window.of(TODAY, TODAY.minusDays(12), 0).days(), 13L, "a 12-day gap");
        same(Window.of(TODAY, TODAY.minusDays(12), 0).from, TODAY.minusDays(12), "gap heals from there");
        same(Window.of(TODAY, TODAY.minusDays(40), 0).days(), 30L, "a long gap is capped");
        same(Window.of(TODAY, TODAY, 90).days(), 90L, "resync");
        same(Window.of(TODAY, TODAY, 90).to, TODAY, "every window ends today");
    }

    private static final String NO_HEART = ",\"resting_hr\":null,\"hrv_ms\":null";
    private static final String NO_SLEEP = ",\"asleep_min\":null,\"in_bed_min\":null,"
            + "\"bedtime\":null,\"wake_time\":null,\"deep_min\":null,\"rem_min\":null,"
            + "\"light_min\":null";

    private static Batch week(ZoneId zone) {
        return new Batch(new Window(LocalDate.of(2026, 10, 2), TODAY), zone, "Pixel \"9\"");
    }

    private static void payload(String fixture) {
        Batch b = week(HELSINKI);
        b.day(LocalDate.of(2026, 10, 7), null, null);
        b.day(LocalDate.of(2026, 10, 8), Payload.kcal(511_600.0), 9120L);
        b.day(LocalDate.of(2026, 10, 1), 1L, 1L);
        same(b.days(), 1, "empty and outside days are dropped");
        same(Payload.kcal(511_499.0), 511L, "kcal round down");
        same(Payload.kcal(511_500.0), 512L, "kcal round up");
        same(Payload.kcal(null), null, "no energy");
        // 23:30 on the window's last day is in it; 00:10 the next day is not.
        b.session("a-1", Instant.parse("2026-10-08T20:30:00Z"),
                Instant.parse("2026-10-08T20:50:00Z"), 33, null, 120L, null, 1);
        b.session("a-2", Instant.parse("2026-10-08T21:10:00Z"),
                Instant.parse("2026-10-08T21:40:00Z"), 33, null, 120L, null, 1);
        same(b.sessions(), 1, "a session after the window's last day");
        b.session("a-3", Instant.parse("2026-10-05T06:00:00Z"),
                Instant.parse("2026-10-05T07:00:00Z"), 999, "  Tempo \"run\"\n\u0001 ", null, null, 0);
        b.session("a-4", Instant.parse("2026-10-05T08:00:00Z"),
                Instant.parse("2026-10-05T09:00:00Z"), 999, "  ", null, null, 0);
        // Every field the server reads, once: heart, a staged night, a distance workout.
        b.rhr(LocalDate.of(2026, 10, 8), 54L);
        b.sleep(sleepOf("2026-10-07T23:10", "2026-10-08T07:05",
                stage("2026-10-07T23:10", "2026-10-08T01:00", 5),
                stage("2026-10-08T01:00", "2026-10-08T02:30", 6),
                stage("2026-10-08T02:30", "2026-10-08T02:45", 1),
                stage("2026-10-08T02:45", "2026-10-08T07:05", 4)));
        b.hrv(new Payload.Reading(at("2026-10-08T03:00"), 42.4));
        b.session("a-5", Instant.parse("2026-10-06T15:00:00Z"),
                Instant.parse("2026-10-06T15:45:00Z"), 53, "Evening walk", 180L, 4210L, 2);
        // The fixture the server's suite POSTs (tests/api/activity.rs): drift on
        // either side fails one of the two.
        same(b.json(), minified(fixture), "payload JSON equals tests/fixtures/health/payload.json");
        same(Payload.typeName(33), "Running", "a known type");
        same(Payload.typeName(56), "Workout", "an unknown type");
        same(Payload.typeName(-1), "Workout", "a negative type");
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

    private static void outcome() {
        String counts = "{\"days\":1,\"sessions\":1,\"nights\":1,\"skipped\":0}";
        same(Payload.outcome(200, counts), new Outcome("1 day, 1 workout, 1 night", false, true),
                "200: done, counted");
        same(Payload.outcome(200, "{\"days\":3,\"sessions\":0,\"nights\":2,\"skipped\":1}"),
                new Outcome("3 days, 0 workouts, 2 nights", false, true), "200: plurals");
        Outcome signIn = new Outcome("Sign in again: open the app", false, false);
        same(Payload.outcome(200, null), signIn, "200 that isn't JSON: a login page");
        same(Payload.outcome(401, null), signIn, "401");
        same(Payload.outcome(403, "{\"error\":\"Forbidden\"}"), signIn, "403");
        same(Payload.outcome(400,
                "{\"error\":\"Steps must be at most 100000 (\\\"days\\\")\",\"code\":\"invalid\","
                        + "\"field\":\"days[0].steps\"}"),
                new Outcome("Steps must be at most 100000 (\"days\")", false, false),
                "400: the server's sentence, no retry");
        same(Payload.outcome(404,
                "{\"error\":\"Profile not found\",\"code\":\"not_found\",\"resource\":\"profile\"}"),
                new Outcome("Profile not found. Profile gone: choose a profile in Settings", false,
                        false),
                "404: choose another profile");
        same(Payload.outcome(413, "{\"error\":\"Request body too large\",\"code\":\"too_large\"}"),
                new Outcome("Request body too large", false, false), "413: no retry");
        same(Payload.outcome(409, "{\"code\":\"stale\"}"), new Outcome("HTTP 409", false, false),
                "an error without a sentence");
        same(Payload.outcome(500, "{\"error\":\"Internal error\",\"code\":\"internal\"}"),
                new Outcome("Server error (HTTP 500)", true, false),
                "500: the server answered, retry");
        same(Payload.outcome(502, null), new Outcome("Server error (HTTP 502)", true, false),
                "502 from a proxy");
        same(Payload.UNREACHABLE, new Outcome("Server unreachable", true, false),
                "no answer: retry");
    }

    private static void plural() {
        same(Payload.plural(1, "day"), "1 day", "one");
        same(Payload.plural(0, "night"), "0 nights", "none");
        same(Payload.plural(12, "workout"), "12 workouts", "many");
    }

    private static void zones() {
        // DST ends in Helsinki on 2026-10-25 at 04:00 (back to 03:00).
        LocalDate dstEnd = LocalDate.of(2026, 10, 25);
        same(Payload.dayOf(Instant.parse("2026-10-24T21:30:00Z"), HELSINKI), dstEnd,
                "00:30 (+03) on the day DST ends");
        same(Payload.dayOf(Instant.parse("2026-10-25T21:30:00Z"), HELSINKI), dstEnd,
                "23:30 (+02) the same day");
        Batch b = new Batch(new Window(dstEnd, dstEnd), HELSINKI, "Pixel 9");
        b.session("dst", Instant.parse("2026-10-24T21:30:00Z"),
                Instant.parse("2026-10-24T22:30:00Z"), 33, null, null, null, 0);
        same(b.sessions(), 1, "a 00:30 session on the DST day is in it");
        // The same instant is another day in another zone.
        Instant late = Instant.parse("2026-10-07T22:30:00Z");
        same(Payload.dayOf(late, HELSINKI), TODAY, "in Helsinki");
        same(Payload.dayOf(late, ZoneId.of("Europe/London")), TODAY.minusDays(1), "in London");
        Batch london = new Batch(new Window(TODAY, TODAY), ZoneId.of("Europe/London"), "x");
        london.session("tz", late, late.plusSeconds(600), 33, null, null, null, 0);
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

    private static void binding() {
        same(Payload.lastOkAfterBind(1, 1, "2026-10-07"), "2026-10-07", "the same profile keeps it");
        same(Payload.lastOkAfterBind(1, 2, "2026-10-07"), null, "another profile starts over");
        same(Payload.lastOkAfterBind(0, 2, "2026-10-07"), null, "a first binding starts over");
    }

    private static void checks() {
        same(Payload.profileId("7"), 7L, "a profile id");
        same(Payload.profileId("9007199254740992"), 9_007_199_254_740_992L, "2^53");
        for (String bad : new String[] {null, "", "0", "-1", "1.5", "07x", "9007199254740993", " 7"}) {
            same(Payload.profileId(bad), null, "not a profile id: " + bad);
        }
        same(Payload.origin("https://kaloriina.example/#/day?x=1"), "https://kaloriina.example", "origin only");
        same(Payload.origin("HTTPS://Kaloriina.Example:443/"), "https://kaloriina.example", "default port");
        same(Payload.origin("https://10.0.0.2:8443"), "https://10.0.0.2:8443", "a port");
        for (String bad : new String[] {null, "http://kaloriina.example", "kaloriina.example",
                "https://", "https://user@host", "javascript:alert(1)", "kaloriina-app://settings"}) {
            same(Payload.origin(bad), null, "not an origin: " + bad);
        }
    }

    /** {@code local} ("2026-10-08T23:10") in Helsinki. */
    private static Instant at(String local) {
        return ZonedDateTime.of(LocalDateTime.parse(local), HELSINKI).toInstant();
    }

    private static Payload.Sleep sleepOf(String from, String to, Payload.Stage... stages) {
        return new Payload.Sleep(at(from), at(to), List.of(stages));
    }

    private static Payload.Stage stage(String from, String to, int type) {
        return new Payload.Stage(at(from), at(to), type);
    }

    /** The one night {@code sleeps} make in {@code w}, or null. */
    private static Payload.Night night(Window w, Payload.Sleep... sleeps) {
        var all = Payload.nights(List.of(sleeps), HELSINKI, w);
        check(all.size() <= 1, "one night at most");
        return all.isEmpty() ? null : all.values().iterator().next();
    }

    private static final Window OCT =
            new Window(LocalDate.of(2026, 10, 1), LocalDate.of(2026, 10, 31));

    private static void interval() {
        Instant a = Instant.parse("2026-10-08T00:00:00Z");
        same(Payload.unionMinutes(List.of(new Instant[] {a, a.plusSeconds(3600)},
                new Instant[] {a.plusSeconds(1800), a.plusSeconds(5400)},
                new Instant[] {a.plusSeconds(7200), a.plusSeconds(7800)})), 100L,
                "overlaps count once");
        same(Payload.unionMinutes(List.of()), 0L, "nothing");
        // Two apps writing the same night: in bed once, not twice.
        Payload.Night twice = night(OCT, sleepOf("2026-10-08T23:00", "2026-10-09T07:00"),
                sleepOf("2026-10-08T23:00", "2026-10-09T07:00"));
        same(twice.inBed(), 480L, "the same night from two apps");
        Payload.Night awake = night(OCT, sleepOf("2026-10-08T23:00", "2026-10-09T07:00",
                stage("2026-10-09T02:00", "2026-10-09T02:30", 1),
                stage("2026-10-09T02:10", "2026-10-09T02:40", 7)));
        same(awake.asleep(), 440L, "overlapping awake stages count once");
    }

    private static void sleep() {
        Payload.Night n = night(OCT, sleepOf("2026-10-08T23:10", "2026-10-09T07:05"));
        same(n.day(), LocalDate.of(2026, 10, 9), "the wake day");
        same(n.inBed(), 475L, "in bed across midnight");
        same(n.asleep(), 475L, "no stages: asleep = in bed");
        same(n.bedtime(), "23:10", "bedtime");
        same(n.wake(), "07:05", "wake time");
        same(n.deep(), null, "no stages: no deep");
        Payload.Night dstEnd = night(OCT, sleepOf("2026-10-24T23:00", "2026-10-25T07:00"));
        same(dstEnd.inBed(), 540L, "DST end night");
        same(dstEnd.day(), LocalDate.of(2026, 10, 25), "DST end wake day");
        Window march = new Window(LocalDate.of(2027, 3, 20), LocalDate.of(2027, 3, 31));
        same(night(march, sleepOf("2027-03-27T23:00", "2027-03-28T07:00")).inBed(), 420L,
                "DST start night");
        Payload.Night staged = night(OCT, sleepOf("2026-10-08T23:00", "2026-10-09T07:00",
                stage("2026-10-08T23:00", "2026-10-08T23:10", 1),
                stage("2026-10-09T03:00", "2026-10-09T03:10", 3),
                stage("2026-10-09T06:50", "2026-10-09T07:00", 7),
                stage("2026-10-08T23:10", "2026-10-09T00:20", 5),
                stage("2026-10-09T00:20", "2026-10-09T01:50", 6),
                stage("2026-10-09T01:50", "2026-10-09T03:00", 4),
                stage("2026-10-09T03:10", "2026-10-09T05:20", 4),
                stage("2026-10-09T05:20", "2026-10-09T06:50", 0)));
        same(staged.asleep(), 450L, "awake stages 1, 3, 7 are taken off; 0 is asleep");
        same(staged.deep(), 70L, "deep");
        same(staged.rem(), 90L, "REM");
        same(staged.light(), 200L, "light");
        Payload.Night generic = night(OCT, sleepOf("2026-10-08T23:00", "2026-10-09T07:00",
                stage("2026-10-08T23:00", "2026-10-09T07:00", 2)));
        same(generic.asleep(), 480L, "a sleeping stage is asleep");
        same(generic.rem(), null, "no 4/5/6 stage: no breakdown");
        Payload.Night split = night(OCT, sleepOf("2026-10-08T23:00", "2026-10-09T02:00"),
                sleepOf("2026-10-09T02:30", "2026-10-09T07:00"));
        same(split.inBed(), 450L, "a split night is one");
        same(split.bedtime(), "23:00", "its bedtime is the first part's");
        Payload.Night longer = night(OCT, sleepOf("2026-10-08T21:00", "2026-10-09T00:30"),
                sleepOf("2026-10-09T03:30", "2026-10-09T08:00"));
        same(longer.inBed(), 270L, "a 3 h gap splits; the longer block wins");
        same(night(OCT, sleepOf("2026-10-09T14:00", "2026-10-09T14:40")), null, "a lone nap");
        Payload.Night withNap = night(OCT, sleepOf("2026-10-08T23:10", "2026-10-09T07:05"),
                sleepOf("2026-10-09T14:00", "2026-10-09T14:40"));
        same(withNap.inBed(), 475L, "a nap leaves the night alone");
        same(night(OCT, sleepOf("2026-10-08T23:00", "2026-10-09T01:50")), null,
                "2 h 50 min is no night");
        Window w = new Window(LocalDate.of(2026, 10, 9), LocalDate.of(2026, 10, 15));
        same(night(w, sleepOf("2026-10-08T23:10", "2026-10-09T07:05")).day(),
                LocalDate.of(2026, 10, 9), "a night ending on from is kept");
        same(night(w, sleepOf("2026-10-07T23:10", "2026-10-08T07:05")), null,
                "a night ending the day before from is dropped");
        Batch b = new Batch(w, HELSINKI, "x");
        b.sleep(sleepOf("2026-10-08T23:40", "2026-10-09T07:05"));
        same(b.nights(), 1, "a night counted");
        Batch incomplete = new Batch(w, HELSINKI, "x");
        incomplete.pageLeft(7L, "sleep");
        same(incomplete.json(), null, "a page left on sleep");
        same(incomplete.why(), "Health Connect had more sleep than one read", "names the read");
    }

    private static void heart() {
        Window w = new Window(LocalDate.of(2026, 10, 8), LocalDate.of(2026, 10, 9));
        Batch b = new Batch(w, HELSINKI, "x");
        b.hrv(new Payload.Reading(at("2026-10-08T09:00"), 40.4));
        b.hrv(new Payload.Reading(at("2026-10-08T12:00"), 47.6));
        b.hrv(new Payload.Reading(at("2026-10-08T18:00"), 55.0));
        b.rhr(LocalDate.of(2026, 10, 8), 54L);
        // A nightly value stamped 23:30 belongs to the morning it describes.
        b.sleep(sleepOf("2026-10-08T23:00", "2026-10-09T07:00"));
        b.hrv(new Payload.Reading(at("2026-10-08T23:30"), 60.0));
        same(b.json(), "{\"from\":\"2026-10-08\",\"to\":\"2026-10-09\",\"device\":\"x\",\"days\":["
                + "{\"day\":\"2026-10-08\",\"active_kcal\":null,\"steps\":null,\"resting_hr\":54,"
                + "\"hrv_ms\":48" + NO_SLEEP + "},"
                + "{\"day\":\"2026-10-09\",\"active_kcal\":null,\"steps\":null,\"resting_hr\":null,"
                + "\"hrv_ms\":60,\"asleep_min\":480,\"in_bed_min\":480,\"bedtime\":\"23:00\","
                + "\"wake_time\":\"07:00\",\"deep_min\":null,\"rem_min\":null,\"light_min\":null}"
                + "],\"sessions\":[]}", "heart and sleep days");
        Batch onlySleep = new Batch(w, HELSINKI, "x");
        onlySleep.sleep(sleepOf("2026-10-08T23:00", "2026-10-09T07:00"));
        onlySleep.day(LocalDate.of(2026, 10, 8), null, null);
        same(onlySleep.days(), 1, "a day with only sleep is sent, one with nothing isn't");
        // Out of bounds: the field goes, the day stays.
        Batch bad = new Batch(w, HELSINKI, "x");
        bad.day(LocalDate.of(2026, 10, 8), 100L, null);
        bad.rhr(LocalDate.of(2026, 10, 8), 300L);
        bad.hrv(new Payload.Reading(at("2026-10-08T12:00"), 0.2));
        same(bad.json(), "{\"from\":\"2026-10-08\",\"to\":\"2026-10-09\",\"device\":\"x\",\"days\":["
                + "{\"day\":\"2026-10-08\",\"active_kcal\":100,\"steps\":null" + NO_HEART + NO_SLEEP
                + "}],\"sessions\":[]}", "RHR 300 and HRV 0 are left out");
        Batch badSleep = new Batch(w, HELSINKI, "x");
        badSleep.rhr(LocalDate.of(2026, 10, 9), 50L);
        // One merged block over 24 h in bed: the sleep group goes, the day stays.
        badSleep.sleep(sleepOf("2026-10-07T20:00", "2026-10-08T21:00"));
        badSleep.sleep(sleepOf("2026-10-08T22:00", "2026-10-09T07:00"));
        same(badSleep.json(), "{\"from\":\"2026-10-08\",\"to\":\"2026-10-09\",\"device\":\"x\","
                + "\"days\":[{\"day\":\"2026-10-09\",\"active_kcal\":null,\"steps\":null,"
                + "\"resting_hr\":50,\"hrv_ms\":null" + NO_SLEEP + "}],\"sessions\":[]}",
                "in bed over 1440 is left out");
        Batch paged = new Batch(w, HELSINKI, "x");
        paged.pageLeft(3L, "HRV readings");
        same(paged.json(), null, "a page left on HRV");
        same(paged.why(), "Health Connect had more HRV readings than one read", "names it");
    }

    private static void distance() {
        same(Payload.metres(8234.6), 8235L, "metres rounded");
        same(Payload.metres(null), null, "no distance");
        same(Payload.hasDistance(53), true, "walking has a distance");
        same(Payload.hasDistance(33), true, "running has a distance");
        same(Payload.hasDistance(45), false, "strength training has none");
        Batch b = new Batch(new Window(TODAY, TODAY), HELSINKI, "x");
        b.session("r", Instant.parse("2026-10-08T14:00:00Z"),
                Instant.parse("2026-10-08T14:46:00Z"), 33, null, 410L, 8235L, 2);
        b.session("s", Instant.parse("2026-10-08T16:00:00Z"),
                Instant.parse("2026-10-08T16:46:00Z"), 45, null, null, 500L, 1);
        b.session("far", Instant.parse("2026-10-08T17:00:00Z"),
                Instant.parse("2026-10-08T17:46:00Z"), 33, null, null, 2_000_000L, 9);
        same(b.json(), "{\"from\":\"2026-10-08\",\"to\":\"2026-10-08\",\"device\":\"x\","
                + "\"days\":[],\"sessions\":["
                + "{\"key\":\"r\",\"day\":\"2026-10-08\",\"start_at\":\"2026-10-08T14:00:00Z\","
                + "\"end_at\":\"2026-10-08T14:46:00Z\",\"type\":33,\"name\":\"Running\","
                + "\"kcal\":410,\"distance_m\":8235,\"recording_method\":2},"
                + "{\"key\":\"s\",\"day\":\"2026-10-08\",\"start_at\":\"2026-10-08T16:00:00Z\","
                + "\"end_at\":\"2026-10-08T16:46:00Z\",\"type\":45,\"name\":\"Strength training\","
                + "\"kcal\":null,\"distance_m\":null,\"recording_method\":1},"
                + "{\"key\":\"far\",\"day\":\"2026-10-08\",\"start_at\":\"2026-10-08T17:00:00Z\","
                + "\"end_at\":\"2026-10-08T17:46:00Z\",\"type\":33,\"name\":\"Running\","
                + "\"kcal\":null,\"distance_m\":null,\"recording_method\":0}"
                + "]}", "distance and recording method");
    }
}
