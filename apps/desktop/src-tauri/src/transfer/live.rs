use super::{ServiceTransfer, TransferSnapshot};
use crate::{
    cloudflare_api::{CloudflareClient, validate_service_version},
    contracts::AppError,
    profiles::{ProvisionInput, ProvisionState},
    service_artifact::sha256,
};
use aes_gcm::{
    Aes256Gcm, Nonce,
    aead::{Aead, KeyInit, Payload},
};
use async_trait::async_trait;
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::Value;
use std::collections::{BTreeMap, HashSet};
use zeroize::Zeroizing;

#[cfg(test)]
#[path = "live_tests.rs"]
mod live_tests;

#[async_trait]
pub(crate) trait TransferReadApi: Send + Sync {
    async fn settings(&self, state: &ProvisionState) -> Result<Value, AppError>;
    async fn verify_resources(&self, state: &ProvisionState) -> Result<(), AppError>;
    async fn domains(&self) -> Result<Value, AppError>;
    async fn workers_subdomain(&self) -> Result<String, AppError>;
    async fn query(
        &self,
        state: &ProvisionState,
        sql: &str,
        params: Vec<String>,
    ) -> Result<Vec<Value>, AppError>;
    async fn workspaces(&self, base_url: &str, token: &str) -> Result<Vec<Value>, AppError>;
}

#[async_trait]
pub trait TransferSource: Send + Sync {
    async fn inspect(
        &self,
        state: &ProvisionState,
        secrets: &BTreeMap<String, String>,
    ) -> Result<ServiceTransfer, AppError>;
}

pub struct CloudflareTransferSource;
#[async_trait]
impl TransferSource for CloudflareTransferSource {
    async fn inspect(
        &self,
        state: &ProvisionState,
        secrets: &BTreeMap<String, String>,
    ) -> Result<ServiceTransfer, AppError> {
        let input = ProvisionInput {
            account_id: state.profile.account_id.clone(),
            api_token: secret(state, secrets, "cloudflare")?.into(),
            r2_access_key_id: secret(state, secrets, "r2-access")?.into(),
            r2_secret_access_key: secret(state, secrets, "r2-secret")?.into(),
            domain: state.domain.clone(),
            zone_id: state.zone_id.clone(),
        };
        let api = CloudflareClient::new(&input, state).await?;
        inspect_with(&api, state, secrets).await
    }
}

fn invalid() -> AppError {
    AppError::new(
        "TRANSFER_UNVERIFIED",
        "تعذر التحقق من الخدمة وبيانات ربطها. راجع الملف والاتصال.",
    )
}
fn secret<'a>(
    state: &ProvisionState,
    secrets: &'a BTreeMap<String, String>,
    suffix: &str,
) -> Result<&'a str, AppError> {
    secrets
        .get(&format!("{}:{suffix}", state.profile.id))
        .map(String::as_str)
        .ok_or_else(invalid)
}

