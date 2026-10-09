# Kaloriina

Self-hosted food, training and health diary. One Rust binary, one SQLite file, built for a phone browser.

```bash
nix run github:tupakkatapa/kaloriina -- serve --db ./kaloriina.db
```

NixOS module: [`module.nix`](module.nix).

## Android

A WebView shell around the app that also syncs Health Connect. Android 15 or newer.

```bash
# Once: a signing key (alias must be kaloriina)
keytool -genkeypair -keystore kaloriina.jks -alias kaloriina -keyalg RSA -keysize 4096 -validity 10000

# Build and sign, writes ./kaloriina.apk
nix run .#sign-apk -- kaloriina.jks
```

## Security

There is no login. Keep it on `127.0.0.1` and reach it only over your WireGuard network, through an HTTPS reverse proxy.
