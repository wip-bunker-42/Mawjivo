use crate::{
    cloudflare::ProvisionApi,
    contracts::AppError,
    profiles::{ProvisionInput, ProvisionState},
    service_artifact::{ServiceArtifact, sha256},
};
use async_trait::async_trait;
use reqwest::{Client, Method, Response, multipart};
use serde_json::{Value, json};
use std::time::Duration;
use zeroize::Zeroizing;
pub struct CloudflareClient {
    client: Client,
    account_id: String,
    service_id: String,
    token: Zeroizing<String>,
    artifact: ServiceArtifact,
}
fn api_error(status: u16) -> AppError {
    match status {
        401 | 403 => AppError::new(
            "CLOUDFLARE_PERMISSION",
            "راجع رمز Cloudflare وصلاحيات Workers وD1 وR2؛ يحتاج النطاق الخاص صلاحية DNS أيضًا.",
        ),
        429 => {
            let mut error = AppError::new(
                "CLOUDFLARE_RATE_LIMIT",
                "وصل حساب Cloudflare إلى حد الطلبات. حاول لاحقًا.",
            );
            error.retryable = true;
            error
        }
        _ => AppError::new(
            "CLOUDFLARE_API",
            "تعذر إكمال إعداد Cloudflare. أعد المحاولة لاستكمال الخطوات المحفوظة.",
        ),
    }
}
fn invalid_response() -> AppError {
    AppError::new(
        "CLOUDFLARE_RESPONSE",
        "استجابة Cloudflare غير مكتملة. حاول لاحقًا.",
    )
}
pub fn client() -> Result<Client, AppError> {
    Client::builder()
        .timeout(Duration::from_secs(35))
        .connect_timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("Mawjivo/0.1.0")
        .build()
        .map_err(|_| AppError::new("NETWORK", "تعذر إنشاء اتصال آمن."))
}
pub async fn bounded_body(mut response: Response, max_bytes: usize) -> Result<Vec<u8>, AppError> {
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| AppError::new("NETWORK", "انقطع الاتصال. حاول مجددًا."))?
    {
        if bytes.len() + chunk.len() > max_bytes {
            return Err(invalid_response());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}
impl CloudflareClient {
    pub async fn new(input: &ProvisionInput, state: &ProvisionState) -> Result<Self, AppError> {
        crate::cloudflare::validate_input(input)?;
        let result = Self {
            client: client()?,
            account_id: input.account_id.clone(),
            service_id: state.profile.service_id.clone(),
            token: Zeroizing::new(input.api_token.clone()),
            artifact: ServiceArtifact::bundled()?,
        };
        result
            .call(
                Method::GET,
                &format!("/accounts/{}", result.account_id),
                None,
            )
            .await?;
        Ok(result)
    }
    async fn healthchecks_request(
        &self,
        key: &str,
        suffix: &str,
        body: Option<Value>,
    ) -> Result<Value, AppError> {
        let mut request = self
            .client
            .request(
                if body.is_some() {
                    Method::POST
                } else {
                    Method::GET
                },
                format!("https://healthchecks.io/api/v3/{suffix}"),
            )
            .header("X-Api-Key", key);
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().await.map_err(|_| {
            AppError::new(
                "HEALTHCHECKS_SETUP",
                "تعذر تجهيز Healthchecks. أعد المحاولة لاستكمال الفحوص نفسها.",
            )
        })?;
        if !response.status().is_success() {
            return Err(AppError::new(
                "HEALTHCHECKS_SETUP",
                "راجع مفتاح Healthchecks والمنطقة الزمنية وصلاحية إدارة الفحوص.",
            ));
        }
        serde_json::from_slice(&bounded_body(response, 131072).await?)
            .map_err(|_| AppError::new("HEALTHCHECKS_SETUP", "استجابة Healthchecks غير صالحة."))
    }
    pub async fn configure_monitoring(
        &self,
        state: &ProvisionState,
        management_key: &str,
        time_zone: &str,
    ) -> Result<Value, AppError> {
        if management_key.is_empty()
            || management_key.len() > 1024
            || time_zone.is_empty()
            || time_zone.len() > 100
        {
            return Err(AppError::new(
                "INVALID_MONITORING",
                "راجع مفتاح Healthchecks والمنطقة الزمنية.",
            ));
        }
        let worker = state.worker_name();
        if !self
            .worker_tags(&worker)
            .await?
            .is_some_and(|tags| tags.contains(&state.owner_tag()))
        {
            return Err(AppError::new(
                "RESOURCE_NOT_OWNED",
                "خدمة Cloudflare لا تحمل علامة ملكية هذا الإعداد.",
            ));
        }
        let channels = self
            .healthchecks_request(management_key, "channels/", None)
            .await?;
        let emails: Vec<&str> = channels["channels"]
            .as_array()
            .ok_or_else(invalid_response)?
            .iter()
            .filter(|channel| channel["kind"] == "email")
            .filter_map(|channel| channel["id"].as_str())
            .collect();
        let mut pings = Vec::new();
        for kind in ["heartbeat", "daily"] {
            let slug = format!("mawjivo-{}-{kind}", state.profile.service_id);
            let found = self
                .healthchecks_request(management_key, &format!("checks/?slug={slug}"), None)
                .await?;
            if found["checks"]
                .as_array()
                .ok_or_else(invalid_response)?
                .iter()
                .any(|check| {
                    !check["tags"]
                        .as_str()
                        .unwrap_or("")
                        .split_whitespace()
                        .any(|tag| tag == state.profile.service_id)
                })
            {
                return Err(AppError::new(
                    "RESOURCE_NOT_OWNED",
                    "يوجد فحص Healthchecks بالاسم نفسه دون علامة ملكية الخدمة.",
                ));
            }
            let mut body = json!({"name":format!("Mawjivo {} {kind}",state.profile.service_id),"slug":slug,"tags":format!("mawjivo {}",state.profile.service_id),"channels":emails.join(","),"unique":["slug"],"methods":"POST"});
            if kind == "heartbeat" {
                body["timeout"] = json!(300);
                body["grace"] = json!(600);
            } else {
                body["schedule"] = json!("0 0 * * *");
                body["tz"] = json!(time_zone);
                body["grace"] = json!(900);
            }
            let check = self
                .healthchecks_request(management_key, "checks/", Some(body))
                .await?;
            let ping = check["ping_url"]
                .as_str()
                .filter(|url| url.starts_with("https://hc-ping.com/"))
                .ok_or_else(invalid_response)?;
            let identifier = ping.strip_prefix("https://hc-ping.com/").unwrap();
            if uuid::Uuid::parse_str(identifier).is_err() {
                return Err(invalid_response());
            }
            pings.push(ping.to_string());
        }
        for (name, value) in [
            ("HEARTBEAT_PING_URL", pings[0].as_str()),
            ("DAILY_PING_URL", pings[1].as_str()),
            ("MONITOR_TIME_ZONE", time_zone),
        ] {
            self.call(
                Method::PUT,
                &self.account_path(&format!("/workers/scripts/{worker}/secrets")),
                Some(json!({"name":name,"text":value,"type":"secret_text"})),
            )
            .await?;
        }
        Ok(
            json!([{"code":"HEALTHCHECKS","state":if emails.is_empty(){"needsAction"}else{"ready"},"messageAr":if emails.is_empty(){"أُعدت الفحوص. أضف تكامل البريد في Healthchecks ثم أعد التجهيز."}else{"تم تجهيز مراقبة الخدمة والملخص على البريد."}}]),
        )
    }
    fn account_path(&self, path: &str) -> String {
        format!("/accounts/{}{}", self.account_id, path)
    }
    async fn send(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<Response, AppError> {
        let mut request = self
            .client
            .request(
                method,
                format!("https://api.cloudflare.com/client/v4{path}"),
            )
            .bearer_auth(self.token.as_str());
        if let Some(body) = body {
            request = request.json(&body)
        }
        request.send().await.map_err(|_| {
            AppError::new(
                "NETWORK",
                "تعذر الوصول إلى Cloudflare. تحقق من الاتصال ثم أعد المحاولة.",
            )
        })
    }
    async fn json_response(&self, response: Response) -> Result<Value, AppError> {
        if !response.status().is_success() {
            return Err(api_error(response.status().as_u16()));
        }
        let envelope: Value = serde_json::from_slice(&bounded_body(response, 4_194_304).await?)
            .map_err(|_| invalid_response())?;
        if envelope.get("success").and_then(Value::as_bool) != Some(true) {
            return Err(invalid_response());
        }
        envelope.get("result").cloned().ok_or_else(invalid_response)
    }
    async fn call(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<Value, AppError> {
        self.json_response(self.send(method, path, body).await?)
            .await
    }
    async fn query(
        &self,
        database: &str,
        sql: &str,
        params: Vec<String>,
    ) -> Result<Value, AppError> {
        let result = self
            .call(
                Method::POST,
                &self.account_path(&format!("/d1/database/{database}/query")),
                Some(json!({"sql":sql,"params":params})),
            )
            .await?;
        if !result.as_array().is_some_and(|parts| {
            !parts.is_empty() && parts.iter().all(|part| part["success"] == true)
        }) {
            return Err(invalid_response());
        }
        Ok(result)
    }
    async fn assert_database_owner(&self, id: &str) -> Result<(), AppError> {
        let result = self
            .query(
                id,
                "SELECT service_id FROM mawjivo_owner WHERE singleton=1",
                vec![],
            )
            .await
            .map_err(|_| {
                AppError::new(
                    "RESOURCE_NOT_OWNED",
                    "قاعدة البيانات موجودة دون علامة ملكية مطابقة. لم تُعدل.",
                )
            })?;
        if result[0]["results"][0]["service_id"] != self.service_id {
            return Err(AppError::new(
                "RESOURCE_NOT_OWNED",
                "قاعدة البيانات مرتبطة بخدمة أخرى. لم تُعدل.",
            ));
        }
        Ok(())
    }
    async fn migrate(&self, id: &str) -> Result<(), AppError> {
        self.assert_database_owner(id).await?;
        self.query(id,"CREATE TABLE IF NOT EXISTS mawjivo_migrations(name TEXT PRIMARY KEY,sha256 TEXT NOT NULL)",vec![]).await?;
        for migration in &self.artifact.migrations {
            let existing = self
                .query(
                    id,
                    "SELECT sha256 FROM mawjivo_migrations WHERE name=?",
                    vec![migration.name.clone()],
                )
                .await?;
            if let Some(hash) = existing[0]["results"][0]["sha256"].as_str() {
                if hash != migration.sha256 {
                    return Err(AppError::new(
                        "MIGRATION_MISMATCH",
                        "إصدار قاعدة البيانات لا يطابق حزمة الخدمة. استعد النسخة الصحيحة قبل المتابعة.",
                    ));
                }
                continue;
            }
            // Initial DDL is idempotent so a partial REST batch can safely resume.
            let sql = format!(
                "{}\nINSERT INTO mawjivo_migrations(name,sha256) VALUES('{}','{}');",
                migration.source, migration.name, migration.sha256
            );
            self.query(id, &sql, vec![]).await?;
        }
        self.query(id,"INSERT INTO service_settings(key,value_json,updated_at_ms) VALUES('owner_service_id',?,0) ON CONFLICT(key) DO NOTHING",vec![serde_json::to_string(&self.service_id).map_err(|_|invalid_response())?]).await?;
        Ok(())
    }
    async fn attach_domain(&self, domain: &str, zone: &str, worker: &str) -> Result<(), AppError> {
        if domain.len() > 253
            || !domain.contains('.')
            || !domain
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'.')
            || zone.len() != 32
            || !zone.bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err(AppError::new(
                "INVALID_DOMAIN",
                "راجع النطاق الفرعي ومعرف المنطقة.",
            ));
        }
        let zone_info = self
            .call(Method::GET, &format!("/zones/{zone}"), None)
            .await?;
        if zone_info["account"]["id"] != self.account_id {
            return Err(AppError::new(
                "INVALID_DOMAIN",
                "النطاق لا ينتمي لحساب Cloudflare المحدد.",
            ));
        }
        let zone_name = zone_info["name"].as_str().ok_or_else(invalid_response)?;
        if !domain.ends_with(&format!(".{zone_name}")) {
            return Err(AppError::new(
                "INVALID_DOMAIN",
                "استخدم نطاقًا فرعيًا داخل المنطقة المحددة.",
            ));
        }
        let domains = self
            .call(Method::GET, &self.account_path("/workers/domains"), None)
            .await?;
        if let Some(existing) = domains
            .as_array()
            .ok_or_else(invalid_response)?
            .iter()
            .find(|item| item["hostname"] == domain)
        {
            if existing["service"] == worker {
                return Ok(());
            }
            return Err(AppError::new(
                "RESOURCE_NOT_OWNED",
                "النطاق الفرعي مستخدم بواسطة خدمة أخرى. لم يُعدل.",
            ));
        }
        let records = self
            .call(
                Method::GET,
                &format!("/zones/{zone}/dns_records?name={domain}"),
                None,
            )
            .await?;
        if !records.as_array().ok_or_else(invalid_response)?.is_empty() {
            return Err(AppError::new(
                "RESOURCE_NOT_OWNED",
                "النطاق الفرعي له سجل DNS موجود. اختر نطاقًا فرعيًا جديدًا.",
            ));
        }
        self.call(
            Method::PUT,
            &self.account_path("/workers/domains"),
            Some(json!({"hostname":domain,"service":worker,"zone_id":zone,"enabled":true})),
        )
        .await?;
        Ok(())
    }
}
#[async_trait]
impl ProvisionApi for CloudflareClient {
    async fn worker_tags(&self, name: &str) -> Result<Option<Vec<String>>, AppError> {
        let response = self
            .send(
                Method::GET,
                &self.account_path(&format!("/workers/scripts/{name}/settings")),
                None,
            )
            .await?;
        if response.status() == 404 {
            return Ok(None);
        }
        let result = self.json_response(response).await?;
        Ok(Some(
            result["tags"]
                .as_array()
                .map(|tags| {
                    tags.iter()
                        .filter_map(|tag| tag.as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_default(),
        ))
    }
    async fn database(&self, name: &str, known_id: Option<&str>) -> Result<String, AppError> {
        if let Some(id) = known_id {
            self.assert_database_owner(id).await?;
            return Ok(id.into());
        }
        for page in 1..=20 {
            let found = self
                .call(
                    Method::GET,
                    &self.account_path(&format!(
                        "/d1/database?name={name}&per_page=100&page={page}"
                    )),
                    None,
                )
                .await?;
            let databases = found.as_array().ok_or_else(invalid_response)?;
            if let Some(existing) = databases.iter().find(|db| db["name"] == name) {
                let id = existing["uuid"].as_str().ok_or_else(invalid_response)?;
                self.assert_database_owner(id).await?;
                return Ok(id.into());
            }
            if databases.len() < 100 {
                break;
            }
            if page == 20 {
                return Err(AppError::new(
                    "RESOURCE_LIST_TOO_LARGE",
                    "تعذر التأكد من موارد الحساب. ضيق نطاق رمز Cloudflare ثم أعد المحاولة.",
                ));
            }
        }
        let database = self
            .call(
                Method::POST,
                &self.account_path("/d1/database"),
                Some(json!({"name":name})),
            )
            .await?;
        let id = database["uuid"].as_str().ok_or_else(invalid_response)?;
        self.query(id,"CREATE TABLE mawjivo_owner(singleton INTEGER PRIMARY KEY CHECK(singleton=1),service_id TEXT NOT NULL);INSERT INTO mawjivo_owner(singleton,service_id) VALUES(1,?);",vec![self.service_id.clone()]).await?;
        Ok(id.into())
    }
    async fn bucket(&self, name: &str, _known: bool) -> Result<(), AppError> {
        let path = self.account_path(&format!("/r2/buckets/{name}"));
        let exists = self.send(Method::GET, &path, None).await?;
        if exists.status() == 404 {
            self.call(
                Method::POST,
                &self.account_path("/r2/buckets"),
                Some(json!({"name":name})),
            )
            .await?;
            let response = self
                .client
                .put(format!(
                    "https://api.cloudflare.com/client/v4{path}/objects/mawjivo%2Fowner-service-id"
                ))
                .bearer_auth(self.token.as_str())
                .header("Content-Type", "text/plain")
                .body(self.service_id.clone())
                .send()
                .await
                .map_err(|_| api_error(0))?;
            self.json_response(response).await?;
        } else {
            self.json_response(exists).await?;
            let marker = self
                .send(
                    Method::GET,
                    &format!("{path}/objects/mawjivo%2Fowner-service-id"),
                    None,
                )
                .await?;
            if !marker.status().is_success() {
                return Err(AppError::new(
                    "RESOURCE_NOT_OWNED",
                    "حاوية الوسائط موجودة دون علامة ملكية مطابقة. لم تُعدل.",
                ));
            }
            if bounded_body(marker, 1024).await? != self.service_id.as_bytes() {
                return Err(AppError::new(
                    "RESOURCE_NOT_OWNED",
                    "حاوية الوسائط مرتبطة بخدمة أخرى. لم تُعدل.",
                ));
            }
        }
        Ok(())
    }
    async fn deploy(
        &self,
        state: &ProvisionState,
        device_token: &str,
        encryption_key: &str,
        input: &ProvisionInput,
    ) -> Result<String, AppError> {
        let database = state.database_id.as_deref().ok_or_else(invalid_response)?;
        self.migrate(database).await?;
        let hash = sha256(device_token);
        self.query(database,"INSERT INTO devices(id,token_hash,allowed_workspace_ids,created_at_ms) VALUES(?,?,'\"*\"',0) ON CONFLICT(id) DO NOTHING",vec![state.profile.id.clone(),hash.clone()]).await?;
        let current = self
            .query(
                database,
                "SELECT token_hash,revoked_at_ms FROM devices WHERE id=?",
                vec![state.profile.id.clone()],
            )
            .await?;
        if current[0]["results"][0]["token_hash"] != hash
            || !current[0]["results"][0]["revoked_at_ms"].is_null()
        {
            return Err(AppError::new(
                "DEVICE_REVOKED",
                "مفتاح هذا الجهاز تغير أو أُلغي. أعد ربط الجهاز بمفتاح جديد.",
            ));
        }
        let worker = state.worker_name();
        let bucket = format!("{worker}-media");
        let mut bindings = vec![
            json!({"name":"DB","type":"d1","id":database}),
            json!({"name":"MEDIA","type":"r2_bucket","bucket_name":bucket}),
            json!({"name":"SERVICE_ID","type":"plain_text","text":self.service_id}),
            json!({"name":"SERVICE_VERSION","type":"plain_text","text":self.artifact.version}),
            json!({"name":"R2_ACCOUNT_ID","type":"plain_text","text":self.account_id}),
            json!({"name":"MEDIA_BUCKET","type":"plain_text","text":bucket}),
            json!({"name":"SERVICE_ENCRYPTION_KEY","type":"secret_text","text":encryption_key}),
            json!({"name":"R2_ACCESS_KEY_ID","type":"secret_text","text":input.r2_access_key_id}),
            json!({"name":"R2_SECRET_ACCESS_KEY","type":"secret_text","text":input.r2_secret_access_key}),
        ];
        if let Some(class) = &self.artifact.workflow_class {
            bindings.push(json!({"name":"PUBLISH","type":"workflow","workflow_name":format!("{worker}-publish"),"class_name":class}));
        }
        let metadata = worker_upload_metadata(&self.artifact, state, bindings);
        let mut form = multipart::Form::new().part(
            "metadata",
            multipart::Part::text(metadata.to_string())
                .mime_str("application/json")
                .map_err(|_| invalid_response())?,
        );
        for module in &self.artifact.modules {
            form = form.part(
                module.name.clone(),
                multipart::Part::text(module.source.clone())
                    .file_name(module.name.clone())
                    .mime_str("application/javascript+module")
                    .map_err(|_| invalid_response())?,
            );
        }
        // Recheck ownership immediately before replacing script/config.
        if self
            .worker_tags(&worker)
            .await?
            .is_some_and(|tags| !tags.contains(&state.owner_tag()))
        {
            return Err(AppError::new(
                "RESOURCE_NOT_OWNED",
                "خدمة Cloudflare لا تحمل علامة الملكية المطلوبة.",
            ));
        }
        let response = self
            .client
            .put(format!(
                "https://api.cloudflare.com/client/v4{}",
                self.account_path(&format!("/workers/scripts/{worker}"))
            ))
            .bearer_auth(self.token.as_str())
            .multipart(form)
            .send()
            .await
            .map_err(|_| api_error(0))?;
        self.json_response(response).await?;
        if let Some(class) = &self.artifact.workflow_class {
            self.call(
                Method::PUT,
                &self.account_path(&format!("/workflows/{worker}-publish")),
                Some(json!({"class_name":class,"script_name":worker})),
            )
            .await?;
        }
        if !self.artifact.cron_triggers.is_empty() {
            let schedules: Vec<Value> = self
                .artifact
                .cron_triggers
                .iter()
                .map(|cron| json!({"cron":cron}))
                .collect();
            self.call(
                Method::PUT,
                &self.account_path(&format!("/workers/scripts/{worker}/schedules")),
                Some(json!(schedules)),
            )
            .await?;
        }
        let base_url = if let (Some(domain), Some(zone)) = (&input.domain, &input.zone_id) {
            self.attach_domain(domain, zone, &worker).await?;
            format!("https://{domain}")
        } else {
            self.call(
                Method::POST,
                &self.account_path(&format!("/workers/scripts/{worker}/subdomain")),
                Some(json!({"enabled":true,"previews_enabled":false})),
            )
            .await?;
            let subdomain = self
                .call(Method::GET, &self.account_path("/workers/subdomain"), None)
                .await?;
            let name = subdomain["subdomain"]
                .as_str()
                .filter(|name| !name.is_empty())
                .ok_or_else(|| {
                    AppError::new(
                        "WORKERS_SUBDOMAIN_MISSING",
                        "فعّل عنوان workers.dev لحسابك أو أدخل نطاقًا خاصًا.",
                    )
                })?;
            format!("https://{worker}.{name}.workers.dev")
        };
        let response = self
            .client
            .post(format!("{base_url}/api/service/initialize"))
            .bearer_auth(device_token)
            .send()
            .await
            .map_err(|_| api_error(0))?;
        if !response.status().is_success() {
            let failure: AppError = serde_json::from_slice(&bounded_body(response, 65_536).await?)
                .map_err(|_| invalid_response())?;
            return Err(failure);
        }
        let _: Value = serde_json::from_slice(&bounded_body(response, 65_536).await?)
            .map_err(|_| invalid_response())?;
        Ok(base_url)
    }
}
pub fn worker_upload_metadata(
    artifact: &ServiceArtifact,
    state: &ProvisionState,
    bindings: Vec<Value>,
) -> Value {
    json!({"main_module":artifact.main_module,"compatibility_date":artifact.compatibility_date,"compatibility_flags":artifact.compatibility_flags,"bindings":bindings,"tags":[state.owner_tag()],"observability":{"enabled":true,"head_sampling_rate":0.1}})
}
