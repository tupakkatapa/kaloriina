package io.github.tupakkatapa.kaloriina;

import android.Manifest;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ContentValues;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Bundle;
import android.provider.MediaStore;
import android.view.WindowInsets;
import android.webkit.PermissionRequest;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;
import android.window.OnBackInvokedDispatcher;

import java.io.IOException;
import java.io.OutputStream;
import java.util.Arrays;

/**
 * Kaloriina full screen in a WebView, locked to the configured origin. The page gets no native API;
 * a {@code kaloriina-app://settings?profile=N} link it shows opens the settings, and {@code
 * kaloriina-app://sync} (its pull to refresh) runs a sync now, answered with a {@code
 * kaloriina-sync} event when the run ends.
 */
public final class MainActivity extends Activity {
    private static final String SCHEME = "kaloriina-app";
    private static final int FILES = 1;
    private static final int CAMERA = 2;

    private WebView web;
    private String origin;
    private ValueCallback<Uri[]> files;
    private PermissionRequest camera;

    /** Kept here: the store holds its listeners weakly. */
    private final SharedPreferences.OnSharedPreferenceChangeListener syncEnded = this::onSyncEnded;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        Store store = new Store(this);
        origin = store.origin();
        if (origin == null) {
            startActivity(new Intent(this, SettingsActivity.class));
            finish();
            return;
        }
        web = new WebView(this);
        FrameLayout root = new FrameLayout(this);
        root.addView(web);
        // targetSdk 35 is edge to edge: keep the page off the system bars and the keyboard.
        root.setOnApplyWindowInsetsListener(
                (v, insets) -> {
                    Insets bars =
                            insets.getInsets(
                                    WindowInsets.Type.systemBars() | WindowInsets.Type.ime());
                    v.setPadding(bars.left, bars.top, bars.right, bars.bottom);
                    return WindowInsets.CONSUMED;
                });
        setContentView(root);
        configure(web.getSettings());
        web.setWebViewClient(new Lock());
        web.setWebChromeClient(new Chrome());
        web.setDownloadListener((url, agent, disposition, mime, length) -> download(url));
        getOnBackInvokedDispatcher()
                .registerOnBackInvokedCallback(
                        OnBackInvokedDispatcher.PRIORITY_DEFAULT,
                        () -> {
                            if (web.canGoBack()) {
                                web.goBack();
                            } else {
                                finish();
                            }
                        });
        if (state == null || web.restoreState(state) == null) {
            web.loadUrl(origin + "/");
        }
        if (store.profile() != 0) {
            SyncJob.schedule(this);
        }
    }

    private static void configure(WebSettings s) {
        s.setJavaScriptEnabled(true);
        // localStorage: the profile choice and the offline outbox live there.
        s.setDomStorageEnabled(true);
        // The scanner starts its video after an await, without a gesture.
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setSupportMultipleWindows(false);
        s.setUserAgentString(s.getUserAgentString() + " KaloriinaAndroid/1");
    }

    @Override
    protected void onResume() {
        super.onResume();
        Store store = new Store(this);
        boolean stale = System.currentTimeMillis() - store.lastOkAt() > SyncJob.STALE.toMillis();
        if (web != null && store.profile() != 0 && stale && !SyncJob.pending(this)) {
            SyncJob.runNow(this, 0);
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        if (web != null) {
            web.saveState(out);
        }
    }

    @Override
    protected void onDestroy() {
        new Store(this).unlisten(syncEnded);
        if (web != null) {
            web.destroy();
        }
        super.onDestroy();
    }

    private boolean here(String url) {
        return origin.equals(Payload.origin(url));
    }

    /**
     * The configured origin loads here; http(s) elsewhere opens the browser; the rest is blocked.
     */
    private final class Lock extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri url = request.getUrl();
            if (here(url.toString())) {
                return false;
            }
            if (!request.isForMainFrame()) {
                return true;
            }
            String scheme = url.getScheme() == null ? "" : url.getScheme();
            if (SCHEME.equals(scheme)) {
                if (!here(view.getUrl())) {
                    return true;
                }
                if (request.hasGesture() && "settings".equals(url.getHost())) {
                    settings(Payload.profileId(url.getQueryParameter("profile")));
                } else if ("sync".equals(url.getHost())) {
                    syncNow();
                }
                return true;
            }
            if ("http".equals(scheme) || "https".equals(scheme)) {
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, url));
                } catch (ActivityNotFoundException e) {
                    toast("No browser to open " + url.getHost());
                }
            }
            return true;
        }
    }

    /**
     * The page's pull to refresh: a sync now, as Settings' "Sync now" (it replaces one waiting to
     * retry), answered when a run ends. No gesture needed: it comes after the page sent its outbox,
     * and a sync starts unasked on resume anyway.
     */
    private void syncNow() {
        Store store = new Store(this);
        if (store.profile() == 0) {
            answer(store, false);
            return;
        }
        store.listen(syncEnded);
        SyncJob.runNow(this, 0);
    }

    private void onSyncEnded(SharedPreferences prefs, String key) {
        if (Store.RUN_ENDED.equals(key)) {
            Store store = new Store(this);
            store.unlisten(syncEnded);
            answer(store, true);
        }
    }

    /** Only to the configured origin's page: the status may name the server's errors. */
    private void answer(Store store, boolean bound) {
        if (web != null && here(web.getUrl())) {
            web.evaluateJavascript(Payload.syncEvent(bound, store.lastError(), store.note()), null);
        }
    }

    private void settings(Long profile) {
        Intent intent = new Intent(this, SettingsActivity.class);
        if (profile != null) {
            intent.putExtra(SettingsActivity.EXTRA_PROFILE, profile.longValue());
        }
        startActivity(intent);
    }

    /** The camera for the scanner (this origin only), and the file picker for imports. */
    private final class Chrome extends WebChromeClient {
        @Override
        public void onPermissionRequest(PermissionRequest request) {
            boolean video =
                    Arrays.asList(request.getResources())
                            .contains(PermissionRequest.RESOURCE_VIDEO_CAPTURE);
            if (!video || !here(request.getOrigin().toString())) {
                request.deny();
            } else if (checkSelfPermission(Manifest.permission.CAMERA)
                    == PackageManager.PERMISSION_GRANTED) {
                request.grant(new String[] {PermissionRequest.RESOURCE_VIDEO_CAPTURE});
            } else {
                if (camera != null) {
                    camera.deny();
                }
                camera = request;
                requestPermissions(new String[] {Manifest.permission.CAMERA}, CAMERA);
            }
        }

        @Override
        public boolean onShowFileChooser(
                WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
            if (files != null) {
                files.onReceiveValue(null);
            }
            files = callback;
            try {
                startActivityForResult(params.createIntent(), FILES);
            } catch (ActivityNotFoundException e) {
                files.onReceiveValue(null);
                files = null;
            }
            return true;
        }
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
        if (code != CAMERA || camera == null) {
            return;
        }
        if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) {
            camera.grant(new String[] {PermissionRequest.RESOURCE_VIDEO_CAPTURE});
        } else {
            camera.deny();
        }
        camera = null;
    }

    @Override
    protected void onActivityResult(int code, int result, Intent data) {
        if (code != FILES || files == null) {
            return;
        }
        // Always answered, null on cancel, or the page's input never fires again.
        files.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result, data));
        files = null;
    }

    private void toast(String s) {
        runOnUiThread(() -> Toast.makeText(this, s, Toast.LENGTH_LONG).show());
    }

    /**
     * Save a same-origin download (the profile export) to Downloads. Fetched here rather than by
     * the system's DownloadManager, which runs elsewhere and wouldn't trust a user CA.
     */
    private void download(String url) {
        if (!here(url)) {
            toast("Can't save this file here");
            return;
        }
        new Thread(
                        () -> {
                            try {
                                Net.Reply reply = Net.get(url, Net.POST_MS);
                                if (reply.code != 200) {
                                    toast("Couldn't download: HTTP " + reply.code);
                                    return;
                                }
                                String name =
                                        URLUtil.guessFileName(url, reply.disposition, reply.type);
                                ContentValues values = new ContentValues();
                                values.put(MediaStore.Downloads.DISPLAY_NAME, name);
                                values.put(MediaStore.Downloads.MIME_TYPE, reply.type);
                                Uri saved =
                                        getContentResolver()
                                                .insert(
                                                        MediaStore.Downloads.EXTERNAL_CONTENT_URI,
                                                        values);
                                if (saved == null) {
                                    throw new IOException("Downloads refused the file");
                                }
                                try (OutputStream out =
                                        getContentResolver().openOutputStream(saved)) {
                                    if (out == null) {
                                        throw new IOException("Downloads refused the file");
                                    }
                                    out.write(reply.body);
                                }
                                toast("Saved to Downloads: " + name);
                            } catch (IOException e) {
                                toast("Couldn't download: " + e.getMessage());
                            }
                        })
                .start();
    }
}
