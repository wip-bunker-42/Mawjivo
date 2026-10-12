import { beforeEach, afterEach, test, expect, vi } from 'vitest';
import { hashPlan, type PublicationState } from '@mawjivo/core';
import { listPosts, getSummary, getPostDetail } from '../src/history';
import { submitPost, cancelPost } from '../src/posts';
import { resetTestData } from './helpers';
import { auth, publicationFixture } from './publication-fixture';
beforeEach(async () => {
  await resetTestData();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-11T09:00:00Z'));
});
afterEach(() => vi.useRealTimers());

test('summary_includes_received_posts_and_named_targets_before_publication_finishes', async () => {
  const fixture = await publicationFixture(true);
  const receipt = await submitPost(
    auth,
    await fixture.submission({ text: 'منشور قيد المتابعة' }),
    fixture.env,
  );
  const summary = await getSummary(auth, 'workspace-a', '2026-10-11', fixture.env);
  expect(summary).toMatchObject({
    receivedPosts: 1,
    processingPosts: 1,
    items: [{ postId: receipt.postId, preview: 'منشور قيد المتابعة' }],
  });
  expect(summary.items![0]!.targets).toHaveLength(2);
  expect((await getSummary(auth, 'workspace-b', '2026-10-11', fixture.env)).items).toEqual([]);
});

test('a_known_rejection_can_be_retried_after_repair_without_resending_successful_targets', async () => {
  const fixture = await publicationFixture(true),
    receipt = await submitPost(auth, await fixture.submission(), fixture.env);
  await fixture.env.DB.prepare(
    "UPDATE targets SET state=CASE WHEN channel_id='publish-x' THEN 'published' ELSE 'failed' END,error_json=? WHERE post_id=?",
  )
    .bind(
      JSON.stringify({ code: 'PROVIDER_AUTH', messageAr: 'أعد ربط الحساب.', retryable: false }),
      receipt.postId,
    )
    .run();
  expect((await getPostDetail(auth, receipt.postId, fixture.env)).receipt).toMatchObject({
    canRetry: true,
  });
  await fixture.env.DB.prepare(
    "UPDATE targets SET state='uncertain' WHERE post_id=? AND channel_id='publish-threads'",
  )
    .bind(receipt.postId)
    .run();
  expect((await getPostDetail(auth, receipt.postId, fixture.env)).receipt).toMatchObject({
    canRetry: false,
  });
});

