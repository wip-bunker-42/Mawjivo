use crate::{
    commands::NativeState,
    contracts::{AppError, Draft},
};
use serde::Serialize;
use tauri::{AppHandle, State, WebviewUrl, WebviewWindowBuilder, Window};
pub fn composer_window_label() -> String {
    format!("composer-{}", uuid::Uuid::new_v4().simple())
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposerContext {
    window_id: String,
    draft: Option<Draft>,
}
#[tauri::command]
pub fn composer_context(
    window: Window,
    state: State<'_, NativeState>,
    profile_id: String,
    workspace_id: String,
) -> Result<ComposerContext, AppError> {
    state.store.get_state(&profile_id)?;
    Ok(ComposerContext {
        window_id: window.label().into(),
        draft: state
            .store
            .window_draft(&profile_id, window.label(), &workspace_id)?,
    })
}
#[tauri::command]
pub async fn open_composer_window(app: AppHandle) -> Result<String, AppError> {
    use tauri::Manager;
    let work = app.state::<crate::updates::OperationGate>().work()?;
    tauri::async_runtime::spawn_blocking(move || {
        let _work = work;
        let label = composer_window_label();
        WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("index.html".into()))
            .title("Mawjivo — منشور جديد")
            .inner_size(1050.0, 760.0)
            .min_inner_size(600.0, 480.0)
            .zoom_hotkeys_enabled(true)
            .build()
            .map_err(|_| AppError::new("WINDOW_OPEN", "تعذر فتح نافذة جديدة."))?;
        Ok(label)
    })
    .await
    .map_err(|_| AppError::new("WINDOW_OPEN", "تعذر فتح نافذة جديدة."))?
}
