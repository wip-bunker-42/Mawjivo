# نقل إعدادات Mawjivo — خطة التنفيذ

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** يستطيع المستخدم تصدير إعداداته وكريدنشلز خدمته إلى ملف واضح ثم استيراده على جهاز جديد متصل بنفس الخدمة والحسابات.

**Architecture:** محرك Rust يقرأ الملف ويحفظه ويتحقق من الخدمة عبر عميل Cloudflare الحالي، ويحافظ على المعرفات الأصلية. تجلب الواجهة أحدث المساحات من الخدمة بعد إضافة الربط المحلي. تتولى وحدة النقل وظائف الملف والفحص والحفظ، وتبقى أسرار الملف خارج React وIPC.

**Tech Stack:** Tauri 2.12.2، Rust 1.99.0، React/TypeScript الحالية، Node 24.21.0، pnpm 12.11.2، و`aes-gcm = "=0.11.1"` لفك AES-GCM المحلي. تحققت بيانات crates.io من أن هذا الإصدار مستقر ويتطلب Rust 1.85؛ لا تضاف اعتماديات أخرى للنقل.

**Spec:** [المواصفة المعتمدة](../specs/2026-10-13-mawjivo-portability-and-release-design.md).

**Execution:** تنفيذ مباشر في الجلسة باستخدام `superpowers:executing-plans`، استمرارًا لطريقة المشروع. تنفذ هذه الخطة أولًا، ثم [خطة الإصدارات](2026-10-13-mawjivo-automated-releases.md). لا يبدأ تنفيذ أي منهما قبل مراجعة المستخدم لهما.

## Global Constraints

- ملفات `.secrets.env` واضحة بلا كلمة مرور أو تشفير إضافي؛ حد ملف الجهاز `2 MiB` وصيغته `MAWJIVO_DEVICE_EXPORT_SCHEMA=1`.
- قبول ملف المالك الحالي ذي `MAWJIVO_SERVICE_PROFILE_JSON` المفرد، والتصدير الجديد بمصفوفة `MAWJIVO_SERVICE_PROFILES_JSON`.
- لا نشر اجتماعي أو رفع وسائط أو إنشاء/ترقية موارد Cloudflare عند الاستيراد والتصدير.
- إعادة استخدام معرفات الخدمة والمساحات؛ الإعدادات السحابية الحالية تتقدم على نسخة الملف.
- لا قيم أسرار في React أو IPC أو السجلات أو الحزمة أو Git. لا يدخل مفتاح توقيع المشروع في تصدير الجهاز.
- تستخدم صفحة النقل أسماء عربية وأزرار HTML أصلية؛ لا انتقال تلقائي للتركيز أو إعلان متكرر.
- تبقى Task 16 وشروط NVDA والتسليم الأصلي مفتوحة؛ لا يتغير الفرع الافتراضي ولا تفعّل هذه الخطة إنتاجًا.

## Review Focus

1. ملف المالك القديم مع حساب Meta مشترك لفيسبوك وإنستقرام يجب أن يبقى ربطًا واحدًا؛ يثبت في Task 1 وTask 4.
2. ملف صالح أُضيفت إليه وجهة HTTPS أجنبية يجب ألا يستلم مفتاح الجهاز؛ يثبت في Task 2.
3. تعطل الخزنة بعد إضافة أول سر، أو تكرار العملية بعد انقطاعها، يجب ألا يظهر تعريف نصف مستورد؛ يثبت في Task 3.
4. تعديل فئة يوتيوب أو الحساب المفضل على الجهاز القديم بعد التصدير يجب أن يظهر على الجهاز الجديد؛ يثبت في Task 3 وTask 4.
5. فقد خدمة واحدة ضمن عدة خدمات يجب ألا ينتج ملف نجاح ناقصًا أو تغييرًا محليًا جزئيًا؛ يثبت في Task 2 وTask 3.

## خريطة الملفات والواجهات

