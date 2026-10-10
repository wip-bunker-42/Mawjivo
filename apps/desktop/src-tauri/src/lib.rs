pub mod cloudflare;
pub mod cloudflare_api;
pub mod commands;
pub mod contracts;
pub mod error;
pub mod media;
pub mod profiles;
pub mod service_artifact;
pub mod vault;
pub mod upload;
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(commands::setup)
        .invoke_handler(tauri::generate_handler![
            commands::list_profiles,
            commands::provision_service,
            commands::save_draft,
            commands::load_draft,
            commands::service_request,
            media::jobs::pick_media,
            media::jobs::probe_media,
            media::jobs::prepare_media,
            media::jobs::cancel_media
        ])
        .run(tauri::generate_context!())
        .expect("Mawjivo could not start");
}
