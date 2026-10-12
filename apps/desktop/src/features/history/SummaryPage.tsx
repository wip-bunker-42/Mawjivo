import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { Temporal } from '@js-temporal/polyfill';
import type { Summary, Workspace, PublicationReceipt, TargetReceipt } from '@mawjivo/core';
import { workspaceSummary, errorMessage } from '../../bridge';
import { DateTextInput } from '../../components/DateTextInput';
import { platformNames } from '../composer/useComposer';
import { stateNames } from './PostDetails';
const finished = new Set(['published', 'failed', 'cancelled']);
function targetState(post: PublicationReceipt, target: TargetReceipt): string {
  if (target.state === 'ready' && post.state === 'scheduled') return 'ينتظر موعد النشر';
  if (target.state === 'uncertain')
    return 'يحتاج تأكيدًا من الحساب؛ قد يكون نُشر ولم يصل رد القبول';
  return stateNames[target.state];
}
export function SummaryPage({ workspace }: { workspace: Workspace }): ReactElement {
  const [date, setDate] = useState(() =>
    Temporal.Now.zonedDateTimeISO(workspace.timeZone).toPlainDate().toString(),
  );
  const [selectedDate, setSelectedDate] = useState(date),
    [summary, setSummary] = useState<Summary | null>(null),
    [message, setMessage] = useState(''),
    [loading, setLoading] = useState(true);
  const active = useRef(true),
    generation = useRef(0),
    inFlight = useRef<string | null>(null);
  async function load(localDate = selectedDate, background = false): Promise<void> {
    if (inFlight.current === localDate) return;
    try {
      Temporal.PlainDate.from(localDate);
    } catch {
      setMessage('اكتب تاريخًا صالحًا بالصيغة يوم/شهر/سنة.');
      return;
    }
    const id = ++generation.current;
    inFlight.current = localDate;
    if (!background) {
      setLoading(true);
      setMessage('');
    }
    try {
      const result = await workspaceSummary(workspace, localDate);
      if (active.current && id === generation.current) {
        setSummary(result);
        setMessage('');
      }
    } catch (error) {
      if (active.current && id === generation.current) setMessage(errorMessage(error));
    } finally {
      if (inFlight.current === localDate) inFlight.current = null;
      if (active.current && id === generation.current) setLoading(false);
    }
  }
  useEffect(() => {
    active.current = true;
    void load(selectedDate);
    return () => {
      active.current = false;
      generation.current++;
    };
  }, [workspace.id, selectedDate]);
  const following = Boolean(
    summary?.items?.some((post) =>
      post.targets.some(
        (t) =>
          ['preparing', 'ready', 'sending', 'accepted'].includes(t.state) &&
          post.state !== 'scheduled',
      ),
    ),
  );
  useEffect(() => {
    if (!following) return;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void load(selectedDate, true);
    }, 15000);
    return () => clearInterval(timer);
  }, [following, selectedDate, workspace.id]);
  return (
    <section aria-labelledby="summary-heading">
      <h3 id="summary-heading">ملخص النشر</h3>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (date === selectedDate) void load(date);
          else setSelectedDate(date);
        }}
      >
        <DateTextInput id="summary-date" label="تاريخ الملخص" value={date} onChange={setDate} />
        <button type="submit" disabled={loading}>
          تحديث الملخص
        </button>
      </form>
      {message && <p className="operation-message">{message}</p>}
      {summary && (
        <>
          <p>
            التاريخ: <bdi>{summary.localDate}</bdi>؛ المنطقة الزمنية: <bdi>{summary.timeZone}</bdi>.
          </p>
          <ul>
            <li>
              منشورات استلمتها Cloudflare: {summary.receivedPosts ?? summary.items?.length ?? 0}
            </li>
            <li>منشورات يجري تنفيذها: {summary.processingPosts ?? 0}</li>
            <li>منشورات مكتملة: {summary.completePosts}</li>
            <li>نجاح جزئي: {summary.partialPosts}</li>
            <li>منشورات لم تكتمل: {summary.failedPosts}</li>
            <li>منشورات تحتاج تأكيد نتيجة منصة: {summary.unknownPosts}</li>
            <li>وجهات منشورة: {summary.publishedTargets}</li>
            <li>مجدولة قادمة: {summary.upcomingScheduled}</li>
          </ul>
          {following && (
            <p>تتحدث المتابعة تلقائيًا كل 15 ثانية أثناء التنفيذ، دون إعلانات صوتية.</p>
          )}
          <h3>متابعة المنشورات</h3>
          {summary.items?.length ? (
            summary.items.map((post) => (
              <section key={post.postId} aria-labelledby={'summary-post-' + post.postId}>
                <h4 id={'summary-post-' + post.postId}>
                  {post.preview ?? 'منشور ' + post.postId.slice(0, 8)}
                </h4>
                <p>استلمت Cloudflare المنشور. {stateNames[post.state]}</p>
                <p>
                  نتائج مؤكدة: {post.targets.filter((t) => finished.has(t.state)).length} من{' '}
                  {post.targets.length} منصات
                </p>
                <ul>
                  {post.targets.map((target) => (
                    <li key={target.channelId}>
                      <p>
                        {platformNames[target.platform]}: {targetState(post, target)}
                      </p>
                      <p>
                        المراحل:{' '}
                        {finished.has(target.state)
                          ? '3 من 3 — وصلت النتيجة النهائية'
                          : target.state === 'accepted'
                            ? '2 من 3 — قبلته المنصة، ننتظر نتيجة النشر'
                            : target.state === 'sending'
                              ? '1 من 3 — جارٍ إرسال الطلب'
                              : target.state === 'uncertain'
                                ? '1 من 3 — أُرسل الطلب، لكن رد المنصة لم يُحسم'
                                : '0 من 3 — ينتظر الإرسال'}
                      </p>
                      {target.error && <p>{target.error.messageAr}</p>}
                      {target.publicUrl && (
                        <a href={target.publicUrl} target="_blank" rel="noreferrer">
                          فتح المنشور على {platformNames[target.platform]}
                        </a>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            ))
          ) : (
            <p>لا توجد منشورات في هذا التاريخ.</p>
          )}
          {summary.hasMore && (
            <p>تظهر أحدث 20 منشورًا؛ بقية المنشورات متاحة من «المجدولة» ثم «كل المنشورات».</p>
          )}
        </>
      )}
      {loading && !summary && <p>جارٍ قراءة الملخص…</p>}
    </section>
  );
}