async function publishedFixture(states: PublicationState[], when = Date.now()) {
  const fixture = await publicationFixture(true),
    receipt = await submitPost(auth, await fixture.submission(), fixture.env);
  await fixture.env.DB.prepare('DELETE FROM targets WHERE post_id=?').bind(receipt.postId).run();
  for (const [index, state] of states.entries())
    await fixture.env.DB.prepare(
      'INSERT INTO targets(post_id,revision,workspace_id,channel_id,state,updated_at_ms) VALUES(?,1,?,?,?,?)',
    )
      .bind(receipt.postId, 'workspace-a', index % 2 ? 'publish-threads' : 'publish-x', state, when)
      .run();
  return { ...fixture, receipt };
}
test('one_post_six_targets_is_one_post', async () => {
  const fixture = await publicationFixture(),
    s = await fixture.submission();
  // Six distinct channels share one logical post, including accounts on a common client.
  for (let i = 1; i < 6; i++) {
    const c = { ...fixture.caps.channels[0]!, id: 'copy-' + i, remoteId: 'remote-copy-' + i };
    fixture.caps.channels.push(c);
    await fixture.env.DB.prepare(
      'INSERT INTO channels(id,workspace_id,connection_id,remote_id,platform,provider,ready,limits_json,discovered_at_ms) VALUES(?,?,?,?,?,?,1,?,?)',
    )
      .bind(
        c.id,
        'workspace-a',
        c.connectionId,
        c.remoteId,
        c.platform,
        c.provider,
        JSON.stringify(c.limits),
        Date.now(),
      )
      .run();
  }
  await fixture.env.DB.prepare('UPDATE service_settings SET value_json=? WHERE key=?')
    .bind(JSON.stringify(fixture.caps), 'capabilities:workspace-a')
    .run();
  s.plan.targets = fixture.caps.channels.map((c) => ({ ...s.plan.targets[0]!, channelId: c.id }));
  s.planHash = await hashPlan(s.plan);
  const r = await submitPost(auth, s, fixture.env);
  await fixture.env.DB.prepare("UPDATE targets SET state='published' WHERE post_id=?")
    .bind(r.postId)
    .run();
  const summary = await getSummary(auth, 'workspace-a', '2026-10-11', fixture.env);
  expect(summary.completePosts).toBe(1);
  expect(summary.publishedTargets).toBe(6);
});
test('partial_and_unknown_are_never_complete', async () => {
  const fixture = await publishedFixture(['published', 'failed']);
  const partial = await getSummary(auth, 'workspace-a', '2026-10-11', fixture.env);
  expect(partial.completePosts).toBe(0);
  expect(partial.partialPosts).toBe(1);
  expect(partial.failedPosts).toBe(0);
  await fixture.env.DB.prepare(
    "UPDATE targets SET state='uncertain' WHERE channel_id='publish-threads'",
  ).run();
  const unknown = await getSummary(auth, 'workspace-a', '2026-10-11', fixture.env);
  expect(unknown.completePosts).toBe(0);
  expect(unknown.unknownPosts).toBe(1);
  expect(unknown.partialPosts).toBe(0);
});
test('workspace_day_boundaries_follow_cairo_even_on_a_dst_transition', async () => {
  const start = Date.parse('2026-10-28T21:00:00Z');
  const fixture = await publishedFixture(['published', 'published'], start - 1);
  expect((await getSummary(auth, 'workspace-a', '2026-10-29', fixture.env)).publishedTargets).toBe(
    0,
  );
  await fixture.env.DB.prepare('UPDATE targets SET updated_at_ms=?').bind(start).run();
  expect((await getSummary(auth, 'workspace-a', '2026-10-29', fixture.env)).publishedTargets).toBe(
    2,
  );
});
test('cancellation_removes_the_upcoming_schedule_and_lists_stay_workspace_scoped', async () => {
  const fixture = await publicationFixture(),
    r = await submitPost(
      auth,
      await fixture.submission({ scheduleLocal: '2026-10-12T10:00' }),
      fixture.env,
    );
  expect((await getSummary(auth, 'workspace-a', '2026-10-11', fixture.env)).upcomingScheduled).toBe(
    1,
  );
  expect(
    (await listPosts(auth, 'workspace-a', 'scheduled', undefined, fixture.env)).items.map(
      (p) => p.postId,
    ),
  ).toEqual([r.postId]);
  expect((await listPosts(auth, 'workspace-b', 'all', undefined, fixture.env)).items).toEqual([]);
  await cancelPost(auth, r.postId, 1, fixture.env);
  expect((await getSummary(auth, 'workspace-a', '2026-10-11', fixture.env)).upcomingScheduled).toBe(
    0,
  );
  expect((await listPosts(auth, 'workspace-a', 'scheduled', undefined, fixture.env)).items).toEqual(
    [],
  );
  await expect(
    listPosts(
      { deviceId: 'limited', allowedWorkspaceIds: ['workspace-b'] },
      'workspace-a',
      'all',
      undefined,
      fixture.env,
    ),
  ).rejects.toMatchObject({ code: 'FORBIDDEN' });
});
test('pagination_is_stable_without_duplicates_and_rejects_a_foreign_cursor', async () => {
  const fixture = await publicationFixture();
  for (let i = 0; i < 23; i++)
    await submitPost(
      auth,
      await fixture.submission({ id: crypto.randomUUID(), text: 'منشور ' + i }),
      fixture.env,
    );
  const prepare = vi.fn(fixture.env.DB.prepare.bind(fixture.env.DB));
  const boundedEnv = {
    ...fixture.env,
    DB: { ...fixture.env.DB, prepare, batch: fixture.env.DB.batch.bind(fixture.env.DB) },
  } as unknown as Env;
  const page = await listPosts(auth, 'workspace-a', 'all', undefined, boundedEnv);
  expect(page.items).toHaveLength(20);
  expect(prepare.mock.calls.length).toBeLessThanOrEqual(6);
  expect(page.nextCursor).toBeTruthy();
  const next = await listPosts(auth, 'workspace-a', 'all', page.nextCursor!, fixture.env);
  expect(next.items).toHaveLength(3);
  expect(new Set([...page.items, ...next.items].map((p) => p.postId)).size).toBe(23);
  await expect(
    listPosts(auth, 'workspace-b', 'all', page.nextCursor!, fixture.env),
  ).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
});
test('post_details_keep_confirmed_variants_and_original_source_metadata_for_editing', async () => {
  const fixture = await publicationFixture(),
    s = await fixture.imageSubmission(),
    r = await submitPost(auth, s, fixture.env);
  const detail = await getPostDetail(auth, r.postId, fixture.env);
  expect(detail.plan).toEqual(s.plan);
  expect(detail.preparedAssets).toEqual(s.preparedAssets);
  expect(detail.sources[0]).toMatchObject({ id: 'source-photo', originalName: 'صورتنا.PNG' });
  expect(detail.editable).toBe(true);
  await fixture.env.DB.prepare('UPDATE posts SET locked_at_ms=? WHERE id=?')
    .bind(Date.now(), r.postId)
    .run();
  expect((await getPostDetail(auth, r.postId, fixture.env)).editable).toBe(false);
});
