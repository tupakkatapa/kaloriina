# The Android companion: the APK, unsigned, built from Java with
# framework APIs only (no Gradle), the signing app, and its checks. x86_64
# Linux only (androidenv's tools are x86_64 builds). The SDK is unfree: it
# comes from a separate nixpkgs import so its licence doesn't reach the other
# outputs, and `nix flake check` downloads it (~200 MB) once.
{ inputs, pkgs, system }:
let
  inherit (pkgs) lib;
  androidPkgs = import inputs.nixpkgs {
    inherit system;
    config = {
      allowUnfree = true;
      android_sdk.accept_license = true;
    };
  };
  sdk = (androidPkgs.androidenv.composeAndroidPackages {
    platformVersions = [ "35" ];
    buildToolsVersions = [ "35.0.0" ];
    includeEmulator = false;
    includeSystemImages = false;
    includeNDK = false;
  }).androidsdk;
  tools = "${sdk}/libexec/android-sdk/build-tools/35.0.0";
  androidJar = "${sdk}/libexec/android-sdk/platforms/android-35/android.jar";

  inherit ((lib.importTOML ../Cargo.toml).package) version;
  # Android installs only over a lower or equal code, so the code follows the
  # commit's time: minutes since Nov 2023, never lower for a later commit and
  # within an int32 for 4000 years. The name says which commit it is.
  versionCode = (inputs.self.lastModified - 1700000000) / 60;
  versionName = "${version}+${inputs.self.shortRev or inputs.self.dirtyShortRev}";
  # The released app's signer certificate (a digest, not a secret). Android
  # refuses an update signed by any other key ("App not installed").
  signer = lib.fileContents ../android/signer.sha256;

  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [ ../android ../web/icon.svg ];
  };

  apk = pkgs.stdenv.mkDerivation {
    pname = "kaloriina-android";
    inherit version src;
    nativeBuildInputs = [ pkgs.jdk17_headless pkgs.zip pkgs.librsvg ];
    # No R class: the code never names a resource id (the UI is built in
    # code), so javac needs only android.jar.
    buildPhase = ''
      runHook preBuild
      cd android
      mkdir -p res/mipmap-xxxhdpi classes dex
      rsvg-convert -w 192 -h 192 ../web/icon.svg > res/mipmap-xxxhdpi/ic_launcher.png
      ${tools}/aapt2 compile --dir res -o res.zip
      ${tools}/aapt2 link -I ${androidJar} --manifest AndroidManifest.xml \
        --min-sdk-version 35 --target-sdk-version 35 \
        --version-code ${toString versionCode} --version-name ${versionName} \
        -o base.apk res.zip
      javac --release 17 -encoding UTF-8 -Xlint:all -Werror -classpath ${androidJar} -d classes \
        $(find src -name '*.java')
      # d8 warns on stderr; a warning fails the build like javac's. Build-tools
      # 35.0.0's d8 knows API levels up to 34: the dex targets 34 (nothing in
      # Java 17 needs more), the manifest still requires 35.
      ${tools}/d8 --release --min-api 34 --lib ${androidJar} --output dex \
        $(find classes -name '*.class') 2> d8.log
      if [ -s d8.log ]; then cat d8.log; exit 1; fi
      # Fixed times, no extra fields: the same source gives the same APK.
      touch -d @$SOURCE_DATE_EPOCH dex/classes.dex
      (cd dex && zip -X -D ../base.apk classes.dex)
      ${tools}/zipalign -f 4 base.apk aligned.apk
      runHook postBuild
    '';
    installPhase = ''
      install -Dm644 aligned.apk $out/kaloriina-unsigned.apk
    '';
  };

  sign-apk = pkgs.writeShellApplication {
    name = "sign-apk";
    runtimeInputs = [ pkgs.jdk17_headless pkgs.coreutils pkgs.gnused ];
    text = ''
      if [ $# -lt 1 ] || [ $# -gt 2 ]; then
        echo "usage: nix run .#sign-apk -- <keystore> [out.apk]" >&2
        exit 2
      fi
      keystore=$(realpath "$1")
      case "$keystore" in
        /nix/store/*)
          echo "sign-apk: keep the keystore out of the Nix store (it's world-readable)" >&2
          exit 2
          ;;
      esac
      mode=$(stat -c %a "$keystore")
      if (( 8#$mode & 8#044 )); then
        echo "sign-apk: warning: $keystore is group- or world-readable (mode $mode); chmod 600 it" >&2
      fi
      out=''${2:-kaloriina.apk}
      ${tools}/apksigner sign --ks "$keystore" --ks-key-alias kaloriina \
        --out "$out" ${apk}/kaloriina-unsigned.apk
      certs=$(${tools}/apksigner verify --print-certs "$out")
      echo "$certs"
      got=$(echo "$certs" | sed -n 's/^Signer #1 certificate SHA-256 digest: //p')
      if [ "$got" != "${signer}" ]; then
        rm -f "$out" "$out.idsig"
        echo "sign-apk: signed with a different key ($got) than the released app (${signer});" \
          "the phone will refuse it as an update. Use the original keystore, or update" \
          "android/signer.sha256 knowing every install must be uninstalled first." >&2
        exit 1
      fi
    '';
  };
in
{
  packages.kaloriina-android = apk;

  apps.sign-apk = {
    type = "app";
    program = "${sign-apk}/bin/sign-apk";
    meta.description = "Sign the Android app with your keystore";
  };

  checks = {
    # The package id, the SDK levels and exactly these 29 health permissions (9
    # required, 20 optional; never exercise routes), as Android reads them from
    # the built APK.
    android-apk = pkgs.runCommand "kaloriina-android-badging" { } ''
      ${tools}/aapt2 dump badging ${apk}/kaloriina-unsigned.apk > badging
      cat badging
      grep -q "^package: name='io.github.tupakkatapa.kaloriina' versionCode='${toString versionCode}' versionName='${versionName}'" badging
      grep -qx "minSdkVersion:'35'" badging
      grep -qx "targetSdkVersion:'35'" badging
      for p in READ_ACTIVE_CALORIES_BURNED READ_STEPS READ_EXERCISE READ_SLEEP \
        READ_RESTING_HEART_RATE READ_HEART_RATE_VARIABILITY READ_DISTANCE \
        READ_WEIGHT READ_BODY_FAT READ_LEAN_BODY_MASS READ_BONE_MASS \
        READ_BASAL_METABOLIC_RATE READ_HEIGHT READ_TOTAL_CALORIES_BURNED \
        READ_HEART_RATE READ_OXYGEN_SATURATION READ_RESPIRATORY_RATE \
        READ_BODY_TEMPERATURE READ_SKIN_TEMPERATURE READ_VO2_MAX \
        READ_FLOORS_CLIMBED READ_ELEVATION_GAINED READ_HYDRATION \
        READ_BLOOD_PRESSURE READ_BLOOD_GLUCOSE READ_SPEED READ_POWER \
        READ_HEALTH_DATA_IN_BACKGROUND READ_HEALTH_DATA_HISTORY; do
        grep -qx "uses-permission: name='android.permission.health.$p'" badging
      done
      test "$(grep -c "^uses-permission: name='android.permission.health\." badging)" = 29
      # The sync job's network constraint needs it (else a crash at start).
      grep -qx "uses-permission: name='android.permission.ACCESS_NETWORK_STATE'" badging
      # A phone-sized UI: both screens portrait only (orientation 1).
      ${tools}/aapt2 dump xmltree --file AndroidManifest.xml ${apk}/kaloriina-unsigned.apk \
        | grep -c 'screenOrientation.*=1' | grep -qx 2
      touch $out
    '';
    # The phone's logic on the JVM (windows, the payload, zones, heart, pages, the
    # sync against a fake Health Connect, the run's loop): Payload.java, Window.java,
    # Kinds.java and Batch.java have no android.* imports. It reads the fixtures
    # the server's suite shares (tests/fixtures/health).
    android-unit = pkgs.runCommand "kaloriina-android-unit"
      {
        nativeBuildInputs = [ pkgs.jdk17_headless ];
      } ''
      javac --release 17 -encoding UTF-8 -Xlint:all -Werror -d out \
        ${src}/android/src/io/github/tupakkatapa/kaloriina/{Payload,Window,Kinds,Batch}.java \
        ${src}/android/test/{PayloadTest,WindowTest,BatchTest}.java
      java -ea -cp out PayloadTest ${../tests/fixtures/health}
      touch $out
    '';
  };
}
