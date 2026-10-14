// Operator-only executable; never bundled or exposed through Tauri IPC.
use mawjivo_lib::{
    profiles::{LocalStore, ProvisionState},
    service_artifact::sha256,
    vault::{SystemVault, Vault},
};
fn acceptance_directory(
    root: &std::path::Path,
    production: bool,
    ci: bool,
) -> Result<std::path::PathBuf, String> {
    if production && !ci {
        return Err("ACCEPTANCE_CI_ONLY".into());
    }
    Ok(root.join(if production {
        "com.aimansour.mawjivo"
    } else {
        "com.aimansour.mawjivo.acceptance"
    }))
}
fn require_empty(directory: &std::path::Path) -> Result<(), String> {
    match std::fs::read_dir(directory) {
        Ok(mut entries) => {
            if entries.next().is_none() {
                Ok(())
            } else {
                Err("ACCEPTANCE_OWNER_DATA".into())
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        _ => Err("ACCEPTANCE_OWNER_DATA".into()),
    }
}
fn main() {
    if let Err(error) = run() {
        eprintln!("ACCEPTANCE_DATA_ERROR: {error}");
        std::process::exit(1);
    }
}
fn run() -> Result<(), String> {
    let root = std::path::PathBuf::from(
        std::env::var_os("LOCALAPPDATA").ok_or("Windows user directory missing")?,
    );
    let production =
        std::env::var("MAWJIVO_ACCEPTANCE_PRODUCTION_NAMESPACE").as_deref() == Ok("true");
    let ci = std::env::var("GITHUB_ACTIONS").as_deref() == Ok("true");
    let directory = acceptance_directory(&root, production, ci)?;
    let mode = std::env::args().nth(1).ok_or("Missing acceptance mode")?;
    if mode == "assert-empty" {
        require_empty(&directory)?;
        println!("{}", serde_json::json!({"empty":true}));
        return Ok(());
    }
    if mode == "seed" && production {
        require_empty(&directory)?;
    }
    if mode != "seed" && mode != "probe" {
        return Err("Invalid acceptance mode".into());
    }
    std::fs::create_dir_all(&directory).map_err(|_| "Cannot create acceptance data directory")?;
    let store = LocalStore::open(&directory.join("mawjivo.sqlite")).map_err(|e| e.message_ar)?;
    if mode == "seed" {
        if !store.list_states().map_err(|e| e.message_ar)?.is_empty() {
            return Err("Acceptance profile already exists".into());
        }
        let url =
            std::env::var("MAWJIVO_ACCEPTANCE_FIXTURE_URL").map_err(|_| "Fixture URL missing")?;
        let parsed = reqwest::Url::parse(&url).map_err(|_| "Invalid fixture URL")?;
        if parsed.scheme() != "https"
            || !parsed.host_str().is_some_and(|host| {
                host.starts_with("mawjivo-desktop-acceptance.") && host.ends_with(".workers.dev")
            })
            || !parsed.username().is_empty()
            || parsed.password().is_some()
        {
            return Err("Invalid fixture origin".into());
        }
        let mut state = ProvisionState::new(&"a".repeat(32));
        state.profile.id = "acceptance-profile".into();
        state.profile.base_url = url;
        state.profile.device_credential_ref = format!("acceptance:device:{}", uuid::Uuid::new_v4());
        let token = uuid::Uuid::new_v4().to_string();
        SystemVault
            .set(&state.profile.device_credential_ref, &token)
            .map_err(|e| e.message_ar)?;
        if SystemVault
            .get(&state.profile.device_credential_ref)
            .map_err(|e| e.message_ar)?
            != token
        {
            return Err("Vault roundtrip failed".into());
        }
        store.save_state(&state).map_err(|e| e.message_ar)?;
    } else if mode != "probe" {
        return Err("Invalid acceptance mode".into());
    }
    let state = store
        .get_state("acceptance-profile")
        .map_err(|e| e.message_ar)?;
    let token = SystemVault
        .get(&state.profile.device_credential_ref)
        .map_err(|e| e.message_ar)?;
    let draft = store
        .window_draft("acceptance-profile", "main", "acceptance-space")
        .map_err(|e| e.message_ar)?;
    let backup_count = directory
        .join("backups")
        .read_dir()
        .map(|entries| entries.flatten().count())
        .unwrap_or(0);
    println!(
        "{}",
        serde_json::json!({"profileHash":sha256(serde_json::to_vec(&state).map_err(|_|"Invalid profile")?),"vaultHash":sha256(&token),"draftHash":draft.as_ref().map(|draft|sha256(serde_json::to_vec(draft).unwrap())),"draftText":draft.map(|draft|draft.text),"backupCount":backup_count})
    );
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn production_namespace_is_ci_only_and_local_acceptance_is_separate() {
        let root = std::path::Path::new("isolated");
        assert!(acceptance_directory(root, true, false).is_err());
        assert_eq!(
            acceptance_directory(root, true, true).unwrap(),
            root.join("com.aimansour.mawjivo")
        );
        assert_eq!(
            acceptance_directory(root, false, false).unwrap(),
            root.join("com.aimansour.mawjivo.acceptance")
        );
    }
    #[test]
    fn empty_guard_preserves_owner_files_and_allows_only_absent_or_empty_directory() {
        let root =
            std::env::temp_dir().join(format!("mawjivo-acceptance-guard-{}", uuid::Uuid::new_v4()));
        assert!(require_empty(&root).is_ok());
        std::fs::create_dir(&root).unwrap();
        assert!(require_empty(&root).is_ok());
        let owner = root.join("mawjivo.sqlite");
        std::fs::write(&owner, "owner data").unwrap();
        assert!(require_empty(&root).is_err());
        assert_eq!(std::fs::read_to_string(&owner).unwrap(), "owner data");
        std::fs::remove_file(owner).unwrap();
        std::fs::remove_dir(root).unwrap();
    }
}
