use crate::contracts::AppError;
use serde::Serialize;
use std::{sync::Arc, time::{Duration, Instant}};
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadProgress {
    pub job_id: String, pub asset_id: Option<String>, pub completed_bytes: u64, pub total_bytes: u64,
    pub elapsed_ms: u64, pub remaining_ms: Option<u64>, pub phase: String, pub error: Option<AppError>,
}
pub type ProgressSink = Arc<dyn Fn(UploadProgress) + Send + Sync>;
pub struct ProgressTracker {
    pub job_id: String, pub asset_id: Option<String>, pub total: u64, pub phase: String,
    start: Instant, last: Option<Instant>, baseline: u64, transfer: Option<Instant>, sink: ProgressSink,
}
impl ProgressTracker {
    pub fn new(id: &str, total: u64, baseline: u64, sink: ProgressSink) -> Self {
        Self { job_id: id.into(), asset_id: None, total, phase: "pending".into(), start: Instant::now(), last: None, baseline, transfer: None, sink }
    }
    pub fn emit(&mut self, bytes: u64, force: bool, error: Option<AppError>) {
        let now = Instant::now();
        if !force && self.last.is_some_and(|last| now.duration_since(last) < Duration::from_millis(250)) { return; }
        self.last = Some(now);
        let transfer = *self.transfer.get_or_insert(now);
        let elapsed = now.duration_since(transfer).as_millis() as u64;
        let moved = bytes.saturating_sub(self.baseline);
        let remaining = if self.phase == "uploading" && elapsed >= 1000 && moved > 0 { Some(((u128::from(self.total.saturating_sub(bytes)) * u128::from(elapsed)) / u128::from(moved)).min(u128::from(u64::MAX)) as u64) } else { None };
        (self.sink)(UploadProgress { job_id: self.job_id.clone(), asset_id: self.asset_id.clone(), completed_bytes: bytes.min(self.total), total_bytes: self.total, elapsed_ms: self.start.elapsed().as_millis() as u64, remaining_ms: remaining, phase: self.phase.clone(), error });
    }
}
