pub mod progress;
pub mod session;
pub mod transport;
pub mod commands;
pub use session::{UploadJob, UploadStore};
use crate::contracts::{AppError, MediaAsset, PreparedAsset, SignedPart, UploadInput, UploadTicket, UploadedPart};
use progress::{ProgressSink, ProgressTracker};
use session::{PART_BYTES, PartProof, UploadSession, source_changed, stamp};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, path::Path, sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}}, time::{Duration, Instant}};
use tokio::io::AsyncReadExt;
use transport::{HttpUploadTransport, cancelled, valid_id};
pub struct UploadEngine {
    pub store: Arc<UploadStore>,
    locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    slots: tokio::sync::Semaphore,
    starts: Mutex<()>,
}
fn internal() -> AppError { AppError::new("UPLOAD_STATE", "تعذر متابعة عملية الرفع.") }
fn check_cancel(flag: &AtomicBool) -> Result<(), AppError> { if flag.load(Ordering::Relaxed) { Err(cancelled()) } else { Ok(()) } }
fn hex(bytes: impl AsRef<[u8]>) -> String { bytes.as_ref().iter().map(|b| format!("{b:02x}")).collect() }
async fn hash_source(s: &UploadSession, flag: &AtomicBool) -> Result<String, AppError> {
    s.check_source()?; let mut file = tokio::fs::File::open(&s.path).await.map_err(|_| source_changed())?;
    let mut hasher = Sha256::new(); let mut buffer = vec![0; 262144];
    loop { check_cancel(flag)?; let n = file.read(&mut buffer).await.map_err(|_| source_changed())?; if n == 0 { break; } hasher.update(&buffer[..n]); }
    s.check_source()?; Ok(hex(hasher.finalize()))
}
fn checked_input(input: &UploadInput, bytes: u64) -> Result<(), AppError> {
    let m = &input.manifest;
    if [&input.profile_id, &input.workspace_id, &input.file_id, &input.source_asset_id].iter().any(|id| !valid_id(id))
        || input.recipe_id.as_ref().is_some_and(|id| id.is_empty() || id.len() > 2048)
        || input.source_asset_id != m.source_asset_id || input.recipe_id != m.recipe_id
        || (input.recipe_id.is_none() && input.file_id != input.source_asset_id)
        || m.bytes != bytes || bytes == 0 || bytes > 9_000_000_000
        || m.original_name.is_empty() || m.original_name.encode_utf16().count() > 255 || m.original_name == "." || m.original_name == ".."
        || m.original_name.chars().any(|c| c.is_control() || c == '/' || c == '\\')
        || !m.mime_type.starts_with(if m.kind == crate::contracts::MediaKind::Image { "image/" } else { "video/" })
    { return Err(AppError::new("INVALID_UPLOAD_MANIFEST", "بيانات الرفع لا تطابق الملف المختار.")); }
    Ok(())
}
impl UploadEngine {
    pub fn new(store: Arc<UploadStore>) -> Self { Self { store, locks: Mutex::new(HashMap::new()), slots: tokio::sync::Semaphore::new(2), starts: Mutex::new(()) } }
    pub fn start(&self, owner: &str, input: UploadInput, path: &Path) -> Result<String, AppError> {
        let _lock = self.starts.lock().map_err(|_| internal())?;
        let path = path.canonicalize().map_err(|_| source_changed())?;
        let (bytes, modified) = stamp(&path)?; checked_input(&input, bytes)?;
        if let Some(mut old) = self.store.find(owner, &input)? {
            if old.input != input || old.path != path || old.modified != modified { return Err(source_changed()); }
            if old.phase == "complete" { old.phase = "pending".into(); old.ready = None; self.store.save(&old)?; }
            return Ok(old.id);
        }
        let s = UploadSession { id: uuid::Uuid::new_v4().to_string(), owner: owner.into(), input, path, modified, asset_id: None, parts: Vec::new(), sha256: None, phase: "pending".into(), ready: None, error: None };
        self.store.save(&s)?; Ok(s.id)
    }
    fn job_lock(&self, id: &str) -> Result<Arc<tokio::sync::Mutex<()>>, AppError> {
        Ok(self.locks.lock().map_err(|_| internal())?.entry(id.into()).or_insert_with(|| Arc::new(tokio::sync::Mutex::new(()))).clone())
    }
    pub fn prepared(&self, owner: &str, id: &str) -> Result<Option<PreparedAsset>, AppError> { Ok(self.store.get(owner,id)?.ready) }
    pub fn sessions(&self, owner: &str, profile: &str, workspace: &str) -> Result<Vec<UploadJob>, AppError> { Ok(self.store.list(owner,profile,workspace)?.iter().map(UploadSession::public).collect()) }
    pub async fn run(&self, owner: &str, id: &str, remote: &HttpUploadTransport, flag: Arc<AtomicBool>, sink: ProgressSink) -> Result<(), AppError> {
        self.store.get(owner,id)?;
        let lock = self.job_lock(id)?; let _guard = lock.lock().await;
        let cancellation = async { loop { if flag.load(Ordering::Relaxed) { break; } tokio::time::sleep(Duration::from_millis(100)).await; } };
        let _slot = tokio::select! { permit = self.slots.acquire() => permit.map_err(|_| internal())?, _ = cancellation => return Err(cancelled()) };
        let mut s = self.store.get(owner,id)?;
        if s.phase == "cancelled" { return Err(cancelled()); }
        if s.phase == "complete" { return Ok(()); }
        if s.phase == "cancelling" { return self.cancel_locked(&mut s, remote).await; }
        let tracker = Arc::new(Mutex::new(ProgressTracker::new(id, s.input.manifest.bytes, s.completed_bytes(), sink)));
        let result = self.run_inner(&mut s, remote, flag.clone(), tracker.clone()).await;
        if let Err(error) = &result {
            s.ready = None; s.error = Some(error.clone());
            if error.code == "SOURCE_CHANGED" || error.code == "UPLOAD_CANCELLED" {
                s.phase = "cancelling".into(); self.store.save(&s)?;
                let cleanup = self.cancel_locked(&mut s, remote).await;
                if error.code == "SOURCE_CHANGED" && cleanup.is_ok() { s.phase = "failed".into(); }
                // Unconfirmed deletion remains cancelling and keeps its cloud capacity.
                s.error = Some(error.clone());
            } else { s.phase = if error.retryable { "paused" } else { "failed" }.into(); }
            self.store.save(&s)?;
        }
        let mut p = tracker.lock().map_err(|_| internal())?;
        p.asset_id = s.asset_id.clone(); p.phase = s.phase.clone(); p.emit(s.completed_bytes(), true, s.error.clone());
        result
    }
    async fn run_inner(&self, s: &mut UploadSession, remote: &HttpUploadTransport, flag: Arc<AtomicBool>, tracker: Arc<Mutex<ProgressTracker>>) -> Result<(), AppError> {
        check_cancel(&flag)?; s.check_source()?; s.error = None; s.ready = None;
        let workspace = s.input.workspace_id.clone();
        let mut completing = false;
        let mut ticket: Option<UploadTicket> = None;
        if let Some(id) = &s.asset_id {
            let status = remote.status(&workspace,id).await?;
            if status.state == "complete" {
                let actual = hash_source(s,&flag).await?;
                let asset = status.asset.ok_or_else(internal)?;
                if s.sha256.as_ref().is_some_and(|sha| sha != &actual) { return Err(source_changed()); }
                s.sha256 = Some(actual); return self.finish(s, asset);
            }
            if status.state == "deleted" { s.asset_id = None; s.parts.clear(); s.sha256 = None; self.store.save(s)?; }
            else if status.state == "completing" { completing = true; }
            else if status.state != "uploading" { let mut e = internal(); e.retryable = true; return Err(e); }
        }
        if s.asset_id.is_none() {
            let started = remote.begin(&workspace, &s.input.manifest).await?;
            if !valid_id(&started.asset_id) { return Err(internal()); }
            s.asset_id = Some(started.asset_id.clone()); self.store.save(s)?;
            if started.multipart_id.is_none() {
                let status = remote.status(&workspace, &started.asset_id).await?;
                if status.state != "complete" { return Err(internal()); }
                s.sha256 = Some(hash_source(s,&flag).await?);
                return self.finish(s,status.asset.ok_or_else(internal)?);
            }
            ticket = Some(started);
        }
        let asset_id = s.asset_id.clone().ok_or_else(internal)?;
        {
            let mut p = tracker.lock().map_err(|_| internal())?; p.asset_id = Some(asset_id.clone()); p.phase = "uploading".into(); p.emit(s.completed_bytes(), true, None);
        }
        s.phase = "uploading".into(); self.store.save(s)?;
        let count = u32::try_from(s.input.manifest.bytes.div_ceil(PART_BYTES)).map_err(|_| internal())?;
        let mut grants = HashMap::<u32,SignedPart>::new(); let mut multipart = None; let mut renewed = Instant::now();
        if let Some(t) = ticket { self.check_ticket(&t,&asset_id,count)?; multipart = t.multipart_id; grants.extend(t.parts.into_iter().map(|p| (p.part_number,p))); }
        let mut file = tokio::fs::File::open(&s.path).await.map_err(|_| source_changed())?; let mut digest = Sha256::new();
        for number in 1..=count {
            check_cancel(&flag)?; s.check_source()?;
            let length = PART_BYTES.min(s.input.manifest.bytes - (u64::from(number)-1)*PART_BYTES);
            let mut bytes = vec![0; length as usize];
            file.read_exact(&mut bytes).await.map_err(|_| source_changed())?;
            digest.update(&bytes); let part_hash = hex(Sha256::digest(&bytes));
            if let Some(proof) = s.parts.iter().find(|p| p.part.part_number == number) {
                if proof.sha256 != part_hash { return Err(source_changed()); }
                continue;
            }
            if completing { return Err(internal()); }
            if !grants.contains_key(&number) || renewed.elapsed() >= Duration::from_secs(840) {
                let numbers: Vec<_> = (number..=count).filter(|n| !s.parts.iter().any(|p| p.part.part_number == *n)).take(16).collect();
                let t = remote.renew(&workspace,&asset_id,&numbers).await?; self.check_ticket(&t,&asset_id,count)?;
                if t.multipart_id.is_none() { return Err(internal()); }
                if multipart.as_ref().is_some_and(|id| Some(id) != t.multipart_id.as_ref()) { return Err(internal()); }
                multipart = t.multipart_id; grants = t.parts.into_iter().map(|p| (p.part_number,p)).collect(); renewed = Instant::now();
            }
            let grant = grants.remove(&number).ok_or_else(internal)?; let base = s.completed_bytes(); let p = tracker.clone();
            let sent = Arc::new(move |n| { if let Ok(mut p) = p.lock() { p.emit(base+n, false, None); } });
            let etag = remote.put(&grant, multipart.as_deref().ok_or_else(internal)?, bytes, flag.clone(), sent).await?;
            s.parts.push(PartProof { part: UploadedPart { part_number: number, etag }, sha256: part_hash }); self.store.save(s)?;
        }
        drop(file);
        let sha = hex(digest.finalize());
        if s.sha256.as_ref().is_some_and(|known| known != &sha) { return Err(source_changed()); }
        s.phase = "verifying".into(); self.store.save(s)?;
        { let mut p = tracker.lock().map_err(|_| internal())?; p.phase = s.phase.clone(); p.emit(s.completed_bytes(), true, None); }
        if hash_source(s,&flag).await? != sha { return Err(source_changed()); }
        check_cancel(&flag)?; s.check_source()?;
        s.sha256 = Some(sha.clone()); s.phase = "completing".into(); self.store.save(s)?;
        { let mut p = tracker.lock().map_err(|_| internal())?; p.phase = s.phase.clone(); p.emit(s.completed_bytes(), true, None); }
        let asset = remote.complete(&workspace,&asset_id,s.parts.iter().map(|p| p.part.clone()).collect(), &sha).await?;
        self.finish(s,asset)
    }
    fn check_ticket(&self, t: &UploadTicket, asset: &str, count: u32) -> Result<(), AppError> {
        let mut unique = std::collections::HashSet::new();
        if t.asset_id != asset || t.parts.len() > 16 || t.multipart_id.as_ref().is_some_and(|id| id.is_empty() || id.len() > 2048) || t.parts.iter().any(|p| p.part_number == 0 || p.part_number > count || !unique.insert(p.part_number)) { Err(internal()) } else { Ok(()) }
    }
    fn finish(&self, s: &mut UploadSession, asset: MediaAsset) -> Result<(), AppError> {
        let sha = s.sha256.as_ref().ok_or_else(internal)?;
        if Some(&asset.id) != s.asset_id.as_ref() || asset.bytes != s.input.manifest.bytes || asset.mime_type != s.input.manifest.mime_type || asset.kind != s.input.manifest.kind || asset.sha256.as_ref() != Some(sha) { return Err(source_changed()); }
        s.ready = Some(PreparedAsset { source_asset_id: s.input.source_asset_id.clone(), recipe_id: s.input.recipe_id.clone(), asset_id: asset.id, sha256: sha.clone() });
        s.phase = "complete".into(); s.error = None; self.store.save(s)
    }
    async fn cancel_locked(&self, s: &mut UploadSession, remote: &HttpUploadTransport) -> Result<(), AppError> {
        s.phase = "cancelling".into(); s.ready = None; self.store.save(s)?;
        if let Some(id) = &s.asset_id { remote.abort(&s.input.workspace_id,id).await?; }
        s.phase = "cancelled".into(); s.error = None; self.store.save(s)
    }
    pub async fn cancel(&self, owner: &str, id: &str, remote: &HttpUploadTransport) -> Result<(), AppError> {
        self.store.get(owner,id)?; let lock = self.job_lock(id)?; let _guard = lock.lock().await;
        let mut s = self.store.get(owner,id)?; if s.phase == "cancelled" { return Ok(()); }
        self.cancel_locked(&mut s,remote).await
    }
}
