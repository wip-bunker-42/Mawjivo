# إصدارات Mawjivo الآلية وتنظيف التنزيلات — خطة التنفيذ

تعديل معتمد في 14 أكتوبر 2026: طلب المالك جعل المستودع عامًا ونقله إلى منظمتِه الوحيدة `wip-bunker-42`. يحل هذا الطلب محل شرط خصوصية المستودع السابق. تكون Releases التجريبية والإنتاجية عامة، مع بقاء التوقيع ودليل القبول شرطًا للنشر، واستمرار مرآة Cloudflare والتنظيف وبوابة اعتماد أول إصدار كما هي. لا تتغير حسابات المستخدم أو ملفا أسراره المحليان.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** يبني GitHub الإصدار المعتمد ويوقعه ويحفظه في Releases الخاصة وينشره على Cloudflare، ثم ينظف حزم الإصدارات القديمة بعد التحقق.

**Architecture:** تفصل أدوات الإصدار بين بناء الحزمة وتحققها ورفع مرشح اختبار وتفعيل تحديث الإنتاج والتنظيف. تظل روابط التنزيل العامة الحالية وتوقيع Tauri الحالي ثابتين؛ تستعمل أدوات التطوير ENV الواضح، وتستعمل Actions الأسرار الموجودة. تقود بيانات الحزمة ودليل قبول Windows وسجل الإصدارات القرارات، مع قفل GitHub وكتابات R2 المشروطة.

**Tech Stack:** Node 24.21.0، pnpm 12.11.2، Rust 1.99.0، Tauri 2.12.2 وupdater 2.13.3، GitHub Actions Windows 2025، وaws4fetch الحالي. يضاف `fast-xml-parser = 5.11.2` كاعتمادية تطوير فقط لقراءة استجابات S3 والحذف المجمع؛ تحققت النسخة من npm registry. لا يدخل parser أو أدوات الإصدار حزمة التطبيق.

**Spec:** [المواصفة المعتمدة](../specs/2026-10-13-mawjivo-portability-and-release-design.md).

**Execution:** تنفيذ مباشر باستخدام `superpowers:executing-plans` بعد [خطة نقل الإعدادات](2026-10-13-mawjivo-device-transfer.md). مراجعة واحدة للتغيير المجمع قبل التسليم، دون وكلاء منفصلين لكل مهمة. تحتاج الخطتان مراجعة المستخدم قبل التنفيذ.

## Global Constraints

- يبقى `wip-bunker-42/Mawjivo` خاصًا، والتنزيل والتحديث على `downloads.aimansour.com`، ومخزن الإصدارات `mawjivo-releases` بعلامة ملكية `mawjivo-release-store:v1`.
- الوسم الثابت `vX.Y.Z` المعتمد وحده ينشر إنتاجًا؛ أول نسخة لهذا التعديل `0.1.1`. لا نشر عند كل push ولا إعادة كتابة ملف إصدار ثابت ببايتات مختلفة.
- توقيع الإنتاج من `MAWJIVO_SIGNING_PRIVATE_KEY`، والاختبار من `MAWJIVO_TEST_SIGNING_PRIVATE_KEY`؛ يحافظ التحديث على `requireSignedVersion` والمفتاح العام الحالي.
- لا تفعيل إنتاج قبل دليل قبول Windows لنفس commit، ولا حذف قبل التحقق من تفعيل الإعلان الجديد وقراءة الإعلانات المحمية.
- أحدث إصدارين مستقرين وقناة الاختبار محميون؛ المهلة `7 * 24 * 60 * 60 * 1000` ms. حد المخزن `1_000_000_000` بايت يشمل أدوات الوسائط والمصادر.
- الحذف لحزم التطبيق المعروفة تحت `releases/` فقط؛ لا `updates/` أو علامات الملكية أو أدوات الوسائط أو مصادرها أو حاوية محتوى المستخدم.
- لا نسخة secrets أو signing private key في Git أو Releases أو Artifacts أو سجلات Actions.
- تعطل WebView الحالي عطل يجب تشخيصه وإصلاحه؛ لا يستبدل قبول التطبيق بنجاح بناء أو fixture يعلن نجاحًا بلا تشغيل.
- تبقى شروط Task 16 الأصلية واعتماد أول إصدار إنتاج مطلوبة. لا تغير الخطة الفرع الافتراضي أو صلاحية المستودع أو سياسة حماية الجهاز.

