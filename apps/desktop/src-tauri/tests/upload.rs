use mawjivo_lib::{
    contracts::UploadInput,
    media::hash_file,
    profiles::{LocalStore, ProvisionState},
    upload::{UploadEngine, UploadStore, transport::HttpUploadTransport},
};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    io::{Read, Seek, SeekFrom, Write},
    net::{TcpListener, TcpStream},
    path::Path,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::Duration,
};

#[derive(Default)]
struct ServerState {
    parts: BTreeMap<u32, Vec<u8>>,
    sends: BTreeMap<u32, u32>,
    fail_part: Option<u32>,
    complete_calls: u32,
    publish_calls: u32,
    aborted: bool,
    completed: bool,
    final_hash: String,
    total_sent: usize,
    active: usize,
    peak: usize,
    source_change: Option<std::path::PathBuf>,
    foreign_url: bool,
    lose_completion_reply: bool,
    hold_body: bool,
}
struct Server {
    origin: String,
    state: Arc<Mutex<ServerState>>,
    stop: Arc<AtomicBool>,
    thread: Option<thread::JoinHandle<()>>,
}
impl Server {
    fn new() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let state = Arc::new(Mutex::new(ServerState::default()));
        let stop = Arc::new(AtomicBool::new(false));
        let (s, done, root) = (state.clone(), stop.clone(), origin.clone());
        let thread = thread::spawn(move || {
            let mut requests = Vec::new();
            while !done.load(Ordering::Relaxed) {
                if let Ok((stream, _)) = listener.accept() {
                    let (s, root) = (s.clone(), root.clone());
                    requests.push(thread::spawn(move || handle(stream, &root, &s)));
                } else {
                    thread::sleep(Duration::from_millis(5));
                }
            }
            for t in requests {
                t.join().unwrap();
            }
        });
        Self {
            origin,
            state,
            stop,
            thread: Some(thread),
        }
    }
    fn remote(&self) -> HttpUploadTransport {
        HttpUploadTransport::loopback(&self.origin, "test-device").unwrap()
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        self.thread.take().unwrap().join().unwrap();
    }
}
fn handle(mut stream: TcpStream, origin: &str, state: &Mutex<ServerState>) {
    // Winsock accepted sockets inherit the listener's nonblocking mode.
    stream.set_nonblocking(false).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    let mut bytes = Vec::new();
    let boundary;
    loop {
        let mut chunk = [0u8; 8192];
        let n = stream.read(&mut chunk).unwrap();
        if n == 0 {
            return;
        }
        bytes.extend_from_slice(&chunk[..n]);
        if let Some(i) = bytes.windows(4).position(|v| v == b"\r\n\r\n") {
            boundary = i + 4;
            break;
        }
    }
    let headers = String::from_utf8(bytes[..boundary].to_vec()).unwrap();
    let first = headers.lines().next().unwrap();
    let mut words = first.split_whitespace();
    let method = words.next().unwrap();
    let path = words.next().unwrap();
    let size: usize = headers
        .lines()
        .find_map(|line| {
            line.to_lowercase()
                .strip_prefix("content-length:")
                .map(|v| v.trim().parse().unwrap())
        })
        .unwrap_or(0);
    let is_part = method == "PUT" && path.starts_with("/r2/part/");
    if is_part {
        let mut s = state.lock().unwrap();
        s.active += 1;
        s.peak = s.peak.max(s.active);
    }
    while is_part && state.lock().unwrap().hold_body {
        thread::sleep(Duration::from_millis(5));
    }
    while bytes.len() - boundary < size {
        let mut chunk = vec![0u8; 65536];
        // Cancelling a request may close or reset its connection mid-body.
        let n = match stream.read(&mut chunk) {
            Ok(n) => n,
            Err(_) => return,
        };
        if n == 0 {
            return;
        }
        bytes.extend_from_slice(&chunk[..n]);
    }
    let body = &bytes[boundary..boundary + size];
    let mut s = state.lock().unwrap();
    let (mut code, mut value, mut extra) = (200, Value::Null, String::new());
    if method == "PUT" && path.starts_with("/r2/part/") {
        assert!(!headers.to_lowercase().contains("authorization:"));
        let n: u32 = path.trim_start_matches("/r2/part/").parse().unwrap();
        s.total_sent += size;
        *s.sends.entry(n).or_default() += 1;
        if s.fail_part == Some(n) {
            code = 503;
            value = json!({"error":"temporary"});
        } else {
            s.parts.insert(n, body.to_vec());
            extra = format!("ETag: \"opaque-etag-{n}\"\r\n");
        }
        s.active -= 1;
        if let Some(path) = s.source_change.take() {
            std::fs::write(path, b"changed").unwrap();
        }
    } else {
        assert!(
            headers
                .to_lowercase()
                .contains("authorization: bearer test-device")
        );
        if path == "/api/workspaces/space/assets" || path.ends_with("/renew") {
            let v: Value = serde_json::from_slice(body).unwrap();
            let count = if path.ends_with("/renew") {
                v["partNumbers"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|n| n.as_u64().unwrap() as u32)
                    .collect::<Vec<_>>()
            } else {
                (1..=v["bytes"].as_u64().unwrap().div_ceil(16_777_216) as u32).collect()
            };
            value = json!({"assetId":"remote-asset", "multipartId":if s.completed {Value::Null} else {json!("multipart-1")}, "expiresAt":"2099-01-01T00:00:00Z", "parts":if s.completed {vec![]} else {count.into_iter().take(16).map(|n| json!({"partNumber":n,"url":if s.foreign_url {"https://foreign.invalid/r2/part/1".into()} else {format!("{origin}/r2/part/{n}")}})).collect::<Vec<_>>()} });
        } else if path.ends_with("/complete") {
            s.complete_calls += 1;
            let v: Value = serde_json::from_slice(body).unwrap();
            s.final_hash = v["sha256"].as_str().unwrap().into();
            s.completed = true;
            value = json!({"id":"remote-asset","originalName":"العربية.mp4","kind":"video","bytes":s.parts.values().map(Vec::len).sum::<usize>(),"mimeType":"video/mp4","sha256":s.final_hash});
            if s.lose_completion_reply {
                s.lose_completion_reply = false;
                code = 503;
                value = json!({"error":"reply lost after completion"});
            }
        } else if method == "GET" && path.ends_with("/remote-asset") {
            value = json!({"state":if s.completed {"complete"} else {"uploading"},"asset":if s.completed {json!({"id":"remote-asset","originalName":"العربية.mp4","kind":"video","bytes":s.parts.values().map(Vec::len).sum::<usize>(),"mimeType":"video/mp4","sha256":s.final_hash})} else {Value::Null}});
        } else if method == "DELETE" && path.ends_with("/remote-asset") {
            s.aborted = true;
            s.parts.clear();
            code = 204;
        } else {
            s.publish_calls += 1;
            code = 404;
        }
    }
    drop(s);
    let payload = if code == 204 {
        Vec::new()
    } else {
        serde_json::to_vec(&value).unwrap()
    };
    write!(stream, "HTTP/1.1 {code} Test\r\nContent-Length: {}\r\nContent-Type: application/json\r\n{extra}Connection: close\r\n\r\n", payload.len()).unwrap();
    let _ = stream.write_all(&payload);
}
fn engine(path: &Path) -> UploadEngine {
    let local = LocalStore::open(path).unwrap();
    let mut state = ProvisionState::new("aabb");
    state.profile.id = "profile".into();
    local.save_state(&state).unwrap();
    UploadEngine::new(Arc::new(UploadStore::open(path).unwrap()))
}
fn fixture(path: &Path, size: usize) -> UploadInput {
    let bytes: Vec<u8> = (0..size).map(|n| (n % 251) as u8).collect();
    std::fs::write(path, bytes).unwrap();
    serde_json::from_value(json!({"profileId":"profile","workspaceId":"space","fileId":"file-original","sourceAssetId":"file-original","recipeId":null,"manifest":{"sourceAssetId":"file-original","recipeId":null,"originalName":"العربية.mp4","kind":"video","bytes":size,"mimeType":"video/mp4","width":1920,"height":1080,"durationMs":180000}})).unwrap()
}
async fn run(
    engine: &UploadEngine,
    id: &str,
    server: &Server,
) -> Result<(), mawjivo_lib::contracts::AppError> {
    engine
        .run(
            "main",
            id,
            &server.remote(),
            Arc::new(AtomicBool::new(false)),
            Arc::new(|_| {}),
        )
        .await
}
#[tokio::test]
async fn selection_starts_transfer_without_publish() {
    let t = tempfile::tempdir().unwrap();
    let file = t.path().join("العربية.mp4");
    let e = engine(&t.path().join("db"));
    let s = Server::new();
    let id = e.start("main", fixture(&file, 35000000), &file).unwrap();
    run(&e, &id, &s).await.unwrap();
    let state = s.state.lock().unwrap();
    assert!(state.total_sent > 0);
    assert_eq!(state.publish_calls, 0);
    assert_eq!(state.parts[&1].len(), 16 * 1024 * 1024);
    assert_eq!(state.parts[&2].len(), 16 * 1024 * 1024);
    assert!(state.peak <= 2);
    assert_eq!(state.final_hash, hash_file(&file).unwrap());
    assert_eq!(
        state.parts.values().flatten().copied().collect::<Vec<_>>(),
        std::fs::read(&file).unwrap()
    );
    assert_eq!(
        e.prepared("main", &id).unwrap().unwrap().asset_id,
        "remote-asset"
    );
}
#[tokio::test]
async fn resume_after_process_restart_does_not_resend_completed_parts() {
    let t = tempfile::tempdir().unwrap();
    let file = t.path().join("v.mp4");
    let db = t.path().join("db");
    let e = engine(&db);
    let s = Server::new();
    s.state.lock().unwrap().fail_part = Some(2);
    let id = e.start("main", fixture(&file, 35000000), &file).unwrap();
    assert!(run(&e, &id, &s).await.unwrap_err().retryable);
    drop(e);
    s.state.lock().unwrap().fail_part = None;
    let e = engine(&db);
    run(&e, &id, &s).await.unwrap();
    let state = s.state.lock().unwrap();
    assert_eq!(state.sends[&1], 1);
    assert_eq!(state.sends[&2], 2);
    assert_eq!(state.sends[&3], 1);
    assert_eq!(state.final_hash, hash_file(&file).unwrap());
}
#[tokio::test]
async fn reuse_returns_the_same_asset_with_no_additional_bytes() {
    let t = tempfile::tempdir().unwrap();
    let file = t.path().join("v.mp4");
    let e = engine(&t.path().join("db"));
    let s = Server::new();
    let input = fixture(&file, 90000);
    let id = e.start("main", input.clone(), &file).unwrap();
    run(&e, &id, &s).await.unwrap();
    let first = e.prepared("main", &id).unwrap().unwrap();
    let bytes = s.state.lock().unwrap().total_sent;
    let next = e.start("main", input, &file).unwrap();
    run(&e, &next, &s).await.unwrap();
    assert_eq!(first, e.prepared("main", &next).unwrap().unwrap());
    assert_eq!(s.state.lock().unwrap().total_sent, bytes);
}
#[tokio::test]
async fn reuse_from_another_local_session_reports_all_bytes_complete() {
    let t = tempfile::tempdir().unwrap();
    let file = t.path().join("v.mp4");
    let first = engine(&t.path().join("first.db"));
    let s = Server::new();
    let input = fixture(&file, 90000);
    let id = first.start("main", input.clone(), &file).unwrap();
    run(&first, &id, &s).await.unwrap();
    let sent = s.state.lock().unwrap().total_sent;
    let next = engine(&t.path().join("next.db"));
    let id = next.start("main", input, &file).unwrap();
    run(&next, &id, &s).await.unwrap();
    assert_eq!(s.state.lock().unwrap().total_sent, sent);
    let jobs = next.sessions("main", "profile", "space").unwrap();
    assert_eq!(jobs[0].phase, "complete");
    assert_eq!(jobs[0].completed_bytes, jobs[0].total_bytes);
}
#[tokio::test]
async fn source_change_aborts_without_completing_or_publishing() {
    let t = tempfile::tempdir().unwrap();
    let file = t.path().join("v.mp4");
    let e = engine(&t.path().join("db"));
    let s = Server::new();
    let id = e.start("main", fixture(&file, 35000000), &file).unwrap();
    s.state.lock().unwrap().source_change = Some(file.clone());
    let error = run(&e, &id, &s).await.unwrap_err();
    assert_eq!(error.code, "SOURCE_CHANGED");
    let state = s.state.lock().unwrap();
    assert_eq!(state.complete_calls, 0);
    assert_eq!(state.publish_calls, 0);
    assert!(state.aborted);
}
#[tokio::test]
async fn cancellation_preserves_source_and_releases_remote_reservation() {
    let t = tempfile::tempdir().unwrap();
    let file = t.path().join("v.mp4");
    let e = engine(&t.path().join("db"));
    let s = Server::new();
    let id = e.start("main", fixture(&file, 35000000), &file).unwrap();
    s.state.lock().unwrap().fail_part = Some(2);
    assert!(run(&e, &id, &s).await.is_err());
    let before = hash_file(&file).unwrap();
    e.cancel("main", &id, &s.remote()).await.unwrap();
    assert!(file.exists());
    assert_eq!(hash_file(&file).unwrap(), before);
    assert!(s.state.lock().unwrap().aborted);
    assert!(e.prepared("main", &id).unwrap().is_none());
}
#[test]
fn upload_jobs_are_scoped_to_window_profile_and_workspace() {
    let t = tempfile::tempdir().unwrap();
    let file = t.path().join("v.mp4");
    let e = engine(&t.path().join("db"));
    let id = e.start("main", fixture(&file, 9), &file).unwrap();
    assert_eq!(
        e.prepared("other-window", &id).unwrap_err().code,
        "UPLOAD_SCOPE"
    );
    assert_eq!(
        e.sessions("main", "other-profile", "space").unwrap().len(),
        0
    );
    assert_eq!(
        e.sessions("main", "profile", "other-space").unwrap().len(),
        0
    );
}
#[tokio::test]
async fn lost_completion_reply_is_reconciled_without_uploading_again() {
    let t = tempfile::tempdir().unwrap();
    let file = t.path().join("v.mp4");
    let e = engine(&t.path().join("db"));
    let s = Server::new();
    let id = e.start("main", fixture(&file, 90000), &file).unwrap();
    s.state.lock().unwrap().lose_completion_reply = true;
    assert!(run(&e, &id, &s).await.unwrap_err().retryable);
    let before = s.state.lock().unwrap().total_sent;
    run(&e, &id, &s).await.unwrap();
    assert!(e.prepared("main", &id).unwrap().is_some());
    let state = s.state.lock().unwrap();
    assert_eq!(state.total_sent, before);
    assert_eq!(state.complete_calls, 1);
}
#[tokio::test]
async fn foreign_upload_url_never_receives_source_or_device_token() {
    let t = tempfile::tempdir().unwrap();
    let file = t.path().join("v.mp4");
    let e = engine(&t.path().join("db"));
    let s = Server::new();
    let id = e.start("main", fixture(&file, 90000), &file).unwrap();
    s.state.lock().unwrap().foreign_url = true;
    assert_eq!(
        run(&e, &id, &s).await.unwrap_err().code,
        "INVALID_UPLOAD_URL"
    );
    assert_eq!(s.state.lock().unwrap().total_sent, 0);
}
#[test]
fn upload_manifest_cannot_lie_about_source_identity_or_size() {
    let t = tempfile::tempdir().unwrap();
    let file = t.path().join("v.mp4");
    let e = engine(&t.path().join("db"));
    let input = fixture(&file, 9);
    let mut changed = input.clone();
    changed.manifest.bytes += 1;
    assert_eq!(
        e.start("main", changed, &file).unwrap_err().code,
        "INVALID_UPLOAD_MANIFEST"
    );
    let mut changed = input;
    changed.manifest.source_asset_id = "foreign".into();
    assert_eq!(
        e.start("main", changed, &file).unwrap_err().code,
        "INVALID_UPLOAD_MANIFEST"
    );
}
#[tokio::test]
async fn changed_content_with_restored_size_and_mtime_is_rejected_on_resume() {
    let t = tempfile::tempdir().unwrap();
    let file = t.path().join("v.mp4");
    let e = engine(&t.path().join("db"));
    let s = Server::new();
    let id = e.start("main", fixture(&file, 35000000), &file).unwrap();
    s.state.lock().unwrap().fail_part = Some(2);
    assert!(run(&e, &id, &s).await.is_err());
    let modified = std::fs::metadata(&file).unwrap().modified().unwrap();
    let mut local = std::fs::OpenOptions::new().write(true).open(&file).unwrap();
    local.seek(SeekFrom::Start(0)).unwrap();
    local.write_all(b"Z").unwrap();
    local
        .set_times(std::fs::FileTimes::new().set_modified(modified))
        .unwrap();
    drop(local);
    s.state.lock().unwrap().fail_part = None;
    assert_eq!(run(&e, &id, &s).await.unwrap_err().code, "SOURCE_CHANGED");
    let state = s.state.lock().unwrap();
    assert_eq!(state.complete_calls, 0);
    assert!(state.aborted);
    assert_eq!(state.sends[&1], 1);
}
#[tokio::test]
async fn native_dispatch_starts_once_and_cancels_an_active_transfer() {
    use mawjivo_lib::upload::commands::UploadState;
    let t = tempfile::tempdir().unwrap();
    let file = t.path().join("v.mp4");
    let state = Arc::new(UploadState::new(engine(&t.path().join("db"))));
    let s = Server::new();
    let id = state
        .engine
        .start("main", fixture(&file, 35000000), &file)
        .unwrap();
    let before = hash_file(&file).unwrap();
    s.state.lock().unwrap().hold_body = true;
    struct ReleaseBody(Arc<Mutex<ServerState>>);
    impl Drop for ReleaseBody {
        fn drop(&mut self) {
            self.0.lock().unwrap().hold_body = false;
        }
    }
    let release_body = ReleaseBody(s.state.clone());
    // The command returns while streaming continues in the native runtime.
    state
        .launch("main", &id, s.remote(), Arc::new(|_| {}))
        .unwrap();
    state
        .launch("main", &id, s.remote(), Arc::new(|_| {}))
        .unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while s.state.lock().unwrap().active == 0 {
        assert!(
            std::time::Instant::now() < deadline,
            "selection never started transfer"
        );
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    let denied = state.cancel("other", &id, &s.remote()).await.unwrap_err();
    assert_eq!(denied.code, "UPLOAD_SCOPE");
    let result = state.cancel("main", &id, &s.remote()).await;
    drop(release_body);
    result.unwrap();
    assert_eq!(hash_file(&file).unwrap(), before);
    assert_eq!(
        state.engine.sessions("main", "profile", "space").unwrap()[0].phase,
        "cancelled"
    );
    assert!(state.engine.prepared("main", &id).unwrap().is_none());
    let remote = s.state.lock().unwrap();
    assert!(remote.aborted);
    assert_eq!(remote.complete_calls, 0);
    assert_eq!(remote.publish_calls, 0);
    assert_eq!(remote.peak, 1);
}
#[tokio::test]
async fn native_dispatch_reports_a_local_storage_failure_to_the_window() {
    use mawjivo_lib::upload::commands::UploadState;
    let t = tempfile::tempdir().unwrap();
    let db = t.path().join("db");
    let file = t.path().join("v.mp4");
    let state = Arc::new(UploadState::new(engine(&db)));
    let s = Server::new();
    let id = state.engine.start("main", fixture(&file, 90000), &file).unwrap();
    // A real SQLite write failure occurs after start returns, in the native worker.
    rusqlite::Connection::open(&db).unwrap().execute_batch(
        "CREATE TRIGGER upload_disk_full BEFORE UPDATE ON upload_sessions BEGIN SELECT RAISE(ABORT,'disk full fixture'); END;",
    ).unwrap();
    let events = Arc::new(Mutex::new(Vec::new()));
    let received = events.clone();
    state.launch("main", &id, s.remote(), Arc::new(move |event| {
        received.lock().unwrap().push(event);
    })).unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    loop {
        if events.lock().unwrap().iter().any(|event| event.error.is_some()) {
            break;
        }
        assert!(std::time::Instant::now() < deadline, "upload failure was silently lost");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let events = events.lock().unwrap();
    let failure = events.iter().find(|event| event.error.is_some()).unwrap();
    assert_eq!(failure.job_id, id);
    assert_eq!(failure.error.as_ref().unwrap().code, "UPLOAD_STORE");
    assert_eq!(s.state.lock().unwrap().publish_calls, 0);
}
