# Kaloriina

Got tired of juggling a calorie counter, a workout log, a habit tracker, a sleep app and a scale app, each with its own account, ads and idea of what my data is worth. So here is one self-hosted food, training and health diary for all of it.

One Rust binary, one SQLite file, built for a phone browser.

## Features

- **Diary**: Planned and Eaten food against your targets, the night's sleep, the day's distance, steps and activities, and a log for weight, habits and check-ins
- **Foods**: your own foods, recipes and meals, ~4,200 Finnish foods from [Fineli](https://fineli.fi) and barcodes from [Open Food Facts](https://world.openfoodfacts.org), each rated Healthy, OK or Unhealthy
- **Targets**: energy, macros, nutrients, body, steps, sleep and habits, recommended from your body
- **Summary**: a week, month or year of Food, Body, Activity and Habits, with highlights, All time and Records
- **Activity**: every type with its own view and cardio load, workouts with a run screen, 273 exercises with history and bests
- **Energy**: maintenance learned from what you ate and your weight trend
- **Honest numbers**: `≈` an estimate, `≥` a floor, `–` unknown, and every tile says what it counts
- **Connections**: Health Connect through the [Android app](#android), [openScale](#openscale), [Google Health](#google-health) and [Home Assistant](#home-assistant)
- Several profiles, offline logging, and Metric or US units

## Getting Started

Try it and open <http://127.0.0.1:8080>:

```bash
nix run github:tupakkatapa/kaloriina -- serve --db ./kaloriina.db
```

On NixOS, add this repository as a flake input and enable the module:

```nix
{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    kaloriina.url = "github:tupakkatapa/kaloriina";
  };

  outputs = { nixpkgs, kaloriina, ... }: {
    nixosConfigurations.yourhostname = nixpkgs.lib.nixosSystem {
      system = "x86_64-linux";
      modules = [
        ./configuration.nix
        kaloriina.nixosModules.default
        {
          services.kaloriina = {
            enable = true;
            allowedHosts = [ "kaloriina.example.ts.net" ]; # the host your HTTPS proxy forwards
            timeZone = "Europe/Helsinki";
            # Optional: import a pinned Fineli package, again only when it changes
            fineli = {
              enable = true;
              source = "${./fineli}";
            };
            # Optional: a profile's Home Assistant hook, the id read at runtime
            hooks.Anna = {
              url = "http://homeassistant.lan:8123";
              webhookIdFile = "/run/agenix/kaloriina-ha-anna";
              events = [ "workout_started" "workout_finished" ];
            };
          };
        }
      ];
    };
  };
}
```

Nightly backups are on by default. See [`module.nix`](module.nix) for every option. A new database has one profile: fill it in under the last tab, then Targets → Recalculate targets.

## Security

There is no login. Keep it on `127.0.0.1` behind an HTTPS proxy that does the login, e.g. `tailscale serve` with a tailnet ACL or Caddy with `basic_auth`, name the proxy's host in `allowedHosts` and pass the `Host` header through. Profiles have no passwords and the Android app sends none, so serve it where the network is the login. Anyone who can open the app sees every profile, and can make the server call an address on your network through a Home Assistant hook.

## Imports

Every command has `--help`. `--db` defaults to `KALORIINA_DB`, else `kaloriina.db` in the current folder. On NixOS, `sudo kaloriina <command> …` works on the service's database as the service user, so the files you pass must be readable by it.

### Fineli

Download the open-data package from [fineli.fi](https://fineli.fi), unzip it and run `kaloriina fineli --db kaloriina.db ./fineli`, or pin it with `services.kaloriina.fineli`.

### Cronometer

Profile → Import from Cronometer, or `kaloriina import --db kaloriina.db --servings servings.csv --summary dailysummary.csv`.

### Google Health

Export Google Health from [Google Takeout](https://takeout.google.com), then Profile → Connections → Google Health, or `kaloriina import-google-health --db kaloriina.db --time-zone Europe/Helsinki ./Takeout`.

### Loop Habit Tracker

In Loop, Settings → Export full backup, copy the `.db` file off the phone, then `kaloriina import-loop-habits --db kaloriina.db Loop.db`. Each habit becomes a tracker under Habits; days you already counted here stay.

## Android

A WebView shell around the app that syncs Health Connect every two hours on Wi-Fi. It needs Android 15 or newer.

```bash
# Once: a signing key with the alias kaloriina; keep it, an update needs the same key
nix shell nixpkgs#jdk17_headless -c keytool -genkeypair -keystore ~/.android/kaloriina.jks \
  -alias kaloriina -keyalg RSA -keysize 4096 -validity 36500

# Build and sign; with your own key, put the digest it prints in android/signer.sha256 and run again
nix run .#sign-apk -- ~/.android/kaloriina.jks kaloriina.apk
adb install -r kaloriina.apk
```

Empty Chrome's outbox (`#/outbox`) first. Open the app, save your server's `https://` address, then Profile → Connections → App settings → Sync this profile → Grant.

## openScale

1. Install openScale sync next to [openScale](https://github.com/oliexdev/openScale)
2. Copy the webhook URL from Profile → Connections into openScale sync's Webhook
3. Weigh yourself, press Use beside your openScale user, then run a full sync

Each day's weight is its first reading after you woke.

## Home Assistant

1. Create an automation with a Webhook trigger
2. Enter Home Assistant's address and the webhook id in Profile → Connections → Home Assistant, or set `services.kaloriina.hooks`
3. Press Send test

It gets a `POST` to `{address}/api/webhook/{id}` with `{event, profile, workout, at}` when a workout starts or finishes.

## Backups

The module copies the database to `/var/lib/kaloriina/backups` every night, compressed with zstd, and keeps the newest 14. To restore one:

```bash
sudo systemctl stop kaloriina
sudo zstd -d /var/lib/kaloriina/backups/kaloriina-<time>.db.zst -o /tmp/kaloriina.db
sudo install -o kaloriina -g kaloriina -m 0600 /tmp/kaloriina.db /var/lib/kaloriina/kaloriina.db
sudo rm -f /var/lib/kaloriina/kaloriina.db-wal /var/lib/kaloriina/kaloriina.db-shm
sudo systemctl start kaloriina
```

An upgrade saves `kaloriina.db.pre-v<N>` before migrating. To undo one, put that copy in place the same way (it isn't compressed: skip `zstd`), but run `sudo nixos-rebuild switch --rollback` instead of the last line.

## Contributing

```bash
nix develop        # Enter dev shell (or use direnv)
nix flake check    # Tests, lints, the NixOS VM tests and the Android checks
playwright test    # Browser tests
```

Pre-commit runs treefmt, oxlint, clippy, the tests and Playwright.

## Licence

GPL-3.0-or-later. Bundles [Chart.js](https://www.chartjs.org) (MIT). Fineli data is © THL (CC BY 4.0); Open Food Facts data is ODbL.
