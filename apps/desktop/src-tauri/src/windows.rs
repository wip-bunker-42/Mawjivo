use crate::{
    commands::NativeState,
    contracts::{AppError, Draft},
};
use serde::Serialize;
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder, Window};
#[tauri::command]
pub fn list_saved_composers(
    app: AppHandle,
    state: State<'_, NativeState>,
    profile_id: String,
    workspace_id: String,
) -> Result<Vec<crate::profiles::SavedComposer>, AppError> {
    state.store.get_state(&profile_id)?;
    state.store.saved_composers(
        &profile_id,
        &workspace_id,
        &app.webview_windows().into_keys().collect::<Vec<_>>(),
    )
}
#[tauri::command]
pub async fn open_saved_composer(
    app: AppHandle,
    profile_id: String,
    workspace_id: String,
    window_id: String,
    draft_id: String,
) -> Result<String, AppError> {
    let work = app.state::<crate::updates::OperationGate>().work()?;
    tauri::async_runtime::spawn_blocking(move || {
        let _work = work;
        let suffix = window_id.strip_prefix("composer-").unwrap_or("");
        if suffix.len()!=32 || !suffix.bytes().all(|c| c.is_ascii_hexdigit()) {
            return Err(AppError::new("INVALID_WINDOW","معرف نافذة المسودة غير صالح."));
        }
        let state = app.state::<NativeState>();
        state.store.get_state(&profile_id)?;
        state.store.window_draft(&profile_id,&window_id,&workspace_id)?
            .filter(|draft| draft.id==draft_id)
            .ok_or_else(|| AppError::new("DRAFT_NOT_FOUND","لم تعد هذه المسودة متاحة؛ حدّث القائمة."))?;
        if app.get_webview_window(&window_id).is_some() {
            return Err(AppError::new("DRAFT_WINDOW_OPEN","هذه المسودة مفتوحة بالفعل؛ حدّث القائمة."));
        }
        let intent = serde_json::json!({"profileId":profile_id,"workspaceId":workspace_id});
        let script = format!("Object.defineProperty(window,'__MAWJIVO_INITIAL_WORKSPACE__',{{value:{intent},writable:false}});");
        WebviewWindowBuilder::new(&app,&window_id,WebviewUrl::App("index.html".into()))
            .title("Mawjivo — مسودة محفوظة").inner_size(1050.0,760.0).min_inner_size(600.0,480.0)
            .zoom_hotkeys_enabled(true).initialization_script(script).build()
            .map_err(|_| AppError::new("WINDOW_OPEN","تعذر فتح نافذة المسودة."))?;
        // Reuse its durable label so native file/upload ownership remains intact.
        Ok(window_id)
    }).await.map_err(|_| AppError::new("WINDOW_OPEN","تعذر فتح نافذة المسودة."))?
}
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
