use super::{UploadEngine, progress::ProgressSink, transport::HttpUploadTransport};
use crate::contracts::AppError;
use std::sync::Arc;
pub struct UploadState { pub engine: UploadEngine }
impl UploadState {
    pub fn new(engine: UploadEngine) -> Self { Self { engine } }
    pub fn launch(self: &Arc<Self>, _owner: &str, _id: &str, _remote: HttpUploadTransport, _sink: ProgressSink) -> Result<(), AppError> {
        Err(AppError::new("NOT_IMPLEMENTED", "بدء الرفع التلقائي لم ينفذ بعد."))
    }
    pub async fn cancel(&self, _owner: &str, _id: &str, _remote: &HttpUploadTransport) -> Result<(), AppError> {
        Err(AppError::new("NOT_IMPLEMENTED", "إلغاء الرفع النشط لم ينفذ بعد."))
    }
}
