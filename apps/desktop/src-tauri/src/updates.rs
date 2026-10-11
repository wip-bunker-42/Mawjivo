use crate::contracts::{AppError, UpdateInfo};
use async_trait::async_trait;
use std::{collections::HashMap, sync::{Arc, Mutex}};

#[derive(Clone, Default)]
pub struct OperationGate(Arc<Mutex<u32>>);
pub struct WorkLease(OperationGate);
impl Drop for WorkLease {
    fn drop(&mut self) { *self.0.0.lock().unwrap() -= 1; }
}
impl OperationGate {
    pub fn work(&self) -> Result<WorkLease, AppError> {
        *self.0.lock().unwrap() += 1;
        Ok(WorkLease(self.clone()))
    }
}
pub struct AvailableUpdate<O> { pub info: UpdateInfo, pub offer: O }
#[async_trait]
pub trait UpdateBackend: Send + Sync {
    type Offer: Clone + Send + Sync;
    async fn check(&self) -> Result<Option<AvailableUpdate<Self::Offer>>, AppError>;
    async fn download(&self, offer: &Self::Offer) -> Result<Vec<u8>, AppError>;
    fn install(&self, offer: &Self::Offer, bytes: &[u8]) -> Result<(), AppError>;
}
pub struct UpdateManager<B: UpdateBackend> {
    backend: B,
    pub gate: OperationGate,
    pending: Mutex<HashMap<String, (String, B::Offer, Vec<u8>)>>,
}
impl<B: UpdateBackend> UpdateManager<B> {
    pub fn new(backend: B, gate: OperationGate) -> Self {
        Self { backend, gate, pending: Mutex::new(HashMap::new()) }
    }
    pub async fn check(&self, owner: &str) -> Result<Option<UpdateInfo>, AppError> {
        let Some(mut candidate) = self.backend.check().await? else { return Ok(None); };
        candidate.info.id = uuid::Uuid::new_v4().to_string();
        self.pending.lock().unwrap().insert(candidate.info.id.clone(), (owner.into(), candidate.offer, vec![]));
        Ok(Some(candidate.info))
    }
    pub async fn download(&self, _owner: &str, id: &str) -> Result<(), AppError> {
        let offer = self.pending.lock().unwrap().get(id).unwrap().1.clone();
        let bytes = self.backend.download(&offer).await.unwrap_or_default();
        self.pending.lock().unwrap().get_mut(id).unwrap().2 = bytes;
        Ok(())
    }
    pub fn install(&self, _owner: &str, id: &str) -> Result<(), AppError> {
        let pending = self.pending.lock().unwrap();
        let (_, offer, bytes) = pending.get(id).unwrap();
        self.backend.install(offer, bytes)
    }
}
