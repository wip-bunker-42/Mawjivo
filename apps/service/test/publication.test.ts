import { beforeEach, afterEach, test, expect, vi } from 'vitest';
import { hashPlan } from '@mawjivo/core';
import {
  submitPost,
  revisePost,
  cancelPost,
  claimTarget,
  drainDispatchOutbox,
  getPublicationReceipt,
  retryPost,
} from '../src/posts';
import { runPublication } from '../src/workflows/publish';
import { bufferAdapter } from '../src/providers/buffer';
import { resetTestData, testEnv, requestAs, ownerToken } from './helpers';
import { seedConnection, bufferConnection, metaConnection } from './publishing-fixtures';
import { metaAdapter } from '../src/providers/meta';
import service from '../src/index';
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

test('confirmed_hash_must_match', async () => {
  const fixture = await publicationFixture(),
    submission = await fixture.submission();
  submission.plan.targets[0]!.text = 'تعديل بعد الموافقة';
  await expect(submitPost(auth, submission, fixture.env)).rejects.toMatchObject({
    code: 'PLAN_HASH_MISMATCH',
  });
  expect(fixture.workflow.create).not.toHaveBeenCalled();
});

test('changed_settings_or_capabilities_require_new_review', async () => {
  const fixture = await publicationFixture(),
    submission = await fixture.submission();
  await testEnv()
    .DB.prepare('UPDATE workspaces SET version=2 WHERE id=?')
    .bind('workspace-a')
    .run();
  await expect(submitPost(auth, submission, fixture.env)).rejects.toMatchObject({
    code: 'REVIEW_REQUIRED',
    status: 409,
  });
  await testEnv()
    .DB.prepare('UPDATE workspaces SET version=1 WHERE id=?')
    .bind('workspace-a')
    .run();
  await testEnv()
    .DB.prepare('UPDATE service_settings SET value_json=? WHERE key=?')
    .bind(JSON.stringify({ ...fixture.caps, version: 'changed' }), 'capabilities:workspace-a')
    .run();
  await expect(submitPost(auth, submission, fixture.env)).rejects.toMatchObject({
    code: 'REVIEW_REQUIRED',
    status: 409,
  });
});

test.each(['uploading', 'complete'])('unuploaded_or_foreign_asset_rejected_%s', async (state) => {
  const fixture = await publicationFixture(),
    submission = await fixture.imageSubmission(
      state === 'complete' ? 'workspace-b' : 'workspace-a',
      state,
    );
  await expect(submitPost(auth, submission, fixture.env)).rejects.toMatchObject({
    code: state === 'complete' ? 'ASSET_SCOPE' : 'ASSET_NOT_READY',
  });
  expect(fixture.workflow.create).not.toHaveBeenCalled();
});

test('two_submit_calls_create_one_receipt', async () => {
  const fixture = await publicationFixture(),
    submission = await fixture.submission();
  const receipts = await Promise.all([
    submitPost(auth, submission, fixture.env),
    submitPost(auth, submission, fixture.env),
  ]);
  expect(receipts[0]!.postId).toBe(receipts[1]!.postId);
  expect(await testEnv().DB.prepare('SELECT COUNT(*) AS count FROM posts').first('count')).toBe(1);
  expect(fixture.workflow.instances.size).toBe(1);
});

test('failed_workflow_creation_resumes_from_dispatch_outbox', async () => {
  const fixture = await publicationFixture(),
    submission = await fixture.submission();
  fixture.workflow.create.mockRejectedValueOnce(new Error('temporary outage'));
  const receipt = await submitPost(auth, submission, fixture.env);
  expect(receipt.state).toBe('preparing');
  const outbox = await testEnv()
    .DB.prepare('SELECT workflow_id,state FROM dispatch_outbox')
    .first<{ workflow_id: string; state: string }>();
  expect(outbox?.state).toBe('pending');
  await testEnv().DB.prepare('UPDATE dispatch_outbox SET next_attempt_ms=0').run();
  expect(await drainDispatchOutbox(new Date().toISOString(), fixture.env)).toBe(1);
  expect(fixture.workflow.create.mock.calls.map((call) => call[0].id)).toEqual([
    outbox!.workflow_id,
    outbox!.workflow_id,
  ]);
  expect((await getPublicationReceipt(auth, receipt.postId, fixture.env)).state).toBe('ready');
});

