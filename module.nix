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
      example = "Europe/Helsinki";
      description = ''
        IANA time zone that decides which day a scale reading falls on, read
        from the system's tz database. `null`: the system's, else UTC.
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
        description = "Directory for the copies, `kaloriina-<UTC time>.db`.";
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

    # Puts `kaloriina import` and `kaloriina fineli` on PATH; run them as
    # the service user.
    environment.systemPackages = [ cfg.package ];

    systemd.tmpfiles.rules = [
      "d ${cfg.dataDir} 0750 ${cfg.user} ${cfg.group} -"
    ] ++ optional cfg.backup.enable "d ${cfg.backup.dir} 0700 ${cfg.user} ${cfg.group} -";

    # sqlite3's online backup: a consistent snapshot while the server writes,
    # WAL included. The copy is checked before it gets its final name, so
    # pruning and restores only ever see good copies.
    systemd.services.kaloriina-backup = mkIf cfg.backup.enable {
      description = "Back up the kaloriina database";
      path = [ pkgs.sqlite ];
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
        shopt -s nullglob
        dir=${escapeShellArg cfg.backup.dir}
        rm -f "$dir"/kaloriina-*.db.tmp*
        name="$dir/kaloriina-$(date -u +%Y%m%dT%H%M%SZ).db"
        trap 'rm -f "$name.tmp"*' EXIT
        sqlite3 -readonly ${escapeShellArg db} ".backup '$name.tmp'"
        check=$(sqlite3 "$name.tmp" 'PRAGMA integrity_check')
        if [ "$check" != ok ]; then
          echo "backup failed its integrity check, deleted: $check" >&2
          exit 1
        fi
        # One self-contained file: readers of a WAL copy leave -wal/-shm files
        # beside it. The server turns WAL back on when it opens a restored copy.
        sqlite3 "$name.tmp" 'PRAGMA journal_mode = DELETE' >/dev/null
        mv "$name.tmp" "$name"
        echo "backed up to $name"
        copies=("$dir"/kaloriina-*.db)
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
      # Open Food Facts lookups need the network up, not just configured.
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
        # Hardening: one writable directory, outbound HTTPS, nothing else.
        ReadWritePaths = [ cfg.dataDir ];
        # The server reads the newest copy's age (GET /api/backups).
        ReadOnlyPaths = optional (cfg.backup.enable && !hasPrefix "${cfg.dataDir}/" cfg.backup.dir) cfg.backup.dir;
        # AF_UNIX: name lookups go through nscd on NixOS.
        RestrictAddressFamilies = [ "AF_INET" "AF_INET6" "AF_UNIX" ];
        # Ceilings, so a runaway request can't take the host with it. The
        # largest allowed import and its export peak near 620 MiB, page cache
        # included (the VM test measures it and keeps a quarter spare);
        # everyday use needs a fraction of this.
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
