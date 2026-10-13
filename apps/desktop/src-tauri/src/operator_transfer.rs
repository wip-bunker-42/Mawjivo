use mawjivo_lib::{
    cloudflare_api::CloudflareClient,
    contracts::AppError,
    profiles::{LocalStore, ProvisionInput},
    transfer::{
        CloudflareTransferSource, ServiceTransfer, TransferBundle, TransferSource, export_to,
        import_from, parse_env,
    },
    vault::Vault,
};
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    fs::File,
    io::Read,
    path::{Path, PathBuf},
    sync::Mutex,
};
use zeroize::Zeroizing;

fn failure() -> AppError {
    AppError::new(
        "TRANSFER_ACCEPTANCE",
        "تعذر إثبات النقل المعزول. راجع الاتصال وبيئة الاختبار.",
    )
}
fn isolated_directory(target: &Path, owner: &Path) -> Result<PathBuf, AppError> {
    let parent = target
        .parent()
        .ok_or_else(failure)?
        .canonicalize()
        .map_err(|_| failure())?;
    let resolved = parent.join(target.file_name().ok_or_else(failure)?);
    let owner_text = owner
        .to_string_lossy()
        .replace('/', "\\")
        .to_ascii_lowercase();
    let target_text = resolved
        .to_string_lossy()
        .replace('/', "\\")
        .to_ascii_lowercase();
    let owner_text = owner_text
        .trim_start_matches("\\\\?\\")
        .trim_end_matches('\\');
    let target_text = target_text.trim_start_matches("\\\\?\\");
    if target_text == owner_text
        || target_text.starts_with(&format!("{owner_text}\\"))
        || resolved.exists()
    {
        return Err(failure());
    }
    std::fs::create_dir(&resolved).map_err(|_| failure())?;
    resolved.canonicalize().map_err(|_| failure())
}
fn receipt(services: &[ServiceTransfer], resources: &[Value], fresh: bool) -> Value {
    let fields = [
        "serviceId",
        "databaseId",
        "worker",
        "mediaBucket",
        "workflow",
        "workspaceIds",
        "connectionIds",
        "postIds",
    ];
    let identities: Vec<Value> = resources
        .iter()
        .map(|resource| {
            Value::Object(
                fields
                    .iter()
                    .filter_map(|field| {
                        resource
                            .get(*field)
                            .map(|value| ((*field).into(), value.clone()))
                    })
                    .collect(),
            )
        })
        .collect();
    json!({"schema":1,"verified":true,"freshVault":fresh,"freshDatabase":fresh,"cloudWrites":0,"summary":{"services":services.len(),"workspaces":services.iter().map(|service|service.snapshot.workspaces.len()).sum::<usize>(),"connections":services.iter().map(|service|service.snapshot.connections.len()).sum::<usize>()},"identities":identities})
}
fn read_bundle(path: &Path) -> Result<TransferBundle, AppError> {
    let file = File::open(path).map_err(|_| failure())?;
    if !file.metadata().map_err(|_| failure())?.is_file() {
        return Err(failure());
    }
    let mut bytes = Zeroizing::new(Vec::new());
    file.take(2 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| failure())?;
    parse_env(&bytes)
}
async fn current(bundle: &TransferBundle) -> Result<Vec<ServiceTransfer>, AppError> {
    let mut services = Vec::new();
    for service in &bundle.services {
        services.push(
            CloudflareTransferSource
                .inspect(&service.state, &service.secrets)
                .await?,
        );
    }
    Ok(services)
}
async fn resources(services: &[ServiceTransfer]) -> Result<Vec<Value>, AppError> {
    let mut results = Vec::new();
    for service in services {
        let value = |suffix: &str| {
            service
                .secrets
                .get(&format!("{}:{suffix}", service.state.profile.id))
                .cloned()
                .ok_or_else(failure)
        };
        let input = ProvisionInput {
            account_id: service.state.profile.account_id.clone(),
            api_token: value("cloudflare")?,
            r2_access_key_id: value("r2-access")?,
            r2_secret_access_key: value("r2-secret")?,
            zone_id: service.state.zone_id.clone(),
            domain: service.state.domain.clone(),
        };
        let api = CloudflareClient::new(&input, &service.state).await?;
        let ids = |items: &[Value]| -> Result<Vec<String>, AppError> {
            let mut ids: Vec<_> = items
                .iter()
                .map(|item| item["id"].as_str().map(String::from).ok_or_else(failure))
                .collect::<Result<_, _>>()?;
            ids.sort();
            Ok(ids)
        };
        results.push(
            api.transfer_resource_evidence(
                &service.state,
                &ids(&service.snapshot.workspaces)?,
                &ids(&service.snapshot.connections)?,
            )
            .await?,
        );
    }
    Ok(results)
}

