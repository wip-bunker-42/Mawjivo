import { useEffect, useState } from 'react';
import type { ReactElement, FormEvent } from 'react';
import type { Workspace, ReadinessItem } from '@mawjivo/core';
import { serviceRequest, native, errorMessage } from '../../bridge';
interface TelegramStatus {
  configured: boolean;
  chatId: string;
  daily: boolean;
  reports: { kind: string; state: string; error_code: string | null; updated_at_ms: number }[];
}
interface MonitorStatus {
  configured: boolean;
  lastCheckedAt: string | null;
  readiness: ReadinessItem[];
}
const reportStates: Record<string, string> = {
  sent: 'أُرسل',
  pending: 'ينتظر الإرسال',
  sending: 'جارٍ الإرسال',
  failed: 'راجع ربط البوت',
  uncertain: 'قد يكون وصل؛ افحص تليجرام',
};
export function TelegramPage({ workspace }: { workspace: Workspace | null }): ReactElement {
  const [botToken, setBotToken] = useState(''),
    [chatId, setChatId] = useState(''),
    [daily, setDaily] = useState(true),
    [configured, setConfigured] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(''),
    [reports, setReports] = useState<TelegramStatus['reports']>([]),
    [monitor, setMonitor] = useState<MonitorStatus | null>(null),
    [healthchecksKey, setHealthchecksKey] = useState(''),
    [monitorTimeZone, setMonitorTimeZone] = useState('Africa/Cairo'),
    [monitorChecks, setMonitorChecks] = useState<ReadinessItem[]>([]);
  useEffect(() => {
    let active = true;
    if (workspace)
      void Promise.all([
        serviceRequest<TelegramStatus>(
          workspace.serviceProfileId,
          'GET',
          `/api/workspaces/${workspace.id}/telegram`,
        ),
        serviceRequest<MonitorStatus>(workspace.serviceProfileId, 'GET', '/api/monitoring'),
      ])
        .then(([status, monitor]) => {
          if (active) {
            setConfigured(status.configured);
            setChatId(status.chatId);
            setDaily(status.daily);
            setReports(status.reports);
            setMonitor(monitor);
          }
        })
        .catch((error) => {
          if (active) setMessage(errorMessage(error));
        });
    return () => {
      active = false;
    };
  }, [workspace?.id]);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!workspace || busy) return;
    setBusy(true);
    setMessage('');
    try {
      const result = await serviceRequest<TelegramStatus>(
        workspace.serviceProfileId,
        'POST',
        `/api/workspaces/${workspace.id}/telegram`,
        { botToken, chatId, daily },
      );
      setBotToken('');
      setConfigured(result.configured);
      setReports(result.reports);
      setMessage('حُفظ ربط تليجرام لهذه المساحة.');
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  async function setupMonitoring(event: FormEvent) {
    event.preventDefault();
    if (!workspace || busy) return;
    setBusy(true);
    setMessage('');
    try {
      new Intl.DateTimeFormat('ar-EG', { timeZone: monitorTimeZone }).format();
      const checks = await native<ReadinessItem[]>('configure_monitoring', {
        profileId: workspace.serviceProfileId,
        apiKey: healthchecksKey,
        timeZone: monitorTimeZone,
      });
      setHealthchecksKey('');
      setMonitorChecks(checks);
      setMonitor(
        await serviceRequest<MonitorStatus>(workspace.serviceProfileId, 'GET', '/api/monitoring'),
      );
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-labelledby="telegram-heading">
      <h3 id="telegram-heading">تقارير بوتك في تليجرام</h3>
      {!workspace ? (
        <p>اختر مساحة عمل لإعداد التقارير.</p>
      ) : (
        <>
          <p>تصل مشكلات النشر وحسم النتائج عبر بوتك. أرسل له /start مرة واحدة قبل الربط.</p>
          <form onSubmit={(event) => void save(event)}>
            <fieldset disabled={busy}>
              <legend>ربط هذه المساحة</legend>
              <label htmlFor="telegram-token">رمز بوت تليجرام</label>
              <input
                id="telegram-token"
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={botToken}
                onChange={(event) => setBotToken(event.target.value)}
                required={!configured}
                aria-describedby="telegram-token-help"
              />
              <p id="telegram-token-help">
                {configured
                  ? 'الرمز محفوظ. اترك الحقل فارغًا للاحتفاظ به.'
                  : 'ضع رمز البوت الذي أنشأته عبر BotFather.'}
              </p>
              <label htmlFor="telegram-chat">معرف المحادثة</label>
              <input
                id="telegram-chat"
                value={chatId}
                onChange={(event) => setChatId(event.target.value)}
                required
                autoComplete="off"
              />
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={daily}
                  onChange={(event) => setDaily(event.target.checked)}
                />
                ملخص منتصف الليل عند وجود نشاط
              </label>
              <button type="submit">حفظ ربط تليجرام</button>
            </fieldset>
          </form>
          {message && <p className="operation-message">{message}</p>}
          <h4>آخر التقارير</h4>
          {reports.length ? (
            <ul>
              {reports.map((report, index) => (
                <li key={index}>
                  {report.kind === 'daily'
                    ? 'الملخص اليومي'
                    : report.kind === 'recovery'
                      ? 'حسم النتيجة'
                      : 'مشكلة نشر'}
                  : {reportStates[report.state] ?? 'راجع الحالة'}
                </li>
              ))}
            </ul>
          ) : (
            <p>لا توجد تقارير بعد.</p>
          )}
          <h4>المراقبة الخارجية</h4>
          <p>تنبيهات Healthchecks مستقلة عن الخدمة وتصل إلى بريدك المسجل.</p>
          <form onSubmit={(event) => void setupMonitoring(event)}>
            <fieldset disabled={busy}>
              <legend>تجهيز مراقبة هذه الخدمة</legend>
              <label htmlFor="healthchecks-key">مفتاح إدارة Healthchecks</label>
              <input
                id="healthchecks-key"
                type="password"
                autoComplete="off"
                value={healthchecksKey}
                onChange={(event) => setHealthchecksKey(event.target.value)}
                aria-describedby="healthchecks-key-help"
              />
              <p id="healthchecks-key-help">
                يُحفظ في خزنة جهازك. أدخله أول مرة، ثم اتركه فارغًا للاحتفاظ به. يحتاج مشروع
                Healthchecks إلى تكامل بريد مفعّل.
              </p>
              <label htmlFor="monitor-zone">منطقة موعد فحص الملخص</label>
              <input
                id="monitor-zone"
                value={monitorTimeZone}
                onChange={(event) => setMonitorTimeZone(event.target.value)}
                required
              />
              <p>ملخص كل مساحة يبقى مرتبطًا بمنطقتها الزمنية.</p>
              <button type="submit">تجهيز Healthchecks على بريدي</button>
            </fieldset>
          </form>
          {monitorChecks.map((item) => (
            <p key={item.code}>{item.messageAr}</p>
          ))}
          <p>
            {monitor?.configured
              ? 'روابط نبض الخدمة والملخص مُعدّة.'
              : 'أكمل إعداد روابط Healthchecks للخدمة وفق دليل المراقبة.'}
          </p>
          {monitor?.lastCheckedAt && (
            <p>
              آخر فحص:{' '}
              {new Intl.DateTimeFormat('ar-EG', {
                dateStyle: 'short',
                timeStyle: 'short',
                timeZone: workspace.timeZone,
              }).format(new Date(monitor.lastCheckedAt))}
            </p>
          )}
          {monitor?.readiness.map((item) => (
            <p key={item.code}>{item.messageAr}</p>
          ))}
        </>
      )}
    </section>
  );
}
