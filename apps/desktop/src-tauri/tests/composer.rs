use mawjivo_lib::{
    contracts::{Draft, PreparedAsset},
    media::jobs::MediaRegistry,
    profiles::{LocalStore, ProvisionState},
    upload::{UploadEngine, UploadStore},
    windows::composer_window_label,
};
use std::sync::Arc;
#[test]
fn window_labels_are_unique_and_do_not_reuse_the_primary_window() {
    let a = composer_window_label();
    let b = composer_window_label();
    assert!(a.starts_with("composer-"));
    assert_ne!(a, b);
    assert_ne!(a, "main");
}
#[test]
fn per_workspace_drafts_restore_after_switch_and_restart() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("local.sqlite");
    let store = LocalStore::open(&path).unwrap();
    let mut profile = ProvisionState::new("account");
    profile.profile.id = "profile".into();
    store.save_state(&profile).unwrap();
    let mut a: Draft = serde_json::from_str(include_str!(
        "../../../../packages/core/test/contract-fixture.json"
    ))
    .unwrap();
    a.id = "draft-a".into();
    a.workspace_id = "workspace-a".into();
    store.save_draft("profile", "main", &a).unwrap();
    let mut b = a.clone();
    b.id = "draft-b".into();
    b.workspace_id = "workspace-b".into();
    b.text = "مسودة الثانية".into();
    store.save_draft("profile", "main", &b).unwrap();
    let mut other = a.clone();
    other.id = "draft-other".into();
    other.text = "نافذة أخرى".into();
    store
        .save_draft("profile", "composer-other", &other)
        .unwrap();
    drop(store);
    let store = LocalStore::open(&path).unwrap();
    assert_eq!(
        store
            .window_draft("profile", "main", "workspace-a")
            .unwrap(),
        Some(a)
    );
    assert_eq!(
        store
            .window_draft("profile", "main", "workspace-b")
            .unwrap(),
        Some(b)
    );
    assert_eq!(
        store
            .window_draft("profile", "composer-other", "workspace-a")
            .unwrap(),
        Some(other)
    );
    assert_eq!(
        store
            .window_draft("profile", "foreign", "workspace-a")
            .unwrap(),
        None
    );
}
#[test]
fn trusted_upload_sessions_restore_opaque_handles_without_renderer_paths() {
    let t = tempfile::tempdir().unwrap();
    let path = t.path().join("صورتي.JPEG");
    image::RgbImage::from_pixel(32, 32, image::Rgb([10, 20, 30]))
        .save(&path)
        .unwrap();
    let store = Arc::new(LocalStore::memory().unwrap());
    let mut profile = ProvisionState::new("account");
    profile.profile.id = "profile".into();
    store.save_state(&profile).unwrap();
    let sessions = Arc::new(UploadStore::new(store).unwrap());
    let engine = UploadEngine::new(sessions);
    let input=serde_json::from_value(serde_json::json!({"profileId":"profile","workspaceId":"space","fileId":"source","sourceAssetId":"source","recipeId":null,"manifest":{"sourceAssetId":"source","recipeId":null,"originalName":"صورتي.JPEG","kind":"image","bytes":std::fs::metadata(&path).unwrap().len(),"mimeType":"image/jpeg","width":32,"height":32}})).unwrap();
    engine.start("main", input, &path).unwrap();
    let registry = MediaRegistry::default();
    assert_eq!(
        engine
            .restore_handles("main", "profile", "space", &["source".into()], &registry)
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        registry.file_for("main", "source").unwrap(),
        path.canonicalize().unwrap()
    );
    assert!(registry.file_for("other", "source").is_err());
    assert!(
        engine
            .restore_handles("other", "profile", "space", &["source".into()], &registry)
            .unwrap()
            .is_empty()
    );
    assert!(
        engine
            .restore_handles("main", "profile", "other", &["source".into()], &registry)
            .unwrap()
            .is_empty()
    );
}
#[test]
fn completed_upload_revalidation_clears_old_cloud_readiness_before_dispatch() {
    let t = tempfile::tempdir().unwrap();
    let path = t.path().join("video.mp4");
    std::fs::write(&path, b"trusted fixture").unwrap();
    let local = Arc::new(LocalStore::memory().unwrap());
    let mut profile = ProvisionState::new("account");
    profile.profile.id = "profile".into();
    local.save_state(&profile).unwrap();
    let sessions = Arc::new(UploadStore::new(local).unwrap());
    let engine = UploadEngine::new(sessions.clone());
    let input=serde_json::from_value(serde_json::json!({"profileId":"profile","workspaceId":"space","fileId":"source","sourceAssetId":"source","recipeId":null,"manifest":{"sourceAssetId":"source","recipeId":null,"originalName":"video.mp4","kind":"video","bytes":15,"mimeType":"video/mp4"}})).unwrap();
    let id = engine.start("main", input, &path).unwrap();
    let mut session = sessions.get("main", &id).unwrap();
    session.phase = "complete".into();
    session.ready = Some(PreparedAsset {
        source_asset_id: "source".into(),
        recipe_id: None,
        asset_id: "old-cloud".into(),
        sha256: "a".repeat(64),
    });
    sessions.save(&session).unwrap();
    assert!(engine.prepared("main", &id).unwrap().is_some());
    assert_eq!(engine.revalidate("main", &id).unwrap(), id);
    assert!(engine.prepared("main", &id).unwrap().is_none());
    assert_eq!(sessions.get("main", &id).unwrap().phase, "pending");
}
#[test]
fn an_old_draft_source_is_not_lost_after_two_hundred_newer_uploads() {
    let t = tempfile::tempdir().unwrap();
    let path = t.path().join("صورتي.JPEG");
    image::RgbImage::from_pixel(32, 32, image::Rgb([10, 20, 30]))
        .save(&path)
        .unwrap();
    let local = Arc::new(LocalStore::memory().unwrap());
    let mut profile = ProvisionState::new("account");
    profile.profile.id = "profile".into();
    local.save_state(&profile).unwrap();
    let sessions = Arc::new(UploadStore::new(local).unwrap());
    let engine = UploadEngine::new(sessions);
    let input:mawjivo_lib::contracts::UploadInput=serde_json::from_value(serde_json::json!({"profileId":"profile","workspaceId":"space","fileId":"old-source","sourceAssetId":"old-source","recipeId":null,"manifest":{"sourceAssetId":"old-source","recipeId":null,"originalName":"صورتي.JPEG","kind":"image","bytes":std::fs::metadata(&path).unwrap().len(),"mimeType":"image/jpeg","width":32,"height":32}})).unwrap();
    engine.start("main", input.clone(), &path).unwrap();
    for index in 0..201 {
        let mut next = input.clone();
        next.file_id = format!("source-{index}");
        next.source_asset_id = next.file_id.clone();
        next.manifest.source_asset_id = next.file_id.clone();
        engine.start("main", next, &path).unwrap();
    }
    let registry = MediaRegistry::default();
    assert_eq!(
        engine
            .restore_handles(
                "main",
                "profile",
                "space",
                &["old-source".into()],
                &registry
            )
            .unwrap()
            .len(),
        1
    );
    assert!(registry.file_for("main", "old-source").is_ok());
}
