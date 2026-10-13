import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
test('operator helper modules stay outside Tauri automatic executable discovery', async () => {
  const entries = await readdir(new URL('../../apps/desktop/src-tauri/src/bin/', import.meta.url), {
    withFileTypes: true,
  });
  assert.deepEqual(
    entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name),
    [],
  );
});