test('old_workflow_revision_cannot_publish', async () => {
  const fixture = await publicationFixture(),
    initial = await fixture.submission(),
    receipt = await submitPost(auth, initial, fixture.env);
  const next = await fixture.submission({ revision: 2, text: 'نص أحدث' });
  await revisePost(auth, receipt.postId, 1, next, fixture.env);
  const publish = vi.spyOn(bufferAdapter, 'publishBatch');
  await runPublication({ postId: receipt.postId, revision: 1 }, workflowSteps().step, fixture.env);
  expect(publish).not.toHaveBeenCalled();
});

test('cancel_wins_before_claim', async () => {
  const fixture = await publicationFixture(),
    receipt = await submitPost(auth, await fixture.submission(), fixture.env);
  expect((await cancelPost(auth, receipt.postId, 1, fixture.env)).state).toBe('cancelled');
  expect((await claimTarget(receipt.postId, 1, 'publish-x', fixture.env)).kind).toBe('skipped');
});

test('claim_wins_locks_edit', async () => {
  const fixture = await publicationFixture(),
    receipt = await submitPost(auth, await fixture.submission(), fixture.env);
  expect((await claimTarget(receipt.postId, 1, 'publish-x', fixture.env)).kind).toBe('claimed');
  await expect(
    revisePost(
      auth,
      receipt.postId,
      1,
      await fixture.submission({ revision: 2, text: 'تعديل' }),
      fixture.env,
    ),
  ).rejects.toMatchObject({ code: 'POST_LOCKED', status: 409 });
});

test('cancel_unclaimed_target_during_partial_send', async () => {
  const fixture = await publicationFixture(true),
    receipt = await submitPost(auth, await fixture.submission(), fixture.env);
  expect((await claimTarget(receipt.postId, 1, 'publish-x', fixture.env)).kind).toBe('claimed');
  const cancelled = await cancelPost(auth, receipt.postId, 1, fixture.env);
  expect(cancelled.targets.find((t) => t.channelId === 'publish-threads')!.state).toBe('cancelled');
  expect(cancelled.targets.find((t) => t.channelId === 'publish-x')!.state).toBe('sending');
  expect((await claimTarget(receipt.postId, 1, 'publish-threads', fixture.env)).kind).toBe(
    'skipped',
  );
});

test('partial_success_only_retries_failed_target', async () => {
  const fixture = await publicationFixture(true),
    receipt = await submitPost(auth, await fixture.submission(), fixture.env);
  const publish = vi
    .spyOn(bufferAdapter, 'publishBatch')
    .mockImplementation(async (_connection, targets) =>
      targets.map((target) =>
        target.platform === 'x'
          ? { kind: 'accepted', channelId: target.channelId, remoteId: 'remote-published-x' }
          : {
              kind: 'rejected',
              channelId: target.channelId,
              error: {
                code: 'PROVIDER_REJECTED',
                messageAr: 'فشل معروف قبل النشر.',
                retryable: true,
              },
            },
      ),
    );
  vi.spyOn(bufferAdapter, 'readReceipts').mockImplementation(async (_connection, ids) =>
    ids.map((remoteId) => ({ remoteId, state: 'published' })),
  );
  await runPublication({ postId: receipt.postId, revision: 1 }, workflowSteps().step, fixture.env);
  expect(
    (await getPublicationReceipt(auth, receipt.postId, fixture.env)).targets.find(
      (t) => t.platform === 'x',
    )!.state,
  ).toBe('published');
  await retryPost(auth, receipt.postId, 1, fixture.env);
  publish.mockImplementation(async (_connection, targets) =>
    targets.map((target) => ({
      kind: 'accepted',
      channelId: target.channelId,
      remoteId: 'remote-retried-threads',
    })),
  );
  await runPublication({ postId: receipt.postId, revision: 1 }, workflowSteps().step, fixture.env);
  expect(
    publish.mock.calls.flatMap((call) => call[1]).filter((target) => target.platform === 'x'),
  ).toHaveLength(1);
  expect(publish.mock.calls.at(-1)![1].map((target) => target.platform)).toEqual(['threads']);
});

