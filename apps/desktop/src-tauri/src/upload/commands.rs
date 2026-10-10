use super::{
    UploadEngine, UploadJob, UploadStore, progress::ProgressSink, transport::HttpUploadTransport,
};
use crate::{
    commands::NativeState,
    contracts::{AppError, PreparedAsset, UploadInput},
    media::jobs::MediaState,
    vault::{SystemVault, Vault},
};
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Instant,
};
use tauri::{Emitter, Manager, State, Window};
use zeroize::Zeroizing;

pub struct UploadState {
    pub engine: UploadEngine,
    active: Mutex<HashMap<String, Arc<AtomicBool>>>,
}
fn state_error() -> AppError {
    AppError::new("UPLOAD_STATE", "تعذر متابعة عملية الرفع.")
}
impl UploadState {
    pub fn new(engine: UploadEngine) -> Self {
        Self {
            engine,
            active: Mutex::new(HashMap::new()),
        }
    }
    pub fn launch(
        self: &Arc<Self>,
        owner: &str,
        id: &str,
        remote: HttpUploadTransport,
        sink: ProgressSink,
    ) -> Result<(), AppError> {
        let initial = self.engine.store.get(owner, id)?;
        let flag = {
            let mut active = self.active.lock().map_err(|_| state_error())?;
            if active.contains_key(id) {
                return Ok(());
            }
            let flag = Arc::new(AtomicBool::new(false));
            active.insert(id.into(), flag.clone());
            flag
        };
        let state = self.clone();
        let owner = owner.to_owned();
        let id = id.to_owned();
        tauri::async_runtime::spawn(async move {
            let started = Instant::now();
            let reported = Arc::new(AtomicBool::new(false));
            let remembered = reported.clone();
            let destination = sink.clone();
            let tracked: ProgressSink = Arc::new(move |event| {
                if event.error.is_some() {
                    remembered.store(true, Ordering::Relaxed);
                }
                destination(event);
            });
            if let Err(error) = state.engine.run(&owner, &id, &remote, flag, tracked).await
                && !reported.load(Ordering::Relaxed)
            {
                // A failed local write cannot persist its own error. Still report it to its window.
                let session = state.engine.store.get(&owner, &id).unwrap_or(initial);
                sink(super::progress::UploadProgress {
                    job_id: id.clone(),
                    asset_id: session.asset_id.clone(),
                    completed_bytes: session.completed_bytes(),
                    total_bytes: session.input.manifest.bytes,
                    elapsed_ms: started.elapsed().as_millis() as u64,
                    remaining_ms: None,
                    phase: if error.retryable { "paused" } else { "failed" }.into(),
                    error: Some(error),
                });
            }
            if let Ok(mut active) = state.active.lock() {
                active.remove(&id);
            }
        });
        Ok(())
    }
    pub async fn cancel(
        &self,
        owner: &str,
        id: &str,
        remote: &HttpUploadTransport,
    ) -> Result<(), AppError> {
        self.engine.store.get(owner, id)?;
        {
            let active = self.active.lock().map_err(|_| state_error())?;
            if let Some(flag) = active.get(id) {
                flag.store(true, Ordering::Relaxed);
            }
        }
        self.engine.cancel(owner, id, remote).await
    }
}
fn remote(native: &NativeState, profile_id: &str) -> Result<HttpUploadTransport, AppError> {
    let profile = native.store.get_state(profile_id)?.profile;
    let token = Zeroizing::new(SystemVault.get(&profile.device_credential_ref)?);
    HttpUploadTransport::new(&profile, &token)
}
fn progress(window: &Window) -> ProgressSink {
    let window = window.clone();
    Arc::new(move |event| {
        let _ = window.emit("upload-progress", event);
    })
}
#[tauri::command]
pub async fn start_upload(
    window: Window,
    native: State<'_, NativeState>,
    media: State<'_, Arc<MediaState>>,
    state: State<'_, Arc<UploadState>>,
    mut input: UploadInput,
) -> Result<String, AppError> {
    let transport = remote(&native, &input.profile_id)?;
    let (path, manifest) = media.registry.upload_for(window.label(), &input)?;
    input.manifest = manifest;
    let id = state.engine.start(window.label(), input, &path)?;
    state.launch(window.label(), &id, transport, progress(&window))?;
    Ok(id)
}
#[tauri::command]
pub async fn resume_upload(
    window: Window,
    native: State<'_, NativeState>,
    state: State<'_, Arc<UploadState>>,
    job_id: String,
) -> Result<(), AppError> {
    let session = state.engine.store.get(window.label(), &job_id)?;
    let transport = remote(&native, &session.input.profile_id)?;
    let restarted = state.engine.revalidate(window.label(), &job_id)?;
    state.launch(window.label(), &restarted, transport, progress(&window))
}
#[tauri::command]
pub async fn cancel_upload(
    window: Window,
    native: State<'_, NativeState>,
    state: State<'_, Arc<UploadState>>,
    job_id: String,
) -> Result<(), AppError> {
    let session = state.engine.store.get(window.label(), &job_id)?;
    let transport = remote(&native, &session.input.profile_id)?;
    state.cancel(window.label(), &job_id, &transport).await?;
    let session = state.engine.store.get(window.label(), &job_id)?;
    progress(&window)(super::progress::UploadProgress {
        job_id,
        asset_id: session.asset_id.clone(),
        completed_bytes: session.completed_bytes(),
        total_bytes: session.input.manifest.bytes,
        elapsed_ms: 0,
        remaining_ms: None,
        phase: session.phase,
        error: session.error,
    });
    Ok(())
}
#[tauri::command]
pub fn uploaded_asset(
    window: Window,
    state: State<'_, Arc<UploadState>>,
    job_id: String,
) -> Result<Option<PreparedAsset>, AppError> {
    state.engine.prepared(window.label(), &job_id)
}
#[tauri::command]
pub fn list_uploads(
    window: Window,
    native: State<'_, NativeState>,
    state: State<'_, Arc<UploadState>>,
    profile_id: String,
    workspace_id: String,
) -> Result<Vec<UploadJob>, AppError> {
    native.store.get_state(&profile_id)?;
    state
        .engine
        .sessions(window.label(), &profile_id, &workspace_id)
}
#[tauri::command]
pub fn restore_uploads(
    window: Window,
    native: State<'_, NativeState>,
    media: State<'_, Arc<MediaState>>,
    state: State<'_, Arc<UploadState>>,
    profile_id: String,
    workspace_id: String,
    source_asset_ids: Vec<String>,
) -> Result<Vec<UploadJob>, AppError> {
    native.store.get_state(&profile_id)?;
    state.engine.restore_handles(window.label(), &profile_id, &workspace_id, &source_asset_ids, &media.registry)
}
pub fn setup(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let local = app.state::<NativeState>().store.clone();
    let store = UploadStore::new(local).map_err(|e| std::io::Error::other(e.message_ar))?;
    app.manage(Arc::new(UploadState::new(UploadEngine::new(Arc::new(
        store,
    )))));
    Ok(())
}
