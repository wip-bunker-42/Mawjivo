import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import { resetTestData } from './helpers';
import { publicationFixture, auth, workflowSteps } from './publication-fixture';
import { seedConnection, metaConnection } from './publishing-fixtures';
import { submitPost, getPublicationReceipt } from '../src/posts';
import { runPublication } from '../src/workflows/publish';

beforeEach(async () => {
  await resetTestData();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime('2026-10-12T12:00:00Z');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function facebookFixture() {
  const fixture = await publicationFixture();
  await seedConnection(metaConnection);
  const channel = fixture.caps.channels[0]!;
  Object.assign(channel, {
    platform: 'facebook',
    provider: 'meta',
    connectionId: metaConnection.id,
    remoteId: '12345',
  });
  await fixture.env.DB.prepare(
    'UPDATE channels SET platform=?,provider=?,connection_id=?,remote_id=? WHERE id=?',
  )
    .bind('facebook', 'meta', metaConnection.id, '12345', channel.id)
    .run();
  await fixture.env.DB.prepare('UPDATE service_settings SET value_json=? WHERE key=?')
    .bind(JSON.stringify(fixture.caps), 'capabilities:workspace-a')
    .run();
  const receipt = await submitPost(auth, await fixture.submission(), fixture.env);
  return { ...fixture, receipt, job: { postId: receipt.postId, revision: 1 } };
}

test('facebook_like_runs_only_after_confirmed_delivery_and_cannot_republish_on_replay', async () => {
  const f = await facebookFixture(),
    calls: string[] = [];
  let reads = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input),
      method = init?.method ?? 'GET';
    calls.push(method + ' ' + new URL(url).pathname);
    if (url.endsWith('/12345/feed')) return Response.json({ id: '12345_900' });
    if (url.includes('/12345_900?'))
      return Response.json({ id: '12345_900', is_published: ++reads > 1 });
    if (url.includes('/12345_900/likes')) {
      expect(
        await f.env.DB.prepare('SELECT state FROM targets WHERE post_id=?')
          .bind(f.receipt.postId)
          .first('state'),
      ).toBe('published');
      expect(init?.headers).toMatchObject({
        Authorization: 'Bearer ' + metaConnection.credentials.pageAccessToken,
      });
      return Response.json(
        method === 'POST'
          ? { success: true }
          : { data: [], summary: { can_like: true, has_liked: false } },
      );
    }
    throw new Error('unexpected provider route');
  });
  await Promise.all([
    runPublication(f.job, workflowSteps().step, f.env),
    runPublication(f.job, workflowSteps().step, f.env),
  ]);
  await runPublication(f.job, workflowSteps().step, f.env);
  expect(calls.filter((c) => c === 'POST /v26.0/12345/feed')).toHaveLength(1);
  expect(calls.filter((c) => c === 'POST /v26.0/12345_900/likes')).toHaveLength(1);
  expect((await getPublicationReceipt(auth, f.receipt.postId, f.env)).state).toBe('published');
});

test.each(['permission', 'lost-reply'])(
  'facebook_like_%s_preserves_publication_and_explains_the_problem',
  async (problem) => {
    const f = await facebookFixture();
    let likeWrites = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input),
        method = init?.method ?? 'GET';
      if (url.endsWith('/12345/feed')) return Response.json({ id: '12345_900' });
      if (url.includes('/12345_900?'))
        return Response.json({ id: '12345_900', is_published: true });
      if (url.includes('/likes') && method === 'GET')
        return Response.json({ data: [], summary: { can_like: true, has_liked: false } });
      if (url.endsWith('/likes') && method === 'POST') {
        likeWrites++;
        if (problem === 'lost-reply') throw new DOMException('network', 'AbortError');
        return Response.json(
          { error: { code: 200, message: 'private-provider-message' } },
          { status: 403 },
        );
      }
      throw new Error('unexpected provider route');
    });
    await runPublication(f.job, workflowSteps().step, f.env);
    await runPublication(f.job, workflowSteps().step, f.env);
    const receipt = await getPublicationReceipt(auth, f.receipt.postId, f.env);
    expect(receipt.state).toBe('published');
    expect(receipt.targets[0]?.state).toBe('published');
    expect(receipt.targets[0]?.error?.code).toBe(
      problem === 'permission' ? 'FACEBOOK_LIKE_FAILED' : 'FACEBOOK_LIKE_UNCERTAIN',
    );
    expect(receipt.targets[0]?.error?.messageAr).toContain('الإعجاب');
    expect(JSON.stringify(receipt)).not.toContain('private-provider-message');
    expect(likeWrites).toBe(1);
  },
);

test('an_existing_page_like_is_confirmed_without_an_extra_like_write', async () => {
  const f = await facebookFixture(),
    calls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input),
      method = init?.method ?? 'GET';
    calls.push(method + ' ' + new URL(url).pathname);
    if (url.endsWith('/12345/feed')) return Response.json({ id: '12345_900' });
    if (url.includes('/12345_900?')) return Response.json({ id: '12345_900', is_published: true });
    if (url.includes('/likes') && method === 'GET')
      return Response.json({ data: [], summary: { can_like: true, has_liked: true } });
    throw new Error('unexpected provider route');
  });
  await runPublication(f.job, workflowSteps().step, f.env);
  expect(calls.filter((c) => c.startsWith('POST') && c.endsWith('/likes'))).toHaveLength(0);
  expect(calls.filter((c) => c.startsWith('GET') && c.endsWith('/likes'))).toHaveLength(1);
});

test('cancelled_publication_does_not_start_a_new_facebook_like', async () => {
  const f = await facebookFixture();
  await f.env.DB.prepare(
    "UPDATE targets SET state='published',remote_id='fb-post:12345_900' WHERE post_id=?",
  )
    .bind(f.receipt.postId)
    .run();
  await f.env.DB.prepare('UPDATE posts SET cancel_requested_ms=? WHERE id=?')
    .bind(Date.now(), f.receipt.postId)
    .run();
  const io = vi
    .spyOn(globalThis, 'fetch')
    .mockRejectedValue(new Error('no external operation expected'));
  await runPublication({ ...f.job, receiptsOnly: true }, workflowSteps().step, f.env);
  expect(io).not.toHaveBeenCalled();
});

test('an_interrupted_like_claim_becomes_a_warning_without_repeating_the_write', async () => {
  const f = await facebookFixture();
  await f.env.DB.prepare(
    "UPDATE targets SET state='published',remote_id='fb-post:12345_900',facebook_like_state='sending',facebook_like_claimed_at_ms=? WHERE post_id=?",
  )
    .bind(Date.now() - 360000, f.receipt.postId)
    .run();
  const io = vi
    .spyOn(globalThis, 'fetch')
    .mockRejectedValue(new Error('no external operation expected'));
  await runPublication(f.job, workflowSteps().step, f.env);
  const receipt = await getPublicationReceipt(auth, f.receipt.postId, f.env);
  expect(receipt.state).toBe('published');
  expect(receipt.targets[0]?.error?.code).toBe('FACEBOOK_LIKE_UNCERTAIN');
  expect(io).not.toHaveBeenCalled();
});