- `apps/desktop/src-tauri/src/transfer/mod.rs`: الأنواع العامة وحدود النقل؛ `format.rs`: ENV والفحص؛ `live.rs`: القراءة والتحقق وفك التشفير؛ `operations.rs`: تنسيق التصدير والاستيراد؛ `commands.rs`: مربع الملف واستدعاءات Tauri.
- `profiles.rs`: حفظ تعريفات المجموعة في معاملة واحدة. `vault.rs`: حذف القيم الجديدة عند فشل الاستيراد. `cloudflare_api.rs`: قراءة محدودة لملكية الخدمة وبيانات D1 والعنوان، دون استدعاء وظائف الإنشاء.
- `apps/desktop/src/features/settings/TransferPage.tsx`: التدفق العربي؛ `bridge.ts` و`App.tsx`: النتائج المنقحة وتحديث الخدمات والمساحات.
- `tests/transfer.rs` واختبارات الواجهة: اختبارات المعنى والفشل. تظل ملفات المالك الفعلية محلية ومستبعدة من Git.

### Task 1: صيغة النقل وتوافق الملفات

**Files:** Create `apps/desktop/src-tauri/src/transfer/mod.rs`, `transfer/format.rs`, `tests/transfer.rs`, `tests/support/transfer.rs`. Modify `apps/desktop/src-tauri/src/lib.rs`.

**Interfaces:**

- `TransferBundle { exported_at: String, services: Vec<ServiceTransfer> }`.
- `ServiceTransfer { state: ProvisionState, secrets: BTreeMap<String,String>, snapshot: TransferSnapshot }`.
- `TransferSnapshot { workspaces: Vec<serde_json::Value>, connections: Vec<serde_json::Value>, telegram: Vec<serde_json::Value> }`؛ تفحص معرفات السجلات وعلاقاتها، وتحفظ بقية تفضيلات المساحة دون إسقاط فئة يوتيوب التي لا تحتويها `contracts::Workspace` الحالية.
- `TransferSummary { services: u32, workspaces: u32, connections: u32 }`، مسلسلة بصيغة camelCase؛ هذا وحده مع التعريفات غير السرية يعبر IPC.
- `parse_env(bytes: &[u8]) -> Result<TransferBundle, AppError>` و`serialize_env(bundle: &TransferBundle) -> Result<Vec<u8>, AppError>`.
- مساعدا الاختبار `fixture_bundle(count: usize) -> TransferBundle` و`legacy_env(bundle: &TransferBundle) -> Vec<u8>` ينتجان بيانات مصطنعة؛ لا يقرآن ملفات المالك ولا يستعملان serializer الإنتاج لبناء الحالة القديمة.

- [x] **Step 1 — RED:** أضف الاختبارات التالية إلى `tests/transfer.rs`:

```rust
let old = parse_env(&legacy_env(&fixture_bundle(1))).unwrap();
assert_eq!(old.services.len(), 1);
assert_eq!(old.services[0].snapshot.connections.len(), 3);
let many = parse_env(&serialize_env(&fixture_bundle(2)).unwrap()).unwrap();
assert_eq!(many.services.len(), 2);
```

أضف `rejects_duplicate_env_keys`, `rejects_files_over_two_mib`, `rejects_foreign_vault_references`, و`ignores_project_signing_fields`؛ تثبت الأخيرة أن مفاتيح التوقيع لا تدخل `services[*].secrets`. تثبت حالة تضارب الحقل المفرد والمصفوفة الرفض، وتحفظ حالة round-trip أسماء عربية وJSON يحتوي علامات اقتباس و`=`.

- [x] **Step 2:** شغّل `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked --test transfer`؛ يتوقع فشل بسبب غياب واجهة النقل، لا فشل تجهيز أداة Rust.
- [x] **Step 3 — GREEN:** نفذ الصيغة المحددة بالمواصفة. افحص الحد قبل JSON، وارفض المفاتيح المكررة ونسخة غير `1` وعلاقات المعرفات الغامضة. احصر مراجع الخزنة في `device/encryption/cloudflare/r2-access/r2-secret/healthchecks` تحت معرف كل خدمة. لا تشتق `Debug` للأنواع التي تحمل أسرارًا. انقل البدائل المفردة المعروفة إلى التمثيل العام دون تنفيذ قيمها.
- [x] **Step 4:** أعد نفس أمر الاختبار، ثم `cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --check`؛ يتوقع النجاح.
- [x] **Step 5:** احفظ commit مستقل: `feat: define portable settings format with legacy compatibility`.

