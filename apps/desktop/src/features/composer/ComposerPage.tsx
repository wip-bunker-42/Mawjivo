import { useRef } from 'react';
import type { ReactElement } from 'react';
import { platforms, resolveSchedule } from '@mawjivo/core';
import type { Workspace, PostDetail } from '@mawjivo/core';
import { useComposer, platformNames } from './useComposer';
import { MediaPicker } from './MediaPicker';
import { PlatformFields } from './PlatformFields';
import { ReviewPage } from './ReviewPage';
import { SavedDrafts } from './SavedDrafts';
export function ComposerPage({
  workspace,
  editing,
  onReset,
}: {
  workspace: Workspace;
  editing?: PostDetail | undefined;
  onReset?: () => void;
}): ReactElement {
  const composer = useComposer(workspace, editing),
    reviewButton = useRef<HTMLButtonElement>(null),
    draft = composer.draft,
    caps = composer.caps;
  function closeReview() {
    composer.closeReview();
    reviewButton.current?.focus();
  }
  if (!draft || !caps)
    return (
      <section>
        <p>
          {composer.loading
            ? 'جارٍ فتح المسودة…'
            : composer.message || 'تعذر فتح المسودة. راجع إعدادات الخدمة.'}
        </p>
      </section>
    );
  const ambiguous = draft.scheduleLocal
    ? resolveSchedule(draft.scheduleLocal, draft.timeZone)
    : null;
  return (
    <section aria-labelledby="composer-heading">
      <h3 id="composer-heading">{draft.editingPost ? 'تعديل المنشور' : 'تفاصيل المنشور'}</h3>
      <SavedDrafts workspace={workspace} />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void composer.openReview();
        }}
      >
        <fieldset disabled={composer.submitted}>
          <legend>محتوى المنشور</legend>
          <div className="form-field">
            <label htmlFor="post-text">النص أو الوصف</label>
            <textarea
              id="post-text"
              rows={7}
              value={draft.text}
              onChange={(e) => composer.patch({ text: e.target.value })}
            />
          </div>
          {draft.assets.some((asset) => asset.kind === 'video') && (
            <div className="form-field">
              <label htmlFor="video-title">عنوان الفيديو</label>
              <input
                id="video-title"
                required
                value={draft.title}
                onChange={(e) => composer.patch({ title: e.target.value })}
                aria-describedby="video-title-help"
              />
              <p id="video-title-help">
                نستخدم العنوان لاسم الملف عند إرساله وللمنصات التي تتطلب عنوانًا.
              </p>
            </div>
          )}
          <MediaPicker
            assets={draft.assets}
            jobs={composer.jobs}
            disabled={composer.loading}
            onPick={() => void composer.pick()}
            onRemove={composer.remove}
            onMove={composer.reorder}
            onResume={(job) => void composer.resume(job)}
          />
          <fieldset>
            <legend>منصات النشر</legend>
            {platforms.map((platform) => {
              const channels = caps.channels.filter((c) => c.platform === platform),
                selected = channels.find((c) => draft.selections.includes(c.id));
              return (
                <div key={platform} className="platform-setting">
                  <label>
                    <input
                      type="checkbox"
                      checked={Boolean(selected)}
                      disabled={!channels.some((c) => c.ready)}
                      onChange={(e) => composer.choose(platform, e.target.checked)}
                    />
                    {platformNames[platform]}
                  </label>
                  {!channels.some((c) => c.ready) && <span> — يحتاج ربطًا</span>}
                  {selected && channels.filter((c) => c.ready).length > 1 && (
                    <div className="form-field">
                      <label htmlFor={'channel-' + platform}>
                        حساب {platformNames[platform]} لهذا المنشور
                      </label>
                      <select
                        id={'channel-' + platform}
                        value={selected.id}
                        onChange={(e) => composer.choose(platform, true, e.target.value)}
                      >
                        {channels
                          .filter((c) => c.ready)
                          .map((channel) => (
                            <option key={channel.id} value={channel.id}>
                              {channel.displayName ?? platformNames[platform]} (
                              {channel.provider === 'meta' ? 'Meta' : 'Buffer'})
                            </option>
                          ))}
                      </select>
                    </div>
                  )}
                  {selected && (
                    <PlatformFields
                      channel={selected}
                      draft={draft}
                      onChange={(value) => composer.override(platform, value)}
                      onSplit={() => composer.split(platform)}
                    />
                  )}
                </div>
              );
            })}
          </fieldset>
          <fieldset>
            <legend>موعد النشر</legend>
            <label>
              <input
                type="checkbox"
                checked={draft.scheduleLocal !== null}
                onChange={(e) => composer.schedule(e.target.checked)}
              />
              جدولة النشر
            </label>
            {draft.scheduleLocal !== null && (
              <>
                <div className="form-field">
                  <label htmlFor="schedule-time">وقت النشر</label>
                  <input
                    id="schedule-time"
                    type="datetime-local"
                    step="0.001"
                    required
                    value={draft.scheduleLocal}
                    onChange={(e) => composer.scheduleTime(e.target.value)}
                  />
                  <p>
                    المنطقة الزمنية: <bdi>{workspace.timeZone}</bdi>
                  </p>
                </div>
                {ambiguous?.kind === 'ambiguous' && (
                  <div className="form-field">
                    <label htmlFor="schedule-offset">إزاحة الوقت للموعد المتكرر</label>
                    <select
                      id="schedule-offset"
                      required
                      value={draft.scheduleOffset ?? ''}
                      onChange={(e) => composer.patch({ scheduleOffset: e.target.value })}
                    >
                      <option value="">اختر إزاحة الوقت</option>
                      {ambiguous.offsets.map((offset) => (
                        <option key={offset} value={offset}>
                          {offset}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </>
            )}
          </fieldset>
        </fieldset>
        {composer.message && !composer.review && (
          <p className="operation-message">{composer.message}</p>
        )}
        <div className="button-row">
          <button
            ref={reviewButton}
            type="submit"
            className="primary"
            disabled={composer.loading || composer.submitted}
          >
            مراجعة النشر
          </button>
          {(composer.submitted || draft.editingPost) && (
            <button
              type="button"
              onClick={() => {
                composer.reset();
                onReset?.();
              }}
            >
              بدء منشور جديد
            </button>
          )}
        </div>
      </form>
      {composer.review && (
        <ReviewPage
          plan={composer.review.plan}
          hash={composer.review.hash}
          timeZone={workspace.timeZone}
          ready={composer.assetsReady}
          sending={composer.sending}
          message={composer.message}
          onClose={closeReview}
          onConfirm={() => void composer.confirm()}
        />
      )}
    </section>
  );
}