## Review Focus

1. إعادة تشغيل نشر فشل بعد رفع بعض الملفات يجب أن تستكمل الباقي دون ملف مختلف تحت الاسم نفسه؛ Task 1 وTask 4.
2. نشر وسم أقدم أو تغيير manifest من ناشر متزامن يجب ألا يرجع القناة إلى نسخة أقدم؛ Task 2 وTask 4.
3. ملف R2 اسمه يحوي XML escapes أو مسارًا يشبه الحزمة يجب ألا يصبح هدف حذف آخر بعد فك اسمه؛ Task 2.
4. الخطأ الجزئي في الحذف المجمع يجب أن يبقي سجل الملفات غير المحذوفة ودليل الحجم صحيحين؛ Task 2.
5. حزمة اختبار تحمل نفس رقم الإنتاج أو SIG مختلفًا يجب ألا تحل محل توقيع الإنتاج أو تفشل حفظ بيانات التحديث؛ Task 3 وTask 4.

## خريطة الملفات والواجهات

- `scripts/operator-release.mjs` و`release-env.mjs`: البناء المحلي من ENV الواضح، دون DPAPI.
- `release-store.mjs`: نقل R2 المحدود والتحقق من الملكية والـETag؛ `release-retention.mjs`: قرار الحذف وتنفيذه؛ `release-records.mjs`: سجل النسخ المنشورة.
- `release-publication.mjs` و`publish-release.mjs`: استكمال منطق نشر الحزمة وتفعيل القناة الحالي بدل إنشاء ناشر آخر.
- `accept-installed-update.mjs` و`windows-session.mjs`: قبول التطبيق والتحديث الحقيقي. `tools/release-acceptance-tauri.json`: إعداد baseline اختباري، لا حزمة مستخدم.
- `.github/workflows/release.yml`: تنسيق البناء والاختبار والأرشفة والنشر والتنظيف؛ تبقى CI الحالية للفحص العام.

### Task 1: البناء والتوقيع من ENV ونقل R2 القابل لإعادة المحاولة

**Files:** Create `scripts/release-env.mjs`, `operator-release.mjs`, `release-store.mjs`, `scripts/test/release-env.test.mjs`, `release-store.test.mjs`. Modify `scripts/publish-release.mjs`, `package.json`, `pnpm-lock.yaml`, `docs/user/development.md`.

**Interfaces:**

- `PackageInfo` هو مخطط `package-info.json` الموجود من `package-windows-release.mjs`؛ و`ReleasePackage` ناتج `verifyReleasePackage(directory, {channel})` الموجود، ببياناته و`objects` و`manifest`.
- `ReleaseEnv` قيم نصية للأسماء الحالية `MAWJIVO_SIGNING_PRIVATE_KEY`, `MAWJIVO_TEST_SIGNING_PRIVATE_KEY`, `MAWJIVO_RELEASE_ACCOUNT_ID`, `MAWJIVO_RELEASE_ACCESS_KEY_ID`, `MAWJIVO_RELEASE_SECRET_KEY`، مع كلمة مرور التوقيع الفارغة الحالية. يطابق بديل Tauri مفتاح الإنتاج عند وجود الاثنين.
- `loadReleaseEnv(path) -> Promise<ReleaseEnv>` يعيد المفاتيح المطلوبة ويميز غيابها برسالة لا تتضمن قيمة.
- `buildSignedRelease({envFile, output, channel, sourceCommit}) -> Promise<PackageInfo>` يستخدم الإصدار المزامن الحالي و`packageManagerInvocation`، ويمرر المفتاح إلى عملية Tauri في البيئة فقط.
- `createReleaseStore(credentials) -> ReleaseStore` يوفر `verifyOwnership()`, `listObjects(prefix)`, `inspect(object)`, `upload(object)`, `verifyPublic(object)`, `readManifest(channel)`, `putManifest(channel, manifest, expectedEtag)`, `readIndex()`, `putIndex(index, expectedEtag)`, `deleteObjects(keys)`.
- نتيجة القراءة `{value, etag}` أو `{value:null, etag:null}`؛ نتيجة الحذف `{deletedKeys, errors}`. تستخدم الكتابة `If-Match` أو `If-None-Match: *`، ويصبح 412 خطأ تعارض واضحًا.

