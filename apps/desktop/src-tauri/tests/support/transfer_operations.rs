use super::support::fixture_bundle;
use async_trait::async_trait;
use mawjivo_lib::{
    contracts::AppError,
    profiles::ProvisionState,
    transfer::{ServiceTransfer, TransferSource},
    vault::Vault,
};
use std::{collections::BTreeMap, sync::Mutex};

#[derive(Default)]
pub struct TransferVault {
    pub values: Mutex<BTreeMap<String, String>>,
    pub writes: Mutex<usize>,
    pub fail_after: Option<usize>,
}
impl Vault for TransferVault {
    fn get(&self, reference: &str) -> Result<String, AppError> {
        self.values
            .lock()
            .unwrap()
            .get(reference)
            .cloned()
            .ok_or_else(|| AppError::new("SECRET_MISSING", "مفقود"))
    }
    fn set(&self, reference: &str, value: &str) -> Result<(), AppError> {
        let mut writes = self.writes.lock().unwrap();
        if self.fail_after == Some(*writes) {
            return Err(AppError::new("VAULT_UNAVAILABLE", "تعذر الحفظ"));
        }
        *writes += 1;
        self.values
            .lock()
            .unwrap()
            .insert(reference.into(), value.into());
        Ok(())
    }
    fn delete(&self, reference: &str) -> Result<(), AppError> {
        self.values.lock().unwrap().remove(reference);
        Ok(())
    }
}

#[derive(Default)]
pub struct LiveSource {
    pub fail_profile: Option<String>,
    pub reads: Mutex<Vec<ServiceTransfer>>,
}
#[async_trait]
impl TransferSource for LiveSource {
    async fn inspect(
        &self,
        state: &ProvisionState,
        secrets: &BTreeMap<String, String>,
    ) -> Result<ServiceTransfer, AppError> {
        if self.fail_profile.as_deref() == Some(state.profile.id.as_str()) {
            return Err(AppError::new("NETWORK", "غير متاحة"));
        }
        let index = usize::from_str_radix(&state.profile.id, 16).unwrap();
        let mut result = fixture_bundle(index).services.remove(index - 1);
        result.state = state.clone();
        result.secrets = secrets.clone();
        result.snapshot.workspaces[0]["defaultYoutubeCategoryId"] = "25".into();
        result.snapshot.workspaces[0]["preferredChannels"]["youtube"] = "latest-channel".into();
        self.reads.lock().unwrap().push(result.clone());
        Ok(result)
    }
}
