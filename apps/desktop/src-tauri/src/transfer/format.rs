use super::{ServiceTransfer, TransferBundle, TransferSnapshot};
use crate::{
    contracts::AppError,
    profiles::{ProvisionInput, ProvisionState},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, HashSet};

const MAX_BYTES: usize = 2 * 1024 * 1024;
const SUFFIXES: [&str; 6] = [
    "device",
    "encryption",
    "cloudflare",
    "r2-access",
    "r2-secret",
    "healthchecks",
];

fn invalid() -> AppError {
    AppError::new(
        "TRANSFER_FILE_INVALID",
        "ملف الإعدادات ناقص أو غير صالح. اختر ملفًا صادرًا من Mawjivo.",
    )
}
fn too_large() -> AppError {
    AppError::new(
        "TRANSFER_FILE_TOO_LARGE",
        "ملف الإعدادات أكبر من الحد المسموح وهو 2 ميجابايت.",
    )
}
fn json<T: DeserializeOwned>(fields: &BTreeMap<String, String>, key: &str) -> Result<T, AppError> {
    serde_json::from_str(fields.get(key).ok_or_else(invalid)?).map_err(|_| invalid())
}
fn hex_id(value: &str) -> bool {
    value.len() == 32 && value.bytes().all(|b| b.is_ascii_hexdigit())
}
fn record_id<'a>(value: &'a Value, key: &str) -> Result<&'a str, AppError> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|id| {
            !id.is_empty()
                && id.len() <= 160
                && id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        })
        .ok_or_else(invalid)
}