- [x] **Step 1 — RED:** اختبر تحميل أسماء الأسرار الحالية وبديل `TAURI_SIGNING_PRIVATE_KEY` المتطابق، وعدم تضمين قيمة في stderr عند الغياب، وغياب أي استدعاء DPAPI. اختبر نقل R2: علامة ملكية خاطئة تمنع كل كتابة، وإعادة ملف مطابق تتخطى PUT، وملف مختلف يرفض، و412 لا يستبدل ملفًا، وpublic hash خاطئ يمنع نجاح الرفع. استخدم ملفات مؤقتة بكريدنشلز مصطنعة ومساعد `fakeStore` يسجل الأفعال، دون الاتصال بحساب المالك.

```js
assert.equal(loaded.MAWJIVO_SIGNING_PRIVATE_KEY, syntheticPrivateKey);
assert.ok(!capturedStderr.includes(syntheticPrivateKey));
assert.equal(capturedPutCalls.length, 0); // ملف مطابق أو ملكية خاطئة
await assert.rejects(uploadDifferentBytes, /IMMUTABLE/);
await assert.rejects(conditionalWriteConflict, /CONFLICT/);
```

- [x] **Step 2:** شغّل `node --test scripts/test/release-env.test.mjs scripts/test/release-store.test.mjs`؛ يتوقع فشل غياب الوحدات.
- [x] **Step 3 — GREEN:** افصل transport من ناشر R2 الموجود واستعمل `fast-xml-parser` بالإصدار المثبت. ارفض XML غير صالح والتكرار وحجم الاستجابة الأكبر من 2 MiB وPagination التي تتجاوز 20 صفحة من 1000 عنصر. استعمل نقلًا متدفقًا للبصمات والملفات، وأبق أسماء الحزمة وفحوص المدقق الأصلي الحالية. تقرأ الأداة المحلية ملف ENV بمسار صريح؛ لا تطبع أو تمرر private key في argv. تستخدم metadata لتجاوز تحميل ملف مطابق وتثبت محتواه العام قبل التفعيل.
- [x] **Step 4:** أعد الاختبارات ثم `pnpm test:scripts` و`pnpm check:secrets`. نفذ بناء حزمة محلية موقعة من ملف التطوير الحقيقي إلى `.tools/` باستخدام CLI الجديد، وتحقق منها بالمدقق الأصلي. لا تنشرها في هذه المهمة.
- [x] **Step 5:** احفظ commit: `feat: build signed releases from portable operator credentials`.

### Task 2: سجل الإصدارات وسياسة الحذف المتسقة

**Files:** Create `scripts/release-records.mjs`, `release-retention.mjs`, `scripts/test/release-retention.test.mjs`. Modify `release-store.mjs`, `release-publication.mjs`, `publish-release.mjs`, و`release-publication.test.mjs`.

**Interfaces:**

