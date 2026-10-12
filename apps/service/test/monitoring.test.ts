import { beforeEach, afterEach, test, expect, vi } from 'vitest';
import { runMonitor } from '../src/monitoring';
import { resetTestData, testEnv } from './helpers';
import { auth, publicationFixture } from './publication-fixture';
import { submitPost, retryPost } from '../src/posts';
import { runPublication } from '../src/workflows/publish';
import { workflowSteps } from './publication-fixture';
import { bufferAdapter } from '../src/providers/buffer';
import service from '../src/index';
import { failureReport } from '../src/reports/telegram';
const heartbeat = 'https://hc-ping.com/00000000-0000-4000-8000-000000000001';
test('failure_report_names_the_post_and_points_to_its_live_summary', () => {
  const report = failureReport(
    'workspace-a',
    'post-1',
    1,
    {
      channelId: 'x',
      platform: 'x',
      state: 'uncertain',
      error: {
        code: 'PROVIDER_UNCERTAIN',
        messageAr: 'synthetic secret must stay private',
        retryable: false,
      },
    },
    'عنوان المنشور الواضح',
  );
  expect(report.textAr).toContain('عنوان المنشور الواضح');
  expect(report.textAr).toContain('«ملخص»');
  expect(report.textAr).not.toContain('synthetic secret');
});
beforeEach(async () => {
  await resetTestData();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-11T09:00:00Z'));
  await testEnv()
    .DB.prepare('UPDATE workspaces SET created_at_ms=?,updated_at_ms=?')
    .bind(Date.now(), Date.now())
    .run();
  await testEnv().MEDIA.put('mawjivo/owner-service-id', testEnv().SERVICE_ID);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
test('five_minute_heartbeat_requires_db_r2_and_progress', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('OK'));
  const env = { ...testEnv(), HEARTBEAT_PING_URL: heartbeat };
  expect((await runMonitor('2026-10-11T09:00:00Z', env)).serviceHealthy).toBe(true);
  expect(fetcher.mock.calls.map((call) => String(call[0]))).toContain(heartbeat);
  await testEnv().MEDIA.delete('mawjivo/owner-service-id');
  expect((await runMonitor('2026-10-11T09:05:00Z', env)).serviceHealthy).toBe(false);
  expect(fetcher.mock.calls.map((call) => String(call[0]))).toContain(heartbeat + '/fail');
});
test('one_client_rate_wait_is_not_dead_job', async () => {
  const fixture = await publicationFixture(),
    receipt = await submitPost(auth, await fixture.submission(), fixture.env);
  await fixture.env.DB.prepare(
    "UPDATE targets SET state='ready',next_check_ms=?,updated_at_ms=? WHERE post_id=?",
  )
    .bind(Date.now() + 3600000, Date.now() - 3600000, receipt.postId)
    .run();
  const result = await runMonitor('2026-10-11T09:00:00Z', {
    ...fixture.env,
    HEARTBEAT_PING_URL: heartbeat,
  });
  expect(result.serviceHealthy).toBe(true);
  expect(fixture.workflow.get).not.toHaveBeenCalled();
});
test('a_terminal_orphaned_send_is_uncertain_and_never_reissued', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('OK'));
  const fixture = await publicationFixture(),
    receipt = await submitPost(auth, await fixture.submission(), fixture.env);
  for (const instance of fixture.workflow.instances.values())
    instance.status = async () => ({ status: 'errored' });
  await fixture.env.DB.prepare(
    "UPDATE targets SET state='sending',claim_id='ambiguous-claim',claimed_at_ms=?,updated_at_ms=? WHERE post_id=?",
  )
    .bind(Date.now() - 3600000, Date.now() - 3600000, receipt.postId)
    .run();
  await runMonitor('2026-10-11T09:00:00Z', fixture.env);
  expect(
    await fixture.env.DB.prepare('SELECT state FROM targets WHERE post_id=?')
      .bind(receipt.postId)
      .first(),
  ).toMatchObject({ state: 'uncertain' });
  expect(fixture.workflow.create).toHaveBeenCalledTimes(1);
});

test('a_terminal_accepted_job_resumes_receipt_reads_without_a_second_write', async () => {
  const fixture = await publicationFixture(),
    receipt = await submitPost(auth, await fixture.submission(), fixture.env);
  for (const instance of fixture.workflow.instances.values())
    instance.status = async () => ({ status: 'complete' });
  await fixture.env.DB.prepare(
    "UPDATE targets SET state='accepted',claim_id='saved-claim',remote_id='accepted-id',next_check_ms=?,updated_at_ms=? WHERE post_id=?",
  )
    .bind(Date.now() - 1, Date.now() - 3600000, receipt.postId)
    .run();
  await runMonitor('2026-10-11T09:00:00Z', fixture.env);
  expect(fixture.workflow.create.mock.calls[1]?.[0]).toMatchObject({
    params: { postId: receipt.postId, revision: 1, receiptsOnly: true },
  });
  const write = vi.spyOn(bufferAdapter, 'publishBatch');
  const read = vi
    .spyOn(bufferAdapter, 'readReceipts')
    .mockResolvedValue([{ remoteId: 'accepted-id', state: 'published' }]);
  await runPublication(
    { postId: receipt.postId, revision: 1, ...{ receiptsOnly: true } },
    workflowSteps().step,
    fixture.env,
  );
  expect(write).not.toHaveBeenCalled();
  expect(read).toHaveBeenCalledTimes(1);
});

