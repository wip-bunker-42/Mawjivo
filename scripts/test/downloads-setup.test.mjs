import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ensureDownloads, downloadsOwner } from '../downloads-setup.mjs';
function fixture(snapshot, marker) {
  const calls = [];
  return {
    calls,
    control: {
      inspect: async () => snapshot,
      readMarker: async () => marker,
      createBucket: async () => calls.push('create'),
      writeMarker: async (value) => calls.push(['marker', value]),
      deploy: async () => calls.push('deploy'),
    },
  };
}
test('an existing foreign downloads bucket prevents all resource writes', async () => {
  const f = fixture({ bucketExists: true, workerExists: false }, 'unrelated project');
  await assert.rejects(ensureDownloads(f.control), /DOWNLOADS_OWNERSHIP/);
  assert.deepEqual(f.calls, []);
});
test('foreign Worker or DNS is detected before creating a new downloads bucket', async () => {
  for (const snapshot of [
    { bucketExists: false, workerExists: true, workerTags: [] },
    { bucketExists: false, workerExists: false, domainService: 'unrelated-worker' },
    { bucketExists: false, workerExists: false, foreignDns: true },
  ]) {
    const f = fixture(snapshot);
    await assert.rejects(ensureDownloads(f.control), /DOWNLOADS_OWNERSHIP/);
    assert.deepEqual(f.calls, []);
  }
});
test('a fresh store is marked before deployment and an owned store resumes without duplicate creation', async () => {
  const fresh = fixture({ bucketExists: false, workerExists: false });
  await ensureDownloads(fresh.control);
  assert.deepEqual(fresh.calls, ['create', ['marker', downloadsOwner], 'deploy']);
  const existing = fixture(
    {
      bucketExists: true,
      workerExists: true,
      workerTags: [downloadsOwner],
      domainService: 'mawjivo-downloads',
    },
    downloadsOwner,
  );
  await ensureDownloads(existing.control);
  assert.deepEqual(existing.calls, ['deploy']);
});
