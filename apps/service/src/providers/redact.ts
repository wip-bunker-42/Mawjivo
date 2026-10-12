import type { AppError } from '@mawjivo/core';
/** Provider messages and HTTP bodies are untrusted and may echo credentials. Never expose them. */
export function providerError(code: string, retryable = false): AppError {
  const messages: Record<string, string> = {
    PROVIDER_UNCERTAIN:
      'لم نتمكن من تأكيد استلام الطلب. لن نعيد النشر تلقائيًا؛ تحقق من حساب المنصة.',
    PROVIDER_RATE_LIMIT: 'وصل الحساب إلى حد الطلبات. ستستأنف الخدمة في الوقت المتاح.',
    PROVIDER_AUTH: 'يحتاج الحساب إلى إعادة الربط أو منح صلاحية النشر.',
    PROVIDER_CONTENT: 'رفضت المنصة المحتوى. راجع النص والوسائط قبل المحاولة.',
    PROVIDER_FAILED: 'أبلغت المنصة عن فشل النشر. راجع الحساب والوسائط.',
    PROVIDER_RECEIPT: 'تعذر التحقق من النتيجة الآن. ستستمر المتابعة.',
    PROVIDER_CHANNEL: 'حساب النشر غير جاهز أو لا ينتمي إلى مساحة العمل.',
    PROVIDER_CHECKPOINT: 'تعذر حفظ تقدم النشر. تحقق من المنصة قبل إعادة المحاولة.',
    FACEBOOK_LIKE_FAILED: 'نُشر المنشور؛ تعذر الإعجاب به باسم الصفحة. لا حاجة لإعادة النشر.',
    FACEBOOK_LIKE_UNCERTAIN: 'نُشر المنشور؛ تعذر حسم الإعجاب به باسم الصفحة. لا حاجة لإعادة النشر.',
  };
  return { code, messageAr: messages[code] ?? messages.PROVIDER_FAILED!, retryable };
}
export function retryAt(headers: Headers, now = Date.now()): string | undefined {
  const raw = headers.get('Retry-After');
  if (!raw) return undefined;
  const at = /^\d+(\.\d+)?$/.test(raw) ? now + Number(raw) * 1000 : Date.parse(raw);
  return Number.isFinite(at) ? new Date(Math.max(now, at)).toISOString() : undefined;
}
export function publicUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 4096) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}
export function instant(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const date = Date.parse(value);
  return Number.isFinite(date) ? new Date(date).toISOString() : undefined;
}