test('replayed_submission_after_revision_keeps_the_original_receipt', async () => {
  const fixture = await publicationFixture(),
    original = await fixture.submission(),
    receipt = await submitPost(auth, original, fixture.env);
  await revisePost(
    auth,
    receipt.postId,
    1,
    await fixture.submission({ revision: 2, text: 'تعديل' }),
    fixture.env,
  );
  const replay = await submitPost(auth, original, fixture.env);
  expect(replay.postId).toBe(receipt.postId);
  expect(replay.revision).toBe(1);
  expect(replay.state).toBe('cancelled');
  expect(await testEnv().DB.prepare('SELECT COUNT(*) AS count FROM posts').first('count')).toBe(1);
});

test('valid_hash_does_not_authorize_an_oversized_or_mismatched_target', async () => {
  const fixture = await publicationFixture(),
    submission = await fixture.submission();
  submission.plan.targets[0]!.text = 'أ'.repeat(281);
  submission.planHash = await hashPlan(submission.plan);
  await expect(submitPost(auth, submission, fixture.env)).rejects.toMatchObject({
    code: 'PLAN_INVALID',
  });
});

test('claim_during_validation_does_not_enqueue_termination_when_edit_cas_loses', async () => {
  const fixture = await publicationFixture(),
    receipt = await submitPost(auth, await fixture.submission(), fixture.env);
  const wrapped = {
    ...fixture.env,
    DB: {
      prepare: fixture.env.DB.prepare.bind(fixture.env.DB),
      batch: async (statements: D1PreparedStatement[]) => {
        await claimTarget(receipt.postId, 1, 'publish-x', fixture.env);
        return fixture.env.DB.batch(statements);
      },
    },
  } as unknown as Env;
  await expect(
    revisePost(
      auth,
      receipt.postId,
      1,
      await fixture.submission({ revision: 2, text: 'تعديل متزامن' }),
      wrapped,
    ),
  ).rejects.toMatchObject({ code: 'POST_LOCKED' });
  expect(
    await fixture.env.DB.prepare(
      "SELECT COUNT(*) AS count FROM dispatch_outbox WHERE action='terminate'",
    ).first('count'),
  ).toBe(0);
});

test('a_known_rate_wait_sleeps_and_does_not_republish_another_client', async () => {
  const fixture = await publicationFixture(true);
  const second = {
    ...bufferConnection,
    id: 'buffer-second',
    credentials: { apiKey: 'synthetic-second-budget' },
  };
  await seedConnection(second);
  fixture.caps.channels.find((channel) => channel.platform === 'threads')!.connectionId = second.id;
  await fixture.env.DB.prepare('UPDATE channels SET connection_id=? WHERE id=?')
    .bind(second.id, 'publish-threads')
    .run();
  await fixture.env.DB.prepare('UPDATE service_settings SET value_json=? WHERE key=?')
    .bind(JSON.stringify(fixture.caps), 'capabilities:workspace-a')
    .run();
  const receipt = await submitPost(auth, await fixture.submission(), fixture.env);
  let waited = false;
  const publish = vi
    .spyOn(bufferAdapter, 'publishBatch')
    .mockImplementation(async (_connection, targets) =>
      targets.map((target) => {
        if (target.platform === 'x' && !waited) {
          waited = true;
          return {
            kind: 'rejected',
            channelId: target.channelId,
            retryAt: new Date(Date.now() + 3600000).toISOString(),
            error: {
              code: 'PROVIDER_RATE_LIMIT',
              messageAr: 'انتظار الحصة المتاحة.',
              retryable: true,
            },
          };
        }
        return {
          kind: 'accepted',
          channelId: target.channelId,
          remoteId: 'rate-receipt-' + target.platform,
        };
      }),
    );
  vi.spyOn(bufferAdapter, 'readReceipts').mockImplementation(async (_connection, ids) =>
    ids.map((remoteId) => ({ remoteId, state: 'published' })),
  );
  const steps = workflowSteps();
  await runPublication({ postId: receipt.postId, revision: 1 }, steps.step, fixture.env);
  expect((await getPublicationReceipt(auth, receipt.postId, fixture.env)).state).toBe('published');
  expect(
    publish.mock.calls.flatMap((call) => call[1]).filter((target) => target.platform === 'threads'),
  ).toHaveLength(1);
  expect(publish.mock.calls.filter((call) => call[0].id === bufferConnection.id)).toHaveLength(2);
  expect(steps.sleeps.some((date) => date.toISOString() === '2026-10-11T10:00:00.000Z')).toBe(true);
});

