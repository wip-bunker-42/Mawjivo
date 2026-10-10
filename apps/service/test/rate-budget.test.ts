import { beforeEach, expect, test } from 'vitest';
import { reserveRequests, observeRateLimits, nextReceiptAt } from '../src/providers/rate-budget';
import { bufferConnection, seedConnection } from './publishing-fixtures';
import { resetTestData, testEnv } from './helpers';
const now = '2026-10-10T12:00:00.000Z';
const limits = (remaining = 10) =>
  new Headers({
    RateLimit:
      '"100-in-15min"; r=' +
      remaining +
      '; t=600, "250-in-1day"; r=250; t=86400, "3000-in-30days"; r=3000; t=2592000',
    'RateLimit-Policy':
      '"100-in-15min"; q=100; w=900, "250-in-1day"; q=250; w=86400, "3000-in-30days"; q=3000; w=2592000',
    Date: 'Sat, 10 Oct 2026 12:00:00 GMT',
  });
beforeEach(async () => {
  await resetTestData();
  await seedConnection(bufferConnection);
});
test('two_clients_have_independent_budgets_and_receipts_keep_their_reserve', async () => {
  await seedConnection({
    ...bufferConnection,
    id: 'buffer-second',
    label: 'second',
    credentials: { apiKey: 'synthetic-buffer-second' },
  });
  await observeRateLimits(bufferConnection.id, limits(), now, testEnv());
  expect(await reserveRequests(bufferConnection.id, 1, 'publish', now, testEnv())).toEqual({
    kind: 'deferred',
    retryAt: '2026-10-10T12:10:00.000Z',
  });
  expect((await reserveRequests(bufferConnection.id, 1, 'receipt', now, testEnv())).kind).toBe(
    'allowed',
  );
  expect((await reserveRequests('buffer-second', 1, 'publish', now, testEnv())).kind).toBe(
    'allowed',
  );
});
test('duplicate_credentials_in_another_workspace_share_the_same_client_budget', async () => {
  await seedConnection({ ...bufferConnection, id: 'buffer-copy', workspaceId: 'workspace-b' });
  await observeRateLimits(bufferConnection.id, limits(), now, testEnv());
  expect((await reserveRequests('buffer-copy', 1, 'publish', now, testEnv())).kind).toBe(
    'deferred',
  );
});
test('concurrent_reservations_cannot_spend_the_same_final_receipt_credit', async () => {
  await observeRateLimits(bufferConnection.id, limits(1), now, testEnv());
  const decisions = await Promise.all([
    reserveRequests(bufferConnection.id, 1, 'receipt', now, testEnv()),
    reserveRequests(bufferConnection.id, 1, 'receipt', now, testEnv()),
  ]);
  expect(decisions.filter((d) => d.kind === 'allowed')).toHaveLength(1);
});
test('a_rolling_window_expiry_does_not_invent_a_full_new_quota', async () => {
  await observeRateLimits(bufferConnection.id, limits(0), now, testEnv());
  const later = '2026-10-10T12:10:01.000Z';
  const decisions = await Promise.all([
    reserveRequests(bufferConnection.id, 1, 'receipt', later, testEnv()),
    reserveRequests(bufferConnection.id, 1, 'receipt', later, testEnv()),
  ]);
  expect(decisions.filter((d) => d.kind === 'allowed')).toHaveLength(1);
});
test('receipts_back_off_without_fabricating_a_terminal_result', () => {
  expect(nextReceiptAt(now, 0)).toBe('2026-10-10T12:01:00.000Z');
  expect(nextReceiptAt(now, 1)).toBe('2026-10-10T12:05:00.000Z');
  expect(nextReceiptAt(now, 2)).toBe('2026-10-10T12:15:00.000Z');
  expect(nextReceiptAt(now, 3)).toBe('2026-10-10T13:15:00.000Z');
});
test('a_late_response_cannot_restore_credits_already_spent', async () => {
  await observeRateLimits(bufferConnection.id, limits(1), now, testEnv());
  const allowed = await reserveRequests(bufferConnection.id, 1, 'receipt', now, testEnv());
  expect(allowed.kind).toBe('allowed');
  await observeRateLimits(bufferConnection.id, limits(8), now, testEnv());
  expect((await reserveRequests(bufferConnection.id, 1, 'receipt', now, testEnv())).kind).toBe(
    'deferred',
  );
});
test('retry_after_blocks_all_work_for_only_the_affected_client', async () => {
  await observeRateLimits(
    bufferConnection.id,
    new Headers({ 'Retry-After': '120' }),
    now,
    testEnv(),
  );
  expect(await reserveRequests(bufferConnection.id, 1, 'receipt', now, testEnv())).toEqual({
    kind: 'deferred',
    retryAt: '2026-10-10T12:02:00.000Z',
  });
});
