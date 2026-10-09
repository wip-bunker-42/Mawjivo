import { beforeEach, expect, test, vi } from 'vitest';
import { collectExpiredAssets } from '../src/assets';
import { resetTestData, testEnv } from './helpers';
import { uploaded, postReference } from './asset-fixtures';
beforeEach(resetTestData);
const base = Date.parse('2026-10-10T00:00:00Z'),
  hour = 3_600_000;
async function age(id: string) {
  await testEnv()
    .DB.prepare('UPDATE assets SET created_at_ms=?,updated_at_ms=? WHERE id=?')
    .bind(base, base, id)
    .run();
}
test('abandoned_upload_retained_before_24h_and_removed_after', async () => {
  const { asset, key } = await uploaded();
  await age(asset.id);
  await collectExpiredAssets(new Date(base + 24 * hour - 1).toISOString(), testEnv());
  expect(await testEnv().MEDIA.head(key)).not.toBeNull();
  const result = await collectExpiredAssets(new Date(base + 24 * hour).toISOString(), testEnv());
  expect(await testEnv().MEDIA.head(key)).toBeNull();
  expect(result.releasedBytes).toBe(10);
});
test('completed_retained_48h_failed_retained_7d', async () => {
  const success = await uploaded(),
    failure = await uploaded();
  const successfulPost = await postReference(success.asset.id);
  const failedPost = await postReference(failure.asset.id, 'failed', 'failed');
  await age(success.asset.id);
  await age(failure.asset.id);
  await testEnv()
    .DB.prepare('UPDATE targets SET updated_at_ms=? WHERE post_id IN (?,?)')
    .bind(base, successfulPost.id, failedPost.id)
    .run();
  await collectExpiredAssets(new Date(base + 48 * hour - 1).toISOString(), testEnv());
  expect(await testEnv().MEDIA.head(success.key)).not.toBeNull();
  await collectExpiredAssets(new Date(base + 48 * hour).toISOString(), testEnv());
  expect(await testEnv().MEDIA.head(success.key)).toBeNull();
  expect(await testEnv().MEDIA.head(failure.key)).not.toBeNull();
  await collectExpiredAssets(new Date(base + 7 * 24 * hour - 1).toISOString(), testEnv());
  expect(await testEnv().MEDIA.head(failure.key)).not.toBeNull();
  await collectExpiredAssets(new Date(base + 7 * 24 * hour).toISOString(), testEnv());
  expect(await testEnv().MEDIA.head(failure.key)).toBeNull();
});
test('scheduled_and_unknown_references_are_protected_regardless_of_age', async () => {
  const scheduled = await uploaded(),
    unknown = await uploaded();
  await postReference(scheduled.asset.id, 'scheduled', 'ready');
  await postReference(unknown.asset.id, 'uncertain', 'uncertain');
  await age(scheduled.asset.id);
  await age(unknown.asset.id);
  const result = await collectExpiredAssets(
    new Date(base + 400 * 24 * hour).toISOString(),
    testEnv(),
  );
  const scheduledExists = !!(await testEnv().MEDIA.head(scheduled.key)),
    unknownExists = !!(await testEnv().MEDIA.head(unknown.key));
  expect(scheduledExists && unknownExists).toBe(true);
  expect(result.retainedUnknownCount).toBe(1);
});
test('failed_delete_keeps_capacity_reserved_until_a_confirmed_retry', async () => {
  const { asset, key } = await uploaded();
  await age(asset.id);
  const env = testEnv();
  const deletion = vi
    .spyOn(env.MEDIA, 'delete')
    .mockRejectedValueOnce(new Error('synthetic deletion outage'));
  try {
    const first = await collectExpiredAssets(new Date(base + 25 * hour).toISOString(), env);
    expect(first.failedCount).toBe(1);
    expect(first.releasedBytes).toBe(0);
    expect(await env.MEDIA.head(key)).not.toBeNull();
    const stored = await env.DB.prepare('SELECT state FROM assets WHERE id=?')
      .bind(asset.id)
      .first<{ state: string }>();
    expect(stored!.state).toBe('deleting');
    const second = await collectExpiredAssets(new Date(base + 25 * hour + 1).toISOString(), env);
    expect(second.releasedBytes).toBe(10);
    expect(await env.MEDIA.head(key)).toBeNull();
  } finally {
    deletion.mockRestore();
  }
});
test('concurrent_cleanup_reports_released_capacity_once', async () => {
  const { asset } = await uploaded();
  await age(asset.id);
  const env = testEnv(),
    remove = env.MEDIA.delete.bind(env.MEDIA);
  let count = 0,
    release!: () => void;
  const both = new Promise<void>((resolve) => {
    release = resolve;
  });
  const spy = vi.spyOn(env.MEDIA, 'delete').mockImplementation(async (key) => {
    count++;
    if (count === 2) release();
    await both;
    return remove(key);
  });
  try {
    const results = await Promise.all([
      collectExpiredAssets(new Date(base + 25 * hour).toISOString(), env),
      collectExpiredAssets(new Date(base + 25 * hour).toISOString(), env),
    ]);
    expect(results.reduce((sum, r) => sum + r.releasedBytes, 0)).toBe(10);
  } finally {
    spy.mockRestore();
  }
});
