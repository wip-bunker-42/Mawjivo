import { beforeEach, afterEach, test, expect, vi } from 'vitest';
import { introspectWorkflowInstance } from 'cloudflare:test';
import { hashPlan } from '@mawjivo/core';
import { submitPost, getPublicationReceipt } from '../src/posts';
import { bufferAdapter } from '../src/providers/buffer';
import { resetTestData, testEnv } from './helpers';
import { auth, publicationFixture } from './publication-fixture';
beforeEach(resetTestData);
afterEach(() => vi.restoreAllMocks());

test('the_actual_cloudflare_workflow_sleeps_and_claims_with_no_desktop_connection', async () => {
  const fixture = await publicationFixture(),
    submission = await fixture.submission();
  submission.plan.dueAt = new Date(Date.now() + 1500).toISOString();
  submission.planHash = await hashPlan(submission.plan);
  const receipt = await submitPost(auth, submission, fixture.env);
  const publish = vi
    .spyOn(bufferAdapter, 'publishBatch')
    .mockImplementation(async (_connection, targets) =>
      targets.map((target) => ({
        kind: 'rejected',
        channelId: target.channelId,
        error: { code: 'PROVIDER_AUTH', messageAr: 'أعد ربط حساب الاختبار.', retryable: true },
      })),
    );
  const id = 'runtime-' + crypto.randomUUID(),
    instance = await introspectWorkflowInstance(testEnv().PUBLISH, id);
  try {
    await testEnv().PUBLISH.create({ id, params: { postId: receipt.postId, revision: 1 } });
    await instance.waitForStatus('complete');
    expect(Date.now()).toBeGreaterThanOrEqual(Date.parse(receipt.dueAt!));
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0]![1][0]!.text).toBe('منشور مؤكد');
    expect((await getPublicationReceipt(auth, receipt.postId, fixture.env)).state).toBe('failed');
  } finally {
    await instance.dispose();
  }
}, 30000);

test('the_actual_workflow_tracks_acceptance_to_a_receipt_without_resending', async () => {
  const fixture = await publicationFixture(),
    receipt = await submitPost(auth, await fixture.submission(), fixture.env);
  const publish = vi
    .spyOn(bufferAdapter, 'publishBatch')
    .mockResolvedValue([
      { kind: 'accepted', channelId: 'publish-x', remoteId: 'actual-runtime-receipt' },
    ]);
  const reads = vi
    .spyOn(bufferAdapter, 'readReceipts')
    .mockResolvedValue([
      {
        remoteId: 'actual-runtime-receipt',
        state: 'published',
        publicUrl: 'https://x.com/test/status/1',
      },
    ]);
  const id = 'runtime-receipt-' + crypto.randomUUID(),
    instance = await introspectWorkflowInstance(testEnv().PUBLISH, id);
  try {
    await testEnv().PUBLISH.create({ id, params: { postId: receipt.postId, revision: 1 } });
    await instance.waitForStatus('complete');
    const final = await getPublicationReceipt(auth, receipt.postId, fixture.env);
    expect(final.state).toBe('published');
    expect(final.targets[0]!.publicUrl).toBe('https://x.com/test/status/1');
    expect(publish).toHaveBeenCalledTimes(1);
    expect(reads).toHaveBeenCalledTimes(1);
  } finally {
    await instance.dispose();
  }
}, 120000);