- `ReleaseRecord {version, sourceCommit, activatedAt, objects:[{key,bytes,sha256}]}`؛ سجل R2 `_mawjivo-release-index.json` يحوي `schemaVersion:1` و`records` ولا ينشره download Worker.
- `StagedRelease {release: ReleasePackage, verifiedObjectKeys: string[]}`؛ و`PublicationResult {version,sourceCommit,channel,cleanup:{deletedKeys,remainingBytes,errors}}`، ولا يمثل نجاح staging تفعيل قناة.
- `planReleaseCleanup({objects, records, productionManifest, testManifest, nowMs}) -> {deleteKeys, protectedKeys, candidateBytes}`؛ دالة بلا شبكة.
- `cleanupReleases(store, nowMs) -> Promise<{deletedKeys, remainingBytes, errors}>`؛ تقرأ الإعلانات والسجل الحاليين، وتستعمل الحذف المجمع وتكتب نتيجة الحذف المؤكدة فقط.
- `stageRelease(release, store) -> Promise<StagedRelease>` يتحقق من التوقيع ويرفع المفقود ويثبت القراءة العامة دون تفعيل إنتاج. `activateRelease(staged, acceptanceProof, store) -> Promise<PublicationResult>` يتحقق من الدليل والإصدار الحالي وETag، ويسجل التفعيل ثم يشغل التنظيف. تبقى واجهة `publishRelease(release, control)` القديمة wrapper متوافقة مع الاختبارات الحالية.

- [x] **Step 1 — RED:** أنشئ قائمة أربع نسخ إنتاج، ونسخة اختبار تحمل رقم نسخة إنتاج، وحزمة عمرها أقل من سبعة أيام، وملف `media-tools/sources.zip`، واسمًا يحوي `&amp;`/مسارًا غير مصنف. اختبر:

```js
assert.deepEqual(plan.deleteKeys.sort(), eligibleOlderPackageKeys.sort());
assert.ok(plan.protectedKeys.includes(activeManifestInstallerKey));
assert.ok(!plan.deleteKeys.some((key) => key.startsWith('media-tools/')));
```

ثبّت الرفض عند manifest مفقود أو مزور، والسلوك عند حد السبعة أيام بالضبط، وحماية كل ملفات الحزمة، ورفض وسم قديم أو ETag متغير. اختبر أن الحذف الجزئي لا يزيل سجل ملف فشل حذفه، وأن بقايا رفع فاشل لا تصنف إصدارًا مستقرًا.

- [x] **Step 2:** شغّل `node --test scripts/test/release-retention.test.mjs scripts/test/release-publication.test.mjs`؛ يتوقع الفشل الجديد.
- [x] **Step 3 — GREEN:** طبق الفرز بـSemVer ثابت، مع مقارنة النسخة النشطة قبل التفعيل. احم أحدث إصدارين فُعل إعلانهما وتحقق منه، وروابط manifest الاختبار، وكل مجموعة أحدث ملف فيها أصغر من المهلة. تستند قواعد legacy لملفات الاختبار الثلاثة الموجودة إلى prefix واسم مثبت Mawjivo موثق وLastModified، ولا تتوسع إلى ملفات مجهولة. توقف عن الحذف عند نقص دليل الإعلان أو السجل. افحص حد `1_000_000_000` بايت للموجود والجديد المفقود قبل الرفع؛ عند عدم كفايته أوقف النشر برسالة قابلة للإجراء، دون حذف مسبق أو تفعيل ناقص. يتحقق CAS عند تحديث السجل والإعلان، ويسجل فشل التنظيف بعد نشر ناجح دون إعادة الإعلان السابق.
- [x] **Step 4:** أعد الاختبارات و`pnpm test:scripts`. شغّل وضع عرض خطة تنظيف قراءة فقط على `mawjivo-releases` الحقيقي، وراجع قائمة الحماية والحذف دون حذف شيء. يختبر S3 bulk delete فعليًا على ملفات اختبار معزولة داخل مخزن اختبار مملوك بعلامة الملكية نفسها، وليس على وسائط المالك أو الإعلانات النشطة.
- [x] **Step 5:** احفظ commit: `feat: retain active release packages and clean eligible old downloads`.

### Task 3: قبول Windows الحقيقي ومعالجة تعطل WebView

**Files:** Create `scripts/windows-session.mjs`, `scripts/test/windows-session.test.mjs`, `tools/release-acceptance-tauri.json`. Modify `accept-installed-update.mjs`, `src-tauri/src/bin/acceptance_data.rs`, `.github/workflows/release.yml` في وضع الاختبار فقط.

