use mawjivo_lib::{
    cloudflare_api::worker_upload_metadata,
    profiles::{LocalStore, ProvisionState},
    service_artifact::ServiceArtifact,
};
use rusqlite::Connection;
use serde_json::json;

#[test]
fn signed_release_verification_checks_real_bytes_and_the_signed_version() {
    use mawjivo_lib::updates::verify_signed_release;
    let original = include_bytes!("../../../../tests/fixtures/update-signature/payload.bin");
    let signature =
        include_str!("../../../../tests/fixtures/update-signature/payload.bin.sig").trim();
    let public_key = include_str!("../../../../tests/fixtures/update-signature/public.key").trim();
    verify_signed_release(original, signature, public_key, "0.1.1").unwrap();
    let mut tampered = original.to_vec();
    tampered[0] ^= 1;
    assert_eq!(
        verify_signed_release(&tampered, signature, public_key, "0.1.1")
            .unwrap_err()
            .code,
        "UPDATE_SIGNATURE_INVALID"
    );
    assert_eq!(
        verify_signed_release(original, signature, public_key, "0.1.9")
            .unwrap_err()
            .code,
        "UPDATE_SIGNATURE_INVALID"
    );
}

#[test]
fn a_newer_remote_schema_is_rejected_before_deployment() {
    let artifact = ServiceArtifact::bundled().unwrap();
    let error = mawjivo_lib::cloudflare_api::validate_remote_migrations(
        &artifact,
        &json!([{"name":"0099_future.sql","sha256":"future"}]),
    )
    .unwrap_err();
    assert_eq!(error.code, "SERVICE_SCHEMA_NEWER");
}
use async_trait::async_trait;
use mawjivo_lib::{
    contracts::{AppError, Draft, UpdateInfo},
    profiles::migrate_local_database,
    updates::{AvailableUpdate, OperationGate, UpdateBackend, UpdateManager},
};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

