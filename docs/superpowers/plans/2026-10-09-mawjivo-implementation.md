# Mawjivo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** تسليم Mawjivo كتطبيق Windows عربي متاح لقارئات الشاشة، ينشر ويجدول على حسابات المستخدم بواسطة Cloudflare، مع مراقبة وتحديثات قابلة للاستخدام.

**Architecture:** تطبيق Tauri يدير الملفات والخزنة والمعالجة والرفع محليًا. قواعد TypeScript مشتركة تحدد المحتوى المؤكد، وخدمة Worker تعتمد على D1 وR2 وWorkflows لتنفيذه بصورة مستقلة عن الجهاز. Telegram وHealthchecks يراقبان النتائج والخدمة، وGitHub Actions يبني الإصدار والتحديث الموقّع.

**Tech Stack:** Tauri 2.12.2، Rust 1.99.0، React 19.3.0، TypeScript 7.0.2، Vite 8.3.4، Node 24.21.0 LTS، pnpm 12.10.1، Wrangler 4.149.0، Vitest 5.0.3 و`@cloudflare/vitest-plugin` 1.4.0، Playwright 1.64.0، FFmpeg 9.0.2.

**Spec:** [المواصفات المعتمدة](C:/chatgpt/Mawjivo1/docs/superpowers/specs/2026-10-09-mawjivo-design.md)، التسجيل `dca68cb` مع تحديث حالة اعتماد الوثيقة فقط في هذا التسجيل.

## Global Constraints

- Windows هو نظام التسليم الأساسي، ثم Linux وmacOS.
- يختبر المستخدم التجربة النهائية بنفسه باستخدام NVDA.
- اللغة `ar` والاتجاه RTL؛ واجهة مظلمة وعناصر HTML أصلية دون نقل تلقائي للتركيز أو إعلان متكرر لتقدم الرفع.
- Facebook وInstagram عبر Meta افتراضيًا. Threads وX وYouTube وTikTok عبر Buffer في الإعداد الحالي.
- YouTube عبر Buffer للـShorts فقط؛ فيديوهات يوتيوب الطويلة خارج نطاق هذه النسخة.
- الجدولة في Cloudflare؛ لا تحفظ مواعيد Mawjivo المستقبلية في طابور Buffer.
- رفع نسخة واحدة لكل أصل أو نتيجة معالجة مختلفة، ثم إعادة استخدام الرابط بين المنصات المناسبة.
- القيمة الافتراضية للجدولة وقت إنشاء صفحة المنشور زائد 10 ساعات؛ المنطقة افتراضيًا `Africa/Cairo`.
- سقف الملفات النشطة المبدئي 9 GB، أي `9_000_000_000` بايت، يشمل ملفات الإصدار المستضافة؛ لا يفترض أن باقي حصة الحساب متاحة.
- تنظف الملفات المرفوعة التي لا ترتبط بمنشور مؤكد بعد 24 ساعة؛ تحذف النسخ المكتملة بعد 48 ساعة؛ يحتفظ الفشل المؤكد 7 أيام؛ لا يحذف مجدول أو غير محسوم تلقائيًا.
- Buffer: 100 طلب خلال 15 دقيقة، و250 خلال 24 ساعة، و3,000 خلال 30 يومًا لكل حساب مجاني؛ النوافذ متحركة والحصتان مستقلتان.
- Workflows المجانية: 3,000 خطوة يوميًا و10 ms CPU للخطوة وفق الوثائق الحالية؛ تختبر المسارات وتراقب الاستخدام.
- نبض Healthchecks كل 5 دقائق ومهلة سماح 10 دقائق؛ تقييم يومي مع مهلة 15 دقيقة.
- لا توجد خدمة SaaS مشتركة؛ كل مستخدم يجهز Cloudflare وحساباته، والمثبت خالٍ من بيانات صاحب المشروع.
- لا يعاد إرسال كتابة ذات نتيجة غير محسومة عميانيًا؛ قبول الموفر منفصل عن النشر النهائي.
- لا تطبق معالجة وسائط على Cloudflare ولا تغير الملفات المصدر محليًا.
- الكريدينشلز المحلية في خزنة النظام، وأسرار النشر السحابية مشفرة؛ لا قيم أسرار في Git أو السجلات أو بيانات البناء.
- النجاح النهائي تنزيل التطبيق واستخدامه؛ لا تكفي محاكاة المنصات أو اكتمال البناء.

## Review Focus

1. أسماء عربية طويلة تحتوي محارف Windows المحجوزة أو إيموجي مركبة: يظل العنوان محفوظًا ويصبح اسم الإرسال صالحًا دون تقسيم الحروف؛ اختبارات المهمتين 2 و6.
2. تغيير الملف أو حذفه أثناء رفع مجزأ: توقف الرفع المتأثر، ولا تعتمد بايتات من إصدارين، وتحرر الحجز؛ اختبار المهمة 8.
3. وقت جدولة يقع في فجوة أو تكرار التوقيت الصيفي: يرفض الوقت غير الموجود ويطلب تحديد الإزاحة للوقت المكرر، وتبقى +10 ساعات محسوبة من اللحظة الفعلية؛ المهمتان 2 و11.
4. امتلاء القرص أو إلغاء FFmpeg في منتصف المعالجة: رسالة إصلاح قصيرة، حذف الناتج الجزئي فقط، وبقاء الأصل؛ اختبار المهمة 6.
5. تحديث تالف أو فشل ترحيل قاعدة محلية: رفض التوقيع/استعادة النسخة السابقة، مع بقاء المسودات والكريدينشلز؛ اختبار المهمة 15.

---

## 1. الإصدارات ومصدرها

فحوص التخطيط بتاريخ 9 أكتوبر 2026 كانت قراءة فقط من npm وcrates.io ومستودعات المصادر الرسمية. تعاد المقارنة عند تنفيذ المهمة 1؛ ترقية إصلاح متوافقة مقبولة، وأي تغير واجهة يؤثر في الخطة يسجل ويختبر قبل اعتماده.

| الاعتماد | الإصدار المبدئي |
| --- | --- |
| `@tauri-apps/api` / `@tauri-apps/cli` / `tauri-build` | 2.12.2 / 2.12.1 / 2.7.1 |
| Tauri Updater، JS وRust | 2.13.2 |
| Tauri Dialog / Process / Single Instance، Rust | 2.8.1 / 2.4.0 / 2.5.2؛ Single Instance موصل Rust ولا تضاف له حزمة JS غير موجودة |
| `@vitejs/plugin-react` / أنواع React | 6.1.2 / 19.3.0 |
| `@axe-core/playwright` / Zod | 4.13.0 / 4.6.5 |
| `aws4fetch` / `twitter-text` / Temporal polyfill | 1.0.20 / 3.1.0 / 0.5.1 |
| `keyring` / `rusqlite` / `reqwest` / `image` | 4.2.0 / 0.40.2 / 0.13.5 / 0.25.10 |
| `tokio` / `serde` / `serde_json` | 1.53.2 / 1.0.229 / 1.0.151 |
| `uuid` / `sha2` / `zeroize` | 1.27.0 / 0.11.0 / 1.9.1 |

يتوافق Vitest 5 مع peerDependencies الخاصة بـ`@cloudflare/vitest-plugin` 1.4.0. لا تستخدم حزمة `@cloudflare/vitest-pool-workers` القديمة. يبدأ Graph API بإصدار `v26.0` المثبت في إعداد SDK الرسمي 26.0.2؛ نجحت قراءة الصفحة وحساب Instagram به، ويظل نشر الفيديو خاضعًا لاختبار صلاحياته.