**Interfaces:**

- `startWindowsAcceptanceSession({appPath, driverPath, edgeDriverPath, output}) -> Promise<{sessionId, binaryPath, close()}>`؛ يفحص مسار البرنامج الفعلي ويقيد انتظار بدء الجلسة إلى 60 ثانية، ويكتب diagnostics منقحة عند الفشل.
- `acceptInstalledUpdate({basePackage,nextPackage,driverPath,edgeDriverPath,output,productionCandidate}) -> Promise<AcceptanceProof>`؛ الدليل يحوي `sourceCommit`, `cleanInstall`, `signedUpdateVerified`, `profilePreserved`, `draftPreserved`, `vaultPreserved`, `installedBinarySha256`, `referenceBinarySha256`, `packageSha256`, و`packageVersion`. تستخرج بصمة التطبيق المرجعية من تثبيت نظيف مستقل لنفس المثبت الموقّع، وتقارنها ببصمة التطبيق بعد التحديث؛ لا تقارن بصمة التطبيق ببصمة ملف المثبت المختلف عنه.
- مسار `productionCandidate` يعمل على Windows runner مع مجلد بيانات الإنتاج الفارغ فقط؛ يرفض التشغيل فوق بيانات المالك. يظل مسار قبول التطبيق الاختباري القديم متاحًا محليًا.

- [ ] **Step 1 — RED/تشخيص:** استخرج من التشغيل السابق سبب انتهاء الجلسة قبلفتح منفذ WebView، وسجل تجربة CI صغيرة تعيد الفشل من نفس مدخلات Runtime/Driver. اختبر timeout، وظهور العملية دون جلسة، وخروج الطفل، وعدم تطابق المسار أو Runtime، وتأكد أن أيًا منها لا ينتج دليل قبول ناجحًا. لا تقترح تغييرات حماية النظام؛ استعمل تشخيص العملية والـWebView والبيئة قبل تعديل الإطلاق.

```js
await assert.rejects(startSessionWithNoWebView);
await assert.rejects(startSessionWithExitedChild);
assert.equal(writtenSuccessfulProofs.length, 0);
assert.equal(proof.installedBinarySha256, proof.referenceBinarySha256); // حالة النجاح الحقيقي
assert.equal(proof.packageSha256, verifiedPackage.sha256);
```

- [ ] **Step 2 — GREEN:** أصلح الحد الأدنى في factory تشغيل جلسة Windows/مطابقة Runtime وDriver، وأعد التشغيل الذي فشل. لا تستخدم fixture يحل محل تشغيل WebView ولا تخفض شرط الدليل. إذا بقي العطل، سجل السبب المثبت والمرحلة المتوقفة؛ يبقى الإنتاج غير مفعل ولا تمرر نجاحًا اصطناعيًا.
- [ ] **Step 3:** عمم قبول الإصدارات بدل assertions الثابتة `0.1.0 -> 0.1.1`، مع بقاء البداية أقل من النهاية. لاختبار أول حزمة إنتاج فعلية قبل تفعيل الإنتاج: ابن baseline `0.1.0` مع identifier الإنتاج الأصلي ومفتاح الاختبار وعنوان قناة الاختبار، داخل Windows runner الفارغ. تكون الحزمة التالية مثبت الإنتاج الفعلي ذاته، ببصمة وتوقيع الإنتاج النهائيين. أنشئ توقيع اختبار إضافيًا لنفس بايتات المثبت في مجلد مؤقت عبر `tauri signer sign --app-version <version>` باستخدام مفتاح الاختبار؛ يستخدم manifest الاختبار التوقيع الإضافي inline، ولا يكتب فوق `.sig` الإنتاج. يرفع `stageRelease` ملفات المرشح وتفعل قناة الاختبار وحدها لإثبات التنزيل والتحديث. بعد التحديث تفتح بايتات التطبيق الفعلية بإعداد إنتاجها، وتقارن البيانات والخزنة والمسودة. تثبت إعادة التثبيت النظيفة لنفس حزمة الإنتاج أيضًا. سجل ضبط baseline كمدخل اختباري، ولا توزعه بوصفه إصدار إنتاج.
- [ ] **Step 4:** شغّل `node --test scripts/test/windows-session.test.mjs` ثم workflow قبول الاختبار على نفس المصدر. النجاح يتطلب WebView حقيقيًا ومثبتًا موقّعًا مطابقًا وبقاء البيانات والخزنة، وتبقى قناة الإنتاج السابقة كما هي. تحقق من عدم دخول ملف ENV أو توقيع الاختبار المؤقت أو أدوات setup/acceptance في حزمة التطبيق.
- [ ] **Step 5:** احفظ commit: `fix: prove real Windows signed updates before production activation`.

