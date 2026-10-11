import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { Temporal } from '@js-temporal/polyfill';
import type { Summary, Workspace } from '@mawjivo/core';
import { workspaceSummary, errorMessage } from '../../bridge';
export function SummaryPage({ workspace }: { workspace: Workspace }): ReactElement {
  const [date, setDate] = useState(() =>
      Temporal.Now.zonedDateTimeISO(workspace.timeZone).toPlainDate().toString(),
    ),
    [summary, setSummary] = useState<Summary | null>(null),
    [message, setMessage] = useState(''),
    [loading, setLoading] = useState(true);
  const active = useRef(true),
    generation = useRef(0);
  async function load() {
    const id = ++generation.current;
    setLoading(true);
    setMessage('');
    try {
      const result = await workspaceSummary(workspace, date);
      if (active.current && id === generation.current) setSummary(result);
    } catch (error) {
      if (active.current && id === generation.current) setMessage(errorMessage(error));
    } finally {
      if (active.current && id === generation.current) setLoading(false);
    }
  }
  useEffect(() => {
    active.current = true;
    void load();
    return () => {
      active.current = false;
      generation.current++;
    };
  }, [workspace.id]);
  return (
    <section aria-labelledby="summary-heading">
      <h3 id="summary-heading">ملخص النشر</h3>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void load();
        }}
      >
        <div className="form-field">
          <label htmlFor="summary-date">تاريخ الملخص</label>
          <input
            id="summary-date"
            type="date"
            value={date}
            required
            onChange={(event) => setDate(event.target.value)}
          />
        </div>
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
            <li>منشورات مكتملة: {summary.completePosts}</li>
            <li>نجاح جزئي: {summary.partialPosts}</li>
            <li>منشورات لم تكتمل: {summary.failedPosts}</li>
            <li>نتائج غير محسومة: {summary.unknownPosts}</li>
            <li>وجهات منشورة: {summary.publishedTargets}</li>
            <li>مجدولة قادمة: {summary.upcomingScheduled}</li>
          </ul>
          <p>المنشور المكتمل يُحسب مرة واحدة، ويظهر عدد الوجهات المنشورة بصورة منفصلة.</p>
        </>
      )}
      {loading && !summary && <p>جارٍ قراءة الملخص…</p>}
    </section>
  );
}
