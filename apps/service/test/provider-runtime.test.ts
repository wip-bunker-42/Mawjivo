import { beforeEach, afterEach, test, expect, vi } from 'vitest';
import { providerJson } from '../src/providers/http';
import { bufferQuery, publishBatch } from '../src/providers/buffer';
import { resetTestData, testEnv } from './helpers';
import { seedConnection, bufferConnection, target } from './publishing-fixtures';
import { metaConnection } from './publishing-fixtures';
import { publishBatch as publishMetaBatch } from '../src/providers/meta';
import { saveTelegramSettings } from '../src/reports/settings';
import { sendReport } from '../src/reports/telegram';
import { auth } from './publication-fixture';
beforeEach(async () => {
  await resetTestData();
  await seedConnection(bufferConnection);
});
afterEach(() => vi.restoreAllMocks());
function network(body: unknown, status = 200) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    // Preserve the actual Workers Request validation; substitute only remote I/O.
    new Request(input, init);
    return Response.json(body, {
      status,
      ...(status === 302 ? { headers: { Location: 'https://foreign.test/' } } : {}),
    });
  });
}
test('provider_discovery_uses_a_request_accepted_by_the_actual_worker_runtime', async () => {
  network({ id: 'account-ready' });
  expect(await providerJson('https://provider.test/account', 'synthetic-secret')).toEqual({
    id: 'account-ready',
  });
});
test('buffer_discovery_uses_actual_worker_request_validation_before_remote_io', async () => {
  network({ data: { account: { organizations: [{ id: 'org-ready' }] } } });
  expect(
    await bufferQuery(bufferConnection, 'query{account{organizations{id}}}', {}, testEnv()),
  ).toEqual({ account: { organizations: [{ id: 'org-ready' }] } });
});
test('a_provider_redirect_does_not_follow_credentials_or_claim_a_definite_write_rejection', async () => {
  const io = network(
    {
      data: {
        p0: {
          __typename: 'PostActionSuccess',
          post: { id: 'may-have-created', status: 'sending' },
        },
      },
    },
    302,
  );
  const result = await publishBatch(bufferConnection, [await target('x')], testEnv());
  expect(result[0]!.kind).toBe('uncertain');
  expect(io).toHaveBeenCalledTimes(1);
});
test('a_meta_write_redirect_stays_uncertain_and_does_not_follow_the_location', async () => {
  await seedConnection(metaConnection);
  const io = network({ id: '12345_98765' }, 302);
  const result = await publishMetaBatch(
    metaConnection,
    [await target('facebook', metaConnection)],
    testEnv(),
  );
  expect(result[0]!.kind).toBe('uncertain');
  expect(io).toHaveBeenCalledTimes(1);
});
test('a_telegram_write_redirect_stays_uncertain_even_if_its_body_claims_rejection', async () => {
  await saveTelegramSettings(
    auth,
    'workspace-a',
    { botToken: '123456:' + 't'.repeat(35), chatId: '1234', daily: true },
    testEnv(),
  );
  const io = network({ ok: false, error_code: 400 }, 302);
  const report = {
    workspaceId: 'workspace-a',
    dedupeKey: 'runtime-redirect',
    kind: 'recovery' as const,
    textAr: 'تقرير اختبار',
  };
  expect((await sendReport(report, testEnv())).kind).toBe('uncertain');
  expect((await sendReport(report, testEnv())).kind).toBe('uncertain');
  expect(io).toHaveBeenCalledTimes(1);
});
