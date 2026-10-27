{ config
, lib
, pkgs
, ...
}:
with lib; let
  cfg = config.services.kaloriina;
  loopback = [ "127.0.0.1" "::1" "localhost" ];
  db = "${cfg.dataDir}/kaloriina.db";

  # Shared by the server and the backup job; each adds its own writable
  # paths and network access.
  hardening = {
    User = cfg.user;
    Group = cfg.group;
    UMask = "0077";
    NoNewPrivileges = true;
    ProtectSystem = "strict";
    ProtectHome = true;
    PrivateTmp = true;
    PrivateDevices = true;
    ProtectKernelTunables = true;
    ProtectKernelModules = true;
    ProtectKernelLogs = true;
    ProtectControlGroups = true;
    ProtectClock = true;
    ProtectHostname = true;
    ProtectProc = "invisible";
    ProcSubset = "pid";
    RestrictNamespaces = true;
    RestrictRealtime = true;
    RestrictSUIDSGID = true;
    LockPersonality = true;
    MemoryDenyWriteExecute = true;
    SystemCallArchitectures = "native";
    SystemCallFilter = [ "@system-service" "~@privileged @resources" ];
    CapabilityBoundingSet = "";
    PrivateIPC = true;
    RemoveIPC = true;
  };

  # Where a local client reaches the server: a wildcard or loopback name
  # is loopback; an IPv6 address goes in brackets.
  serverHost = {
    "0.0.0.0" = "127.0.0.1";
    "localhost" = "127.0.0.1";
    "::" = "[::1]";
    "::1" = "[::1]";
  }.${cfg.address} or (if hasInfix ":" cfg.address then "[${cfg.address}]" else cfg.address);
  hooks = imap0 (i: name: cfg.hooks.${name} // { inherit name; credential = "hook-${toString i}"; })
    (attrNames cfg.hooks);
in
{
  options.services.kaloriina = {
    enable = mkEnableOption "kaloriina, a personal food, training and health diary";

    package = mkOption {
      type = types.package;
      default = pkgs.callPackage ./package.nix { };
      defaultText = literalExpression "pkgs.callPackage ./package.nix { }";
      description = ''
        The package to run. Set it to the flake's own build
        (`inputs.kaloriina.packages.${system}.default`) to use the toolchain
        it was tested with instead of the host's.
      '';
    };

    dataDir = mkOption {
      type = types.str;
      default = "/var/lib/kaloriina";
      description = "Directory holding the SQLite database (kaloriina.db).";
    };

    address = mkOption {
      type = types.str;
      default = "127.0.0.1";
      description = ''
        Host address for the service. There is no login: keep the default and
        expose it only over HTTPS (see the README's Security section).
      '';
    };

    port = mkOption {
      type = types.port;
      default = 8080;
      description = "Port number for the service.";
    };

    allowedHosts = mkOption {
      type = types.listOf types.str;
      default = [ ];
      example = [ "kaloriina.example.com" ];
      description = ''
        Host names the app is reached by besides localhost: the name your
        HTTPS proxy forwards. Requests
        naming any other host get 421, which stops DNS rebinding.
      '';
    };

    offUrl = mkOption {
      type = types.str;
      default = "https://world.openfoodfacts.org";
      description = "Open Food Facts base URL used for barcode lookups.";
    };

    timeZone = mkOption {
      type = types.nullOr types.str;
      default = config.time.timeZone;
      defaultText = literalExpression "config.time.timeZone";
      example = "Europe/London";
      description = ''
        IANA time zone for the server's "today": which day a scale reading
        falls on, the latest day a Health Connect sync may name, and the zone
        `kaloriina import-google-health --time-zone` must be given. Read from
        the system's tz database. `null`: the system's, else UTC.
      '';
    };

    openFirewall = mkOption {
      type = types.bool;
      default = false;
      description = ''
        Open `port` in the firewall. This exposes plain HTTP without login:
        only for a TLS-terminating proxy on another host over a trusted link
        (see the README's Security section).
      '';
    };

    user = mkOption {
      type = types.str;
      default = "kaloriina";
      description = "User the service runs as.";
    };

    group = mkOption {
      type = types.str;
      default = cfg.user;
      description = "Group the service runs as.";
    };

    hooks = mkOption {
      default = { };
      example = literalExpression ''
        {
          Anna = {
            url = "http://homeassistant.lan:8123";
            webhookIdFile = "/run/agenix/kaloriina-ha-anna";
            events = [ "workout_started" "workout_finished" ];
          };
        }
      '';
      description = ''
        Home Assistant hooks, keyed by profile name (README → Home Assistant).
        `kaloriina-hooks.service` sets them through the API each time the
        server starts and whenever they change: Nix wins, so a hook set in
        Connections for a profile listed here is overwritten on the next run.
        A name with no profile is skipped with a warning; when several
        profiles share a name, the first is used.
      '';
      type = types.attrsOf (types.submodule {
        options = {
          url = mkOption {
            type = types.str;
            example = "http://homeassistant.lan:8123";
            description = ''
              Home Assistant's base address, `http(s)://host[:port][/path]`,
              without a login, query or fragment.
            '';
          };
          webhookIdFile = mkOption {
            type = types.str;
            example = "/run/agenix/kaloriina-ha-anna";
            description = ''
              File holding the webhook id (surrounding whitespace is trimmed).
              Read by systemd when the unit runs (`LoadCredential=`), never
              copied into the Nix store. An unreadable file fails the unit.
            '';
          };
          events = mkOption {
            type = types.listOf (types.enum [ "workout_started" "workout_finished" ]);
            default = [ "workout_started" "workout_finished" ];
            description = "Events sent to Home Assistant.";
          };
        };
      });
    };

    fineli = {
      enable = mkEnableOption "importing the Fineli food database (THL, CC BY 4.0) from `source`";

      source = mkOption {
        type = types.pathInStore;
        example = literalExpression ''"''${./fineli}"'';
        description = ''
          The unzipped Fineli open-data package (holding `food.csv`), in the
          Nix store. There is no default: fineli.fi puts its downloads behind
          a browser challenge, so `fetchzip` can't fetch them. Download it
          once and add it to the store: `"''${./fineli}"`, a flake input,
          `nix-store --add-fixed`.

          `kaloriina-fineli.service` imports it before the server starts and
          again only when this path changes (stamped in
          `dataDir/.fineli-source`); foods are updated in place and your
          servings kept. A package that can't be read fails the unit; the
          server still starts.
        '';
      };
    };

    backup = {
      enable = mkOption {
        type = types.bool;
        default = true;
        description = ''
          Take checked copies of the database on a timer.
          They sit on the same disk: copy `dir` off the host
          with your own backup job.
        '';
      };

      dir = mkOption {
        type = types.str;
        default = "${cfg.dataDir}/backups";
        defaultText = literalExpression ''"''${config.services.kaloriina.dataDir}/backups"'';
        description = ''
          Directory for the copies, `kaloriina-<UTC time>.db.zst` (zstd; earlier
          ones are `.db`).
        '';
      };

      calendar = mkOption {
        type = types.str;
        default = "daily";
        example = "*-*-* 03:00:00";
        description = ''
          When to take a copy, as systemd's `OnCalendar` (see
          {manpage}`systemd.time(7)`). A run missed while the host was off
          happens at the next boot.
        '';
      };

      keep = mkOption {
        type = types.ints.positive;
        default = 14;
        description = "How many of the newest copies to keep; older ones are deleted.";
      };

      onFailure = mkOption {
        type = types.listOf types.str;
        default = [ ];
        example = [ "notify-failure@%n.service" ];
        description = ''
          Units started when a backup run fails (systemd `OnFailure=`), so a
          failed copy reaches you instead of only the journal.
        '';
      };
    };
  };

  config = mkIf cfg.enable {
    warnings =
      # In a container the address is its private link to the host's proxy.
      optional (!elem cfg.address loopback && !config.boot.isContainer) ''
        services.kaloriina.address = "${cfg.address}" serves plain HTTP without login beyond this host; keep it on 127.0.0.1 behind an HTTPS proxy (README, Security).
      ''
      ++ optional (cfg.openFirewall && elem cfg.address loopback) ''
        services.kaloriina.openFirewall opens port ${toString cfg.port}, but the app only listens on ${cfg.address}.
      '';

    # `kaloriina` on PATH works on the service's database; root's runs as the
    # service user, so the files it writes (the WAL too) stay the service's.
    environment.systemPackages = [
      (pkgs.writeShellScriptBin "kaloriina" ''
        export KALORIINA_DB="''${KALORIINA_DB-${db}}"
        if [ "$EUID" -eq 0 ]; then
          exec ${pkgs.util-linux}/bin/runuser -u ${escapeShellArg cfg.user} -- ${getExe cfg.package} "$@"
        fi
        exec ${getExe cfg.package} "$@"
      '')
    ];

    systemd.tmpfiles.rules = [
      "d ${cfg.dataDir} 0750 ${cfg.user} ${cfg.group} -"
    ] ++ optional cfg.backup.enable "d ${cfg.backup.dir} 0700 ${cfg.user} ${cfg.group} -";

    # `VACUUM INTO`: a consistent snapshot while the server writes, WAL
    # included, compact (free pages left out). The copy is checked, then
    # compressed and its archive tested, before it gets its final name, so
    # pruning and restores only ever see good copies. During a run `dir`
    # holds keep + 1 copies.
    systemd.services.kaloriina-backup = mkIf cfg.backup.enable {
      description = "Back up the kaloriina database";
      path = [ pkgs.sqlite pkgs.zstd ];
      # A copy taken by hand is never refused for coming too soon after another.
      startLimitIntervalSec = 0;
      inherit (cfg.backup) onFailure;
      serviceConfig = hardening // {
        Type = "oneshot";
        # A WAL reader writes the -shm index (and creates it while the server
        # is stopped), so the data directory stays writable; `-readonly`
        # keeps the database itself untouched.
        ReadWritePaths = [ cfg.dataDir cfg.backup.dir ];
        PrivateNetwork = true;
        RestrictAddressFamilies = "none";
      };
      script = ''
        set -o pipefail
        shopt -s nullglob extglob
        dir=${escapeShellArg cfg.backup.dir}
        rm -f "$dir"/kaloriina-*.tmp*
        name="$dir/kaloriina-$(date -u +%Y%m%dT%H%M%SZ).db"
        trap 'rm -f "$name.tmp"* "$name.zst.tmp"' EXIT
        sqlite3 -readonly ${escapeShellArg db} "VACUUM INTO '$name.tmp'"
        check=$(sqlite3 "$name.tmp" 'PRAGMA integrity_check')
        if [ "$check" != ok ]; then
          echo "backup failed its integrity check, deleted: $check" >&2
          exit 1
        fi
        # One self-contained file, whatever mode the copy was written in:
        # readers of a WAL copy leave -wal/-shm files beside it. The server
        # turns WAL back on when it opens a restored copy.
        sqlite3 "$name.tmp" 'PRAGMA journal_mode = DELETE' >/dev/null
        # Through stdout: writing a file, zstd copies its owner (`fchown`,
        # which the syscall filter's ~@privileged kills).
        zstd -q -T0 -10 -c "$name.tmp" > "$name.zst.tmp"
        zstd -tq "$name.zst.tmp"
        mv "$name.zst.tmp" "$name.zst"
        echo "backed up to $name.zst"
        # Oldest first by name, compressed or not.
        copies=("$dir"/kaloriina-*Z.db?(.zst))
        excess=$(( ''${#copies[@]} - ${toString cfg.backup.keep} ))
        if [ "$excess" -gt 0 ]; then
          rm -f -- "''${copies[@]:0:excess}"
        fi
      '';
    };

    systemd.timers.kaloriina-backup = mkIf cfg.backup.enable {
      wantedBy = [ "timers.target" ];
      timerConfig = {
        OnCalendar = cfg.backup.calendar;
        Persistent = true;
      };
    };

    systemd.services.kaloriina = {
      # Open Food Facts lookups and Home Assistant hooks need the network
      # up, not just configured.
      wants = [ "network-online.target" ];
      after = [ "network-online.target" ];
      wantedBy = [ "multi-user.target" ];
      # A failure that repeats on every start (a migration that can't run)
      # stops after five tries and shows as failed, instead of looping.
      startLimitIntervalSec = 300;
      startLimitBurst = 5;
      serviceConfig = hardening // {
        Restart = "on-failure";
        # Back off so a transient failure (port still held during a switch)
        # doesn't exhaust the start limit within a second.
        RestartSec = "5s";
        # The server drops requests still open 10 s after a stop; this is
        # the outer bound, so a deploy never waits systemd's default 90 s.
        TimeoutStopSec = "20s";
        # Hardening: one writable directory, outbound HTTPS (Open Food Facts)
        # and the profiles' Home Assistant hooks (plain HTTP on the LAN: keep
        # it reachable when tightening with IPAddressAllow=), nothing else.
        ReadWritePaths = [ cfg.dataDir ];
        # The server reads the newest copy's age (GET /api/backups).
        ReadOnlyPaths = optional (cfg.backup.enable && !hasPrefix "${cfg.dataDir}/" cfg.backup.dir) cfg.backup.dir;
        # AF_UNIX: name lookups go through nscd on NixOS.
        RestrictAddressFamilies = [ "AF_INET" "AF_INET6" "AF_UNIX" ];
        # Ceilings, so a runaway request can't take the host with it. The
        # largest allowed profile import and its export, and the largest
        # Google Health import, each stay under 3/4 of this, page cache
        # included (the VM test measures both); imports run one at a time
        # (a second is 503 `busy`); everyday use needs a fraction of this.
        MemoryMax = "1G";
        TasksMax = 64;
      };
      script = ''
        exec ${getExe cfg.package} serve \
          --db ${escapeShellArg db} \
          --address ${escapeShellArg cfg.address} \
          --port ${toString cfg.port} \
          --off-url ${escapeShellArg cfg.offUrl} \
          ${optionalString (cfg.timeZone != null) "--time-zone ${escapeShellArg cfg.timeZone}"} \
          ${optionalString cfg.backup.enable "--backup-dir ${escapeShellArg cfg.backup.dir}"} \
          ${concatMapStringsSep " " (h: "--allowed-host ${escapeShellArg h}") cfg.allowedHosts}
      '';
    };

    # Imports the pinned Fineli package when it changed. Before the server,
    # not after: the server (Type=simple) is "started" before it has
    # migrated, and two migrations must never race. On a switch it re-runs
    # beside the live server; the database is current by then, and the
    # import is one transaction.
    systemd.services.kaloriina-fineli = mkIf cfg.fineli.enable {
      description = "Import the Fineli food database into kaloriina";
      before = [ "kaloriina.service" ];
      partOf = [ "kaloriina.service" ];
      # Wanted, not required: a bad package never keeps the app down.
      wantedBy = [ "kaloriina.service" ];
      serviceConfig = hardening // {
        Type = "oneshot";
        RemainAfterExit = true;
        # It opens the database first, which migrates it: on a large file
        # and a slow disk that outlasts the default 90 s.
        TimeoutStartSec = "infinity";
        ReadWritePaths = [ cfg.dataDir ];
        PrivateNetwork = true;
        RestrictAddressFamilies = "none";
      };
      script = ''
        stamp=${escapeShellArg "${cfg.dataDir}/.fineli-source"}
        source=${escapeShellArg cfg.fineli.source}
        if [ "$(cat "$stamp" 2>/dev/null)" = "$source" ]; then
          echo "fineli: $source already imported, skipped"
          exit 0
        fi
        ${getExe cfg.package} fineli --create --db ${escapeShellArg db} "$source"
        echo "$source" > "$stamp"
      '';
    };

    # Sets the declared hooks through the API on every server start: Nix wins
    # over Connections. A refused hook fails the unit after the rest are set.
    systemd.services.kaloriina-hooks = mkIf (cfg.hooks != { }) {
      description = "Set kaloriina's declared Home Assistant hooks";
      requires = [ "kaloriina.service" ];
      after = [ "kaloriina.service" ];
      partOf = [ "kaloriina.service" ];
      wantedBy = [ "kaloriina.service" ];
      path = [ pkgs.curl pkgs.jq ];
      serviceConfig = hardening // {
        Type = "oneshot";
        RemainAfterExit = true;
        LoadCredential = map (h: "${h.credential}:${h.webhookIdFile}") hooks;
        # Only the server.
        RestrictAddressFamilies = [ "AF_INET" "AF_INET6" ];
        IPAddressDeny = "any";
        IPAddressAllow = [ "localhost" ] ++ optional (!elem cfg.address (loopback ++ [ "0.0.0.0" "::" ])) cfg.address;
      };
      script = ''
        set -uo pipefail
        api=http://${serverHost}:${toString cfg.port}/api
        # Loopback names always pass the server's host check (allowedHosts);
        # no Origin or Sec-Fetch-Site, so its cross-site check lets writes by.
        call() { curl -sS --fail-with-body -H 'Host: localhost' "$@"; }
        # The server may still be starting.
        if ! profiles=$(call --retry 30 --retry-connrefused --retry-delay 1 "$api/profiles"); then
          echo "kaloriina didn't answer at $api" >&2
          exit 1
        fi
        failed=0
        ${concatMapStrings (h: ''
          name=${escapeShellArg h.name}
          pid=$(jq -r --arg n "$name" 'first(.[] | select(.name == $n) | .id) // empty' <<<"$profiles")
          if [ -z "$pid" ]; then
            echo "<4>services.kaloriina.hooks.$name: no profile named $name, skipped"
          # The id goes through a pipe: never on a command line.
          elif out=$(jq -n --arg url ${escapeShellArg h.url} --argjson events ${escapeShellArg (builtins.toJSON h.events)} \
              --rawfile id "$CREDENTIALS_DIRECTORY/${h.credential}" \
              '{url: $url, webhook_id: ($id | trim), events: $events}' |
              call -X PUT -H 'content-type: application/json' --data-binary @- "$api/profiles/$pid/hooks/home-assistant"); then
            echo "services.kaloriina.hooks.$name: set on profile $pid"
          else
            echo "<3>services.kaloriina.hooks.$name: not set: $out"
            failed=1
          fi
        '') hooks}
        exit "$failed"
      '';
    };

    networking.firewall = mkIf cfg.openFirewall {
      allowedTCPPorts = [ cfg.port ];
    };

    users.users = mkIf (cfg.user == "kaloriina") {
      kaloriina = {
        isSystemUser = true;
        inherit (cfg) group;
      };
    };

    users.groups = mkIf (cfg.group == "kaloriina") {
      kaloriina = { };
    };
  };
}
