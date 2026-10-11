import { useEffect, useRef } from 'react';
import type { ReactElement } from 'react';
import type { PostPlan } from '@mawjivo/core';
import { platformNames } from './useComposer';
export function ReviewPage({
  plan,
  hash,
  ready,
  sending,
  message,
  timeZone,
  onClose,
  onConfirm,
}: {
  plan: PostPlan;
  hash: string;
  ready: boolean;
  sending: boolean;
  message?: string | undefined;
  timeZone: string;
  onClose: () => void;
  onConfirm: () => void;
}): ReactElement {
  const dialog = useRef<HTMLDialogElement>(null),
    heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
    heading.current?.focus();
    return () => dialog.current?.close();
  }, []);
  function close(): void {
    if (sending) return;
    dialog.current?.close();
    onClose();
  }
  const date = plan.dueAt
    ? new Intl.DateTimeFormat('ar-EG', { dateStyle: 'full', timeStyle: 'short', timeZone }).format(
        new Date(plan.dueAt),
      )
    : null;
  return (
    <dialog
      ref={dialog}
      aria-labelledby="review-heading"
      data-plan-hash={hash}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
    >
      <h3 id="review-heading" ref={heading} tabIndex={-1}>
        هل تود فعلًا النشر؟
      </h3>
      <p>
        سيتم النشر على {plan.targets.length} منصات
        {date ? ' في ' + date + ' (' + timeZone + ').' : '.'}
      </p>
      {plan.notes.length > 0 && (
        <ul>
          {plan.notes.map((note, index) => (
            <li key={note.channelId + ':' + index}>{note.messageAr}</li>
          ))}
        </ul>
      )}
      {plan.excluded.length > 0 && (
        <>
          <h4>استبعاد {plan.excluded.length} وجهات</h4>
          <ul>
            {plan.excluded.map((target) => (
              <li key={target.channelId}>
                {platformNames[target.platform]}: {target.messageAr}
              </li>
            ))}
          </ul>
        </>
      )}
      {plan.targets.map((target) => (
        <details key={target.channelId}>
          <summary>تفاصيل {platformNames[target.platform]}</summary>
          {target.title && <p>العنوان: {target.title}</p>}
          {target.assets.some((asset) => asset.sentName) && (
            <p>
              اسم ملف الفيديو: <bdi>{target.assets.find((asset) => asset.sentName)!.sentName}</bdi>
            </p>
          )}
          {target.threadParts.length ? (
            <ol>
              {target.threadParts.map((part, index) => (
                <li key={index}>
                  <p className="post-preview">{part}</p>
                </li>
              ))}
            </ol>
          ) : (
            <p className="post-preview">{target.text}</p>
          )}
          {target.altTexts.length > 0 && (
            <>
              <h4>النصوص البديلة</h4>
              <ol>
                {target.altTexts.map((alt, index) => (
                  <li key={index}>{alt}</li>
                ))}
              </ol>
            </>
          )}
        </details>
      ))}
      {!ready && <p>يكتمل تجهيز الوسائط ورفعها قبل إتاحة الموافقة.</p>}
      {message && <p className="operation-message">{message}</p>}
      <div className="button-row">
        <button type="button" className="primary" disabled={!ready || sending} onClick={onConfirm}>
          {sending ? 'جارٍ الإرسال…' : 'موافق، انشر'}
        </button>
        <button type="button" disabled={sending} onClick={close}>
          رجوع للتعديل
        </button>
      </div>
    </dialog>
  );
}
