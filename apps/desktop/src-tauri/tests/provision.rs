use async_trait::async_trait;
use mawjivo_lib::{
    cloudflare::{ProvisionApi, provision_with, service_package_info, upgrade_with},
    contracts::{AppError, Draft},
    profiles::{LocalStore, ProvisionInput, ProvisionState},
    vault::Vault,
};
use std::{collections::HashMap, sync::Mutex};
#[test]
fn database_ownership_script_is_valid_without_d1_multi_statement_parameters() {
    let service = "de19f04f6457408eb1c6d47aa32428f2";
    let payload = mawjivo_lib::cloudflare_api::database_owner_payload(service).unwrap();
    assert!(payload["params"].as_array().unwrap().is_empty());
    let db = rusqlite::Connection::open_in_memory().unwrap();
    db.execute_batch(payload["sql"].as_str().unwrap()).unwrap();
    let actual: String = db
        .query_row(
            "SELECT service_id FROM mawjivo_owner WHERE singleton=1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(actual, service);
    assert!(
        mawjivo_lib::cloudflare_api::database_owner_payload("a');DROP TABLE mawjivo_owner;--")
            .is_err()
    );
    assert!(mawjivo_lib::cloudflare_api::database_owner_payload("").is_err());
}
#[derive(Default)]
struct TestVault(Mutex<HashMap<String, String>>);
impl Vault for TestVault {
    fn get(&self, reference: &str) -> Result<String, AppError> {
        self.0
            .lock()
            .unwrap()
            .get(reference)
            .cloned()
            .ok_or_else(|| AppError::new("SECRET_MISSING", "مفقود"))
    }
    fn set(&self, reference: &str, value: &str) -> Result<(), AppError> {
        self.0
            .lock()
            .unwrap()
            .insert(reference.into(), value.into());
        Ok(())
    }
}
#[derive(Default)]
struct FakeApi {
    tags: Mutex<Option<Vec<String>>>,
    creates: Mutex<u32>,
    deploys: Mutex<u32>,
    fail_bucket: Mutex<bool>,
}
#[async_trait]
impl ProvisionApi for FakeApi {
    async fn verify_existing_resources(&self, _: &ProvisionState) -> Result<(), AppError> {
        Ok(())
    }
    async fn worker_tags(&self, _: &str) -> Result<Option<Vec<String>>, AppError> {
        Ok(self.tags.lock().unwrap().clone())
    }
    async fn database(&self, _: &str, known: Option<&str>) -> Result<String, AppError> {
        if let Some(id) = known {
            return Ok(id.into());
        }
        *self.creates.lock().unwrap() += 1;
        Ok("database-1".into())
    }
    async fn bucket(&self, _: &str, _: bool) -> Result<(), AppError> {
        if *self.fail_bucket.lock().unwrap() {
            Err(AppError::new("R2_PERMISSION", "صلاحية R2"))
        } else {
            Ok(())
        }
    }
    async fn deploy(
        &self,
        state: &ProvisionState,
        _: &str,
        _: &str,
        _: &ProvisionInput,
    ) -> Result<String, AppError> {
        *self.deploys.lock().unwrap() += 1;
        *self.tags.lock().unwrap() = Some(vec![state.owner_tag()]);
        Ok("https://test.workers.dev".into())
    }
}
fn input() -> ProvisionInput {
    ProvisionInput {
        account_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into(),
        api_token: "synthetic-cf-token-not-real".into(),
        r2_access_key_id: "synthetic-r2-id".into(),
        r2_secret_access_key: "synthetic-r2-secret".into(),
        zone_id: None,
        domain: None,
    }
}
#[tokio::test]
async fn service_upgrade_preserves_resource_ids_vault_and_local_draft() {
    let store = LocalStore::memory().unwrap();
    let vault = TestVault::default();
    let api = FakeApi::default();
    let first = provision_with(
        &api,
        &vault,
        &store,
        ProvisionState::new(&input().account_id),
        input(),
    )
    .await
    .unwrap();
    let before = store.get_state(&first.id).unwrap();
    let device = vault.get(&first.device_credential_ref).unwrap();
    let key = vault.get(&format!("{}:encryption", first.id)).unwrap();
    let draft: Draft = serde_json::from_value(serde_json::json!({"id":"kept-draft","workspaceId":"space-a","workspaceVersion":1,"timeZone":"Africa/Cairo","revision":1,"text":"مسودة محفوظة","title":"","assets":[],"selections":[],"overrides":{},"scheduleLocal":null,"scheduleOffset":null,"createdAt":"2026-10-11T00:00:00Z"})).unwrap();
    store.save_draft(&first.id, "main", &draft).unwrap();
    let package = service_package_info().unwrap();
    let upgraded = upgrade_with(&api, &vault, &store, &first.id, &package.id)
        .await
        .unwrap();
    assert_eq!(upgraded.id, first.id);
    assert_eq!(upgraded.service_id, first.service_id);
    assert_eq!(upgraded.device_credential_ref, first.device_credential_ref);
    assert_eq!(upgraded.version, package.version);
    assert_eq!(
        store.get_state(&first.id).unwrap().database_id,
        before.database_id
    );
    assert_eq!(vault.get(&first.device_credential_ref).unwrap(), device);
    assert_eq!(vault.get(&format!("{}:encryption", first.id)).unwrap(), key);
    assert_eq!(
        store
            .load_draft(&first.id, "space-a", "kept-draft")
            .unwrap(),
        Some(draft)
    );
    assert_eq!(*api.creates.lock().unwrap(), 1);
    assert_eq!(*api.deploys.lock().unwrap(), 2);
}
#[tokio::test]
async fn upgrade_refuses_missing_or_foreign_worker_without_recreating_it() {
    for tags in [None, Some(vec!["foreign".into()])] {
        let store = LocalStore::memory().unwrap();
        let state = ProvisionState::new(&input().account_id);
        store.save_state(&state).unwrap();
        let api = FakeApi {
            tags: Mutex::new(tags),
            ..Default::default()
        };
        let error = upgrade_with(
            &api,
            &TestVault::default(),
            &store,
            &state.profile.id,
            &service_package_info().unwrap().id,
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "RESOURCE_NOT_OWNED");
        assert_eq!(*api.creates.lock().unwrap(), 0);
        assert_eq!(*api.deploys.lock().unwrap(), 0);
    }
}
#[tokio::test]
async fn upgrade_rejects_renderer_supplied_package_before_cloudflare_writes() {
    let store = LocalStore::memory().unwrap();
    let api = FakeApi::default();
    let error = upgrade_with(
        &api,
        &TestVault::default(),
        &store,
        "profile",
        "C:/untrusted/worker.js",
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, "SERVICE_PACKAGE_INVALID");
    assert_eq!(*api.deploys.lock().unwrap(), 0);
}
#[tokio::test]
async fn missing_zone_is_rejected_before_creating_resources() {
    let store = LocalStore::memory().unwrap();
    let api = FakeApi::default();
    let mut value = input();
    value.domain = Some("mawjivo.example.com".into());
    let error = provision_with(
        &api,
        &TestVault::default(),
        &store,
        ProvisionState::new(&value.account_id),
        value,
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, "INVALID_DOMAIN");
    assert_eq!(*api.creates.lock().unwrap(), 0);
}
#[tokio::test]
async fn provision_twice_reuses_owned_resources() {
    let store = LocalStore::memory().unwrap();
    let vault = TestVault::default();
    let api = FakeApi::default();
    let state = ProvisionState::new(&input().account_id);
    let first = provision_with(&api, &vault, &store, state, input())
        .await
        .unwrap();
    let second = provision_with(
        &api,
        &vault,
        &store,
        store.get_state(&first.id).unwrap(),
        input(),
    )
    .await
    .unwrap();
    assert_eq!(first.service_id, second.service_id);
    assert_eq!(*api.creates.lock().unwrap(), 1);
}
#[tokio::test]
async fn foreign_existing_worker_is_not_overwritten() {
    let store = LocalStore::memory().unwrap();
    let api = FakeApi {
        tags: Mutex::new(Some(vec!["foreign".into()])),
        ..Default::default()
    };
    let error = provision_with(
        &api,
        &TestVault::default(),
        &store,
        ProvisionState::new(&input().account_id),
        input(),
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, "RESOURCE_NOT_OWNED");
    assert_eq!(*api.deploys.lock().unwrap(), 0);
    assert_eq!(*api.creates.lock().unwrap(), 0);
}
#[tokio::test]
async fn partial_setup_resumes_without_destroying_resources() {
    let store = LocalStore::memory().unwrap();
    let vault = TestVault::default();
    let api = FakeApi {
        fail_bucket: Mutex::new(true),
        ..Default::default()
    };
    let state = ProvisionState::new(&input().account_id);
    let id = state.profile.id.clone();
    assert!(
        provision_with(&api, &vault, &store, state, input())
            .await
            .is_err()
    );
    assert_eq!(
        store.get_state(&id).unwrap().database_id.as_deref(),
        Some("database-1")
    );
    *api.fail_bucket.lock().unwrap() = false;
    provision_with(&api, &vault, &store, store.get_state(&id).unwrap(), input())
        .await
        .unwrap();
    assert_eq!(*api.creates.lock().unwrap(), 1);
}
#[test]
fn two_profiles_and_windows_do_not_share_drafts() {
    let store = LocalStore::memory().unwrap();
    let first = ProvisionState::new("first");
    let second = ProvisionState::new("second");
    store.save_state(&first).unwrap();
    store.save_state(&second).unwrap();
    let mut a: Draft = serde_json::from_str(include_str!(
        "../../../../packages/core/test/contract-fixture.json"
    ))
    .unwrap();
    a.id = "draft-a".into();
    let mut b = a.clone();
    b.id = "draft-b".into();
    b.text = "نص آخر".into();
    store.save_draft(&first.profile.id, "window-a", &a).unwrap();
    store.save_draft(&first.profile.id, "window-b", &b).unwrap();
    assert_eq!(
        store
            .load_draft(&first.profile.id, &a.workspace_id, &a.id)
            .unwrap(),
        Some(a.clone())
    );
    assert_eq!(
        store
            .load_draft(&first.profile.id, &b.workspace_id, &b.id)
            .unwrap(),
        Some(b)
    );
    assert_eq!(
        store
            .load_draft(&second.profile.id, &a.workspace_id, &a.id)
            .unwrap(),
        None
    );
}
#[test]
fn initial_migration_resumes_from_partial_schema_without_losing_data() {
    let sql = include_str!("../../../../apps/service/migrations/0001_initial.sql");
    let db = rusqlite::Connection::open_in_memory().unwrap();
    let first = sql.split(';').take(3).collect::<Vec<_>>().join(";") + ";";
    db.execute_batch(&first).unwrap();
    db.execute("INSERT INTO workspaces(id,name,time_zone,version,default_platforms,service_profile_id,created_at_ms,updated_at_ms) VALUES('existing','مساحة محفوظة','Africa/Cairo',1,'[]','profile',0,0)",[]).unwrap();
    db.execute_batch(sql).unwrap();
    db.execute_batch(sql).unwrap();
    assert_eq!(
        db.query_row(
            "SELECT name FROM workspaces WHERE id='existing'",
            [],
            |row| row.get::<_, String>(0)
        )
        .unwrap(),
        "مساحة محفوظة"
    );
}
#[tokio::test]
async fn renderer_never_receives_raw_tokens() {
    let store = LocalStore::memory().unwrap();
    let vault = TestVault::default();
    let api = FakeApi::default();
    let profile = provision_with(
        &api,
        &vault,
        &store,
        ProvisionState::new(&input().account_id),
        input(),
    )
    .await
    .unwrap();
    let json = serde_json::to_string(&profile).unwrap();
    assert!(!json.contains(&input().api_token));
    assert!(!json.contains(&input().r2_secret_access_key));
    assert!(vault.get(&profile.device_credential_ref).unwrap().len() >= 40);
}
