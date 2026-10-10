pub mod transport;
use crate::contracts::{AppError, PreparedAsset, UploadInput};
use std::{path::Path, sync::{Arc, atomic::AtomicBool}};
pub struct UploadStore;
impl UploadStore { pub fn open(_: &Path) -> Result<Self, AppError> { Ok(Self) } }
pub struct UploadEngine;
fn missing() -> AppError { AppError::new("NOT_IMPLEMENTED", "الرفع لم ينفذ بعد.") }
impl UploadEngine {
    pub fn new(_: Arc<UploadStore>) -> Self { Self }
    pub fn start(&self, _: &str, _: UploadInput, _: &Path) -> Result<String, AppError> { Err(missing()) }
    pub async fn run(&self, _: &str, _: &str, _: &transport::HttpUploadTransport, _: Arc<AtomicBool>, _: Arc<dyn Fn(()) + Send + Sync>) -> Result<(), AppError> { Err(missing()) }
    pub fn prepared(&self, _: &str, _: &str) -> Result<Option<PreparedAsset>, AppError> { Err(missing()) }
    pub async fn cancel(&self, _: &str, _: &str, _: &transport::HttpUploadTransport) -> Result<(), AppError> { Err(missing()) }
    pub fn sessions(&self, _: &str, _: &str, _: &str) -> Result<Vec<()>, AppError> { Err(missing()) }
}
