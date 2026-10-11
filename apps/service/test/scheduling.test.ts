import { beforeEach, afterEach, test, expect, vi } from 'vitest';
import { hashPlan } from '@mawjivo/core';
import { submitPost, getPublicationReceipt } from '../src/posts';
import { runPublication } from '../src/workflows/publish';
import { bufferAdapter } from '../src/providers/buffer';
import { resetTestData } from './helpers';
import { auth, publicationFixture, workflowSteps } from './publication-fixture';
beforeEach(async () => {
  await resetTestData();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-11T09:00:00Z'));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
test('sleep_uses_utc_instant_across_cairo_dst', async () => {
  vi.setSystemTime(new Date('2026-10-28T00:00:00Z'));
  const fixture = await publicationFixture(),
    submission = await fixture.submission({
      scheduleLocal: '2026-10-29T23:30',
      scheduleOffset: '+02:00',
    });
  const receipt = await submitPost(auth, submission, fixture.env),
    steps = workflowSteps();
  vi.spyOn(bufferAdapter, 'publishBatch').mockImplementation(async (_c, targets) =>
    targets.map((t) => ({ kind: 'accepted', channelId: t.channelId, remoteId: 'receipt-x' })),
  );
  vi.spyOn(bufferAdapter, 'readReceipts').mockResolvedValue([
    { remoteId: 'receipt-x', state: 'published' },
  ]);
  await runPublication({ postId: receipt.postId, revision: 1 }, steps.step, fixture.env);
  expect(steps.sleeps[0]!.toISOString()).toBe('2026-10-29T21:30:00.000Z');
});
test('computer_off_does_not_block_due_job', async () => {
  const fixture = await publicationFixture(),
    receipt = await submitPost(auth, await fixture.submission(), fixture.env);
  const providerWrites = vi
    .spyOn(bufferAdapter, 'publishBatch')
    .mockImplementation(async (_c, targets) =>
      targets.map((t) => ({
        kind: 'accepted',
        channelId: t.channelId,
        remoteId: 'offline-receipt',
      })),
    );
  vi.spyOn(bufferAdapter, 'readReceipts').mockResolvedValue([
    { remoteId: 'offline-receipt', state: 'published' },
  ]);
  await runPublication({ postId: receipt.postId, revision: 1 }, workflowSteps().step, fixture.env);
  expect(providerWrites).toHaveBeenCalledTimes(1);
  expect((await getPublicationReceipt(auth, receipt.postId, fixture.env)).state).toBe('published');
});
test('beyond_365_days_rejected', async () => {
  const fixture = await publicationFixture(),
    submission = await fixture.submission();
  submission.plan.dueAt = new Date(Date.now() + 366 * 86400000).toISOString();
  submission.planHash = await hashPlan(submission.plan);
  await expect(submitPost(auth, submission, fixture.env)).rejects.toMatchObject({
    code: 'SCHEDULE_TOO_FAR',
  });
});
