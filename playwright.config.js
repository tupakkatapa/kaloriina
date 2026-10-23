import { defineConfig, devices } from "@playwright/test";

// PORT lets two runs (say, two spec files at once) use servers of their own.
const port = process.env.PORT ?? "8091";
// Let `context.route` see a service worker's requests (Chromium): the
// offline spec plays a login proxy behind the worker. Without a worker
// (every other spec) it changes nothing.
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = "1";
// The perf spec (KALORIINA_PERF=1) times a release server, as deployed.
const profile = process.env.KALORIINA_PERF ? " --release" : "";

export default defineConfig({
  testDir: "./tests",
  testMatch: "*.spec.js",
  fullyParallel: true,
  forbidOnly: true,
  retries: 0,
  // Retries keep traces, but a test that only passes on retry still fails.
  failOnFlakyTests: true,
  workers: process.env.CI ? 1 : undefined,
  reporter: "line",
  use: {
    baseURL: `http://localhost:${port}`,
    trace: "on-first-retry",
    // Assertions spell numbers and dates; pin how the browser writes them.
    locale: "en-US",
    timezoneId: "Europe/Helsinki",
    // A service worker would answer from its cache across tests; only the
    // offline spec's own tests turn it on.
    serviceWorkers: "block",
    // Reminders off: the evening check-in would open over any test run
    // after 18:00. Their own specs turn them on.
    storageState: {
      cookies: [],
      origins: [
        {
          origin: `http://localhost:${port}`,
          localStorage: [{ name: "reminders", value: "false" }],
        },
      ],
    },
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "mobile-chromium",
      use: {
        ...devices["Pixel 5"],
        hasTouch: true,
      },
    },
    // Firefox and WebKit disabled for NixOS compatibility
  ],
  webServer: {
    // Fresh in-memory database per run; Open Food Facts unreachable on purpose.
    command: `RUST_LOG=warn cargo run -q${profile} -- serve --db :memory: --port ${port} --off-url http://127.0.0.1:9`,
    url: `http://localhost:${port}`,
    // Never reuse: tests write data, and a stale server makes reruns fail.
    reuseExistingServer: false,
    // A release build from scratch takes minutes.
    timeout: profile ? 900_000 : 120_000,
  },
});
