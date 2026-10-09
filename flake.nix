{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
    flake-parts.url = "github:hercules-ci/flake-parts";
    git-hooks.url = "github:cachix/git-hooks.nix";
    git-hooks.inputs.nixpkgs.follows = "nixpkgs";
    treefmt-nix.url = "github:numtide/treefmt-nix";
    treefmt-nix.inputs.nixpkgs.follows = "nixpkgs";
    playwright.url = "github:pietdevries94/playwright-web-flake/1.55.0";
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
              files = "\\.rs$";
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
            # Pure web helpers (units, formatting, dates) without a browser.
            web-unit = pkgs.runCommand "kaloriina-web-unit"
              {
                nativeBuildInputs = [ pkgs.nodejs ];
                src = pkgs.lib.fileset.toSource {
                  root = ./.;
                  # Every node test file, so a new one can't be left out.
                  fileset = pkgs.lib.fileset.unions [
                    ./web
                    ./tests/step-rules.json
                    ./tests/slots.mjs
                    ./src/exercises.json
                    (pkgs.lib.fileset.fileFilter (f: pkgs.lib.hasSuffix ".test.mjs" f.name) ./tests)
                  ];
                };
              } ''
              cd $src
              TZ=Europe/Helsinki node --test tests/*.test.mjs
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
                  networking.firewall.allowedTCPPorts = [ 443 ];
                  services.nginx = {
                    enable = true;
                    virtualHosts.off = {
                      onlySSL = true;
                      sslCertificate = "${certs}/off.crt";
                      sslCertificateKey = "${certs}/off.key";
                      locations."= /api/v2/product/4000000000017.json".extraConfig = ''
                        default_type application/json;
                        return 200 '{"product":{"product_name":"Stub bread","nutriments":{"energy-kcal_100g":250}}}';
                      '';
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
                  machine.succeed(f"curl -sf {ctype} -d '{{\"name\":\"Oats\"}}' {api}/foods")

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

                  machine.succeed("systemctl restart kaloriina.service")
                  machine.wait_for_open_port(port)
                  machine.succeed("journalctl -u kaloriina.service | grep -q 'shutting down'")
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
                  # Restore the newest copy of the database.
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
                  # The server sees the copies (--backup-dir): the app shows their age.
                  assert json.loads(machine.succeed(f"curl -sf {api}/backups"))["newest"], "no backup age"

                  # Restore a profile: a deleted profile comes back from a
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
                  anna = post("/profiles", {"name": "Anna", "sex": "female", "birth_date": "1990-01-01",
                      "height_cm": 165, "activity": 1.6, "goal_kg_per_week": 0})["id"]
                  day = "2026-06-03"
                  put(f"/profiles/{anna}/weights/2026-06-02", {"kg": 61})
                  rev = json.loads(machine.succeed(f"curl -sf {api}/profiles/{anna}"))["rev"]
                  put(f"/profiles/{anna}/targets", {"rev": rev,
                      "targets": [{"metric": "goal_weight", "value": 58}]})
                  post(f"/profiles/{anna}/entries", {"day": day, "group": "Consumed",
                      "food_id": oats, "grams": 50, "uid": "anna-entry-1"})
                  post(f"/profiles/{anna}/sessions", {"day": day, "name": "Walk",
                      "minutes": 30, "sets": [], "uid": "anna-walk-1"})
                  put(f"/profiles/{anna}/notes/{day}", {"text": "Travel day"})
                  put(f"/profiles/{anna}/measurements/{day}/waist", {"value": 80})
                  put(f"/profiles/{anna}/check-ins/{day}", {"mood": 4, "energy": 3, "stress": 2, "tags": ["Travel"]})
                  snus = post(f"/profiles/{anna}/habits", {"name": "Snus", "unit": "pouches"})["id"]
                  put(f"/profiles/{anna}/habits/{snus}/days/{day}", {"amount": 4})
                  stretch = post("/workouts", {"name": "Stretch", "steps": [{"kind": "rest", "seconds": 60}]})["id"]
                  post(f"/profiles/{anna}/plans", {"day": day, "workout_id": stretch})
                  # Scale sync: a reading through the webhook, bound to openScale
                  # user 1; the restore brings the reading and the binding back.
                  hook = f"/profiles/{anna}/sync/openscale"
                  post(hook, {"event": "clear", "userId": 1})
                  put(hook, {"user_id": 1})
                  post(hook, {"event": "insert", "id": 1, "userId": 1, "username": "Anna",
                      "date": f"{day}T05:00:00.000Z", "weight": 61.5, "body_fat": 0.0,
                      "water": 0.0, "muscle": 0.0})
                  # Health Connect: a day with its night and heart, a run and a ride
                  # from the Android app. Both become sessions; the ride, deleted,
                  # stays gone on the next sync (a tombstone), restored too.
                  health = f"/profiles/{anna}/sync/health"
                  night = {"day": day, "active_kcal": 512, "steps": 9120, "resting_hr": 54,
                      "hrv_ms": 48, "asleep_min": 440, "in_bed_min": 475, "bedtime": "23:10",
                      "wake_time": "07:05", "deep_min": 70, "rem_min": 90, "light_min": 200}
                  hc = {"from": day, "to": day, "device": "Pixel 9", "days": [night],
                      "sessions": [{"key": "hc-1", "day": day, "start_at": f"{day}T14:02:00Z",
                          "end_at": f"{day}T14:48:00Z", "type": 33, "name": "Running", "kcal": 410,
                          "distance_m": 8200, "recording_method": 1},
                        {"key": "hc-2", "day": day, "start_at": f"{day}T18:00:00Z",
                          "end_at": f"{day}T18:30:00Z", "type": 4, "name": "Biking", "kcal": 200,
                          "distance_m": 10000, "recording_method": 1}]}
                  res = post(health, hc)
                  assert res == {"days": 1, "sessions": 2, "nights": 1, "skipped": 0}, res
                  synced = lambda: {s["source_key"]: s for s in json.loads(
                      machine.succeed(f"curl -sf {api}/profiles/{anna}/sessions"))}
                  runs = synced()
                  assert (runs["hc-1"]["type"], runs["hc-1"]["distance_m"]) == ("run", 8200), runs
                  assert runs["hc-1"]["source"] == "health_connect", runs
                  machine.succeed(f"curl -sf -X DELETE {api}/profiles/{anna}/sessions/{runs['hc-2']['id']}")
                  post(health, hc)
                  assert set(synced()) == {None, "hc-1"}, synced()
                  newest = take_backup()[-1]
                  machine.succeed(f"curl -sf -X DELETE {api}/profiles/{anna}")
                  post("/profiles/1/entries", {"day": day, "group": "Consumed",
                      "food_id": oats, "grams": 20})
                  copy = "/var/lib/kaloriina/restore.db"
                  machine.succeed(f"install -o kaloriina -g kaloriina -m 0600 {backups}/{newest} {copy}")
                  machine.succeed(
                      f"systemd-run --unit kaloriina-restore -p User=kaloriina -p Group=kaloriina "
                      f"$(command -v kaloriina) serve --db {copy} --port 8099"
                  )
                  machine.wait_for_open_port(8099)
                  machine.succeed(f"curl -sf -o /tmp/anna.json http://127.0.0.1:8099/api/profiles/{anna}/export")
                  machine.succeed("systemctl stop kaloriina-restore")
                  machine.succeed(f"rm -f {copy}*")
                  restored = json.loads(machine.succeed(
                      f"curl -sf {ctype} --data-binary @/tmp/anna.json '{api}/profiles/import?restore=true'"))
                  assert restored["id"] == anna, restored
                  back = json.loads(machine.succeed(f"curl -sf {api}/profiles/{anna}/day/{day}"))
                  entries = [e for g in back["groups"] for e in g["entries"]]
                  assert [e["uid"] for e in entries] == ["anna-entry-1"], entries
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
                  assert sorted(x["name"] for x in back["sessions"]) == ["Running", "Walk"], back["sessions"]
                  weights = json.loads(machine.succeed(f"curl -sf {api}/profiles/{anna}/weights"))
                  assert sorted(w["kg"] for w in weights) == [61, 61.5], weights
                  assert back["weight_source"] == "openscale", back
                  bound = json.loads(machine.succeed(f"curl -sf {api}/profiles/{anna}/sync/openscale"))
                  assert bound["bound_user"]["id"] == 1, bound
                  assert back["activity"] == night, back
                  assert back["pending_sessions"] == [], back
                  assert synced()["hc-1"]["distance_m"] == 8200
                  # The tombstone came back too: the ride stays gone.
                  post(health, hc)
                  assert set(synced()) == {None, "hc-1"}, synced()
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
                      e = {"uid": f"entry-{i:010d}", "day": d, "group": "Consumed", "food": "f",
                           "name": "Kaurapuuro, vedellä", "grams": 250, "amount": "250 g",
                           "nutrients": nutrients, "imported": False,
                           "created_at": f"{d}T08:00:00Z", "time": "08:00"}
                      size += len(json.dumps(e)) + 1
                      entries.append(e)
                      i += 1
                  big = {"format": "kaloriina-profile", "version": 1,
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
                  # copies aren't pruned.
                  machine.succeed("systemctl stop kaloriina")
                  machine.succeed(f"cp -p {db} /root/good.db")
                  before = machine.succeed(f"ls -1 {backups}").split()
                  machine.succeed(f"dd if=/dev/zero of={db} bs=4096 seek=2 count=1 conv=notrunc")
                  machine.fail("sleep 1.1 && systemctl start kaloriina-backup.service")
                  machine.succeed("journalctl -u kaloriina-backup.service | grep -q 'failed its integrity check'")
                  after = machine.succeed(f"ls -1 {backups}").split()
                  assert after == before, (before, after)
                  machine.succeed(f"cp -p /root/good.db {db}")
                  machine.succeed("systemctl reset-failed kaloriina-backup.service")
                  machine.succeed("systemctl start kaloriina")
                  machine.wait_for_open_port(port)

                  machine.succeed("test -z \"$(find /var/lib/kaloriina ! -user kaloriina)\"")
                  # Hardening can't regress unnoticed: exposure must stay at or below 2.0.
                  print(machine.succeed("systemd-analyze security --threshold=20 kaloriina.service | tail -1"))
                  print(machine.succeed("systemd-analyze security --threshold=20 kaloriina-backup.service | tail -1"))
                '';
              };
          } // android.checks or { };

          # Packages -> 'nix build' or 'nix run'
          packages = {
            kaloriina = pkgs.callPackage ./package.nix { };
            default = self'.packages.kaloriina;
          } // android.packages or { };

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