async fn inspect_with(
    api: &dyn TransferReadApi,
    state: &ProvisionState,
    secrets: &BTreeMap<String, String>,
) -> Result<ServiceTransfer, AppError> {
    // Cloudflare's control plane proves ownership before any device bearer is sent.
    let url = reqwest::Url::parse(&state.profile.base_url).map_err(|_| invalid())?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(invalid());
    }
    let settings = api.settings(state).await?;
    let binding = |name: &str| {
        settings["bindings"]
            .as_array()
            .and_then(|items| items.iter().find(|item| item["name"] == name))
            .and_then(|item| item["text"].as_str())
    };
    if !settings["tags"].as_array().is_some_and(|tags| {
        tags.iter()
            .any(|tag| tag.as_str() == Some(state.owner_tag().as_str()))
    }) || binding("SERVICE_ID") != Some(state.profile.service_id.as_str())
    {
        return Err(invalid());
    }
    let version = binding("SERVICE_VERSION").ok_or_else(invalid)?;
    validate_service_version(version, env!("CARGO_PKG_VERSION"))?;
    let resource = |name: &str| {
        settings["bindings"]
            .as_array()
            .and_then(|items| items.iter().find(|item| item["name"] == name))
    };
    if resource("DB").and_then(|item| item["id"].as_str()) != state.database_id.as_deref()
        || resource("MEDIA").and_then(|item| item["bucket_name"].as_str())
            != Some(format!("{}-media", state.worker_name()).as_str())
    {
        return Err(invalid());
    }
    api.verify_resources(state).await?;
    let host = url.host_str().ok_or_else(invalid)?;
    if host.ends_with(".workers.dev") {
        let account_subdomain = api.workers_subdomain().await?;
        if host != format!("{}.{account_subdomain}.workers.dev", state.worker_name()) {
            return Err(invalid());
        }
    } else {
        let domains = api.domains().await?;
        if !domains.as_array().is_some_and(|items| {
            items.iter().any(|item| {
                item["hostname"].as_str() == Some(host)
                    && item["service"] == state.worker_name()
                    && state
                        .zone_id
                        .as_deref()
                        .is_some_and(|zone| item["zone_id"] == zone)
            })
        }) {
            return Err(invalid());
        }
    }
    let device = secret(state, secrets, "device")?;
    let rows = api
        .query(
            state,
            "SELECT id,allowed_workspace_ids,revoked_at_ms FROM devices WHERE token_hash=?",
            vec![sha256(device.as_bytes())],
        )
        .await?;
    if rows.len() != 1 || !rows[0]["revoked_at_ms"].is_null() {
        return Err(invalid());
    }
    let allowed: Value = serde_json::from_str(
        rows[0]["allowed_workspace_ids"]
            .as_str()
            .ok_or_else(invalid)?,
    )
    .map_err(|_| invalid())?;
    if allowed != "*"
        && !allowed
            .as_array()
            .is_some_and(|ids| ids.iter().all(Value::is_string))
    {
        return Err(invalid());
    }
    let mut workspaces = api.workspaces(&state.profile.base_url, device).await?;
    workspaces.retain(|ws| {
        allowed == "*"
            || allowed
                .as_array()
                .is_some_and(|ids| ids.contains(&ws["id"]))
    });
    let mut seen = HashSet::new();
    let mut ids = Vec::new();
    for ws in &workspaces {
        let id = ws["id"].as_str().ok_or_else(invalid)?;
        if id.is_empty()
            || id.len() > 160
            || !id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
            || ws["serviceProfileId"] != state.profile.id
            || !seen.insert(id.to_string())
        {
            return Err(invalid());
        }
        ids.push(id.to_string());
    }
    let key = secret(state, secrets, "encryption")?;
    let mut connections = Vec::new();
    let mut telegram = Vec::new();
    // Keep D1 parameters below its limit while restricting every SELECT to this device.
    for chunk in ids.chunks(80) {
        let placeholders = vec!["?"; chunk.len()].join(",");
        let rows = api.query(state, &format!("SELECT id,workspace_id,provider,label,secret_cipher,key_version,version FROM connections WHERE workspace_id IN ({placeholders}) ORDER BY workspace_id,id"), chunk.to_vec()).await?;
        for row in rows {
            let ws = row["workspace_id"].as_str().ok_or_else(invalid)?;
            let id = row["id"].as_str().ok_or_else(invalid)?;
            if !chunk.iter().any(|allowed| allowed == ws)
                || !matches!(row["provider"].as_str(), Some("meta" | "buffer"))
            {
                return Err(invalid());
            }
            let credentials = decrypt_connection(
                row["secret_cipher"].as_str().ok_or_else(invalid)?,
                key,
                ws,
                id,
                row["key_version"].as_u64().ok_or_else(invalid)?,
            )?;
            connections.push(serde_json::json!({"id":id,"workspaceId":ws,"provider":row["provider"],"label":row["label"],"version":row["version"],"credentials":credentials}));
        }
        let params = chunk.iter().map(|id| format!("telegram:{id}")).collect();
        let rows = api.query(state, &format!("SELECT key,value_json FROM service_settings WHERE key IN ({placeholders}) ORDER BY key"), params).await?;
        for row in rows {
            let ws = row["key"]
                .as_str()
                .and_then(|key| key.strip_prefix("telegram:"))
                .ok_or_else(invalid)?;
            if !chunk.iter().any(|allowed| allowed == ws) {
                return Err(invalid());
            }
            let envelope: Value =
                serde_json::from_str(row["value_json"].as_str().ok_or_else(invalid)?)
                    .map_err(|_| invalid())?;
            let mut config = decrypt_connection(
                envelope["cipher"].as_str().ok_or_else(invalid)?,
                key,
                ws,
                "telegram",
                1,
            )?;
            config["workspaceId"] = Value::String(ws.into());
            telegram.push(config);
        }
    }
    let mut current = state.clone();
    current.profile.version = version.into();
    Ok(ServiceTransfer {
        state: current,
        secrets: secrets.clone(),
        snapshot: TransferSnapshot {
            workspaces,
            connections,
            telegram,
        },
    })
}

pub fn decrypt_connection(
    cipher: &str,
    key_base64: &str,
    workspace_id: &str,
    connection_id: &str,
    key_version: u64,
) -> Result<Value, AppError> {
    let invalid = || {
        AppError::new(
            "SECRET_INVALID",
            "تعذر قراءة بيانات الربط من الخدمة. راجع مفتاحها.",
        )
    };
    let parts: Vec<_> = cipher.split('.').collect();
    if parts.len() != 4
        || parts[0] != "v1"
        || key_version != 1
        || parts[1] != key_version.to_string()
    {
        return Err(invalid());
    }
    let key_bytes = Zeroizing::new(STANDARD.decode(key_base64).map_err(|_| invalid())?);
    if key_bytes.len() != 32 {
        return Err(invalid());
    }
    let nonce_bytes = STANDARD.decode(parts[2]).map_err(|_| invalid())?;
    let nonce: [u8; 12] = nonce_bytes.as_slice().try_into().map_err(|_| invalid())?;
    let body = STANDARD.decode(parts[3]).map_err(|_| invalid())?;
    let aad =
        serde_json::to_vec(&(workspace_id, connection_id, key_version)).map_err(|_| invalid())?;
    let cipher = Aes256Gcm::new_from_slice(&key_bytes).map_err(|_| invalid())?;
    let plain = Zeroizing::new(
        cipher
            .decrypt(
                &Nonce::from(nonce),
                Payload {
                    msg: &body,
                    aad: &aad,
                },
            )
            .map_err(|_| invalid())?,
    );
    let value: Value = serde_json::from_slice(&plain).map_err(|_| invalid())?;
    if !value.is_object() {
        return Err(invalid());
    }
    Ok(value)
}