#[derive(Clone)]
struct TestUpdater {
    bad_signature: bool,
    installs: Arc<AtomicUsize>,
}
#[async_trait]
impl UpdateBackend for TestUpdater {
    type Offer = ();
    async fn check(&self) -> Result<Option<AvailableUpdate<()>>, AppError> {
        Ok(Some(AvailableUpdate {
            offer: (),
            info: UpdateInfo {
                id: String::new(),
                version: "0.1.1".into(),
                notes_ar: "تحسين حفظ المسودات.".into(),
                bytes: 4,
            },
        }))
    }
    async fn download(
        &self,
        _: &(),
        _: mawjivo_lib::updates::ProgressSink,
    ) -> Result<Vec<u8>, AppError> {
        if self.bad_signature {
            Err(AppError::new(
                "UPDATE_SIGNATURE_INVALID",
                "توقيع التحديث غير صالح. أعد الفحص.",
            ))
        } else {
            Ok(b"test".to_vec())
        }
    }
    fn install(&self, _: &(), bytes: &[u8]) -> Result<(), AppError> {
        self.installs.fetch_add(1, Ordering::SeqCst);
        assert_eq!(bytes, b"test");
        Ok(())
    }
}
fn updater(bad_signature: bool) -> (UpdateManager<TestUpdater>, Arc<AtomicUsize>) {
    let installs = Arc::new(AtomicUsize::new(0));
    (
        UpdateManager::new(
            TestUpdater {
                bad_signature,
                installs: installs.clone(),
            },
            OperationGate::default(),
        ),
        installs,
    )
}
#[tokio::test]
async fn a_bad_signature_never_reaches_the_installer() {
    let (manager, calls) = updater(true);
    let candidate = manager.check("main").await.unwrap().unwrap();
    let error = manager.download("main", &candidate.id).await.unwrap_err();
    assert_eq!(error.code, "UPDATE_SIGNATURE_INVALID");
    assert_eq!(
        manager.install("main", &candidate.id).unwrap_err().code,
        "UPDATE_NOT_VERIFIED"
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}
#[tokio::test]
async fn active_upload_or_media_work_blocks_install_until_an_explicit_retry() {
    let (manager, calls) = updater(false);
    let candidate = manager.check("main").await.unwrap().unwrap();
    manager.download("main", &candidate.id).await.unwrap();
    let work = manager.gate.work().unwrap();
    assert_eq!(
        manager.install("main", &candidate.id).unwrap_err().code,
        "UPDATE_BUSY"
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    drop(work);
    manager.install("main", &candidate.id).unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}
#[tokio::test]
async fn checking_an_update_does_not_authorize_installing_without_verified_download() {
    let (manager, calls) = updater(false);
    let candidate = manager.check("main").await.unwrap().unwrap();
    assert_eq!(
        manager.install("main", &candidate.id).unwrap_err().code,
        "UPDATE_NOT_VERIFIED"
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}
#[tokio::test]
async fn update_handles_belong_only_to_the_window_that_requested_them() {
    let (manager, calls) = updater(false);
    let candidate = manager.check("main").await.unwrap().unwrap();
    assert_eq!(
        manager
            .download("composer-other", &candidate.id)
            .await
            .unwrap_err()
            .code,
        "UPDATE_NOT_FOUND"
    );
    manager.download("main", &candidate.id).await.unwrap();
    assert_eq!(
        manager
            .install("composer-other", &candidate.id)
            .unwrap_err()
            .code,
        "UPDATE_NOT_FOUND"
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}
#[test]
fn a_failed_migration_preserves_the_draft_vault_reference_and_consistent_backup() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("local.sqlite");
    let backup = directory.path().join("before-upgrade.sqlite");
    let store = LocalStore::open(&path).unwrap();
    let state = ProvisionState::new("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    store.save_state(&state).unwrap();
    let original: Draft = serde_json::from_str(include_str!(
        "../../../../packages/core/test/contract-fixture.json"
    ))
    .unwrap();
    store
        .save_draft(&state.profile.id, "main", &original)
        .unwrap();
    drop(store);
    let mut db = Connection::open(&path).unwrap();
    let error = migrate_local_database(
        &mut db,
        &backup,
        3,
        "UPDATE drafts SET body='lost'; CREATE TABLE invalid(; ",
    )
    .unwrap_err();
    assert_eq!(error.code, "LOCAL_MIGRATION_FAILED");
    drop(db);
    let store = LocalStore::open(&path).unwrap();
    assert_eq!(
        store
            .load_draft(&state.profile.id, &original.workspace_id, &original.id)
            .unwrap(),
        Some(original.clone())
    );
    assert_eq!(
        store
            .get_state(&state.profile.id)
            .unwrap()
            .profile
            .device_credential_ref,
        state.profile.device_credential_ref
    );
    let restored = LocalStore::open(&backup).unwrap();
    assert_eq!(
        restored
            .load_draft(&state.profile.id, &original.workspace_id, &original.id)
            .unwrap(),
        Some(original)
    );
    assert_eq!(
        restored.get_state(&state.profile.id).unwrap().profile,
        state.profile
    );
}

#[test]
fn a_newer_local_database_is_rejected_before_any_schema_or_data_write() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("local.sqlite");
    let connection = Connection::open(&path).unwrap();
    connection.execute_batch("CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES('keep'); PRAGMA user_version=99;").unwrap();
    drop(connection);
    let result = LocalStore::open(&path);
    assert!(result.is_err(), "An older app must refuse a newer schema");
    assert_eq!(result.err().unwrap().code, "LOCAL_SCHEMA_NEWER");
    let connection = Connection::open(&path).unwrap();
    let version: u32 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap();
    assert_eq!(version, 99);
    let value: String = connection
        .query_row("SELECT value FROM sentinel", [], |row| row.get(0))
        .unwrap();
    assert_eq!(value, "keep");
    let tables: u32 = connection
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        tables, 1,
        "Refusing an upgrade must not create old app tables"
    );
}

#[test]
fn worker_upgrade_keeps_healthchecks_secrets_without_sending_their_values() {
    let artifact = ServiceArtifact::bundled().unwrap();
    let state = ProvisionState::new("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    let bindings =
        vec![json!({"name":"SERVICE_VERSION","type":"plain_text","text":artifact.version})];
    let metadata = worker_upload_metadata(&artifact, &state, bindings);
    assert_eq!(metadata["keep_bindings"], json!(["secret_text"]));
    assert_eq!(metadata["tags"], json!([state.owner_tag()]));
    let body = metadata.to_string();
    for secret in ["HEARTBEAT_PING_URL", "DAILY_PING_URL", "MONITOR_TIME_ZONE"] {
        assert!(
            !body.contains(secret),
            "Keep the existing values on Cloudflare"
        );
    }
}
