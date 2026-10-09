package io.github.tupakkatapa.kaloriina;

import android.content.Context;
import android.content.SharedPreferences;

/** The app's own settings and sync status, private to it (never backed up). */
final class Store {
    private static final String ORIGIN = "origin";
    private static final String PROFILE = "profile_id";
    private static final String PROFILE_NAME = "profile_name";
    private static final String LAST_OK_AT = "last_ok_at";
    private static final String LAST_OK_TO = "last_ok_to";
    private static final String LAST_COUNTS = "last_counts";
    private static final String LAST_ERROR = "last_error";

    private final SharedPreferences prefs;

    Store(Context ctx) {
        prefs = ctx.getSharedPreferences("kaloriina", Context.MODE_PRIVATE);
    }

    /** The server's origin ({@code https://host[:port]}), or null before the first run. */
    String origin() {
        return prefs.getString(ORIGIN, null);
    }

    void origin(String origin) {
        prefs.edit().putString(ORIGIN, origin).apply();
    }

    /** The bound profile's id, 0 when none. */
    long profile() {
        return prefs.getLong(PROFILE, 0);
    }

    String profileName() {
        return prefs.getString(PROFILE_NAME, "");
    }

    /** Bind {@code id}; another profile than before starts its window over. */
    void bind(long id, String name) {
        prefs.edit()
                .putLong(PROFILE, id)
                .putString(PROFILE_NAME, name)
                .putString(LAST_OK_TO, Payload.lastOkAfterBind(profile(), id, lastOkTo()))
                .apply();
    }

    void unbind() {
        prefs.edit().remove(PROFILE).remove(PROFILE_NAME).remove(LAST_OK_TO).apply();
    }

    /** The last successful sync's {@code to} day, or null. */
    String lastOkTo() {
        return prefs.getString(LAST_OK_TO, null);
    }

    long lastOkAt() {
        return prefs.getLong(LAST_OK_AT, 0);
    }

    String lastCounts() {
        return prefs.getString(LAST_COUNTS, "");
    }

    String lastError() {
        return prefs.getString(LAST_ERROR, "");
    }

    void succeeded(String to, String counts, long at) {
        prefs.edit()
                .putString(LAST_OK_TO, to)
                .putLong(LAST_OK_AT, at)
                .putString(LAST_COUNTS, counts)
                .remove(LAST_ERROR)
                .apply();
    }

    void failed(String error) {
        prefs.edit().putString(LAST_ERROR, error).apply();
    }
}