test('the_inactive_daily_job_pings_and_the_same_heartbeat_slot_is_not_duplicated', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('OK'));
  const daily = 'https://hc-ping.com/00000000-0000-4000-8000-000000000002',
    env = { ...testEnv(), HEARTBEAT_PING_URL: heartbeat, DAILY_PING_URL: daily };
  expect((await runMonitor('2026-10-11T21:00:00Z', env)).dailyEvaluated).toBe(true);
  await runMonitor('2026-10-11T21:00:30Z', env);
  const calls = fetcher.mock.calls.map((call) => String(call[0]));
  expect(calls.filter((url) => url === heartbeat)).toHaveLength(1);
  expect(calls).toContain(daily + '/start');
  expect(calls).toContain(daily);
  expect(calls.some((url) => url.includes('api.telegram.org'))).toBe(false);
});

test('the_scheduled_entrypoint_runs_the_monitor_without_a_desktop_request', async () => {
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (promise: Promise<unknown>) => pending.push(promise),
  } as unknown as ExecutionContext;
  await (service as ExportedHandler<Env>).scheduled!(
    { scheduledTime: Date.now(), cron: '* * * * *' } as ScheduledController,
    testEnv(),
    ctx,
  );
  await Promise.all(pending);
  expect(
    await testEnv()
      .DB.prepare("SELECT value_json FROM service_settings WHERE key='monitor:heartbeat'")
      .first(),
  ).not.toBeNull();
});

test('an_orphaned_meta_continuation_is_uncertain_and_is_not_polled_as_an_unpublished_container', async () => {
  const fixture = await publicationFixture(),
    receipt = await submitPost(auth, await fixture.submission(), fixture.env);
  for (const instance of fixture.workflow.instances.values())
    instance.status = async () => ({ status: 'errored' });
  await fixture.env.DB.prepare(
    "UPDATE targets SET state='accepted',claim_id='send-claim',continuation_claim_id='lost-write',remote_id='ig-container:123',provider_state_json=?,next_check_ms=?,updated_at_ms=? WHERE post_id=?",
  )
    .bind(
      JSON.stringify({ kind: 'instagram', containerId: '123', childIds: [] }),
      Date.now() - 1,
      Date.now() - 3600000,
      receipt.postId,
    )
    .run();
  await runMonitor('2026-10-11T09:00:00Z', fixture.env);
  expect(
    await fixture.env.DB.prepare('SELECT state FROM targets WHERE post_id=?')
      .bind(receipt.postId)
      .first(),
  ).toMatchObject({ state: 'uncertain' });
  expect(fixture.workflow.create).toHaveBeenCalledTimes(1);
});
test('an_explicit_safe_retry_clears_a_previous_receipts_only_generation', async () => {
  const fixture = await publicationFixture(),
    receipt = await submitPost(auth, await fixture.submission(), fixture.env);
  await fixture.env.DB.prepare(
    "UPDATE targets SET state='failed',claim_id=NULL,remote_id=NULL WHERE post_id=?",
  )
    .bind(receipt.postId)
    .run();
  await fixture.env.DB.prepare('UPDATE dispatch_outbox SET receipts_only=1 WHERE post_id=?')
    .bind(receipt.postId)
    .run();
  await retryPost(auth, receipt.postId, 1, fixture.env);
  expect(fixture.workflow.create.mock.calls[1]![0].params).not.toHaveProperty('receiptsOnly');
});

test('a_database_failure_sends_an_explicit_external_failure_without_reading_credentials_from_d1', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('OK'));
  const broken = {
    ...testEnv(),
    HEARTBEAT_PING_URL: heartbeat,
    DB: {
      prepare: () => {
        throw new Error('database unavailable');
      },
    } as unknown as D1Database,
  };
  expect((await runMonitor('2026-10-11T09:00:00Z', broken)).serviceHealthy).toBe(false);
  expect(fetcher.mock.calls.map((call) => String(call[0]))).toContain(heartbeat + '/fail');
});
test('r2_write_failure_and_a_live_job_without_progress_fail_the_service_heartbeat', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('OK'));
  const fixture = await publicationFixture(),
    receipt = await submitPost(auth, await fixture.submission(), fixture.env);
  await fixture.env.DB.prepare("UPDATE targets SET state='sending',updated_at_ms=? WHERE post_id=?")
    .bind(Date.now() - 3600000, receipt.postId)
    .run();
  await fixture.env.DB.prepare('UPDATE posts SET updated_at_ms=? WHERE id=?')
    .bind(Date.now() - 3600000, receipt.postId)
    .run();
  expect((await runMonitor('2026-10-11T09:00:00Z', fixture.env)).serviceHealthy).toBe(false);
  const broken = {
    ...testEnv(),
    MEDIA: {
      get: (...args: any[]) => testEnv().MEDIA.get(args[0]),
      put: () => {
        throw new Error('r2 write unavailable');
      },
    } as unknown as R2Bucket,
  };
  expect((await runMonitor('2026-10-11T09:05:00Z', broken)).serviceHealthy).toBe(false);
});
