import io.github.tupakkatapa.kaloriina.Payload;
import io.github.tupakkatapa.kaloriina.Window;

import java.time.LocalDate;
import java.util.List;

/** The sync's windows: the normal one, a resync's chunks and where a retry resumes. */
final class WindowTest {
    private static final LocalDate TODAY = PayloadTest.TODAY;

    private WindowTest() {}

    static void all() {
        window();
        resyncResumesAtTheFailedChunk();
        lastOkToIsMonotonic();
        forRun();
    }

    private static void same(Object got, Object want, String what) {
        PayloadTest.same(got, want, what);
    }

    private static void window() {
        same(Window.of(TODAY, null).days(), 30L, "first sync");
        same(Window.of(TODAY, null).from, LocalDate.of(2026, 9, 9), "first sync starts");
        same(Window.of(TODAY, TODAY).days(), 7L, "normal");
        same(Window.of(TODAY, TODAY.minusDays(1)).days(), 7L, "a day behind");
        same(Window.of(TODAY, TODAY.minusDays(12)).days(), 13L, "a 12-day gap");
        same(
                Window.of(TODAY, TODAY.minusDays(12)).from,
                TODAY.minusDays(12),
                "gap heals from there");
        same(Window.of(TODAY, TODAY.minusDays(40)).days(), 30L, "a long gap is capped");
        same(Window.of(TODAY, TODAY).to, TODAY, "every window ends today");
        chunks(10, 30, "10");
        chunks(30, 30, "30");
        chunks(90, 30, "30,30,30");
        chunks(91, 30, "1,30,30,30");
        chunks(365, Payload.CHUNK_DAYS, "5,30,30,30,30,30,30,30,30,30,30,30,30");
        chunks(Payload.RESYNC_DAYS, Payload.CHUNK_DAYS, "30,30,30");
    }

    /** {@code days} ending today in chunks of {@code size}: oldest first, gapless, ending today. */
    private static void chunks(int days, int size, String want) {
        StringBuilder sizes = new StringBuilder();
        LocalDate next = TODAY.minusDays(days - 1L);
        for (Window w : Window.chunks(TODAY, days, size)) {
            same(w.from, next, days + " days: a chunk starts where the last ended");
            next = w.to.plusDays(1);
            sizes.append(sizes.length() == 0 ? "" : ",").append(w.days());
        }
        same(next, TODAY.plusDays(1), days + " days end today");
        same(sizes.toString(), want, days + " days in chunks of " + size);
    }

    private static void resyncResumesAtTheFailedChunk() {
        List<Window> chunks = Window.chunks(TODAY, Payload.RESYNC_DAYS, Payload.CHUNK_DAYS);
        // Chunks 1 and 2 sent, 3 failed: the retry starts at 3.
        same(Window.resume(chunks, chunks.get(2).from), chunks.subList(2, 3), "resumes at chunk 3");
        same(Window.resume(chunks, chunks.get(0).from), chunks, "nothing sent: all of it");
        same(Window.resume(chunks, TODAY.plusDays(1)), List.of(), "all sent: nothing left");
        // A retry a day later: today's chunks moved; what's sent isn't sent again.
        List<Window> later =
                Window.chunks(TODAY.plusDays(1), Payload.RESYNC_DAYS, Payload.CHUNK_DAYS);
        List<Window> rest = Window.resume(later, chunks.get(2).from);
        same(rest.get(0).from, chunks.get(2).from, "a day later: from the failed chunk's start");
        same(rest.get(rest.size() - 1).to, TODAY.plusDays(1), "to the new today");
    }

    private static void lastOkToIsMonotonic() {
        same(Payload.lastOkTo(null, TODAY), TODAY.toString(), "the first");
        same(Payload.lastOkTo(TODAY.minusDays(3).toString(), TODAY), TODAY.toString(), "forward");
        same(
                Payload.lastOkTo(TODAY.toString(), TODAY.minusDays(60)),
                TODAY.toString(),
                "a resync chunk never moves it back");
    }

    private static void forRun() {
        same(
                Window.forRun(TODAY, 0, null, null),
                List.of(Window.of(TODAY, null)),
                "no resync: the normal window, a first sync's");
        same(
                Window.forRun(TODAY, 0, TODAY.minusDays(3).toString(), "2026-01-01"),
                List.of(Window.of(TODAY, TODAY.minusDays(3))),
                "after the last successful day");
        List<Window> chunks = Window.chunks(TODAY, Payload.RESYNC_DAYS, Payload.CHUNK_DAYS);
        same(Window.forRun(TODAY, Payload.RESYNC_DAYS, null, null), chunks, "a resync's chunks");
        same(
                Window.forRun(TODAY, Payload.RESYNC_DAYS, null, chunks.get(1).from.toString()),
                chunks.subList(1, 3),
                "a resync resumed");
    }
}
