import { exports } from 'cloudflare:workers';
import { beforeEach, expect, test, vi } from 'vitest';
import { encryptSecret, decryptSecret } from '../src/secrets';
import {
  resetTestData,
  testEnv,
  requestAs,
  ownerToken,
  limitedToken,
  revokedToken,
} from './helpers';
beforeEach(resetTestData);
test('revoked_device_gets_401', async () => {
  const response = await exports.default.fetch(requestAs(revokedToken, '/api/workspaces'));
  expect(response.status).toBe(401);
});
test('foreign_workspace_gets_403', async () => {
  const response = await exports.default.fetch(
    requestAs(limitedToken, '/api/workspaces/workspace-b'),
  );
  expect(response.status).toBe(403);
});
test('stale_workspace_version_gets_409_without_losing_latest_settings', async () => {
  const input = {
    name: 'اسم جديد',
    timeZone: 'Africa/Cairo',
    defaultPlatforms: ['x'],
    serviceProfileId: 'profile-1',
    expectedVersion: 1,
  };
  const first = await exports.default.fetch(
    requestAs(ownerToken, '/api/workspaces/workspace-a', input, 'PATCH'),
  );
  expect(first.status).toBe(200);
  const second = await exports.default.fetch(
    requestAs(ownerToken, '/api/workspaces/workspace-a', { ...input, name: 'اسم قديم' }, 'PATCH'),
  );
  expect(second.status).toBe(409);
  const saved = await exports.default.fetch(requestAs(ownerToken, '/api/workspaces/workspace-a'));
  expect(await saved.json()).toMatchObject({ name: 'اسم جديد', version: 2 });
});
test('same_plaintext_has_distinct_authenticated_ciphertexts', async () => {
  const context = { workspaceId: 'workspace-a', connectionId: 'connection-a', keyVersion: 1 };
  const first = await encryptSecret('synthetic-provider-token', context, testEnv());
  const second = await encryptSecret('synthetic-provider-token', context, testEnv());
  expect(first).not.toBe(second);
  expect(first).not.toContain('synthetic-provider-token');
  expect(await decryptSecret(first, context, testEnv())).toBe('synthetic-provider-token');
});
test('corrupted_ciphertext_and_foreign_aad_rejected_without_token_log', async () => {
  const log = vi.spyOn(console, 'error');
  const context = { workspaceId: 'workspace-a', connectionId: 'connection-a', keyVersion: 1 };
  const cipher = await encryptSecret('synthetic-provider-token', context, testEnv());
  const parts = cipher.split('.');
  parts[3] = '!' + parts[3]!.slice(1);
  await expect(decryptSecret(parts.join('.'), context, testEnv())).rejects.toMatchObject({
    code: 'SECRET_INVALID',
  });
  await expect(
    decryptSecret(cipher, { ...context, workspaceId: 'workspace-b' }, testEnv()),
  ).rejects.toMatchObject({ code: 'SECRET_INVALID' });
  expect(JSON.stringify(log.mock.calls)).not.toContain('synthetic-provider-token');
  log.mockRestore();
});
test('device_token_is_hashed_and_not_returned_by_workspace_api', async () => {
  const row = await testEnv()
    .DB.prepare('SELECT token_hash FROM devices WHERE id=?')
    .bind('owner')
    .first<{ token_hash: string }>();
  expect(row?.token_hash).toMatch(/^[a-f0-9]{64}$/);
  expect(row?.token_hash).not.toBe(ownerToken);
  const response = await exports.default.fetch(requestAs(ownerToken, '/api/workspaces'));
  const text = await response.text();
  expect(text).not.toContain(ownerToken);
  expect(JSON.parse(text)).toHaveLength(2);
});
test('concurrent_workspace_edits_have_one_winner', async () => {
  const input = {
    name: 'تعديل',
    timeZone: 'Africa/Cairo',
    defaultPlatforms: ['facebook'],
    serviceProfileId: 'profile-1',
    expectedVersion: 1,
  };
  const results = await Promise.all([
    exports.default.fetch(requestAs(ownerToken, '/api/workspaces/workspace-a', input, 'PATCH')),
    exports.default.fetch(requestAs(ownerToken, '/api/workspaces/workspace-a', input, 'PATCH')),
  ]);
  expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
});
