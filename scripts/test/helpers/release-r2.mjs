import { createHash } from 'node:crypto';
import { XMLBuilder, XMLParser } from 'fast-xml-parser';
import { createReleaseStore } from '../../release-store.mjs';
export function releaseR2() {
  const state = {
    now: Date.parse('2026-10-14T00:00:00Z'),
    objects: new Map(),
    etag: 0,
    beforeDelete: null,
  };
  const hash = (body) => createHash('sha256').update(body).digest('hex');
  function put(key, value, ageMs = 0, digest) {
    const body = Buffer.isBuffer(value)
      ? value
      : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');
    state.objects.set(key, {
      body,
      etag: '"' + ++state.etag + '"',
      date: new Date(state.now - ageMs).toISOString(),
      digest: digest ?? hash(body),
    });
  }
  put('_mawjivo-owner.json', { owner: 'mawjivo-release-store:v1' });
  async function signedFetch(input, init = {}) {
    const url = new URL(input),
      key = decodeURIComponent(url.pathname.replace(/^\/mawjivo-releases\//, ''));
    const item = state.objects.get(key),
      headers = new Headers(init.headers),
      method = init.method ?? 'GET';
    const response = (body, status = 200, extra = {}) =>
      new Response(body, {
        status,
        headers: { Date: new Date(state.now).toUTCString(), ...extra },
      });
    if (url.searchParams.has('list-type'))
      return response(
        new XMLBuilder().build({
          ListBucketResult: {
            IsTruncated: 'false',
            Contents: [...state.objects].map(([Key, v]) => ({
              Key,
              Size: String(v.body.length),
              LastModified: v.date,
            })),
          },
        }),
      );
    if (method === 'POST' && url.searchParams.has('delete')) {
      const parsed = new XMLParser({ isArray: (name) => name === 'Object' }).parse(init.body);
      const keys = parsed.Delete.Object.map((o) => o.Key);
      await state.beforeDelete?.(keys);
      for (const k of keys) state.objects.delete(k);
      return response(
        new XMLBuilder().build({ DeleteResult: { Deleted: keys.map((Key) => ({ Key })) } }),
      );
    }
    if (method === 'PUT') {
      if (
        (headers.get('if-none-match') === '*' && item) ||
        (headers.has('if-match') && headers.get('if-match') !== item?.etag)
      )
        return response(null, 412);
      let body = init.body;
      if (typeof body !== 'string' && !Buffer.isBuffer(body)) {
        const chunks = [];
        for await (const chunk of body) chunks.push(chunk);
        body = Buffer.concat(chunks);
      }
      put(key, body, 0, headers.get('x-amz-meta-sha256') ?? undefined);
      return response(null, 200, { etag: state.objects.get(key).etag });
    }
    if (!item) return response(null, 404);
    const extra = {
      etag: item.etag,
      'content-length': String(item.body.length),
      'x-amz-meta-sha256': item.digest,
    };
    return response(method === 'HEAD' ? null : item.body, 200, extra);
  }
  const publicFetch = async (url) => {
    const item = state.objects.get(new URL(url).pathname.slice(1));
    return new Response(item?.body ?? null, { status: item ? 200 : 404 });
  };
  const store = () =>
    createReleaseStore(
      {
        MAWJIVO_RELEASE_ACCOUNT_ID: 'a'.repeat(32),
        MAWJIVO_RELEASE_ACCESS_KEY_ID: 'TEST_access',
        MAWJIVO_RELEASE_SECRET_KEY: 'TEST_secret',
      },
      { signedFetch, publicFetch },
    );
  return { state, put, store, signedFetch, publicFetch };
}
