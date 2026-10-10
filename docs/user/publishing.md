# النشر والمتابعة

ترسل الخدمة النشر الفوري إلى Buffer باستخدام shareNow وautomatic. موعد النشر يبقى في Cloudflare؛ لا نضع المنشور في طابور Buffer. تجمع الخدمة حتى 30 قناة في طلب واحد، ثم تحفظ نتيجة كل قناة على حدة. قبول الطلب لا يعني وصول المنشور إلى المنصة.

عند انقطاع رد طلب النشر، تظهر نتيجة غير مؤكدة ولا تعاد الكتابة تلقائيًا. تبقى الوسائط محفوظة إلى أن يمكن التحقق أو يراجع المستخدم الحساب. أخطاء الصلاحيات والمحتوى تحتاج إجراء إصلاح. حد الطلبات يؤجل العمل وفق Retry-After والحصص التي تعيدها الخدمة.

تستخدم كل بيانات اعتماد Buffer ميزانيتها، حتى عند تكرارها في مساحات عمل مختلفة. يحتفظ Mawjivo باحتياطي 10% لمتابعة النتائج؛ فحص القنوات والنشر لا يستهلكانه. الحدود المجانية الأولية هي 100 طلب خلال 15 دقيقة و250 خلال يوم و3000 خلال 30 يومًا، وتضيق أو تتغير وفق الترويسات الفعلية. انتهاء النافذة المتحركة يسمح بطلب استطلاع واحد ولا يفترض تجدد الحصة كاملة. المصدر: [حدود Buffer](https://developers.buffer.com/guides/api-limits.html).

السلاسل في X وThreads تتضمن الجزء الأول وتحفظ ترتيب النصوص والصور. لا تعرض الواجهة معرفات أو نتائج منفصلة للأجزاء عندما لا توفرها واجهة Buffer؛ فشل السلسلة قد يحتاج مراجعة الأجزاء المنشورة بالفعل. المصدر: [إنشاء سلسلة](https://developers.buffer.com/examples/create-threaded-post.html).

ينشئ موصل Meta صور ألبوم Facebook بالترتيب ويحفظ معرف كل صورة قبل المتابعة. يتابع فيديو Facebook حتى تتأكد حالة النشر، ولا يعد انتهاء المعالجة وحده نجاحًا. ينشئ موصل Instagram حاوية الصورة أو الألبوم أو الريل، ويتابعها؛ FINISHED تعني الجاهزية لطلب النشر. يستلم نشر Instagram معرف الوسيط النهائي ثم يتأكد منه بقراءة مستقلة. تعتمد حقول Facebook على [Post في SDK الرسمي v26](https://github.com/facebook/facebook-python-business-sdk/blob/26.0.0/facebook_business/adobjects/post.py)، و[AdVideo](https://github.com/facebook/facebook-python-business-sdk/blob/26.0.0/facebook_business/adobjects/advideo.py)، و[VideoStatusPublishingPhase](https://github.com/facebook/facebook-python-business-sdk/blob/26.0.0/facebook_business/adobjects/videostatuspublishingphase.py). تعتمد قراءة Instagram على [IGMedia](https://github.com/facebook/facebook-python-business-sdk/blob/26.0.0/facebook_business/adobjects/igmedia.py).

تبدأ متابعة النتائج بعد دقيقة، ثم عند الدقيقة الخامسة والخامسة عشرة، ثم كل ساعة؛ تتأخر عند نفاد الحصة. لا تتحول النتيجة المعلقة إلى نجاح أو فشل لمجرد مرور الوقت، ولا يصدر أي طلب متابعة عند غياب منشورات معلقة. يتولى محرك النشر المجدول في Cloudflare هذه المواعيد.
