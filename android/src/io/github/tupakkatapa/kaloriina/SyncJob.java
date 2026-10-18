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
import android.health.connect.datatypes.BasalMetabolicRateRecord;
import android.health.connect.datatypes.BloodGlucoseRecord;
import android.health.connect.datatypes.BloodPressureRecord;
import android.health.connect.datatypes.BodyFatRecord;
import android.health.connect.datatypes.BodyTemperatureRecord;
import android.health.connect.datatypes.BoneMassRecord;
import android.health.connect.datatypes.CyclingPedalingCadenceRecord;
import android.health.connect.datatypes.Device;
import android.health.connect.datatypes.DistanceRecord;
import android.health.connect.datatypes.ElevationGainedRecord;
import android.health.connect.datatypes.ExerciseLap;
import android.health.connect.datatypes.ExerciseSegment;
import android.health.connect.datatypes.ExerciseSessionRecord;
import android.health.connect.datatypes.FloorsClimbedRecord;
import android.health.connect.datatypes.HeartRateRecord;
import android.health.connect.datatypes.HeartRateVariabilityRmssdRecord;
import android.health.connect.datatypes.HeightRecord;
import android.health.connect.datatypes.HydrationRecord;
import android.health.connect.datatypes.InstantRecord;
import android.health.connect.datatypes.IntervalRecord;
import android.health.connect.datatypes.LeanBodyMassRecord;
import android.health.connect.datatypes.Metadata;
import android.health.connect.datatypes.OxygenSaturationRecord;
import android.health.connect.datatypes.PowerRecord;
import android.health.connect.datatypes.Record;
import android.health.connect.datatypes.RespiratoryRateRecord;
import android.health.connect.datatypes.RestingHeartRateRecord;
import android.health.connect.datatypes.SkinTemperatureRecord;
import android.health.connect.datatypes.SleepSessionRecord;
import android.health.connect.datatypes.SpeedRecord;
import android.health.connect.datatypes.StepsCadenceRecord;
import android.health.connect.datatypes.StepsRecord;
import android.health.connect.datatypes.TotalCaloriesBurnedRecord;
import android.health.connect.datatypes.Vo2MaxRecord;
import android.health.connect.datatypes.WeightRecord;
import android.health.connect.datatypes.units.Length;
import android.health.connect.datatypes.units.Temperature;
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
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.BooleanSupplier;
import java.util.function.Consumer;
import java.util.function.ToDoubleFunction;

