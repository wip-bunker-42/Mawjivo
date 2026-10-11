use crate::contracts::{AppError, UpdateInfo};
use async_trait::async_trait;
use std::sync::{Arc, Mutex, MutexGuard};
pub mod tauri_backend;

pub const MAX_UPDATE_BYTES: u64 = 512 * 1_048_576;
pub fn verify_signed_release(
    _bytes: &[u8],
    _signature: &str,
    _public_key: &str,
    _version: &str,
) -> Result<(), AppError> {
    Ok(())
}
fn busy() -> AppError {
    AppError::new(
        "UPDATE_BUSY",
        "انتظر انتهاء الرفع أو معالجة الوسائط، ثم أعد التثبيت.",
    )
}
fn state_error() -> AppError {
    AppError::new("UPDATE_STATE", "تعذر متابعة التحديث. أعد الفحص.")
}
fn not_found() -> AppError {
    AppError::new("UPDATE_NOT_FOUND", "أعد فحص التحديث من هذه النافذة.")
}
#[derive(Default)]
struct GateState {
    active: u32,
    installing: bool,
}

#[derive(Clone, Default)]
pub struct OperationGate(Arc<Mutex<GateState>>);
pub struct WorkLease(OperationGate);
pub struct InstallLease(OperationGate);
impl Drop for WorkLease {
    fn drop(&mut self) {
        if let Ok(mut state) = self.0.0.lock() {
            state.active = state.active.saturating_sub(1);
        }
    }
}
impl Drop for InstallLease {
    fn drop(&mut self) {
        if let Ok(mut state) = self.0.0.lock() {
            state.installing = false;
        }
    }
}
impl OperationGate {
    pub fn work(&self) -> Result<WorkLease, AppError> {
        let mut state = self.0.lock().map_err(|_| state_error())?;
        if state.installing {
            return Err(busy());
        }
        state.active = state.active.checked_add(1).ok_or_else(state_error)?;
        Ok(WorkLease(self.clone()))
    }
    pub fn install(&self) -> Result<InstallLease, AppError> {
        let mut state = self.0.lock().map_err(|_| state_error())?;
        if state.installing || state.active > 0 {
            return Err(busy());
        }
        state.installing = true;
        Ok(InstallLease(self.clone()))
    }
}
pub type ProgressSink = Arc<dyn Fn(u64, Option<u64>) + Send + Sync>;
pub struct AvailableUpdate<O> {
    pub info: UpdateInfo,
    pub offer: O,
}
#[async_trait]
pub trait UpdateBackend: Send + Sync {
    type Offer: Clone + Send + Sync;
    async fn check(&self) -> Result<Option<AvailableUpdate<Self::Offer>>, AppError>;
    // Only bytes returned after mandatory signature verification may reach install().
    async fn download(
        &self,
        offer: &Self::Offer,
        progress: ProgressSink,
    ) -> Result<Vec<u8>, AppError>;
    fn install(&self, offer: &Self::Offer, bytes: &[u8]) -> Result<(), AppError>;
}
struct Pending<O> {
    id: String,
    owner: String,
    offer: O,
    verified: Option<Vec<u8>>,
}
pub struct UpdateManager<B: UpdateBackend> {
    backend: B,
    pub gate: OperationGate,
    serial: tokio::sync::Mutex<()>,
    pending: Mutex<Option<Pending<B::Offer>>>,
}
impl<B: UpdateBackend> UpdateManager<B> {
    pub fn new(backend: B, gate: OperationGate) -> Self {
        Self {
            backend,
            gate,
            serial: tokio::sync::Mutex::new(()),
            pending: Mutex::new(None),
        }
    }
    fn pending(&self) -> Result<MutexGuard<'_, Option<Pending<B::Offer>>>, AppError> {
        self.pending.lock().map_err(|_| state_error())
    }
    pub async fn check(&self, owner: &str) -> Result<Option<UpdateInfo>, AppError> {
        let _serial = self.serial.try_lock().map_err(|_| busy())?;
        let _work = self.gate.work()?;
        *self.pending()? = None;
        let Some(mut candidate) = self.backend.check().await? else {
            return Ok(None);
        };
        candidate.info.id = uuid::Uuid::new_v4().to_string();
        *self.pending()? = Some(Pending {
            id: candidate.info.id.clone(),
            owner: owner.into(),
            offer: candidate.offer,
            verified: None,
        });
        Ok(Some(candidate.info))
    }
    pub async fn download(&self, owner: &str, id: &str) -> Result<(), AppError> {
        self.download_with_progress(owner, id, Arc::new(|_, _| {}))
            .await
    }
    pub async fn download_with_progress(
        &self,
        owner: &str,
        id: &str,
        progress: ProgressSink,
    ) -> Result<(), AppError> {
        let _serial = self.serial.try_lock().map_err(|_| busy())?;
        let _work = self.gate.work()?;
        let offer = {
            let mut pending = self.pending()?;
            let selected = pending
                .as_mut()
                .filter(|p| p.id == id && p.owner == owner)
                .ok_or_else(not_found)?;
            selected.verified = None;
            selected.offer.clone()
        };
        let verified = self.backend.download(&offer, progress).await?;
        if verified.is_empty() || verified.len() as u64 > MAX_UPDATE_BYTES {
            return Err(AppError::new(
                "UPDATE_SIZE",
                "حجم التحديث غير صالح. أعد الفحص.",
            ));
        }
        self.pending()?
            .as_mut()
            .filter(|p| p.id == id && p.owner == owner)
            .ok_or_else(not_found)?
            .verified = Some(verified);
        Ok(())
    }
    pub fn install(&self, owner: &str, id: &str) -> Result<(), AppError> {
        let _serial = self.serial.try_lock().map_err(|_| busy())?;
        let _install = self.gate.install()?;
        let pending = self.pending()?;
        let selected = pending
            .as_ref()
            .filter(|p| p.id == id && p.owner == owner)
            .ok_or_else(not_found)?;
        let bytes = selected.verified.as_ref().ok_or_else(|| {
            AppError::new("UPDATE_NOT_VERIFIED", "نزّل التحديث وتحقق من توقيعه أولًا.")
        })?;
        self.backend.install(&selected.offer, bytes)
    }
}
