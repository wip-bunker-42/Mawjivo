import { beforeEach, afterEach, test, expect, vi } from 'vitest';
import { runMonitor } from '../src/monitoring';
import { resetTestData, testEnv } from './helpers';
import { auth, publicationFixture } from './publication-fixture';
import { submitPost } from '../src/posts';
import { runPublication } from '../src/workflows/publish';
import { workflowSteps } from './publication-fixture';
import { bufferAdapter } from '../src/providers/buffer';
const heartbeat = 'https://hc-ping.com/00000000-0000-4000-8000-000000000001';
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
  const fixture=await publicationFixture(),receipt=await submitPost(auth,await fixture.submission(),fixture.env);
  for(const instance of fixture.workflow.instances.values())instance.status=async()=>({status:'complete'});
  await fixture.env.DB.prepare("UPDATE targets SET state='accepted',claim_id='saved-claim',remote_id='accepted-id',next_check_ms=?,updated_at_ms=? WHERE post_id=?").bind(Date.now()-1,Date.now()-3600000,receipt.postId).run();
  await runMonitor('2026-10-11T09:00:00Z',fixture.env);
  expect(fixture.workflow.create.mock.calls[1]?.[0]).toMatchObject({params:{postId:receipt.postId,revision:1,receiptsOnly:true}});
  const write=vi.spyOn(bufferAdapter,'publishBatch');
  const read=vi.spyOn(bufferAdapter,'readReceipts').mockResolvedValue([{remoteId:'accepted-id',state:'published'}]);
  await runPublication({postId:receipt.postId,revision:1,...{receiptsOnly:true}},workflowSteps(),fixture.env);
  expect(write).not.toHaveBeenCalled();expect(read).toHaveBeenCalledTimes(1);
});

test('the_inactive_daily_job_pings_and_the_same_heartbeat_slot_is_not_duplicated',async () => {
  const fetcher=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>new Response('OK'));
  const daily='https://hc-ping.com/00000000-0000-4000-8000-000000000002',env={...testEnv(),HEARTBEAT_PING_URL:heartbeat,DAILY_PING_URL:daily};
  expect((await runMonitor('2026-10-11T21:00:00Z',env)).dailyEvaluated).toBe(true);
  await runMonitor('2026-10-11T21:00:30Z',env);
  const calls=fetcher.mock.calls.map(call=>String(call[0]));
  expect(calls.filter(url=>url===heartbeat)).toHaveLength(1);
  expect(calls).toContain(daily+'/start');expect(calls).toContain(daily);
  expect(calls.some(url=>url.includes('api.telegram.org'))).toBe(false);
});
