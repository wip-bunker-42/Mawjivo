import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../desktop-acceptance-worker.mjs';
test('desktop acceptance fixture exposes only nonsensitive read-only workspace and capabilities', async () => {
  const response = await worker.fetch(new Request('https://fixture.test/api/workspaces'));
  assert.equal(response.status, 200);
  assert.equal((await response.json())[0].id, 'acceptance-space');
  const capabilities = await worker.fetch(
    new Request('https://fixture.test/api/workspaces/acceptance-space/capabilities'),
  );
  assert.deepEqual((await capabilities.json()).channels, []);
});
test('desktop acceptance fixture has no publishing or credential-write route', async () => {
  assert.equal(
    (await worker.fetch(new Request('https://fixture.test/api/workspaces', { method: 'POST' })))
      .status,
    405,
  );
  assert.equal(
    (
      await worker.fetch(
        new Request('https://fixture.test/api/workspaces/acceptance-space/connections'),
      )
    ).status,
    404,
  );
});
