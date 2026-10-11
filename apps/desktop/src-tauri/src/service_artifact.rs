use crate::contracts::AppError;
use serde::Deserialize;
use sha2::{Digest, Sha256};
#[derive(Deserialize)]
pub struct ArtifactFile {
    pub name: String,
    pub source: String,
    pub sha256: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceArtifact {
    pub version: String,
    pub compatibility_date: String,
    pub compatibility_flags: Vec<String>,
    pub main_module: String,
    pub modules: Vec<ArtifactFile>,
    pub migrations: Vec<ArtifactFile>,
    pub workflow_class: Option<String>,
}
pub fn sha256(value: impl AsRef<[u8]>) -> String {
    Sha256::digest(value.as_ref())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
impl ServiceArtifact {
    pub fn bundled() -> Result<Self, AppError> {
        let artifact: Self = serde_json::from_str(include_str!(
            "../service-artifact/manifest.json"
        ))
        .map_err(|_| {
            AppError::new(
                "SERVICE_ARTIFACT_INVALID",
                "حزمة الخدمة غير صالحة. أعد تثبيت التطبيق.",
            )
        })?;
        if artifact.main_module != "index.js"
            || artifact.modules.is_empty()
            || artifact.migrations.is_empty()
            || artifact
                .modules
                .iter()
                .chain(&artifact.migrations)
                .any(|file| sha256(&file.source) != file.sha256 || file.name.contains(['/', '\\']))
        {
            return Err(AppError::new(
                "SERVICE_ARTIFACT_INVALID",
                "بصمة حزمة الخدمة لا تتطابق. أعد تثبيت التطبيق.",
            ));
        }
        Ok(artifact)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bundled_service_deploys_the_minute_monitor_trigger() {
        let manifest: serde_json::Value = serde_json::from_str(include_str!("../service-artifact/manifest.json")).unwrap();
        assert_eq!(manifest["cronTriggers"], serde_json::json!(["* * * * *"]));
    }
    #[test]
    fn bundled_artifact_has_verified_modules_and_migrations() {
        assert!(ServiceArtifact::bundled().is_ok());
    }
}
