package io.github.tupakkatapa.kaloriina;

import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.function.Predicate;

/**
 * The Health Connect record kinds a sync reads raw: those it always reads, the optional ones read
 * when granted (with the label Settings shows), and those read with the window.
 */
public final class Kinds {
    private static final String HC = "android.permission.health.";

    /** A raw record kind (its Health Connect class without "Record"), permission and label. */
    public record Kind(String name, String permission, String label) {}

    /** The kinds the window already needs: read raw too, under the required permissions. */
    static final List<String> CORE =
            List.of(
                    "Steps",
                    "ActiveCaloriesBurned",
                    "Distance",
                    "ExerciseSession",
                    "SleepSession",
                    "RestingHeartRate",
                    "HeartRateVariabilityRmssd");

    /**
     * The kinds read only when their permission is granted. The two cadences come under the core
     * Exercise and Steps permissions; exercise routes are never asked for (their own consent).
     */
    public static final List<Kind> OPTIONAL =
            List.of(
                    new Kind("Weight", HC + "READ_WEIGHT", "Weight"),
                    new Kind("BodyFat", HC + "READ_BODY_FAT", "Body fat"),
                    new Kind("LeanBodyMass", HC + "READ_LEAN_BODY_MASS", "Lean body mass"),
                    new Kind("BoneMass", HC + "READ_BONE_MASS", "Bone mass"),
                    new Kind(
                            "BasalMetabolicRate",
                            HC + "READ_BASAL_METABOLIC_RATE",
                            "Basal metabolic rate (resting energy)"),
                    new Kind("Height", HC + "READ_HEIGHT", "Height"),
                    new Kind(
                            "TotalCaloriesBurned",
                            HC + "READ_TOTAL_CALORIES_BURNED",
                            "Total energy"),
                    new Kind("HeartRate", HC + "READ_HEART_RATE", "Heart rate"),
                    new Kind("OxygenSaturation", HC + "READ_OXYGEN_SATURATION", "Blood oxygen"),
                    new Kind("RespiratoryRate", HC + "READ_RESPIRATORY_RATE", "Respiratory rate"),
                    new Kind("BodyTemperature", HC + "READ_BODY_TEMPERATURE", "Body temperature"),
                    new Kind("SkinTemperature", HC + "READ_SKIN_TEMPERATURE", "Skin temperature"),
                    new Kind("Vo2Max", HC + "READ_VO2_MAX", "VO2 max"),
                    new Kind("FloorsClimbed", HC + "READ_FLOORS_CLIMBED", "Floors climbed"),
                    new Kind("ElevationGained", HC + "READ_ELEVATION_GAINED", "Elevation gained"),
                    new Kind("Hydration", HC + "READ_HYDRATION", "Hydration"),
                    new Kind("BloodPressure", HC + "READ_BLOOD_PRESSURE", "Blood pressure"),
                    new Kind("BloodGlucose", HC + "READ_BLOOD_GLUCOSE", "Blood glucose"),
                    new Kind("Speed", HC + "READ_SPEED", "Speed"),
                    new Kind("Power", HC + "READ_POWER", "Power"),
                    new Kind("CyclingPedalingCadence", HC + "READ_EXERCISE", "Cycling cadence"),
                    new Kind("StepsCadence", HC + "READ_STEPS", "Steps cadence"));

    /** The body kinds a weighing takes, read with the window when granted. */
    static final List<String> BODY =
            List.of("Weight", "BodyFat", "LeanBodyMass", "BoneMass", "BasalMetabolicRate");

    /** Kinds read once, with the window: their records are kept and sent as raw records too. */
    static final Set<String> WINDOW_KINDS =
            Set.of(
                    "SleepSession",
                    "HeartRateVariabilityRmssd",
                    "ExerciseSession",
                    "Weight",
                    "BodyFat",
                    "LeanBodyMass",
                    "BoneMass",
                    "BasalMetabolicRate");

    /**
     * The window's kinds the server makes days from (nights and their HRV; resting energy): the
     * window lists the ids it read of each, so one deleted on the phone goes on the server too.
     */
    static final List<String> DERIVED_FROM =
            List.of("SleepSession", "HeartRateVariabilityRmssd", "BasalMetabolicRate");

    private Kinds() {}

    /** The kinds a sync reads raw, and how many optional kinds it skips for want of a grant. */
    public record Granted(List<String> read, int skipped) {}

    /** The core kinds and each optional kind whose permission is {@code granted}. */
    public static Granted of(Predicate<String> granted) {
        List<String> read = new ArrayList<>(CORE);
        int skipped = 0;
        for (Kind k : OPTIONAL) {
            if (granted.test(k.permission())) {
                read.add(k.name());
            } else {
                skipped++;
            }
        }
        return new Granted(read, skipped);
    }

    /** The permission an optional kind needs; a core kind's is always held. */
    static String permission(String kind) {
        return OPTIONAL.stream()
                .filter(k -> k.name().equals(kind))
                .map(Kind::permission)
                .findFirst()
                .orElse(null);
    }
}
