use mawjivo_lib::contracts::{AssetUse, Draft};
#[test]
fn draft_json_roundtrip_preserves_every_shared_field() {
    let json = include_str!("../../../../packages/core/test/contract-fixture.json");
    let expected: serde_json::Value = serde_json::from_str(json).unwrap();
    let draft: Draft = serde_json::from_str(json).unwrap();
    assert_eq!(serde_json::to_value(draft).unwrap(), expected);
}
#[test]
fn editing_context_and_reviewed_video_name_survive_native_json() {
    let mut expected: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../packages/core/test/contract-fixture.json"
    ))
    .unwrap();
    expected["editingPost"] =
        serde_json::json!({"postId":"post-1","draftId":"server-draft-1","expectedRevision":3});
    let draft: Draft = serde_json::from_value(expected.clone()).unwrap();
    assert_eq!(serde_json::to_value(draft).unwrap(), expected);
    let expected_use =
        serde_json::json!({"sourceAssetId":"source-1","recipeId":null,"sentName":"عنواني.mp4"});
    let media_use: AssetUse = serde_json::from_value(expected_use.clone()).unwrap();
    assert_eq!(serde_json::to_value(media_use).unwrap(), expected_use);
}
