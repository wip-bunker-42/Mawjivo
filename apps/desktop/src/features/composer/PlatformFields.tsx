import type { ReactElement } from 'react';
import type { Channel, Draft, Platform, PlatformOverride } from '@mawjivo/core';
import { platformNames } from './useComposer';
export function PlatformFields({
  channel,
  draft,
  onChange,
  onSplit,
}: {
  channel: Channel;
  draft: Draft;
  onChange: (value: Partial<PlatformOverride>) => void;
  onSplit: () => void;
}): ReactElement {
  const platform = channel.platform,
    name = platformNames[platform],
    override = draft.overrides[platform],
    parts = override?.threadParts ?? [];
  function setPart(index: number, text: string): void {
    onChange({ threadParts: parts.map((part, i) => (i === index ? text : part)) });
  }
  function move(index: number, to: number): void {
    const next = [...parts];
    const [part] = next.splice(index, 1);
    next.splice(to, 0, part!);
    onChange({ threadParts: next });
  }
  function alt(index: number, value: string): void {
    const next = draft.assets.map((_, i) => override?.altTexts?.[i] ?? draft.text);
    next[index] = value;
    onChange({ altTexts: next });
  }
  return (
    <details>
      <summary>تخصيص {name}</summary>
      <div className="form-field">
        <label htmlFor={'text-' + channel.id}>نص {name}</label>
        <textarea
          id={'text-' + channel.id}
          rows={4}
          value={override?.text ?? draft.text}
          onChange={(e) => onChange({ text: e.target.value })}
        />
      </div>
      <button type="button" onClick={() => onChange({ text: undefined })}>
        استخدام الوصف المشترك لـ{name}
      </button>
      {draft.assets.map((asset, index) =>
        channel.limits.altKinds?.includes(asset.kind) ? (
          <div className="form-field" key={asset.id}>
            <label htmlFor={'alt-' + channel.id + '-' + asset.id}>
              النص البديل {name} ل{asset.kind === 'image' ? 'لصورة' : 'لفيديو'} {index + 1}
            </label>
            <textarea
              id={'alt-' + channel.id + '-' + asset.id}
              rows={2}
              value={override?.altTexts?.[index] ?? draft.text}
              onChange={(e) => alt(index, e.target.value)}
            />
          </div>
        ) : null,
      )}
      {(platform === 'x' || platform === 'threads') && channel.limits.threadParts !== undefined && (
        <fieldset>
          <legend>سلسلة {name}</legend>
          <label>
            <input
              type="checkbox"
              checked={parts.length > 0}
              onChange={(e) =>
                onChange({
                  threadParts: e.target.checked ? [override?.text ?? draft.text] : undefined,
                })
              }
            />
            نشر سلسلة متصلة على {name}
          </label>
          {parts.length > 0 && (
            <>
              <div className="button-row">
                <button type="button" onClick={onSplit}>
                  تقسيم النص تلقائيًا لـ{name}
                </button>
                <button type="button" onClick={() => onChange({ threadParts: [...parts, ''] })}>
                  إضافة جزء إلى {name}
                </button>
                <button type="button" onClick={() => onChange({ threadParts: undefined })}>
                  إلغاء السلسلة
                </button>
              </div>
              {parts.map((part, index) => (
                <div className="thread-part" key={index}>
                  <div className="form-field">
                    <label htmlFor={'part-' + channel.id + '-' + index}>
                      جزء {index + 1} من سلسلة {name}
                    </label>
                    <textarea
                      id={'part-' + channel.id + '-' + index}
                      rows={3}
                      value={part}
                      onChange={(e) => setPart(index, e.target.value)}
                    />
                  </div>
                  <div className="button-row">
                    <button
                      type="button"
                      disabled={index === 0}
                      onClick={() => move(index, index - 1)}
                      aria-label={'نقل جزء ' + (index + 1) + ' من ' + name + ' لأعلى'}
                    >
                      لأعلى
                    </button>
                    <button
                      type="button"
                      disabled={index === parts.length - 1}
                      onClick={() => move(index, index + 1)}
                      aria-label={'نقل جزء ' + (index + 1) + ' من ' + name + ' لأسفل'}
                    >
                      لأسفل
                    </button>
                    <button
                      type="button"
                      onClick={() => onChange({ threadParts: parts.filter((_, i) => i !== index) })}
                      aria-label={'حذف جزء ' + (index + 1) + ' من ' + name}
                    >
                      حذف الجزء
                    </button>
                  </div>
                </div>
              ))}
            </>
          )}
        </fieldset>
      )}
    </details>
  );
}
