import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReleaseStore } from '../release-store.mjs';

const bytes = Buffer.from('synthetic installer bytes');
const digest = createHash('sha256').update(bytes).digest('hex');
const object = {
  key: 'releases/0.1.1/Mawjivo_0.1.1_x64-setup.exe',
  name: 'Mawjivo_0.1.1_x64-setup.exe',
  bytes: bytes.length,
  sha256: digest,
  url: 'https://downloads.aimansour.com/releases/0.1.1/Mawjivo_0.1.1_x64-setup.exe',
  contentType: 'application/octet-stream',
};
function fakeStore(options = {}) {
  const calls = [];
  const publicCalls = [];
  const signedFetch = async (input, init = {}) => {
    const url = new URL(input),
      method = init.method ?? 'GET';
    calls.push({ url, method, headers: new Headers(init.headers), body: init.body });
    if (url.pathname.endsWith('/_mawjivo-owner.json'))
      return Response.json({
        owner: options.foreign ? 'another-owner' : 'mawjivo-release-store:v1',
      });
    if (url.searchParams.get('list-type') === '2')
      return new Response(
        options.xml ?? '<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>',
      );
    if (method === 'HEAD')
      return options.exists
        ? new Response(null, {
            headers: {
              'content-length': String(bytes.length),
              'x-amz-meta-sha256': options.different ? '0'.repeat(64) : digest,
              etag: '"object-etag"',
            },
          })
        : new Response(null, { status: 404 });
    if (method === 'PUT')
      return new Response(null, {
        status: options.conflict ? 412 : 200,
        headers: { etag: '"new-etag"' },
      });
    if (method === 'POST' && url.searchParams.has('delete')) return new Response(options.deleteXml);
    if (url.pathname.endsWith('/updates/windows-x86_64.json'))
      return options.absent
        ? new Response(null, { status: 404 })
        : Response.json({ version: '0.1.0' }, { headers: { etag: '"manifest-etag"' } });
    return new Response(null, { status: 404 });
  };
  const publicFetch = async (...args) => {
    publicCalls.push(args);
    return new Response(options.publicBody ?? (options.badPublic ? 'wrong bytes' : bytes));
  };
  const store = createReleaseStore(
    {
      MAWJIVO_RELEASE_ACCOUNT_ID: 'a'.repeat(32),
      MAWJIVO_RELEASE_ACCESS_KEY_ID: 'TEST_release_access',
      MAWJIVO_RELEASE_SECRET_KEY: 'TEST_release_secret',
    },
    { signedFetch, publicFetch },
  );
  return { store, calls, publicCalls };
}
async function localObject(run) {
  const directory = await mkdtemp(join(tmpdir(), 'mawjivo-release-object-'));
  try {
    const path = join(directory, object.name);
    await writeFile(path, bytes);
    await run({ ...object, path });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
test('a foreign ownership marker prevents writes', async () => {
  const { store, calls } = fakeStore({ foreign: true });
  await localObject(
    async (object) => await assert.rejects(store.upload(object), /RELEASE_STORE_NOT_OWNED/),
  );
  assert.equal(calls.filter((call) => call.method === 'PUT').length, 0);
});
test('an identical immutable file skips PUT and is verified publicly', async () => {
  const { store, calls } = fakeStore({ exists: true });
  await localObject(async (object) => await store.upload(object));
  assert.equal(calls.filter((call) => call.method === 'PUT').length, 0);
});
test('different immutable bytes never replace the same key', async () => {
  const { store, calls } = fakeStore({ exists: true, different: true });
  await localObject(async (object) => await assert.rejects(store.upload(object), /IMMUTABLE/));
  assert.equal(calls.filter((call) => call.method === 'PUT').length, 0);
});
test('an upload uses create-only headers and rejects a conflicting winner', async () => {
  const { store, calls } = fakeStore({ conflict: true });
  await localObject(async (object) => await assert.rejects(store.upload(object), /CONFLICT/));
  assert.equal(calls.find((call) => call.method === 'PUT').headers.get('if-none-match'), '*');
});
test('wrong anonymous public bytes prevent successful upload', async () => {
  const { store } = fakeStore({ badPublic: true });
  await localObject(async (object) => await assert.rejects(store.upload(object), /PUBLIC_HASH/));
});
test('manifest reads preserve etags and missing manifests have a null etag', async () => {
  assert.deepEqual(await fakeStore().store.readManifest('production'), {
    value: { version: '0.1.0' },
    etag: '"manifest-etag"',
  });
  assert.deepEqual(await fakeStore({ absent: true }).store.readManifest('production'), {
    value: null,
    etag: null,
  });
});
test('manifest writes use CAS and never bypass a 412', async () => {
  const { store, calls } = fakeStore({ conflict: true });
  await assert.rejects(
    store.putManifest('production', { version: '0.1.1' }, '"old-etag"'),
    /CONFLICT/,
  );
  assert.equal(calls.find((call) => call.method === 'PUT').headers.get('if-match'), '"old-etag"');
});
test('list reads decode escaped object keys exactly once and reject duplicate keys', async () => {
  const contents =
    '<Contents><Key>releases/0.1.1/Mawjivo&amp;amp;.exe</Key><Size>10</Size><LastModified>2026-10-01T00:00:00Z</LastModified><ETag>&quot;file&quot;</ETag></Contents>';
  const xml = `<ListBucketResult>${contents}<IsTruncated>false</IsTruncated></ListBucketResult>`;
  const rows = await fakeStore({ xml }).store.listObjects('releases/');
  assert.equal(rows[0].key, 'releases/0.1.1/Mawjivo&amp;.exe');
  await assert.rejects(
    fakeStore({ xml: xml.replace(contents, contents + contents) }).store.listObjects('releases/'),
    /RELEASE_LIST_INVALID/,
  );
});
test('rejects malformed or oversized XML and repeated pagination tokens', async () => {
  for (const xml of [
    '<ListBucketResult>',
    'x'.repeat(2 * 1024 * 1024 + 1),
    '<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>repeat</NextContinuationToken></ListBucketResult>',
  ]) {
    await assert.rejects(
      fakeStore({ xml }).store.listObjects(''),
      /RELEASE_(?:LIST_INVALID|RESPONSE_LIMIT|LIST_LIMIT)/,
    );
  }
});

test('bulk deletion reports only confirmed keys and keeps partial errors separate', async () => {
  const signature = object.key + '.sig';
  const { store, calls } = fakeStore({
    deleteXml: `<DeleteResult><Deleted><Key>${object.key}</Key></Deleted><Error><Key>${signature}</Key><Code>AccessDenied</Code><Message>not allowed</Message></Error></DeleteResult>`,
  });
  assert.deepEqual(await store.deleteObjects([object.key, signature]), {
    deletedKeys: [object.key],
    errors: [{ key: signature, code: 'AccessDenied' }],
  });
  const deletion = calls.find((call) => call.method === 'POST');
  assert.equal(deletion.url.searchParams.get('delete'), '');
  assert.equal(
    deletion.headers.get('content-md5'),
    createHash('md5').update(deletion.body).digest('base64'),
  );
});
test('bulk deletion rejects protected paths and unexpected response keys', async () => {
  const { store, calls } = fakeStore();
  await assert.rejects(store.deleteObjects(['media-tools/sources.zip']), /RELEASE_DELETE_SCOPE/);
  assert.equal(calls.filter((call) => call.method === 'POST').length, 0);
  const malicious = fakeStore({
    deleteXml: '<DeleteResult><Deleted><Key>media-tools/sources.zip</Key></Deleted></DeleteResult>',
  });
  await assert.rejects(malicious.store.deleteObjects([object.key]), /RELEASE_DELETE_RESPONSE/);
});
test('new manifests and indexes cannot exceed the total release storage cap', async () => {
  const xml =
    '<ListBucketResult><Contents><Key>media-tools/sources.zip</Key><Size>1000000000</Size><LastModified>2026-10-01T00:00:00Z</LastModified></Contents><IsTruncated>false</IsTruncated></ListBucketResult>';
  for (const write of [
    (store) => store.putManifest('production', { version: '0.1.1' }, null),
    (store) => store.putIndex({ schemaVersion: 1, records: [] }, null),
  ]) {
    const { store, calls } = fakeStore({ xml });
    await assert.rejects(write(store), /RELEASE_STORAGE_LIMIT/);
    assert.equal(calls.filter((call) => call.method === 'PUT').length, 0);
  }
});

test('an immutable object is publicly hashed once per publication attempt', async () => {
  const { store, publicCalls } = fakeStore({ exists: true });
  await localObject(async (object) => {
    await store.upload(object);
    await store.verifyPublic(object);
  });
  assert.equal(publicCalls.length, 1);
});
