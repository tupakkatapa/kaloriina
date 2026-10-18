package io.github.tupakkatapa.kaloriina;

import android.content.Context;
import android.content.SharedPreferences;

import java.time.LocalDate;

/** The app's own settings and sync status, private to it (never backed up). */
final class Store implements Payload.Store {
    private static final String ORIGIN = "origin";
    private static final String PROFILE = "profile_id";
    private static final String PROFILE_NAME = "profile_name";
    private static final String LAST_OK_AT = "last_ok_at";
    private static final String LAST_OK_TO = "last_ok_to";
    private static final String LAST_COUNTS = "last_counts";
    private static final String LAST_ERROR = "last_error";
    private static final String NOTE = "note";
    private static final String RESYNC_NEXT = "resync_next";

    /** The key a run's end writes ({@link #ended}). */
    static final String RUN_ENDED = "run_ended";

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
        prefs.edit()
                .remove(PROFILE)
                .remove(PROFILE_NAME)
                .remove(LAST_OK_TO)
                .remove(RESYNC_NEXT)
                .apply();
    }

    /** The last successful sync's {@code to} day, or null. */
    @Override
    public String lastOkTo() {
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

    /** A window synced up to {@code to}: the last successful day never moves back. */
    @Override
    public void succeeded(LocalDate to, String counts, long at) {
        prefs.edit()
                .putString(LAST_OK_TO, Payload.lastOkTo(lastOkTo(), to))
                .putLong(LAST_OK_AT, at)
                .putString(LAST_COUNTS, counts)
                .remove(LAST_ERROR)
                .remove(NOTE)
                .apply();
    }

    @Override
    public void failed(String error) {
        prefs.edit().putString(LAST_ERROR, error).remove(NOTE).apply();
    }

    /** Why the sync waits, not a failure (Health Connect's read limit); empty when it doesn't. */
    String note() {
        return prefs.getString(NOTE, "");
    }

    @Override
    public void note(String note) {
        prefs.edit().putString(NOTE, note).apply();
    }

    /** The first day a resync has yet to send, or null when none is under way. */
    @Override
    public String resyncNext() {
        return prefs.getString(RESYNC_NEXT, null);
    }

    @Override
    public void resyncNext(String day) {
        prefs.edit().putString(RESYNC_NEXT, day).apply();
    }

    /** A sync run that wasn't stopped ended at {@code at}: what a pull to refresh waits for. */
    void ended(long at) {
        prefs.edit().putLong(RUN_ENDED, at).apply();
    }

    /** Call {@code listener} on the main thread whenever the status changes. */
    void listen(SharedPreferences.OnSharedPreferenceChangeListener listener) {
        prefs.registerOnSharedPreferenceChangeListener(listener);
    }

    void unlisten(SharedPreferences.OnSharedPreferenceChangeListener listener) {
        prefs.unregisterOnSharedPreferenceChangeListener(listener);
    }
}
