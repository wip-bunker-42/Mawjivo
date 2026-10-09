use crate::contracts::AppError;
impl AppError {
    pub fn new(code: &str, message: &str) -> Self {
        Self {
            code: code.into(),
            message_ar: message.into(),
            retryable: false,
            details: None,
        }
    }
}
