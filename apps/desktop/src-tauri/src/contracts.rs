use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Platform {
    Facebook,
    Instagram,
    Threads,
    X,
    Youtube,
    Tiktok,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Meta,
    Buffer,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MediaKind {
    Image,
    Video,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub time_zone: String,
    pub version: u64,
    pub default_platforms: Vec<Platform>,
    pub service_profile_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preferred_channels: Option<BTreeMap<Platform, String>>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MediaAsset {
    pub id: String,
    pub original_name: String,
    pub kind: MediaKind,
    pub bytes: u64,
    pub mime_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub derived_from: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SelectedFile {
    pub file_id: String,
    pub original_name: String,
    pub bytes: u64,
    pub mime_type: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreparedLocalAsset {
    pub file_id: String,
    pub source_asset_id: String,
    pub recipe_id: String,
    pub mime_type: String,
    pub bytes: u64,
    pub sha256: String,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UploadManifest {
    pub source_asset_id: String,
    pub recipe_id: Option<String>,
    pub original_name: String,
    pub kind: MediaKind,
    pub bytes: u64,
    pub mime_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UploadInput {
    pub profile_id: String,
    pub workspace_id: String,
    pub file_id: String,
    pub source_asset_id: String,
    pub recipe_id: Option<String>,
    pub manifest: UploadManifest,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlatformOverride {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alt_texts: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread_parts: Option<Vec<String>>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Draft {
    pub id: String,
    pub workspace_id: String,
    pub workspace_version: u64,
    pub time_zone: String,
    pub revision: u64,
    pub text: String,
    pub title: String,
    pub assets: Vec<MediaAsset>,
    pub selections: Vec<String>,
    pub overrides: BTreeMap<Platform, PlatformOverride>,
    pub schedule_local: Option<String>,
    pub schedule_offset: Option<String>,
    pub created_at: String,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssetUse {
    pub source_asset_id: String,
    pub recipe_id: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MediaRecipe {
    pub id: String,
    pub source_asset_id: String,
    pub output_mime_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_duration_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_height: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_height: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_aspect_ratio: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_aspect_ratio: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frame_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quality: Option<u8>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TargetPlan {
    pub channel_id: String,
    pub connection_id: String,
    pub platform: Platform,
    pub provider: Provider,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub thread_parts: Vec<String>,
    pub assets: Vec<AssetUse>,
    pub alt_texts: Vec<String>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanNote {
    pub code: String,
    pub channel_id: String,
    pub message_ar: String,
    pub facts: BTreeMap<String, serde_json::Value>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExcludedTarget {
    pub channel_id: String,
    pub platform: Platform,
    pub code: String,
    pub message_ar: String,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PostPlan {
    pub draft_id: String,
    pub workspace_id: String,
    pub workspace_version: u64,
    pub time_zone: String,
    pub revision: u64,
    pub policy_version: String,
    pub capability_version: String,
    pub targets: Vec<TargetPlan>,
    pub excluded: Vec<ExcludedTarget>,
    pub media_recipes: Vec<MediaRecipe>,
    pub due_at: Option<String>,
    pub notes: Vec<PlanNote>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreparedAsset {
    pub source_asset_id: String,
    pub recipe_id: Option<String>,
    pub asset_id: String,
    pub sha256: String,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Submission {
    pub plan: PostPlan,
    pub plan_hash: String,
    pub prepared_assets: Vec<PreparedAsset>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppError {
    pub code: String,
    pub message_ar: String,
    pub retryable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<BTreeMap<String, serde_json::Value>>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReadinessItem {
    pub code: String,
    pub state: String,
    pub message_ar: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action: Option<String>,
}
