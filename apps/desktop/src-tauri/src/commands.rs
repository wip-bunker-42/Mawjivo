use crate::{
    cloudflare::provision_with,
    cloudflare_api::{CloudflareClient, bounded_body, client},
    contracts::{AppError, Draft},
    profiles::{LocalStore, ProvisionInput, ProvisionState, ServiceProfile},
    vault::{SystemVault, Vault},
};
use serde_json::Value;
use std::sync::Arc;
use tauri::{Manager, State, Window};
use zeroize::Zeroizing;
pub struct NativeState {
    pub store: Arc<LocalStore>,
    pub setup_lock: tokio::sync::Mutex<()>,
}
#[tauri::command]
pub fn list_profiles(state: State<'_, NativeState>) -> Result<Vec<ServiceProfile>, AppError> {
    Ok(state
        .store
        .list_states()?
        .into_iter()
        .filter(|state| !state.profile.base_url.is_empty())
        .map(|state| state.profile)
        .collect())
}
#[tauri::command]
pub async fn provision_service(
    state: State<'_, NativeState>,
    input: ProvisionInput,
) -> Result<ServiceProfile, AppError> {
    let _guard = state.setup_lock.lock().await;
    let selected = state
        .store
        .list_states()?
        .into_iter()
        .find(|profile| {
            profile.profile.account_id == input.account_id && profile.domain == input.domain
        })
        .unwrap_or_else(|| ProvisionState::new(&input.account_id));
    let api = CloudflareClient::new(&input, &selected).await?;
    provision_with(&api, &SystemVault, &state.store, selected, input).await
}
#[tauri::command]
pub fn save_draft(
    state: State<'_, NativeState>,
    window: Window,
    profile_id: String,
    window_id: String,
    draft: Draft,
) -> Result<(), AppError> {
    if window.label() != window_id {
        return Err(AppError::new("INVALID_WINDOW", "معرف النافذة غير صالح."));
    }
    state.store.save_draft(&profile_id, &window_id, &draft)
}
#[tauri::command]
pub fn load_draft(
    state: State<'_, NativeState>,
    profile_id: String,
    workspace_id: String,
    draft_id: String,
) -> Result<Option<Draft>, AppError> {
    state
        .store
        .load_draft(&profile_id, &workspace_id, &draft_id)
}
pub fn allowed_service_request(method: &str, path: &str) -> bool {
    if !["GET", "POST", "PATCH", "DELETE"].contains(&method)
        || path.len() > 1024
        || path.contains(['%', '?', '#', '\\'])
    {
        return false;
    }
    if path == "/api/service/initialize" {
        return method == "POST";
    }
    if path == "/api/workspaces" {
        return ["GET", "POST"].contains(&method);
    }
    if !path.starts_with("/api/workspaces/") {
        return false;
    }
    let parts: Vec<&str> = path.split('/').skip(3).collect();
    if !parts.iter().all(|part| {
        !part.is_empty()
            && part.len() <= 160
            && part
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    }) {
        return false;
    }
    match parts.as_slice() {
        [_workspace] => ["GET", "PATCH"].contains(&method),
        [_workspace, "capabilities"] => ["GET", "POST"].contains(&method),
        [_workspace, "summary"] => method == "GET",
        [_workspace, "connections"] => ["GET", "POST"].contains(&method),
        [_workspace, "connections", _connection] => ["PATCH", "DELETE"].contains(&method),
        [_workspace, "posts"] => ["GET", "POST"].contains(&method),
        [_workspace, "posts", _post] => ["GET", "PATCH", "DELETE"].contains(&method),
        _ => false,
    }
}
#[tauri::command]
pub async fn service_request(
    state: State<'_, NativeState>,
    profile_id: String,
    method: String,
    path: String,
    body: Option<Value>,
) -> Result<Value, AppError> {
    if !allowed_service_request(&method, &path)
        || ((method == "GET" || method == "DELETE") && body.is_some())
    {
        return Err(AppError::new(
            "INVALID_SERVICE_REQUEST",
            "طلب الخدمة غير مسموح.",
        ));
    }
    if body
        .as_ref()
        .is_some_and(|body| body.to_string().len() > 1_048_576)
    {
        return Err(AppError::new(
            "REQUEST_TOO_LARGE",
            "بيانات الطلب أكبر من الحد المسموح.",
        ));
    }
    let profile = state.store.get_state(&profile_id)?.profile;
    let url = reqwest::Url::parse(&profile.base_url)
        .map_err(|_| AppError::new("INVALID_SERVICE", "عنوان الخدمة غير صالح."))?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(AppError::new(
            "INVALID_SERVICE",
            "عنوان الخدمة يحتاج إصلاحًا.",
        ));
    }
    let token = Zeroizing::new(SystemVault.get(&profile.device_credential_ref)?);
    let method = method
        .parse::<reqwest::Method>()
        .map_err(|_| AppError::new("INVALID_SERVICE_REQUEST", "طريقة الطلب غير صالحة."))?;
    let mut request = client()?
        .request(
            method,
            format!("{}{}", profile.base_url.trim_end_matches('/'), path),
        )
        .bearer_auth(token.as_str());
    if let Some(body) = body {
        request = request.json(&body)
    }
    let response = request
        .send()
        .await
        .map_err(|_| AppError::new("NETWORK", "تعذر الوصول للخدمة. تحقق من اتصالك."))?;
    let success = response.status().is_success();
    let bytes = bounded_body(response, 2_097_152).await?;
    if !success {
        return Err(serde_json::from_slice::<AppError>(&bytes)
            .unwrap_or_else(|_| AppError::new("SERVICE_ERROR", "تعذر إكمال الطلب. حاول لاحقًا.")));
    }
    serde_json::from_slice(&bytes)
        .map_err(|_| AppError::new("SERVICE_RESPONSE", "استجابة الخدمة غير صالحة."))
}
pub fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let directory = app.path().app_local_data_dir()?;
    std::fs::create_dir_all(&directory)?;
    let store = LocalStore::open(&directory.join("mawjivo.sqlite"))
        .map_err(|error| std::io::Error::other(error.message_ar))?;
    app.manage(NativeState {
        store: Arc::new(store),
        setup_lock: tokio::sync::Mutex::new(()),
    });
    crate::media::jobs::setup(app)?;
    crate::upload::commands::setup(app)?;
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rpc_only_allows_bounded_service_paths() {
        assert!(allowed_service_request(
            "GET",
            "/api/workspaces/space-1/capabilities"
        ));
        for path in [
            "https://elsewhere.test",
            "//elsewhere.test",
            "/api/workspaces/../secrets",
            "/api/workspaces/%2e%2e/secrets",
            "/api/workspaces/id?url=https://elsewhere.test",
        ] {
            assert!(!allowed_service_request("GET", path));
        }
        assert!(!allowed_service_request("PUT", "/api/workspaces"));
        assert!(!allowed_service_request(
            "GET",
            "/api/workspaces/id/secrets"
        ));
    }
    #[test]
    fn manual_capabilities_refresh_is_an_explicit_scoped_post() {
        assert!(allowed_service_request(
            "POST",
            "/api/workspaces/space-1/capabilities"
        ));
        assert!(!allowed_service_request(
            "POST",
            "/api/workspaces/space-1/summary"
        ));
    }
}