test('ready_media_alias_preserves_the_original_image_name', async () => {
  const fixture = await publicationFixture(),
    submission = await fixture.imageSubmission();
  await fixture.env.DB.prepare(
    'INSERT INTO service_settings(key,value_json,updated_at_ms) VALUES(?,?,?)',
  )
    .bind('public_base_url', JSON.stringify('https://service.test'), Date.now())
    .run();
  const receipt = await submitPost(auth, submission, fixture.env);
  const publish = vi
    .spyOn(bufferAdapter, 'publishBatch')
    .mockImplementation(async (_connection, targets) =>
      targets.map((target) => ({
        kind: 'accepted',
        channelId: target.channelId,
        remoteId: 'image-receipt',
      })),
    );
  vi.spyOn(bufferAdapter, 'readReceipts').mockResolvedValue([
    { remoteId: 'image-receipt', state: 'published' },
  ]);
  await runPublication({ postId: receipt.postId, revision: 1 }, workflowSteps().step, fixture.env);
  const url = new URL(publish.mock.calls[0]![1][0]!.assets[0]!.url);
  expect(decodeURIComponent(url.pathname.split('/').at(-1)!)).toBe('صورتنا.PNG');
  expect((await getPublicationReceipt(auth, receipt.postId, fixture.env)).state).toBe('published');
});

test('publication_http_routes_scope_posts_and_reject_stale_edits', async () => {
  const fixture = await publicationFixture(),
    submission = await fixture.submission();
  const create = await service.fetch(
    requestAs(ownerToken, '/api/workspaces/workspace-a/posts', submission),
    fixture.env,
  );
  expect(create.status).toBe(201);
  const receipt = (await create.json()) as { postId: string };
  const foreign = await service.fetch(
    requestAs(ownerToken, '/api/workspaces/workspace-b/posts/' + receipt.postId),
    fixture.env,
  );
  expect(foreign.status).toBe(403);
  const unauthorized = await service.fetch(
    new Request('https://service.test/api/workspaces/workspace-a/posts'),
    fixture.env,
  );
  expect(unauthorized.status).toBe(401);
  const updated = await fixture.submission({ revision: 2, text: 'تحرير عبر الواجهة' });
  const edit = await service.fetch(
    requestAs(
      ownerToken,
      '/api/workspaces/workspace-a/posts/' + receipt.postId,
      { expectedRevision: 1, submission: updated },
      'PATCH',
    ),
    fixture.env,
  );
  expect(edit.status).toBe(200);
  const stale = await service.fetch(
    requestAs(ownerToken, '/api/workspaces/workspace-a/posts/' + receipt.postId + '/cancel', {
      expectedRevision: 1,
    }),
    fixture.env,
  );
  expect(stale.status).toBe(409);
});

