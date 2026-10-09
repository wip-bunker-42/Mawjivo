pub mod cloudflare;
pub mod cloudflare_api;
pub mod commands;
pub mod contracts;
pub mod error;
pub mod profiles;
pub mod service_artifact;
pub mod vault;
pub fn run() {
    tauri::Builder::default()
        .setup(commands::setup)
        .invoke_handler(tauri::generate_handler![
            commands::list_profiles,
            commands::provision_service,
            commands::save_draft,
            commands::load_draft,
            commands::service_request
        ])
        .run(tauri::generate_context!())
        .expect("Mawjivo could not start");
}
