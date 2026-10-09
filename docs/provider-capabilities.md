# قواعد النشر ومصادرها

مراجعة: 2026-10-09. فحص الربط لا ينشر محتوى. تُحفظ بيانات القنوات والجاهزية 24 ساعة، ويعيد تغيير الرموز أو زر الفحص تحديثها. تحفظ الرموز مشفرة؛ لا تحتوي الواجهة أو هذا الملف على رموز المستخدم.

| المسار | المرجع الأساسي |
| --- | --- |
| أحرف Buffer والعد والحقول | https://developers.buffer.com/guides/character-limits.html |
| قنوات Buffer وصلاحياتها | https://developers.buffer.com/types/ChannelConfiguration.html |
| حدود خطة Buffer | https://developers.buffer.com/types/OrganizationLimits.html |
| X عبر Buffer | https://support.buffer.com/articles/using-xtwitter-with-buffer-nA84XnWtuU |
| Threads عبر Buffer | https://support.buffer.com/articles/using-threads-with-buffer-HN9ZUFnVZv |
| TikTok عبر Buffer | https://support.buffer.com/articles/using-tiktok-with-buffer-oGEroY9Of2 |
| YouTube Shorts عبر Buffer | https://support.buffer.com/en-us/articles/using-youtube-shorts-with-buffer-Jl8iR6jIck |
| Facebook عبر Buffer | https://support.buffer.com/en-us/articles/using-facebook-with-buffer-jY1AM9fz2G |
| Instagram عبر Buffer | https://support.buffer.com/en-us/articles/using-instagram-with-buffer-YSjg2dXFV8 |
| Instagram عبر Meta | https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media |
| صور صفحة Facebook | https://developers.facebook.com/docs/graph-api/reference/page/photos/ |
| فيديو صفحة Facebook | https://developers.facebook.com/docs/graph-api/reference/page/videos/ |

تستخدم واجهة Meta الإصدار v26.0. نشر الصفحة يستخدم رمز الصفحة، مع `pages_manage_posts` و`pages_read_engagement` و`pages_show_list` ومهمة `CREATE_CONTENT`. Instagram يستخدم رمز المستخدم في مسار Facebook Login مع `instagram_basic` و`instagram_content_publish`؛ يُطابق الحساب الاحترافي المرتبط بالصفحة. لا تُطلب حقول Instagram Login من كائن IGUser في Facebook Login. لا تتوقف قناة Facebook السليمة إذا تعذر فحص Instagram.

في فحص حسابي Buffer الحاليين، أعادت إعدادات القنوات قواعد التعليقات فقط، لذلك لم تُستخدم لإثبات حدود المنشورات. تُقرأ حالة النشر والإغلاق والانقطاع من الحساب، وتؤخذ قواعد المنشورات من المراجع الرسمية أعلاه. المفتاحان لهما ميزانيتان مستقلتان؛ لا يجمع التطبيق الطلبات المتبقية في ميزانية مشتركة.

مرجع Buffer الخاص بالـAPI يحدد UTF-16 لـThreads، بينما صفحة المساعدة تصفه بعدد بايتات UTF-8. يعتمد التطبيق مرجع الـAPI، ويظل اختبار منشور عربي فعلي عبر تأكيد المستخدم شرط تحقق للإصدار. كما يعتمد 2,196 حرفًا لـInstagram عبر Buffer وفق مرجع الـAPI، مع احتساب كسر السطر بوحدتين، و5 وسوم وفق صفحة المنصة. Meta يحدد 2,200 حرف و30 وسمًا و20 إشارة في مرجعه الحالي. النص البديل يقتصر على أنواع الوسائط التي يثبت دعمها؛ Instagram وX يدعمانه للصور.

الحد الموثق لسلاسل X وThreads هو 25 جزءًا. قيمة `scheduledThreadsPerChannel` هي عدد السلاسل المتزامنة في طابور Buffer، لا عدد أجزائها. لا يعتمد التطبيق على طابور Buffer للجدولة. مرجع Threads يذكر 20 صورة في خانة عامة و10 في خانة carousel؛ يعتمد التطبيق حد carousel وهو 10.

حدود Facebook عبر Meta في التطبيق محافظة: نص 5,000 وحدة، فيديو حتى 1GB و4 ساعات وبنطاق أبعاد 9:16 إلى 16:9، ونص بديل حتى 1,000 وحدة. حدود الفيديو هذه سياسة للتطبيق مأخوذة من مسار Facebook الموثق عبر Buffer، وليست ادعاءً بأنها أقصى حدود Meta. صور Meta تصل إلى 10MB وفق مرجع Page Photos. TikTok النصي المستقل غير مفعّل حتى يثبت مسار نشره التلقائي؛ يدعم الربط الصور والفيديو حاليًا. تقتصر YouTube على Shorts حتى 180 ثانية وفق التصميم المعتمد.

تنفذ موائمات التهيئة واختبار المعالجة محليًا. يرسل Mawjivo أسماء الصور الأصلية وأسماء الفيديو المشتقة من العنوان. إعادة الترميز أو التسمية التي تجريها المنصة داخل خدمتها تخضع للمنصة نفسها؛ التحقق المقصود هو الاسم والمحتوى اللذان يرسلهما Mawjivo.
