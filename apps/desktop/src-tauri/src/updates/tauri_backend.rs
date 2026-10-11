use super::{
    AvailableUpdate, MAX_UPDATE_BYTES, OperationGate, ProgressSink, UpdateBackend, UpdateManager,
};
use crate::contracts::{AppError, UpdateInfo};
use async_trait::async_trait;
use serde::Serialize;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State, Window};
use tauri_plugin_updater::{Update, UpdaterExt};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProgress {
    pub update_id: String,
    pub completed_bytes: u64,
    pub total_bytes: Option<u64>,
    pub phase: String,
}
pub struct TauriUpdater(pub AppHandle);
fn updater_error(error: tauri_plugin_updater::Error) -> AppError {
    use tauri_plugin_updater::Error;
    match error {
        Error::Minisign(_)
        | Error::Base64(_)
        | Error::SignatureUtf8(_)
        | Error::SignedVersionMismatch { .. }
        | Error::MissingSignedVersion => AppError::new(
            "UPDATE_SIGNATURE_INVALID",
            "توقيع التحديث غير صالح. أعد الفحص.",
        ),
        _ => AppError::new(
            "UPDATE_UNAVAILABLE",
            "تعذر إكمال التحديث. تحقق من الاتصال ثم أعد الفحص.",
        ),
    }
}
#[async_trait]
impl UpdateBackend for TauriUpdater {
    type Offer = Update;
    async fn check(&self) -> Result<Option<AvailableUpdate<Update>>, AppError> {
        let Some(offer) = self
            .0
            .updater_builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(updater_error)?
            .check()
            .await
            .map_err(updater_error)?
        else {
            return Ok(None);
        };
        let url = &offer.download_url;
        let bytes = offer.raw_json["bytes"].as_u64().unwrap_or(0);
        if url.scheme() != "https"
            || url.host_str() != Some("downloads.aimansour.com")
            || url.port().is_some()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || !url.path().starts_with("/releases/")
            || !url.path().ends_with(".exe")
            || url.path().contains('%')
            || bytes == 0
            || bytes > MAX_UPDATE_BYTES
        {
            return Err(AppError::new(
                "UPDATE_MANIFEST_INVALID",
                "بيانات التحديث غير صالحة. أعد الفحص لاحقًا.",
            ));
        }
        let info = UpdateInfo {
            id: String::new(),
            version: offer.version.clone(),
            notes_ar: offer
                .body
                .as_deref()
                .unwrap_or("")
                .chars()
                .take(4000)
                .collect(),
            bytes,
        };
        Ok(Some(AvailableUpdate { info, offer }))
    }
    async fn download(&self, offer: &Update, progress: ProgressSink) -> Result<Vec<u8>, AppError> {
        let limit = tokio::sync::Notify::new();
        let mut received = 0u64;
        let mut reported = std::time::Instant::now()
            .checked_sub(std::time::Duration::from_secs(1))
            .unwrap_or_else(std::time::Instant::now);
        let download = offer.download(
            |chunk, total| {
                received = received.saturating_add(chunk as u64);
                if received > MAX_UPDATE_BYTES || total.is_some_and(|n| n > MAX_UPDATE_BYTES) {
                    limit.notify_one();
                }
                if reported.elapsed() >= std::time::Duration::from_millis(200)
                    || total == Some(received)
                {
                    progress(received, total);
                    reported = std::time::Instant::now();
                }
            },
            || {},
        );
        tokio::select! {
            biased;
            _ = limit.notified() => Err(AppError::new("UPDATE_SIZE", "حجم التحديث أكبر من الحد المسموح. أعد الفحص.")),
            verified = download => verified.map_err(updater_error),
        }
    }
    fn install(&self, offer: &Update, bytes: &[u8]) -> Result<(), AppError> {
        let directory = self
            .0
            .path()
            .app_local_data_dir()
            .map_err(|_| super::state_error())?;
        let available = fs4::available_space(&directory).map_err(|_| super::state_error())?;
        if available < bytes.len() as u64 * 3 + 128 * 1_048_576 {
            return Err(AppError::new(
                "UPDATE_DISK_SPACE",
                "المساحة المحلية لا تكفي للتحديث. وفر مساحة ثم أعد التثبيت.",
            ));
        }
        let backup = directory
            .join("backups")
            .join(format!("before-update-{}.sqlite", uuid::Uuid::new_v4()));
        self.0
            .state::<crate::commands::NativeState>()
            .store
            .backup(&backup)?;
        offer.install(bytes).map_err(updater_error)
    }
}
#[tauri::command]
pub async fn check_update(
    window: Window,
    state: State<'_, Arc<UpdateManager<TauriUpdater>>>,
) -> Result<Option<UpdateInfo>, AppError> {
    state.check(window.label()).await
}
#[tauri::command]
pub async fn download_update(
    window: Window,
    state: State<'_, Arc<UpdateManager<TauriUpdater>>>,
    update_id: String,
) -> Result<(), AppError> {
    let destination = window.clone();
    let progress_id = update_id.clone();
    state
        .download_with_progress(
            window.label(),
            &update_id,
            Arc::new(move |completed_bytes, total_bytes| {
                let _ = destination.emit(
                    "update-progress",
                    UpdateProgress {
                        update_id: progress_id.clone(),
                        completed_bytes,
                        total_bytes,
                        phase: "downloading".into(),
                    },
                );
            }),
        )
        .await?;
    let _ = window.emit(
        "update-progress",
        UpdateProgress {
            update_id,
            completed_bytes: 0,
            total_bytes: None,
            phase: "verified".into(),
        },
    );
    Ok(())
}
#[tauri::command]
pub fn install_update(
    window: Window,
    state: State<'_, Arc<UpdateManager<TauriUpdater>>>,
    update_id: String,
) -> Result<(), AppError> {
    state.install(window.label(), &update_id)
}
pub fn setup(app: &tauri::App) {
    let gate = OperationGate::default();
    app.manage(gate.clone());
    app.manage(Arc::new(UpdateManager::new(
        TauriUpdater(app.handle().clone()),
        gate,
    )));
}