/**
 * The sync: every 2 hours on an unmetered network (job 1), or once on demand (job 2, its window in
 * the {@code days} extra). Each run probes the server, checks the permissions, then reads Health
 * Connect and posts each window ({@link Payload#sync}; a resync a chunk at a time, resuming where a
 * failed run stopped).
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

    /** The grant dialog's: the required set, each optional kind's, background and history. */
    static final String[] ALL = all();

    /** The class Health Connect reads for each raw kind. */
    private static final Map<String, Class<? extends Record>> TYPES =
            Map.ofEntries(
                    Map.entry("Steps", StepsRecord.class),
                    Map.entry("ActiveCaloriesBurned", ActiveCaloriesBurnedRecord.class),
                    Map.entry("Distance", DistanceRecord.class),
                    Map.entry("ExerciseSession", ExerciseSessionRecord.class),
                    Map.entry("SleepSession", SleepSessionRecord.class),
                    Map.entry("RestingHeartRate", RestingHeartRateRecord.class),
                    Map.entry("HeartRateVariabilityRmssd", HeartRateVariabilityRmssdRecord.class),
                    Map.entry("Weight", WeightRecord.class),
                    Map.entry("BodyFat", BodyFatRecord.class),
                    Map.entry("LeanBodyMass", LeanBodyMassRecord.class),
                    Map.entry("BoneMass", BoneMassRecord.class),
                    Map.entry("BasalMetabolicRate", BasalMetabolicRateRecord.class),
                    Map.entry("Height", HeightRecord.class),
                    Map.entry("TotalCaloriesBurned", TotalCaloriesBurnedRecord.class),
                    Map.entry("HeartRate", HeartRateRecord.class),
                    Map.entry("OxygenSaturation", OxygenSaturationRecord.class),
                    Map.entry("RespiratoryRate", RespiratoryRateRecord.class),
                    Map.entry("BodyTemperature", BodyTemperatureRecord.class),
                    Map.entry("SkinTemperature", SkinTemperatureRecord.class),
                    Map.entry("Vo2Max", Vo2MaxRecord.class),
                    Map.entry("FloorsClimbed", FloorsClimbedRecord.class),
                    Map.entry("ElevationGained", ElevationGainedRecord.class),
                    Map.entry("Hydration", HydrationRecord.class),
                    Map.entry("BloodPressure", BloodPressureRecord.class),
                    Map.entry("BloodGlucose", BloodGlucoseRecord.class),
                    Map.entry("Speed", SpeedRecord.class),
                    Map.entry("Power", PowerRecord.class),
                    Map.entry("CyclingPedalingCadence", CyclingPedalingCadenceRecord.class),
                    Map.entry("StepsCadence", StepsCadenceRecord.class));

    private static String[] all() {
        Set<String> out = new LinkedHashSet<>(List.of(READ));
        for (Kinds.Kind k : Kinds.OPTIONAL) {
            out.add(k.permission());
        }
        out.add(HealthPermissions.READ_HEALTH_DATA_IN_BACKGROUND);
        out.add(HealthPermissions.READ_HEALTH_DATA_HISTORY);
        return out.toArray(new String[0]);
    }

    private final ExecutorService worker = Executors.newSingleThreadExecutor();

    /**
     * Each running job's stop flag, one per run: a stopped or replaced run stops between posts, and
     * the run that replaced it under the same id starts with its own.
     */
    private final Map<Integer, AtomicBoolean> runs = new ConcurrentHashMap<>();

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
        jobs(ctx)
                .schedule(
                        job(ctx, PERIODIC)
                                .setPeriodic(120 * MINUTE, 30 * MINUTE)
                                .setPersisted(true)
                                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_UNMETERED)
                                .build());
    }

    /** One sync now: the normal window ({@code days} 0) or a new resync of that many days. */
    static void runNow(Context ctx, int days) {
        if (days > 0) {
            new Store(ctx).resyncNext(null);
        }
        PersistableBundle extras = new PersistableBundle();
        extras.putInt(DAYS, days);
        jobs(ctx)
                .schedule(
                        job(ctx, NOW)
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
        int id = params.getJobId();
        AtomicBoolean stop = new AtomicBoolean();
        // The system stops a run before it starts its replacement; should one still be
        // running, it's replaced all the same.
        AtomicBoolean replaced = runs.put(id, stop);
        if (replaced != null) {
            replaced.set(true);
        }
        worker.execute(
                () -> {
                    boolean retry = run(days, stop::get);
                    runs.remove(id, stop);
                    // A replaced run's end isn't the answer: its successor's is.
                    if (!stop.get()) {
                        new Store(this).ended(System.currentTimeMillis());
                    }
                    jobFinished(params, retry);
                });
        return true;
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        AtomicBoolean stop = runs.remove(params.getJobId());
        if (stop != null) {
            stop.set(true);
        }
        return true;
    }

    @Override
    public void onDestroy() {
        worker.shutdownNow();
        super.onDestroy();
    }

    /** One run ({@link Payload#run}); whether to retry it with backoff. */
    private boolean run(int resync, BooleanSupplier stopped) {
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
        String url = origin + "/api/profiles/" + profile + "/sync/health";
        return Payload.run(
                LocalDate.now(zone),
                resync,
                store,
                w -> sync(w, zone, resync > 0, url, stopped),
                System::currentTimeMillis);
    }

    /** Check the permissions, then read and post one window. */
    private Payload.Outcome sync(
            Window window, ZoneId zone, boolean history, String url, BooleanSupplier stopped) {
        try {
            checkPermissions(history);
            return Payload.sync(
                    window,
                    zone,
                    Build.MODEL,
                    new Hc(getSystemService(HealthConnectManager.class)),
                    (path, body) -> post(url + path, body),
                    stopped);
        } catch (Permanent | SecurityException e) {
            return new Payload.Outcome(
                    "Health Connect access not granted: open Settings (" + e.getMessage() + ")",
                    false,
                    false);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return Payload.STOPPED;
        }
    }

    private static Payload.Outcome post(String url, String body) {
        try {
            Net.Reply reply = Net.post(url, body, Net.POST_MS);
            return Payload.outcome(reply.code, reply.json() ? reply.text() : null);
        } catch (IOException e) {
            return Payload.UNREACHABLE;
        }
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

    /** Health Connect for {@link Payload#sync}: paged reads, daily and span aggregates. */
    private final class Hc implements Payload.Source {
        private final HealthConnectManager hc;

        Hc(HealthConnectManager hc) {
            this.hc = hc;
        }

        @Override
        public boolean granted(String permission) {
            return checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED;
        }

        @Override
        public Payload.Page read(String kind, Instant from, Instant to, long token)
                throws Payload.ReadFailed, InterruptedException {
            return read(kind, TYPES.get(kind), from, to, token);
        }

        /** One page of up to 1000 records. */
        private <T extends Record> Payload.Page read(
                String kind, Class<T> type, Instant from, Instant to, long token)
                throws Payload.ReadFailed, InterruptedException {
            ReadRecordsRequestUsingFilters.Builder<T> b =
                    new ReadRecordsRequestUsingFilters.Builder<>(type)
                            .setTimeRangeFilter(
                                    new TimeInstantRangeFilter.Builder()
                                            .setStartTime(from)
                                            .setEndTime(to)
                                            .build())
                            .setPageSize(1000);
            if (token != -1) {
                b.setPageToken(token);
            }
            ReadRecordsRequestUsingFilters<T> request = b.build();
            ReadRecordsResponse<T> page = await(cb -> hc.readRecords(request, Runnable::run, cb));
            List<Payload.Rec> out = new ArrayList<>();
            for (T r : page.getRecords()) {
                out.add(rec(kind, r));
            }
            return new Payload.Page(out, page.getNextPageToken());
        }

        @Override
        public Map<LocalDate, Double> daily(String metric, Window w)
                throws Payload.ReadFailed, InterruptedException {
            LocalTimeRangeFilter days =
                    new LocalTimeRangeFilter.Builder()
                            .setStartTime(w.from.atStartOfDay())
                            .setEndTime(w.to.plusDays(1).atStartOfDay())
                            .build();
            return switch (metric) {
                case Payload.ACTIVE_KCAL ->
                        daily(
                                ActiveCaloriesBurnedRecord.ACTIVE_CALORIES_TOTAL,
                                days,
                                e -> e.getInCalories() / 1000);
                case Payload.TOTAL_KCAL ->
                        daily(
                                TotalCaloriesBurnedRecord.ENERGY_TOTAL,
                                days,
                                e -> e.getInCalories() / 1000);
                case Payload.STEPS -> daily(StepsRecord.STEPS_COUNT_TOTAL, days, Long::doubleValue);
                case Payload.RESTING_HR ->
                        daily(RestingHeartRateRecord.BPM_AVG, days, Long::doubleValue);
                case Payload.AVG_HR -> daily(HeartRateRecord.BPM_AVG, days, Long::doubleValue);
                case Payload.MIN_HR -> daily(HeartRateRecord.BPM_MIN, days, Long::doubleValue);
                case Payload.MAX_HR -> daily(HeartRateRecord.BPM_MAX, days, Long::doubleValue);
                default -> throw new IllegalArgumentException(metric);
            };
        }

        private <T> Map<LocalDate, Double> daily(
                AggregationType<T> metric, LocalTimeRangeFilter range, ToDoubleFunction<T> unit)
                throws Payload.ReadFailed, InterruptedException {
            AggregateRecordsRequest<T> request =
                    new AggregateRecordsRequest.Builder<T>(range)
                            .addAggregationType(metric)
                            .build();
            List<AggregateRecordsGroupedByPeriodResponse<T>> buckets =
                    await(
                            cb ->
                                    hc.aggregateGroupByPeriod(
                                            request, Period.ofDays(1), Runnable::run, cb));
            Map<LocalDate, Double> out = new HashMap<>();
            for (AggregateRecordsGroupedByPeriodResponse<T> b : buckets) {
                T value = b.get(metric);
                if (value != null) {
                    out.put(b.getStartTime().toLocalDate(), unit.applyAsDouble(value));
                }
            }
            return out;
        }

        @Override
        public Double total(String metric, Instant from, Instant to)
                throws Payload.ReadFailed, InterruptedException {
            return switch (metric) {
                case Payload.ACTIVE_KCAL ->
                        total(
                                ActiveCaloriesBurnedRecord.ACTIVE_CALORIES_TOTAL,
                                from,
                                to,
                                e -> e.getInCalories() / 1000);
                case Payload.TOTAL_KCAL ->
                        total(
                                TotalCaloriesBurnedRecord.ENERGY_TOTAL,
                                from,
                                to,
                                e -> e.getInCalories() / 1000);
                case Payload.DISTANCE_M ->
                        total(DistanceRecord.DISTANCE_TOTAL, from, to, Length::getInMeters);
                case Payload.AVG_HR -> total(HeartRateRecord.BPM_AVG, from, to, Long::doubleValue);
                default -> throw new IllegalArgumentException(metric);
            };
        }

        private <T> Double total(
                AggregationType<T> metric, Instant from, Instant to, ToDoubleFunction<T> unit)
                throws Payload.ReadFailed, InterruptedException {
            AggregateRecordsRequest<T> request =
                    new AggregateRecordsRequest.Builder<T>(
                                    new TimeInstantRangeFilter.Builder()
                                            .setStartTime(from)
                                            .setEndTime(to)
                                            .build())
                            .addAggregationType(metric)
                            .build();
            AggregateRecordsResponse<T> total =
                    await(cb -> hc.aggregate(request, Runnable::run, cb));
            T value = total.get(metric);
            return value == null ? null : unit.applyAsDouble(value);
        }
    }

    /**
     * Wait for one Health Connect call; its error, a refusal or a 30 s silence is thrown as a
     * failed read (a spent quota apart).
     */
    private static <R> R await(Consumer<OutcomeReceiver<R, HealthConnectException>> call)
            throws Payload.ReadFailed, InterruptedException {
        CompletableFuture<R> done = new CompletableFuture<>();
        try {
            call.accept(
                    new OutcomeReceiver<R, HealthConnectException>() {
                        @Override
                        public void onResult(R result) {
                            done.complete(result);
                        }

                        @Override
                        public void onError(HealthConnectException e) {
                            done.completeExceptionally(e);
                        }
                    });
            return done.get(30, TimeUnit.SECONDS);
        } catch (SecurityException e) {
            throw new Payload.ReadFailed(Payload.ReadFailed.Why.DENIED, e.getMessage());
        } catch (TimeoutException e) {
            throw new Payload.ReadFailed(
                    Payload.ReadFailed.Why.OTHER, "Health Connect didn't answer");
        } catch (HealthConnectException e) {
            throw failed(e);
        } catch (ExecutionException e) {
            if (e.getCause() instanceof HealthConnectException h) {
                throw failed(h);
            }
            if (e.getCause() instanceof RuntimeException r) {
                throw r;
            }
            throw new IllegalStateException(e.getCause());
        }
    }

    private static Payload.ReadFailed failed(HealthConnectException e) {
        return new Payload.ReadFailed(
                switch (e.getErrorCode()) {
                    case HealthConnectException.ERROR_SECURITY -> Payload.ReadFailed.Why.DENIED;
                    case HealthConnectException.ERROR_RATE_LIMIT_EXCEEDED ->
                            Payload.ReadFailed.Why.RATE_LIMITED;
                    default -> Payload.ReadFailed.Why.OTHER;
                },
                "Health Connect: " + e.getMessage());
    }

    /** A map of {@code keys} and values in order, nulls kept. */
    private static Map<String, Object> map(Object... kv) {
        Map<String, Object> out = new LinkedHashMap<>();
        for (int i = 0; i < kv.length; i += 2) {
            out.put((String) kv[i], kv[i + 1]);
        }
        return out;
    }

    /**
     * One record as plain values: its kind, id, span, and as {@code data} every field Health
     * Connect has for it (metadata, times and offsets, values with their unit in the key, series
     * samples as-is).
     */
    private static Payload.Rec rec(String kind, Record r) {
        Metadata m = r.getMetadata();
        Map<String, Object> data;
        Instant start;
        Instant end;
        if (r instanceof IntervalRecord i) {
            start = i.getStartTime();
            end = i.getEndTime();
            data =
                    map(
                            "start_time",
                            start,
                            "start_zone_offset",
                            i.getStartZoneOffset(),
                            "end_time",
                            end,
                            "end_zone_offset",
                            i.getEndZoneOffset());
        } else {
            InstantRecord i = (InstantRecord) r;
            start = i.getTime();
            end = null;
            data = map("time", start, "zone_offset", i.getZoneOffset());
        }
        Device d = m.getDevice();
        data.put(
                "metadata",
                map(
                        "id",
                        m.getId(),
                        "data_origin",
                        m.getDataOrigin().getPackageName(),
                        "last_modified_time",
                        m.getLastModifiedTime(),
                        "client_record_id",
                        m.getClientRecordId(),
                        "client_record_version",
                        m.getClientRecordVersion(),
                        "recording_method",
                        m.getRecordingMethod(),
                        "device",
                        d == null
                                ? null
                                : map(
                                        "type",
                                        d.getType(),
                                        "manufacturer",
                                        d.getManufacturer(),
                                        "model",
                                        d.getModel())));
        fields(data, r);
        return new Payload.Rec(kind, m.getId(), start, end, data);
    }

    private static String text(CharSequence s) {
        return s == null ? null : s.toString();
    }

    private static Double celsius(Temperature t) {
        return t == null ? null : t.getInCelsius();
    }

    /** The kind's own fields, one mapping per kind. */
    private static void fields(Map<String, Object> d, Record r) {
        if (r instanceof StepsRecord x) {
            d.put("count", x.getCount());
        } else if (r instanceof ActiveCaloriesBurnedRecord x) {
            d.put("kcal", x.getEnergy().getInCalories() / 1000);
        } else if (r instanceof TotalCaloriesBurnedRecord x) {
            d.put("kcal", x.getEnergy().getInCalories() / 1000);
        } else if (r instanceof DistanceRecord x) {
            d.put("meters", x.getDistance().getInMeters());
        } else if (r instanceof ElevationGainedRecord x) {
            d.put("meters", x.getElevation().getInMeters());
        } else if (r instanceof FloorsClimbedRecord x) {
            d.put("floors", x.getFloors());
        } else if (r instanceof HydrationRecord x) {
            d.put("liters", x.getVolume().getInLiters());
        } else if (r instanceof ExerciseSessionRecord x) {
            List<Object> segments = new ArrayList<>();
            for (ExerciseSegment s : x.getSegments()) {
                segments.add(
                        map(
                                "start_time",
                                s.getStartTime(),
                                "end_time",
                                s.getEndTime(),
                                "segment_type",
                                s.getSegmentType(),
                                "repetitions",
                                s.getRepetitionsCount()));
            }
            List<Object> laps = new ArrayList<>();
            for (ExerciseLap l : x.getLaps()) {
                Length length = l.getLength();
                laps.add(
                        map(
                                "start_time",
                                l.getStartTime(),
                                "end_time",
                                l.getEndTime(),
                                "length_meters",
                                length == null ? null : length.getInMeters()));
            }
            d.put("exercise_type", x.getExerciseType());
            d.put("title", text(x.getTitle()));
            d.put("notes", text(x.getNotes()));
            d.put("has_route", x.hasRoute());
            d.put("planned_exercise_session_id", x.getPlannedExerciseSessionId());
            d.put("segments", segments);
            d.put("laps", laps);
        } else if (r instanceof SleepSessionRecord x) {
            List<Object> stages = new ArrayList<>();
            for (SleepSessionRecord.Stage s : x.getStages()) {
                stages.add(
                        map(
                                "start_time",
                                s.getStartTime(),
                                "end_time",
                                s.getEndTime(),
                                "type",
                                s.getType()));
            }
            d.put("title", text(x.getTitle()));
            d.put("notes", text(x.getNotes()));
            d.put("stages", stages);
        } else if (r instanceof RestingHeartRateRecord x) {
            d.put("bpm", x.getBeatsPerMinute());
        } else if (r instanceof HeartRateVariabilityRmssdRecord x) {
            d.put("ms", x.getHeartRateVariabilityMillis());
        } else if (r instanceof WeightRecord x) {
            d.put("kg", x.getWeight().getInGrams() / 1000);
        } else if (r instanceof BodyFatRecord x) {
            d.put("percent", x.getPercentage().getValue());
        } else if (r instanceof LeanBodyMassRecord x) {
            d.put("kg", x.getMass().getInGrams() / 1000);
        } else if (r instanceof BoneMassRecord x) {
            d.put("kg", x.getMass().getInGrams() / 1000);
        } else if (r instanceof BasalMetabolicRateRecord x) {
            double watts = x.getBasalMetabolicRate().getInWatts();
            d.put("watts", watts);
            d.put("kcal_per_day", Payload.kcalPerDay(watts));
        } else if (r instanceof HeightRecord x) {
            d.put("meters", x.getHeight().getInMeters());
        } else if (r instanceof HeartRateRecord x) {
            List<Object> samples = new ArrayList<>();
            for (HeartRateRecord.HeartRateSample s : x.getSamples()) {
                samples.add(map("time", s.getTime(), "bpm", s.getBeatsPerMinute()));
            }
            d.put("samples", samples);
        } else if (r instanceof OxygenSaturationRecord x) {
            d.put("percent", x.getPercentage().getValue());
        } else if (r instanceof RespiratoryRateRecord x) {
            d.put("breaths_per_min", x.getRate());
        } else if (r instanceof BodyTemperatureRecord x) {
            d.put("celsius", celsius(x.getTemperature()));
            d.put("measurement_location", x.getMeasurementLocation());
        } else if (r instanceof SkinTemperatureRecord x) {
            List<Object> deltas = new ArrayList<>();
            for (SkinTemperatureRecord.Delta s : x.getDeltas()) {
                deltas.add(map("time", s.getTime(), "delta_celsius", s.getDelta().getInCelsius()));
            }
            d.put("baseline_celsius", celsius(x.getBaseline()));
            d.put("measurement_location", x.getMeasurementLocation());
            d.put("deltas", deltas);
        } else if (r instanceof Vo2MaxRecord x) {
            d.put("ml_per_min_kg", x.getVo2MillilitersPerMinuteKilogram());
            d.put("measurement_method", x.getMeasurementMethod());
        } else if (r instanceof BloodPressureRecord x) {
            d.put("systolic_mmHg", x.getSystolic().getInMillimetersOfMercury());
            d.put("diastolic_mmHg", x.getDiastolic().getInMillimetersOfMercury());
            d.put("body_position", x.getBodyPosition());
            d.put("measurement_location", x.getMeasurementLocation());
        } else if (r instanceof BloodGlucoseRecord x) {
            d.put("mmol_per_l", x.getLevel().getInMillimolesPerLiter());
            d.put("specimen_source", x.getSpecimenSource());
            d.put("relation_to_meal", x.getRelationToMeal());
            d.put("meal_type", x.getMealType());
        } else if (r instanceof SpeedRecord x) {
            List<Object> samples = new ArrayList<>();
            for (SpeedRecord.SpeedRecordSample s : x.getSamples()) {
                samples.add(
                        map(
                                "time",
                                s.getTime(),
                                "meters_per_second",
                                s.getSpeed().getInMetersPerSecond()));
            }
            d.put("samples", samples);
        } else if (r instanceof PowerRecord x) {
            List<Object> samples = new ArrayList<>();
            for (PowerRecord.PowerRecordSample s : x.getSamples()) {
                samples.add(map("time", s.getTime(), "watts", s.getPower().getInWatts()));
            }
            d.put("samples", samples);
        } else if (r instanceof CyclingPedalingCadenceRecord x) {
            List<Object> samples = new ArrayList<>();
            for (CyclingPedalingCadenceRecord.CyclingPedalingCadenceRecordSample s :
                    x.getSamples()) {
                samples.add(map("time", s.getTime(), "rpm", s.getRevolutionsPerMinute()));
            }
            d.put("samples", samples);
        } else if (r instanceof StepsCadenceRecord x) {
            List<Object> samples = new ArrayList<>();
            for (StepsCadenceRecord.StepsCadenceRecordSample s : x.getSamples()) {
                samples.add(map("time", s.getTime(), "steps_per_min", s.getRate()));
            }
            d.put("samples", samples);
        }
    }
}
