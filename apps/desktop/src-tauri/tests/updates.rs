use mawjivo_lib::{
    cloudflare_api::worker_upload_metadata,
    profiles::{LocalStore, ProvisionState},
    service_artifact::ServiceArtifact,
};
use rusqlite::Connection;
use serde_json::json;

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
    let version: u32 = connection.query_row("PRAGMA user_version", [], |row| row.get(0)).unwrap();
    assert_eq!(version, 99);
    let value: String = connection.query_row("SELECT value FROM sentinel", [], |row| row.get(0)).unwrap();
    assert_eq!(value, "keep");
    let tables: u32 = connection.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='table'", [], |row| row.get(0)).unwrap();
    assert_eq!(tables, 1, "Refusing an upgrade must not create old app tables");
}

#[test]
fn worker_upgrade_keeps_healthchecks_secrets_without_sending_their_values() {
    let artifact = ServiceArtifact::bundled().unwrap();
    let state = ProvisionState::new("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    let bindings = vec![json!({"name":"SERVICE_VERSION","type":"plain_text","text":artifact.version})];
    let metadata = worker_upload_metadata(&artifact, &state, bindings);
    assert_eq!(metadata["keep_bindings"], json!(["secret_text"]));
    assert_eq!(metadata["tags"], json!([state.owner_tag()]));
    let body = metadata.to_string();
    for secret in ["HEARTBEAT_PING_URL", "DAILY_PING_URL", "MONITOR_TIME_ZONE"] {
        assert!(!body.contains(secret), "Keep the existing values on Cloudflare");
    }
}
