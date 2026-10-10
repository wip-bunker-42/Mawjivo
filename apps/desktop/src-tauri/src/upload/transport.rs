use crate::{cloudflare_api::bounded_body, contracts::{AppError, MediaAsset, SignedPart, UploadManifest, UploadTicket, UploadedPart}, profiles::ServiceProfile};
use bytes::Bytes;
use reqwest::{Client, Method, Url};
use serde::{Deserialize, de::DeserializeOwned};
use serde_json::{Value, json};
use std::{sync::{Arc, atomic::{AtomicBool, Ordering}}, time::Duration};
use zeroize::Zeroizing;
enum UploadOrigin { R2 { host: String, bucket: String }, #[cfg(debug_assertions)] Loopback(Url) }
pub struct HttpUploadTransport { control: Client, data: Client, base: Url, token: Zeroizing<String>, origin: UploadOrigin }
pub fn network() -> AppError { let mut e = AppError::new("UPLOAD_NETWORK", "انقطع الرفع؛ يمكنك استكمال الأجزاء المتبقية."); e.retryable = true; e }
pub fn cancelled() -> AppError { AppError::new("UPLOAD_CANCELLED", "أُلغي الرفع.") }
pub fn valid_id(value: &str) -> bool { !value.is_empty() && value.len() <= 160 && value.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') }
fn invalid() -> AppError { AppError::new("UPLOAD_RESPONSE", "استجابة الرفع غير صالحة؛ أعد المحاولة.") }
fn json_as<T: DeserializeOwned>(value: Value) -> Result<T, AppError> { serde_json::from_value(value).map_err(|_| invalid()) }
#[derive(Deserialize)]
pub struct RemoteAsset { pub state: String, pub asset: Option<MediaAsset> }
impl HttpUploadTransport {
    pub fn new(profile: &ServiceProfile, token: &str) -> Result<Self, AppError> {
        let base = Url::parse(&profile.base_url).map_err(|_| invalid())?;
        if base.scheme() != "https" || base.host_str().is_none() || !base.username().is_empty() || base.password().is_some() || base.path() != "/" || base.query().is_some() || base.fragment().is_some() || profile.account_id.len() != 32 || !profile.account_id.bytes().all(|b| b.is_ascii_hexdigit()) || !valid_id(&profile.service_id) { return Err(invalid()); }
        Self::with_origin(base, token, UploadOrigin::R2 { host: format!("{}.r2.cloudflarestorage.com", profile.account_id), bucket: format!("mawjivo-{}-media", profile.service_id) })
    }
    #[cfg(debug_assertions)]
    pub fn loopback(origin: &str, token: &str) -> Result<Self, AppError> {
        let base = Url::parse(origin).map_err(|_| invalid())?;
        if base.scheme() != "http" || base.host_str() != Some("127.0.0.1") || base.path() != "/" || !base.username().is_empty() || base.password().is_some() || base.query().is_some() || base.fragment().is_some() { return Err(invalid()); }
        Self::with_origin(base.clone(), token, UploadOrigin::Loopback(base))
    }
    fn with_origin(base: Url, token: &str, origin: UploadOrigin) -> Result<Self, AppError> {
        let build = |timeout| Client::builder().timeout(timeout).connect_timeout(Duration::from_secs(10)).redirect(reqwest::redirect::Policy::none()).user_agent("Mawjivo/0.1.0").build().map_err(|_| network());
        Ok(Self { control: build(Duration::from_secs(35))?, data: build(Duration::from_secs(1200))?, base, token: Zeroizing::new(token.into()), origin })
    }
    async fn request(&self, method: Method, path: &str, body: Option<Value>) -> Result<Value, AppError> {
        let mut r = self.control.request(method, self.base.join(path).map_err(|_| invalid())?).bearer_auth(self.token.as_str());
        if let Some(body) = body { r = r.json(&body); }
        let response = r.send().await.map_err(|_| network())?;
        let status = response.status(); let bytes = bounded_body(response, 2_097_152).await?;
        if !status.is_success() {
            let mut error = serde_json::from_slice::<AppError>(&bytes).unwrap_or_else(|_| network());
            error.details = None;
            if error.code.len() > 80 || error.message_ar.len() > 1024 { return Err(invalid()); }
            return Err(error);
        }
        if status.as_u16() == 204 { return Ok(Value::Null); }
        serde_json::from_slice(&bytes).map_err(|_| invalid())
    }
    pub async fn begin(&self, workspace: &str, manifest: &UploadManifest) -> Result<UploadTicket, AppError> { json_as(self.request(Method::POST, &format!("/api/workspaces/{workspace}/assets"), Some(json!(manifest))).await?) }
    pub async fn status(&self, workspace: &str, id: &str) -> Result<RemoteAsset, AppError> { json_as(self.request(Method::GET, &format!("/api/workspaces/{workspace}/assets/{id}"), None).await?) }
    pub async fn renew(&self, workspace: &str, id: &str, parts: &[u32]) -> Result<UploadTicket, AppError> { json_as(self.request(Method::POST, &format!("/api/workspaces/{workspace}/assets/{id}/renew"), Some(json!({"partNumbers":parts}))).await?) }
    pub async fn complete(&self, workspace: &str, id: &str, parts: Vec<UploadedPart>, sha256: &str) -> Result<MediaAsset, AppError> { json_as(self.request(Method::POST, &format!("/api/workspaces/{workspace}/assets/{id}/complete"), Some(json!({"parts":parts,"sha256":sha256}))).await?) }
    pub async fn abort(&self, workspace: &str, id: &str) -> Result<(), AppError> { self.request(Method::DELETE, &format!("/api/workspaces/{workspace}/assets/{id}"), None).await?; Ok(()) }
    fn part_url(&self, part: &SignedPart, multipart: &str) -> Result<Url, AppError> {
        let reject = || AppError::new("INVALID_UPLOAD_URL", "رابط الرفع لا يخص حساب Cloudflare المحدد.");
        if part.url.len() > 8192 { return Err(reject()); }
        let u = Url::parse(&part.url).map_err(|_| reject())?;
        if !u.username().is_empty() || u.password().is_some() || u.fragment().is_some() { return Err(reject()); }
        match &self.origin {
            UploadOrigin::R2 { host, bucket } => {
                let prefix = format!("/{bucket}/mawjivo/media/");
                if u.scheme() != "https" || u.host_str() != Some(host.as_str()) || u.port().is_some_and(|p| p != 443) || !u.path().starts_with(&prefix) { return Err(reject()); }
                let segments: Vec<_> = u.path()[prefix.len()..].split('/').collect();
                if segments.len() != 2 || segments.iter().any(|s| uuid::Uuid::parse_str(s).is_err()) { return Err(reject()); }
                let pairs: Vec<_> = u.query_pairs().collect();
                let one = |key: &str| { let v: Vec<_> = pairs.iter().filter(|(k,_)| k == key).collect(); if v.len() == 1 { Some(v[0].1.as_ref()) } else { None } };
                if one("partNumber") != Some(part.part_number.to_string().as_str()) || one("uploadId") != Some(multipart) || one("X-Amz-SignedHeaders") != Some("content-length;host") || one("X-Amz-Expires") != Some("900") { return Err(reject()); }
            }
            #[cfg(debug_assertions)]
            UploadOrigin::Loopback(root) => { if u.origin() != root.origin() || u.path() != format!("/r2/part/{}", part.part_number) || u.query().is_some() { return Err(reject()); } }
        }
        Ok(u)
    }
    pub async fn put(&self, part: &SignedPart, multipart: &str, body: Vec<u8>, flag: Arc<AtomicBool>, sent: Arc<dyn Fn(u64) + Send + Sync>) -> Result<String, AppError> {
        let url = self.part_url(part, multipart)?; let length = body.len();
        let stream = futures_util::stream::unfold((Bytes::from(body), 0usize, flag.clone(), sent), |(body, offset, cancel, sent)| async move {
            if offset == body.len() || cancel.load(Ordering::Relaxed) { return None; }
            let end = (offset + 65536).min(body.len()); let chunk = body.slice(offset..end); sent(end as u64);
            Some((Ok::<_,std::io::Error>(chunk), (body,end,cancel,sent)))
        });
        let request = self.data.put(url).header(reqwest::header::CONTENT_LENGTH, length).body(reqwest::Body::wrap_stream(stream)).send();
        let cancellation = async { loop { if flag.load(Ordering::Relaxed) { break; } tokio::time::sleep(Duration::from_millis(100)).await; } };
        let response = tokio::select! { r = request => r.map_err(|_| if flag.load(Ordering::Relaxed) { cancelled() } else { network() })?, _ = cancellation => return Err(cancelled()) };
        if !response.status().is_success() { return Err(network()); }
        let etag = response.headers().get(reqwest::header::ETAG).and_then(|v| v.to_str().ok()).ok_or_else(invalid)?.trim_matches('"').to_owned();
        if etag.is_empty() || etag.len() > 2048 || etag.bytes().any(|b| b < 32 || b == 127) { return Err(invalid()); }
        Ok(etag)
    }
}