test('a_losing_retry_cas_cannot_reset_the_winning_dispatch_lease', async () => {
  const fixture = await publicationFixture(),
    receipt = await submitPost(auth, await fixture.submission(), fixture.env);
  await fixture.env.DB.prepare("UPDATE targets SET state='failed',error_json=? WHERE post_id=?")
    .bind(
      JSON.stringify({ code: 'PROVIDER_AUTH', messageAr: 'أعد الربط.', retryable: true }),
      receipt.postId,
    )
    .run();
  let raced = false;
  const wrapped = {
    ...fixture.env,
    DB: {
      ...fixture.env.DB,
      prepare: fixture.env.DB.prepare.bind(fixture.env.DB),
      batch: async (statements: D1PreparedStatement[]) => {
        if (!raced) {
          raced = true;
          await retryPost(auth, receipt.postId, 1, fixture.env);
        }
        return fixture.env.DB.batch(statements);
      },
    },
  } as unknown as Env;
  await retryPost(auth, receipt.postId, 1, wrapped);
  expect(
    await fixture.env.DB.prepare(
      "SELECT state FROM dispatch_outbox WHERE post_id=? AND action='create'",
    )
      .bind(receipt.postId)
      .first('state'),
  ).toBe('done');
  expect(fixture.workflow.create).toHaveBeenCalledTimes(2);
});

test('a_receipt_rate_wait_keeps_the_known_remote_id_and_resumes_reads', async () => {
  const fixture = await publicationFixture(),
    receipt = await submitPost(auth, await fixture.submission(), fixture.env);
  const publish = vi
    .spyOn(bufferAdapter, 'publishBatch')
    .mockResolvedValue([{ kind: 'accepted', channelId: 'publish-x', remoteId: 'remote-receipt' }]);
  const reads = vi
    .spyOn(bufferAdapter, 'readReceipts')
    .mockResolvedValueOnce([
      {
        remoteId: 'remote-receipt',
        state: 'unknown',
        retryAt: '2026-10-11T10:00:00.000Z',
        error: { code: 'PROVIDER_RATE_LIMIT', messageAr: 'انتظار الحصة.', retryable: true },
      },
    ])
    .mockResolvedValue([{ remoteId: 'remote-receipt', state: 'published' }]);
  const steps = workflowSteps();
  await runPublication({ postId: receipt.postId, revision: 1 }, steps.step, fixture.env);
  expect((await getPublicationReceipt(auth, receipt.postId, fixture.env)).state).toBe('published');
  expect(publish).toHaveBeenCalledTimes(1);
  expect(reads).toHaveBeenCalledTimes(2);
});

async function instagramFixture() {
  const fixture = await publicationFixture();
  await seedConnection(metaConnection);
  const channel = fixture.caps.channels[0]!;
  Object.assign(channel, {
    connectionId: metaConnection.id,
    provider: 'meta',
    platform: 'instagram',
    remoteId: '67890',
  });
  await fixture.env.DB.prepare(
    'UPDATE channels SET connection_id=?,provider=?,platform=?,remote_id=? WHERE id=?',
  )
    .bind(metaConnection.id, 'meta', 'instagram', '67890', channel.id)
    .run();
  await fixture.env.DB.prepare('UPDATE service_settings SET value_json=? WHERE key=?')
    .bind(JSON.stringify(fixture.caps), 'capabilities:workspace-a')
    .run();
  await fixture.env.DB.prepare(
    'INSERT INTO service_settings(key,value_json,updated_at_ms) VALUES(?,?,?)',
  )
    .bind('public_base_url', JSON.stringify('https://service.test'), Date.now())
    .run();
  const receipt = await submitPost(auth, await fixture.imageSubmission(), fixture.env);
  return { ...fixture, receipt };
}

