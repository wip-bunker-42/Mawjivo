import { useState } from 'react';
import type { ReactElement } from 'react';
import { errorMessage, exportSettings, importSettings } from '../../bridge';

export function TransferPage({ onImported }: { onImported: () => Promise<void> }): ReactElement {
  const [busy, setBusy] = useState<'export' | 'import' | null>(null);
  const [message, setMessage] = useState('');
  async function transfer(importing: boolean): Promise<void> {
    if (busy) return;
    setBusy(importing ? 'import' : 'export');
    setMessage('');
    try {
      const result = await (importing ? importSettings() : exportSettings());
      if (result) {
        if (importing) await onImported();
        setMessage(
          `${importing ? 'تم ربط الإعدادات والحسابات.' : 'حُفظ ملف الإعدادات.'} ${result.services} خدمة، ${result.workspaces} مساحة عمل، ${result.connections} حسابات نشر.`,
        );
      }
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(null);
    }
  }
  return (
    <section aria-labelledby="transfer-heading" aria-busy={busy !== null}>
      <h3 id="transfer-heading">نقل الإعدادات والحسابات</h3>
      <p>
        احفظ ملف إعداداتك، ثم استورده بعد الفورمات أو على جهاز جديد للاتصال بنفس خدمة Cloudflare
        وحسابات النشر.
      </p>
      <p>
        الملف نص واضح بلا كلمة مرور ويحتوي على مفاتيح الربط. تحتاج إلى الإنترنت للتحقق من الخدمة.
        تبقى الجدولة والمنشورات في Cloudflare؛ المسودات والملفات المحلية تُنقل منفصلة.
      </p>
      <div className="transfer-actions">
        <button type="button" aria-disabled={busy !== null} onClick={() => void transfer(false)}>
          تصدير الإعدادات والحسابات
        </button>
        <button type="button" aria-disabled={busy !== null} onClick={() => void transfer(true)}>
          استيراد الإعدادات والحسابات
        </button>
      </div>
      {busy && <p>{busy === 'export' ? 'جارٍ تصدير الإعدادات…' : 'جارٍ استيراد الإعدادات…'}</p>}
      <p role="status" aria-label="نتيجة نقل الإعدادات" aria-atomic="true">
        {message}
      </p>
    </section>
  );
}
