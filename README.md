# Kaloriina

> Written largely by AI, reviewed and maintained by me

Got tired of juggling a calorie counter, a workout log, a habit tracker, a sleep app and a scale app, each with its own account, ads and idea of what my data is worth. So here is one self-hosted food, training and health diary for all of it.

One Rust binary, one SQLite file, built for a phone browser.

## Features

- **Diary**: Planned and Eaten food against your targets, the night's sleep, the day's distance, steps and activities, and a log for weight, habits and check-ins
- **Foods**: your own foods and recipes, ~4,200 Finnish foods from [Fineli](https://fineli.fi) and barcodes from [Open Food Facts](https://world.openfoodfacts.org), each rated Healthy, OK or Unhealthy
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
  inputs.kaloriina.url = "github:tupakkatapa/kaloriina";
}
```

```nix
{
  imports = [ inputs.kaloriina.nixosModules.default ];
  services.kaloriina = {
    enable = true;
    allowedHosts = [ "kaloriina.example.ts.net" ]; # the host your HTTPS proxy forwards
    timeZone = "Europe/Helsinki";
  };
}
```

Then put HTTPS and a login in front of it ([Security](#security)), e.g. on the tailnet host: `sudo tailscale serve --bg 8080`. See [`module.nix`](module.nix) for every option. A new database has one profile: fill it in under the last tab, then Targets → Recalculate targets.

## Security

There is no login, and profiles have no passwords. Keep it on `127.0.0.1` behind an HTTPS proxy that does the login, name the proxy's host in `allowedHosts` and pass the `Host` header through. The Android app answers no password prompt, so with the app the network must be the login: `tailscale serve` with a tailnet ACL, say. Anyone who can open the app sees every profile, and can make the server call an address on your network through a Home Assistant hook.

## Imports

Every command has `--help`. `--db` defaults to `KALORIINA_DB`, else `kaloriina.db` in the current folder. On NixOS, `sudo kaloriina <command> …` works on the service's database as the service user, so the files you pass must be readable by it.

| Source             | How                                                                                                                                                                                    |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fineli             | Unzip the open-data package from [fineli.fi](https://fineli.fi), then `kaloriina fineli ./fineli`; or set `services.kaloriina.fineli` (`enable`, `source`), imported again on a change |
| Cronometer         | Profile → Import from Cronometer, or `kaloriina import-cronometer --servings servings.csv --summary dailysummary.csv`                                                                  |
| Loop Habit Tracker | In Loop, Settings → Export full backup, then `kaloriina import-loop-habits Loop.db`; days you already counted here stay                                                                |

### Google Health

1. In [Google Takeout](https://takeout.google.com), export Google Health as a zip
2. Profile → Connections → Google Health → Import from Google Health…, and choose every part of the export

Too big for the browser, unzip it on the server and run `kaloriina import-google-health ./Takeout` (days follow the server's time zone; before the server has run, add `--time-zone Europe/Helsinki`).

## Android

A WebView shell around the app that syncs Health Connect every two hours on Wi-Fi. It needs Android 15 or newer, a computer with Nix and `adb`, and the phone's USB debugging on.

```bash
# Once: a signing key with the alias kaloriina; keep it, an update needs the same key
nix shell nixpkgs#jdk17_headless -c keytool -genkeypair -keystore ~/.android/kaloriina.jks \
  -alias kaloriina -keyalg RSA -keysize 4096 -validity 36500

# Build and sign; with your own key, put the digest it prints in android/signer.sha256 and run again
nix run .#sign-apk -- ~/.android/kaloriina.jks kaloriina.apk
adb install -r kaloriina.apk
```

Open the app, save your server's `https://` address, then Profile → Connections → App settings → Sync this profile → Grant. If you logged offline in the phone's browser, open `#/outbox` there first and send what waits.

## openScale

