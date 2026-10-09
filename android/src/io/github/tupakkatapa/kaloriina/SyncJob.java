package io.github.tupakkatapa.kaloriina;

import android.app.ActivityManager;
import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;
import android.content.pm.PackageManager;
import android.health.connect.AggregateRecordsGroupedByPeriodResponse;
import android.health.connect.AggregateRecordsRequest;
import android.health.connect.AggregateRecordsResponse;
import android.health.connect.HealthConnectException;
import android.health.connect.HealthConnectManager;
import android.health.connect.HealthPermissions;
import android.health.connect.LocalTimeRangeFilter;
import android.health.connect.ReadRecordsRequestUsingFilters;
import android.health.connect.ReadRecordsResponse;
import android.health.connect.TimeInstantRangeFilter;
import android.health.connect.datatypes.ActiveCaloriesBurnedRecord;
import android.health.connect.datatypes.AggregationType;
import android.health.connect.datatypes.DistanceRecord;
import android.health.connect.datatypes.ExerciseSessionRecord;
import android.health.connect.datatypes.HeartRateVariabilityRmssdRecord;
import android.health.connect.datatypes.Record;
import android.health.connect.datatypes.RestingHeartRateRecord;
import android.health.connect.datatypes.SleepSessionRecord;
import android.health.connect.datatypes.StepsRecord;
import android.health.connect.datatypes.units.Energy;
import android.health.connect.datatypes.units.Length;
import android.os.Build;
import android.os.OutcomeReceiver;
import android.os.PersistableBundle;
import java.io.IOException;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.Period;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.function.Consumer;

/**
 * The sync: every 2 hours on an unmetered network (job 1), or once on demand (job 2,
 * its window in the {@code days} extra). Each run probes the server, checks the permissions,
 * reads Health Connect and POSTs the window, or nothing at all.
 */
public final class SyncJob extends JobService {
    static final int PERIODIC = 1;
    static final int NOW = 2;
    private static final String DAYS = "days";
    private static final long MINUTE = 60_000;
    /** The age past which opening the app syncs at once. */
    static final Duration STALE = Duration.ofHours(1);

    /** Read always; background access and history only when the run needs them. */
    static final String[] READ = {
        HealthPermissions.READ_ACTIVE_CALORIES_BURNED,
        HealthPermissions.READ_STEPS,
        HealthPermissions.READ_EXERCISE,
        HealthPermissions.READ_SLEEP,
        HealthPermissions.READ_RESTING_HEART_RATE,
        HealthPermissions.READ_HEART_RATE_VARIABILITY,
        HealthPermissions.READ_DISTANCE,
    };
    static final String[] ALL = {
        HealthPermissions.READ_ACTIVE_CALORIES_BURNED,
        HealthPermissions.READ_STEPS,
        HealthPermissions.READ_EXERCISE,
        HealthPermissions.READ_SLEEP,
        HealthPermissions.READ_RESTING_HEART_RATE,
        HealthPermissions.READ_HEART_RATE_VARIABILITY,
        HealthPermissions.READ_DISTANCE,
        HealthPermissions.READ_HEALTH_DATA_IN_BACKGROUND,
        HealthPermissions.READ_HEALTH_DATA_HISTORY,
    };

    private final ExecutorService worker = Executors.newSingleThreadExecutor();

    /** A failure no retry can fix: a permission is missing. */
    private static final class Permanent extends Exception {
        private static final long serialVersionUID = 1L;

        Permanent(String message) {
            super(message);
        }
    }

    private static JobScheduler jobs(Context ctx) {
        return ctx.getSystemService(JobScheduler.class);
    }

    private static JobInfo.Builder job(Context ctx, int id) {
        return new JobInfo.Builder(id, new ComponentName(ctx, SyncJob.class))
                .setBackoffCriteria(30 * MINUTE, JobInfo.BACKOFF_POLICY_EXPONENTIAL);
    }