### Task 2: القراءة الحية وملكية الخدمة والتشفير

**Files:** Create `apps/desktop/src-tauri/src/transfer/live.rs`. Modify `cloudflare_api.rs`, `Cargo.toml`, `Cargo.lock`, و`tests/transfer.rs`. Create `tests/fixtures/transfer-aes-gcm.json` ببيانات مصطنعة مولدة باستخدام Web Crypto وسياق خدمة Mawjivo الحالي.

**Interfaces:**

- `#[async_trait] trait TransferSource: Send + Sync { async fn inspect(&self, state: &ProvisionState, secrets: &BTreeMap<String,String>) -> Result<ServiceTransfer, AppError>; }`.
- `CloudflareTransferSource` ينفذ الواجهة ويعيد تعريفًا مثبت الملكية ونسخة الحسابات الحالية؛ يستخدم عميل الإدارة الموجود ولا يستدعي `provision_with` أو `deploy` أو `bucket` أو `database`.
- `decrypt_connection(cipher: &str, key_base64: &str, workspace_id: &str, connection_id: &str, key_version: u64) -> Result<serde_json::Value, AppError>`؛ سياق AAD هو JSON للمصفوفة `[workspaceId,connectionId,keyVersion]` كما في `apps/service/src/secrets.ts`.

- [x] **Step 1 — RED:** أضف `decrypts_service_web_crypto_envelope`, `rejects_wrong_aad_or_key`, `foreign_base_url_receives_no_device_bearer`, `revoked_device_is_rejected`, `scopes_accounts_to_allowed_workspaces`, و`unavailable_profile_does_not_return_partial_export`. تثبت حالة القراءة صفر استدعاءات إنشاء أو ترقية وصفر طلبات Meta/Buffer. تسجل بدائل الشبكة الوجهة قبل إرسال Authorization لتثبت غياب الطلب للأجنبي.

```rust
assert!(decrypt_connection(&tampered_cipher, &key, &ws, &id, 1).is_err());
assert_eq!(captured_foreign_bearer_requests.len(), 0);
assert_eq!(captured_resource_mutations.len(), 0);
assert_eq!(exported_allowed_workspace_ids, device_allowed_workspace_ids);
assert!(unavailable_profile_export.is_err());
```

- [x] **Step 2:** شغّل `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --test transfer` لتسجيل فشل السلوك الجديد، ثم أضف `aes-gcm` بالإصدار المثبت أعلاه فقط ونفذ الحد الأدنى للوحدات. يحدّث Cargo ملف القفل عند إضافة الاعتمادية، ثم تستخدم `--locked` في التحقق اللاحق.
- [x] **Step 3 — GREEN:** افحص علامات Worker وD1 وR2 أولًا. أثبت custom domain من ربط Cloudflare الفعلي، أو أثبت workers.dev من subdomain الحساب. اقرأ سجل الجهاز ورفض الإلغاء ونطاقه؛ لا ترسل bearer إلى عنوان الملف قبل إثباته، ولا تتبع redirect. اقرأ الحسابات وتليجرام باستعلامات SELECT مقيدة بمعرفات المساحات، وفك البيانات بـAES-GCM مع nonce بطول 12 بايت ومفتاح بطول 32 بايت ونسخة المفتاح المعتمدة. افحص جميع نتائج الخدمات، وأعد أحدث إعدادات المساحات من الخدمة.
- [x] **Step 4:** شغّل اختبار `transfer` بـ`--locked` ثم `pnpm check:secrets` و`cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --locked --all-targets --all-features -- -D warnings`؛ يتوقع النجاح. لا تطبع ciphertext أو plaintext عند فشل التحقق.
- [x] **Step 5:** احفظ commit: `feat: verify and read owned settings for portable export`.

