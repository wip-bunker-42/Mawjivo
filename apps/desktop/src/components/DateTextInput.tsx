import type { ReactElement } from 'react';
import { Temporal } from '@js-temporal/polyfill';

function digits(value: string): string {
  return value.replace(/[٠-٩۰-۹]/g, (char) =>
    String(char.charCodeAt(0) - (char >= '۰' ? 0x6f0 : 0x660)),
  );
}
function display(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(.+))?$/.exec(value);
  return match ? `${match[3]}/${match[2]}/${match[1]}${match[4] ? ' ' + match[4] : ''}` : value;
}
function iso(value: string, withTime: boolean): string {
  const text = digits(value);
  const match =
    /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2})(\.\d{1,3})?)?)?$/.exec(
      text.trim(),
    );
  if (!match || Boolean(match[4]) !== withTime) return text;
  const date = `${match[3]}-${match[2]!.padStart(2, '0')}-${match[1]!.padStart(2, '0')}`;
  const result = withTime
    ? `${date}T${match[4]!.padStart(2, '0')}:${match[5]}${match[6] ? ':' + match[6] + (match[7] ?? '') : ''}`
    : date;
  try {
    if (withTime) Temporal.PlainDateTime.from(result);
    else Temporal.PlainDate.from(result);
    return result;
  } catch {
    return text;
  }
}
export function DateTextInput({
  id,
  label,
  value,
  onChange,
  withTime = false,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  withTime?: boolean;
}): ReactElement {
  return (
    <div className="form-field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="text"
        dir="ltr"
        required
        autoComplete="off"
        spellCheck={false}
        value={display(value)}
        onChange={(event) => onChange(iso(event.target.value, withTime))}
        aria-describedby={id + '-help'}
      />
      <p id={id + '-help'}>
        {withTime
          ? 'اكتب اليوم/الشهر/السنة ثم الساعة والدقيقة بنظام 24 ساعة، مثل 12/10/2026 20:30.'
          : 'اكتب اليوم/الشهر/السنة، مثل 12/10/2026.'}
      </p>
    </div>
  );
}
