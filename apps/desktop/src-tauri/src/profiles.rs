use crate::contracts::AppError;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::{
    path::Path,
    sync::{Mutex, MutexGuard},
};
use zeroize::Zeroize;
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProvisionInput {
    pub account_id: String,
    pub api_token: String,
    pub r2_access_key_id: String,
    pub r2_secret_access_key: String,
    pub zone_id: Option<String>,
    pub domain: Option<String>,
}
impl Drop for ProvisionInput {
    fn drop(&mut self) {
        self.api_token.zeroize();
        self.r2_secret_access_key.zeroize();
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServiceProfile {
    pub id: String,
    pub base_url: String,
    pub service_id: String,
    pub account_id: String,
    pub device_credential_ref: String,
    pub version: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ProvisionState {
    pub profile: ServiceProfile,
    pub database_id: Option<String>,
    pub bucket_created: bool,
    pub domain: Option<String>,
}
impl ProvisionState {
    pub fn new(account: &str) -> Self {
        let id = uuid::Uuid::new_v4().simple().to_string();
        Self {
            profile: ServiceProfile {
                id: id.clone(),
                base_url: String::new(),
                service_id: id.clone(),
                account_id: account.into(),
                device_credential_ref: format!("{id}:device"),
                version: "0.1.0".into(),
            },
            database_id: None,
            bucket_created: false,
            domain: None,
        }
    }
    pub fn worker_name(&self) -> String {
        format!("mawjivo-{}", self.profile.service_id)
    }
    pub fn owner_tag(&self) -> String {
        format!("mawjivo-service:{}", self.profile.service_id)
    }
}
pub struct LocalStore {
    db: Mutex<Connection>,
}
fn storage_error(_: impl std::fmt::Debug) -> AppError {
    AppError::new(
        "LOCAL_STORE",
        "تعذر حفظ البيانات المحلية. تحقق من مساحة القرص وصلاحيات مجلد التطبيق.",
    )
}
impl LocalStore {
    pub fn window_draft(
        &self,
        profile: &str,
        window: &str,
        workspace: &str,
    ) -> Result<Option<crate::contracts::Draft>, AppError> {
        let value: Option<String> = self.lock()?.query_row(
            "SELECT d.body FROM composer_drafts c JOIN drafts d ON d.profile_id=c.profile_id AND d.workspace_id=c.workspace_id AND d.id=c.draft_id WHERE c.profile_id=? AND c.window_id=? AND c.workspace_id=?",
            params![profile, window, workspace], |row| row.get(0)
        ).optional().map_err(storage_error)?;
        value
            .map(|body| serde_json::from_str(&body).map_err(storage_error))
            .transpose()
    }
    pub fn memory() -> Result<Self, AppError> {
        Self::initialize(Connection::open_in_memory().map_err(storage_error)?)
    }
    pub fn open(path: &Path) -> Result<Self, AppError> {
        Self::initialize(Connection::open(path).map_err(storage_error)?)
    }
    fn initialize(db: Connection) -> Result<Self, AppError> {
        db.busy_timeout(std::time::Duration::from_secs(5))
            .map_err(storage_error)?;
        db.execute_batch("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS profiles(id TEXT PRIMARY KEY,state_json TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS drafts(profile_id TEXT NOT NULL,workspace_id TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(profile_id,workspace_id,id),FOREIGN KEY(profile_id) REFERENCES profiles(id));
            CREATE TABLE IF NOT EXISTS window_drafts(profile_id TEXT NOT NULL,window_id TEXT NOT NULL,workspace_id TEXT NOT NULL,draft_id TEXT NOT NULL,PRIMARY KEY(profile_id,window_id),FOREIGN KEY(profile_id,workspace_id,draft_id) REFERENCES drafts(profile_id,workspace_id,id));
            CREATE TABLE IF NOT EXISTS composer_drafts(profile_id TEXT NOT NULL,window_id TEXT NOT NULL,workspace_id TEXT NOT NULL,draft_id TEXT NOT NULL,PRIMARY KEY(profile_id,window_id,workspace_id),FOREIGN KEY(profile_id,workspace_id,draft_id) REFERENCES drafts(profile_id,workspace_id,id));
            INSERT OR IGNORE INTO composer_drafts SELECT profile_id,window_id,workspace_id,draft_id FROM window_drafts;
            PRAGMA user_version=2;").map_err(storage_error)?;
        Ok(Self { db: Mutex::new(db) })
    }
    pub(crate) fn lock(&self) -> Result<MutexGuard<'_, Connection>, AppError> {
        self.db.lock().map_err(storage_error)
    }
    pub fn save_state(&self, state: &ProvisionState) -> Result<(), AppError> {
        self.lock()?.execute("INSERT INTO profiles(id,state_json) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET state_json=excluded.state_json",params![state.profile.id,serde_json::to_string(state).map_err(storage_error)?]).map_err(storage_error)?;
        Ok(())
    }
    pub fn get_state(&self, id: &str) -> Result<ProvisionState, AppError> {
        let value: Option<String> = self
            .lock()?
            .query_row("SELECT state_json FROM profiles WHERE id=?", [id], |row| {
                row.get(0)
            })
            .optional()
            .map_err(storage_error)?;
        serde_json::from_str(&value.ok_or_else(|| {
            AppError::new("PROFILE_NOT_FOUND", "الخدمة غير موجودة على هذا الجهاز.")
        })?)
        .map_err(storage_error)
    }
    pub fn list_states(&self) -> Result<Vec<ProvisionState>, AppError> {
        let db = self.lock()?;
        let mut statement = db
            .prepare("SELECT state_json FROM profiles ORDER BY rowid")
            .map_err(storage_error)?;
        statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(storage_error)?
            .map(|row| serde_json::from_str(&row.map_err(storage_error)?).map_err(storage_error))
            .collect()
    }
    pub fn save_draft(
        &self,
        profile: &str,
        window: &str,
        draft: &crate::contracts::Draft,
    ) -> Result<(), AppError> {
        if draft.id.is_empty()
            || draft.workspace_id.is_empty()
            || draft.revision == 0
            || draft.revision > i64::MAX as u64
        {
            return Err(AppError::new("INVALID_INPUT", "بيانات المسودة غير صالحة."));
        }
        let revision = i64::try_from(draft.revision).map_err(storage_error)?;
        let body = serde_json::to_string(draft).map_err(storage_error)?;
        if body.len() > 2_097_152 {
            return Err(AppError::new(
                "DRAFT_TOO_LARGE",
                "بيانات المسودة أكبر من الحد المسموح.",
            ));
        }
        let mut db = self.lock()?;
        let transaction = db.transaction().map_err(storage_error)?;
        let changed=transaction.execute("INSERT INTO drafts(profile_id,workspace_id,id,revision,body) VALUES(?,?,?,?,?) ON CONFLICT(profile_id,workspace_id,id) DO UPDATE SET revision=excluded.revision,body=excluded.body WHERE drafts.revision<=excluded.revision",params![profile,draft.workspace_id,draft.id,revision,body]).map_err(storage_error)?;
        if changed == 0 {
            return Err(AppError::new(
                "DRAFT_VERSION_CONFLICT",
                "هناك تعديل أحدث على المسودة.",
            ));
        }
        transaction.execute("INSERT INTO window_drafts(profile_id,window_id,workspace_id,draft_id) VALUES(?,?,?,?) ON CONFLICT(profile_id,window_id) DO UPDATE SET workspace_id=excluded.workspace_id,draft_id=excluded.draft_id",params![profile,window,draft.workspace_id,draft.id]).map_err(storage_error)?;
        transaction.execute("INSERT INTO composer_drafts(profile_id,window_id,workspace_id,draft_id) VALUES(?,?,?,?) ON CONFLICT(profile_id,window_id,workspace_id) DO UPDATE SET draft_id=excluded.draft_id",params![profile,window,draft.workspace_id,draft.id]).map_err(storage_error)?;
        transaction.commit().map_err(storage_error)
    }
    pub fn load_draft(
        &self,
        profile: &str,
        workspace: &str,
        id: &str,
    ) -> Result<Option<crate::contracts::Draft>, AppError> {
        let value: Option<String> = self
            .lock()?
            .query_row(
                "SELECT body FROM drafts WHERE profile_id=? AND workspace_id=? AND id=?",
                params![profile, workspace, id],
                |row| row.get(0),
            )
            .optional()
            .map_err(storage_error)?;
        value
            .map(|body| serde_json::from_str(&body).map_err(storage_error))
            .transpose()
    }
}