test('instagram_checkpoint_is_durable_and_an_ambiguous_continuation_never_repeats', async () => {
  const fixture = await instagramFixture(),
    state = { kind: 'instagram' as const, childIds: ['child-one'], containerId: 'container-one' };
  const publish = vi
    .spyOn(metaAdapter, 'publishBatch')
    .mockImplementation(async (_connection, targets) => {
      await targets[0]!.checkpoint!(state);
      expect(
        JSON.parse(
          (await fixture.env.DB.prepare('SELECT provider_state_json FROM targets WHERE post_id=?')
            .bind(fixture.receipt.postId)
            .first<string>('provider_state_json')) as string,
        ),
      ).toEqual(state);
      return [
        {
          kind: 'accepted',
          channelId: 'publish-x',
          remoteId: 'ig-container:container-one',
          providerState: state,
        },
      ];
    });
  vi.spyOn(metaAdapter, 'readReceipts').mockResolvedValue([
    {
      remoteId: 'ig-container:container-one',
      state: 'processing',
      continuation: { kind: 'instagram-publish', containerId: 'container-one' },
    },
  ]);
  const continuation = vi.spyOn(metaAdapter, 'continuePublishing').mockResolvedValue({
    kind: 'uncertain',
    channelId: 'publish-x',
    error: { code: 'PROVIDER_UNCERTAIN', messageAr: 'تحقق من المنصة.', retryable: false },
  });
  const job = { postId: fixture.receipt.postId, revision: 1 };
  await runPublication(job, workflowSteps().step, fixture.env);
  await retryPost(auth, job.postId, 1, fixture.env);
  await runPublication(job, workflowSteps().step, fixture.env);
  expect((await getPublicationReceipt(auth, job.postId, fixture.env)).state).toBe('uncertain');
  expect(publish).toHaveBeenCalledTimes(1);
  expect(continuation).toHaveBeenCalledTimes(1);
});

test('a_known_rejected_instagram_continuation_retries_the_container_without_reuploading', async () => {
  const fixture = await instagramFixture(),
    state = { kind: 'instagram' as const, childIds: ['child-one'], containerId: 'container-one' };
  const publish = vi.spyOn(metaAdapter, 'publishBatch').mockResolvedValue([
    {
      kind: 'accepted',
      channelId: 'publish-x',
      remoteId: 'ig-container:container-one',
      providerState: state,
    },
  ]);
  vi.spyOn(metaAdapter, 'readReceipts').mockImplementation(async (_connection, ids) =>
    ids.map((remoteId) =>
      remoteId.startsWith('ig-container:')
        ? {
            remoteId,
            state: 'processing',
            continuation: { kind: 'instagram-publish', containerId: 'container-one' },
          }
        : { remoteId, state: 'published' },
    ),
  );
  const continuation = vi
    .spyOn(metaAdapter, 'continuePublishing')
    .mockResolvedValueOnce({
      kind: 'rejected',
      channelId: 'publish-x',
      error: { code: 'PROVIDER_AUTH', messageAr: 'أعد الربط.', retryable: true },
    })
    .mockResolvedValue({
      kind: 'accepted',
      channelId: 'publish-x',
      remoteId: 'ig-media:published-one',
      providerState: { ...state, publishedId: 'published-one' },
    });
  const job = { postId: fixture.receipt.postId, revision: 1 };
  await runPublication(job, workflowSteps().step, fixture.env);
  expect((await getPublicationReceipt(auth, job.postId, fixture.env)).state).toBe('failed');
  await retryPost(auth, job.postId, 1, fixture.env);
  await runPublication(job, workflowSteps().step, fixture.env);
  expect((await getPublicationReceipt(auth, job.postId, fixture.env)).state).toBe('published');
  expect(publish).toHaveBeenCalledTimes(1);
  expect(continuation).toHaveBeenCalledTimes(2);
});

