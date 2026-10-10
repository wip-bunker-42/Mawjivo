use image::{Rgb, RgbImage};
use mawjivo_lib::{
    contracts::{MediaKind, UploadInput},
    media::{MediaInfo, jobs::MediaRegistry},
};
use serde_json::json;
fn info(path: &std::path::Path, mime: &str) -> MediaInfo {
    MediaInfo {
        mime_type: mime.into(),
        bytes: std::fs::metadata(path).unwrap().len(),
        width: 32,
        height: 32,
        duration_ms: None,
        quality: None,
    }
}
fn input(id: &str, name: &str, bytes: u64) -> UploadInput {
    serde_json::from_value(json!({"profileId":"profile","workspaceId":"space","fileId":id,"sourceAssetId":id,"recipeId":null,"manifest":{"sourceAssetId":id,"recipeId":null,"originalName":name,"kind":"image","bytes":bytes,"mimeType":"image/jpeg"}})).unwrap()
}
#[test]
fn originals_use_native_names_dimensions_and_window_ownership() {
    let t = tempfile::tempdir().unwrap();
    let path = t.path().join("صورتي.JPEG");
    RgbImage::from_pixel(32, 32, Rgb([20, 60, 120]))
        .save(&path)
        .unwrap();
    let registry = MediaRegistry::default();
    let media = info(&path, "image/jpeg");
    let id = registry
        .register_probed("main", &path, media.clone())
        .unwrap();
    let mut data = input(&id, "صورتي.JPEG", media.bytes);
    let (chosen, manifest) = registry.upload_for("main", &data).unwrap();
    assert_eq!(chosen, path.canonicalize().unwrap());
    assert_eq!(manifest.original_name, "صورتي.JPEG");
    assert_eq!(manifest.width, Some(32));
    assert_eq!(manifest.kind, MediaKind::Image);
    assert_eq!(
        registry.upload_for("other", &data).unwrap_err().code,
        "LOCAL_FILE_SCOPE"
    );
    data.manifest.original_name = "اسم آخر.jpg".into();
    assert_eq!(
        registry.upload_for("main", &data).unwrap_err().code,
        "INVALID_UPLOAD_MANIFEST"
    );
    data.manifest.original_name = "صورتي.JPEG".into();
    data.manifest.width = Some(999);
    assert_eq!(
        registry.upload_for("main", &data).unwrap_err().code,
        "INVALID_UPLOAD_MANIFEST"
    );
}
#[test]
fn prepared_upload_must_match_the_native_source_and_recipe() {
    let t = tempfile::tempdir().unwrap();
    let source = t.path().join("صورتي.PNG");
    let output = t.path().join("صورتي.jpg");
    RgbImage::from_pixel(32, 32, Rgb([20, 60, 120]))
        .save(&source)
        .unwrap();
    RgbImage::from_pixel(32, 32, Rgb([20, 60, 120]))
        .save(&output)
        .unwrap();
    let r = MediaRegistry::default();
    let source_id = r
        .register_probed("main", &source, info(&source, "image/png"))
        .unwrap();
    let derived_id = r
        .register_prepared(
            "main",
            &output,
            &source_id,
            "native-recipe",
            info(&output, "image/jpeg"),
        )
        .unwrap();
    let mut data = input(
        &derived_id,
        "صورتي.jpg",
        std::fs::metadata(&output).unwrap().len(),
    );
    data.source_asset_id = source_id.clone();
    data.manifest.source_asset_id = source_id;
    data.recipe_id = Some("native-recipe".into());
    data.manifest.recipe_id = data.recipe_id.clone();
    assert!(r.upload_for("main", &data).is_ok());
    data.recipe_id = Some("forged-recipe".into());
    data.manifest.recipe_id = data.recipe_id.clone();
    assert_eq!(
        r.upload_for("main", &data).unwrap_err().code,
        "INVALID_UPLOAD_MANIFEST"
    );
}
