use crate::contracts::AppError;
pub trait Vault: Send + Sync {
    fn get(&self, reference: &str) -> Result<String, AppError>;
    fn set(&self, reference: &str, value: &str) -> Result<(), AppError>;
    fn delete(&self, reference: &str) -> Result<(), AppError>;
}
pub struct SystemVault;
impl Vault for SystemVault {
    fn delete(&self, reference: &str) -> Result<(), AppError> {
        match keyring::Entry::new("com.aimansour.mawjivo", reference)
            .and_then(|entry| entry.delete_credential())
        {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(AppError::new(
                "VAULT_UNAVAILABLE",
                "تعذر إزالة بيانات الربط الجديدة من خزنة النظام.",
            )),
        }
    }
    fn get(&self, reference: &str) -> Result<String, AppError> {
        let entry = keyring::Entry::new("com.aimansour.mawjivo", reference).map_err(|_| {
            AppError::new(
                "VAULT_UNAVAILABLE",
                "تعذر فتح خزنة النظام. افتح جلستك ثم أعد المحاولة.",
            )
        })?;
        entry.get_password().map_err(|error| match error {
            keyring::Error::NoEntry => AppError::new(
                "SECRET_MISSING",
                "بيانات الربط المحلية مفقودة. أعد ربط الخدمة.",
            ),
            _ => AppError::new("VAULT_UNAVAILABLE", "تعذر قراءة خزنة النظام."),
        })
    }
    fn set(&self, reference: &str, value: &str) -> Result<(), AppError> {
        keyring::Entry::new("com.aimansour.mawjivo", reference)
            .and_then(|entry| entry.set_password(value))
            .map_err(|_| {
                AppError::new("VAULT_UNAVAILABLE", "تعذر حفظ بيانات الربط في خزنة النظام.")
            })
    }
}
