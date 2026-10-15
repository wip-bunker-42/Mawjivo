# Mawjivo

تطبيق سطح مكتب للنشر على الحسابات الاجتماعية، بواجهة عربية مظلمة ومهيأة لاستخدام لوحة المفاتيح وقارئات الشاشة. يعتمد على Tauri، ويستهدف Windows أساسًا. يستخدم كل مستخدم حساباته وخدمة Cloudflare الخاصة به لتنفيذ النشر والجدولة.

نزّل التطبيق من [أحدث إصدار على GitHub](https://github.com/wip-bunker-42/Mawjivo/releases/latest). تأتي تحديثات التطبيق من GitHub أيضًا.

الكود الحالي المدمج موجود في الفرع الافتراضي `main`. لتنزيله:

```sh
git clone https://github.com/wip-bunker-42/Mawjivo.git
```

- [التثبيت والاستخدام](docs/user/install.md).
- [استعادة الإعدادات والحسابات على جهاز جديد](docs/user/recovery.md).
- [التطوير والبناء والتوقيع والإصدارات](docs/user/development.md).
- [أدلة التحقق من الإصدار 0.1.2](docs/releases/0.1.2-verification.md).

توجد واجهة التطبيق في `apps/desktop`، وكود Rust في `apps/desktop/src-tauri`، وخدمة Cloudflare في `apps/service`. تحفظ `.github/workflows` إجراءات الفحص والبناء والإصدارات والصيانة.

ملف `mawjivo.secrets.env` مخصص للتطوير والتوقيع، و`mawjivo-device.secrets.env` لاستيراد إعدادات المستخدم وحساباته. يحفظهما المالك محليًا خارج Git؛ تفاصيل استخدامهما في الدليلين أعلاه.
