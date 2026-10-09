package io.github.tupakkatapa.kaloriina;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ComponentName;
import android.content.Intent;
import android.content.pm.PackageManager;
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
import java.io.IOException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;

/**
 * The app's settings, built in code: the server address, which profile syncs (offered by the
 * page's link, confirmed here), Health Connect access, and the sync's status. Not exported; the
 * Health Connect privacy entry reaches it through an alias, whose extras are ignored.
 */
public final class SettingsActivity extends Activity {
    static final String EXTRA_PROFILE = "profile";
    private static final String ALIAS = ".ViewPermissionUsageActivity";
    private static final int GRANT = 1;
    private static final String PRIVACY = "Kaloriina reads your active energy, steps, sleep, heart rate"
            + " and workouts from Health Connect, and sends each day's totals, your nights and"
            + " your workouts to your own"
            + " Kaloriina server only. It writes nothing to Health Connect.";

    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private Store store;
    private LinearLayout root;
    private boolean viaAlias;
    /** The profile the page's link named, 0 when none (or not yet confirmed). */
    private long incoming;

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
        scroll.setOnApplyWindowInsetsListener((v, insets) -> {
            Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime());
            int pad = dp(16);
            v.setPadding(bars.left + pad, bars.top + pad, bars.right + pad, bars.bottom + pad);
            return WindowInsets.CONSUMED;
        });
        setContentView(scroll);
    }

    @Override
    protected void onResume() {
        super.onResume();
        render();
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
        TextView t = new TextView(this);
        t.setText(s);
        t.setPadding(0, dp(4), 0, dp(4));
        root.addView(t);
        return t;
    }

    private void heading(String s) {
        TextView t = text(s);
        t.setTextSize(20);
        t.setPadding(0, dp(16), 0, dp(4));
    }

    private Button button(String label, View.OnClickListener onClick) {
        Button b = new Button(this);
        b.setText(label);
        b.setOnClickListener(onClick);
        root.addView(b);
        return b;
    }

    private void toast(String s) {
        Toast.makeText(this, s, Toast.LENGTH_LONG).show();
    }

    private boolean granted(String permission) {
        return checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED;
    }

    private void render() {
        root.removeAllViews();
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
            return;
        }
        profile();
        health();
        status();
    }

    /** Check the address answers as Kaloriina, keep it, and open it. */
    private void saveOrigin(String text, Button save) {
        String origin = Payload.origin(text);
        if (origin == null) {
            toast("Use an https:// address");
            return;
        }
        save.setEnabled(false);
        worker.execute(() -> {
            boolean ok = Net.isKaloriina(origin);
            runOnUiThread(() -> {
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
                startActivity(new Intent(this, MainActivity.class)
                        .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_NEW_TASK));
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
            worker.execute(() -> {
                String name = null;
                try {
                    JSONObject p = Net.get(store.origin() + "/api/profiles/" + id, Net.QUICK_MS)
                            .object();
                    name = p == null ? null : p.optString("name", null);
                } catch (IOException e) {
                    name = null;
                }
                String found = name;
                runOnUiThread(() -> {
                    if (found == null) {
                        confirm.setText("Profile " + id + " isn't on the server");
                        return;
                    }
                    confirm.setText("Sync this profile (" + found + ")");
                    confirm.setEnabled(true);
                    confirm.setOnClickListener(v -> {
                        store.bind(id, found);
                        incoming = 0;
                        SyncJob.schedule(this);
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
        for (String p : SyncJob.ALL) {
            text(label(p) + ": " + (granted(p) ? "granted" : "not granted"));
        }
        button("Grant", v -> requestPermissions(SyncJob.ALL, GRANT));
        button("Open Health Connect", v -> {
            try {
                startActivity(new Intent(HealthConnectManager.ACTION_MANAGE_HEALTH_PERMISSIONS)
                        .putExtra(Intent.EXTRA_PACKAGE_NAME, getPackageName()));
            } catch (ActivityNotFoundException e) {
                toast("Health Connect isn't available");
            }
        });
    }

    private static String label(String permission) {
        return switch (permission) {
            case HealthPermissions.READ_ACTIVE_CALORIES_BURNED -> "Active energy";
            case HealthPermissions.READ_STEPS -> "Steps";
            case HealthPermissions.READ_EXERCISE -> "Workouts";
            case HealthPermissions.READ_SLEEP -> "Sleep";
            case HealthPermissions.READ_RESTING_HEART_RATE -> "Resting heart rate";
            case HealthPermissions.READ_HEART_RATE_VARIABILITY -> "Heart rate variability";
            case HealthPermissions.READ_DISTANCE -> "Distance";
            case HealthPermissions.READ_HEALTH_DATA_IN_BACKGROUND -> "In the background";
            default -> "Past data (over 30 days)";
        };
    }

    private void status() {
        heading("Sync");
        long at = store.lastOkAt();
        text(at == 0 ? "Not synced yet"
                : "Last sync " + DateUtils.getRelativeTimeSpanString(at) + ": "
                        + store.lastCounts());
        if (!store.lastError().isEmpty()) {
            text("Last problem: " + store.lastError());
        }
        if (store.profile() == 0) {
            return;
        }
        button("Sync now", v -> {
            SyncJob.runNow(this, 0);
            toast("Syncing");
        });
        Button resync = button("Resync " + Payload.RESYNC_DAYS + " days", v -> {
            SyncJob.runNow(this, Payload.RESYNC_DAYS);
            toast("Resyncing " + Payload.RESYNC_DAYS + " days");
        });
        resync.setEnabled(granted(HealthPermissions.READ_HEALTH_DATA_HISTORY));
        button("Stop syncing", v -> {
            SyncJob.stop(this);
            store.unbind();
            render();
        });
    }
}
