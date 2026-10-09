use mawjivo_lib::contracts::Draft;
#[test]
fn draft_json_roundtrip_preserves_every_shared_field() {
    let json = include_str!("../../../../packages/core/test/contract-fixture.json");
    let expected: serde_json::Value = serde_json::from_str(json).unwrap();
    let draft: Draft = serde_json::from_str(json).unwrap();
    assert_eq!(serde_json::to_value(draft).unwrap(), expected);
}
