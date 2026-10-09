import { useEffect, useState } from 'react';
import type { FormEvent, ReactElement } from 'react';
import type {
  CapabilitySnapshot,
  ConnectionInput,
  ConnectionSummary,
  ReadinessItem,
  Workspace,
} from '@mawjivo/core';
import { errorMessage, serviceRequest } from '../../bridge';
import type { ServiceProfile } from '../../bridge';
const metaFields = [
  ['pageId', 'معرف صفحة Facebook'],
  ['pageAccessToken', 'رمز وصول صفحة Facebook'],
  ['userAccessToken', 'رمز وصول مستخدم Meta'],
  ['instagramId', 'معرف حساب Instagram المرتبط (اختياري)'],
] as const;
export function ConnectionsPage({
  profile,
  workspace,
}: {
  profile: ServiceProfile | null;
  workspace: Workspace | null;
}): ReactElement {
  const [provider, setProvider] = useState<ConnectionInput['provider']>('buffer'),
    [label, setLabel] = useState(''),
    [credentials, setCredentials] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState(''),
    [checks, setChecks] = useState<ReadinessItem[]>([]);
  const [connections, setConnections] = useState<ConnectionSummary[]>([]),
    [snapshot, setSnapshot] = useState<CapabilitySnapshot | null>(null);
  const base = workspace ? `/api/workspaces/${workspace.id}` : '';
  useEffect(() => {
    let active = true;
    if (profile && workspace)
      void Promise.all([
        serviceRequest<ConnectionSummary[]>(profile.id, 'GET', base + '/connections'),
        serviceRequest<CapabilitySnapshot>(profile.id, 'GET', base + '/capabilities'),
      ])
        .then(([items, caps]) => {
          if (active) {
            setConnections(items);
            setSnapshot(caps);
          }
        })
        .catch((error) => {
          if (active) setMessage(errorMessage(error));
        });
    return () => {
      active = false;
    };
  }, [profile?.id, workspace?.id, base]);
  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!profile || !workspace || busy) return;
    setBusy(true);
    setMessage('جارٍ حفظ الربط وفحصه…');
    setChecks([]);
    try {
      const result = await serviceRequest<ReadinessItem[]>(
        profile.id,
        'POST',
        base + '/connections',
        [{ provider, label: label.trim(), credentials } satisfies ConnectionInput],
      );
      setChecks(result);
      setMessage(
        result.every((check) => check.state === 'ready')
          ? 'حُفظ الربط. الحسابات جاهزة.'
          : 'حُفظ الربط. أصلح الحسابات الموضحة أدناه.',
      );
      const [items, caps] = await Promise.all([
        serviceRequest<ConnectionSummary[]>(profile.id, 'GET', base + '/connections'),
        serviceRequest<CapabilitySnapshot>(profile.id, 'GET', base + '/capabilities'),
      ]);
      setConnections(items);
      setSnapshot(caps);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setCredentials({});
      setBusy(false);
    }
  }
  async function refresh(): Promise<void> {
    if (!profile || !workspace || busy) return;
    setBusy(true);
    try {
      setSnapshot(
        await serviceRequest<CapabilitySnapshot>(profile.id, 'POST', base + '/capabilities', {}),
      );
      setMessage('اكتمل فحص الحسابات.');
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-labelledby="connections-heading">
      <h3 id="connections-heading">ربط حساب نشر</h3>
      {!workspace && <p>أضف مساحة عمل بعد تجهيز Cloudflare لتربط حساباتها.</p>}
      <p>أضف كل حساب Buffer باسم مختلف. لإعادة ربط حساب، استخدم اسمه السابق.</p>
      <form
        onSubmit={(event) => {
          void submit(event);
        }}
        aria-busy={busy}
      >
        <div className="form-field">
          <label htmlFor="connection-provider">طريقة الربط</label>
          <select
            id="connection-provider"
            value={provider}
            onChange={(event) => {
              setProvider(event.target.value as ConnectionInput['provider']);
              setCredentials({});
            }}
            disabled={busy}
          >
            <option value="buffer">Buffer</option>
            <option value="meta">Meta — Facebook وInstagram</option>
          </select>
        </div>
        <div className="form-field">
          <label htmlFor="connection-label">اسم الربط</label>
          <input
            id="connection-label"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            required
            maxLength={120}
            disabled={busy}
          />
        </div>
        {(provider === 'buffer' ? ([['apiKey', 'مفتاح Buffer API']] as const) : metaFields).map(
          ([key, name]) => (
            <div className="form-field" key={key}>
              <label htmlFor={'connection-' + key}>{name}</label>
              <input
                id={'connection-' + key}
                type={key === 'pageId' || key === 'instagramId' ? 'text' : 'password'}
                dir="ltr"
                autoComplete="off"
                spellCheck={false}
                value={credentials[key] ?? ''}
                onChange={(event) => {
                  const updated = { ...credentials };
                  if (event.target.value) updated[key] = event.target.value;
                  else delete updated[key];
                  setCredentials(updated);
                }}
                required={key !== 'instagramId'}
                maxLength={4096}
                disabled={busy}
              />
            </div>
          ),
        )}
        <button type="submit" className="primary" disabled={!profile || !workspace || busy}>
          حفظ وفحص الحساب
        </button>
      </form>
      {message && <p className="operation-message">{message}</p>}
      {checks.length > 0 && (
        <ul>
          {checks.map((check, index) => (
            <li key={check.code + ':' + index}>{check.messageAr}</li>
          ))}
        </ul>
      )}
      {connections.length > 0 && (
        <>
          <h3>الحسابات المحفوظة</h3>
          <ul>
            {connections.map((connection) => (
              <li key={connection.id}>
                {connection.label} —{' '}
                <bdi>{connection.provider === 'buffer' ? 'Buffer' : 'Meta'}</bdi>
                {connection.readiness
                  ?.filter((check) => check.state !== 'ready')
                  .map((check, index) => (
                    <p key={check.code + ':' + index}>{check.messageAr}</p>
                  ))}
              </li>
            ))}
          </ul>
        </>
      )}
      {workspace && (
        <>
          <h3>قنوات النشر</h3>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              void refresh();
            }}
          >
            إعادة فحص الحسابات
          </button>
          <p>تُحفظ نتيجة الفحص ليوم واحد. يعاد الفحص عند تغيير الرموز.</p>
          {snapshot?.channels.length ? (
            <table>
              <caption>حالة القنوات</caption>
              <thead>
                <tr>
                  <th scope="col">الحساب</th>
                  <th scope="col">المنصة</th>
                  <th scope="col">طريقة الربط</th>
                  <th scope="col">الحالة</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.channels.map((channel) => (
                  <tr key={channel.id}>
                    <td>{channel.displayName ?? channel.platform}</td>
                    <td>
                      <bdi>{channel.platform}</bdi>
                    </td>
                    <td>
                      <bdi>{channel.provider}</bdi>
                    </td>
                    <td>
                      {channel.ready ? 'جاهز' : (channel.readinessMessageAr ?? 'يحتاج إعادة ربط')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p>لا توجد قنوات نشر مرتبطة.</p>
          )}
        </>
      )}
    </section>
  );
}
