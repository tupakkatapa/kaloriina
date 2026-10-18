package io.github.tupakkatapa.kaloriina;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.ComponentName;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.graphics.Insets;
import android.health.connect.HealthConnectManager;
import android.health.connect.HealthPermissions;
import android.os.Bundle;
import android.text.InputType;
import android.text.format.DateUtils;
import android.view.View;
import android.view.WindowInsets;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.IOException;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * The app's settings, built in code: the server address, which profile syncs (offered by the page's
 * link, confirmed here), Health Connect access, and the sync's status. Not exported; the Health
 * Connect privacy entry reaches it through an alias, whose extras are ignored.
 */
public final class SettingsActivity extends Activity {
    static final String EXTRA_PROFILE = "profile";
    private static final String ALIAS = ".ViewPermissionUsageActivity";
    private static final int GRANT = 1;
    private static final String PRIVACY =
            "Kaloriina reads your active energy, steps, sleep, heart rate and exercise sessions"
                + " from Health Connect, and sends each day's totals, your nights and your exercise"
                + " sessions to your own Kaloriina server only. It writes nothing to Health"
                + " Connect.";

    /** Needed for every sync (background access for the periodic one); the rest are optional. */
    private static final List<String> REQUIRED = required();

    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private Store store;
    private LinearLayout root;

    /** The sync's status, redrawn whenever a run changes it. */
    private LinearLayout statusBox;

    /** Whether every permission is listed, not only those needed and missing. */
    private boolean showAll;

    /** Kept here: the store holds its listeners weakly. */
    private final SharedPreferences.OnSharedPreferenceChangeListener changed =
            (prefs, key) -> {
                if (statusBox != null) {
                    status();
                }
            };

    private boolean viaAlias;

    /** The profile the page's link named, 0 when none (or not yet confirmed). */
    private long incoming;