test('a_partial_chain_receipt_exposes_saved_part_outcomes_and_never_retries_delivered_parts', async () => {
  const fixture = await publicationFixture(),
    submission = await fixture.submission({
      overrides: { x: { threadParts: ['الجزء الأول', 'الجزء الثاني'] } },
    });
  const receipt = await submitPost(auth, submission, fixture.env);
  const publish = vi
    .spyOn(bufferAdapter, 'publishBatch')
    .mockResolvedValue([{ kind: 'accepted', channelId: 'publish-x', remoteId: 'parent-receipt' }]);
  vi.spyOn(bufferAdapter, 'readReceipts').mockResolvedValue([
    {
      remoteId: 'parent-receipt',
      state: 'failed',
      partReceipts: [
        { partIndex: 0, remoteId: 'part-one', state: 'published' },
        { partIndex: 1, remoteId: 'part-two', state: 'failed' },
      ],
    },
  ]);
  const job = { postId: receipt.postId, revision: 1 };
  await runPublication(job, workflowSteps().step, fixture.env);
  const final = await getPublicationReceipt(auth, job.postId, fixture.env);
  expect(final.targets[0]!.parts).toEqual([
    { partIndex: 0, state: 'published', remoteId: 'part-one' },
    { partIndex: 1, state: 'failed', remoteId: 'part-two' },
  ]);
  await retryPost(auth, job.postId, 1, fixture.env);
  await runPublication(job, workflowSteps().step, fixture.env);
  expect(publish).toHaveBeenCalledTimes(1);
});

test.each(['deferred', 'http429', 'network'] as const)(
  'real_buffer_receipts_resume_after_%s_without_republishing',
  async (failure) => {
    const fixture = await publicationFixture();
    let writes = 0,
      reads = 0;
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, options) => {
      const query = JSON.parse(String(options?.body)).query as string;
      if (query.includes('createPost')) {
        writes++;
        return Response.json(
          { data: { p0: { __typename: 'PostActionSuccess', post: { id: 'known-buffer-id' } } } },
          failure === 'deferred'
            ? {
                headers: {
                  RateLimit: '"short";r=0;t=120',
                  'RateLimit-Policy': '"short";q=100;w=900',
                },
              }
            : undefined,
        );
      }
      expect(query).toContain('MawjivoReceipts');
      reads++;
      if (reads === 1 && failure === 'http429')
        return Response.json({}, { status: 429, headers: { 'Retry-After': '120' } });
      if (reads === 1 && failure === 'network') throw new TypeError('temporary read outage');
      return Response.json(
        { data: { r0: { id: 'known-buffer-id', status: 'sent' } } },
        {
          headers: { RateLimit: '"short";r=99;t=900', 'RateLimit-Policy': '"short";q=100;w=900' },
        },
      );
    });
    const receipt = await submitPost(auth, await fixture.submission(), fixture.env);
    const steps = workflowSteps();
    await runPublication({ postId: receipt.postId, revision: 1 }, steps.step, fixture.env);
    expect((await getPublicationReceipt(auth, receipt.postId, fixture.env)).state).toBe(
      'published',
    );
    expect(writes).toBe(1);
    expect(reads).toBe(failure === 'deferred' ? 1 : 2);
    expect(fetcher).toHaveBeenCalledTimes(writes + reads);
    if (failure !== 'network')
      expect(steps.sleeps.some((at) => at.getTime() >= Date.parse('2026-10-11T09:02:00Z'))).toBe(
        true,
      );
  },
);

test.each([false, true])(
  'scheduled_publication_after_capability_refresh_changed_%s',
  async (changed) => {
    const fixture = await publicationFixture();
    const receipt = await submitPost(
      auth,
      await fixture.submission({ scheduleLocal: '2026-10-11T15:00', scheduleOffset: '+03:00' }),
      fixture.env,
    );
    vi.setSystemTime(new Date('2026-10-11T10:00:00Z'));
    const refreshed = structuredClone(fixture.caps.channels);
    refreshed[0]!.limits.verifiedAt = new Date().toISOString();
    if (changed) refreshed[0]!.limits.textMax = 100;
    vi.spyOn(bufferAdapter, 'discover').mockResolvedValue(refreshed);
    const { getCapabilities } = await import('../src/connections');
    await getCapabilities(auth, fixture.draft.workspaceId, fixture.env, true);
    const writes = vi
      .spyOn(bufferAdapter, 'publishBatch')
      .mockResolvedValue([
        { kind: 'accepted', channelId: 'publish-x', remoteId: 'refreshed-scheduled-id' },
      ]);
    vi.spyOn(bufferAdapter, 'readReceipts').mockResolvedValue([
      { remoteId: 'refreshed-scheduled-id', state: 'published' },
    ]);
    await runPublication(
      { postId: receipt.postId, revision: 1 },
      workflowSteps().step,
      fixture.env,
    );
    const final = await getPublicationReceipt(auth, receipt.postId, fixture.env);
    expect(final.state).toBe(changed ? 'failed' : 'published');
    expect(writes).toHaveBeenCalledTimes(changed ? 0 : 1);
    if (changed) expect(final.targets[0]!.error?.code).toBe('REVIEW_REQUIRED');
  },
);

