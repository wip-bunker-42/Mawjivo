import { useState } from 'react';
import type { Workspace } from '@mawjivo/core';
import { savedComposers, openSavedComposer, errorMessage } from '../../bridge';
import type { SavedComposer } from '../../bridge';
export function SavedDrafts({ workspace }: { workspace: Workspace }) {
  const [items, setItems] = useState<SavedComposer[]>([]),
    [selected, setSelected] = useState(''),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false);
  async function load() {
    setBusy(true);
    try {
      const result = await savedComposers(workspace.serviceProfileId, workspace.id);
      setItems(result);
      setSelected(result[0]?.windowId ?? '');
      setMessage(result.length ? '' : 'لا توجد مسودات في نوافذ مغلقة لهذه المساحة.');
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  async function open() {
    const item = items.find((item) => item.windowId === selected);
    if (!item) return;
    setBusy(true);
    try {
      await openSavedComposer(
        workspace.serviceProfileId,
        workspace.id,
        item.windowId,
        item.draftId,
      );
      setItems((current) => current.filter((other) => other.windowId !== item.windowId));
      setSelected('');
      setMessage('');
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="saved-drafts">
      <button type="button" disabled={busy} onClick={() => void load()}>
        عرض المسودات المحفوظة
      </button>
      {items.length > 0 && (
        <div className="form-field">
          <label htmlFor="saved-composer">المسودة المحفوظة</label>
          <select
            id="saved-composer"
            value={selected}
            disabled={busy}
            onChange={(e) => setSelected(e.target.value)}
          >
            <option value="">اختر مسودة</option>
            {items.map((item) => (
              <option key={item.windowId} value={item.windowId}>
                {item.preview || 'مسودة بلا نص'} —{' '}
                {new Date(item.createdAt).toLocaleString('ar-EG', { timeZone: workspace.timeZone })}
              </option>
            ))}
          </select>
          <button type="button" disabled={busy || !selected} onClick={() => void open()}>
            فتح المسودة في نافذة
          </button>
        </div>
      )}
      {message && <p className="operation-message">{message}</p>}
    </div>
  );
}