### Task 3: حفظ الملف واستيراد المجموعة بصورة متسقة

**Files:** Create `transfer/operations.rs`, `transfer/commands.rs`. Modify `profiles.rs`, `vault.rs`, `lib.rs`, ومساعدات `tests/transfer.rs` وVault mocks الحالية في اختبارات Rust.

**Interfaces:**

- `Vault::delete(reference: &str) -> Result<(), AppError>`؛ يستخدم `SystemVault` واجهة `delete_credential` الموجودة في keyring 4.2.0.
- `LocalStore::import_states(states: &[ProvisionState]) -> Result<(), AppError>`: يضيف الجديد في معاملة واحدة، ويتحقق من عدم تعارض الموجود.
- `export_to(source: &dyn TransferSource, vault: &dyn Vault, store: &LocalStore, path: &Path) -> Result<TransferSummary, AppError>`.
- `import_from(source: &dyn TransferSource, vault: &dyn Vault, store: &LocalStore, path: &Path) -> Result<(TransferSummary, Vec<ServiceProfile>), AppError>`.
- أمران `export_settings` و`import_settings` يفتحان مربع الملف داخل Rust، ويعيدان `Result<Option<TransferSummary>, AppError>`؛ `None` يعني إلغاء. يقرأ App قائمة التعريفات بعد نجاح الاستيراد بدل نقل الأسرار في النتيجة.

- [x] **Step 1 — RED:** أضف `import_twice_keeps_one_profile`, `vault_failure_restores_old_profiles`, `sqlite_failure_removes_only_new_credentials`, `interrupted_matching_vault_entries_can_resume`, `conflicting_profile_is_not_overwritten`, `current_cloud_preferences_win_over_export_snapshot`، و`second_profile_failure_commits_nothing`. في كل حالة فشل قارن التعريفات والمراجع القديمة، وتحقق من عدم وجود مسودة أو منشور سحابي جديد.

```rust
assert_eq!(store.list_states().unwrap().len(), 1); // بعد الاستيراد المكرر
assert_eq!(vault.get(&old_reference).unwrap(), old_value); // عند الفشل
assert_eq!(profiles_after_failed_import, profiles_before);
assert_eq!(live_workspace["defaultYoutubeCategoryId"], "25");
assert_eq!(captured_social_publish_requests.len(), 0);
```

- [x] **Step 2:** شغّل اختبار `transfer` بـ`--locked`؛ يتوقع فشل بسبب غياب عمليات الملف والمعاملة.
- [x] **Step 3 — GREEN:** اقرأ الملف بحد `2 MiB + 1` فعليًا لمنع تغير حجمه بعد فحص metadata. تحقق من جميع الخدمات قبل الحفظ. ارفض المراجع الموجودة ذات القيم المتعارضة، وأضف فقط المراجع الجديدة ثم التعريفات في معاملة واحدة. نظف ما أضيف عند فشل المعاملة، ولا تحذف أسرارًا سبقت العملية. سجل قائمة المراجع الجديدة في ذاكرة العملية فقط؛ لا تحتاج إلى جدول أو بروتوكول مزامنة جديد. استخدم backup SQLite المتسقة الموجودة قبل تغيير قاعدة قائمة. احفظ التصدير مؤقتًا في مجلد الوجهة ثم استبدله، ونظف المؤقتات عند الإلغاء أو الخطأ. تتولى أوامر Tauri قفل الإعداد وحاجز العمليات الحاليين.
- [x] **Step 4:** أعد اختبار `transfer` واختبارات `provision` و`updates` و`composer`؛ يتوقع النجاح دون تغيير سلوك المسودات أو التحديث. أضف assertion إلى اختبار حدود الأوامر يثبت أن JSON النتيجة لا يحمل `secrets` أو `credentials` أو signing key.
- [x] **Step 5:** احفظ commit: `feat: import existing service settings without recreating resources`.

