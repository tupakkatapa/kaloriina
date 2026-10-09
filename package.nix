{ rustPlatform
, lib
, cacert
}:
let
  manifest = (lib.importTOML ./Cargo.toml).package;
in
rustPlatform.buildRustPackage {
  pname = manifest.name;
  inherit (manifest) version;

  src = lib.sourceByRegex ./. [
    "^Cargo.toml$"
    "^Cargo.lock$"
    "^src.*$"
    "^tests.*$"
    "^web.*$"
  ];

  cargoLock.lockFile = ./Cargo.lock;

  # Rust tests run in the sandbox (loopback only); Playwright stays in pre-commit.
  doCheck = true;
  # The HTTP client needs CA roots (even for the plain-HTTP stub servers the
  # tests use); the sandbox has none. Without them the server would still run,
  # with barcode lookup off.
  preCheck = ''
    export SSL_CERT_FILE=${cacert}/etc/ssl/certs/ca-bundle.crt
  '';

  meta = {
    inherit (manifest) description;
    homepage = "https://github.com/tupakkatapa/kaloriina";
    license = lib.licenses.gpl3Plus;
    mainProgram = manifest.name;
  };
}