### Task 4: Workflow الإنتاج والأرشفة الخاصة والنشر والتنظيف

**Files:** Create `scripts/github-release.mjs`, `scripts/test/github-release.test.mjs`, `scripts/test/release-workflow.test.mjs`. Modify `.github/workflows/release.yml`, `operator-release.mjs`, `package.json`, و`publish-release.mjs`.

**Interfaces:** `archiveGithubRelease({tag,packageDirectory,acceptanceProof,sourceCommit,mode}) -> Promise<{releaseId,assetIds}>`، حيث `mode` هو `production` أو `acceptance`. يتطلب الإنتاج tag ثابتًا `vX.Y.Z`؛ يستخدم قبول الاختبار tag مستقلًا `acceptance-vX.Y.Z-<commit8>` وRelease خاصة prerelease ولا يفعل إنتاجًا. تستعمل الوظيفة `gh` أو GitHub REST بمدخلات محددة وbody file؛ تصنع draft ثم تحفظ الحزمة والدليل وتنشر Release بعد نجاح الدليل. لا تنشئ token دائمًا؛ تستخدم Actions `GITHUB_TOKEN`، ويستخدم المطور تسجيل دخول gh الحالي عند تشغيله محليًا.

- [ ] **Step 1 — RED:** اختبر أن tag غير ثابت في وضع `production` أو نسخة لا تطابق المشروع أو دليل مصدر آخر يمنع الأرشفة/التفعيل. يثبت اختبار وضع `acceptance` السماح بوسم الاختبار المحدد وprerelease، ومنع تفعيل الإنتاج. اختبر draft جزئيًا وإعادة التشغيل لتستكمل الملفات المطابقة، ورفض أصل Release موجود ببايتات مختلفة. افحص Workflow: production مشروط بوسم ثابت، وpermissions كتابة Releases تخص النشر، وconcurrency واحدة لا تلغي النشر العامل، وcleanup تأتي بعد تحقق manifest، ولا تشمل artifacts أي `*.secrets.env` أو private key. يفشل اختبار production stage إذا اختلف `installedBinarySha256` عن `referenceBinarySha256`، أو اختلف `packageSha256` عن بصمة المثبت المعتمد.

```js
assert.equal(createdReleaseCount, 1); // إعادة نفس النشر
assert.equal(productionActivationsWithWrongSource.length, 0);
assert.equal(productionActivationsWithWrongHash.length, 0);
assert.ok(events.indexOf('verify-manifest') < events.indexOf('cleanup'));
assert.ok(!archivedAssetNames.some((name) => name.endsWith('.secrets.env')));
```