struct AcceptanceVault {
    namespace: String,
    created: Mutex<BTreeSet<String>>,
}
impl AcceptanceVault {
    fn new() -> Self {
        Self {
            namespace: format!(
                "com.aimansour.mawjivo.transfer-test.{}",
                uuid::Uuid::new_v4()
            ),
            created: Mutex::new(BTreeSet::new()),
        }
    }
    fn cleanup(&self) -> Result<(), AppError> {
        let references = self.created.lock().map_err(|_| failure())?.clone();
        let mut clean = true;
        for reference in references {
            if self.delete(&reference).is_err() {
                clean = false;
            }
        }
        if clean {
            Ok(())
        } else {
            Err(AppError::new(
                "TRANSFER_ACCEPTANCE_CLEANUP",
                "تعذرت إزالة بعض مراجع خزنة الاختبار المعزولة.",
            ))
        }
    }
}
impl Drop for AcceptanceVault {
    fn drop(&mut self) {
        let _ = self.cleanup();
    }
}
impl Vault for AcceptanceVault {
    fn get(&self, reference: &str) -> Result<String, AppError> {
        keyring::Entry::new(&self.namespace, reference)
            .and_then(|entry| entry.get_password())
            .map_err(|error| match error {
                keyring::Error::NoEntry => AppError::new("SECRET_MISSING", "مفقود"),
                _ => failure(),
            })
    }
    fn set(&self, reference: &str, value: &str) -> Result<(), AppError> {
        self.created
            .lock()
            .map_err(|_| failure())?
            .insert(reference.into());
        keyring::Entry::new(&self.namespace, reference)
            .and_then(|entry| entry.set_password(value))
            .map_err(|_| failure())
    }
    fn delete(&self, reference: &str) -> Result<(), AppError> {
        match keyring::Entry::new(&self.namespace, reference)
            .and_then(|entry| entry.delete_credential())
        {
            Ok(()) | Err(keyring::Error::NoEntry) => {
                self.created
                    .lock()
                    .map_err(|_| failure())?
                    .remove(reference);
                Ok(())
            }
            Err(_) => Err(failure()),
        }
    }
}

pub async fn run(args: &[String]) -> Result<Value, AppError> {
    if args.len() == 2 && args[0] == "--verify-transfer-file" {
        let bundle = read_bundle(Path::new(&args[1]))?;
        let live = current(&bundle).await?;
        return Ok(receipt(&live, &resources(&live).await?, false));
    }
    if args.len() != 3 || args[0] != "--accept-transfer" {
        return Err(failure());
    }
    let file = Path::new(&args[2]).canonicalize().map_err(|_| failure())?;
    let bundle = read_bundle(&file)?;
    let before = current(&bundle).await?;
    let before_resources = resources(&before).await?;
    let owner = PathBuf::from(std::env::var_os("LOCALAPPDATA").ok_or_else(failure)?)
        .join("com.aimansour.mawjivo");
    let directory = isolated_directory(Path::new(&args[1]), &owner)?;
    let vault = AcceptanceVault::new();
    let outcome = async {
        let store = LocalStore::open(&directory.join("mawjivo.sqlite"))?;
        if !store.list_states()?.is_empty() {
            return Err(failure());
        }
        for reference in bundle
            .services
            .iter()
            .flat_map(|service| service.secrets.keys())
        {
            match vault.get(reference) {
                Err(error) if error.code == "SECRET_MISSING" => {}
                _ => return Err(failure()),
            }
        }
        let (summary, profiles) =
            import_from(&CloudflareTransferSource, &vault, &store, &file).await?;
        let imported_states = store.list_states()?;
        if profiles.len() != bundle.services.len()
            || imported_states
                .iter()
                .zip(&before)
                .any(|(state, expected)| {
                    serde_json::to_value(state).ok() != serde_json::to_value(&expected.state).ok()
                })
        {
            return Err(failure());
        }
        // Repeat import proves idempotence against the real Windows credential store.
        import_from(&CloudflareTransferSource, &vault, &store, &file).await?;
        let export = directory.join("restored.secrets.env");
        let exported_summary =
            export_to(&CloudflareTransferSource, &vault, &store, &export).await?;
        if summary.connections != exported_summary.connections
            || summary.workspaces != exported_summary.workspaces
            || summary.services != exported_summary.services
        {
            return Err(failure());
        }
        let after = read_bundle(&export)?;
        let after_resources = resources(&after.services).await?;
        if before_resources != after_resources
            || before
                .iter()
                .zip(&after.services)
                .any(|(old, new)| old.snapshot.workspaces != new.snapshot.workspaces)
        {
            return Err(failure());
        }
        let mut report = receipt(&after.services, &after_resources, true);
        report["resourcesUnchanged"] = true.into();
        report["repeatImportStable"] = true.into();
        Ok(report)
    }
    .await;
    let cleanup = vault.cleanup();
    // This directory was just created after rejecting the owner's data directory.
    let removed = std::fs::remove_dir_all(&directory).map_err(|_| {
        AppError::new(
            "TRANSFER_ACCEPTANCE_CLEANUP",
            "تعذرت إزالة ملفات الاختبار المحلية.",
        )
    });
    cleanup?;
    removed?;
    outcome
}

#[cfg(test)]
#[path = "../tests/support/transfer.rs"]
mod fixtures;
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn refuses_owner_directory_and_existing_targets() {
        let root = tempfile::tempdir().unwrap();
        let owner = root.path().join("owner");
        std::fs::create_dir(&owner).unwrap();
        assert!(isolated_directory(&owner, &owner).is_err());
        assert!(isolated_directory(&owner.join("nested"), &owner).is_err());
        assert!(isolated_directory(root.path(), &owner).is_err());
    }
    #[test]
    fn creates_only_a_fresh_isolated_directory() {
        let root = tempfile::tempdir().unwrap();
        let target = root.path().join("fresh");
        let result = isolated_directory(&target, &root.path().join("owner")).unwrap();
        assert!(result.is_dir());
        assert!(std::fs::read_dir(result).unwrap().next().is_none());
    }
    #[test]
    fn report_exposes_counts_and_ids_without_any_credentials() {
        let bundle = fixtures::fixture_bundle(1);
        let old = mawjivo_lib::transfer::parse_env(&fixtures::legacy_env(&bundle)).unwrap();
        let result = receipt(&old.services, &[], true);
        assert_eq!(result["summary"]["connections"], 3);
        assert_eq!(result["freshVault"], true);
        let text = result.to_string();
        assert!(!text.contains("credentials"));
        assert!(!text.contains("secret"));
        assert!(!text.contains("synthetic-page-token"));
    }
}