test.each(['recover', 'cancel', 'ambiguous'] as const)(
  'staged_instagram_recovery_%s_preserves_the_continuation_claim',
  async (mode) => {
    const fixture = await instagramFixture();
    const staged = { kind: 'instagram', childIds: ['child-one'], containerId: 'staged-one' };
    await fixture.env.DB.prepare(
      "UPDATE targets SET state='accepted',claim_id='staged-claim',remote_id='ig-container:staged-one',provider_state_json=?,next_check_ms=?,updated_at_ms=?,continuation_claim_id=? WHERE post_id=?",
    )
      .bind(
        JSON.stringify(staged),
        Date.now(),
        Date.now(),
        mode === 'ambiguous' ? 'possibly-sent' : null,
        fixture.receipt.postId,
      )
      .run();
    if (mode === 'cancel') await cancelPost(auth, fixture.receipt.postId, 1, fixture.env);
    for (const instance of fixture.workflow.instances.values())
      instance.status = async () => ({ status: 'errored' });
    vi.setSystemTime(new Date('2026-10-11T09:06:00Z'));
    const { runMonitor } = await import('../src/monitoring');
    await runMonitor(new Date().toISOString(), fixture.env);
    const upload = vi.spyOn(metaAdapter, 'publishBatch');
    let reads = 0;
    vi.spyOn(metaAdapter, 'readReceipts').mockImplementation(async (_connection, ids) => {
      reads++;
      return ids.map((remoteId) =>
        remoteId === 'ig-media:finished-one'
          ? { remoteId, state: 'published' as const }
          : mode === 'cancel' && reads > 1
            ? {
                remoteId,
                state: 'failed' as const,
                error: { code: 'PROVIDER_FAILED', messageAr: 'انتهت الحاوية.', retryable: false },
              }
            : {
                remoteId,
                state: 'processing' as const,
                continuation: { kind: 'instagram-publish' as const, containerId: 'staged-one' },
              },
      );
    });
    const continuation = vi.spyOn(metaAdapter, 'continuePublishing').mockResolvedValue({
      kind: 'accepted',
      channelId: 'publish-x',
      remoteId: 'ig-media:finished-one',
      providerState: { ...staged, kind: 'instagram', publishedId: 'finished-one' },
    });
    const recovered = fixture.workflow.create.mock.calls[1]?.[0];
    if (mode === 'ambiguous') {
      expect(recovered).toBeUndefined();
      expect((await getPublicationReceipt(auth, fixture.receipt.postId, fixture.env)).state).toBe(
        'uncertain',
      );
    } else {
      expect(recovered).toMatchObject({ params: { receiptsOnly: true } });
      await runPublication(
        recovered!.params! as { postId: string; revision: number; receiptsOnly: true },
        workflowSteps().step,
        fixture.env,
      );
      expect(continuation).toHaveBeenCalledTimes(mode === 'recover' ? 1 : 0);
      if (mode === 'recover')
        expect((await getPublicationReceipt(auth, fixture.receipt.postId, fixture.env)).state).toBe(
          'published',
        );
    }
    expect(upload).not.toHaveBeenCalled();
  },
);
