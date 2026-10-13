use crate::profiles::ProvisionState;
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;

mod format;
pub use format::{parse_env, serialize_env};
pub(crate) mod live;
pub use live::{CloudflareTransferSource, TransferSource, decrypt_connection};
mod operations;
pub use operations::{export_to, import_from};
pub mod commands;

#[derive(Clone)]
pub struct TransferBundle {
    pub exported_at: String,
    pub services: Vec<ServiceTransfer>,
}

#[derive(Clone)]
pub struct ServiceTransfer {
    pub state: ProvisionState,
    pub secrets: BTreeMap<String, String>,
    pub snapshot: TransferSnapshot,
}

#[derive(Clone, Default)]
pub struct TransferSnapshot {
    pub workspaces: Vec<Value>,
    pub connections: Vec<Value>,
    pub telegram: Vec<Value>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferSummary {
    pub services: u32,
    pub workspaces: u32,
    pub connections: u32,
}
