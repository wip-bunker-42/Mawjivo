#[path = "support/transfer.rs"]
mod support;
use mawjivo_lib::transfer::{parse_env, serialize_env};
use serde_json::json;
use support::{fixture_bundle, legacy_env};

fn error_code(bytes: &[u8]) -> String {
    match parse_env(bytes) {
        Err(error) => error.code,
        Ok(_) => panic!("Invalid transfer file was accepted"),
    }
}

#[test]
fn accepts_legacy_single_profile_file() {
    let parsed = parse_env(&legacy_env(&fixture_bundle(1))).unwrap();
    assert_eq!(parsed.services.len(), 1);
    assert_eq!(
        parsed.services[0].state.profile.id,
        "00000000000000000000000000000001"
    );
    assert_eq!(parsed.services[0].snapshot.connections.len(), 3);
    assert_eq!(
        parsed.services[0].snapshot.workspaces[0]["defaultYoutubeCategoryId"],
        "25"
    );
    assert_eq!(
        parsed.services[0].snapshot.workspaces[0]["preferredChannels"]["youtube"],
        "my-youtube-channel"
    );
}

#[test]
fn round_trip_preserves_multiple_services_and_readable_settings() {
    let mut bundle = fixture_bundle(2);
    bundle.services[1].snapshot.connections[1]["label"] = json!("عربي \"واضح\" = ☄️\nسطر");
    let bytes = serialize_env(&bundle).unwrap();
    let text = String::from_utf8(bytes.clone()).unwrap();
    assert!(text.contains("MAWJIVO_SERVICE_PROFILES_JSON=["));
    assert!(text.contains("synthetic-buffer-a"));
    assert!(!text.contains("SIGNING_PRIVATE_KEY"));
    let parsed = parse_env(&bytes).unwrap();
    assert_eq!(parsed.services.len(), 2);
    assert_eq!(
        parsed.services[1].state.profile.id,
        "00000000000000000000000000000002"
    );
    assert_eq!(
        parsed.services[1].snapshot.connections[1]["label"],
        "عربي \"واضح\" = ☄️\nسطر"
    );
    assert_eq!(
        parsed.services[1].snapshot.workspaces[0]["serviceProfileId"],
        "00000000000000000000000000000002"
    );
}

#[test]
fn rejects_duplicate_env_keys() {
    let mut bytes = legacy_env(&fixture_bundle(1));
    bytes.extend_from_slice(b"MAWJIVO_DEVICE_EXPORT_SCHEMA=1\n");
    assert_eq!(error_code(&bytes), "TRANSFER_FILE_INVALID");
}

#[test]
fn rejects_files_over_two_mib_before_parsing() {
    assert_eq!(
        error_code(&vec![b' '; 2 * 1024 * 1024 + 1]),
        "TRANSFER_FILE_TOO_LARGE"
    );
}

#[test]
fn rejects_unsupported_file_schema() {
    let text = String::from_utf8(legacy_env(&fixture_bundle(1)))
        .unwrap()
        .replace("EXPORT_SCHEMA=1", "EXPORT_SCHEMA=2");
    assert_eq!(error_code(text.as_bytes()), "TRANSFER_FILE_VERSION");
}

#[test]
fn rejects_foreign_vault_references() {
    let mut bundle = fixture_bundle(1);
    bundle.services[0].secrets.insert(
        "00000000000000000000000000000002:device".into(),
        "synthetic-foreign-device".into(),
    );
    assert_eq!(error_code(&legacy_env(&bundle)), "TRANSFER_FILE_INVALID");
}

#[test]
fn rejects_missing_required_local_credentials() {
    let mut bundle = fixture_bundle(1);
    bundle.services[0]
        .secrets
        .remove("00000000000000000000000000000001:encryption");
    // Construct without the optional alias, so the test reaches missing-vault validation.
    let raw = format!(
        "MAWJIVO_DEVICE_EXPORT_SCHEMA=1\nMAWJIVO_EXPORTED_AT={}\nMAWJIVO_SERVICE_PROFILE_JSON={}\nMAWJIVO_VAULT_JSON={}\nMAWJIVO_WORKSPACES_JSON={}\nMAWJIVO_CONNECTIONS_JSON={}\nMAWJIVO_TELEGRAM_JSON=[]\n",
        bundle.exported_at,
        serde_json::to_string(&bundle.services[0].state).unwrap(),
        serde_json::to_string(&bundle.services[0].secrets).unwrap(),
        serde_json::to_string(&bundle.services[0].snapshot.workspaces).unwrap(),
        serde_json::to_string(&bundle.services[0].snapshot.connections).unwrap()
    );
    assert_eq!(error_code(raw.as_bytes()), "TRANSFER_FILE_INVALID");
}