المراجع: [Cloudflare Vitest](https://developers.cloudflare.com/workers/testing/vitest-integration/write-your-first-test/)، [Node LTS](https://nodejs.org/en/about/previous-releases)، [FFmpeg](https://ffmpeg.org/download.html)، [إعداد Meta الرسمي](https://github.com/facebook/facebook-python-business-sdk/blob/26.0.2/facebook_business/apiconfig.py)، [Tauri Updater](https://v2.tauri.app/plugin/updater/).

## 2. خريطة الملفات وحدودها

تفسر جميع مسارات المهام نسبة إلى جذر checkout التنفيذ. يوجد مصدر واحد لكل سياسة وعقد، مع DTOs Rust واختبار تطابق JSON، دون توليد طبقات غير لازمة.

| المسار | المسؤولية |
| --- | --- |
| `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `rust-toolchain.toml`, `tools/dependencies.json` | الإصدارات والسكربتات وبيانات مصادر الأدوات |
| `packages/core/src/{contracts,schemas,policy,time,filenames,plan-hash}.ts` | العقود والتخطيط والحدود والتوقيت والأسماء |
| `apps/desktop/src/{App,bridge}.tsx/ts`, `src/styles.css`, `src/features/` | واجهة عربية وميزات الإعداد والمنشور والإدارة والتحديث |
| `apps/desktop/src-tauri/src/{lib,contracts,error,vault,profiles,drafts,cloudflare,media,upload,windows,updates}.rs` | المحرك المحلي؛ يقسم أي ملف يكبر إلى مجلد بنفس المسؤولية |
| `apps/service/src/{index,auth,secrets,workspaces,connections,assets,posts,monitoring}.ts` | مسارات الخدمة المحدودة والمساحات والسجل |
| `apps/service/src/providers/{types,buffer,meta,rate-budget}.ts` | موصلات المنصات وحصص الطلبات |
| `apps/service/src/workflows/publish.ts` و`src/reports/{telegram,daily}.ts` | تنفيذ الأعمال ومخرجات التقارير |
| `apps/service/migrations/`, `wrangler.jsonc`, `vitest.config.ts` | مخطط D1 وربط الموارد واختبار Workers الفعلي محليًا |
| `tests/e2e/`, `scripts/`, `.github/workflows/` | اختبارات التدفق والبناء والتحقق والتجهيز والإصدار |
| `docs/user/`, `docs/releases/` | تعليمات عربية وأدلة تحقق الإصدار |

الأسماء بين الأقواس خريطة مختصرة فقط؛ كل مهمة أدناه تسمي الملفات الفعلية التي تنتجها. لا تضاف Redux أو إطار UI أو خادم Node أو Queues/DOs في هذه النسخة.

## 3. العقود الأساسية المشتركة

تعرف المهمة 2 الأنواع التالية في `packages/core/src/contracts.ts` وتصدر Zod schemas في `schemas.ts`؛ الحقول في JSON بصيغة camelCase:

- `Platform = 'facebook' | 'instagram' | 'threads' | 'x' | 'youtube' | 'tiktok'`، و`Provider = 'meta' | 'buffer'`، و`ISOInstant = string` صالح في UTC.
- `Workspace`: `id, name, timeZone, version, defaultPlatforms, serviceProfileId`؛ اتصالات الحسابات لها معرفات منفصلة تخص المساحة.
- `MediaAsset`: `id, originalName, kind, bytes, mimeType, sha256?, width?, height?, durationMs?, derivedFrom?`؛ `kind` صورة أو فيديو.
- `Draft`: `id, workspaceId, workspaceVersion, timeZone, revision, text, title, assets, selections: string[], overrides, scheduleLocal, scheduleOffset, createdAt`؛ selections معرفات القنوات، وoverride لكل منصة: `text?, altTexts?, threadParts?`. العنوان مشترك ويظل مطلوبًا للفيديو.
- `CapabilitySnapshot`: `version, fetchedAt, channels`؛ القناة: `id, connectionId, platform, provider, ready, limits`، والحدود تتضمن الأحرف والوسائط والمدة والصيغ والسلاسل والنص البديل، مع مصدر كل قاعدة.
- `AssetUse`: `sourceAssetId, recipeId: string | null`؛ و`MediaRecipe`: `id, sourceAssetId, outputMimeType, maxDurationMs?, maxBytes?, frameMode?, quality?`.
- `TargetPlan`: `channelId, connectionId, platform, provider, text, title?, threadParts, assets: AssetUse[], altTexts`.
- `PostPlan`: `draftId, workspaceId, workspaceVersion, timeZone, revision, policyVersion, capabilityVersion, targets, excluded, mediaRecipes, dueAt, notes`؛ `excluded` سبب لكل قناة، و`notes` رسائل عربية مع كود وحقائق رقمية. يؤخذ capabilityVersion من snapshot؛ تدخل جميع هذه الحقول في hash الموافقة.
- `PreparedAsset`: `sourceAssetId, recipeId, assetId, sha256`؛ `Submission`: `plan, planHash, preparedAssets`، ويجب أن توجد نسخة جاهزة لكل استخدام.
- `PublicationReceipt`: `postId, workspaceId, revision, state, dueAt, targets`؛ `state` وقيم الوجهات وأجزاء السلاسل تطابق حالات القسم 12 من المواصفات.
- `AppError`: `code, messageAr, retryable, details?` بعد تنقيح الأسرار؛ `ReadinessItem`: `code, state, messageAr, action?`.

لا تضيف وظيفة لاحقة نوعًا غير معرف إلى عقد موجود دون تحديث schemas وDTO واختبار العقد في نفس التغيير.

## 4. تسلسل المهام

### Task 1: هيكل قابل للبناء وواجهة عربية بحالة إعداد صادقة

**Files:** إنشاء `package.json`, `pnpm-workspace.yaml`, `.npmrc`, `tsconfig.base.json`, `rust-toolchain.toml`, `tools/dependencies.json`, `apps/desktop/package.json`, `apps/desktop/tsconfig.json`, `apps/desktop/index.html`, `apps/desktop/vite.config.ts`, `apps/desktop/src/App.tsx`, `apps/desktop/src/styles.css`, `apps/desktop/src-tauri/Cargo.toml`, `apps/desktop/src-tauri/build.rs`, `apps/desktop/src-tauri/tauri.conf.json`, `apps/desktop/src-tauri/src/main.rs`, `apps/desktop/src-tauri/src/lib.rs`, `apps/desktop/src-tauri/capabilities/default.json`, `apps/service/package.json`, `apps/service/tsconfig.json`, `apps/service/src/index.ts`, `apps/service/wrangler.jsonc`, `apps/service/vitest.config.ts`, `tests/e2e/shell.spec.ts`, `playwright.config.ts`؛ تعديل `.gitignore`.

**Interfaces:** ينتج `App(): ReactElement` وWorker `fetch(Request, Env, ExecutionContext): Promise<Response>`، ومسار `/health` يعيد 503 و`state: 'unconfigured'` إلى أن يكتمل الإعداد. سكربتات الجذر: `typecheck`, `test`, `test:e2e`, `build`, `tauri:build`؛ أسماء packages: `@mawjivo/desktop`, `@mawjivo/service`؛ تنشأ `@mawjivo/core` في المهمة 2. Env يولد بواسطة Wrangler ولا يكتب يدويًا بعقد مخالف للربط.

- [x] **1. تجهيز harness فقط:** إنشاء worktree عبر مهارة using-git-worktrees من HEAD الذي يحتوي الوثيقتين، وفرع `abdo/mawjivo-app`؛ الإبقاء على ملف الأسرار المستبعد في checkout الأصل وتمرير مساره دون نسخه إلى Git. تثبيت الإصدارات المثبتة ومتطلبات MSVC/WebView2 وFFmpeg الموثوقة، وملفات إعداد الاختبارات والـlockfiles. لا يعتمد التطبيق على برامج مفقودة لدى المستخدم النهائي.
- [x] **2. اختبار فاشل:** `shell_has_arabic_labels_and_unconfigured_service` في `shell.spec.ts`: `await expect(page.locator('html')).toHaveAttribute('lang', 'ar')` و`toHaveAttribute('dir', 'rtl')`، و`await expect(page.getByRole('combobox', {name: 'مساحة العمل'})).toBeVisible()`، وعنوان «Mawjivo»، و`expect(health.status()).toBe(503)`.
- [x] **3. تشغيل الأحمر:** `pnpm test:e2e -- shell.spec.ts`؛ المتوقع فشل الدلالات/مسار الصحة، لا فشل تنزيل الاعتمادات.
- [x] **4. التنفيذ الأدنى:** إنشاء الهيكل والواجهة الدلالية وhealth الصادق؛ ربط `cloudflareTest({wrangler:{configPath:'./wrangler.jsonc'}})`، و`wrangler types`، وتاريخ توافق `2026-10-09`، وCSP دون تنفيذ JavaScript بعيد أو shell عام.
- [x] **5. تحقق أخضر:** `pnpm typecheck`، الاختبار السابق، `pnpm build`، و`pnpm tauri:build -- --no-bundle`؛ نجاح البناء المحلي وWorker dry-run، دون نشر خارجي في هذه المهمة.
- [x] **6. تسجيل:** إضافة الملفات المحددة وملفات القفل ثم `git commit -m "feat: bootstrap accessible Mawjivo desktop and service"`.

### Task 2: سياسة منشور واحدة وتوقيت وأسماء ومراجعة قابلة للتطابق

**Files:** إنشاء `packages/core/package.json`, `packages/core/src/contracts.ts`, `schemas.ts`, `policy.ts`, `time.ts`, `filenames.ts`, `plan-hash.ts`, `platform-rules.json`, `packages/core/test/policy.test.ts`, `time.test.ts`, `filenames.test.ts`, `fixtures.ts`, `apps/desktop/src-tauri/src/contracts.rs`, `apps/desktop/src-tauri/tests/contracts.rs`.

**Interfaces:** `buildPlan(draft: Draft, caps: CapabilitySnapshot, now: ISOInstant): PostPlan`؛ `hashPlan(plan: PostPlan): Promise<string>`؛ `defaultSchedule(createdAt: ISOInstant): ISOInstant`؛ `resolveSchedule(local: string, zone: string, offset?: string): ScheduleResolution` الذي يعيد instant أو ambiguous مع إزاحتين أو invalid؛ `videoFilename(title: string, extension: string): string`. fixtures تنتج `draft(overrides?: Partial<Draft>): Draft` و`caps(): CapabilitySnapshot` بحسابات اختبار فقط.

- [x] **1. اختبارات فاشلة بالقيم المحددة:** `text_only_targets_three_supported_platforms`: `expect(plan.targets.map(t => t.platform).sort()).toEqual(['facebook', 'threads', 'x'])`؛ `x_truncates_weighted_text_and_140000ms_video`: `expect(parseTweet(x.text).weightedLength).toBeLessThanOrEqual(280)` و`expect(xRecipe.maxDurationMs).toBe(140_000)`؛ `youtube_shorts_caps_180000ms`: `expect(youtubeRecipe.maxDurationMs).toBe(180_000)`؛ `x_uses_first_four_images`: `expect(x.assets).toHaveLength(4)`. alt ينتظر غياب حقل غير مدعوم وقص المدعوم، وسلسلة تتجاوز حد fixture تظهر excluded parts دون وجهات منفصلة؛ `expect(await hashPlan(edited)).not.toBe(await hashPlan(original))` عند تغيير النص.
- [x] **2. تثبيت المدخلات غير المعتادة:** `arabic_emoji_title_preserved_with_safe_filename`: `expect(plan.targets[0].title).toBe(originalTitle)` و`expect(filename).not.toMatch(/[<>:"\/\\|?*]/)`؛ `plus_ten_hours_crosses_date_from_instant`: `expect(Date.parse(dueAt) - Date.parse(createdAt)).toBe(36_000_000)`؛ `cairo_dst_gap_rejected_and_overlap_requires_offset`: `expect(gap.kind).toBe('invalid')` و`expect(overlap.offsets).toHaveLength(2)` بقيم مستخرجة من قاعدة المنطقة؛ اختبار Rust يقرأ fixture JSON نفسه دون فقد الحقول.
- [x] **3. تشغيل الأحمر:** `pnpm --filter @mawjivo/core test` و`cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --test contracts`؛ فشل القواعد/العقود المطلوبة.
- [x] **4. التنفيذ:** تعريف العقود أعلاه وZod، حساب X عبر `twitter-text`، وحدود grapheme، وTemporal للتوقيت، وSHA-256 لتمثيل JSON مرتب المفاتيح ويحافظ على ترتيب القوائم. قواعد الموفر بإصدار ومصدر، ولا تبنى السلاسل على قدرة غير متحققة.
- [x] **5. تحقق وتسجيل:** تشغيل الاختبارات نفسها و`pnpm typecheck`؛ نجاح جميع حالات القص والتوقيت والتطابق ثم `git commit -m "feat: add shared post planning and media policies"` بعد إضافة هذه الملفات.

### Task 3: بيانات الخدمة وتوثيق الأجهزة والعزل وتشفير الاتصالات

**Files:** إنشاء `apps/service/migrations/0001_initial.sql`, `src/auth.ts`, `secrets.ts`, `workspaces.ts`, `posts.ts`, `test/security.test.ts`, `test/helpers.ts`؛ تعديل `src/index.ts` وملف config للربط بـDB وMEDIA وPUBLISH.

**Interfaces:** `authenticate(request: Request, env: Env): Promise<AuthContext>`؛ السياق `deviceId, allowedWorkspaceIds: '*' | string[]` في `auth.ts`؛ `requireWorkspace(auth: AuthContext, workspaceId: string): void`. تعرف `secrets.ts` النوع `SecretContext = {workspaceId: string; connectionId: string; keyVersion: number}`؛ `encryptSecret(plain: string, context: SecretContext, env: Env): Promise<string>` و`decryptSecret(cipher: string, context: SecretContext, env: Env): Promise<string>`. تعرف `contracts.ts` النوع `WorkspaceInput = Pick<Workspace, 'name' | 'timeZone' | 'defaultPlatforms' | 'serviceProfileId'>`؛ `createWorkspace(auth: AuthContext, input: WorkspaceInput, env: Env): Promise<Workspace>` و`updateWorkspace(auth: AuthContext, id: string, expectedVersion: number, input: WorkspaceInput, env: Env): Promise<Workspace>`.

- [x] **1. اختبارات فاشلة:** `revoked_device_gets_401`, `foreign_workspace_gets_403`, `stale_workspace_version_gets_409`: `expect(statuses).toEqual([401, 403, 409])` للحالات الثلاث بالترتيب؛ ciphertext: `expect(first).not.toBe(second)`، و`await expect(decryptSecret(corrupted, context, env)).rejects.toMatchObject({code: 'SECRET_INVALID'})`، وكذلك context مساحة مختلفة؛ `expect(logs).not.toContain(testToken)`. fixture: جهازان ومساحتان ومعرفات غير حساسة؛ يعزل helpers مخازن الاختبار ويصدر `testEnv(): Env` و`requestAs(deviceToken: string, path: string, body?: unknown): Request`.
- [x] **2. تشغيل الأحمر:** `pnpm --filter @mawjivo/service test -- security.test.ts`؛ فشل التوثيق أو العزل أو تعديل الإصدار.
- [x] **3. التنفيذ:** جداول `devices, workspaces, connections, channels, posts, targets, target_parts, assets, asset_uses, upload_reservations, rate_budgets, dispatch_outbox, report_outbox, service_settings`؛ مفاتيح المساحة وفهارس الموعد والحالة، وunique للوجهة والإصدار وجزء السلسلة والتقرير اليومي. dispatch_outbox يسجل إنشاء/استبدال Workflow مع postId/revision ومعرف العمل الثابت. تخزين hash رمز الجهاز، وAES-GCM عبر Web Crypto مع nonce عشوائي وإصدار المفتاح وAAD للمساحة/الاتصال. لا رمز جهاز ثابت داخل التطبيق.
- [x] **4. تحقق:** تشغيل اختبارات الأمن وترحيل D1 محليًا: `pnpm --filter @mawjivo/service exec wrangler d1 migrations apply mawjivo-db --local`؛ 401/403/409 كما سبق، وأسرار لا تظهر في logs. تحقق CPU للعمليات الصغيرة في سياق Worker، وتجنب إعادة إنشاء مفاتيح غير لازمة.
- [x] **5. تسجيل:** `git commit -m "feat: isolate workspaces and secure service credentials"` بعد إضافة الملفات المحددة.

### Task 4: خزنة ومسودات محلية وتجهيز Cloudflare من التطبيق

**Files:** إنشاء `apps/desktop/src-tauri/src/error.rs`, `vault.rs`, `profiles.rs`, `drafts.rs`, `cloudflare.rs`, `apps/desktop/src/features/setup/SetupPage.tsx`, `apps/desktop/src/bridge.ts`, `src-tauri/tests/provision.rs`, `tests/e2e/setup.spec.ts`, `scripts/operator-setup.mjs`, `scripts/build-service-artifact.mjs`؛ تعديل `lib.rs`, `Cargo.toml` وconfig وscripts.

**Interfaces:** تعرف `profiles.rs` النوعين `ProvisionInput` و`ServiceProfile`؛ `provision_service(input: ProvisionInput) -> Result<ServiceProfile, AppError>`؛ المدخل accountId/apiToken وr2AccessKeyId/r2SecretAccessKey وzoneId/domain اختياريان؛ الناتج `id, baseUrl, serviceId, accountId, deviceCredentialRef, version` بلا قيم أسرار. `save_draft(profile_id: String, window_id: String, draft: Draft) -> Result<(), AppError>`، `load_draft(profile_id: String, workspace_id: String, draft_id: String) -> Result<Option<Draft>, AppError>`؛ المسودات بمفتاح draftId وربط مستقل لكل نافذة. `service_request(profile_id: String, method: String, path: String, body: Option<serde_json::Value>) -> Result<serde_json::Value, AppError>` يضيف التوثيق داخل Rust ويقبل مسارات الخدمة وطرقها المسموحة فقط.

- [x] **1. اختبارات فاشلة:** `provision_twice_reuses_owned_resources`: `assert_eq!(second.service_id, first.service_id)` مع إنشاء موارد مرة واحدة؛ `foreign_existing_worker_is_not_overwritten`: `assert_eq!(error.code, "RESOURCE_NOT_OWNED")` وصفر كتابة عليه؛ `partial_setup_resumes_without_destroying_resources` يبقي معرف D1 وبياناته؛ `two_profiles_do_not_share_tokens_or_drafts` ونافذتان في نفس المساحة تعيدان draftId المختلف؛ `renderer_never_receives_raw_tokens`: `assert!(!response_json.contains(test_token))`. API Cloudflare وvault محاكيان داخل الاختبار؛ العقد ثابت ويختبر responses الموثقة، دون موارد حقيقية هنا.
- [x] **2. تشغيل الأحمر:** `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --test provision` و`pnpm test:e2e -- setup.spec.ts`.
- [x] **3. التنفيذ:** `keyring` للأسرار وSQLite للمسودات/مراجع الخدمة. تجهيز Worker وD1 وR2 وربط Workflows وترحيل schema من حزمة خدمة مضمّنة ومثبتة البصمة. Native يستخدم Cloudflare APIs لإعداد المستخدم النهائي دون Node/Wrangler لديه؛ سكربت المشغل يستخدم Wrangler للحساب الأول. يثبت ملكية الموارد بعلامة serviceId ويستأنف الخطوات الآمنة فقط؛ يزرع hash جهاز موثق في D1 بعملية إدارة حسابه.
- [x] **4. تحقق:** الاختبارات السابقة؛ واجهة فحص توضح البند وحالته وإجراء الإصلاح، وتعرض عدم الجاهزية عند نقص صلاحية API/R2/النطاق. بناء حزمة الخدمة المضمّنة قابل للتكرار ولا يحتوي secrets؛ `pnpm build`.
- [x] **5. تسجيل:** `git commit -m "feat: add private profiles and Cloudflare onboarding"` للملفات المحددة.

### Task 5: ربط الحسابات واكتشاف القدرات والجاهزية

**Files:** إنشاء `apps/service/src/connections.ts`, `providers/types.ts`, `providers/buffer.ts`, `providers/meta.ts`, `test/connections.test.ts`, `apps/desktop/src/features/settings/ConnectionsPage.tsx`, `WorkspaceSettings.tsx`, `tests/e2e/connections.spec.ts`؛ تعديل router والعقود اللازمة.

**Interfaces:** تعرف `contracts.ts` النوعين `ConnectionInput = {provider: Provider; label: string; credentials: Record<string,string>}` و`Channel = CapabilitySnapshot['channels'][number]`. تعرف `providers/types.ts` النوع `DecryptedConnection = ConnectionInput & {id: string; workspaceId: string}`؛ لا يصدر إلى الواجهة. `saveConnections(auth: AuthContext, workspaceId: string, inputs: ConnectionInput[], env: Env): Promise<ReadinessItem[]>`؛ `discoverChannels(connection: DecryptedConnection, env: Env): Promise<Channel[]>`؛ `getCapabilities(auth: AuthContext, workspaceId: string, env: Env): Promise<CapabilitySnapshot>`. `ProviderAdapter` ينتج `discover(connection, env): Promise<Channel[]>` و`validate(connection, env): Promise<ReadinessItem[]>`؛ تنضم إليه واجهتا الكتابة والنتائج المحددتان في المهمة 9 عند تنفيذها.

- [x] **1. اختبارات فاشلة:** `two_buffer_clients_map_four_channels_correctly`: `expect(channels.map(c => c.platform).sort()).toEqual(['threads', 'tiktok', 'x', 'youtube'])`؛ `facebook_instagram_share_page_link_but_not_token_types` يطابق account/page من fixture؛ `expired_or_missing_scope_is_not_ready`: `expect(channel.ready).toBe(false)`؛ fallback ينتظر رفض قناة غير متصلة؛ `cached_channels_do_not_refetch_on_new_window`: `expect(providerFetch).toHaveBeenCalledTimes(1)`؛ `free_threads_limit_is_exposed_before_confirm`: `expect(channel.limits.threadParts).toBe(verifiedFixtureLimit)` أو عدم جاهزية إذا لم يتحقق الحد. لا قيم حسابات فعلية في fixtures.
- [x] **2. تشغيل الأحمر:** `pnpm --filter @mawjivo/service test -- connections.test.ts` و`pnpm test:e2e -- connections.spec.ts`.
- [x] **3. التنفيذ:** Buffer GraphQL الحالي وGraph API `v26.0` بتوثيق headers. حفظ كريدينشلز النشر مشفرة، وربط الصفحة والحساب الاحترافي، والتحقق من انقطاع القناة وقفلها وحقوق النشر. cache افتراضي 24 ساعة مع تحديث عند تعديل الربط أو طلب فحص يدوي. قيم media/thread التي لا يمكن إثباتها تبقى غير جاهزة بدل اختلاق حد.
- [x] **4. تحقق قراءة:** تشغيل الاختبارات ثم فحص حسابات المستخدم الحالي قراءة فقط: القنوات الأربع والصفحة والـIG والرابط بينهما؛ حسم شروط فيديو Meta من مرجع المسار وفحص الرمز. حفظ القدرات المتحققة ومصادرها دون الأسرار. لا تصنف حد سلسلة أو فيديو غير مثبت كميزة مكتملة.
- [x] **5. تسجيل:** `git commit -m "feat: connect publishing accounts and verify capabilities"`.

### Task 6: فحص ومعالجة الوسائط محليًا

**Files:** إنشاء `apps/desktop/src-tauri/src/media/mod.rs`, `probe.rs`, `transform.rs`, `filenames.rs`, `jobs.rs`, `tests/media.rs`, `scripts/fetch-media-tools.mjs`, `tools/media-tools.json`, `docs/user/media-processing.md`؛ تعديل موارد Tauri و`lib.rs`.

**Interfaces:** تضيف `contracts.rs` الأنواع `SelectedFile {file_id, original_name, bytes, mime_type}` و`PreparedLocalAsset {file_id, source_asset_id, recipe_id, mime_type, bytes, sha256}` بصيغة camelCase في JSON؛ fileId مرجع داخلي وليس مسارًا يقبله renderer. `pick_media() -> Result<Vec<SelectedFile>, AppError>`؛ `probe_media(file_id: String) -> Result<MediaAsset, AppError>`؛ `prepare_media(file_id: String, recipe: MediaRecipe) -> Result<PreparedLocalAsset, AppError>`؛ `cancel_media(job_id: String) -> Result<(), AppError>`. حدث `media-progress` يحمل assetId/stage والأرقام فقط.

- [x] **1. اختبارات فاشلة:** `png_to_jpeg_keeps_basename_and_highest_fitting_quality`: `assert_eq!(output.mime_type, "image/jpeg")` وجذر الاسم مطابق؛ `video_uses_title_without_renaming_source`: الاسم المطلوب للإرسال من العقد و`assert_eq!(source_hash_before, source_hash_after)`؛ `clip_takes_first_140000ms_or_180000ms`: `assert!(output.duration_ms <= requested_limit_ms)` مع 140_000 و180_000، وضبط نهاية القص على إطار لا يتجاوز الحد؛ `portrait_padding_preserves_original_scene` يحفظ علامات أطراف fixture؛ اسم عربي طويل يظل صالحًا؛ امتلاء/إلغاء: `assert!(source.exists())` و`assert!(!partial.exists())`. fixtures صناعية صغيرة، لا ملفات شخصية.
- [x] **2. تشغيل الأحمر:** `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --test media`؛ فشل خصائص الناتج/الحفاظ على الأصل.
- [x] **3. التنفيذ:** FFprobe للمدة والصيغة والأبعاد والدوران؛ `image` لتحويل JPEG حيث يدعم المصدر، وFFmpeg للصور الأخرى والفيديو. جودة JPEG أعلى قيمة تلائم الحد، مع سقف ابتدائي 95 واختبار وضوح/حجم؛ إطارات وهوامش بدلاً من اقتطاع المشهد. `Command` بمعاملات منفصلة ودون shell وبـCREATE_NO_WINDOW على Windows، وتزامن معالجة ثقيلة واحدة. امتداد الناتج يطابق MIME.
- [x] **4. تحقق:** تشغيل اختبارات الوسائط وفحص الناتج بـFFprobe، وحدود المدة والحجم والأبعاد، وبصمة الأصل قبل وبعد. تنزيل sidecars المثبتة البصمة ومعلومات مصدر وترخيص بناء FFmpeg، وعدم الاعتماد على PATH لدى المستخدم النهائي.
- [x] **5. تسجيل:** `git commit -m "feat: process publishing media locally"`.

### Task 7: رفع R2 محجوز السعة وروابط ثابتة بأسماء صحيحة

**Files:** إنشاء `apps/service/src/assets.ts`, `assets/upload.ts`, `assets/serve.ts`, `assets/retention.ts`, `test/assets.test.ts`, `test/retention.test.ts`؛ تعديل router وschema بإضافة migration إذا لزم.

**Interfaces:** تعرف `contracts.ts` النوع `UploadManifest = Pick<MediaAsset, 'originalName' | 'kind' | 'bytes' | 'mimeType' | 'width' | 'height' | 'durationMs'> & {sourceAssetId: string; recipeId: string | null}`، و`UploadedPart = {partNumber: number; etag: string}`، و`UploadTicket = {assetId: string; multipartId: string | null; expiresAt: ISOInstant; parts: {partNumber: number; url: string}[]}`. `beginUpload(auth: AuthContext, workspaceId: string, input: UploadManifest, env: Env): Promise<UploadTicket>`؛ `completeUpload(auth: AuthContext, assetId: string, parts: UploadedPart[], sha256: string, env: Env): Promise<MediaAsset>`؛ `serveMedia(request: Request, nonce: string, filename: string, env: Env): Promise<Response>`؛ `collectExpiredAssets(now: ISOInstant, env: Env): Promise<CleanupResult>`، وCleanupResult في retention.ts يحوي deletedCount/releasedBytes/retainedUnknownCount. جميع قيم size/bytes أعداد صحيحة غير سالبة.

- [x] **1. اختبارات فاشلة:** `concurrent_reservations_cannot_exceed_9000000000`: `expect(totalReservedAndStored).toBeLessThanOrEqual(9_000_000_000)` تحت Promise.all؛ foreign complete ينتظر 403؛ JPEG URL يفك إلى الاسم الأصلي؛ video alias ينتظر صفر نسخ R2؛ Range `bytes=2-5`: `expect(response.status).toBe(206)` و`expect(body.byteLength).toBe(4)`. retention يثبت الوجود قبل 24h/48h/7d والغياب بعد الحد المناسب، و`expect(scheduledExists && unknownExists).toBe(true)` مهما تجاوز العمر.
- [x] **2. تشغيل الأحمر:** `pnpm --filter @mawjivo/service test -- assets.test.ts retention.test.ts`.
- [x] **3. التنفيذ:** حجز ذري في D1، وR2 multipart مباشرة. presign عبر `aws4fetch` دون SDK ضخم؛ ticket مدته 15 دقيقة قابل للتجديد لعملية الرفع نفسها. مفاتيح R2 غير قابلة للتخمين، وmedia alias عبر nonce واسم ظاهر، مع Content-Disposition و`filename*` وMIME وContent-Length وRange. لا تدخل أسرار الحسابات في URL ولا يسمح المستخدم بروابط وسيط خارج الخدمة.
- [x] **4. تحقق:** اختبارات السعة والملكية والـRange والتنظيف؛ R2 محلي، وعدم اعتماد اكتمال الرفع قبل مطابقة حجم object والmanifest. تجدد الحجوزات للرفع النشط وتحرر بعد abort مؤكد؛ تبقى unresolved references محمية.
- [x] **5. تسجيل:** `git commit -m "feat: add resumable media storage and stable delivery URLs"`.

### Task 8: رفع من Rust قابل للاستكمال وفوري عند الاختيار

**Files:** إنشاء `apps/desktop/src-tauri/src/upload/mod.rs`, `session.rs`, `transport.rs`, `progress.rs`, `tests/upload.rs`؛ تعديل `drafts.rs` وcommands في `lib.rs`.

**Interfaces:** تعرف `contracts.rs` النوع `UploadInput {profile_id, workspace_id, file_id, source_asset_id, recipe_id, manifest: UploadManifest}`؛ assetId النهائي يحصل عليه من ticket ولا يخلط بمعرف الأصل. `start_upload(input: UploadInput) -> Result<String, AppError>`، `resume_upload(job_id: String) -> Result<(), AppError>`، `cancel_upload(job_id: String) -> Result<(), AppError>`؛ تستخدم API المهمة 7 وDTO المطابق. حدث `upload-progress`: jobId/assetId/completedBytes/totalBytes/elapsedMs/remainingMs?؛ `uploaded_asset(job_id: String) -> Result<Option<PreparedAsset>, AppError>`.

- [x] **1. اختبارات فاشلة:** `selection_starts_transfer_without_publish`: `assert!(sent_bytes > 0)` قبل أي confirm مع صفر publish calls؛ الاستكمال: `assert_eq!(completed_part_send_count, 1)` لكل جزء ناجح؛ reuse يعيد assetId نفسه وصفر بايتات إضافية؛ تعديل المصدر: `assert_eq!(error.code, "SOURCE_CHANGED")` وصفر complete calls؛ الإلغاء يبقي المصدر ويحرر حجزه. `assert_eq!(part_bytes, 16 * 1024 * 1024)` للأجزاء غير الأخيرة و`assert!(peak_parallel_requests <= 2)`.
- [x] **2. تشغيل الأحمر:** `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --test upload` مع HTTP/R2 محاكيين.
- [x] **3. التنفيذ:** reqwest streaming وقراءة chunks دون تحميل الفيديو كاملًا في الذاكرة، وتخزين session/ETags في SQLite. حساب hash من نفس المصدر، وفحص تغير metadata ثم بصمة نهائية قبل complete. كل ناتج معالجة معرف recipe مستقل. تقدم محدود التحديث ولا يطلق إعلان قارئ شاشة تلقائيًا.
- [x] **4. تحقق:** الاختبارات السابقة ورفع fixture أكبر من 32 MiB عبر R2 المحلي، ثم قطع/استكمال الشبكة؛ إثبات عدد البايتات/الأجزاء المرسلة ومطابقة النهائي. الزمن المتبقي تقديري أو غير متاح عند عدم كفاية العينات.
- [x] **5. تسجيل:** `git commit -m "feat: upload media once with resume and useful progress"`.

### Task 9: موصلات نشر وتحقق مقتصدة دون إعادة كتابة غامضة

**Files:** تعديل `apps/service/src/providers/types.ts`, `buffer.ts`, `meta.ts`؛ إنشاء `providers/rate-budget.ts`, `providers/redact.ts`, `test/buffer.test.ts`, `test/meta.test.ts`, `test/rate-budget.test.ts`.

**Interfaces:** تعرف `providers/types.ts` النوع `ResolvedTarget = Omit<TargetPlan, 'assets'> & {assets: (AssetUse & {assetId: string; url: string; bytes: number; mimeType: string})[]}`؛ `publishBatch(connection: DecryptedConnection, targets: ResolvedTarget[], env: Env): Promise<ProviderResult[]>`؛ `readReceipts(connection: DecryptedConnection, remoteIds: string[], env: Env): Promise<ProviderReceipt[]>`. ProviderResult union لكل channelId: accepted/remoteId، rejected/AppError/retryAt?، أو uncertain؛ ProviderReceipt لكل remoteId: processing/published/failed/unknown مع publishedAt?/publicUrl?/partReceipts?. partReceipts تحوي partIndex/remoteId/state لنتائج السلسلة. `reserveRequests(connectionId: string, count: number, purpose: 'publish' | 'receipt' | 'discovery', now: ISOInstant, env: Env): Promise<BudgetDecision>`؛ BudgetDecision في rate-budget.ts: allowed/reservationId أو deferred/retryAt.

- [x] **1. اختبارات فاشلة:** `buffer_two_targets_share_one_mutation_document`: `expect(fetchCalls).toHaveLength(1)` وفيه عمليتان؛ shareNow: `expect(mode).toBe('shareNow')` وغياب dueAt المستقبل؛ `accepted_is_not_published`: `expect(result.kind).toBe('accepted')` لا published؛ الخطأ الجزئي لا يكرر remoteId الناجح؛ timeout: `expect(result.kind).toBe('uncertain')`؛ Meta carousel يحفظ ترتيب assetIds وaltTexts؛ الفيديو يبقى processing حتى الرد النهائي؛ retryAfter يثبت retryAt المطابق، وميزانيتا العميلين مستقلتان.
- [x] **2. تشغيل الأحمر:** `pnpm --filter @mawjivo/service test -- buffer.test.ts meta.test.ts rate-budget.test.ts`؛ outbound fetch محاكى بالكامل.
- [x] **3. التنفيذ:** عمليات Buffer الحالية بـmode `shareNow` وautomatic، metadata للفيديو والصور والسلاسل وفق schema الموثق، وتجميع ≤30 alias مع هامش تعقيد. Meta feed/photos/media/video flows بالمراجع الرسمية الحالية. قراءة headers الحصة المتحركة وتخزين reset/remaining؛ احتياطي متابعة أولي 10% من كل نافذة، ويستطيع العمل المؤكد استخدامه للمتابعة فقط. لا polling عند غياب أعمال معلقة.
- [x] **4. تحقق:** مراجعة requests المحاكية والأسرار المنقحة، وحالة uncertain للtimeout بعد كتابة. استعلام حالة أولي بعد دقيقة، ثم 5 و15 دقيقة، ثم مجمع كل ساعة مع التأجيل وفق الحصة؛ حد العمل المعلق لا يتحول إلى نجاح أو فشل مختلق. HTTP 429 يثبت retryAt؛ رفض scope/content دائم يثبت إجراء إصلاح.
- [x] **5. تسجيل:** `git commit -m "feat: publish through Buffer and Meta with independent receipts"`.

### Task 10: محرر المنشور والمراجعة والإعدادات والنوافذ

**Files:** إنشاء `apps/desktop/src/features/composer/ComposerPage.tsx`, `MediaPicker.tsx`, `PlatformFields.tsx`, `ReviewPage.tsx`, `useComposer.ts`, `src/features/workspaces/WorkspaceSelect.tsx`, `src-tauri/src/windows.rs`, `tests/e2e/composer.spec.ts`, `windows.spec.ts`؛ تعديل `App.tsx`, `bridge.ts` وsettings.

**Interfaces:** الواجهة تستهلك `buildPlan/hashPlan` وnative pick/probe/prepare/upload، وتنتج `Submission` فقط بعد ready assets. `open_composer_window() -> Result<String, AppError>`؛ `useComposer(workspaceId, windowId)` يحفظ Draft مستقلًا؛ backend submit يتصل في المهمة 11.

- [x] **1. اختبارات فاشلة:** defaults تطابق defaultPlatforms وتقبل إزالة/إضافة وجهة؛ video title يظل required دون YouTube؛ text/alt overrides تطابق TargetPlan؛ المراجعة تعرض مدة القص وعدد الاستبعادات والتحويل. `expect(document.activeElement).toBe(previouslyFocused)` أثناء تقدم الرفع وغياب aria-live عنه؛ `await expect(confirmButton).toBeDisabled()` حتى ready؛ `expect(editedHash).not.toBe(confirmedHash)`؛ Ctrl+Shift+N ينتج نافذتين وdraftId مختلفين، وتغيير المساحة في الأولى لا يغير الثانية.
- [x] **2. تشغيل الأحمر:** `pnpm test:e2e -- composer.spec.ts windows.spec.ts`؛ bridge محاكى بالواجهة، وcommand فتح النافذة يختبر native في التحقق اليدوي.
- [x] **3. التنفيذ:** HTML أصلي وlabels/headings وأزرار صريحة، وعنوان الفيديو المشترك وتخصيص النص/alt/سلسلة. ترتيب الصور وإزالتها، وتقسيم السلسلة آليًا أو تحرير أجزائها وترتيبها. مربع الجدولة يكشف حقله بقيمة إنشاء الصفحة +10h. تبديل المساحة يحفظ المسودة، ولا يغير نافذة أخرى. dialog المراجعة ينتقل إليه التركيز بطلب المستخدم ويعيده عند الإغلاق؛ progress لا يحمل aria-live.
- [x] **4. تحقق:** اختبارات keyboard/RTL والتكبير، وaxe دون أخطاء حرجة أو جسيمة، ثم تشغيل Tauri محليًا لفحص النوافذ والاختصار. فحص تفاعلي عبر مهارة agent-browser عند الحاجة، واختبار NVDA يبقى للمستخدم في التسليم.
- [x] **5. تسجيل:** `git commit -m "feat: add Arabic composer and explicit publication review"`.

### Task 11: تأكيد ذري وجدولة Workflows وتعديل وإلغاء آمن

**Files:** تعديل `apps/service/src/posts.ts`؛ إنشاء `src/workflows/publish.ts`, `test/publication.test.ts`, `test/scheduling.test.ts`؛ تعديل config والعقود والbridge و`ReviewPage.tsx`.

**Interfaces:** `submitPost(auth: AuthContext, submission: Submission, env: Env): Promise<PublicationReceipt>`؛ `revisePost(auth: AuthContext, postId: string, expectedRevision: number, submission: Submission, env: Env): Promise<PublicationReceipt>`؛ `cancelPost(auth: AuthContext, postId: string, expectedRevision: number, env: Env): Promise<PublicationReceipt>`؛ `claimTarget(postId: string, revision: number, channelId: string, env: Env): Promise<ClaimResult>`. تعرف posts.ts النوع `ClaimResult` كclaimed/claimId أو skipped/reason، وpublish.ts النوع `PublishJob = {postId: string; revision: number}`؛ `PublishWorkflow.run(event: WorkflowEvent<PublishJob>, step: WorkflowStep): Promise<void>`. `drainDispatchOutbox(now: ISOInstant, env: Env): Promise<number>` في posts.ts يستخدم cron المهمة 13 ومعرفات أعمال ثابتة للاستئناف.

- [x] **1. اختبارات فاشلة:** `confirmed_hash_must_match`, `changed_settings_or_capabilities_require_new_review`, `unuploaded_or_foreign_asset_rejected`, `two_submit_calls_create_one_receipt`, `failed_workflow_creation_resumes_from_dispatch_outbox`, `old_workflow_revision_cannot_publish`, `cancel_wins_before_claim`, `claim_wins_locks_edit`, `partial_success_only_retries_failed_target`, `cancel_unclaimed_target_during_partial_send`, `sleep_uses_utc_instant_across_cairo_dst`, `computer_off_does_not_block_due_job`, `beyond_365_days_rejected`.
- [x] **2. تشغيل الأحمر:** `pnpm --filter @mawjivo/service test -- publication.test.ts scheduling.test.ts`؛ clock وProviderAdapter محاكيان. assertions: `expect(receipts[0].postId).toBe(receipts[1].postId)` عند submit متكرر؛ `expect(providerWritesForOldRevision).toBe(0)`؛ `expect(providerWritesForConfirmedTarget).toBe(1)`؛ `expect(staleEdit.status).toBe(409)`؛ outbox بعد فشل إنشاء عمل يستأنف إلى workflowId نفسه؛ موعد >365 يومًا ينتظر `SCHEDULE_TOO_FAR`.
- [x] **3. التنفيذ:** تحقق service من hash الخطة وسياسة وإصدار إعدادات/قدرات وملكية وحجم الوسائط؛ لا تحول محتوى خفيًا إن تغيرت قدرة بعد التأكيد. CAS الحالة/revision وunique draftId/revision/planHash وتسجيل dispatch_outbox في المعاملة نفسها؛ إنشاء العمل واستئنافه بمعرف ثابت. Workflow يقرأ snapshot ثابتًا، وينتظر الموعد، ويعيد فحص الحالة قبل claim. الإلغاء/التعديل يثبتان في D1 أولًا ثم ينهيان/يستبدلان العمل؛ القديم آمن حتى إذا فشل إنهاء workflow. يقفل تعديل الإصدار بعد بدء الإرسال، ويمكن إلغاء وجهة لم تحصل على claim بعد. يرفض موعدًا يتجاوز 365 يومًا، ومعالجة uncertain منفصلة عن retry؛ حالات الأجزاء محفوظة في target_parts.
- [x] **4. تحقق:** الاختبارات نفسها، واختبار Workflows الفعلي محليًا بوقوف التطبيق، وrace تكرار submit مع revise/cancel؛ لا customScheduled في payload Buffer. UI يعرض «مجدول» بعد تثبيت السجل والعمل أو حالة إصلاح واضحة إذا فشل إنشاء العمل مع بقاء outbox قابل للاستئناف.
- [x] **5. تسجيل:** `git commit -m "feat: execute cloud schedules with revision-safe publishing"`.

### Task 12: قائمة المجدولة والملخص والإصلاح دون فقد المسودة

**Files:** إنشاء `apps/service/src/history.ts`, `test/history.test.ts`, `apps/desktop/src/features/history/ScheduledPage.tsx`, `SummaryPage.tsx`, `PostDetails.tsx`, `tests/e2e/history.spec.ts`؛ تعديل router وApp/bridge.

**Interfaces:** تعرف contracts.ts النوعين `PostPage = {items: PublicationReceipt[]; nextCursor: string | null}` و`Summary = {localDate: string; timeZone: string; completePosts: number; partialPosts: number; failedPosts: number; unknownPosts: number; publishedTargets: number; upcomingScheduled: number}`. `listPosts(auth: AuthContext, workspaceId: string, filter: 'all' | 'scheduled' | 'needsAction', cursor: string | undefined, env: Env): Promise<PostPage>`؛ `getSummary(auth: AuthContext, workspaceId: string, localDate: string, env: Env): Promise<Summary>`. UI يستعمل revise/cancel من المهمة 11 ويحتفظ بالمسودة حتى نجاح التعديل.

- [ ] **1. اختبارات فاشلة:** `one_post_six_targets_is_one_post`: `expect(summary.completePosts).toBe(1)` و`expect(summary.publishedTargets).toBe(6)`؛ partial/unknown ليست complete؛ حدود اليوم بحسب المنطقة؛ 409 يبقي draftId/text دون تغيير؛ cancelled ينتظر `expect(summary.upcomingScheduled).toBe(0)`؛ تبديل المساحة ينتظر `expect(items.every(p => p.workspaceId === selectedWorkspaceId)).toBe(true)`.
- [ ] **2. تشغيل الأحمر:** `pnpm --filter @mawjivo/service test -- history.test.ts` و`pnpm test:e2e -- history.spec.ts`.
- [ ] **3. التنفيذ:** استعلامات D1 مفهرسة وpagination، ونصوص عربية مباشرة للحالات والتفاصيل. التعديل يعيد المراجعة؛ تغيير الملف يعيد معالجة النسخ اللازمة فقط، وإصلاح ربط لا يعيد نشر وجهة ناجحة. تجميع refresh من الخدمة دون fetch Buffer لكل نافذة.
- [ ] **4. تحقق وتسجيل:** نجاح الاختبارات والكيبورد للقوائم والأزرار، ثم `git commit -m "feat: manage schedules and show reliable Arabic summaries"`.

### Task 13: Telegram وHealthchecks ومؤقت المراقبة

**Files:** إنشاء `apps/service/src/reports/telegram.ts`, `daily.ts`, `src/monitoring.ts`, `test/reports.test.ts`, `monitoring.test.ts`, `scripts/setup-healthchecks.mjs`, `docs/user/monitoring.md`؛ تعديل scheduled handler/config/settings/schema عند الحاجة.

**Interfaces:** تعرف telegram.ts النوع `ReportMessage = {workspaceId: string; dedupeKey: string; kind: 'failure' | 'daily' | 'recovery'; textAr: string}` وReportDelivery: sent/messageId أو failed/AppError أو uncertain؛ `sendReport(report: ReportMessage, env: Env): Promise<ReportDelivery>`. تعرف daily.ts النوع `DailyEvaluation = {evaluated: number; sent: number; inactive: number; unresolved: number}`؛ `evaluateDailySummaries(now: ISOInstant, env: Env): Promise<DailyEvaluation>`. تعرف monitoring.ts النوع `MonitorResult = {serviceHealthy: boolean; dailyEvaluated: boolean; readiness: ReadinessItem[]}`؛ `runMonitor(now: ISOInstant, env: Env): Promise<MonitorResult>`. يعرف سكربت التجهيز `setupHealthchecks(serviceId: string, managementKey: string, monitorTimeZone: string): Promise<MonitorBindings>`، وMonitorBindings يحتوي heartbeatPingUrl/dailyPingUrl/integrationState؛ لا مفتاح إدارة runtime.

- [ ] **1. اختبارات فاشلة:** `midnight_active_day_sends_once`, `inactive_day_pings_but_sends_no_summary`, `telegram_timeout_not_retried_blindly`, `five_minute_heartbeat_requires_db_r2_and_progress`, `one_client_rate_wait_is_not_dead_job`, `daily_monitor_timezone_does_not_change_workspace_midnight`, `provider_error_report_has_action_and_no_secret`.
- [ ] **2. تشغيل الأحمر:** `pnpm --filter @mawjivo/service test -- reports.test.ts monitoring.test.ts` مع Telegram/HC محاكيين؛ `expect(telegramCallsForDay).toHaveLength(1)` للنشاط و0 لغيابه، و`expect(delivery.kind).toBe('uncertain')` مع عدم إعادة الإرسال؛ `expect(heartbeatPeriodSeconds).toBe(300)` وgrace 600 واليومي 900؛ فشل D1/R2/progress يرسل /fail، والانتظار المبرر لا يفعل. `expect(report.textAr).not.toContain(testToken)`.
- [ ] **3. التنفيذ:** Cron `* * * * *` يفحص مؤشرات D1 للمهام اليومية/التأخر/الصيانة ويستأنف dispatch_outbox، ويصدر النبض كل خمس دقائق. outbox فريد للمساحة والتاريخ/نوع المشكلة، وقفل وremote message id. فحصا HC للخدمة والملخص، `/start` ثم success أو `/fail`؛ لا طلب Buffer/Meta في كل نبضة ولا رموز في body. قالب تقرير يذكر المنصة والخطوة والسبب والإجراء مرة مفيدة.
- [ ] **4. تجهيز مراقبة حقيقية:** بعد اختبارات المحاكاة، إنشاء فحوص موسومة serviceId عبر API مع إعادة استخدام الموجودة، وربط Telegram خارج Worker عبر التكامل المتاح. تستخدم مهارة agent-browser إذا احتاجت شاشة Healthchecks؛ خطوة مستخدم لازمة للربط تعرض حين تثبت الحاجة. تحقق تنبيه فشل وتعافٍ حقيقيين في فحص تجريبي معزول؛ لا توقف فحص الإنتاج لإحداث عطل مصطنع.
- [ ] **5. تحقق وتسجيل:** تشغيل scheduled event محليًا ثم قياس التنفيذ في الخدمة المنشورة عند المهمة 16؛ نبض ناجح، وتقارير جاهزية بالعربية، وعدم حاجة Worker لمفتاح إدارة HC؛ `git commit -m "feat: add independent monitoring and actionable Telegram reports"`.

### Task 14: CI وصيانة وتدقيق أسرار ومصادر الأدوات

**Files:** إنشاء `.github/workflows/ci.yml`, `security.yml`, `release.yml`, `.github/dependabot.yml`, `scripts/check-secrets.mjs`, `scripts/verify-toolchain.mjs`, `scripts/sync-version.mjs`, `scripts/test/check-secrets.test.mjs`, `scripts/test/version.test.mjs`, `docs/user/development.md`, `THIRD_PARTY_NOTICES.md`؛ تعديل package scripts وignore.

**Interfaces:** `pnpm verify` يجمع الأنواع واختبارات TS وRust والبناء؛ `pnpm check:secrets -- paths...` يخرج 1 عند اكتشاف سر دون طباعته؛ `pnpm sync-version -- version` يحدث إصدارات التطبيق والخدمة وحزمة النشر وmanifest بصورة واحدة.

- [ ] **1. فحص فاشل meaningful:** fixture سر اصطناعي في دليل مؤقت: `assert.equal(result.status, 1)` و`assert.ok(!result.stdout.includes(testSecret))`؛ نص عادي ينتظر status 0. `version_manifest_matches_all_consumers`: تغيير نسخة واحدة ينتظر status 1، وsync-version يعيد نسخًا مطابقة في Tauri/خدمة/حزمة. لا ينشأ اختبار يعيد قراءة YAML فقط.
- [ ] **2. تشغيل الأحمر:** `node --test scripts/test/check-secrets.test.mjs scripts/test/version.test.mjs`؛ ينشئ الاختبار ملفات مؤقتة ويفحص exitCode/stdout للـCLI، وسبب الفشل detector/version المطلوب. ينظفها الاختبار في finally؛ لا تحفظ fixtures أسرار في المستودع أو أصول البناء.
- [ ] **3. التنفيذ:** workflows بصلاحيات دنيا وActions مثبتة SHA بعد التحقق من مصادرها، وCI على PR/push، وWindows smoke build؛ Linux/macOS عند إصدار/طلب يدوي لتقليل ميزانية private Actions. Dependabot أسبوعي مجمع، وsecurity audit أسبوعي دون شراء خدمات. runtime secrets في environment/ملفات مؤقتة محمية وتمريرها stdin، ولا أسرار في arguments.
- [ ] **4. تحقق:** تشغيل `pnpm verify` و`cargo fmt --check` و`cargo clippy -- -D warnings` ضمن المشروع الصحيح، ثم CI فعلي على GitHub. تأكيد أن artifacts لا تتضمن env/vault/key material، وإشعارات ومصدر FFmpeg وبصماته موجودة.
- [ ] **5. تسجيل:** `git commit -m "ci: verify builds and maintain dependencies securely"`.

### Task 15: مثبت Windows وتحديث موقّع وحفظ البيانات

**Files:** إنشاء `apps/desktop/src-tauri/src/updates.rs`, `src/features/settings/UpdatesPage.tsx`, `src-tauri/tests/updates.rs`, `tests/e2e/updates.spec.ts`, `scripts/publish-release.mjs`, `scripts/verify-release.mjs`, `docs/user/install.md`, `docs/user/recovery.md`, `docs/releases/0.1.0.md`؛ تعديل `tauri.conf.json`, `Cargo.toml`, `release.yml` وموارد الخدمة المضمّنة.

**Interfaces:** تعرف contracts.rs النوع `UpdateInfo {id, version, notes_ar, bytes}`؛ `check_update() -> Result<Option<UpdateInfo>, AppError>`، `download_update(update_id: String) -> Result<(), AppError>`، `install_update(update_id: String) -> Result<(), AppError>`، مع progress event. `upgrade_service(profile_id: String, package_id: String) -> Result<ServiceProfile, AppError>` يستخدم حساب المستخدم ويفحص توافق schema/API ويحافظ على الموارد والأسرار.

- [ ] **1. اختبارات فاشلة:** bad signature: `assert_eq!(error.code, "UPDATE_SIGNATURE_INVALID")` وصفر install calls؛ active upload ينتظر `UPDATE_BUSY`؛ migration الفاشل: `assert_eq!(restored_draft, original_draft)` وبقاء مرجع الخزنة؛ service upgrade يبقي postId/dueAt وconnectionId؛ التحديث من مستودع خاص ينتظر نجاح GET manifest/artifact دون Authorization GitHub. أسرار التوقيع التجريبية منفصلة عن مفاتيح الإصدار.
- [ ] **2. تشغيل الأحمر:** `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --test updates` و`pnpm test:e2e -- updates.spec.ts`؛ إنشاء `tests/e2e/updates.spec.ts` ضمن هذه المهمة.
- [ ] **3. التنفيذ:** Tauri Updater وتوليد مفاتيح الإصدار وحفظ الخاص في خزنة/CI، وNSIS per-user مع WebView2 bootstrapper وsidecars، وmanifest HTTPS متاح علنًا دون GitHub token. استضافة ملفات إصدار في R2 ضمن الحجز، ونشر manifest بعد اكتمال الملفات والتحقق من signatures. نسخة احتياطية محلية قبل migration، ومسار استعادة واضح؛ native service upgrade يتأكد من ملكية النسخة وتوافقها قبل تبديلها.
- [ ] **4. تحقق عملي:** `pnpm tauri:build`؛ تثبيت على Windows نظيف/حساب اختبار، ثم بناء إصدار تجريبي تالٍ على قناة اختبار، وتنزيله والتحقق منه وتثبيته مع بقاء مساحة ومسودة ورمز في الخزنة. نشر تحديث الإنتاج فقط بعد دليل الاختبار. توقيع Updater إلزامي ولا يفترض شراء شهادة Authenticode.
- [ ] **5. تسجيل:** `git commit -m "feat: distribute Mawjivo with signed in-app updates"`.

### Task 16: تجهيز الحساب الأول وإثبات النشر والتسليم

**Files:** إنشاء `docs/releases/0.1.0-verification.md`, `docs/user/quick-start.md`, `scripts/verify-production.mjs`, `tests/e2e/full-flow.spec.ts`؛ تعديل docs الإصدار والإصلاحات التي تكشفها الفحوص فقط، وتحديث الحالة في الخطة.

**Interfaces:** `pnpm verify:production -- profile` يتحقق من الخدمة والموارد والقنوات والمراقبة وروابط الوسائط دون نشر تلقائي؛ ينتج تقريرًا منقحًا. لا تعدل الوظيفة أي منشور أو فحص مراقبة إنتاجي لإنشاء عطل.

- [ ] **1. اختبار تكامل محلي فاشل ثم إصلاح:** `full_flow_preserves_confirmed_content_across_restart` يختار ملفًا، ويغير نص منصة، ويجدول +10h، ويغلق native bridge، ثم يستأنف Worker بclock محاكى؛ `expect(summary.completePosts).toBe(1)` و`expect(dueAtMs - pageCreatedAtMs).toBe(36_000_000)` و`expect(uniqueOriginalUploads).toBe(1)`؛ TargetPlan المرسل يطابق المؤكد. `full_flow_cancel_and_retry_do_not_duplicate`: `expect(cancelledRevisionWrites).toBe(0)` و`expect(uncertainTargetWriteCalls).toBe(1)`.
- [ ] **2. تشغيل وتحقق محلي شامل:** `pnpm verify` و`pnpm test:e2e`، وWorker dry-run وWindows bundle؛ نجاح الفحوص بعد الإصلاحات الجديدة فقط. مراجعة مستقلة وفق طريقة التنفيذ المختارة قبل دمج/إصدار الفرع، ومعالجة النتائج القابلة للإجراء.
- [ ] **3. تجهيز الحساب الحقيقي:** تشغيل operator setup عبر Wrangler للكريدينشلز المحلية، وموارد `mawjivo` الموسومة، وربط `mawjivo.aimansour.com` للخدمة و`media.aimansour.com` لمسار الوسائط إذا كانا متاحين. تزرع الخزنة ومساحة صاحب المشروع من ملفه المحلي، وتتحقق روابط GET/HEAD/Range. لا يستعمل مثبت موزع هذه الإعدادات تلقائيًا لمستخدم مختلف.
- [ ] **4. أدلة الخدمات:** `pnpm verify:production -- owner`، وWrangler types/deploy dry-run ثم deploy، ومتابعة metrics CPU والحصص والسجل. تثبت صلاحيات فيديو Meta، وحدود سلاسل الحساب المجاني، ووصول تقارير Telegram وتنبيه HC الخارجي. أي نقص حقيقي يظهر كبند يحتاج إصلاحًا، ولا يخفى بوصف اكتمال المشروع.
- [ ] **5. نشر حقيقي بتأكيد المستخدم:** يختار المستخدم محتوى اختبار من داخل التطبيق ويوافق على المراجعة؛ يثبت نشر نص وصور وفيديو بحسب قدرات القنوات الست، وسلسلة X/Threads، وجدولة قصيرة والكمبيوتر مغلق، وتعديل/إلغاء مجدول. تحفظ مراجع المنشورات وروابطها والوقت والنتيجة دون الأسرار في دليل التحقق. لا تنشر محتوى اصطناعيًا على حساباته بلا تأكيده.
- [ ] **6. تسليم:** رابط تنزيل يعمل بلا تسجيل GitHub، وفحص تحديث ناجح، وإرشادات الاستخدام والإصلاح بالعربية. يجري المستخدم اختبار NVDA؛ تصلح ملاحظاته وتكرر الفحوص المتأثرة حتى اعتماد التجربة. تسجيل `git commit -m "docs: record verified Mawjivo release and user guide"` ثم تكامل الفرع وفق مهارة finishing-a-development-branch وبحدود التفويض القائم.

## 5. تغطية المواصفات ومعيار النهاية

| أقسام المواصفات | المهام |
| --- | --- |
| 1–4: الغرض والقرارات والموصلات وحدود المكونات | 1–5، 9، 11، 16 |
| 5–6: الإعداد والمساحات والوصول والنوافذ | 3–5، 10، 12، 16 |
| 7–10: المحتوى والسياسات والمراجعة والرفع والأسماء | 2، 6–10، 16 |
| 11–13: الجدولة والاعتمادية والحصص والاحتفاظ | 3، 7–9، 11–13 |
| 14–15: الملخص والتقارير والمراقبة والحماية | 3–5، 12–14 |
| 16–18: البناء والتحديث والتحقق ومعايير القبول | 14–16 مع الاختبارات الخاصة بكل مهمة |
| 19–20: المصادر ومراجعة الاتساق | فحص الإصدارات أعلاه ومراجعة الخطة، ثم دليل المهمة 16 |

تراجع معايير القبول الـ23 بندًا بندًا في دليل الإصدار. تتحقق الطبقات المبكرة بالمحاكاة، والنهاية بالحسابات والتثبيت والمراقبة والنشر المؤكد واختبار NVDA. لا يغلق مشروع كامل حين يبقى معيار إلزامي بلا دليل.

## 6. مراجعة الخطة وتسليمها للتنفيذ

راجعت التغطية والواجهات وأسماء الحقول وتبعيات المهام والحالات الخمس في Review Focus. التجهيز يندمج مع ميزة تحتاجه، ولا توجد مهام لإعادة هيكلة لا تخدم التسليم. الاختبارات المعروضة تثبت السلوك المقصود؛ تفاصيل الأجسام والروتين تترك للتنفيذ.

الخطة تنتظر مراجعة المستخدم واختيار طريقة التنفيذ. الاختيار المقترح **Native**: ينفذ المساعد المهام بالتتابع في هذه الجلسة، ثم مراجعة مستقلة للفرع كاملًا؛ يناسب ترابط العقود ويقلل كلفة السياقات. البديل **Subagent-driven**: منفذ جديد ومراجع مستقل لكل مهمة، ثم مراجعة للفرع؛ يمنح فحصًا مستقلًا مبكرًا بكلفة سياقات أكثر. لا يبدأ التنفيذ قبل مراجعة هذه الخطة واختيار الطريقة.