pub fn parse_env(bytes: &[u8]) -> Result<TransferBundle, AppError> {
    if bytes.len() > MAX_BYTES {
        return Err(too_large());
    }
    let text = std::str::from_utf8(bytes).map_err(|_| invalid())?;
    let mut fields = BTreeMap::new();
    for line in text.strip_prefix('\u{feff}').unwrap_or(text).lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line.strip_prefix("export ").unwrap_or(line);
        let (name, raw) = line.split_once('=').ok_or_else(invalid)?;
        let name = name.trim();
        if name.is_empty()
            || !name
                .bytes()
                .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
        {
            return Err(invalid());
        }
        let raw = raw.trim();
        let value = if raw.len() >= 2
            && ((raw.starts_with('"') && raw.ends_with('"'))
                || (raw.starts_with('\'') && raw.ends_with('\'')))
        {
            &raw[1..raw.len() - 1]
        } else {
            raw
        };
        if fields.insert(name.to_string(), value.to_string()).is_some() {
            return Err(invalid());
        }
    }
    match fields
        .get("MAWJIVO_DEVICE_EXPORT_SCHEMA")
        .map(String::as_str)
    {
        Some("1") => {}
        Some(_) => {
            return Err(AppError::new(
                "TRANSFER_FILE_VERSION",
                "صيغة ملف الإعدادات أحدث من التطبيق. حدّث التطبيق ثم أعد الاستيراد.",
            ));
        }
        None => return Err(invalid()),
    }
    let states: Vec<ProvisionState> = if fields.contains_key("MAWJIVO_SERVICE_PROFILES_JSON") {
        let states: Vec<ProvisionState> = json(&fields, "MAWJIVO_SERVICE_PROFILES_JSON")?;
        if fields.contains_key("MAWJIVO_SERVICE_PROFILE_JSON") {
            let single: Value = json(&fields, "MAWJIVO_SERVICE_PROFILE_JSON")?;
            let array = serde_json::to_value(&states).map_err(|_| invalid())?;
            if array
                .as_array()
                .is_none_or(|items| items.len() != 1 || items[0] != single)
            {
                return Err(invalid());
            }
        }
        states
    } else {
        vec![json(&fields, "MAWJIVO_SERVICE_PROFILE_JSON")?]
    };
    if states.is_empty() {
        return Err(invalid());
    }
    let vault: BTreeMap<String, String> = json(&fields, "MAWJIVO_VAULT_JSON")?;
    let workspaces: Vec<Value> = json(&fields, "MAWJIVO_WORKSPACES_JSON")?;
    let connections: Vec<Value> = json(&fields, "MAWJIVO_CONNECTIONS_JSON")?;
    let telegram: Vec<Value> = json(&fields, "MAWJIVO_TELEGRAM_JSON")?;
    let mut owners = HashMap::new();
    for workspace in &workspaces {
        let id = record_id(workspace, "id")?;
        let service = record_id(workspace, "serviceProfileId")?;
        if owners.insert(id.to_string(), service.to_string()).is_some() {
            return Err(invalid());
        }
    }
    let mut used_references = HashSet::new();
    let mut services = Vec::new();
    for state in states {
        let id = &state.profile.id;
        let mut secrets = BTreeMap::new();
        for suffix in SUFFIXES {
            let reference = format!("{id}:{suffix}");
            if let Some(value) = vault.get(&reference) {
                secrets.insert(reference.clone(), value.clone());
                used_references.insert(reference);
            }
        }
        let belongs = |value: &Value, key: &str| -> bool {
            value
                .get(key)
                .and_then(Value::as_str)
                .and_then(|workspace| owners.get(workspace))
                .is_some_and(|owner| owner == id)
        };
        let snapshot = TransferSnapshot {
            workspaces: workspaces
                .iter()
                .filter(|item| item["serviceProfileId"] == *id)
                .cloned()
                .collect(),
            connections: connections
                .iter()
                .filter(|item| belongs(item, "workspaceId"))
                .cloned()
                .collect(),
            telegram: telegram
                .iter()
                .filter(|item| belongs(item, "workspaceId"))
                .cloned()
                .collect(),
        };
        services.push(ServiceTransfer {
            state,
            secrets,
            snapshot,
        });
    }
    if used_references.len() != vault.len()
        || services
            .iter()
            .map(|s| s.snapshot.workspaces.len())
            .sum::<usize>()
            != workspaces.len()
        || services
            .iter()
            .map(|s| s.snapshot.connections.len())
            .sum::<usize>()
            != connections.len()
        || services
            .iter()
            .map(|s| s.snapshot.telegram.len())
            .sum::<usize>()
            != telegram.len()
    {
        return Err(invalid());
    }
    let bundle = TransferBundle {
        exported_at: fields
            .get("MAWJIVO_EXPORTED_AT")
            .cloned()
            .ok_or_else(invalid)?,
        services,
    };
    validate_bundle(&bundle)?;
    if bundle.services.len() == 1 {
        let service = &bundle.services[0];
        let id = &service.state.profile.id;
        for (alias, suffix) in [
            ("MAWJIVO_DEVICE_TOKEN", "device"),
            ("MAWJIVO_SERVICE_ENCRYPTION_KEY", "encryption"),
            ("SERVICE_ENCRYPTION_KEY", "encryption"),
            ("CLOUDFLARE_API_TOKEN", "cloudflare"),
            ("R2_ACCESS_KEY_ID", "r2-access"),
            ("R2_SECRET_ACCESS_KEY", "r2-secret"),
        ] {
            if fields
                .get(alias)
                .is_some_and(|value| service.secrets.get(&format!("{id}:{suffix}")) != Some(value))
            {
                return Err(invalid());
            }
        }
        if fields
            .get("CLOUDFLARE_ACCOUNT_ID")
            .is_some_and(|value| value != &service.state.profile.account_id)
        {
            return Err(invalid());
        }
    }
    Ok(bundle)
}

