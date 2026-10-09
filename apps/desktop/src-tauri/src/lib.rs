pub mod contracts;
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("Mawjivo could not start");
}
