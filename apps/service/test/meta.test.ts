import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { publishBatch, readReceipts, continuePublishing } from '../src/providers/meta';
import { metaConnection, seedConnection, target, images, video } from './publishing-fixtures';
import { resetTestData, testEnv } from './helpers';
import type { ProviderState } from '../src/providers/types';
beforeEach(async () => {
  await resetTestData();
  await seedConnection(metaConnection);
});
afterEach(() => vi.restoreAllMocks());
function urlOf(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}
test('facebook_carousel_preserves_image_order_and_alt_text', async () => {
  const calls: { url: string; body: URLSearchParams }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = urlOf(input);
    const body = new URLSearchParams(String(init?.body));
    calls.push({ url, body });
    if (url.endsWith('/12345/photos')) return Response.json({ id: String(1000 + calls.length) });
    if (url.endsWith('/12345/feed')) return Response.json({ id: '12345_900' });
    throw new Error('unexpected provider call');
  });
  const t = images(await target('facebook', metaConnection));
  const checkpoints: ProviderState[] = [];
  t.checkpoint = async (state) => {
    checkpoints.push(structuredClone(state));
  };
  const result = await publishBatch(metaConnection, [t], testEnv());
  expect(result[0]).toMatchObject({ kind: 'accepted', remoteId: 'fb-post:12345_900' });
  expect(calls.slice(0, 2).map((c) => c.body.get('url'))).toEqual(t.assets.map((a) => a.url));
  expect(calls.slice(0, 2).map((c) => c.body.get('alt_text_custom'))).toEqual(t.altTexts);
  expect(calls.slice(0, 2).map((c) => c.body.get('published'))).toEqual(['false', 'false']);
  expect(JSON.parse(calls[2]!.body.get('attached_media')!)).toEqual([
    { media_fbid: '1001' },
    { media_fbid: '1002' },
  ]);
  expect(checkpoints[1]!.childIds).toEqual(['1001', '1002']);
});
test('instagram_carousel_stages_children_in_order_without_publishing_early', async () => {
  const calls: URLSearchParams[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    const body = new URLSearchParams(String(init?.body));
    calls.push(body);
    return Response.json({
      id: body.get('media_type') === 'CAROUSEL' ? '800' : String(1000 + calls.length),
    });
  });
  const t = images(await target('instagram', metaConnection));
  const result = await publishBatch(metaConnection, [t], testEnv());
  expect(result[0]).toMatchObject({ kind: 'accepted', remoteId: 'ig-container:800' });
  expect(calls.slice(0, 2).map((c) => c.get('image_url'))).toEqual(t.assets.map((a) => a.url));
  expect(calls.slice(0, 2).map((c) => c.get('alt_text'))).toEqual(t.altTexts);
  expect(calls.slice(0, 2).map((c) => c.get('is_carousel_item'))).toEqual(['true', 'true']);
  expect(calls[2]!.get('children')).toBe('1001,1002');
  expect(calls).toHaveLength(3);
});
test('instagram_video_remains_processing_until_confirmed_delivery', async () => {
  const calls: { url: string; method: string }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = urlOf(input);
    calls.push({ url, method: init?.method ?? 'GET' });
    return Response.json(init?.method === 'POST' ? { id: '800' } : { status_code: 'IN_PROGRESS' });
  });
  const result = await publishBatch(
    metaConnection,
    [video(await target('instagram', metaConnection))],
    testEnv(),
  );
  expect(result[0]).toMatchObject({ kind: 'accepted', remoteId: 'ig-container:800' });
  const receipt = await readReceipts(metaConnection, ['ig-container:800'], testEnv());
  expect(receipt[0]!.state).toBe('processing');
  expect(calls.some((c) => c.url.includes('media_publish'))).toBe(false);
});
test('finished_container_is_read_only_then_one_explicit_publish_can_continue', async () => {
  const calls: { url: string; method: string; body: URLSearchParams }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = urlOf(input),
      method = init?.method ?? 'GET';
    calls.push({ url, method, body: new URLSearchParams(String(init?.body ?? '')) });
    if (url.includes('media_publish')) return Response.json({ id: '999' });
    return Response.json({ status_code: 'FINISHED' });
  });
  const receipt = await readReceipts(metaConnection, ['ig-container:800'], testEnv());
  expect(receipt[0]).toMatchObject({
    state: 'processing',
    continuation: { kind: 'instagram-publish', containerId: '800' },
  });
  expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  const t = video(await target('instagram', metaConnection));
  t.providerState = { kind: 'instagram', childIds: [], containerId: '800' };
  const result = await continuePublishing(metaConnection, t, testEnv());
  expect(result).toMatchObject({ kind: 'accepted', remoteId: 'ig-media:999' });
  expect(calls[1]!.body.get('creation_id')).toBe('800');
  expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
});
test('a_write_timeout_is_uncertain_and_does_not_repeat_a_feed_write', async () => {
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockRejectedValue(new DOMException('network', 'AbortError'));
  const result = await publishBatch(
    metaConnection,
    [await target('facebook', metaConnection)],
    testEnv(),
  );
  expect(result[0]!.kind).toBe('uncertain');
  expect(fetch).toHaveBeenCalledTimes(1);
});
test('failure_to_checkpoint_a_created_photo_stops_before_the_public_feed', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ id: '1001' }));
  const t = images(await target('facebook', metaConnection));
  t.checkpoint = async () => {
    throw new Error('local persistence fixture');
  };
  const result = await publishBatch(metaConnection, [t], testEnv());
  expect(result[0]!.kind).toBe('uncertain');
  expect(fetch).toHaveBeenCalledTimes(1);
});
test('facebook_video_ready_processing_is_not_confirmed_publication', async () => {
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(
      Response.json({
        id: '123',
        published: false,
        status: { video_status: 'ready', publishing_phase: { status: 'in_progress' } },
      }),
    )
    .mockResolvedValueOnce(
      Response.json({
        id: '123',
        published: true,
        status: { video_status: 'ready', publishing_phase: { status: 'complete' } },
        permalink_url: 'https://www.facebook.com/watch/?v=123',
      }),
    );
  expect((await readReceipts(metaConnection, ['fb-video:123'], testEnv()))[0]!.state).toBe(
    'processing',
  );
  expect((await readReceipts(metaConnection, ['fb-video:123'], testEnv()))[0]!.state).toBe(
    'published',
  );
  expect(fetch).toHaveBeenCalledTimes(2);
});
test('restarting_a_carousel_keeps_checkpointed_photos_and_their_order', async () => {
  const calls: URLSearchParams[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    const body = new URLSearchParams(String(init?.body));
    calls.push(body);
    return Response.json({ id: body.has('attached_media') ? '12345_900' : '1002' });
  });
  const t = images(await target('facebook', metaConnection));
  t.providerState = { kind: 'facebook-photos', childIds: ['1001'] };
  expect((await publishBatch(metaConnection, [t], testEnv()))[0]!.kind).toBe('accepted');
  expect(calls[0]!.get('url')).toBe(t.assets[1]!.url);
  expect(JSON.parse(calls[1]!.get('attached_media')!)).toEqual([
    { media_fbid: '1001' },
    { media_fbid: '1002' },
  ]);
  expect(calls).toHaveLength(2);
});
