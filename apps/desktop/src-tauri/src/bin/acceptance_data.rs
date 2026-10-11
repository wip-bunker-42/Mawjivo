// Operator-only executable; never bundled or exposed through Tauri IPC.
use mawjivo_lib::{profiles::{LocalStore, ProvisionState}, vault::{SystemVault, Vault}, service_artifact::sha256};
fn main() {
    if let Err(error) = run() { eprintln!("ACCEPTANCE_DATA_ERROR: {error}"); std::process::exit(1); }
}
fn run() -> Result<(), String> {
    let directory = std::path::PathBuf::from(std::env::var_os("LOCALAPPDATA").ok_or("Windows user directory missing")?).join("com.aimansour.mawjivo.acceptance");
    std::fs::create_dir_all(&directory).map_err(|_| "Cannot create acceptance data directory")?;
    let store = LocalStore::open(&directory.join("mawjivo.sqlite")).map_err(|e| e.message_ar)?;
    let mode = std::env::args().nth(1).ok_or("Missing acceptance mode")?;
    if mode == "seed" {
        if !store.list_states().map_err(|e|e.message_ar)?.is_empty() { return Err("Acceptance profile already exists".into()); }
        let url = std::env::var("MAWJIVO_ACCEPTANCE_FIXTURE_URL").map_err(|_|"Fixture URL missing")?;
        let parsed = reqwest::Url::parse(&url).map_err(|_|"Invalid fixture URL")?;
        if parsed.scheme() != "https" || !parsed.host_str().is_some_and(|host| host.starts_with("mawjivo-desktop-acceptance.") && host.ends_with(".workers.dev")) || !parsed.username().is_empty() || parsed.password().is_some() { return Err("Invalid fixture origin".into()); }
        let mut state = ProvisionState::new(&"a".repeat(32));
        state.profile.id = "acceptance-profile".into();
        state.profile.base_url = url;
        state.profile.device_credential_ref = format!("acceptance:device:{}", uuid::Uuid::new_v4());
        let token = uuid::Uuid::new_v4().to_string();
        SystemVault.set(&state.profile.device_credential_ref, &token).map_err(|e|e.message_ar)?;
        if SystemVault.get(&state.profile.device_credential_ref).map_err(|e|e.message_ar)? != token { return Err("Vault roundtrip failed".into()); }
        store.save_state(&state).map_err(|e|e.message_ar)?;
    } else if mode != "probe" { return Err("Invalid acceptance mode".into()); }
    let state = store.get_state("acceptance-profile").map_err(|e|e.message_ar)?;
    let token = SystemVault.get(&state.profile.device_credential_ref).map_err(|e|e.message_ar)?;
    let draft = store.window_draft("acceptance-profile", "main", "acceptance-space").map_err(|e|e.message_ar)?;
    let backup_count = directory.join("backups").read_dir().map(|entries| entries.flatten().count()).unwrap_or(0);
    println!("{}", serde_json::json!({"profileHash":sha256(serde_json::to_vec(&state).map_err(|_|"Invalid profile")?),"vaultHash":sha256(&token),"draftHash":draft.as_ref().map(|draft|sha256(serde_json::to_vec(draft).unwrap())),"draftText":draft.map(|draft|draft.text),"backupCount":backup_count}));
    Ok(())
}
