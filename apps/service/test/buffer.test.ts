import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { publishBatch, readReceipts } from '../src/providers/buffer';
import { bufferConnection, seedConnection, target, images, video } from './publishing-fixtures';
import { resetTestData, testEnv } from './helpers';
beforeEach(async () => {
  await resetTestData();
  await seedConnection(bufferConnection);
});
afterEach(() => vi.restoreAllMocks());
function capture(response: unknown) {
  const calls: { query: string; variables: Record<string, any> }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    calls.push(JSON.parse(String(init?.body)));
    return Response.json(response);
  });
  return calls;
}
test('buffer_two_targets_share_one_mutation_document', async () => {
  const t = [await target('x'), await target('threads')];
  const calls = capture({
    data: {
      p0: { __typename: 'PostActionSuccess', post: { id: 'post-x', status: 'sending' } },
      p1: { __typename: 'PostActionSuccess', post: { id: 'post-threads', status: 'scheduled' } },
    },
  });
  const result = await publishBatch(bufferConnection, t, testEnv());
  expect(calls).toHaveLength(1);
  expect(calls[0]!.query.match(/createPost\s*\(/g)).toHaveLength(2);
  expect(Object.values(calls[0]!.variables).map((v) => v.channelId)).toEqual([
    'remote-x',
    'remote-threads',
  ]);
  expect(result.map((r) => r.kind)).toEqual(['accepted', 'accepted']);
});
test('shareNow_is_immediate_and_acceptance_is_not_delivery', async () => {
  const calls = capture({
    data: { p0: { __typename: 'PostActionSuccess', post: { id: 'post-x', status: 'sending' } } },
  });
  const result = await publishBatch(bufferConnection, [await target('x')], testEnv());
  const input = Object.values(calls[0]!.variables)[0];
  expect(input.mode).toBe('shareNow');
  expect(input.schedulingType).toBe('automatic');
  expect(input.needsApproval).toBe(false);
  expect(input).not.toHaveProperty('dueAt');
  expect(result[0]).toMatchObject({ kind: 'accepted', remoteId: 'post-x' });
});
test('partial_errors_preserve_the_successful_remote_id_and_receipts_only_read', async () => {
  const calls: { query: string }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    calls.push(body);
    return Response.json(
      body.query.includes('createPost')
        ? {
            data: {
              p0: { __typename: 'PostActionSuccess', post: { id: 'post-ok', status: 'sending' } },
              p1: { __typename: 'InvalidInputError', message: 'bad synthetic-buffer-first' },
            },
          }
        : {
            data: {
              r0: {
                id: 'post-ok',
                status: 'sent',
                sentAt: '2026-10-10T12:00:00Z',
                externalLink: 'https://x.com/owner/status/123',
              },
            },
          },
    );
  });
  const results = await publishBatch(
    bufferConnection,
    [await target('x'), await target('threads')],
    testEnv(),
  );
  expect(results[0]).toMatchObject({ kind: 'accepted', remoteId: 'post-ok' });
  expect(results[1]!.kind).toBe('rejected');
  expect(JSON.stringify(results)).not.toContain('synthetic-buffer-first');
  const receipts = await readReceipts(bufferConnection, ['post-ok'], testEnv());
  expect(receipts[0]).toMatchObject({ state: 'published', remoteId: 'post-ok' });
  expect(calls.filter((c) => c.query.includes('createPost'))).toHaveLength(1);
  expect(calls).toHaveLength(2);
});
test('timeout_after_a_write_is_uncertain_and_is_never_retried', async () => {
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockRejectedValue(new DOMException('lost reply', 'AbortError'));
  const result = await publishBatch(bufferConnection, [await target('x')], testEnv());
  expect(result[0]!.kind).toBe('uncertain');
  expect(fetch).toHaveBeenCalledTimes(1);
});

