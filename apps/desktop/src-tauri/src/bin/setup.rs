use mawjivo_lib::{
    cloudflare::provision_with,
    cloudflare_api::{CloudflareClient, bounded_body, client},
    contracts::AppError,
    profiles::{LocalStore, ProvisionInput, ProvisionState},
    vault::{SystemVault, Vault},
};
use serde_json::Value;
use std::io::Read;
use zeroize::Zeroizing;
mod transfer_acceptance;
fn main() {
    let outcome = tauri::async_runtime::block_on(run());
    match outcome {
        Ok(state) => println!(
            "{}",
            serde_json::to_string(&state).expect("Safe profile serialization")
        ),
        Err(error) => {
            eprintln!("{}: {}", error.code, error.message_ar);
            std::process::exit(1);
        }
    }
}
async fn run() -> Result<Value, AppError> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args
        .first()
        .is_some_and(|arg| arg == "--verify-transfer-file" || arg == "--accept-transfer")
    {
        return transfer_acceptance::run(&args).await;
    }
    let mut text = Zeroizing::new(String::new());
    std::io::stdin()
        .take(16_385)
        .read_to_string(&mut text)
        .map_err(|_| AppError::new("INPUT", "تعذر قراءة بيانات الإعداد."))?;
    if text.len() > 16_384 {
        return Err(AppError::new(
            "INPUT",
            "بيانات الإعداد أكبر من الحد المسموح.",
        ));
    }
    if std::env::args().nth(1).as_deref() == Some("--request") {
        let request: OperatorRequest = serde_json::from_str(&text)
            .map_err(|_| AppError::new("INPUT", "صيغة طلب التجهيز غير صالحة."))?;
        return operator_request(request).await;
    }
    let input: ProvisionInput = serde_json::from_str(&text)
        .map_err(|_| AppError::new("INPUT", "صيغة بيانات الإعداد غير صالحة."))?;
    let store = local_store()?;
    let state = store
        .list_states()?
        .into_iter()
        .find(|profile| {
            profile.profile.account_id == input.account_id && profile.domain == input.domain
        })
        .unwrap_or_else(|| ProvisionState::new(&input.account_id));
    let api = CloudflareClient::new(&input, &state).await?;
    let profile = provision_with(&api, &SystemVault, &store, state, input).await?;
    serde_json::to_value(store.get_state(&profile.id)?)
        .map_err(|_| AppError::new("LOCAL_STORE", "تعذر قراءة حالة التجهيز."))
}
fn local_store() -> Result<LocalStore, AppError> {
    let directory = if cfg!(target_os = "windows") {
        std::env::var_os("LOCALAPPDATA").map(std::path::PathBuf::from)
    } else {
        None
    }
    .ok_or_else(|| {
        AppError::new(
            "OPERATOR_PLATFORM",
            "أداة تجهيز الحساب الأول مخصصة لويندوز. استخدم واجهة التطبيق على الأنظمة الأخرى.",
        )
    })?
    .join("com.aimansour.mawjivo");
    std::fs::create_dir_all(&directory)
        .map_err(|_| AppError::new("LOCAL_STORE", "تعذر إنشاء مجلد البيانات المحلية."))?;
    LocalStore::open(&directory.join("mawjivo.sqlite"))
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OperatorRequest {
    profile_id: String,
    method: String,
    path: String,
    body: Option<Value>,
}
fn request_allowed(method: &str, path: &str) -> bool {
    if method == "POST" && path == "/api/operator/monitoring" {
        return true;
    }
    if !mawjivo_lib::commands::allowed_service_request(method, path) {
        return false;
    }
    if method == "GET" {
        return true;
    }
    if method == "POST" && (path == "/api/workspaces" || path == "/api/service/initialize") {
        return true;
    }
    let segments: Vec<_> = path.split('/').collect();
    (method == "POST"
        && segments.len() == 5
        && segments[2] == "workspaces"
        && ["connections", "telegram", "capabilities"].contains(&segments[4]))
        || (method == "PATCH" && segments.len() == 4 && segments[2] == "workspaces")
}
async fn operator_request(request: OperatorRequest) -> Result<Value, AppError> {
    if !request_allowed(&request.method, &request.path) {
        return Err(AppError::new(
            "OPERATOR_REQUEST_DENIED",
            "أداة التجهيز لا تنشر أو تعدّل المنشورات.",
        ));
    }
    let store = local_store()?;
    let state = store.get_state(&request.profile_id)?;
    if request.path == "/api/operator/monitoring" {
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Monitoring {
            api_key: String,
            time_zone: String,
        }
        let settings: Monitoring = serde_json::from_value(request.body.unwrap_or(Value::Null))
            .map_err(|_| AppError::new("INPUT", "راجع إعدادات المراقبة."))?;
        let key = Zeroizing::new(settings.api_key);
        let input = mawjivo_lib::cloudflare::stored_input(&state, &SystemVault)?;
        let api = CloudflareClient::new(&input, &state).await?;
        let result = api
            .configure_monitoring(&state, &key, &settings.time_zone)
            .await?;
        SystemVault.set(&format!("{}:healthchecks", state.profile.id), &key)?;
        return Ok(result);
    }
    let base = reqwest::Url::parse(&state.profile.base_url)
        .map_err(|_| AppError::new("PROFILE_URL", "عنوان الخدمة غير صالح."))?;
    if base.scheme() != "https"
        || base.host_str().is_none()
        || !base.username().is_empty()
        || base.password().is_some()
        || base.path() != "/"
        || base.query().is_some()
        || base.fragment().is_some()
    {
        return Err(AppError::new("PROFILE_URL", "عنوان الخدمة غير صالح."));
    }
    let token = Zeroizing::new(SystemVault.get(&state.profile.device_credential_ref)?);
    let method = reqwest::Method::from_bytes(request.method.as_bytes())
        .map_err(|_| AppError::new("INPUT", "نوع الطلب غير صالح."))?;
    let mut outgoing = client()?
        .request(
            method,
            format!(
                "{}{}",
                state.profile.base_url.trim_end_matches('/'),
                request.path
            ),
        )
        .bearer_auth(&*token);
    if let Some(body) = request.body {
        outgoing = outgoing.json(&body);
    }
    let response = outgoing
        .send()
        .await
        .map_err(|_| AppError::new("NETWORK", "تعذر الاتصال بالخدمة."))?;
    let success = response.status().is_success();
    let bytes = bounded_body(response, 1_048_576).await?;
    if !success {
        return Err(serde_json::from_slice(&bytes)
            .unwrap_or_else(|_| AppError::new("SERVICE_ERROR", "تعذر إكمال الطلب.")));
    }
    serde_json::from_slice(&bytes)
        .map_err(|_| AppError::new("SERVICE_RESPONSE", "رد الخدمة غير صالح."))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn operator_cannot_write_posts_or_uploads() {
        for (method, path) in [
            ("POST", "/api/workspaces/a/posts"),
            ("POST", "/api/workspaces/a/posts/p/cancel"),
            ("POST", "/api/workspaces/a/posts/p/retry"),
            ("PATCH", "/api/workspaces/a/posts/p"),
            ("POST", "/api/workspaces/a/assets"),
        ] {
            assert!(!request_allowed(method, path));
        }
    }
    #[test]
    fn operator_can_read_and_configure_owned_service() {
        for (method, path) in [
            ("GET", "/api/monitoring"),
            ("GET", "/api/workspaces/a/capabilities"),
            ("POST", "/api/workspaces"),
            ("POST", "/api/workspaces/a/connections"),
            ("POST", "/api/workspaces/a/capabilities"),
            ("POST", "/api/workspaces/a/telegram"),
            ("POST", "/api/operator/monitoring"),
            ("PATCH", "/api/workspaces/a"),
        ] {
            assert!(request_allowed(method, path));
        }
        assert!(!request_allowed("GET", "https://other.test/api/workspaces"));
        assert!(!request_allowed(
            "POST",
            "/api/workspaces/a/connections?token=secret"
        ));
    }
}