1. Install openScale sync next to [openScale](https://github.com/oliexdev/openScale) (F-Droid or Google Play)
2. In openScale sync, open Webhook, turn it on and paste the URL from Profile → Connections → openScale
3. Authorization header: what your HTTPS proxy's login needs (e.g. `Basic …`), or empty; the phone must trust the proxy's certificate
4. Press Test, weigh yourself, then press Use beside your openScale user in Connections
5. Run a full sync in openScale sync to bring in your history

Each day's weight is its first reading after you woke.

## Home Assistant

1. Create an automation with a Webhook trigger
2. Enter Home Assistant's address and the webhook id in Profile → Connections → Home Assistant, or set it in the module, the id read at runtime:

   ```nix
   services.kaloriina.hooks.Anna = { # the profile's name
     url = "http://homeassistant.lan:8123";
     webhookIdFile = "/run/agenix/kaloriina-ha-anna";
     events = [ "workout_started" "workout_finished" ];
   };
   ```

3. Press Send test

It gets a `POST` to `{address}/api/webhook/{id}` with `{event, profile, workout, at}` when a workout starts or finishes.

## Agents

`kaloriina mcp` gives an agent the diary's tools over the Model Context Protocol: read days, summaries and trends, search foods, and log. It calls a running instance's API, so it needs no database; `--host` sends a name the instance allows. Days without a date go to the diary's today, which turns at 03:00.

```json
{
  "mcpServers": {
    "kaloriina": {
      "command": "kaloriina",
      "args": ["mcp", "--url", "http://127.0.0.1:8080", "--profile", "Anna"]
    }
  }
}
```

## Backups

The module copies the database to `/var/lib/kaloriina/backups` every night, compressed with zstd, and keeps the newest 14. The copies sit on the database's disk: copy them off the host for a disk failure. A copy over 48 hours old shows on the Diary.

Restore puts every profile back to the copy's time. The live file is set aside first:

```bash
sudo systemctl stop kaloriina
cd /var/lib/kaloriina
sudo mv kaloriina.db kaloriina.db.before-restore
sudo rm -f kaloriina.db-wal kaloriina.db-shm
sudo zstd -dc backups/kaloriina-<time>.db.zst | sudo install -o kaloriina -g kaloriina -m 0600 /dev/stdin kaloriina.db
sudo systemctl start kaloriina
```

<details>
<summary><b>Restore one profile</b>, the others keep everything since</summary>

Serve the copy on a spare port, export the profile, import it with `?restore=true` (its id and openScale binding are kept):

```bash
cd /var/lib/kaloriina
sudo zstd -dc backups/kaloriina-<time>.db.zst | sudo install -o kaloriina -g kaloriina -m 0600 /dev/stdin restore.db
sudo systemd-run --unit kaloriina-restore -p User=kaloriina kaloriina serve --db /var/lib/kaloriina/restore.db --port 8099
curl -o profile.json http://127.0.0.1:8099/api/profiles/<id>/export
sudo systemctl stop kaloriina-restore && sudo rm -f restore.db*
curl -H 'content-type: application/json' --data-binary @profile.json 'http://127.0.0.1:8080/api/profiles/import?restore=true'
```

Photos, the Home Assistant hook and the raw Health Connect records come back only with the whole database. So does a profile whose export is over 64 MiB, the import limit.

</details>

## Upgrading

1. Read the new version's section of [CHANGELOG.md](CHANGELOG.md): a `Breaking:` line says what to do first
2. On every phone and browser that logged offline, open `#/outbox` and send what is waiting
3. Deploy the server (`nix flake update kaloriina`, then `nixos-rebuild switch`), then the APK

A migration saves `kaloriina.db.pre-v<N>` first, N being the database version upgraded from; the newest two are kept. To undo, restore it as above without `zstd` and run `sudo nixos-rebuild switch --rollback` instead of starting the service. Everything written since the upgrade is lost. If the service fails to start after an upgrade, the migration changed nothing: the rollback alone is enough.

## Contributing

```bash
nix develop        # Enter dev shell (or use direnv)
nix flake check    # Tests, lints, the NixOS VM tests and the Android checks
playwright test    # Browser tests
```

The JSON API under `/api` is the web app's own and changes with it: scripts against it may break on any release.

## Licence

GPL-3.0-or-later. Bundles [Chart.js](https://www.chartjs.org) (MIT). Fineli data is © THL (CC BY 4.0); Open Food Facts data is ODbL.
