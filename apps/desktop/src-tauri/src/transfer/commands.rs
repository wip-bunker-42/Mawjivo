use super::{CloudflareTransferSource, TransferSummary, export_to, import_from};
use crate::{
    commands::NativeState, contracts::AppError, updates::OperationGate, vault::SystemVault,
};
use tauri::{State, Window};
use tauri_plugin_dialog::DialogExt;

async fn choose_file(window: Window, export: bool) -> Result<Option<std::path::PathBuf>, AppError> {
    let selected = tauri::async_runtime::spawn_blocking(move || {
        let picker = window
            .dialog()
            .file()
            .set_parent(&window)
            .add_filter("ملف إعدادات Mawjivo", &["env"]);
        if export {
            picker
                .set_title("تصدير الإعدادات والحسابات")
                .set_file_name("mawjivo-device.secrets.env")
                .blocking_save_file()
        } else {
            picker
                .set_title("استيراد الإعدادات والحسابات")
                .blocking_pick_file()
        }
    })
    .await
    .map_err(|_| AppError::new("TRANSFER_DIALOG", "تعذر فتح اختيار ملف الإعدادات."))?;
    selected
        .map(|file| {
            file.into_path()
                .map_err(|_| AppError::new("TRANSFER_FILE", "اختر ملف إعدادات محليًا."))
        })
        .transpose()
}

#[tauri::command]
pub async fn export_settings(
    window: Window,
    state: State<'_, NativeState>,
    gate: State<'_, OperationGate>,
) -> Result<Option<TransferSummary>, AppError> {
    let _work = gate.work()?;
    let _guard = state.setup_lock.lock().await;
    let Some(path) = choose_file(window, true).await? else {
        return Ok(None);
    };
    Ok(Some(
        export_to(&CloudflareTransferSource, &SystemVault, &state.store, &path).await?,
    ))
}

#[tauri::command]
pub async fn import_settings(
    window: Window,
    state: State<'_, NativeState>,
    gate: State<'_, OperationGate>,
) -> Result<Option<TransferSummary>, AppError> {
    let _work = gate.work()?;
    let _guard = state.setup_lock.lock().await;
    let Some(path) = choose_file(window, false).await? else {
        return Ok(None);
    };
    let (summary, _) =
        import_from(&CloudflareTransferSource, &SystemVault, &state.store, &path).await?;
    Ok(Some(summary))
}
