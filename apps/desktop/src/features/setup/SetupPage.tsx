import { useState } from 'react';
import type { FormEvent, ReactElement } from 'react';
import { provisionService, errorMessage } from '../../bridge';
import type { ServiceProfile } from '../../bridge';
export function SetupPage({
  onReady,
}: {
  onReady: (profile: ServiceProfile) => void;
}): ReactElement {
  const [accountId, setAccountId] = useState(''),
    [apiToken, setApiToken] = useState('');
  const [r2AccessKeyId, setR2AccessKeyId] = useState(''),
    [r2SecretAccessKey, setR2SecretAccessKey] = useState('');
  const [zoneId, setZoneId] = useState(''),
    [domain, setDomain] = useState('');
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  const [checks, setChecks] = useState<{ label: string; state: string }[]>([]);
  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setMessage('جارٍ فحص الحساب وتجهيز الخدمة…');
    setChecks([]);
    try {
      const profile = await provisionService({
        accountId: accountId.trim(),
        apiToken: apiToken.trim(),
        r2AccessKeyId: r2AccessKeyId.trim(),
        r2SecretAccessKey: r2SecretAccessKey.trim(),
        zoneId: zoneId.trim() || null,
        domain: domain.trim() || null,
      });
      setMessage('الخدمة جاهزة. أضف حسابات النشر لمساحتك.');
      setChecks(
        ['قاعدة البيانات', 'تخزين الوسائط', 'مفاتيح رفع R2', 'تشفير بيانات الربط'].map((label) => ({
          label,
          state: 'جاهز',
        })),
      );
      onReady(profile);
    } catch (error) {
      setMessage(errorMessage(error));
      const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : '';
      const label =
        code === 'R2_CREDENTIALS_INVALID'
          ? 'مفاتيح رفع R2'
          : code === 'RESOURCE_NOT_OWNED'
            ? 'ملكية موارد الخدمة'
            : code === 'VAULT_UNAVAILABLE'
              ? 'خزنة النظام'
              : code === 'DESKTOP_REQUIRED'
                ? 'التطبيق المثبت'
                : 'ربط Cloudflare';
      setChecks([{ label, state: 'يحتاج إجراء' }]);
    } finally {
      setApiToken('');
      setR2SecretAccessKey('');
      setBusy(false);
    }
  }
  return (
    <section aria-labelledby="cloudflare-setup-heading">
      <h3 id="cloudflare-setup-heading">إعداد خدمة Cloudflare</h3>
      <p>أدخل بيانات حسابك لتجهيز الخدمة. تحفظ الأسرار في خزنة نظام التشغيل.</p>
      <form
        onSubmit={(event) => {
          void submit(event);
        }}
        aria-busy={busy}
      >
        <div className="form-field">
          <label htmlFor="cf-account">معرف حساب Cloudflare</label>
          <input
            id="cf-account"
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
            required
            minLength={32}
            maxLength={32}
            autoComplete="off"
            spellCheck={false}
            dir="ltr"
          />
        </div>
        <div className="form-field">
          <label htmlFor="cf-token">رمز Cloudflare API</label>
          <input
            id="cf-token"
            type="password"
            value={apiToken}
            onChange={(e) => setApiToken(e.target.value)}
            required
            autoComplete="off"
          />
        </div>
        <div className="form-field">
          <label htmlFor="r2-id">معرف مفتاح R2</label>
          <input
            id="r2-id"
            value={r2AccessKeyId}
            onChange={(e) => setR2AccessKeyId(e.target.value)}
            required
            autoComplete="off"
            dir="ltr"
          />
        </div>
        <div className="form-field">
          <label htmlFor="r2-secret">مفتاح R2 السري</label>
          <input
            id="r2-secret"
            type="password"
            value={r2SecretAccessKey}
            onChange={(e) => setR2SecretAccessKey(e.target.value)}
            required
            autoComplete="off"
          />
        </div>
        <details>
          <summary>نطاق خاص — اختياري</summary>
          <div className="form-field">
            <label htmlFor="cf-zone">معرف منطقة النطاق</label>
            <input
              id="cf-zone"
              value={zoneId}
              onChange={(e) => setZoneId(e.target.value)}
              autoComplete="off"
              dir="ltr"
            />
          </div>
          <div className="form-field">
            <label htmlFor="cf-domain">النطاق الفرعي للخدمة</label>
            <input
              id="cf-domain"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder="mawjivo.example.com"
              autoComplete="off"
              dir="ltr"
            />
          </div>
        </details>
        <button type="submit" className="primary" disabled={busy}>
          فحص وتجهيز الخدمة
        </button>
      </form>
      {message && <p className="operation-message">{message}</p>}
      {checks.length > 0 && (
        <section aria-labelledby="setup-checks-heading">
          <h3 id="setup-checks-heading">حالة فحص الخدمة</h3>
          <table>
            <thead>
              <tr>
                <th scope="col">البند</th>
                <th scope="col">الحالة</th>
              </tr>
            </thead>
            <tbody>
              {checks.map((check) => (
                <tr key={check.label}>
                  <th scope="row">{check.label}</th>
                  <td>{check.state}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </section>
  );
}
