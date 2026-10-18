//! The web UI is embedded at compile time (`include_dir!` in `api`), which
//! cargo can't see: rebuild when anything under `web/` changes.

fn main() {
    println!("cargo:rerun-if-changed=web");
}