    /** Health Connect's home screen (framework, Android 14+). */
    private static final String HEALTH_HOME = "android.health.connect.action.HEALTH_HOME_SETTINGS";

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        store = new Store(this);
        ComponentName came = getIntent().getComponent();
        viaAlias = came != null && came.getClassName().endsWith(ALIAS);
        incoming = viaAlias ? 0 : getIntent().getLongExtra(EXTRA_PROFILE, 0);
        root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        ScrollView scroll = new ScrollView(this);
        scroll.addView(root);
        scroll.setOnApplyWindowInsetsListener(
                (v, insets) -> {
                    Insets bars =
                            insets.getInsets(
                                    WindowInsets.Type.systemBars() | WindowInsets.Type.ime());
                    int pad = dp(16);
                    v.setPadding(
                            bars.left + pad, bars.top + pad, bars.right + pad, bars.bottom + pad);
                    return WindowInsets.CONSUMED;
                });
        setContentView(scroll);
    }

    @Override
    protected void onResume() {
        super.onResume();
        store.listen(changed);
        render();
    }

    @Override
    protected void onPause() {
        store.unlisten(changed);
        super.onPause();
    }

    private static List<String> required() {
        List<String> out = new ArrayList<>(List.of(SyncJob.READ));
        out.add(HealthPermissions.READ_HEALTH_DATA_IN_BACKGROUND);
        return List.copyOf(out);
    }

    @Override
    protected void onDestroy() {
        worker.shutdownNow();
        super.onDestroy();
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
        render();
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private TextView text(String s) {
        return text(root, s);
    }

    private TextView text(LinearLayout into, String s) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setPadding(0, dp(4), 0, dp(4));
        into.addView(t);
        return t;
    }

    private void heading(String s) {
        TextView t = text(s);
        t.setTextSize(20);
        t.setPadding(0, dp(16), 0, dp(4));
    }

    private Button button(String label, View.OnClickListener onClick) {
        return button(root, label, onClick);
    }

    private Button button(LinearLayout into, String label, View.OnClickListener onClick) {
        Button b = new Button(this);
        b.setText(label);
        b.setOnClickListener(onClick);
        into.addView(b);
        return b;
    }

    /** Ask before {@code then}: {@code title}, {@code message}, and the button that goes ahead. */
    private void confirm(String title, String message, String yes, Runnable then) {
        new AlertDialog.Builder(this)
                .setTitle(title)
                .setMessage(message)
                .setPositiveButton(yes, (d, w) -> then.run())
                .setNegativeButton("Cancel", null)
                .show();
    }

    private void toast(String s) {
        Toast.makeText(this, s, Toast.LENGTH_LONG).show();
    }

    private boolean granted(String permission) {
        return checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED;
    }

    private void render() {
        root.removeAllViews();
        statusBox = null;
        if (viaAlias) {
            text(PRIVACY);
        }
        heading("Server");
        EditText address = new EditText(this);
        address.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        address.setSingleLine(true);
        address.setContentDescription("Server address");
        // No default: a build is generic, so no one deployment is prefilled.
        address.setHint("https://kaloriina.example");
        if (store.origin() != null) {
            address.setText(store.origin());
        }
        root.addView(address);
        Button save = button("Save address", null);
        save.setOnClickListener(v -> saveOrigin(address.getText().toString(), save));
        if (store.origin() == null) {
            text("Enter your Kaloriina server's address (https only).");
            version();
            return;
        }
        profile();
        health();
        heading("Sync");
        statusBox = new LinearLayout(this);
        statusBox.setOrientation(LinearLayout.VERTICAL);
        root.addView(statusBox);
        status();
        version();
    }

    /**
     * The build and its signer, as Android installed them: "0.2.0+abc1234 (1234567) · signed
     * f90abd90", so a bug report names its commit and an update refused as "App not installed" can
     * be checked against android/signer.sha256.
     */
    private void version() {
        heading("About");
        try {
            PackageInfo info =
                    getPackageManager()
                            .getPackageInfo(
                                    getPackageName(),
                                    PackageManager.PackageInfoFlags.of(
                                            PackageManager.GET_SIGNING_CERTIFICATES));
            String line = info.versionName + " (" + info.getLongVersionCode() + ")";
            Signature[] signers =
                    info.signingInfo == null
                            ? new Signature[0]
                            : info.signingInfo.getApkContentsSigners();
            if (signers.length > 0) {
                byte[] digest =
                        MessageDigest.getInstance("SHA-256").digest(signers[0].toByteArray());
                StringBuilder hex = new StringBuilder();
                for (int i = 0; i < 4; i++) {
                    hex.append(String.format("%02x", digest[i]));
                }
                line += " · signed " + hex;
            }
            text(line);
        } catch (PackageManager.NameNotFoundException | NoSuchAlgorithmException e) {
            text("Version unknown");
        }
    }

    /** Check the address answers as Kaloriina, keep it, and open it. */
    private void saveOrigin(String text, Button save) {
        String origin = Payload.origin(text);
        if (origin == null) {
            toast("Use an https:// address");
            return;
        }
        save.setEnabled(false);
        worker.execute(
                () -> {
                    boolean ok = Net.isKaloriina(origin);
                    runOnUiThread(
                            () -> {
                                save.setEnabled(true);
                                if (!ok) {
                                    toast("No Kaloriina answers at " + origin);
                                    return;
                                }
                                if (!origin.equals(store.origin())) {
                                    // Profile ids belong to a server.
                                    SyncJob.stop(this);
                                    store.unbind();
                                    store.origin(origin);
                                }
                                startActivity(
                                        new Intent(this, MainActivity.class)
                                                .addFlags(
                                                        Intent.FLAG_ACTIVITY_CLEAR_TOP
                                                                | Intent.FLAG_ACTIVITY_NEW_TASK));
                                finish();
                            });
                });
    }

    private void profile() {
        heading("Profile");
        if (incoming != 0 && incoming != store.profile()) {
            long id = incoming;
            Button confirm = button("Checking profile " + id + "…", null);
            confirm.setEnabled(false);
            worker.execute(
                    () -> {
                        String name = null;
                        try {
                            JSONObject p =
                                    Net.get(store.origin() + "/api/profiles/" + id, Net.QUICK_MS)
                                            .object();
                            name = p == null ? null : p.optString("name", null);
                        } catch (IOException e) {
                            name = null;
                        }
                        String found = name;
                        runOnUiThread(
                                () -> {
                                    if (found == null) {
                                        confirm.setText("Profile " + id + " isn't on the server");
                                        return;
                                    }
                                    confirm.setText("Sync this profile (" + found + ")");
                                    confirm.setEnabled(true);
                                    confirm.setOnClickListener(
                                            v -> {
                                                store.bind(id, found);
                                                incoming = 0;
                                                try {
                                                    SyncJob.schedule(this);
                                                    SyncJob.runNow(this, 0);
                                                } catch (RuntimeException e) {
                                                    toast(
                                                            "Couldn't schedule the sync: "
                                                                    + e.getMessage());
                                                }
                                                render();
                                            });
                                });
                    });
        }
        if (store.profile() != 0) {
            text("Syncing " + store.profileName() + " (" + store.profile() + ")");
        } else if (incoming == 0) {
            text("Open Profile → Connections → App settings in Kaloriina to choose a profile.");
        }
    }

    private void health() {
        heading("Health Connect");
        long required = REQUIRED.stream().filter(this::granted).count();
        long optional =
                List.of(SyncJob.ALL).stream()
                        .filter(p -> !REQUIRED.contains(p) && granted(p))
                        .count();
        text(
                "Required: "
                        + required
                        + " of "
                        + REQUIRED.size()
                        + " granted · Optional: "
                        + optional
                        + " of "
                        + (SyncJob.ALL.length - REQUIRED.size())
                        + " granted");
        for (String p : SyncJob.ALL) {
            boolean missing = REQUIRED.contains(p) && !granted(p);
            if (showAll || missing) {
                text(
                        label(p)
                                + (REQUIRED.contains(p) ? "" : " (optional)")
                                + ": "
                                + (granted(p) ? "granted" : "not granted"));
            }
        }
        button(
                showAll ? "Hide the list" : "Show every permission",
                v -> {
                    showAll = !showAll;
                    render();
                });
        button("Grant", v -> requestPermissions(SyncJob.ALL, GRANT));
        // Health Connect's own home first (its action isn't in the public
        // SDK), then this app's permission page; either may refuse a third-party
        // caller (SecurityException), which must not crash the app.
        button(
                "Open Health Connect",
                v -> {
                    for (Intent intent :
                            new Intent[] {
                                new Intent(HEALTH_HOME),
                                new Intent(HealthConnectManager.ACTION_MANAGE_HEALTH_PERMISSIONS)
                                        .putExtra(Intent.EXTRA_PACKAGE_NAME, getPackageName()),
                            }) {
                        try {
                            startActivity(intent);
                            return;
                        } catch (ActivityNotFoundException | SecurityException e) {
                            // Try the next one.
                        }
                    }
                    toast("Health Connect isn't available");
                });
    }

    private static String label(String permission) {
        return switch (permission) {
            case HealthPermissions.READ_ACTIVE_CALORIES_BURNED -> "Active energy";
            case HealthPermissions.READ_STEPS -> "Steps";
            case HealthPermissions.READ_EXERCISE -> "Exercise sessions";
            case HealthPermissions.READ_SLEEP -> "Sleep";
            case HealthPermissions.READ_RESTING_HEART_RATE -> "Resting heart rate";
            case HealthPermissions.READ_HEART_RATE_VARIABILITY -> "Heart rate variability";
            case HealthPermissions.READ_DISTANCE -> "Distance";
            case HealthPermissions.READ_HEALTH_DATA_IN_BACKGROUND -> "In the background";
            case HealthPermissions.READ_HEALTH_DATA_HISTORY -> "Past data (over 30 days)";
            default ->
                    Kinds.OPTIONAL.stream()
                            .filter(k -> k.permission().equals(permission))
                            .map(Kinds.Kind::label)
                            .findFirst()
                            .orElse(permission);
        };
    }

    /** The last run's result, redrawn when a run ends; the sync's buttons. */
    private void status() {
        statusBox.removeAllViews();
        long at = store.lastOkAt();
        text(
                statusBox,
                at == 0
                        ? "Not synced yet"
                        : "Last sync "
                                + DateUtils.getRelativeTimeSpanString(at)
                                + ": "
                                + store.lastCounts());
        if (!store.note().isEmpty()) {
            text(statusBox, store.note());
        }
        if (!store.lastError().isEmpty()) {
            text(statusBox, "Last problem: " + store.lastError());
        }
        if (store.profile() == 0) {
            return;
        }
        button(
                statusBox,
                "Sync now",
                v -> {
                    SyncJob.runNow(this, 0);
                    toast("Syncing: the result shows here");
                });
        boolean history = granted(HealthPermissions.READ_HEALTH_DATA_HISTORY);
        button(
                        statusBox,
                        "Resync " + Payload.RESYNC_DAYS + " days",
                        v -> resync(Payload.RESYNC_DAYS + " days", Payload.RESYNC_DAYS))
                .setEnabled(history);
        button(
                        statusBox,
                        "Resync a year",
                        v ->
                                confirm(
                                        "Resync a year?",
                                        "This reads a year from Health Connect, 30 days at a time."
                                            + " It can take a while, and if it reaches Health"
                                            + " Connect's read limit it waits and resumes later.",
                                        "Resync",
                                        () -> resync("a year", Payload.RESYNC_YEAR)))
                .setEnabled(history);
        button(
                statusBox,
                "Stop syncing",
                v ->
                        confirm(
                                "Stop syncing " + store.profileName() + "?",
                                "The phone stops sending Health Connect data. What's synced stays"
                                        + " on the server.",
                                "Stop syncing",
                                () -> {
                                    SyncJob.stop(this);
                                    store.unbind();
                                    render();
                                }));
    }

    /** A resync: past data needs the history permission. */
    private void resync(String span, int days) {
        SyncJob.runNow(this, days);
        toast("Resyncing " + span);
    }
}