pub(crate) fn validate_bundle(bundle: &TransferBundle) -> Result<(), AppError> {
    if bundle.services.is_empty()
        || bundle.exported_at.len() > 64
        || !bundle.exported_at.contains('T')
        || !bundle.exported_at.is_ascii()
        || bundle.exported_at.contains(['\r', '\n'])
    {
        return Err(invalid());
    }
    let mut profile_ids = HashSet::new();
    let mut workspace_ids = HashSet::new();
    let mut connection_ids = HashSet::new();
    for service in &bundle.services {
        let state = &service.state;
        let id = &state.profile.id;
        if !hex_id(id)
            || !profile_ids.insert(id.clone())
            || state.profile.service_id != *id
            || state.profile.device_credential_ref != format!("{id}:device")
            || !hex_id(&state.profile.account_id)
            || !state.bucket_created
            || state
                .database_id
                .as_deref()
                .is_none_or(|database| uuid::Uuid::parse_str(database).is_err())
            || state.profile.version.is_empty()
            || state.profile.version.len() > 64
        {
            return Err(invalid());
        }
        let url = reqwest::Url::parse(&state.profile.base_url).map_err(|_| invalid())?;
        if url.scheme() != "https"
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.port().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || url.path() != "/"
        {
            return Err(invalid());
        }
        for (reference, value) in &service.secrets {
            if !SUFFIXES
                .iter()
                .any(|suffix| *reference == format!("{id}:{suffix}"))
                || value.is_empty()
                || value.len() > 16384
                || value.contains(['\r', '\n'])
            {
                return Err(invalid());
            }
        }
        let secret = |suffix: &str| {
            service
                .secrets
                .get(&format!("{id}:{suffix}"))
                .cloned()
                .ok_or_else(invalid)
        };
        let device = secret("device")?;
        if device.len() < 20
            || device.len() > 256
            || !device
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        {
            return Err(invalid());
        }
        if STANDARD
            .decode(secret("encryption")?)
            .map_err(|_| invalid())?
            .len()
            != 32
        {
            return Err(invalid());
        }
        let input = ProvisionInput {
            account_id: state.profile.account_id.clone(),
            api_token: secret("cloudflare")?,
            r2_access_key_id: secret("r2-access")?,
            r2_secret_access_key: secret("r2-secret")?,
            zone_id: state.zone_id.clone(),
            domain: state.domain.clone(),
        };
        crate::cloudflare::validate_input(&input).map_err(|_| invalid())?;
        let mut owned_workspaces = HashSet::new();
        for workspace in &service.snapshot.workspaces {
            let workspace_id = record_id(workspace, "id")?;
            if workspace["serviceProfileId"] != *id
                || !workspace_ids.insert(workspace_id.to_string())
            {
                return Err(invalid());
            }
            owned_workspaces.insert(workspace_id.to_string());
        }
        for connection in &service.snapshot.connections {
            if !owned_workspaces.contains(record_id(connection, "workspaceId")?)
                || !connection_ids.insert(record_id(connection, "id")?.to_string())
                || !matches!(connection["provider"].as_str(), Some("meta" | "buffer"))
                || connection["credentials"].as_object().is_none_or(|values| {
                    values.is_empty()
                        || values
                            .values()
                            .any(|value| value.as_str().is_none_or(str::is_empty))
                })
            {
                return Err(invalid());
            }
        }
        let mut telegram_workspaces = HashSet::new();
        for telegram in &service.snapshot.telegram {
            let workspace = record_id(telegram, "workspaceId")?;
            if !owned_workspaces.contains(workspace)
                || !telegram_workspaces.insert(workspace)
                || !telegram["botToken"].is_string()
                || !telegram["chatId"].is_string()
                || !telegram["daily"].is_boolean()
            {
                return Err(invalid());
            }
        }
    }
    Ok(())
}

pub fn serialize_env(bundle: &TransferBundle) -> Result<Vec<u8>, AppError> {
    validate_bundle(bundle)?;
    let mut vault = BTreeMap::new();
    let mut workspaces = Vec::new();
    let mut connections = Vec::new();
    let mut telegram = Vec::new();
    for service in &bundle.services {
        vault.extend(service.secrets.clone());
        workspaces.extend(service.snapshot.workspaces.clone());
        connections.extend(service.snapshot.connections.clone());
        telegram.extend(service.snapshot.telegram.clone());
    }
    let fields = [
        ("MAWJIVO_DEVICE_EXPORT_SCHEMA", "1".to_string()),
        ("MAWJIVO_EXPORTED_AT", bundle.exported_at.clone()),
        (
            "MAWJIVO_SERVICE_PROFILES_JSON",
            serde_json::to_string(
                &bundle
                    .services
                    .iter()
                    .map(|service| &service.state)
                    .collect::<Vec<_>>(),
            )
            .map_err(|_| invalid())?,
        ),
        (
            "MAWJIVO_VAULT_JSON",
            serde_json::to_string(&vault).map_err(|_| invalid())?,
        ),
        (
            "MAWJIVO_WORKSPACES_JSON",
            serde_json::to_string(&workspaces).map_err(|_| invalid())?,
        ),
        (
            "MAWJIVO_CONNECTIONS_JSON",
            serde_json::to_string(&connections).map_err(|_| invalid())?,
        ),
        (
            "MAWJIVO_TELEGRAM_JSON",
            serde_json::to_string(&telegram).map_err(|_| invalid())?,
        ),
    ];
    let mut text = "# Mawjivo settings and accounts — plain text, schema 1.\n".to_string();
    for (name, value) in fields {
        text.push_str(&format!("{name}={value}\n"));
    }
    let bytes = text.into_bytes();
    if bytes.len() > MAX_BYTES {
        return Err(too_large());
    }
    Ok(bytes)
}
