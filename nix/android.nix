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
  # 1.2.3 → 10203: Android only installs over a lower code.
  versionCode =
    let
      part = i: lib.toInt (builtins.elemAt (lib.splitString "." version) i);
    in
    part 0 * 10000 + part 1 * 100 + part 2;

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
        --version-code ${toString versionCode} --version-name ${version} \
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
    runtimeInputs = [ pkgs.jdk17_headless pkgs.coreutils ];
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
      out=''${2:-kaloriina.apk}
      ${tools}/apksigner sign --ks "$keystore" --ks-key-alias kaloriina \
        --out "$out" ${apk}/kaloriina-unsigned.apk
      ${tools}/apksigner verify --print-certs "$out"
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
    # The package id, the SDK levels and the nine health permissions, as
    # Android reads them from the built APK.
    android-apk = pkgs.runCommand "kaloriina-android-badging" { } ''
      ${tools}/aapt2 dump badging ${apk}/kaloriina-unsigned.apk > badging
      cat badging
      grep -q "^package: name='io.github.tupakkatapa.kaloriina' versionCode='${toString versionCode}'" badging
      grep -qx "minSdkVersion:'35'" badging
      grep -qx "targetSdkVersion:'35'" badging
      for p in READ_ACTIVE_CALORIES_BURNED READ_STEPS READ_EXERCISE READ_SLEEP \
        READ_RESTING_HEART_RATE READ_HEART_RATE_VARIABILITY READ_DISTANCE \
        READ_HEALTH_DATA_IN_BACKGROUND READ_HEALTH_DATA_HISTORY; do
        grep -qx "uses-permission: name='android.permission.health.$p'" badging
      done
      test "$(grep -c "^uses-permission: name='android.permission.health\." badging)" = 9
      touch $out
    '';
    # The phone's logic on the JVM (window, payload, zones, sleep, heart): Payload.java
    # has no android.* imports. The payload is compared with the fixture the
    # server's suite POSTs (tests/api/activity.rs).
    android-unit = pkgs.runCommand "kaloriina-android-unit"
      {
        nativeBuildInputs = [ pkgs.jdk17_headless ];
      } ''
      javac --release 17 -encoding UTF-8 -Xlint:all -Werror -d out \
        ${src}/android/src/io/github/tupakkatapa/kaloriina/Payload.java \
        ${src}/android/test/PayloadTest.java
      java -ea -cp out PayloadTest ${../tests/fixtures/health/payload.json}
      touch $out
    '';
  };
}
