use mawjivo_lib::{
    cloudflare::provision_with,
    cloudflare_api::CloudflareClient,
    contracts::AppError,
    profiles::{LocalStore, ProvisionInput, ProvisionState},
    vault::SystemVault,
};
use std::io::Read;
use zeroize::Zeroizing;
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
async fn run() -> Result<ProvisionState, AppError> {
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
    let input: ProvisionInput = serde_json::from_str(&text)
        .map_err(|_| AppError::new("INPUT", "صيغة بيانات الإعداد غير صالحة."))?;
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
    let store = LocalStore::open(&directory.join("mawjivo.sqlite"))?;
    let state = store
        .list_states()?
        .into_iter()
        .find(|profile| {
            profile.profile.account_id == input.account_id && profile.domain == input.domain
        })
        .unwrap_or_else(|| ProvisionState::new(&input.account_id));
    let api = CloudflareClient::new(&input, &state).await?;
    let profile = provision_with(&api, &SystemVault, &store, state, input).await?;
    store.get_state(&profile.id)
}