#[test]
fn ignores_project_signing_fields() {
    let mut bytes = legacy_env(&fixture_bundle(1));
    bytes.extend_from_slice(b"MAWJIVO_SIGNING_PRIVATE_KEY=synthetic-project-only\nTAURI_SIGNING_PRIVATE_KEY=synthetic-project-only\n");
    let parsed = parse_env(&bytes).unwrap();
    assert_eq!(parsed.services[0].secrets.len(), 5);
    assert!(
        parsed.services[0]
            .secrets
            .keys()
            .all(|key| !key.contains("SIGNING"))
    );
}

#[test]
fn rejects_conflicting_singular_and_array_profiles() {
    let one = fixture_bundle(1);
    let other = fixture_bundle(2);
    let mut bytes = legacy_env(&one);
    bytes.extend_from_slice(
        format!(
            "MAWJIVO_SERVICE_PROFILES_JSON={}\n",
            serde_json::to_string(&vec![&other.services[1].state]).unwrap()
        )
        .as_bytes(),
    );
    assert_eq!(error_code(&bytes), "TRANSFER_FILE_INVALID");
}

#[test]
fn accepts_windows_crlf_and_utf8_bom() {
    let text = String::from_utf8(legacy_env(&fixture_bundle(1)))
        .unwrap()
        .replace('\n', "\r\n");
    let parsed = parse_env(format!("\u{feff}{text}").as_bytes()).unwrap();
    assert_eq!(parsed.services.len(), 1);
}

#[test]
fn rejects_malformed_json_and_invalid_utf8() {
    assert_eq!(
        error_code(b"MAWJIVO_DEVICE_EXPORT_SCHEMA=1\nMAWJIVO_SERVICE_PROFILE_JSON={\n"),
        "TRANSFER_FILE_INVALID"
    );
    assert_eq!(error_code(&[0xff, 0xfe]), "TRANSFER_FILE_INVALID");
}

#[test]
fn rejects_workspace_from_another_service() {
    let mut bundle = fixture_bundle(1);
    bundle.services[0].snapshot.workspaces[0]["serviceProfileId"] =
        json!("00000000000000000000000000000002");
    assert_eq!(error_code(&legacy_env(&bundle)), "TRANSFER_FILE_INVALID");
}

#[test]
fn rejects_connection_or_telegram_outside_exported_workspaces() {
    let mut bundle = fixture_bundle(1);
    bundle.services[0].snapshot.connections[0]["workspaceId"] = json!("foreign-space");
    assert_eq!(error_code(&legacy_env(&bundle)), "TRANSFER_FILE_INVALID");
    let mut bundle = fixture_bundle(1);
    bundle.services[0].snapshot.telegram[0]["workspaceId"] = json!("foreign-space");
    assert_eq!(error_code(&legacy_env(&bundle)), "TRANSFER_FILE_INVALID");
}

#[test]
fn rejects_inconsistent_secret_alias_and_unsafe_service_url() {
    let text = String::from_utf8(legacy_env(&fixture_bundle(1)))
        .unwrap()
        .replace(
            "MAWJIVO_DEVICE_TOKEN=TEST_transfer_device_",
            "MAWJIVO_DEVICE_TOKEN=TEST_wrong_device_",
        );
    assert_eq!(error_code(text.as_bytes()), "TRANSFER_FILE_INVALID");
    let mut bundle = fixture_bundle(1);
    bundle.services[0].state.profile.base_url =
        "https://user:password@space-1.example.test/?token=x".into();
    assert_eq!(error_code(&legacy_env(&bundle)), "TRANSFER_FILE_INVALID");
}

#[test]
fn decrypts_service_web_crypto_envelope() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../tests/fixtures/transfer-aes-gcm.json"
    ))
    .unwrap();
    let actual = mawjivo_lib::transfer::decrypt_connection(
        fixture["cipher"].as_str().unwrap(),
        fixture["keyBase64"].as_str().unwrap(),
        "space-1",
        "meta-1",
        1,
    )
    .unwrap();
    assert_eq!(actual["pageAccessToken"], "TEST_page_token_not_real");
    assert_eq!(actual["instagramId"], "2");
}

#[test]
fn rejects_wrong_aad_or_key() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../tests/fixtures/transfer-aes-gcm.json"
    ))
    .unwrap();
    for (workspace, connection, version) in [
        ("foreign-space", "meta-1", 1),
        ("space-1", "foreign-connection", 1),
        ("space-1", "meta-1", 2),
    ] {
        assert!(
            mawjivo_lib::transfer::decrypt_connection(
                fixture["cipher"].as_str().unwrap(),
                fixture["keyBase64"].as_str().unwrap(),
                workspace,
                connection,
                version
            )
            .is_err()
        );
    }
    assert!(
        mawjivo_lib::transfer::decrypt_connection(
            fixture["cipher"].as_str().unwrap(),
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
            "space-1",
            "meta-1",
            1
        )
        .is_err()
    );
}