### Task 4: الواجهة وإثبات جهاز جديد وتسليم النقل

**Files:** Create `apps/desktop/src/features/settings/TransferPage.tsx`, `tests/e2e/transfer.spec.ts`, `scripts/accept-settings-transfer.mjs`. Modify `App.tsx`, `bridge.ts`, `src-tauri/src/bin/setup.rs`, `docs/user/recovery.md`, `docs/user/install.md`, `docs/user/development.md`.

**Interfaces:** `exportSettings(): Promise<TransferSummary | null>` و`importSettings(): Promise<TransferSummary | null>` في bridge. تتولى `TransferPage({ onImported: () => void })` النتيجة، ويعيد callback تحميل التعريفات والمساحات دون تغيير صفحة المستخدم أو مسودته. يضيف setup وضع تحقق قراءة فقط `--verify-transfer-file` ووضع قبول نقل معزول `--accept-transfer <directory>`؛ لا يقبل وضع القبول مجلد بيانات المالك الحالي. يستخدم وضع القبول تنفيذ `Vault` داخل operator-tools بخدمة keyring اختبار مستقلة ذات اسم عشوائي، ليبدأ بخزنة نظام فارغة فعلًا دون تغيير مراجع المالك، ثم يزيل المراجع التي أنشأها فقط. لا توزع أداة القبول أو هذه الخيارات في المثبت.

- [x] **Step 1 — RED:** اختبر وجود صفحة النقل في تثبيت فارغ، وترتيب Tab وأسماء الزرين، والإلغاء الصامت، وإعلان النتيجة مرة واحدة، وعدم تغير focus، وقراءة المساحات الحية بعد الاستيراد مع فئة يوتيوب والحساب المفضل الأحدث. لا ترسل mock API طلب كتابة لإعادة حفظ snapshot. اختبر error فيه secret في التفاصيل الداخلية وتثبت الواجهة رسالة عربية منقحة فقط.

```ts
await expect(page.getByRole('button', { name: 'استيراد الإعدادات والحسابات' })).toBeVisible();
await expect(importButton).toBeFocused(); // بعد نجاح الاستيراد
expect(announcedResults).toHaveLength(1);
expect(capturedWorkspaceWrites).toHaveLength(0);
await expect(page.getByText(internalSecret)).toHaveCount(0);
```

- [x] **Step 2:** شغّل `pnpm test:e2e tests/e2e/transfer.spec.ts`؛ يتوقع فشل غياب التدفق.
- [x] **Step 3 — GREEN:** أضف الصفحة في الإعدادات وفي إعداد التثبيت الأول، ووصل أوامر bridge والـcallback، واستخدم `TransferSummary` للعدد. وثق الاتصال بالإنترنت للنقل، وكون الملف واضحًا، وكيفية الاحتفاظ به واستعماله بعد الفورمات، وحدود المسودات المحلية. لا تضف كلمة مرور أو خدمة SaaS أو ربط GitHub.
- [x] **Step 4:** نفذ `pnpm verify` و`pnpm test:e2e` ثم أداة قبول النقل بمجلد SQLite جديد ومراجع خزنة اختبار معزولة. يستخدم `--verify-transfer-file` ملف المالك الفعلي للتحقق من الصيغة والاتصال قراءة فقط. تقارن أداة القبول نفس serviceId وdatabaseId وWorker وR2 وWorkflow ومعرفات المساحات والحسابات والمنشورات؛ ولا تعيد نشر شيء. لا تستبدل قاعدة المالك أو تغلق تطبيقه أثناء القراءة. تسجل دليلًا منقحًا وتزيل بيانات الاختبار المحلية فقط. يظل اختبار NVDA للمستخدم بعد تثبيت المرشح.
- [x] **Step 5:** احفظ commit: `feat: expose accessible settings transfer and prove fresh-device restore`. حدّث حالة هذه الخطة في سجل التقدم، ثم ابدأ خطة الإصدارات المعتمدة؛ لا تدّع اكتمال Task 16.
