use crate::{
    contracts::AppError,
    profiles::{LocalStore, ProvisionInput, ProvisionState, ServiceProfile},
    vault::Vault,
};
use async_trait::async_trait;
use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use zeroize::Zeroizing;
#[async_trait]
pub trait ProvisionApi: Send + Sync {
    async fn worker_tags(&self, name: &str) -> Result<Option<Vec<String>>, AppError>;
    async fn database(&self, name: &str, known_id: Option<&str>) -> Result<String, AppError>;
    async fn bucket(&self, name: &str, known: bool) -> Result<(), AppError>;
    async fn verify_existing_resources(&self, state: &ProvisionState) -> Result<(), AppError>;
    async fn deploy(
        &self,
        state: &ProvisionState,
        device_token: &str,
        encryption_key: &str,
        input: &ProvisionInput,
    ) -> Result<String, AppError>;
}
#[derive(serde::Serialize)]
pub struct ServicePackageInfo {
    pub id: String,
    pub version: String,
}
pub fn service_package_info() -> Result<ServicePackageInfo, AppError> {
    Ok(ServicePackageInfo {
        id: crate::service_artifact::sha256(include_bytes!("../service-artifact/manifest.json")),
        version: crate::service_artifact::ServiceArtifact::bundled()?.version,
    })
}
pub async fn upgrade_with(
    api: &dyn ProvisionApi,
    vault: &dyn Vault,
    store: &LocalStore,
    profile_id: &str,
    package_id: &str,
) -> Result<ServiceProfile, AppError> {
    let package = service_package_info()?;
    if package_id != package.id {
        return Err(AppError::new(
            "SERVICE_PACKAGE_INVALID",
            "حزمة الخدمة غير صالحة. افتح التحديث من التطبيق.",
        ));
    }
    let mut state = store.get_state(profile_id)?;
    let tags = api.worker_tags(&state.worker_name()).await?;
    if !tags.is_some_and(|tags| tags.contains(&state.owner_tag())) {
        return Err(AppError::new(
            "RESOURCE_NOT_OWNED",
            "الخدمة غير موجودة أو لا تحمل علامة الملكية. أعد فحص الإعداد.",
        ));
    }
    let input = stored_input(&state, vault)?;
    validate_input(&input)?;
    api.verify_existing_resources(&state).await?;
    let device = Zeroizing::new(vault.get(&state.profile.device_credential_ref)?);
    let key = Zeroizing::new(vault.get(&format!("{profile_id}:encryption"))?);
    let base_url = api.deploy(&state, &device, &key, &input).await?;
    state.profile.base_url = base_url;
    state.profile.version = package.version;
    store.save_state(&state)?;
    Ok(state.profile)
}
pub fn stored_input(state: &ProvisionState, vault: &dyn Vault) -> Result<ProvisionInput, AppError> {
    let id = &state.profile.id;
    Ok(ProvisionInput {
        account_id: state.profile.account_id.clone(),
        api_token: vault.get(&format!("{id}:cloudflare"))?,
        r2_access_key_id: vault.get(&format!("{id}:r2-access"))?,
        r2_secret_access_key: vault.get(&format!("{id}:r2-secret"))?,
        zone_id: state.zone_id.clone(),
        domain: state.domain.clone(),
    })
}
pub fn validate_input(input: &ProvisionInput) -> Result<(), AppError> {
    if input.account_id.len() != 32
        || !input.account_id.bytes().all(|b| b.is_ascii_hexdigit())
        || [
            &input.api_token,
            &input.r2_access_key_id,
            &input.r2_secret_access_key,
        ]
        .iter()
        .any(|value| value.is_empty() || value.len() > 1024)
    {
        return Err(AppError::new(
            "INVALID_INPUT",
            "راجع معرف حساب Cloudflare والمفاتيح المطلوبة.",
        ));
    }
    match (&input.domain, &input.zone_id) {
        (None, None) => Ok(()),
        (Some(domain), Some(zone))
            if domain.len() <= 253
                && domain.contains('.')
                && domain
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'.')
                && zone.len() == 32
                && zone.bytes().all(|b| b.is_ascii_hexdigit()) =>
        {
            Ok(())
        }
        _ => Err(AppError::new(
            "INVALID_DOMAIN",
            "أدخل النطاق الفرعي ومعرف المنطقة معًا، أو اتركهما فارغين.",
        )),
    }
}
fn secret(
    vault: &dyn Vault,
    reference: &str,
    encoding: &base64::engine::GeneralPurpose,
    allow_create: bool,
) -> Result<Zeroizing<String>, AppError> {
    match vault.get(reference) {
        Ok(value) => Ok(Zeroizing::new(value)),
        Err(error) if error.code == "SECRET_MISSING" && allow_create => {
            let mut bytes = Zeroizing::new([0u8; 32]);
            getrandom::fill(bytes.as_mut())
                .map_err(|_| AppError::new("RANDOM_UNAVAILABLE", "تعذر إنشاء مفتاح آمن."))?;
            let value = Zeroizing::new(encoding.encode(bytes.as_slice()));
            vault.set(reference, &value)?;
            Ok(value)
        }
        Err(error) => Err(error),
    }
}
pub async fn provision_with(
    api: &dyn ProvisionApi,
    vault: &dyn Vault,
    store: &LocalStore,
    mut state: ProvisionState,
    input: ProvisionInput,
) -> Result<ServiceProfile, AppError> {
    validate_input(&input)?;
    if input.account_id != state.profile.account_id {
        return Err(AppError::new(
            "INVALID_INPUT",
            "راجع معرف حساب Cloudflare والمفاتيح المطلوبة.",
        ));
    }
    let tags = api.worker_tags(&state.worker_name()).await?;
    if let Some(ref found) = tags
        && !found.contains(&state.owner_tag())
    {
        return Err(AppError::new(
            "RESOURCE_NOT_OWNED",
            "اسم الخدمة مستخدم بواسطة مورد آخر. لم يُعدل. اختر خدمة جديدة.",
        ));
    }
    state.domain = input.domain.clone();
    state.zone_id = input.zone_id.clone();
    store.save_state(&state)?;
    let device = secret(
        vault,
        &state.profile.device_credential_ref,
        &URL_SAFE_NO_PAD,
        tags.is_none(),
    )?;
    let encryption = secret(
        vault,
        &format!("{}:encryption", state.profile.id),
        &STANDARD,
        tags.is_none(),
    )?;
    vault.set(
        &format!("{}:cloudflare", state.profile.id),
        &input.api_token,
    )?;
    vault.set(
        &format!("{}:r2-access", state.profile.id),
        &input.r2_access_key_id,
    )?;
    vault.set(
        &format!("{}:r2-secret", state.profile.id),
        &input.r2_secret_access_key,
    )?;
    state.database_id = Some(
        api.database(
            &format!("{}-db", state.worker_name()),
            state.database_id.as_deref(),
        )
        .await?,
    );
    store.save_state(&state)?;
    api.bucket(
        &format!("{}-media", state.worker_name()),
        state.bucket_created,
    )
    .await?;
    state.bucket_created = true;
    store.save_state(&state)?;
    state.profile.base_url = api.deploy(&state, &device, &encryption, &input).await?;
    state.profile.version = service_package_info()?.version;
    store.save_state(&state)?;
    Ok(state.profile)
}
