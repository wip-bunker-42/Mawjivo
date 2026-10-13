use super::{
    ServiceTransfer, TransferBundle, TransferSource, TransferSummary, parse_env, serialize_env,
};
use crate::{
    contracts::AppError,
    profiles::{LocalStore, ServiceProfile},
    vault::Vault,
};
use std::{
    collections::BTreeMap,
    fs::{File, OpenOptions},
    io::{Read, Write},
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};
use zeroize::Zeroizing;

fn file_error() -> AppError {
    AppError::new(
        "TRANSFER_FILE",
        "تعذر قراءة ملف الإعدادات أو حفظه. راجع المسار وصلاحياته.",
    )
}
fn summary(services: &[ServiceTransfer]) -> TransferSummary {
    TransferSummary {
        services: services.len() as u32,
        workspaces: services
            .iter()
            .map(|service| service.snapshot.workspaces.len() as u32)
            .sum(),
        connections: services
            .iter()
            .map(|service| service.snapshot.connections.len() as u32)
            .sum(),
    }
}
fn utc_timestamp(seconds: u64) -> String {
    // Gregorian UTC conversion, with no additional runtime date dependency.
    let days = (seconds / 86400) as i64 + 719468;
    let era = days / 146097;
    let day_of_era = days - era * 146097;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36524 - day_of_era / 146096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        seconds % 86400 / 3600,
        seconds % 3600 / 60,
        seconds % 60
    )
}

pub async fn export_to(
    source: &dyn TransferSource,
    vault: &dyn Vault,
    store: &LocalStore,
    path: &Path,
) -> Result<TransferSummary, AppError> {
    let states = store.list_states()?;
    if states.is_empty() || states.iter().any(|state| state.profile.base_url.is_empty()) {
        return Err(AppError::new(
            "TRANSFER_NO_SERVICE",
            "أكمل ربط الخدمة قبل تصدير الإعدادات.",
        ));
    }
    let mut services = Vec::new();
    for state in states {
        let mut secrets = BTreeMap::new();
        for suffix in [
            "device",
            "encryption",
            "cloudflare",
            "r2-access",
            "r2-secret",
            "healthchecks",
        ] {
            let reference = format!("{}:{suffix}", state.profile.id);
            match vault.get(&reference) {
                Ok(value) => {
                    secrets.insert(reference, value);
                }
                Err(error) if suffix == "healthchecks" && error.code == "SECRET_MISSING" => {}
                Err(error) => return Err(error),
            }
        }
        services.push(source.inspect(&state, &secrets).await?);
    }
    let result = summary(&services);
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| file_error())?
        .as_secs();
    let bytes = Zeroizing::new(serialize_env(&TransferBundle {
        exported_at: utc_timestamp(seconds),
        services,
    })?);
    let directory = path
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let temporary = directory.join(format!(".mawjivo-transfer-{}.tmp", uuid::Uuid::new_v4()));
    let outcome = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|_| file_error())?;
        file.write_all(&bytes).map_err(|_| file_error())?;
        file.sync_all().map_err(|_| file_error())?;
        drop(file);
        std::fs::rename(&temporary, path).map_err(|_| file_error())
    })();
    if outcome.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    outcome?;
    Ok(result)
}

pub async fn import_from(
    source: &dyn TransferSource,
    vault: &dyn Vault,
    store: &LocalStore,
    path: &Path,
) -> Result<(TransferSummary, Vec<ServiceProfile>), AppError> {
    let file = File::open(path).map_err(|_| file_error())?;
    if !file.metadata().map_err(|_| file_error())?.is_file() {
        return Err(file_error());
    }
    let mut bytes = Zeroizing::new(Vec::new());
    file.take(2 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| file_error())?;
    let bundle = parse_env(&bytes)?;
    let mut live = Vec::new();
    for service in bundle.services {
        live.push(source.inspect(&service.state, &service.secrets).await?);
    }
    // The live cloud snapshot validates the file; it is never written back to Cloudflare.
    super::format::validate_bundle(&TransferBundle {
        exported_at: bundle.exported_at,
        services: live.clone(),
    })?;
    let states: Vec<_> = live.iter().map(|service| service.state.clone()).collect();
    store.validate_import_states(&states)?;
    let mut pending = Vec::new();
    for service in &live {
        for (reference, value) in &service.secrets {
            match vault.get(reference) {
                Ok(existing) => {
                    if Zeroizing::new(existing).as_str() != value {
                        return Err(AppError::new(
                            "TRANSFER_CONFLICT",
                            "تختلف بيانات الربط عن الموجودة في خزنة هذا الجهاز. لم تُستبدل.",
                        ));
                    }
                }
                Err(error) if error.code == "SECRET_MISSING" => pending.push((reference, value)),
                Err(error) => return Err(error),
            }
        }
    }
    let mut added = Vec::new();
    let outcome = (|| {
        for (reference, value) in pending {
            added.push(reference);
            vault.set(reference, value)?;
        }
        store.import_states(&states)
    })();
    if let Err(error) = outcome {
        let mut restored = true;
        for reference in added.into_iter().rev() {
            if vault.delete(reference).is_err() {
                restored = false;
            }
        }
        if !restored {
            return Err(AppError::new(
                "TRANSFER_ROLLBACK_FAILED",
                "لم يكتمل الاستيراد وتعذرت إزالة بعض بيانات الربط الجديدة. افتح خزنة النظام ثم أعد المحاولة بالملف نفسه.",
            ));
        }
        return Err(error);
    }
    Ok((
        summary(&live),
        states.into_iter().map(|state| state.profile).collect(),
    ))
}

#[cfg(test)]
mod tests {
    use super::utc_timestamp;
    #[test]
    fn formats_utc_export_time_across_calendar_boundaries() {
        assert_eq!(utc_timestamp(0), "1970-01-01T00:00:00Z");
        assert_eq!(utc_timestamp(1709251199), "2024-02-29T23:59:59Z");
        assert_eq!(utc_timestamp(1791849600), "2026-10-13T00:00:00Z");
    }
}
