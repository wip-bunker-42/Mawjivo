use super::*;
use mawjivo_lib::{
    profiles::LocalStore,
    transfer::{export_to, import_from},
    vault::Vault,
};
use operations_support::{LiveSource, TransferVault};

fn input_file(count: usize) -> (tempfile::TempDir, std::path::PathBuf) {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("device.secrets.env");
    let mut stale = fixture_bundle(count);
    stale.services[0].snapshot.workspaces[0]["defaultYoutubeCategoryId"] = "22".into();
    std::fs::write(&path, serialize_env(&stale).unwrap()).unwrap();
    (directory, path)
}

#[tokio::test]
async fn import_twice_keeps_one_profile() {
    let (_directory, path) = input_file(1);
    let store = LocalStore::memory().unwrap();
    let vault = TransferVault::default();
    let source = LiveSource::default();
    let (summary, profiles) = import_from(&source, &vault, &store, &path).await.unwrap();
    assert_eq!(summary.connections, 3);
    assert_eq!(
        profiles[0].id,
        fixture_bundle(1).services[0].state.profile.id
    );
    import_from(&source, &vault, &store, &path).await.unwrap();
    assert_eq!(store.list_states().unwrap().len(), 1);
    assert_eq!(*vault.writes.lock().unwrap(), 5);
    let safe = serde_json::to_value(summary).unwrap();
    assert_eq!(safe.as_object().unwrap().len(), 3);
    for key in ["secrets", "credentials", "signingKey"] {
        assert!(safe.get(key).is_none());
    }
}

#[tokio::test]
async fn vault_failure_restores_old_profiles() {
    let (_directory, path) = input_file(2);
    let store = LocalStore::memory().unwrap();
    let old = fixture_bundle(3).services.remove(2);
    store.save_state(&old.state).unwrap();
    let vault = TransferVault {
        fail_after: Some(1),
        ..Default::default()
    };
    *vault.values.lock().unwrap() = old.secrets.clone();
    assert!(
        import_from(&LiveSource::default(), &vault, &store, &path)
            .await
            .is_err()
    );
    assert_eq!(*vault.writes.lock().unwrap(), 1);
    assert_eq!(vault.values.lock().unwrap().clone(), old.secrets);
    assert_eq!(store.list_states().unwrap().len(), 1);
    assert_eq!(store.list_states().unwrap()[0].profile, old.state.profile);
}

