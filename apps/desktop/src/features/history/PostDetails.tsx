import { useState, useRef } from 'react';
import type { ReactElement } from 'react';
import type { PostDetail, PublicationState, Workspace } from '@mawjivo/core';
import { cancelPublication, retryPublication, errorMessage } from '../../bridge';
import { platformNames } from '../composer/useComposer';
export const stateNames: Record<PublicationState, string> = {
  draft: 'مسودة',
  preparing: 'حُفظ؛ ينتظر تثبيت عمل النشر',
  scheduled: 'مجدول',
  ready: 'ينتظر الإرسال أو حصة الحساب',
  sending: 'جارٍ الإرسال',
  accepted: 'قبلته المنصة؛ ننتظر النتيجة',
  published: 'نُشر',
  failed: 'لم يكتمل',
  cancelled: 'أُلغي',
  uncertain: 'نتيجة غير محسومة؛ تحتاج فحصًا',
};
export function PostDetails({
  workspace,
  detail,
  onEdit,
  onChanged,
  onClose,
}: {
  workspace: Workspace;
  detail: PostDetail;
  onEdit: (detail: PostDetail) => void;
  onChanged: (detail: PostDetail) => void;
  onClose: () => void;
}): ReactElement {
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  const canCancel = detail.receipt.targets.some((target) =>
    ['ready', 'scheduled', 'preparing', 'failed'].includes(target.state),
  );
  const canRetry = detail.receipt.canRetry === true;
  const shownCancel = useRef(canCancel),
    shownRetry = useRef(canRetry);
  async function act(kind: 'cancel' | 'retry') {
    if (busy || (kind === 'cancel' ? !canCancel : !canRetry)) return;
    setBusy(true);
    setMessage('');
    try {
      const receipt = await (kind === 'cancel' ? cancelPublication : retryPublication)(
        workspace,
        detail.receipt.postId,
        detail.receipt.revision,
      );
      onChanged({ ...detail, receipt, editable: kind === 'cancel' ? false : detail.editable });
      setMessage(
        kind === 'cancel'
          ? 'أُلغي النشر للوجهات التي لم تبدأ.'
          : 'حُفظ طلب إعادة المحاولة للوجهات الآمنة فقط.',
      );
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  const receipt = detail.receipt;
  return (
    <section aria-labelledby="post-detail-heading">
      <h3 id="post-detail-heading">تفاصيل المنشور</h3>
      <p>{stateNames[receipt.state]}</p>
      {receipt.targets.map((target) => (
        <section key={target.channelId} aria-label={platformNames[target.platform]}>
          <h4>
            {platformNames[target.platform]}: {stateNames[target.state]}
          </h4>
          {target.error && <p>{target.error.messageAr}</p>}
          {detail.plan.targets.find((plan) => plan.channelId === target.channelId)?.title && (
            <p>
              العنوان:{' '}
              {detail.plan.targets.find((plan) => plan.channelId === target.channelId)!.title}
            </p>
          )}
          <p className="post-preview">
            {detail.plan.targets.find((plan) => plan.channelId === target.channelId)?.text}
          </p>
          {target.publicUrl && (
            <p>
              <a href={target.publicUrl} target="_blank" rel="noreferrer">
                فتح المنشور على {platformNames[target.platform]}
              </a>
            </p>
          )}
          {target.parts && (
            <ol>
              {target.parts.map((part) => (
                <li key={part.partIndex}>{stateNames[part.state]}</li>
              ))}
            </ol>
          )}
        </section>
      ))}
      {message && <p className="operation-message">{message}</p>}
      <div className="button-row">
        {detail.editable && (
          <button type="button" disabled={busy} onClick={() => onEdit(detail)}>
            تعديل المنشور
          </button>
        )}
        {(shownCancel.current || canCancel) && (
          <button
            type="button"
            aria-disabled={busy || !canCancel}
            onClick={() => void act('cancel')}
          >
            إلغاء الوجهات التي لم تبدأ
          </button>
        )}
        {(shownRetry.current || canRetry) && (
          <button type="button" aria-disabled={busy || !canRetry} onClick={() => void act('retry')}>
            إعادة محاولة الوجهات الآمنة
          </button>
        )}
        <button type="button" disabled={busy} onClick={onClose}>
          إغلاق التفاصيل
        </button>
      </div>
    </section>
  );
}
