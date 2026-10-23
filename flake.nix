{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
    flake-parts.url = "github:hercules-ci/flake-parts";
    git-hooks.url = "github:cachix/git-hooks.nix";
    git-hooks.inputs.nixpkgs.follows = "nixpkgs";
    treefmt-nix.url = "github:numtide/treefmt-nix";
    treefmt-nix.inputs.nixpkgs.follows = "nixpkgs";
    playwright.url = "github:pietdevries94/playwright-web-flake/1.55.0";
    # RustSec's advisories, pinned: `checks.audit` reads them offline.
    advisory-db = {
      url = "github:rustsec/advisory-db";
      flake = false;
    };
  };

  outputs = { self, ... } @inputs:
    inputs.flake-parts.lib.mkFlake { inherit inputs; } {
      systems = inputs.nixpkgs.lib.systems.flakeExposed;
      imports = [
        inputs.git-hooks.flakeModule
        inputs.treefmt-nix.flakeModule
      ];

      perSystem =
        { self'
        , inputs'
        , pkgs
        , config
        , system
        , ...
        }:
        let
          # The Android companion: its APK, signing app and checks (x86_64 Linux).
          android = pkgs.lib.optionalAttrs (system == "x86_64-linux")
            (import ./nix/android.nix { inherit inputs pkgs system; });
        in
        {
          # Code formatter -> 'nix fmt'
          treefmt.config = {
            projectRootFile = "flake.nix";
            flakeFormatter = true;
            flakeCheck = true;
            programs = {
              nixpkgs-fmt.enable = true;
              deadnix.enable = true;
              statix.enable = true;
              rustfmt.enable = true;
              taplo.enable = true;
              prettier.enable = true;
              # The Android companion's Java, in AOSP's 4-space style.
              google-java-format = {
                enable = true;
                aospStyle = true;
              };
            };
            # Third-party files are kept byte-for-byte as released.
            settings.global.excludes = [ "web/vendor/*" ];
          };

          # Pre-commit hooks
          pre-commit.check.enable = false;
          pre-commit.settings.hooks = {
            treefmt = {
              enable = true;
              package = config.treefmt.build.wrapper;
            };
            node-test = {
              enable = true;
              entry = "${pkgs.nodejs}/bin/node --import ./tests/tz.mjs --test tests/*.test.mjs";
              files = "\\.(mjs|js)$";
              pass_filenames = false;
            };
            oxlint = {
              enable = true;
              entry = "${pkgs.oxlint}/bin/oxlint --deny-warnings web tests playwright.config.js";
              files = "\\.(mjs|js)$";
              pass_filenames = false;
            };
            pedantic-clippy = {
              enable = true;
              entry = "cargo clippy --all-targets -- -D clippy::pedantic -D clippy::cognitive_complexity";
              files = "\\.rs$";
              pass_filenames = false;
            };
            cargo-test = {
              enable = true;
              entry = "cargo test";
              # The fixtures the server's tests read (the phone's too).
              files = "\\.rs$|^tests/fixtures/";
              pass_filenames = false;
            };
            # The phone's logic on the JVM (`checks.android-unit`), against
            # the fixtures it shares with the server: a change to either side
            # runs it before it can drift.
            android-unit = {
              enable = true;
              entry = toString (pkgs.writeShellScript "android-unit" ''
                set -euo pipefail
                out=$(mktemp -d)
                trap 'rm -rf "$out"' EXIT
                ${pkgs.jdk17_headless}/bin/javac --release 17 -encoding UTF-8 -Xlint:all -Werror -d "$out" \
                  android/src/io/github/tupakkatapa/kaloriina/{Payload,Window,Kinds,Batch}.java \
                  android/test/{PayloadTest,WindowTest,BatchTest}.java
                ${pkgs.jdk17_headless}/bin/java -ea -cp "$out" PayloadTest tests/fixtures/health
              '');
              files = "\\.java$|^tests/fixtures/health/";
              pass_filenames = false;
            };
            playwright = {
              enable = true;
              entry = "${inputs'.playwright.packages.playwright-test}/bin/playwright test";
              files = "\\.(rs|mjs|js|html|css)$";
              pass_filenames = false;
            };
          };

          # Development shell -> 'nix develop' or 'direnv allow'
          devShells.default = pkgs.mkShell {
            packages = with pkgs; [
              cargo
              clippy
              rustc
              rustfmt
              rust-analyzer
              oxlint
              nodejs
              sqlite
              pre-commit
              inputs'.playwright.packages.playwright-test
            ];
            env = {
              PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";
              PLAYWRIGHT_BROWSERS_PATH = "${inputs'.playwright.packages.playwright-driver.browsers}";
              PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = "true";
            };
            shellHook = config.pre-commit.installationScript;
          };

          # NixOS VM test -> 'nix flake check' (Linux only)
          checks = {
            # Known advisories (RustSec) against Cargo.lock, offline: the
            # database is the pinned `advisory-db` input (`nix flake update
            # advisory-db` for news).
            audit = pkgs.runCommand "kaloriina-audit"
              {
                nativeBuildInputs = [ pkgs.cargo-audit ];
              } ''
              HOME=$TMPDIR cargo-audit audit -n -d ${inputs.advisory-db} -f ${./Cargo.lock}
              touch $out
            '';
            # Pure web helpers (units, formatting, dates) without a browser.
            web-unit = pkgs.runCommand "kaloriina-web-unit"
              {
                nativeBuildInputs = [ pkgs.nodejs ];
                src = pkgs.lib.fileset.toSource {
                  root = ./.;
                  # Everything a node test reads or scans (the specs for the slot
                  # check, the server and phone sources for the shared tables, the
                  # README for its anchors), so no scan passes on an empty tree.
                  fileset = pkgs.lib.fileset.unions [ ./web ./tests ./src ./android/src ./android/test ./README.md ];
                };
              } ''
              cd $src
              node --import ./tests/tz.mjs --test tests/*.test.mjs
              touch $out
            '';
            # The web client and tests, by .oxlintrc.json (shadowing, unused and
            # undefined names among them).
            web-lint = pkgs.runCommand "kaloriina-web-lint"
              {
                nativeBuildInputs = [ pkgs.oxlint ];
                src = pkgs.lib.fileset.toSource {
                  root = ./.;
                  fileset = pkgs.lib.fileset.unions [ ./web ./tests ./playwright.config.js ./.oxlintrc.json ];
                };
              } ''
              cd $src
              oxlint --deny-warnings web tests playwright.config.js
              touch $out
            '';
          } // pkgs.lib.optionalAttrs pkgs.stdenv.isLinux {
            module =
              let
                # A throwaway CA and a certificate for the stub Open Food Facts host.
                certs = pkgs.runCommand "off-test-certs" { nativeBuildInputs = [ pkgs.openssl ]; } ''
                  mkdir $out
                  openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj /CN=test-ca \
                    -keyout $out/ca.key -out $out/ca.crt
                  openssl req -newkey rsa:2048 -nodes -subj /CN=off -keyout $out/off.key -out off.csr
                  printf 'subjectAltName=DNS:off' > ext
                  openssl x509 -req -in off.csr -CA $out/ca.crt -CAkey $out/ca.key -CAcreateserial \
                    -days 3650 -extfile ext -out $out/off.crt
                '';
              in
              pkgs.testers.runNixOSTest {
                name = "kaloriina-module";
                nodes.off = {
                  networking.firewall.allowedTCPPorts = [ 80 443 ];
                  services.nginx = {
                    enable = true;
                    # Open Food Facts over HTTPS; a Home Assistant webhook over
                    # plain HTTP, as on a LAN.
                    virtualHosts.off = {
                      addSSL = true;
                      sslCertificate = "${certs}/off.crt";
                      sslCertificateKey = "${certs}/off.key";
                      locations."= /api/v2/product/4000000000017.json".extraConfig = ''
                        default_type application/json;
                        return 200 '{"product":{"product_name":"Stub bread","nutriments":{"energy-kcal_100g":250}}}';
                      '';
                      locations."= /api/webhook/anna-workouts".return = "200";
                    };
                  };
                };
                nodes.machine = {
                  imports = [ self.nixosModules.default ];
                  services.kaloriina = {
                    enable = true;
                    offUrl = "https://off";
                    allowedHosts = [ "kaloriina.test" ];
                    timeZone = "Europe/Helsinki";
                    backup.keep = 2;
                  };
                  security.pki.certificateFiles = [ "${certs}/ca.crt" ];
                  environment.systemPackages = [ pkgs.sqlite ];
                  # Room beyond MemoryMax (1 GiB), so the unit's own ceiling is
                  # what the import drills measure, not the VM's.
                  virtualisation.memorySize = 2048;
                };
                testScript = ''
                  import json, re
                  port = 8080
                  api = f"http://127.0.0.1:{port}/api"
                  ctype = "-H 'content-type: application/json'"
                  db = "/var/lib/kaloriina/kaloriina.db"
                  start_all()
                  off.wait_for_unit("nginx.service")
                  machine.wait_for_unit("kaloriina.service")
                  machine.wait_for_open_port(port)
                  machine.succeed(f"curl -sf {api}/meta | grep -q energy")
                  # Oats, typed per a bowl whose weight is a guess (its basis).
                  machine.succeed(f"curl -sf {ctype} -d '{{\"name\":\"Oats\",\"servings\":[{{\"label\":\"Bowl\",\"grams\":60}}],\"basis\":{{\"serving\":\"Bowl\",\"estimated\":true}}}}' {api}/foods")

                  # DNS rebinding: only known host names are served.
                  machine.succeed(f"curl -sf -H 'Host: kaloriina.test' {api}/profiles")
                  machine.succeed(
                      f"curl -s -o /dev/null -w '%{{http_code}}' -H 'Host: evil.example' {api}/profiles"
                      " | grep -qx 421"
                  )

                  # The binary is the main process (exec), not a wrapping shell.
                  machine.succeed(
                      "readlink /proc/$(systemctl show -p MainPID --value kaloriina)/exe"
                      " | grep -q kaloriina"
                  )

                  # Outbound DNS + TLS work inside the hardened unit.
                  machine.succeed(
                      f"curl -sf {ctype} -d '{{}}' {api}/foods/barcode/4000000000017 | grep -q 'Stub bread'"
                  )

                  # Import as the service user.
                  machine.succeed(
                      "printf 'Day,Group,Food Name,Amount\\n2026-06-02,Consumed,Rye,1 g\\n'"
                      " > /tmp/s.csv"
                  )
                  machine.succeed(
                      f"runuser -u kaloriina -- kaloriina import --db {db} --servings /tmp/s.csv --profile Me"
                  )

                  # Fineli as the service user.
                  machine.succeed(
                      "mkdir -p /tmp/fineli"
                      " && printf 'FOODID;FOODNAME;FOODTYPE;IGCLASS;FUCLASS\\n11;MAITO, RASVATON;FOOD;MILKNONF;MILK\\n' > /tmp/fineli/food.csv"
                      " && printf 'FOODID;EUFDNAME;BESTLOC\\n11;ENERC;141,2\\n' > /tmp/fineli/component_value.csv"
                      " && printf 'FOODID;FOODUNIT;MASS\\n11;DL;103\\n' > /tmp/fineli/foodaddunit.csv"
                      " && chmod -R a+rX /tmp/fineli"
                  )
                  machine.succeed(f"runuser -u kaloriina -- kaloriina fineli --db {db} /tmp/fineli")
                  machine.succeed(f"curl -sf '{api}/profiles/1/foods?q=maito' | grep -q 'Maito, rasvaton'")

                  # Root's `kaloriina` finds the service's database without --db,
                  # and leaves no file of root's beside it.
                  machine.succeed(f"curl -sf {ctype} -d '{{\"kind\":\"bug\",\"text\":\"Row wraps\"}}' {api}/feedback")
                  machine.succeed("cd /root && kaloriina feedback --list | grep -q 'Row wraps'")
                  machine.succeed("cd /root && kaloriina feedback --pull | grep -q 'Row wraps'")
                  machine.fail("find /var/lib/kaloriina -user root | grep .")

                  machine.succeed("systemctl restart kaloriina.service")
                  machine.wait_for_open_port(port)
                  machine.succeed("journalctl -u kaloriina.service | grep -q 'shutting down'")

                  # A stalled upload (a phone on a weak link) doesn't hold a restart
                  # (a deploy): the server drops it 10 s into the stop.
                  import time
                  machine.succeed(
                      f"(head -c 1000 /dev/zero | curl -s --limit-rate 1 {ctype}"
                      f" --data-binary @- {api}/feedback >/dev/null 2>&1 &)"
                  )
                  machine.sleep(2)
                  # Its start doesn't count toward the start limit (failure loops).
                  machine.succeed("systemctl reset-failed kaloriina.service")
                  started = time.monotonic()
                  machine.succeed("systemctl restart kaloriina.service")
                  took = time.monotonic() - started
                  assert took < 15, f"restart took {took:.0f} s"
                  machine.succeed("journalctl -u kaloriina.service | grep -q 'requests still open'")
                  machine.wait_for_open_port(port)
                  # A cross-site form can't write (CSRF): only the app's own pages.
                  machine.succeed(
                      f"curl -s -o /dev/null -w '%{{http_code}}' -H 'Origin: https://evil.example'"
                      f" -d 'kind=bug' {api}/feedback | grep -qx 403"
                  )
                  machine.succeed(f"curl -sf '{api}/profiles/1/foods?q=Oats' | grep -q Oats")
                  machine.succeed(f"curl -sf {api}/profiles/1/day/2026-06-02 | grep -q Rye")

                  # Automatic backups: the timer is armed;
                  # each run leaves one checked copy and keeps the newest `keep` = 2.
                  backups = "/var/lib/kaloriina/backups"
                  machine.succeed("systemctl is-active kaloriina-backup.timer")
                  def take_backup():
                      # Copy names have one-second resolution.
                      machine.succeed("sleep 1.1 && systemctl start kaloriina-backup.service")
                      return machine.succeed(f"ls -1 {backups}").split()
                  first = take_backup()
                  assert len(first) == 1 and re.fullmatch(r"kaloriina-\d{8}T\d{6}Z\.db", first[0]), first
                  take_backup()
                  copies = take_backup()
                  assert len(copies) == 2 and first[0] not in copies, copies
                  for c in copies:
                      machine.succeed(
                          f"sqlite3 -readonly {backups}/{c} 'PRAGMA integrity_check' | grep -qx ok"
                          f" && stat -c '%U %a' {backups}/{c} | grep -qx 'kaloriina 600'"
                      )
                  # Restore the newest copy of the database (README → Backups →
                  # Restore the database).
                  machine.succeed(f"cp {backups}/{copies[-1]} /root/backup.db")
                  machine.succeed(f"curl -sf {ctype} -d '{{\"name\":\"Ghost\"}}' {api}/foods")
                  machine.succeed("systemctl stop kaloriina")
                  # The fourth run (keep + 2), with the server stopped: no -shm to share.
                  assert len(take_backup()) == 2
                  machine.succeed(f"install -o kaloriina -g kaloriina -m 0600 /root/backup.db {db}")
                  machine.succeed(f"rm -f {db}-wal {db}-shm")
                  machine.succeed("systemctl start kaloriina")
                  machine.wait_for_open_port(port)
                  machine.succeed(f"curl -sf '{api}/profiles/1/foods?q=Oats' | grep -q Oats")
                  machine.fail(f"curl -sf '{api}/profiles/1/foods?q=Ghost' | grep -q Ghost")
                  # The server sees the copies (--backup-dir): the app shows their age
                  # and the database disk's space.
                  seen = json.loads(machine.succeed(f"curl -sf {api}/backups"))
                  assert seen["configured"] and seen["newest"] and not seen["stale"], seen
                  assert 0 < seen["free_bytes"] <= seen["total_bytes"], seen

                  # Restore a profile (README → Backups): a deleted profile comes back from a
                  # backup (copy it, serve the copy on a scratch port, export the
                  # profile, import it with ?restore=true) while an entry id it held
                  # went to someone else.
                  post = lambda path, body: json.loads(
                      machine.succeed(f"curl -sf {ctype} -d '{json.dumps(body)}' {api}{path}")
                  )
                  put = lambda path, body: machine.succeed(
                      f"curl -sf -X PUT {ctype} -d '{json.dumps(body)}' {api}{path}"
                  )
                  oats = json.loads(machine.succeed(f"curl -sf '{api}/profiles/1/foods?q=Oats'"))[0]["id"]
                  # The restored database kept the food's basis (typed per a bowl).
                  basis = json.loads(machine.succeed(f"curl -sf {api}/foods/{oats}"))["basis"]
                  assert basis == {"serving": "Bowl", "estimated": True}, basis
                  anna = post("/profiles", {"name": "Anna", "sex": "female", "birth_date": "1990-01-01",
                      "height_cm": 165, "activity": 1.6, "goal_kg_per_week": 0,
                      "goal_date": "2036-09-01", "latitude": 60.2})["id"]
                  day = "2026-06-03"
                  put(f"/profiles/{anna}/weights/2026-06-02", {"kg": 61})
                  rev = json.loads(machine.succeed(f"curl -sf {api}/profiles/{anna}"))["rev"]
                  put(f"/profiles/{anna}/targets", {"rev": rev,
                      "targets": [{"metric": "goal_weight", "value": 58}]})
                  oats_eaten = post(f"/profiles/{anna}/entries", {"day": day, "group": "Eaten",
                      "food_id": oats, "grams": 50, "uid": "anna-entry-1"})["entries"][0]["id"]
                  # Oats daily from that day (the entry is its first tick), skipped the next.
                  daily = json.loads(machine.succeed(
                      f"curl -sf -X PATCH {ctype} -d '{json.dumps({'repeat': {'start': day}})}' "
                      f"{api}/profiles/{anna}/entries/{oats_eaten}"))["repeat"]["id"]
                  machine.succeed(f"curl -sf -X DELETE {api}/profiles/{anna}/entries/daily-{daily}-2026-06-04")
                  post(f"/profiles/{anna}/activities", {"day": day, "name": "Walk",
                      "minutes": 30, "kcal": 120, "sets": [], "uid": "anna-walk-1"})
                  put(f"/profiles/{anna}/notes/{day}", {"text": "Travel day"})
                  put(f"/profiles/{anna}/measurements/{day}/waist", {"value": 80})
                  put(f"/profiles/{anna}/check-ins/{day}", {"mood": 4, "energy": 3, "stress": 2, "tags": ["Travel"]})
                  snus = post(f"/profiles/{anna}/habits", {"name": "Snus", "unit": "pouches"})["id"]
                  put(f"/profiles/{anna}/habits/{snus}/days/{day}", {"amount": 4})
                  # Its notes and a note block travel with it.
                  stretch_steps = [{"kind": "note", "text": "Slowly."}, {"kind": "rest", "seconds": 60}]
                  stretch = post("/workouts", {"name": "Stretch", "steps": stretch_steps,
                      "notes": "Hold each.\nBreathe."})["id"]
                  post(f"/profiles/{anna}/plans", {"day": day, "workout_id": stretch})
                  # Used, so archived rather than deleted; the file says so.
                  put(f"/workouts/{stretch}", {"name": "Stretch", "steps": stretch_steps,
                      "minutes": None, "kcal": None,
                      "notes": "Hold each.\nBreathe.", "archived": True, "rev": 1})
                  # Scale sync: a reading through the webhook, bound to openScale
                  # user 1; the restore brings the reading and the binding back.
                  hook = f"/profiles/{anna}/sync/openscale"
                  post(hook, {"event": "clear", "userId": 1})
                  put(hook, {"user_id": 1})
                  post(hook, {"event": "insert", "id": 1, "userId": 1, "username": "Anna",
                      "date": f"{day}T05:00:00.000Z", "weight": 61.5, "body_fat": 0.0,
                      "water": 0.0, "muscle": 0.0,
                      "values": [{"key": "bone", "value": 2.4}, {"key": "lbm", "value": 45.2}]})
                  # A Home Assistant hook: a LAN address and a secret, never
                  # exported (ADR 0024); the restore comes back without it. Its
                  # test event reaches the LAN over plain HTTP from the hardened unit.
                  put(f"/profiles/{anna}/hooks/home-assistant", {"url": "http://off",
                      "webhook_id": "anna-workouts", "events": ["workout_finished"]})
                  fired = post(f"/profiles/{anna}/hooks/home-assistant/events", {"event": "test"})
                  assert fired["sent"] and fired["result"]["ok"], fired
                  # Health Connect, as the Android app syncs: its raw records
                  # first (a night with its stage spans, the night's HRV, a
                  # 40-minute nap: in bed, not sleep), then its window (the day's
                  # values and heart, a run and a ride). The server makes the night
                  # and the nap of the records. Both workouts become sessions; the
                  # ride, deleted, stays gone on the next sync (a tombstone),
                  # restored too.
                  health = f"/profiles/{anna}/sync/health"
                  def hc_sleep(key, start, end, spans):
                      return {"kind": "SleepSession", "id": key, "start": start, "end": end,
                          "data": {"start_time": start, "start_zone_offset": "+03:00",
                              "end_time": end, "end_zone_offset": "+03:00",
                              "stages": [{"start_time": a, "end_time": b, "type": t} for a, b, t in spans]}}
                  # Health Connect's stage types: 1 awake, 4 light, 5 deep, 6 REM.
                  spans = [("2026-06-02T20:10:00Z", "2026-06-02T20:45:00Z", 1, "awake"),
                      ("2026-06-02T20:45:00Z", "2026-06-02T22:00:00Z", 4, "light"),
                      ("2026-06-02T22:00:00Z", "2026-06-02T23:10:00Z", 5, "deep"),
                      ("2026-06-02T23:10:00Z", f"{day}T00:40:00Z", 6, "rem"),
                      (f"{day}T00:40:00Z", f"{day}T04:05:00Z", 4, "light")]
                  raw = [hc_sleep("sleep-1", spans[0][0], spans[-1][1], [s[:3] for s in spans]),
                      {"kind": "HeartRateVariabilityRmssd", "id": "hrv-1", "start": f"{day}T01:00:00Z",
                          "data": {"time": f"{day}T01:00:00Z", "ms": 48.0}},
                      hc_sleep("nap-1", f"{day}T11:00:00Z", f"{day}T11:40:00Z", [])]
                  kept = post(f"{health}/records", {"device": "Pixel 9", "records": raw})
                  assert kept == {"records": 3, "truncated": 0, "skipped": 0, "failed": 0}, kept
                  # The night as the server made it: 23:10–07:05 in Helsinki.
                  night = {"hrv_ms": 48, "asleep_min": 440, "in_bed_min": 475, "bedtime": "23:10",
                      "wake_time": "07:05", "deep_min": 70, "rem_min": 90, "light_min": 280}
                  values = {"day": day, "active_kcal": 512, "total_kcal": 2450, "steps": 9120, "resting_hr": 54,
                      "avg_hr": 68, "min_hr": 48, "max_hr": 141, "sleep_avg_hr": 55}
                  hc = {"from": day, "to": day, "device": "Pixel 9", "days": [values],
                      "sessions": [{"key": "hc-1", "day": day, "start_at": f"{day}T14:02:00Z",
                          "end_at": f"{day}T14:48:00Z", "type": 33, "name": "Running", "kcal": 410,
                          "distance_m": 8200, "recording_method": 1},
                        {"key": "hc-2", "day": day, "start_at": f"{day}T18:00:00Z",
                          "end_at": f"{day}T18:30:00Z", "type": 4, "name": "Biking", "kcal": 200,
                          "distance_m": 10000, "recording_method": 1}]}
                  # An older phone's night fields in the window are left out, never
                  # counted as skipped; the night counted is the server's.
                  res = post(health, {**hc, "days": [{**values, "asleep_min": 1, "naps": []}]})
                  assert res == {"days": 1, "sessions": 2, "nights": 1, "skipped": 0}, res
                  shown = {**values, **night, "bmr_kcal": None, "bmr_origin": None, "distance_m": None,
                      "total_asleep_min": 440, "naps": 1, "nap_in_bed_min": 40}
                  synced_day = json.loads(machine.succeed(f"curl -sf {api}/profiles/{anna}/day/{day}"))
                  assert synced_day["device_day"] == shown, synced_day["device_day"]
                  synced = lambda: {s["source_key"]: s for s in json.loads(
                      machine.succeed(f"curl -sf {api}/profiles/{anna}/activities"))}
                  runs = synced()
                  assert (runs["hc-1"]["type"], runs["hc-1"]["distance_m"]) == ("run", 8200), runs
                  assert runs["hc-1"]["source"] == "health_connect", runs
                  machine.succeed(f"curl -sf -X DELETE {api}/profiles/{anna}/activities/{runs['hc-2']['id']}")
                  post(health, hc)
                  assert set(synced()) == {None, "hc-1"}, synced()
                  # A Google Health import of the same day: Health Connect's values
                  # stay; the import keeps its own, restored too (below).
                  gh = post(f"/profiles/{anna}/import/google-health", {"files": [
                      {"name": "daily_resting_heart_rate.csv",
                       "text": f"timestamp,beats per minute\n{day}T00:00:00Z,57\n"}]})
                  assert (gh["days"], gh["activities"]) == (0, 0), gh
                  # A nap logged by hand travels in the file; a photo only in
                  # backups: a profile restored through its export comes back
                  # without it (ADR 0022).
                  post(f"/profiles/{anna}/naps", {"uid": "anna-nap-1", "day": day,
                      "start_at": f"{day}T13:00:00Z", "end_at": f"{day}T13:20:00Z"})
                  machine.succeed(
                      "printf '\\xff\\xd8\\xff\\xc0\\x00\\x11\\x08\\x00\\x08\\x00\\x08\\x03"
                      "\\x01\\x22\\x00\\x02\\x11\\x01\\x03\\x11\\x01\\xff\\xd9' > /tmp/photo.jpg"
                  )
                  photo = json.loads(machine.succeed(f"curl -sf -H 'Content-Type: image/jpeg' --data-binary @/tmp/photo.jpg "
                      f"'{api}/profiles/{anna}/photos?day={day}&group=Eaten'"))["uid"]
                  newest = take_backup()[-1]
                  machine.succeed(f"curl -sf -X DELETE {api}/profiles/{anna}")
                  # An entry logged since (its id the next one, never one Anna held).
                  post("/profiles/1/entries", {"day": day, "group": "Eaten",
                      "food_id": oats, "grams": 20})
                  # An old client's group name is refused: only Planned and Eaten.
                  machine.succeed(
                      f"curl -s -o /dev/null -w '%{{http_code}}' {ctype} -d '"
                      + json.dumps({"day": day, "group": "Consumed", "food_id": oats, "grams": 20})
                      + f"' {api}/profiles/1/entries | grep -qx 400"
                  )
                  copy = "/var/lib/kaloriina/restore.db"
                  machine.succeed(f"install -o kaloriina -g kaloriina -m 0600 {backups}/{newest} {copy}")
                  machine.succeed(
                      f"systemd-run --unit kaloriina-restore -p User=kaloriina -p Group=kaloriina "
                      f"$(command -v kaloriina) serve --db {copy} --port 8099"
                  )
                  machine.wait_for_open_port(8099)
                  # The backup serves the photo at the URL it had: its uid.
                  machine.succeed(f"curl -sf -o /tmp/photo-back.jpg http://127.0.0.1:8099/api/profiles/{anna}/photos/{photo}")
                  machine.succeed("cmp /tmp/photo.jpg /tmp/photo-back.jpg")
                  machine.succeed(f"curl -sf -o /tmp/anna.json http://127.0.0.1:8099/api/profiles/{anna}/export")
                  machine.succeed("systemctl stop kaloriina-restore")
                  machine.succeed(f"rm -f {copy}*")
                  restored = json.loads(machine.succeed(
                      f"curl -sf {ctype} --data-binary @/tmp/anna.json '{api}/profiles/import?restore=true'"))
                  assert restored["id"] == anna, restored
                  # How fast the goal is: by its date, beside kg a week.
                  assert restored["goal_date"] == "2036-09-01", restored
                  assert restored["latitude"] == 60.2, restored
                  back = json.loads(machine.succeed(f"curl -sf {api}/profiles/{anna}/day/{day}"))
                  entries = [e for g in back["groups"] for e in g["entries"]]
                  assert [e["uid"] for e in entries] == ["anna-entry-1"], entries
                  assert [g["name"] for g in back["groups"]] == ["Planned", "Eaten"], back["groups"]
                  # The food typed per its bowl, its weight a guess, still reads so.
                  assert entries[0]["weight_estimated"], entries
                  assert back["note"] == "Travel day", back["note"]
                  assert back["measurements"] == [{"kind": "waist", "value": 80}], back["measurements"]
                  assert back["check_in"] == {"day": day, "mood": 4, "energy": 3, "stress": 2, "tags": ["travel"]}, back["check_in"]
                  habits = json.loads(machine.succeed(f"curl -sf {api}/profiles/{anna}/habits"))
                  assert [h["name"] for h in habits] == ["Snus"], habits
                  assert [h["amount"] for h in back["habits"]] == [4], back["habits"]
                  targets = json.loads(machine.succeed(f"curl -sf {api}/profiles/{anna}/targets"))
                  assert any(t["metric"] == "goal_weight" and t["value"] == 58 for t in targets), targets
                  plans = json.loads(machine.succeed(f"curl -sf {api}/profiles/{anna}/plans"))
                  assert [p["name"] for p in plans] == ["Stretch"], plans
                  exported = json.loads(machine.succeed("cat /tmp/anna.json"))
                  assert [w["archived"] for w in exported["workouts"]] == [True], exported["workouts"]
                  assert [w["notes"] for w in exported["workouts"]] == ["Hold each.\nBreathe."], exported["workouts"]
                  assert exported["workouts"][0]["steps"][0] == stretch_steps[0], exported["workouts"]
                  after = json.loads(machine.succeed(f"curl -sf {api}/workouts/{stretch}"))
                  assert (after["notes"], after["steps"]) == ("Hold each.\nBreathe.", stretch_steps), after
                  # The daily item: its tick still linked, its skip kept, due after.
                  assert entries[0]["repeat"] is not None, entries
                  due = lambda d: [e for g in json.loads(machine.succeed(
                      f"curl -sf {api}/profiles/{anna}/day/{d}"))["groups"]
                      for e in g["entries"] if e["id"] is None]
                  assert due("2026-06-04") == [], due("2026-06-04")
                  assert [i["name"] for i in due("2026-06-05")] == ["Oats"], due("2026-06-05")
                  # Every session has a type: the walk logged without one is a workout.
                  types = {x["name"]: x["type"] for x in back["activities"]}
                  assert types == {"Running": "run", "Walk": "workout"}, back["activities"]
                  weights = json.loads(machine.succeed(f"curl -sf {api}/profiles/{anna}/weights"))
                  assert sorted(w["kg"] for w in weights) == [61, 61.5], weights
                  assert back["weight_source"] == "openscale", back
                  bound = json.loads(machine.succeed(f"curl -sf {api}/profiles/{anna}/sync/openscale"))
                  assert bound["bound_user"]["id"] == 1, bound
                  hooked = machine.succeed(f"curl -sf {api}/profiles/{anna}/hooks/home-assistant")
                  assert json.loads(hooked) is None, hooked
                  assert "anna-workouts" not in machine.succeed("cat /tmp/anna.json")
                  # The night with its heart and stage spans, its synced nap (in bed)
                  # and the one logged by hand (asleep).
                  assert back["device_day"] == {**shown, "total_asleep_min": 460, "naps": 2}, back
                  assert back["stages"] == [{"day": day, "start_at": a, "end_at": b, "stage": st,
                      "source": "health_connect"} for a, b, _, st in spans], back["stages"]
                  naps = [(n["in_bed_min"], n["source"]) for n in back["naps"]]
                  assert naps == [(40, "health_connect"), (20, "hand")], back
                  assert back["photos"] == [], back["photos"]
                  # Where each session's energy came from; the scale's bone and lean mass.
                  energy = {x["name"]: x["kcal_source"] for x in back["activities"]}
                  assert energy == {"Running": "health_connect", "Walk": "hand"}, back["activities"]
                  scale = json.loads(machine.succeed(f"curl -sf {api}/profiles/{anna}/scale"))
                  assert (scale[0]["bone_kg"], scale[0]["lbm_kg"]) == (2.4, 45.2), scale
                  assert back["pending_activities"] == [], back
                  assert synced()["hc-1"]["distance_m"] == 8200
                  # The tombstone came back too: the ride stays gone.
                  post(health, hc)
                  assert set(synced()) == {None, "hc-1"}, synced()
                  # The import's own values came back too: a sync without a resting
                  # heart rate leaves the imported one.
                  post(health, {**hc, "days": [{k: v for k, v in values.items() if k != "resting_hr"}]})
                  again = json.loads(machine.succeed(f"curl -sf {api}/profiles/{anna}/day/{day}"))
                  assert again["device_day"]["resting_hr"] == 57, again["device_day"]
                  mine = json.loads(machine.succeed(f"curl -sf {api}/profiles/1/day/{day}"))
                  assert sum(len(g["entries"]) for g in mine["groups"]) == 1, mine

                  # The largest allowed import (64 MiB, a realistic shape: years of
                  # entries, 20 nutrients each) and its export run under MemoryMax
                  # without an OOM kill. MemoryPeak counts reclaimable page cache too,
                  # so the margin asked of it is a quarter, not half.
                  machine.succeed("systemctl restart kaloriina.service")
                  machine.wait_for_open_port(port)
                  keys = ["energy", "alcohol", "caffeine", "water", "net_carbs", "carbs", "sugars",
                      "added_sugars", "starch", "fiber", "fat", "saturated", "monounsaturated",
                      "polyunsaturated", "trans_fats", "cholesterol", "omega_3", "omega_6", "ala", "epa"]
                  nutrients = {k: 12.345678901 + i for i, k in enumerate(keys)}
                  import datetime
                  start = datetime.date(2000, 1, 1)
                  entries, size, i = [], 0, 0
                  while size < 63 * 1024 * 1024:
                      d = (start + datetime.timedelta(days=i // 30)).isoformat()
                      e = {"uid": f"entry-{i:010d}", "day": d, "group": "Eaten", "food": "f",
                           "name": "Kaurapuuro, vedellä", "grams": 250, "amount": "250 g",
                           "nutrients": nutrients,
                           "created_at": f"{d}T08:00:00Z", "time": "08:00"}
                      size += len(json.dumps(e)) + 1
                      entries.append(e)
                      i += 1
                  big = {"format": "kaloriina-profile", "version": 3,
                         "profile": {"name": "Big", "sex": None, "birth_date": None, "height_cm": None,
                                     "activity": None, "goal_kg_per_week": 0},
                         "foods": [{"ref": "f", "name": "Kaurapuuro, vedellä", "source": "custom",
                                    "per100": {"energy": 60}}],
                         "entries": entries}
                  import tempfile
                  host = tempfile.mkdtemp() + "/big.json"
                  with open(host, "w") as out:
                      json.dump(big, out)
                  machine.copy_from_host(host, "/tmp/big.json")
                  assert int(machine.succeed("stat -c %s /tmp/big.json")) <= 64 * 1024 * 1024
                  big_id = json.loads(machine.succeed(
                      f"curl -sf {ctype} --data-binary @/tmp/big.json {api}/profiles/import"))["id"]
                  machine.succeed(f"curl -sf -o /dev/null {api}/profiles/{big_id}/export")
                  peak = int(machine.succeed(
                      "systemctl show -p MemoryPeak --value kaloriina.service").strip())
                  print(f"MemoryPeak after a 64 MiB import and its export: {peak / 2**20:.0f} MiB")
                  limit = int(machine.succeed(
                      "systemctl show -p MemoryMax --value kaloriina.service").strip())
                  assert 4 * peak <= 3 * limit, f"MemoryPeak {peak} over 3/4 of MemoryMax {limit}"
                  restarts = machine.succeed("systemctl show -p NRestarts --value kaloriina.service").strip()
                  assert restarts == "0", f"the service restarted {restarts} times"
                  machine.succeed(f"curl -sf -X DELETE {api}/profiles/{big_id}")

                  # The largest Google Health import (64 MiB of sleep stages, every
                  # row kept raw) stays under the same 3/4 of MemoryMax.
                  machine.succeed("systemctl restart kaloriina.service")
                  machine.wait_for_open_port(port)
                  rows, size, i = ["sleep_id,sleep_stage_type,sleep_stage_start,sleep_stage_end"], 0, 0
                  t0 = datetime.datetime(2015, 1, 1, tzinfo=datetime.timezone.utc)
                  # Each line's break is two bytes once in JSON.
                  while size < 62 * 1024 * 1024:
                      a = t0 + datetime.timedelta(seconds=30 * i)
                      b = a + datetime.timedelta(seconds=30)
                      row = f"{i // 960},LIGHT,{a:%Y-%m-%dT%H:%M:%SZ},{b:%Y-%m-%dT%H:%M:%SZ}"
                      size += len(row) + 1
                      rows.append(row)
                      i += 1
                  stages = {"files": [{"name": "Takeout/Google Health/UserSleepStages_2026-05-31.csv",
                                       "text": "\n".join(rows) + "\n"}]}
                  host = tempfile.mkdtemp() + "/stages.json"
                  with open(host, "w") as out:
                      json.dump(stages, out)
                  machine.copy_from_host(host, "/tmp/stages.json")
                  assert int(machine.succeed("stat -c %s /tmp/stages.json")) <= 64 * 1024 * 1024
                  machine.succeed(
                      f"curl -sf {ctype} --data-binary @/tmp/stages.json"
                      f" {api}/profiles/1/import/google-health"
                  )
                  peak = int(machine.succeed(
                      "systemctl show -p MemoryPeak --value kaloriina.service").strip())
                  print(f"MemoryPeak after a 64 MiB Google Health import: {peak / 2**20:.0f} MiB")
                  assert 4 * peak <= 3 * limit, f"MemoryPeak {peak} over 3/4 of MemoryMax {limit}"
                  restarts = machine.succeed("systemctl show -p NRestarts --value kaloriina.service").strip()
                  assert restarts == "0", f"the service restarted {restarts} times"

                  # The day boundary follows services.kaloriina.timeZone: 22:30 UTC is
                  # already the next day in Helsinki.
                  machine.succeed("journalctl -u kaloriina.service | grep -q Europe/Helsinki")
                  hook = f"/profiles/{anna}/sync/openscale"
                  res = post(hook, {"event": "insert", "id": 2, "userId": 1, "username": "Anna",
                      "date": "2026-06-04T22:30:00.000Z", "weight": 61.2, "body_fat": 0.0,
                      "water": 0.0, "muscle": 0.0})
                  assert res == {"applied": 1, "skipped": 0, "ignored": 0}, res
                  late = json.loads(machine.succeed(
                      f"curl -sf '{api}/profiles/{anna}/weights?from=2026-06-04&to=2026-06-05'"
                  ))
                  assert late == [{"day": "2026-06-05", "kg": 61.2}], late

                  # A corrupt database: the run fails, its copy is deleted, and the good
                  # copies aren't pruned. Whether VACUUM INTO already trips on the zeroed
                  # page or the copy's integrity check catches it depends on what the
                  # page held; either way the journal says why.
                  machine.succeed("systemctl stop kaloriina")
                  machine.succeed(f"cp -p {db} /root/good.db")
                  before = machine.succeed(f"ls -1 {backups}").split()
                  machine.succeed(f"dd if=/dev/zero of={db} bs=4096 seek=2 count=1 conv=notrunc")
                  machine.fail("sleep 1.1 && systemctl start kaloriina-backup.service")
                  machine.succeed("journalctl -u kaloriina-backup.service | grep -qE 'failed its integrity check|malformed'")
                  after = machine.succeed(f"ls -1 {backups}").split()
                  assert after == before, (before, after)
                  machine.succeed(f"cp -p /root/good.db {db}")
                  # The drill's deliberate restarts would otherwise spend the server's
                  # start limit (five in five minutes), which is for failure loops.
                  machine.succeed("systemctl reset-failed kaloriina-backup.service kaloriina.service")
                  machine.succeed("systemctl start kaloriina")
                  machine.wait_for_open_port(port)

                  # Upgrade and roll back, step by step as the README's Backups
                  # section says: an old database (v27, a row in every table)
                  # migrates on start and leaves its `.pre-v27` copy; restoring that
                  # copy gives v27 back, every row intact. (The last step, switching
                  # back to the previous build, is the host's.)
                  machine.succeed("systemctl stop kaloriina")
                  # Room on the VM's disk after the big imports.
                  machine.succeed("rm -f /root/good.db /tmp/big.json /tmp/stages.json")
                  machine.succeed(f"mv {db} /root/current.db")
                  machine.succeed(f"rm -f {db}-wal {db}-shm {db}.pre-v*")
                  machine.succeed("sqlite3 /root/v27.db < ${./tests/fixtures/v27.sql}")
                  dump = lambda f: machine.succeed(f"sqlite3 -readonly {f} .dump")
                  old = dump("/root/v27.db")
                  machine.succeed(f"install -o kaloriina -g kaloriina -m 0600 /root/v27.db {db}")
                  machine.succeed("systemctl reset-failed kaloriina.service")
                  machine.succeed("systemctl start kaloriina")
                  machine.wait_for_open_port(port)
                  machine.succeed("journalctl -u kaloriina.service | grep -q 'saved a copy before migrating'")
                  version = lambda: int(machine.succeed(f"sqlite3 -readonly {db} 'PRAGMA user_version'"))
                  assert version() > 27, version()
                  # 1. Stop the service.
                  machine.succeed("systemctl stop kaloriina")
                  # 2. Restore the copy named after the version upgraded from.
                  copies = machine.succeed(f"ls -1 {db}.pre-v*").split()
                  assert copies == [f"{db}.pre-v27"], copies
                  machine.succeed(f"install -o kaloriina -g kaloriina -m 0600 {db}.pre-v27 {db}")
                  machine.succeed(f"rm -f {db}-wal {db}-shm")
                  assert version() == 27, version()
                  assert dump(db) == old, "the rolled-back database lost rows"
                  # Back to the drill's own database.
                  machine.succeed(f"mv /root/current.db {db}")
                  machine.succeed(f"rm -f {db}-wal {db}-shm {db}.pre-v*")
                  machine.succeed("systemctl start kaloriina")
                  machine.wait_for_open_port(port)
                  machine.succeed(f"curl -sf '{api}/profiles/1/foods?q=Oats' | grep -q Oats")

                  machine.succeed("test -z \"$(find /var/lib/kaloriina ! -user kaloriina)\"")
                  # Hardening can't regress unnoticed: exposure must stay at or below 2.0.
                  print(machine.succeed("systemd-analyze security --threshold=20 kaloriina.service | tail -1"))
                  print(machine.succeed("systemd-analyze security --threshold=20 kaloriina-backup.service | tail -1"))
                '';
              };

            # services.kaloriina.hooks: the unit sets a profile's Home Assistant
            # hook from Nix, against a stub Home Assistant on the same host.
            module-hooks = pkgs.testers.runNixOSTest {
              name = "kaloriina-module-hooks";
              nodes.machine = {
                imports = [ self.nixosModules.default ];
                services.kaloriina = {
                  enable = true;
                  # Not a loopback name: the unit's own Host still passes.
                  allowedHosts = [ "kaloriina.test" ];
                  hooks = {
                    Anna = {
                      url = "http://127.0.0.1:8123";
                      # Written by the test: absent at boot.
                      webhookIdFile = "/run/ha/anna";
                      events = [ "workout_started" ];
                    };
                    Nobody = {
                      url = "http://127.0.0.1:8123";
                      webhookIdFile = "/run/ha/anna";
                    };
                  };
                };
                # Home Assistant: answers 200 and logs each request's path.
                systemd.services.ha-stub = {
                  wantedBy = [ "multi-user.target" ];
                  script = ''
                    exec ${pkgs.python3}/bin/python3 -u -c '
                    from http.server import BaseHTTPRequestHandler, HTTPServer
                    class H(BaseHTTPRequestHandler):
                        def do_POST(self):
                            print("got", self.command, self.path)
                            self.send_response(200)
                            self.end_headers()
                    HTTPServer(("127.0.0.1", 8123), H).serve_forever()
                    '
                  '';
                };
              };
              testScript = ''
                import json
                api = "http://127.0.0.1:8080/api"
                ctype = "-H 'content-type: application/json'"
                hook = "/profiles/{}/hooks/home-assistant"
                machine.wait_for_unit("kaloriina.service")
                machine.wait_for_unit("ha-stub.service")

                # The id file can't be read: the unit fails.
                machine.wait_until_succeeds("systemctl is-failed kaloriina-hooks.service")

                # No profile of that name: a warning, skipped, the unit succeeds.
                machine.succeed("install -d -m 0700 /run/ha && printf ' anna-secret-1\\n' > /run/ha/anna")
                machine.succeed("systemctl restart kaloriina-hooks.service")
                machine.succeed("systemctl is-active kaloriina-hooks.service")
                warned = machine.succeed("journalctl -u kaloriina-hooks.service -p warning")
                assert "no profile named Anna" in warned and "no profile named Nobody" in warned, warned

                # The profile exists: a server restart re-applies the hooks.
                profile = {"name": "Anna", "sex": "female", "birth_date": "1990-01-01",
                    "height_cm": 165, "activity": 1.6, "goal_kg_per_week": 0,
                    "goal_date": "2036-09-01", "latitude": 60.2}
                anna = json.loads(machine.succeed(
                    f"curl -sf {ctype} -d '{json.dumps(profile)}' {api}/profiles"))["id"]
                machine.succeed("systemctl restart kaloriina.service")
                machine.wait_until_succeeds(
                    f"curl -sf {api}{hook.format(anna)} | grep -q 127.0.0.1:8123")
                machine.succeed("systemctl is-active kaloriina-hooks.service")
                got = machine.succeed(f"curl -sf {api}{hook.format(anna)}")
                assert "anna-secret-1" not in got, got
                got = json.loads(got)
                assert got["url"] == "http://127.0.0.1:8123" and got["events"] == ["workout_started"], got

                # Nix wins: a change made in Connections is undone by the next run.
                machine.succeed(
                    f"curl -sf -X PUT {ctype} -d '{json.dumps({'url': 'http://127.0.0.1:9', 'webhook_id': 'other', 'events': []})}'"
                    f" {api}{hook.format(anna)}")
                machine.succeed("systemctl restart kaloriina-hooks.service")
                assert json.loads(machine.succeed(f"curl -sf {api}{hook.format(anna)}"))["url"] == "http://127.0.0.1:8123"

                # A workout start reaches Home Assistant with the trimmed id.
                sent = json.loads(machine.succeed(
                    f"curl -sf {ctype} -d '{json.dumps({'event': 'workout_started'})}' {api}{hook.format(anna)}/events"))
                assert sent["sent"] and sent["result"]["ok"], sent
                machine.wait_until_succeeds(
                    "journalctl -u ha-stub.service | grep -q 'got POST /api/webhook/anna-secret-1$'")

                # A refused PUT fails the unit.
                machine.succeed("printf 'not a valid id!' > /run/ha/anna")
                machine.fail("systemctl restart kaloriina-hooks.service")

                print(machine.succeed("systemd-analyze security kaloriina-hooks.service | tail -1"))
              '';
            };

            # services.kaloriina.fineli: a pinned package is imported once, again
            # when it changes; a bad one fails the unit, not the app.
            module-fineli =
              let
                package = foods: values: pkgs.runCommand "fineli-test" { } ''
                  mkdir $out
                  printf 'FOODID;FOODNAME;FOODTYPE;IGCLASS;FUCLASS\n%s' ${pkgs.lib.escapeShellArg foods} > $out/food.csv
                  printf 'FOODID;EUFDNAME;BESTLOC\n%s' ${pkgs.lib.escapeShellArg values} > $out/component_value.csv
                  printf 'FOODID;FOODUNIT;MASS\n11;DL;103\n' > $out/foodaddunit.csv
                '';
                v1 = package "11;MAITO, RASVATON;FOOD;MILKNONF;MILK\n" "11;ENERC;141,2\n";
                v2 = package "11;MAITO, RASVATON;FOOD;MILKNONF;MILK\n12;RUISLEIPA;FOOD;BREADRYE;BREAD\n"
                  "11;ENERC;150\n12;ENERC;900\n";
              in
              pkgs.testers.runNixOSTest {
                name = "kaloriina-module-fineli";
                nodes.machine = {
                  imports = [ self.nixosModules.default ];
                  services.kaloriina = {
                    enable = true;
                    fineli = {
                      enable = true;
                      source = v1;
                    };
                  };
                  specialisation.v2.configuration.services.kaloriina.fineli.source = pkgs.lib.mkForce v2;
                  specialisation.bad.configuration.services.kaloriina.fineli.source =
                    pkgs.lib.mkForce (pkgs.runCommand "not-fineli" { } "mkdir $out");
                };
                testScript = ''
                  import json
                  api = "http://127.0.0.1:8080/api"
                  ctype = "-H 'content-type: application/json'"
                  stamp = "/var/lib/kaloriina/.fineli-source"
                  machine.wait_for_unit("kaloriina.service")
                  machine.wait_for_open_port(8080)

                  # The first boot imports, before the server starts.
                  machine.succeed("systemctl is-active kaloriina-fineli.service")
                  machine.succeed("journalctl -u kaloriina-fineli.service | grep -q 'fineli: 1 foods, 1 new'")
                  machine.succeed(f"grep -qx ${v1} {stamp}")
                  profile = {"name": "Anna", "sex": "female", "birth_date": "1990-01-01",
                      "height_cm": 165, "activity": 1.6, "goal_kg_per_week": 0,
                      "goal_date": "2036-09-01", "latitude": 60.2}
                  anna = json.loads(machine.succeed(
                      f"curl -sf {ctype} -d '{json.dumps(profile)}' {api}/profiles"))["id"]
                  find = lambda q: json.loads(machine.succeed(f"curl -sf '{api}/profiles/{anna}/foods?q={q}'"))
                  milk = find("maito")[0]["id"]

                  # A serving of your own on a Fineli food.
                  food = json.loads(machine.succeed(f"curl -sf {api}/foods/{milk}"))
                  food["servings"].append({"label": "Glass", "grams": 200})
                  machine.succeed(f"curl -sf -X PUT {ctype} -d '{json.dumps(food)}' {api}/foods/{milk}")

                  # Same source: a restart skips.
                  machine.succeed("systemctl restart kaloriina.service")
                  machine.wait_for_open_port(8080)
                  machine.succeed("journalctl -u kaloriina-fineli.service | grep -q 'already imported, skipped'")
                  assert machine.succeed("journalctl -u kaloriina-fineli.service | grep -c 'fineli: 1 foods'").strip() == "1"

                  # A newer package: imported in place while the server runs; your
                  # serving stays, the new food shows without a restart.
                  machine.succeed("/run/booted-system/specialisation/v2/bin/switch-to-configuration test")
                  machine.succeed("journalctl -u kaloriina-fineli.service | grep -q 'fineli: 2 foods, 1 new'")
                  machine.succeed(f"grep -qx ${v2} {stamp}")
                  machine.succeed("systemctl is-active kaloriina.service")
                  food = json.loads(machine.succeed(f"curl -sf {api}/foods/{milk}"))
                  assert {"label": "Glass", "grams": 200} in [
                      {"label": s["label"], "grams": s["grams"]} for s in food["servings"]], food
                  assert find("ruisleip")[0]["name"].lower().startswith("ruisleip"), find("ruisleip")

                  # Not a Fineli package: the unit fails before opening the
                  # database; the app keeps running on what it had.
                  machine.fail("/run/booted-system/specialisation/bad/bin/switch-to-configuration test")
                  machine.succeed("systemctl is-failed kaloriina-fineli.service")
                  machine.succeed("journalctl -u kaloriina-fineli.service | grep -q 'is this a Fineli package'")
                  machine.succeed(f"grep -qx ${v2} {stamp}")
                  machine.succeed("systemctl is-active kaloriina.service")

                  print(machine.succeed("systemd-analyze security kaloriina-fineli.service | tail -1"))
                '';
              };
          } // android.checks or { };

          # Packages -> 'nix build' or 'nix run'
          packages = {
            kaloriina = pkgs.callPackage ./package.nix { };
            default = self'.packages.kaloriina;
          } // android.packages or { };

          # The server's perf bench (tests/bench.rs, a release build) ->
          # 'nix build -L .#bench' ('--rebuild' to time it again). Not under
          # checks: timing needs a quiet machine, so 'nix flake check' leaves
          # it out.
          legacyPackages.bench = self'.packages.kaloriina.overrideAttrs {
            pname = "kaloriina-bench";
            cargoTestFlags = [ "--test" "bench" ];
            checkFlags = [ "--ignored" "--nocapture" ];
          };

          # Apps -> 'nix run .#<name>'
          apps = android.apps or { };
        };

      flake = {
        nixosModules = {
          kaloriina = import ./module.nix;
          default = self.nixosModules.kaloriina;
        };
      };
    };
}
