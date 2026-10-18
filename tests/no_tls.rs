//! The server must keep serving the diary when no TLS roots load; only the
//! Open Food Facts lookup and `https://` hooks depend on them.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, PoisonError};
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

/// One server at a time: a port picked free and let go could otherwise be
/// another test's stand-in by the time its server binds.
static ONE_AT_A_TIME: Mutex<()> = Mutex::new(());

/// `kaloriina serve` on a free port with no CA certificates to load,
/// answering.
fn serve_without_roots(name: &str) -> (Server, u16) {
    let dir = std::env::temp_dir().join(format!("kaloriina-{name}-{}", std::process::id()));
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
        dir,
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
    (server, port)
}

/// A JSON request.
fn send_json(port: u16, method: &str, path: &str, body: &str) -> String {
    let raw = format!(
        "{method} {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\
         Content-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    );
    request(port, &raw).unwrap()
}

#[test]
fn serves_without_ca_certificates() {
    let _one = ONE_AT_A_TIME.lock().unwrap_or_else(PoisonError::into_inner);
    let (_server, port) = serve_without_roots("no-tls");
    let reply = send_json(port, "POST", "/api/foods/barcode/6408430000258", "{}");
    assert!(reply.starts_with("HTTP/1.1 502"), "{reply}");
    assert!(reply.contains("unavailable"), "{reply}");
}

#[test]
fn hooks_work_without_tls_roots() {
    let _one = ONE_AT_A_TIME.lock().unwrap_or_else(PoisonError::into_inner);
    let (_server, port) = serve_without_roots("no-tls-hooks");
    // A stand-in Home Assistant: answers one call 200.
    let ha = TcpListener::bind("127.0.0.1:0").unwrap();
    let ha_port = ha.local_addr().unwrap().port();
    let stub = std::thread::spawn(move || {
        let (mut socket, _) = ha.accept().unwrap();
        let mut seen = [0; 4096];
        let n = socket.read(&mut seen).unwrap();
        socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            .unwrap();
        String::from_utf8_lossy(&seen[..n]).into_owned()
    });
    let hook = "/api/profiles/1/hooks/home-assistant";
    let body =
        format!(r#"{{"url":"http://127.0.0.1:{ha_port}","webhook_id":"kaloriina","events":[]}}"#);
    let reply = send_json(port, "PUT", hook, &body);
    assert!(reply.starts_with("HTTP/1.1 200"), "{reply}");
    let reply = send_json(
        port,
        "POST",
        &format!("{hook}/events"),
        r#"{"event":"test"}"#,
    );
    assert!(reply.contains(r#""ok":true"#), "{reply}");
    assert!(
        stub.join()
            .unwrap()
            .starts_with("POST /api/webhook/kaloriina ")
    );
}
