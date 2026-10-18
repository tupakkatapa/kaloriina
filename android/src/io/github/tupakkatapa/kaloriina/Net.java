package io.github.tupakkatapa.kaloriina;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * Plain HTTPS to the configured origin: no cookies, no credentials (v1 works only where the network
 * is the login). Trust follows the network security config.
 */
final class Net {
    /** The probe's and a page's timeouts; a sync POST may take longer. */
    static final int QUICK_MS = 5_000;

    static final int POST_MS = 30_000;

    private Net() {}

    /** An answer: its status, body and the headers a download needs. */
    static final class Reply {
        final int code;
        final byte[] body;
        final String type;
        final String disposition;

        Reply(int code, byte[] body, String type, String disposition) {
            this.code = code;
            this.body = body;
            this.type = type == null ? "" : type;
            this.disposition = disposition;
        }

        boolean json() {
            return type.startsWith("application/json");
        }

        String text() {
            return new String(body, StandardCharsets.UTF_8);
        }

        /** The body as a JSON object, or null when it isn't one. */
        JSONObject object() {
            if (!json()) {
                return null;
            }
            try {
                return new JSONObject(text());
            } catch (JSONException e) {
                return null;
            }
        }
    }

    static Reply get(String url, int timeoutMs) throws IOException {
        return send("GET", url, null, timeoutMs);
    }

    static Reply post(String url, String json, int timeoutMs) throws IOException {
        return send("POST", url, json, timeoutMs);
    }

    private static Reply send(String method, String url, String json, int timeoutMs)
            throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        try {
            c.setRequestMethod(method);
            c.setConnectTimeout(timeoutMs);
            c.setReadTimeout(timeoutMs);
            c.setInstanceFollowRedirects(false);
            c.setUseCaches(false);
            c.setRequestProperty("Accept", "application/json");
            if (json != null) {
                byte[] bytes = json.getBytes(StandardCharsets.UTF_8);
                c.setDoOutput(true);
                c.setFixedLengthStreamingMode(bytes.length);
                c.setRequestProperty("Content-Type", "application/json");
                try (OutputStream out = c.getOutputStream()) {
                    out.write(bytes);
                }
            }
            int code = c.getResponseCode();
            InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
            byte[] body = new byte[0];
            if (in != null) {
                try (InputStream s = in;
                        ByteArrayOutputStream buf = new ByteArrayOutputStream()) {
                    s.transferTo(buf);
                    body = buf.toByteArray();
                }
            }
            return new Reply(
                    code, body, c.getContentType(), c.getHeaderField("Content-Disposition"));
        } finally {
            c.disconnect();
        }
    }

    /** Whether Kaloriina answers at {@code origin}: {@code /api/meta} is JSON with its limits. */
    static boolean isKaloriina(String origin) {
        try {
            JSONObject meta = get(origin + "/api/meta", QUICK_MS).object();
            return meta != null && meta.has("limits");
        } catch (IOException e) {
            return false;
        }
    }
}
