// This module lives for the whole webview, including after a composer is unmounted.
interface Write {
  promise: Promise<void>;
  write: () => Promise<void>;
  failed: boolean;
}
const writes = new Map<string, Write>();
let preparing = false;
export const updatePreparing = (): boolean => preparing;
export const releaseUpdatePreparation = (): void => {
  preparing = false;
};
export function queueDraftWrite(key: string, write: () => Promise<void>): Promise<void> {
  const previous = writes.get(key);
  const entry: Write = {
    promise: (previous?.promise ?? Promise.resolve()).catch(() => {}).then(write),
    write,
    failed: false,
  };
  writes.set(key, entry);
  void entry.promise.then(
    () => {
      if (writes.get(key) === entry) writes.delete(key);
    },
    () => {
      entry.failed = true;
    },
  );
  return entry.promise;
}
export async function flushDraftWrites(): Promise<boolean> {
  preparing = true;
  try {
    await Promise.all(
      [...writes.values()].map((entry) => (entry.failed ? entry.write() : entry.promise)),
    );
    return true;
  } catch {
    return false;
  }
}
