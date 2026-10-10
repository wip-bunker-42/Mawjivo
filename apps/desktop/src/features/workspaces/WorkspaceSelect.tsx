import type { ReactElement } from 'react';
import type { Workspace } from '@mawjivo/core';
export function WorkspaceSelect({
  workspaces,
  value,
  onChange,
}: {
  workspaces: Workspace[];
  value: string;
  onChange: (id: string) => void;
}): ReactElement {
  return (
    <div className="workspace-field">
      <label htmlFor="workspace">مساحة العمل</label>
      <select
        id="workspace"
        disabled={!workspaces.length}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {!workspaces.length && <option value="">لم تُضف مساحة بعد</option>}
        {workspaces.map((w) => (
          <option key={w.id} value={w.id}>
            {w.name}
          </option>
        ))}
      </select>
    </div>
  );
}
