package io.github.tupakkatapa.kaloriina;

import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.List;

/** Days {@code from}..{@code to}, both included, in the phone's zone. */
public final class Window {
    public final LocalDate from;
    public final LocalDate to;

    public Window(LocalDate from, LocalDate to) {
        this.from = from;
        this.to = to;
    }

    /**
     * The window ending {@code today}: the first sync's 30 days; else the last 7, reaching back to
     * the last successful {@code to} after a gap, at most 30.
     */
    public static Window of(LocalDate today, LocalDate lastOkTo) {
        LocalDate earliest = today.minusDays(Payload.FIRST_DAYS - 1L);
        if (lastOkTo == null) {
            return new Window(earliest, today);
        }
        LocalDate from = today.minusDays(Payload.NORMAL_DAYS - 1L);
        if (lastOkTo.isBefore(from)) {
            from = lastOkTo;
        }
        return new Window(from.isBefore(earliest) ? earliest : from, today);
    }

    /**
     * A resync: the {@code days} ending {@code today} as gapless windows of at most {@code size}
     * days, oldest first (the oldest holds the remainder).
     */
    public static List<Window> chunks(LocalDate today, int days, int size) {
        List<Window> out = new ArrayList<>();
        LocalDate first = today.minusDays(days - 1L);
        for (LocalDate to = today; !to.isBefore(first); to = to.minusDays(size)) {
            LocalDate from = to.minusDays(size - 1L);
            out.add(0, new Window(from.isBefore(first) ? first : from, to));
        }
        return out;
    }

    /**
     * What is left of a resync's {@code chunks} when every day before {@code next} is sent: a retry
     * resumes at the chunk that failed, not at the first.
     */
    public static List<Window> resume(List<Window> chunks, LocalDate next) {
        List<Window> out = new ArrayList<>();
        for (Window w : chunks) {
            if (!w.to.isBefore(next)) {
                out.add(w.from.isBefore(next) ? new Window(next, w.to) : w);
            }
        }
        return out;
    }

    public long days() {
        return ChronoUnit.DAYS.between(from, to) + 1;
    }

    boolean contains(LocalDate day) {
        return !day.isBefore(from) && !day.isAfter(to);
    }

    /** The window's first instant in {@code zone}, and the one after its last day. */
    Instant start(ZoneId zone) {
        return from.atStartOfDay(zone).toInstant();
    }

    Instant end(ZoneId zone) {
        return to.plusDays(1).atStartOfDay(zone).toInstant();
    }

    @Override
    public boolean equals(Object o) {
        return o instanceof Window w && w.from.equals(from) && w.to.equals(to);
    }

    @Override
    public int hashCode() {
        return from.hashCode() * 31 + to.hashCode();
    }

    @Override
    public String toString() {
        return from + ".." + to;
    }

    /**
     * The windows a run sends: a resync of {@code resync} days in chunks (from {@code next} on,
     * when one stopped there), else the normal window after {@code lastOkTo}.
     */
    public static List<Window> forRun(LocalDate today, int resync, String lastOkTo, String next) {
        if (resync <= 0) {
            return List.of(of(today, lastOkTo == null ? null : LocalDate.parse(lastOkTo)));
        }
        List<Window> chunks = chunks(today, resync, Payload.CHUNK_DAYS);
        return next == null ? chunks : resume(chunks, LocalDate.parse(next));
    }
}
