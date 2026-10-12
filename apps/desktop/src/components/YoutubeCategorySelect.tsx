import { youtubeCategoryIds, youtubeCategoryNames } from '@mawjivo/core';
import type { YoutubeCategoryId } from '@mawjivo/core';
import type { ReactElement } from 'react';
export function YoutubeCategorySelect({
  id,
  label,
  value,
  onChange,
  required = false,
  disabled = false,
}: {
  id: string;
  label: string;
  value: YoutubeCategoryId | null | undefined;
  onChange: (value: YoutubeCategoryId | undefined) => void;
  required?: boolean;
  disabled?: boolean;
}): ReactElement {
  return (
    <div className="form-field">
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        value={value ?? ''}
        required={required}
        disabled={disabled}
        onChange={(event) =>
          onChange(event.target.value ? (event.target.value as YoutubeCategoryId) : undefined)
        }
      >
        <option value="">اختر الفئة</option>
        {youtubeCategoryIds.map((category) => (
          <option key={category} value={category}>
            {youtubeCategoryNames[category]}
          </option>
        ))}
      </select>
    </div>
  );
}
