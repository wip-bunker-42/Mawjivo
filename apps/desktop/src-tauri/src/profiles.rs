use crate::contracts::AppError;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
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
    #[serde(default)]
    pub zone_id: Option<String>,
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
            zone_id: None,
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
    path: Option<PathBuf>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedComposer {
    pub window_id: String,
    pub draft_id: String,
    pub preview: String,
    pub created_at: String,
}
fn storage_error(_: impl std::fmt::Debug) -> AppError {
    AppError::new(
        "LOCAL_STORE",
        "تعذر حفظ البيانات المحلية. تحقق من مساحة القرص وصلاحيات مجلد التطبيق.",
    )
}
fn read_states(db: &Connection) -> Result<Vec<ProvisionState>, AppError> {
    let mut statement = db
        .prepare("SELECT state_json FROM profiles ORDER BY rowid")
        .map_err(storage_error)?;
    statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(storage_error)?
        .map(|row| serde_json::from_str(&row.map_err(storage_error)?).map_err(storage_error))
        .collect()
}
fn validate_import(
    existing: &[ProvisionState],
    incoming: &[ProvisionState],
) -> Result<(), AppError> {
    let conflict = || {
        AppError::new(
            "TRANSFER_CONFLICT",
            "تختلف بيانات الخدمة عن الربط الموجود على هذا الجهاز. لم يُستبدل.",
        )
    };
    let mut seen = std::collections::HashSet::new();
    for state in incoming {
        if !seen.insert(&state.profile.id) {
            return Err(conflict());
        }
        for old in existing {
            if old.profile.id == state.profile.id {
                let mut profile = state.profile.clone();
                profile.version = old.profile.version.clone();
                if profile != old.profile
                    || state.database_id != old.database_id
                    || state.bucket_created != old.bucket_created
                    || state.domain != old.domain
                    || state.zone_id != old.zone_id
                {
                    return Err(conflict());
                }
            } else if old.profile.base_url.trim_end_matches('/')
                == state.profile.base_url.trim_end_matches('/')
                || (old.profile.account_id == state.profile.account_id
                    && state.database_id.is_some()
                    && state.database_id == old.database_id)
            {
                return Err(conflict());
            }
        }
    }
    Ok(())
}
fn consistent_backup(db: &Connection, path: &Path) -> Result<(), AppError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(storage_error)?;
    }
    db.execute(
        "VACUUM INTO ?",
        [path.to_str().ok_or_else(|| storage_error("path"))?],
    )
    .map_err(storage_error)?;
    Ok(())
}
pub fn migrate_local_database(
    db: &mut Connection,
    backup: &Path,
    version: u32,
    sql: &str,
) -> Result<(), AppError> {
    apply_local_migration(db, Some(backup), version, sql)
}
fn apply_local_migration(
    db: &mut Connection,
    backup: Option<&Path>,
    version: u32,
    sql: &str,
) -> Result<(), AppError> {
    let current: u32 = db
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(storage_error)?;
    if current > version {
        return Err(AppError::new(
            "LOCAL_SCHEMA_NEWER",
            "البيانات المحلية تخص إصدارًا أحدث. ثبّت الإصدار الأحدث للحفاظ على مسوداتك.",
        ));
    }
    if current == version {
        return Ok(());
    }
    if let Some(path) = backup {
        consistent_backup(db, path)?;
    }
    let transaction = db.transaction().map_err(storage_error)?;
    transaction.execute_batch(sql).map_err(|_| {
        AppError::new(
            "LOCAL_MIGRATION_FAILED",
            "تعذر ترقية البيانات المحلية. احتُفظ بمسوداتك والنسخة الاحتياطية.",
        )
    })?;
    transaction
        .pragma_update(None, "user_version", version)
        .map_err(storage_error)?;
    transaction.commit().map_err(storage_error)
}
impl LocalStore {
    pub fn saved_composers(
        &self,
        profile: &str,
        workspace: &str,
        active_windows: &[String],
    ) -> Result<Vec<SavedComposer>, AppError> {
        let db = self.lock()?;
        let mut statement = db.prepare(
            "SELECT c.window_id,c.draft_id,substr(COALESCE(NULLIF(json_extract(d.body,'$.title'),''),json_extract(d.body,'$.text'),''),1,80),COALESCE(json_extract(d.body,'$.createdAt'),'') FROM composer_drafts c JOIN drafts d ON d.profile_id=c.profile_id AND d.workspace_id=c.workspace_id AND d.id=c.draft_id WHERE c.profile_id=? AND c.workspace_id=? AND c.window_id LIKE 'composer-%' AND c.window_id NOT IN (SELECT value FROM json_each(?)) ORDER BY d.rowid DESC",
        ).map_err(storage_error)?;
        statement
            .query_map(
                params![
                    profile,
                    workspace,
                    serde_json::to_string(active_windows).map_err(storage_error)?
                ],
                |row| {
                    Ok(SavedComposer {
                        window_id: row.get(0)?,
                        draft_id: row.get(1)?,
                        preview: row.get(2)?,
                        created_at: row.get(3)?,
                    })
                },
            )
            .map_err(storage_error)?
            .map(|row| row.map_err(storage_error))
            .collect()
    }
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
        Self::initialize(Connection::open_in_memory().map_err(storage_error)?, None)
    }
    pub fn open(path: &Path) -> Result<Self, AppError> {
        Self::initialize(Connection::open(path).map_err(storage_error)?, Some(path))
    }
    fn initialize(mut db: Connection, path: Option<&Path>) -> Result<Self, AppError> {
        db.busy_timeout(std::time::Duration::from_secs(5))
            .map_err(storage_error)?;
        let version: u32 = db
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .map_err(storage_error)?;
        if version > 2 {
            return Err(AppError::new(
                "LOCAL_SCHEMA_NEWER",
                "البيانات المحلية تخص إصدارًا أحدث. ثبّت الإصدار الأحدث للحفاظ على مسوداتك.",
            ));
        }
        db.execute_batch("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;")
            .map_err(storage_error)?;
        let backup = path.filter(|_| version > 0 && version < 2).map(|path| {
            path.parent()
                .unwrap_or(Path::new("."))
                .join("backups")
                .join(format!(
                    "before-schema-{version}-{}.sqlite",
                    uuid::Uuid::new_v4()
                ))
        });
        apply_local_migration(&mut db, backup.as_deref(), 2, "
            CREATE TABLE IF NOT EXISTS profiles(id TEXT PRIMARY KEY,state_json TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS drafts(profile_id TEXT NOT NULL,workspace_id TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(profile_id,workspace_id,id),FOREIGN KEY(profile_id) REFERENCES profiles(id));
            CREATE TABLE IF NOT EXISTS window_drafts(profile_id TEXT NOT NULL,window_id TEXT NOT NULL,workspace_id TEXT NOT NULL,draft_id TEXT NOT NULL,PRIMARY KEY(profile_id,window_id),FOREIGN KEY(profile_id,workspace_id,draft_id) REFERENCES drafts(profile_id,workspace_id,id));
            CREATE TABLE IF NOT EXISTS composer_drafts(profile_id TEXT NOT NULL,window_id TEXT NOT NULL,workspace_id TEXT NOT NULL,draft_id TEXT NOT NULL,PRIMARY KEY(profile_id,window_id,workspace_id),FOREIGN KEY(profile_id,workspace_id,draft_id) REFERENCES drafts(profile_id,workspace_id,id));
            INSERT OR IGNORE INTO composer_drafts SELECT profile_id,window_id,workspace_id,draft_id FROM window_drafts;")?;
        Ok(Self {
            db: Mutex::new(db),
            path: path.map(Path::to_path_buf),
        })
    }
    pub fn backup(&self, path: &Path) -> Result<(), AppError> {
        let db = self.lock()?;
        consistent_backup(&db, path)
    }
    pub(crate) fn lock(&self) -> Result<MutexGuard<'_, Connection>, AppError> {
        self.db.lock().map_err(storage_error)
    }
    pub fn save_state(&self, state: &ProvisionState) -> Result<(), AppError> {
        self.lock()?.execute("INSERT INTO profiles(id,state_json) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET state_json=excluded.state_json",params![state.profile.id,serde_json::to_string(state).map_err(storage_error)?]).map_err(storage_error)?;
        Ok(())
    }
    pub(crate) fn validate_import_states(&self, states: &[ProvisionState]) -> Result<(), AppError> {
        validate_import(&self.list_states()?, states)
    }
    pub fn import_states(&self, states: &[ProvisionState]) -> Result<(), AppError> {
        let mut db = self.lock()?;
        let existing = read_states(&db)?;
        validate_import(&existing, states)?;
        if states.iter().all(|state| {
            existing
                .iter()
                .any(|old| old.profile.id == state.profile.id)
        }) {
            return Ok(());
        }
        if let Some(path) = &self.path {
            let backup = path
                .parent()
                .unwrap_or(Path::new("."))
                .join("backups")
                .join(format!(
                    "before-settings-import-{}.sqlite",
                    uuid::Uuid::new_v4()
                ));
            consistent_backup(&db, &backup)?;
        }
        let transaction = db
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        // Check again under the write transaction in case another process imported meanwhile.
        let existing = read_states(&transaction)?;
        validate_import(&existing, states)?;
        for state in states {
            if !existing
                .iter()
                .any(|old| old.profile.id == state.profile.id)
            {
                transaction
                    .execute(
                        "INSERT INTO profiles(id,state_json) VALUES(?,?)",
                        params![
                            state.profile.id,
                            serde_json::to_string(state).map_err(storage_error)?
                        ],
                    )
                    .map_err(storage_error)?;
            }
        }
        transaction.commit().map_err(storage_error)
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
        read_states(&db)
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
