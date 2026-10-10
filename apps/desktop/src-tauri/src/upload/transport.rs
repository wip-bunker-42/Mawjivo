pub struct HttpUploadTransport;
impl HttpUploadTransport {
    #[cfg(debug_assertions)]
    pub fn loopback(_: &str, _: &str) -> Result<Self, crate::contracts::AppError> { Ok(Self) }
}
