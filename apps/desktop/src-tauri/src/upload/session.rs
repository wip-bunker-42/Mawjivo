use crate::{
    contracts::{AppError, PreparedAsset, UploadInput, UploadedPart},
    profiles::LocalStore,
};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::UNIX_EPOCH,
};
pub const PART_BYTES: u64 = 16 * 1024 * 1024;
pub fn local_error(_: impl std::fmt::Debug) -> AppError {
    AppError::new("UPLOAD_STORE", "تعذر حفظ سجل الرفع. تحقق من مساحة القرص.")
}
pub fn source_changed() -> AppError {
    AppError::new("SOURCE_CHANGED", "تغير الملف بعد اختياره؛ اختره مجددًا.")
}
pub fn stamp(path: &Path) -> Result<(u64, String), AppError> {
    let m = std::fs::metadata(path).map_err(|_| source_changed())?;
    if !m.is_file() {
        return Err(source_changed());
    }
    Ok((
        m.len(),
        m.modified()
            .map_err(|_| source_changed())?
            .duration_since(UNIX_EPOCH)
            .map_err(|_| source_changed())?
            .as_nanos()
            .to_string(),
    ))
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PartProof {
    pub part: UploadedPart,
    pub sha256: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UploadSession {
    pub id: String,
    pub owner: String,
    pub input: UploadInput,
    pub path: PathBuf,
    pub modified: String,
    pub asset_id: Option<String>,
    pub parts: Vec<PartProof>,
    pub sha256: Option<String>,
    pub phase: String,
    pub ready: Option<PreparedAsset>,
    pub error: Option<AppError>,
}
impl UploadSession {
    pub fn check_source(&self) -> Result<(), AppError> {
        if stamp(&self.path)? != (self.input.manifest.bytes, self.modified.clone()) {
            Err(source_changed())
        } else {
            Ok(())
        }
    }
    pub fn completed_bytes(&self) -> u64 {
        if self.phase == "complete" && self.ready.is_some() {
            return self.input.manifest.bytes;
        }
        self.parts
            .iter()
            .map(|p| {
                PART_BYTES.min(
                    self.input.manifest.bytes - (u64::from(p.part.part_number) - 1) * PART_BYTES,
                )
            })
            .sum()
    }
    pub fn public(&self) -> UploadJob {
        UploadJob {
            job_id: self.id.clone(),
            file_id: self.input.file_id.clone(),
            source_asset_id: self.input.source_asset_id.clone(),
            recipe_id: self.input.recipe_id.clone(),
            asset_id: self.asset_id.clone(),
            phase: self.phase.clone(),
            completed_bytes: self.completed_bytes(),
            total_bytes: self.input.manifest.bytes,
            error: self.error.clone(),
        }
    }
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadJob {
    pub job_id: String,
    pub file_id: String,
    pub source_asset_id: String,
    pub recipe_id: Option<String>,
    pub asset_id: Option<String>,
    pub phase: String,
    pub completed_bytes: u64,
    pub total_bytes: u64,
    pub error: Option<AppError>,
}
pub struct UploadStore {
    store: Arc<LocalStore>,
}
impl UploadStore {
    pub fn open(path: &Path) -> Result<Self, AppError> {
        Self::new(Arc::new(LocalStore::open(path)?))
    }
    pub fn new(store: Arc<LocalStore>) -> Result<Self, AppError> {
        store.lock()?.execute_batch("CREATE TABLE IF NOT EXISTS upload_sessions(id TEXT PRIMARY KEY, owner TEXT NOT NULL, profile_id TEXT NOT NULL REFERENCES profiles(id), workspace_id TEXT NOT NULL, file_id TEXT NOT NULL, recipe_id TEXT NOT NULL, phase TEXT NOT NULL, body TEXT NOT NULL); CREATE UNIQUE INDEX IF NOT EXISTS upload_active_identity ON upload_sessions(owner,profile_id,workspace_id,file_id,recipe_id) WHERE phase!='cancelled';").map_err(local_error)?;
        Ok(Self { store })
    }
    pub fn save(&self, s: &UploadSession) -> Result<(), AppError> {
        let body = serde_json::to_string(s).map_err(local_error)?;
        self.store.lock()?.execute("INSERT INTO upload_sessions(id,owner,profile_id,workspace_id,file_id,recipe_id,phase,body) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET phase=excluded.phase,body=excluded.body", params![s.id,s.owner,s.input.profile_id,s.input.workspace_id,s.input.file_id,s.input.recipe_id.as_deref().unwrap_or(""),s.phase,body]).map_err(local_error)?;
        Ok(())
    }
    pub fn get(&self, owner: &str, id: &str) -> Result<UploadSession, AppError> {
        let json: Option<String> = self
            .store
            .lock()?
            .query_row(
                "SELECT body FROM upload_sessions WHERE id=? AND owner=?",
                params![id, owner],
                |r| r.get(0),
            )
            .optional()
            .map_err(local_error)?;
        serde_json::from_str(
            &json.ok_or_else(|| AppError::new("UPLOAD_SCOPE", "عملية الرفع لا تخص هذه النافذة."))?,
        )
        .map_err(local_error)
    }
    pub fn find(
        &self,
        owner: &str,
        input: &UploadInput,
    ) -> Result<Option<UploadSession>, AppError> {
        let json: Option<String> = self.store.lock()?.query_row("SELECT body FROM upload_sessions WHERE owner=? AND profile_id=? AND workspace_id=? AND file_id=? AND recipe_id=? AND phase!='cancelled'", params![owner,input.profile_id,input.workspace_id,input.file_id,input.recipe_id.as_deref().unwrap_or("")], |r| r.get(0)).optional().map_err(local_error)?;
        json.map(|j| serde_json::from_str(&j).map_err(local_error))
            .transpose()
    }
    pub fn list(
        &self,
        owner: &str,
        profile: &str,
        workspace: &str,
    ) -> Result<Vec<UploadSession>, AppError> {
        let db = self.store.lock()?;
        let mut q = db.prepare("SELECT body FROM upload_sessions WHERE owner=? AND profile_id=? AND workspace_id=? ORDER BY rowid DESC LIMIT 200").map_err(local_error)?;
        q.query_map(params![owner, profile, workspace], |r| {
            r.get::<_, String>(0)
        })
        .map_err(local_error)?
        .map(|row| serde_json::from_str(&row.map_err(local_error)?).map_err(local_error))
        .collect()
    }
    pub fn list_sources(
        &self,
        owner: &str,
        profile: &str,
        workspace: &str,
        sources: &[String],
    ) -> Result<Vec<UploadSession>, AppError> {
        let encoded = serde_json::to_string(sources).map_err(local_error)?;
        let db = self.store.lock()?;
        let mut q = db.prepare("SELECT body FROM upload_sessions WHERE owner=? AND profile_id=? AND workspace_id=? AND phase!='cancelled' AND json_extract(body,'$.input.sourceAssetId') IN (SELECT value FROM json_each(?)) ORDER BY (recipe_id!=''),rowid DESC LIMIT 200").map_err(local_error)?;
        q.query_map(params![owner, profile, workspace, encoded], |r| {
            r.get::<_, String>(0)
        })
        .map_err(local_error)?
        .map(|row| serde_json::from_str(&row.map_err(local_error)?).map_err(local_error))
        .collect()
    }
}