    /** The periodic sync, unless it's already scheduled. */
    static void schedule(Context ctx) {
        if (jobs(ctx).getPendingJob(PERIODIC) != null) {
            return;
        }
        jobs(ctx).schedule(job(ctx, PERIODIC)
                .setPeriodic(120 * MINUTE, 30 * MINUTE)
                .setPersisted(true)
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_UNMETERED)
                .build());
    }

    /** One sync now: the normal window ({@code days} 0) or a resync of that many days. */
    static void runNow(Context ctx, int days) {
        PersistableBundle extras = new PersistableBundle();
        extras.putInt(DAYS, days);
        jobs(ctx).schedule(job(ctx, NOW)
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                .setExtras(extras)
                .build());
    }

    static boolean pending(Context ctx) {
        return jobs(ctx).getPendingJob(NOW) != null;
    }

    static void stop(Context ctx) {
        jobs(ctx).cancel(PERIODIC);
        jobs(ctx).cancel(NOW);
    }

    @Override
    public boolean onStartJob(JobParameters params) {
        int days = params.getExtras().getInt(DAYS, 0);
        worker.execute(() -> jobFinished(params, run(days)));
        return true;
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        return true;
    }

    @Override
    public void onDestroy() {
        worker.shutdownNow();
        super.onDestroy();
    }

    /** One run; whether to retry it with backoff. */
    private boolean run(int resync) {
        Store store = new Store(this);
        String origin = store.origin();
        long profile = store.profile();
        if (origin == null || profile == 0) {
            store.failed("Choose a profile in Settings");
            return false;
        }
        if (!Net.isKaloriina(origin)) {
            store.failed("Not on the home network");
            return false;
        }
        ZoneId zone = ZoneId.systemDefault();
        LocalDate today = LocalDate.now(zone);
        String last = store.lastOkTo();
        Payload.Window window =
                Payload.Window.of(today, last == null ? null : LocalDate.parse(last), resync);
        Payload.Batch batch;
        try {
            checkPermissions(resync > 0);
            batch = read(window, zone);
        } catch (Permanent | SecurityException e) {
            store.failed("Health Connect access not granted: open Settings (" + e.getMessage() + ")");
            return false;
        } catch (HealthConnectException e) {
            boolean denied = e.getErrorCode() == HealthConnectException.ERROR_SECURITY;
            store.failed(denied ? "Health Connect access not granted: open Settings"
                    : "Health Connect: " + e.getMessage());
            return !denied;
        } catch (TimeoutException | InterruptedException e) {
            store.failed("Health Connect didn't answer");
            return true;
        }
        String body = batch.json();
        if (body == null) {
            store.failed(batch.why());
            return true;
        }
        return post(store, origin + "/api/profiles/" + profile + "/sync/health", body, window);
    }

    private void checkPermissions(boolean history) throws Permanent {
        for (String p : READ) {
            need(p);
        }
        if (!inFront()) {
            need(HealthPermissions.READ_HEALTH_DATA_IN_BACKGROUND);
        }
        if (history) {
            need(HealthPermissions.READ_HEALTH_DATA_HISTORY);
        }
    }

    private void need(String permission) throws Permanent {
        if (checkSelfPermission(permission) != PackageManager.PERMISSION_GRANTED) {
            throw new Permanent(permission.substring(permission.lastIndexOf('.') + 1));
        }
    }

    private static boolean inFront() {
        ActivityManager.RunningAppProcessInfo me = new ActivityManager.RunningAppProcessInfo();
        ActivityManager.getMyMemoryState(me);
        return me.importance <= ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND;
    }

    /** Wait for one Health Connect call; its error or a 30 s silence is thrown. */
    private static <R> R await(Consumer<OutcomeReceiver<R, HealthConnectException>> call)
            throws TimeoutException, InterruptedException {
        CompletableFuture<R> done = new CompletableFuture<>();
        call.accept(new OutcomeReceiver<R, HealthConnectException>() {
            @Override
            public void onResult(R result) {
                done.complete(result);
            }

            @Override
            public void onError(HealthConnectException e) {
                done.completeExceptionally(e);
            }
        });
        try {
            return done.get(30, TimeUnit.SECONDS);
        } catch (ExecutionException e) {
            if (e.getCause() instanceof RuntimeException r) {
                throw r;
            }
            throw new IllegalStateException(e.getCause());
        }
    }

    /** One metric's daily totals over the window, by day. */
    private <T> Map<LocalDate, T> daily(HealthConnectManager hc, AggregationType<T> metric,
            LocalTimeRangeFilter range) throws TimeoutException, InterruptedException {
        AggregateRecordsRequest<T> request =
                new AggregateRecordsRequest.Builder<T>(range).addAggregationType(metric).build();
        List<AggregateRecordsGroupedByPeriodResponse<T>> buckets = await(
                cb -> hc.aggregateGroupByPeriod(request, Period.ofDays(1), Runnable::run, cb));
        Map<LocalDate, T> out = new HashMap<>();
        for (AggregateRecordsGroupedByPeriodResponse<T> b : buckets) {
            T value = b.get(metric);
            if (value != null) {
                out.put(b.getStartTime().toLocalDate(), value);
            }
        }
        return out;
    }

    /**
     * The window's days, nights and workouts. Active energy, steps and resting heart rate are one
     * grouped aggregate each (the typed request holds one); sleep and HRV are paged reads over the
     * window and the day before, HRV a week at a time so a resync stays under the page cap;
     * each workout's energy, and a distance workout's distance, is one more aggregate.
     */
    private Payload.Batch read(Payload.Window w, ZoneId zone)
            throws TimeoutException, InterruptedException {
        HealthConnectManager hc = getSystemService(HealthConnectManager.class);
        Payload.Batch batch = new Payload.Batch(w, zone, Build.MODEL);
        LocalTimeRangeFilter days = new LocalTimeRangeFilter.Builder()
                .setStartTime(w.from.atStartOfDay())
                .setEndTime(w.to.plusDays(1).atStartOfDay())
                .build();
        Map<LocalDate, Energy> energy =
                daily(hc, ActiveCaloriesBurnedRecord.ACTIVE_CALORIES_TOTAL, days);
        Map<LocalDate, Long> steps = daily(hc, StepsRecord.STEPS_COUNT_TOTAL, days);
        Map<LocalDate, Long> rhr = daily(hc, RestingHeartRateRecord.BPM_AVG, days);
        for (LocalDate d = w.from; !d.isAfter(w.to); d = d.plusDays(1)) {
            Energy e = energy.get(d);
            batch.day(d, e == null ? null : Payload.kcal(e.getInCalories()), steps.get(d));
            batch.rhr(d, rhr.get(d));
        }
        Instant start = w.from.atStartOfDay(zone).toInstant();
        Instant before = w.from.minusDays(1).atStartOfDay(zone).toInstant();
        Instant end = w.to.plusDays(1).atStartOfDay(zone).toInstant();
        for (SleepSessionRecord s : readAll(hc, SleepSessionRecord.class, before, end, batch,
                "sleep")) {
            List<Payload.Stage> stages = new ArrayList<>();
            for (SleepSessionRecord.Stage st : s.getStages()) {
                stages.add(new Payload.Stage(st.getStartTime(), st.getEndTime(), st.getType()));
            }
            batch.sleep(new Payload.Sleep(s.getStartTime(), s.getEndTime(), stages));
        }
        for (Instant from = before; from.isBefore(end); from = from.plus(Duration.ofDays(7))) {
            Instant to = from.plus(Duration.ofDays(7));
            for (HeartRateVariabilityRmssdRecord r : readAll(hc,
                    HeartRateVariabilityRmssdRecord.class, from, to.isBefore(end) ? to : end, batch,
                    "HRV readings")) {
                batch.hrv(new Payload.Reading(r.getTime(), r.getHeartRateVariabilityMillis()));
            }
        }
        for (ExerciseSessionRecord s : readAll(hc, ExerciseSessionRecord.class, start, end, batch,
                "workouts")) {
            Length distance = Payload.hasDistance(s.getExerciseType())
                    ? total(hc, s, DistanceRecord.DISTANCE_TOTAL) : null;
            Energy kcal = total(hc, s, ActiveCaloriesBurnedRecord.ACTIVE_CALORIES_TOTAL);
            batch.session(s.getMetadata().getId(), s.getStartTime(), s.getEndTime(),
                    s.getExerciseType(), s.getTitle(),
                    kcal == null ? null : Payload.kcal(kcal.getInCalories()),
                    distance == null ? null : Payload.metres(distance.getInMeters()),
                    s.getMetadata().getRecordingMethod());
        }
        return batch;
    }

    /**
     * Every record of {@code type} in [{@code from}, {@code to}), at most 10 pages; a page left
     * unread marks {@code batch} incomplete, naming {@code what}.
     */
    private static <T extends Record> List<T> readAll(HealthConnectManager hc, Class<T> type,
            Instant from, Instant to, Payload.Batch batch, String what)
            throws TimeoutException, InterruptedException {
        TimeInstantRangeFilter span =
                new TimeInstantRangeFilter.Builder().setStartTime(from).setEndTime(to).build();
        List<T> out = new ArrayList<>();
        long token = -1;
        int pages = 0;
        do {
            ReadRecordsRequestUsingFilters.Builder<T> b =
                    new ReadRecordsRequestUsingFilters.Builder<>(type)
                            .setTimeRangeFilter(span)
                            .setPageSize(1000);
            if (token != -1) {
                b.setPageToken(token);
            }
            ReadRecordsRequestUsingFilters<T> request = b.build();
            ReadRecordsResponse<T> page = await(cb -> hc.readRecords(request, Runnable::run, cb));
            out.addAll(page.getRecords());
            token = page.getNextPageToken();
            pages++;
        } while (token != -1 && pages < 10);
        batch.pageLeft(token, what);
        return out;
    }

    /** One metric's total over a workout's span. */
    private static <T> T total(HealthConnectManager hc, ExerciseSessionRecord s,
            AggregationType<T> metric) throws TimeoutException, InterruptedException {
        AggregateRecordsRequest<T> request = new AggregateRecordsRequest.Builder<T>(
                        new TimeInstantRangeFilter.Builder()
                                .setStartTime(s.getStartTime())
                                .setEndTime(s.getEndTime())
                                .build())
                .addAggregationType(metric)
                .build();
        AggregateRecordsResponse<T> total = await(cb -> hc.aggregate(request, Runnable::run, cb));
        return total.get(metric);
    }

    /** POST the window and record the outcome; whether to retry. */
    private static boolean post(Store store, String url, String body, Payload.Window w) {
        Payload.Outcome out;
        try {
            Net.Reply reply = Net.post(url, body, Net.POST_MS);
            out = Payload.outcome(reply.code, reply.json() ? reply.text() : null);
        } catch (IOException e) {
            out = Payload.UNREACHABLE;
        }
        if (out.succeeded()) {
            store.succeeded(w.to.toString(), out.message(), System.currentTimeMillis());
        } else {
            store.failed(out.message());
        }
        return out.retry();
    }
}