test('a_slow_video_batch_keeps_its_accepted_ids_without_republishing', async () => {
  vi.useFakeTimers();
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException('timeout', 'TimeoutError')), ms);
    return controller.signal;
  });
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (_input, init) =>
      new Promise<Response>((resolve, reject) => {
        init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
        setTimeout(
          () =>
            resolve(
              Response.json({
                data: {
                  p0: {
                    __typename: 'PostActionSuccess',
                    post: { id: 'slow-video', status: 'sending' },
                  },
                },
              }),
            ),
          35000,
        );
      }),
  );
  try {
    const t = video(await target('x'));
    const pending = publishBatch(bufferConnection, [t], testEnv());
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(35000);
    expect(await pending).toMatchObject([{ kind: 'accepted', remoteId: 'slow-video' }]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  } finally {
    timeout.mockRestore();
    vi.useRealTimers();
  }
});

test('youtube_video_creation_sends_the_category_the_user_reviewed', async () => {
  const calls = capture({
    data: {
      p0: { __typename: 'PostActionSuccess', post: { id: 'youtube-video', status: 'sending' } },
    },
  });
  const selected = { ...video(await target('youtube')), youtubeCategoryId: '25' as const };
  await publishBatch(bufferConnection, [selected], testEnv());
  expect(Object.values(calls[0]!.variables)[0].metadata.youtube.categoryId).toBe('25');
});

test('tiktok_photo_creation_sends_the_reviewed_title_and_original_image_urls', async () => {
  const calls = capture({
    data: {
      p0: { __typename: 'PostActionSuccess', post: { id: 'tiktok-photo', status: 'sending' } },
    },
  });
  const selected = { ...images(await target('tiktok')), title: 'صور رحلتي' };
  await publishBatch(bufferConnection, [selected], testEnv());
  const input = Object.values(calls[0]!.variables)[0];
  expect(input.metadata.tiktok.title).toBe('صور رحلتي');
  expect(input.assets.map((a: any) => a.image.url)).toEqual(selected.assets.map((a) => a.url));
});

test('missing_tiktok_photo_title_rejects_only_that_target_before_provider_write', async () => {
  const calls = capture({
    data: { p0: { __typename: 'PostActionSuccess', post: { id: 'post-x', status: 'sending' } } },
  });
  const results = await publishBatch(
    bufferConnection,
    [images(await target('tiktok')), await target('x')],
    testEnv(),
  );
  expect(results[0]).toMatchObject({
    kind: 'rejected',
    error: { code: 'TIKTOK_PHOTO_TITLE_REQUIRED' },
  });
  expect(results[1]).toMatchObject({ kind: 'accepted', remoteId: 'post-x' });
  expect(Object.values(calls[0]!.variables).map((v: any) => v.channelId)).toEqual(['remote-x']);
});

test('tiktok_video_does_not_receive_the_photo_only_title_field', async () => {
  const calls = capture({
    data: {
      p0: { __typename: 'PostActionSuccess', post: { id: 'tiktok-video', status: 'sending' } },
    },
  });
  await publishBatch(bufferConnection, [video(await target('tiktok'))], testEnv());
  const input = Object.values(calls[0]!.variables)[0];
  expect(input.metadata.tiktok).not.toHaveProperty('title');
  expect(input.assets[0].video.metadata.title).toBe('عنوان الفيديو');
});