#[tokio::test]
async fn sqlite_failure_removes_only_new_credentials() {
    let (directory, path) = input_file(2);
    let db_path = directory.path().join("local.sqlite");
    let store = LocalStore::open(&db_path).unwrap();
    let old = fixture_bundle(3).services.remove(2);
    store.save_state(&old.state).unwrap();
    let vault = TransferVault::default();
    *vault.values.lock().unwrap() = old.secrets.clone();
    let first = fixture_bundle(1).services.remove(0);
    vault.values.lock().unwrap().insert(
        first.state.profile.device_credential_ref.clone(),
        first.secrets[&first.state.profile.device_credential_ref].clone(),
    );
    let before = vault.values.lock().unwrap().clone();
    rusqlite::Connection::open(&db_path).unwrap().execute_batch("CREATE TRIGGER fail_import BEFORE INSERT ON profiles WHEN NEW.id='00000000000000000000000000000002' BEGIN SELECT RAISE(ABORT,'synthetic disk failure'); END;").unwrap();
    assert!(
        import_from(&LiveSource::default(), &vault, &store, &path)
            .await
            .is_err()
    );
    assert_eq!(*vault.writes.lock().unwrap(), 9);
    assert_eq!(vault.values.lock().unwrap().clone(), before);
    assert_eq!(store.list_states().unwrap().len(), 1);
    assert_eq!(store.list_states().unwrap()[0].profile, old.state.profile);
    let backups: Vec<_> = std::fs::read_dir(directory.path().join("backups"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect();
    assert_eq!(backups.len(), 1);
    let backup = rusqlite::Connection::open(&backups[0]).unwrap();
    let old_id: String = backup
        .query_row("SELECT id FROM profiles", [], |row| row.get(0))
        .unwrap();
    assert_eq!(old_id, old.state.profile.id);
}

#[tokio::test]
async fn interrupted_matching_vault_entries_can_resume() {
    let (_directory, path) = input_file(1);
    let store = LocalStore::memory().unwrap();
    let vault = TransferVault::default();
    let service = fixture_bundle(1).services.remove(0);
    vault.values.lock().unwrap().insert(
        service.state.profile.device_credential_ref.clone(),
        service.secrets[&service.state.profile.device_credential_ref].clone(),
    );
    import_from(&LiveSource::default(), &vault, &store, &path)
        .await
        .unwrap();
    assert_eq!(store.list_states().unwrap().len(), 1);
    assert_eq!(*vault.writes.lock().unwrap(), 4);
}

#[tokio::test]
async fn conflicting_profile_is_not_overwritten() {
    let (_directory, path) = input_file(1);
    let store = LocalStore::memory().unwrap();
    let mut old = fixture_bundle(1).services.remove(0).state;
    old.database_id = Some("00000000-0000-4000-8000-000000000099".into());
    store.save_state(&old).unwrap();
    let vault = TransferVault::default();
    assert!(
        import_from(&LiveSource::default(), &vault, &store, &path)
            .await
            .is_err()
    );
    assert_eq!(
        store.get_state(&old.profile.id).unwrap().database_id,
        old.database_id
    );
    assert_eq!(*vault.writes.lock().unwrap(), 0);
}

#[tokio::test]
async fn conflicting_credential_is_never_replaced() {
    let (_directory, path) = input_file(1);
    let store = LocalStore::memory().unwrap();
    let vault = TransferVault::default();
    let reference = fixture_bundle(1).services[0]
        .state
        .profile
        .device_credential_ref
        .clone();
    vault.values.lock().unwrap().insert(
        reference.clone(),
        "TEST_existing_device_000000000000000000000000000001".into(),
    );
    assert!(
        import_from(&LiveSource::default(), &vault, &store, &path)
            .await
            .is_err()
    );
    assert_eq!(
        vault.get(&reference).unwrap(),
        "TEST_existing_device_000000000000000000000000000001"
    );
    assert_eq!(*vault.writes.lock().unwrap(), 0);
    assert!(store.list_states().unwrap().is_empty());
}

#[tokio::test]
async fn current_cloud_preferences_win_over_export_snapshot() {
    let (directory, path) = input_file(1);
    let store = LocalStore::memory().unwrap();
    let vault = TransferVault::default();
    let source = LiveSource::default();
    import_from(&source, &vault, &store, &path).await.unwrap();
    let output = directory.path().join("export.secrets.env");
    export_to(&source, &vault, &store, &output).await.unwrap();
    let actual = parse_env(&std::fs::read(output).unwrap()).unwrap();
    assert_eq!(
        actual.services[0].snapshot.workspaces[0]["defaultYoutubeCategoryId"],
        "25"
    );
    assert_eq!(
        actual.services[0].snapshot.workspaces[0]["preferredChannels"]["youtube"],
        "latest-channel"
    );
    assert_eq!(source.reads.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn second_profile_failure_commits_nothing() {
    let (_directory, path) = input_file(2);
    let store = LocalStore::memory().unwrap();
    let vault = TransferVault::default();
    let source = LiveSource {
        fail_profile: Some(fixture_bundle(2).services[1].state.profile.id.clone()),
        ..Default::default()
    };
    assert!(import_from(&source, &vault, &store, &path).await.is_err());
    assert_eq!(source.reads.lock().unwrap().len(), 1);
    assert_eq!(*vault.writes.lock().unwrap(), 0);
    assert!(store.list_states().unwrap().is_empty());
}

#[tokio::test]
async fn unavailable_profile_does_not_replace_existing_export() {
    let (directory, _) = input_file(2);
    let output = directory.path().join("keep.secrets.env");
    std::fs::write(&output, b"original export").unwrap();
    let store = LocalStore::memory().unwrap();
    let vault = TransferVault::default();
    let bundle = fixture_bundle(2);
    for service in &bundle.services {
        store.save_state(&service.state).unwrap();
        vault.values.lock().unwrap().extend(service.secrets.clone());
    }
    let source = LiveSource {
        fail_profile: Some(bundle.services[1].state.profile.id.clone()),
        ..Default::default()
    };
    assert!(export_to(&source, &vault, &store, &output).await.is_err());
    assert_eq!(std::fs::read(output).unwrap(), b"original export");
    assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 2);
}

#[tokio::test]
async fn exporting_empty_or_incomplete_setup_is_rejected() {
    let (directory, _) = input_file(1);
    let output = directory.path().join("new.secrets.env");
    let store = LocalStore::memory().unwrap();
    let vault = TransferVault::default();
    assert!(
        export_to(&LiveSource::default(), &vault, &store, &output)
            .await
            .is_err()
    );
    let mut state = fixture_bundle(1).services.remove(0).state;
    state.profile.base_url.clear();
    store.save_state(&state).unwrap();
    assert!(
        export_to(&LiveSource::default(), &vault, &store, &output)
            .await
            .is_err()
    );
    assert!(!output.exists());
}

#[tokio::test]
async fn completed_export_replaces_file_and_failed_rename_removes_temporary() {
    let (directory, path) = input_file(1);
    let store = LocalStore::memory().unwrap();
    let vault = TransferVault::default();
    let source = LiveSource::default();
    import_from(&source, &vault, &store, &path).await.unwrap();
    export_to(&source, &vault, &store, &path).await.unwrap();
    assert_eq!(
        parse_env(&std::fs::read(&path).unwrap()).unwrap().services[0]
            .snapshot
            .workspaces[0]["defaultYoutubeCategoryId"],
        "25"
    );
    let target = directory.path().join("existing-directory");
    std::fs::create_dir(&target).unwrap();
    std::fs::write(target.join("keep"), b"existing data").unwrap();
    assert!(export_to(&source, &vault, &store, &target).await.is_err());
    assert_eq!(
        std::fs::read(target.join("keep")).unwrap(),
        b"existing data"
    );
    assert!(!std::fs::read_dir(directory.path()).unwrap().any(|entry| {
        entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .ends_with(".tmp")
    }));
}

#[tokio::test]
async fn oversized_file_is_not_read_into_import_or_vault() {
    let (_directory, path) = input_file(1);
    std::fs::write(&path, vec![b'A'; 2 * 1024 * 1024 + 1]).unwrap();
    let store = LocalStore::memory().unwrap();
    let vault = TransferVault::default();
    let source = LiveSource::default();
    let error = match import_from(&source, &vault, &store, &path).await {
        Ok(_) => panic!("oversized import succeeded"),
        Err(error) => error,
    };
    assert_eq!(error.code, "TRANSFER_FILE_TOO_LARGE");
    assert!(source.reads.lock().unwrap().is_empty());
    assert_eq!(*vault.writes.lock().unwrap(), 0);
}
