//! The server must keep serving the diary when no TLS roots load; only the
//! Open Food Facts lookup depends on them.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::thread::sleep;
use std::time::Duration;

/// The running server and its scratch directory; both cleaned up on drop.
struct Server(Child, PathBuf);

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = std::fs::remove_dir_all(&self.1);
    }
}

fn request(port: u16, raw: &str) -> Option<String> {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).ok()?;
    stream.write_all(raw.as_bytes()).ok()?;
    let mut out = String::new();
    stream.read_to_string(&mut out).ok()?;
    Some(out)
}

#[test]
fn serves_without_ca_certificates() {
    let dir = std::env::temp_dir().join(format!("kaloriina-no-tls-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let empty = dir.join("empty.pem");
    std::fs::write(&empty, "").unwrap();
    let port = TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();

    let mut server = Server(
        Command::new(env!("CARGO_BIN_EXE_kaloriina"))
            .args(["serve", "--db", ":memory:", "--port", &port.to_string()])
            .env("SSL_CERT_FILE", &empty)
            .env("SSL_CERT_DIR", dir.join("none"))
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
        dir.clone(),
    );

    let get = "GET /api/meta HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n";
    let mut reply = None;
    for _ in 0..100 {
        if let Some(status) = server.0.try_wait().unwrap() {
            panic!("server exited at startup: {status}");
        }
        reply = request(port, get);
        if reply.is_some() {
            break;
        }
        sleep(Duration::from_millis(50));
    }
    assert!(reply.expect("server answered").starts_with("HTTP/1.1 200"));

    let body = "{}";
    let lookup = format!(
        "POST /api/foods/barcode/6408430000258 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\
         Content-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    );
    let reply = request(port, &lookup).unwrap();
    assert!(reply.starts_with("HTTP/1.1 502"), "{reply}");
    assert!(reply.contains("unavailable"), "{reply}");
}
