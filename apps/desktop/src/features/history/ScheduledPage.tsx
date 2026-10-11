import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import type { PostDetail, PublicationReceipt, Workspace } from '@mawjivo/core';
import { postList, postDetail, errorMessage } from '../../bridge';
import { PostDetails, stateNames } from './PostDetails';
export function ScheduledPage({
  workspace,
  onEdit,
}: {
  workspace: Workspace;
  onEdit: (detail: PostDetail) => void;
}): ReactElement {
  const [filter, setFilter] = useState<'all' | 'scheduled' | 'needsAction'>('scheduled'),
    [items, setItems] = useState<PublicationReceipt[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [detail, setDetail] = useState<PostDetail | null>(null),
    [message, setMessage] = useState(''),
    [loading, setLoading] = useState(true);
  const generation = useRef(0),
    alive = useRef(true);
  const refreshButton = useRef<HTMLButtonElement>(null),
    detailButtons = useRef(new Map<string, HTMLButtonElement>());
  async function load(append = false) {
    const id = ++generation.current;
    setLoading(true);
    setMessage('');
    try {
      const page = await postList(workspace, filter, append ? (cursor ?? undefined) : undefined);
      if (alive.current && id === generation.current) {
        setItems((previous) =>
          append
            ? [
                ...previous,
                ...page.items.filter(
                  (item) => !previous.some((existing) => existing.postId === item.postId),
                ),
              ]
            : page.items,
        );
        setCursor(page.nextCursor);
      }
    } catch (error) {
      if (alive.current && id === generation.current) setMessage(errorMessage(error));
    } finally {
      if (alive.current && id === generation.current) setLoading(false);
    }
  }
  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
      generation.current++;
    };
  }, [workspace.id, filter]);
  async function open(id: string) {
    try {
      const value = await postDetail(workspace, id);
      if (alive.current) setDetail(value);
    } catch (error) {
      if (alive.current) setMessage(errorMessage(error));
    }
  }
  const date = (instant: string | null) =>
    instant
      ? new Intl.DateTimeFormat('ar-EG', {
          dateStyle: 'medium',
          timeStyle: 'short',
          timeZone: workspace.timeZone,
        }).format(new Date(instant))
      : 'نشر فوري';
  return (
    <section aria-labelledby="history-heading">
      <h3 id="history-heading">سجل مساحة العمل</h3>
      <div className="form-field">
        <label htmlFor="history-filter">قائمة المنشورات</label>
        <select
          id="history-filter"
          value={filter}
          onChange={(event) => {
            setDetail(null);
            setItems([]);
            setFilter(event.target.value as typeof filter);
          }}
        >
          <option value="scheduled">المجدولة القادمة</option>
          <option value="needsAction">تحتاج إجراء</option>
          <option value="all">كل المنشورات</option>
        </select>
      </div>
      <button ref={refreshButton} type="button" disabled={loading} onClick={() => void load()}>
        تحديث القائمة
      </button>
      {message && <p className="operation-message">{message}</p>}
      {loading && !items.length ? (
        <p>جارٍ قراءة سجل الخدمة…</p>
      ) : !items.length ? (
        <p>لا توجد منشورات في هذه القائمة.</p>
      ) : (
        <ul>
          {items.map((post) => (
            <li key={post.postId}>
              <p>
                {date(post.dueAt)} — {stateNames[post.state]} — {post.targets.length} وجهات
              </p>
              <button
                type="button"
                ref={(button) => {
                  if (button) detailButtons.current.set(post.postId, button);
                  else detailButtons.current.delete(post.postId);
                }}
                aria-label={'تفاصيل المنشور ' + post.postId}
                onClick={() => void open(post.postId)}
              >
                تفاصيل المنشور
              </button>
            </li>
          ))}
        </ul>
      )}
      {cursor && (
        <button type="button" disabled={loading} onClick={() => void load(true)}>
          عرض المزيد
        </button>
      )}
      {detail && (
        <PostDetails
          key={detail.receipt.postId}
          workspace={workspace}
          detail={detail}
          onEdit={onEdit}
          onClose={() => {
            setDetail(null);
            (detailButtons.current.get(detail.receipt.postId) ?? refreshButton.current)?.focus();
          }}
          onChanged={(changed) => {
            setDetail(changed);
            void load();
          }}
        />
      )}
    </section>
  );
}
