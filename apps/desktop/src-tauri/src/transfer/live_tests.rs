use super::{TransferReadApi, inspect_with};
use crate::{contracts::AppError, profiles::ProvisionState};
use async_trait::async_trait;
use serde_json::{Value, json};
use std::{collections::BTreeMap, sync::Mutex};

struct ReadApi {
    workspace_requests: Mutex<Vec<String>>,
    sql: Mutex<Vec<String>>,
    revoked: bool,
    allowed: String,
    foreign_owner: bool,
    wrong_worker: bool,
    wrong_binding: bool,
    wrong_database: bool,
    wrong_bucket: bool,
}
impl Default for ReadApi {
    fn default() -> Self {
        Self {
            workspace_requests: Mutex::new(vec![]),
            sql: Mutex::new(vec![]),
            revoked: false,
            allowed: "\"*\"".into(),
            foreign_owner: false,
            wrong_worker: false,
            wrong_binding: false,
            wrong_database: false,
            wrong_bucket: false,
        }
    }
}
fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../../../../tests/fixtures/transfer-aes-gcm.json"
    ))
    .unwrap()
}
fn state() -> ProvisionState {
    let mut state = ProvisionState::new(&"a".repeat(32));
    state.profile.id = format!("{:032x}", 1);
    state.profile.service_id = state.profile.id.clone();
    state.profile.device_credential_ref = format!("{}:device", state.profile.id);
    state.profile.base_url = "https://owned.example.test".into();
    state.domain = Some("owned.example.test".into());
    state.zone_id = Some("b".repeat(32));
    state.database_id = Some("00000000-0000-4000-8000-000000000001".into());
    state.bucket_created = true;
    state
}
fn secrets() -> BTreeMap<String, String> {
    let id = state().profile.id;
    BTreeMap::from([
        (
            format!("{id}:device"),
            fixture()["deviceToken"].as_str().unwrap().into(),
        ),
        (
            format!("{id}:encryption"),
            fixture()["keyBase64"].as_str().unwrap().into(),
        ),
        (
            format!("{id}:cloudflare"),
            "synthetic-cf-token-not-real".into(),
        ),
        (format!("{id}:r2-access"), "TEST_r2_access".into()),
        (format!("{id}:r2-secret"), "TEST_r2_secret".into()),
    ])
}
#[async_trait]
impl TransferReadApi for ReadApi {
    async fn settings(&self, state: &ProvisionState) -> Result<Value, AppError> {
        Ok(json!({
            "tags":[state.owner_tag()],
            "bindings":[
                {"name":"SERVICE_ID","type":"plain_text","text":if self.wrong_binding {"another-service"} else {&state.profile.service_id}},
                {"name":"SERVICE_VERSION","type":"plain_text","text":"0.1.0"}
                ,{"name":"DB","type":"d1","id":if self.wrong_database {"other-database"} else {state.database_id.as_deref().unwrap()}},
                {"name":"MEDIA","type":"r2_bucket","bucket_name":if self.wrong_bucket {"other-bucket".into()} else {format!("{}-media",state.worker_name())}}
            ]
        }))
    }
    async fn verify_resources(&self, _: &ProvisionState) -> Result<(), AppError> {
        if self.foreign_owner {
            Err(AppError::new("RESOURCE_NOT_OWNED", "مورد مختلف"))
        } else {
            Ok(())
        }
    }
    async fn domains(&self) -> Result<Value, AppError> {
        Ok(
            json!([{"hostname":"owned.example.test","service":if self.wrong_worker {"another-worker".into()} else {state().worker_name()},"zone_id":"b".repeat(32)}]),
        )
    }
    async fn workers_subdomain(&self) -> Result<String, AppError> {
        Ok("test-account".into())
    }
    async fn query(
        &self,
        _: &ProvisionState,
        sql: &str,
        params: Vec<String>,
    ) -> Result<Vec<Value>, AppError> {
        self.sql.lock().unwrap().push(sql.into());
        assert!(
            sql.trim_start().starts_with("SELECT "),
            "Transfer executed a mutation"
        );
        if sql.contains("FROM devices") {
            if params.first().map(String::as_str) != fixture()["deviceTokenSha256"].as_str() {
                return Ok(vec![]);
            }
            return Ok(vec![
                json!({"id":state().profile.id,"allowed_workspace_ids":self.allowed,"revoked_at_ms":if self.revoked {Some(1)} else {None}}),
            ]);
        }
        if sql.contains("FROM connections") {
            assert!(params.iter().any(|value| value == "space-1"));
            return Ok(vec![
                json!({"id":"meta-1","workspace_id":"space-1","provider":"meta","label":"Meta الحالي","secret_cipher":fixture()["cipher"],"key_version":1,"version":2}),
            ]);
        }
        if sql.contains("FROM service_settings") {
            assert!(params.contains(&"telegram:space-1".into()));
            return Ok(vec![
                json!({"key":"telegram:space-1","value_json":json!({"cipher":fixture()["telegramCipher"]}).to_string()}),
            ]);
        }
        panic!("Unexpected read query");
    }
    async fn workspaces(&self, base_url: &str, token: &str) -> Result<Vec<Value>, AppError> {
        assert_eq!(token, fixture()["deviceToken"].as_str().unwrap());
        self.workspace_requests
            .lock()
            .unwrap()
            .push(base_url.into());
        Ok(vec![
            json!({"id":"space-1","name":"مساحتي","serviceProfileId":state().profile.id,"defaultYoutubeCategoryId":"25","preferredChannels":{"youtube":"latest-channel"}}),
            json!({"id":"space-2","name":"المساحة الثانية","serviceProfileId":state().profile.id,"defaultYoutubeCategoryId":"10"}),
        ])
    }
}

