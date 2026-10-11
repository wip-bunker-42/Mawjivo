pub mod cloudflare;
pub mod cloudflare_api;
pub mod commands;
pub mod contracts;
pub mod error;
pub mod media;
pub mod profiles;
pub mod service_artifact;
pub mod updates;
pub mod upload;
pub mod vault;
pub mod windows;
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(commands::setup)
        .invoke_handler(tauri::generate_handler![
            commands::list_profiles,
            commands::provision_service,
            commands::service_package_info,
            commands::upgrade_service,
            commands::save_draft,
            commands::load_draft,
            windows::composer_context,
            windows::open_composer_window,
            commands::service_request,
            commands::configure_monitoring,
            updates::tauri_backend::check_update,
            updates::tauri_backend::download_update,
            updates::tauri_backend::install_update,
            updates::tauri_backend::acknowledge_update_flush,
            media::jobs::pick_media,
            media::jobs::probe_media,
            media::jobs::prepare_media,
            media::jobs::cancel_media,
            upload::commands::start_upload,
            upload::commands::resume_upload,
            upload::commands::cancel_upload,
            upload::commands::uploaded_asset,
            upload::commands::list_uploads,
            upload::commands::restore_uploads
        ])
        .run(tauri::generate_context!())
        .expect("Mawjivo could not start");
}