- [ ] **Step 2:** شغّل `node --test scripts/test/github-release.test.mjs scripts/test/release-workflow.test.mjs`؛ يتوقع فشل غياب المسار الآلي.
- [ ] **Step 3 — GREEN:** وسع Workflow الحالية بأوضاع `acceptance`, `production`, `cleanup`؛ تحفظ وظيفة replay القديمة كتشخيص لا ينشر. عند tag ثابت يتحقق المصدر وأرقام النسخة ويستعمل CI نفس commit أو يشغل الفحص اللازم، ثم ينفذ Task 3، ويحفظ Release الخاصة، ويفعل إنتاج Cloudflare وينظف. يستأنف رفع الملف المطابق ولا يرفع البيانات نفسها مجددًا. يشغل cleanup الأسبوعي على الفرع الافتراضي عندما توجد عليه Workflow بعد اعتماد الدمج الأصلي؛ لا يغير default branch من هذه المهمة. يحتفظ التشغيل اليدوي للاختبار بشرط عدم تفعيل الإنتاج.
- [ ] **Step 4:** نفذ `pnpm sync-version 0.1.1` و`pnpm sync-version --check`، ثم `pnpm verify` و`pnpm test:e2e`. شغّل Workflow اختبار المصدر النهائي، وافحص الأرشفة في Release خاصة prerelease للتجربة دون وسم إنتاج أو تفعيل قناته. أرشف المثبت و`.sig` و`package-info.json` والدليل؛ لا تعتمد Actions Artifacts ذات مدة قصيرة كأرشيف الإصدار الوحيد. اترك روابط الملفات ثابتة، وانقل حالة اختبار الأرشفة بشكل واضح حتى لا يقدم للمستخدم إصدارًا نهائيًا.
- [ ] **Step 5:** احفظ commit: `feat: automate private release archives and verified Cloudflare updates`.

### Task 5: التسليم والتحقق النهائي وتفعيل الإصدار المعتمد

**Files:** Modify `docs/user/development.md`, `docs/user/recovery.md`, `docs/user/install.md`, `docs/releases/0.1.0-verification.md`. Create `docs/releases/0.1.1.md`, `docs/releases/0.1.1-verification.md`. تحفظ الأدلة الخام المنقحة في `.tools/`، والأسرار في الملفين المحليين فقط.

**Interfaces:** تستعمل أداة البناء والنشر والدليل من Tasks 1–4، وملف الجهاز ووظائف النقل من الخطة الأولى؛ لا تتغير واجهة النشر الاجتماعي أو إعدادات المنصات.

- [ ] **Step 1:** راجع متطلبات المواصفة والخطتين مقابل الملفات والاختبارات، ونفذ المراجعة النهائية المجملة مرة واحدة وفق طريقة التنفيذ المعتمدة. أصلح الملاحظات المؤثرة باختبارات فشل ثم نجاح، ولا تكرر المراجعة بسبب قرب التسليم دون سبب جديد.
- [ ] **Step 2:** نفذ تحققًا نهائيًا جديدًا على commit التسليم: `pnpm verify`, `pnpm test:e2e`, `pnpm sync-version --check`, فحص الأسرار، وCI Windows ودليل التحديث الفعلي لنفس المصدر. لا تعيد اختبار كل شيء بعد النجاح ما لم تظهر تغييرات أو فشل جديد.
- [ ] **Step 3:** جهز المثبت النهائي وملف الجهاز الحالي، وأثبت قبوله والتحقق القراءة فقط من خدمته. ثبّت مرشح المالك بعد حفظ قاعدة بياناته والتأكد من عدم وجود رفع نشط، وفق مسار التثبيت المتحقق سابقًا. يجري المالك تجربة النقل وNVDA ومعايير Task 16 الباقية؛ توثق النتائج وحدود الاختبارات بوضوح.
- [ ] **Step 4:** بعد اكتمال شروط أول إصدار إنتاج واعتماده، أنشئ وسم `v0.1.1` على commit المختبر وادفعه. راقب Workflow الآلية حتى حفظ GitHub Release الخاصة وتفعيل Cloudflare والتحقق والتنظيف. افحص أن نسخة `0.1.0` تعرض تحديثًا صحيحًا إلى `0.1.1` في الاختبار المعزول، وأن ملف المثبت العام وبصمته وتوقيعه متطابقون مع Release. لا تنشر وسمًا عند فشل أي دليل مطلوب.
- [ ] **Step 5:** حدّث حالة الوثائق وسجل التقدم، وقدّم رابط التنزيل وصفحة Release الخاصة وطريقة استيراد ملف الجهاز ومواصلة التطوير من ملف ENV. لا تعلن اكتمال المشروع أو Task 16 إلا بعد اكتمال معاييرها فعلًا.