#[tokio::test]
async fn foreign_base_url_receives_no_device_bearer() {
    let api = ReadApi::default();
    let mut state = state();
    state.profile.base_url = "https://foreign.example.test".into();
    assert!(inspect_with(&api, &state, &secrets()).await.is_err());
    assert!(api.workspace_requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn revoked_device_is_rejected_before_contacting_service() {
    let api = ReadApi {
        revoked: true,
        ..Default::default()
    };
    assert!(inspect_with(&api, &state(), &secrets()).await.is_err());
    assert!(api.workspace_requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn scopes_accounts_to_allowed_workspaces() {
    let api = ReadApi {
        allowed: "[\"space-1\"]".into(),
        ..Default::default()
    };
    let result = inspect_with(&api, &state(), &secrets()).await.unwrap();
    assert_eq!(result.snapshot.workspaces.len(), 1);
    assert_eq!(result.snapshot.workspaces[0]["id"], "space-1");
    assert_eq!(result.snapshot.connections.len(), 1);
    assert_eq!(result.snapshot.telegram[0]["workspaceId"], "space-1");
    assert_eq!(
        result.snapshot.telegram[0]["botToken"],
        "TEST_telegram_token_not_real"
    );
    assert_eq!(
        result.snapshot.connections[0]["credentials"]["pageAccessToken"],
        "TEST_page_token_not_real"
    );
}

#[tokio::test]
async fn owned_read_keeps_latest_preferences_without_mutations() {
    let api = ReadApi::default();
    let result = inspect_with(&api, &state(), &secrets()).await.unwrap();
    assert_eq!(result.snapshot.workspaces.len(), 2);
    assert_eq!(
        result.snapshot.workspaces[0]["defaultYoutubeCategoryId"],
        "25"
    );
    assert_eq!(
        result.snapshot.workspaces[0]["preferredChannels"]["youtube"],
        "latest-channel"
    );
    assert_eq!(
        api.workspace_requests.lock().unwrap().as_slice(),
        ["https://owned.example.test"]
    );
}

#[tokio::test]
async fn unavailable_or_foreign_resources_return_no_snapshot() {
    let api = ReadApi {
        foreign_owner: true,
        ..Default::default()
    };
    assert!(inspect_with(&api, &state(), &secrets()).await.is_err());
    assert!(api.workspace_requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn another_worker_or_service_binding_receives_no_device_bearer() {
    for api in [
        ReadApi {
            wrong_worker: true,
            ..Default::default()
        },
        ReadApi {
            wrong_binding: true,
            ..Default::default()
        },
    ] {
        assert!(inspect_with(&api, &state(), &secrets()).await.is_err());
        assert!(api.workspace_requests.lock().unwrap().is_empty());
    }
}

#[tokio::test]
async fn proves_workers_dev_from_account_subdomain() {
    let api = ReadApi::default();
    let mut state = state();
    state.domain = None;
    state.zone_id = None;
    state.profile.base_url = format!("https://{}.test-account.workers.dev", state.worker_name());
    assert!(inspect_with(&api, &state, &secrets()).await.is_ok());
    let foreign = ReadApi::default();
    state.profile.base_url = format!(
        "https://{}.another-account.workers.dev",
        state.worker_name()
    );
    assert!(inspect_with(&foreign, &state, &secrets()).await.is_err());
    assert!(foreign.workspace_requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn absent_device_and_invalid_scope_never_reach_service() {
    let api = ReadApi::default();
    let mut values = secrets();
    values.insert(
        state().profile.device_credential_ref,
        "TEST_unknown_device_00000000000000000000000000000001".into(),
    );
    assert!(inspect_with(&api, &state(), &values).await.is_err());
    assert!(api.workspace_requests.lock().unwrap().is_empty());
    let invalid = ReadApi {
        allowed: "[1]".into(),
        ..Default::default()
    };
    assert!(inspect_with(&invalid, &state(), &secrets()).await.is_err());
    assert!(invalid.workspace_requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn empty_device_scope_reads_no_accounts_or_telegram() {
    let api = ReadApi {
        allowed: "[]".into(),
        ..Default::default()
    };
    let result = inspect_with(&api, &state(), &secrets()).await.unwrap();
    assert!(result.snapshot.workspaces.is_empty());
    assert!(result.snapshot.connections.is_empty());
    assert!(result.snapshot.telegram.is_empty());
    assert_eq!(api.sql.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn worker_bound_to_different_resources_is_rejected_before_bearer() {
    for api in [
        ReadApi {
            wrong_database: true,
            ..Default::default()
        },
        ReadApi {
            wrong_bucket: true,
            ..Default::default()
        },
    ] {
        assert!(inspect_with(&api, &state(), &secrets()).await.is_err());
        assert!(api.workspace_requests.lock().unwrap().is_empty());
    }
}
