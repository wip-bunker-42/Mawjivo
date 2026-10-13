use base64::{Engine, engine::general_purpose::STANDARD};
use mawjivo_lib::{
    profiles::ProvisionState,
    transfer::{ServiceTransfer, TransferBundle, TransferSnapshot},
};
use serde_json::json;
use std::collections::BTreeMap;

pub fn fixture_bundle(count: usize) -> TransferBundle {
    let services = (1..=count).map(|index| {
        let id = format!("{index:032x}");
        let mut state = ProvisionState::new(&"a".repeat(32));
        state.profile.id = id.clone();
        state.profile.service_id = id.clone();
        state.profile.device_credential_ref = format!("{id}:device");
        state.profile.base_url = format!("https://space-{index}.example.test");
        state.domain = Some(format!("space-{index}.example.test"));
        state.zone_id = Some("b".repeat(32));
        state.database_id = Some(format!("00000000-0000-4000-8000-{index:012x}"));
        state.bucket_created = true;
        let secrets = BTreeMap::from([
            (format!("{id}:device"), format!("TEST_transfer_device_{index:032x}")),
            (format!("{id}:encryption"), STANDARD.encode([7u8; 32])),
            (format!("{id}:cloudflare"), "synthetic-cf-token-not-real".into()),
            (format!("{id}:r2-access"), "synthetic-r2-access".into()),
            (format!("{id}:r2-secret"), "synthetic-r2-secret".into()),
        ]);
        let workspace = format!("space-{index}");
        ServiceTransfer {
            state,
            secrets,
            snapshot: TransferSnapshot {
                workspaces: vec![json!({"id":workspace,"name":"مساحتي العربية","timeZone":"Africa/Cairo","version":3,"defaultPlatforms":["facebook","instagram","threads","x","youtube","tiktok"],"serviceProfileId":id,"preferredChannels":{"youtube":"my-youtube-channel"},"defaultYoutubeCategoryId":"25"})],
                connections: vec![
                    json!({"id":format!("meta-{index}"),"workspaceId":workspace,"provider":"meta","label":"ربط Meta","version":1,"credentials":{"pageAccessToken":"synthetic-page-token","userAccessToken":"synthetic-user-token","pageId":"1","instagramId":"2"}}),
                    json!({"id":format!("buffer-a-{index}"),"workspaceId":workspace,"provider":"buffer","label":"حساب Buffer الأول","version":1,"credentials":{"apiKey":"synthetic-buffer-a"}}),
                    json!({"id":format!("buffer-b-{index}"),"workspaceId":workspace,"provider":"buffer","label":"حساب Buffer الثاني","version":1,"credentials":{"apiKey":"synthetic-buffer-b"}}),
                ],
                telegram: vec![json!({"workspaceId":workspace,"botToken":"synthetic-bot-token","chatId":"1","daily":true})],
            },
        }
    }).collect();
    TransferBundle {
        exported_at: "2026-10-13T03:21:43.163Z".into(),
        services,
    }
}

// Independent representation of the already exported singular-profile owner file.
pub fn legacy_env(bundle: &TransferBundle) -> Vec<u8> {
    let service = &bundle.services[0];
    let id = &service.state.profile.id;
    format!(
        "# Existing plaintext device file\nMAWJIVO_DEVICE_EXPORT_SCHEMA=1\nMAWJIVO_EXPORTED_AT={}\nMAWJIVO_SERVICE_PROFILE_JSON={}\nMAWJIVO_VAULT_JSON={}\nMAWJIVO_WORKSPACES_JSON={}\nMAWJIVO_CONNECTIONS_JSON={}\nMAWJIVO_TELEGRAM_JSON={}\nMAWJIVO_DEVICE_TOKEN={}\nMAWJIVO_SERVICE_ENCRYPTION_KEY={}\nCLOUDFLARE_ACCOUNT_ID={}\n",
        bundle.exported_at,
        serde_json::to_string(&service.state).unwrap(),
        serde_json::to_string(&service.secrets).unwrap(),
        serde_json::to_string(&service.snapshot.workspaces).unwrap(),
        serde_json::to_string(&service.snapshot.connections).unwrap(),
        serde_json::to_string(&service.snapshot.telegram).unwrap(),
        service.secrets[&format!("{id}:device")],
        service.secrets[&format!("{id}:encryption")],
        service.state.profile.account_id,
    ).into_bytes()
}