test('missing_youtube_category_rejects_only_that_target_before_a_provider_write', async () => {
  const calls = capture({
    data: { p0: { __typename: 'PostActionSuccess', post: { id: 'post-x', status: 'sending' } } },
  });
  const missing = { ...video(await target('youtube')), youtubeCategoryId: undefined };
  const results = await publishBatch(bufferConnection, [missing, await target('x')], testEnv());
  expect(results[0]).toMatchObject({
    kind: 'rejected',
    error: { code: 'YOUTUBE_CATEGORY_REQUIRED' },
  });
  expect(results[1]).toMatchObject({ kind: 'accepted', remoteId: 'post-x' });
  expect(calls).toHaveLength(1);
  expect(Object.values(calls[0]!.variables).map((v) => v.channelId)).toEqual(['remote-x']);
});
test('threads_include_the_first_post_and_ordered_image_alt_text', async () => {
  const t = images(await target('threads'));
  t.threadParts = ['الأول', 'الثاني', 'الثالث'];
  t.text = 'الأول';
  const calls = capture({
    data: {
      p0: { __typename: 'PostActionSuccess', post: { id: 'post-thread', status: 'sending' } },
    },
  });
  await publishBatch(bufferConnection, [t], testEnv());
  const input = Object.values(calls[0]!.variables)[0];
  expect(input.metadata.threads.thread.map((p: any) => p.text)).toEqual([
    'الأول',
    'الثاني',
    'الثالث',
  ]);
  expect(input.metadata.threads.thread[0].assets.map((a: any) => a.image.url)).toEqual(
    t.assets.map((a) => a.url),
  );
  expect(input.metadata.threads.thread[0].assets.map((a: any) => a.image.metadata.altText)).toEqual(
    ['الصورة الأولى', 'الصورة الثانية'],
  );
  expect(input.metadata.threads.thread[1].assets).toEqual([]);
});
test('video_metadata_uses_the_confirmed_title', async () => {
  const calls = capture({
    data: {
      p0: { __typename: 'PostActionSuccess', post: { id: 'post-video', status: 'sending' } },
    },
  });
  await publishBatch(bufferConnection, [video(await target('youtube'))], testEnv());
  const input = Object.values(calls[0]!.variables)[0];
  expect(input.metadata.youtube.title).toBe('عنوان الفيديو');
  expect(input.assets[0].video.url).toBe('https://service.test/media/nonce/عنوان%20الفيديو.mp4');
  expect(input.assets[0].video.metadata.title).toBe('عنوان الفيديو');
});
test('retry_after_produces_an_exact_safe_retry_time', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-10T12:00:00Z'));
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(
      Response.json(
        { errors: [{ message: 'private synthetic-buffer-first' }] },
        { status: 429, headers: { 'Retry-After': '120' } },
      ),
    );
  const result = await publishBatch(bufferConnection, [await target('x')], testEnv());
  expect(result[0]).toMatchObject({ kind: 'rejected', retryAt: '2026-10-10T12:02:00.000Z' });
  expect(JSON.stringify(result)).not.toContain('synthetic-buffer-first');
  expect(fetch).toHaveBeenCalledTimes(1);
});
test('a_malformed_success_or_proxy_error_never_authorizes_an_automatic_repost', async () => {
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(
      Response.json({ data: { p0: { __typename: 'PostActionSuccess', post: {} } } }),
    )
    .mockResolvedValueOnce(
      Response.json({
        data: { p0: { __typename: 'RestProxyError', message: 'lost upstream reply' } },
      }),
    );
  const t = await target('x');
  expect((await publishBatch(bufferConnection, [t], testEnv()))[0]!.kind).toBe('uncertain');
  expect((await publishBatch(bufferConnection, [t], testEnv()))[0]!.kind).toBe('uncertain');
  expect(fetch).toHaveBeenCalledTimes(2);
});
test('foreign_workspace_channel_is_rejected_before_any_provider_request', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch');
  const t = await target('x');
  t.channelId = 'foreign-channel';
  expect((await publishBatch(bufferConnection, [t], testEnv()))[0]).toMatchObject({
    kind: 'rejected',
    error: { code: 'PROVIDER_CHANNEL' },
  });
  expect(fetch).not.toHaveBeenCalled();
});
test('empty_receipt_batch_does_not_poll_or_spend_requests', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch');
  expect(await readReceipts(bufferConnection, [], testEnv())).toEqual([]);
  expect(fetch).not.toHaveBeenCalled();
});
test('discovery_observes_live_headers_and_cannot_spend_reserved_receipt_credits', async () => {
  const { observeRateLimits } = await import('../src/providers/rate-budget');
  const { bufferAdapter } = await import('../src/providers/buffer');
  const now = new Date().toISOString();
  await observeRateLimits(
    bufferConnection.id,
    new Headers({ RateLimit: '"short";r=10;t=600', 'RateLimit-Policy': '"short";q=100;w=900' }),
    now,
    testEnv(),
  );
  const fetch = vi.spyOn(globalThis, 'fetch');
  await expect(bufferAdapter.discover(bufferConnection, testEnv())).rejects.toMatchObject({
    code: 'PROVIDER_RATE_LIMIT',
  });
  expect(fetch).not.toHaveBeenCalled();
});
