import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { XMLParser, XMLBuilder, XMLValidator } from 'fast-xml-parser';
import { AwsClient } from '../apps/service/node_modules/aws4fetch/dist/aws4fetch.esm.mjs';

const LIMIT = 2 * 1024 * 1024;
const CAP = 1_000_000_000;
const manifestKey = (channel) =>
  channel === 'production'
    ? 'updates/windows-x86_64.json'
    : channel === 'test'
      ? 'updates/windows-x86_64-test.json'
      : (() => {
          throw new Error('RELEASE_CHANNEL');
        })();
const parser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: false,
  isArray: (name) => ['Contents', 'Deleted', 'Error'].includes(name),
});
function xmlResult(text, root) {
  if (/<!DOCTYPE|<!ENTITY/i.test(text) || XMLValidator.validate(text) !== true)
    throw new Error('RELEASE_LIST_INVALID');
  let result;
  try {
    result = parser.parse(text);
  } catch {
    throw new Error('RELEASE_LIST_INVALID');
  }
  if (!result || !result[root] || typeof result[root] !== 'object' || Array.isArray(result[root]))
    throw new Error('RELEASE_LIST_INVALID');
  return result[root];
}
async function bounded(response) {
  const parts = [];
  let bytes = 0;
  if (!response.body) return '';
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > LIMIT) throw new Error('RELEASE_RESPONSE_LIMIT');
    parts.push(chunk);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts));
  } catch {
    throw new Error('RELEASE_RESPONSE_INVALID');
  }
}
async function responseHash(response, expectedBytes) {
  if (!response.ok || !response.body) throw new Error('RELEASE_PUBLIC_UNAVAILABLE');
  let bytes = 0;
  const hash = createHash('sha256');
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > expectedBytes) throw new Error('RELEASE_PUBLIC_HASH');
    hash.update(chunk);
  }
  if (bytes !== expectedBytes) throw new Error('RELEASE_PUBLIC_HASH');
  return hash.digest('hex');
}
function checkedKey(key) {
  if (
    typeof key !== 'string' ||
    !key ||
    key.length > 1024 ||
    key.includes('\0') ||
    key.split('/').some((part) => part === '.' || part === '..')
  )
    throw new Error('RELEASE_OBJECT_KEY');
  return key;
}
function packageKey(key) {
  return /^releases\/\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?\/Mawjivo[A-Za-z0-9_.-]{1,160}\.exe(?:\.sig)?$/.test(
    key,
  );
}
export function createReleaseStore(credentials, options = {}) {
  const account = credentials.MAWJIVO_RELEASE_ACCOUNT_ID,
    accessKeyId = credentials.MAWJIVO_RELEASE_ACCESS_KEY_ID,
    secretAccessKey = credentials.MAWJIVO_RELEASE_SECRET_KEY;
  if (!/^[a-f0-9]{32}$/.test(account ?? '') || !accessKeyId || !secretAccessKey)
    throw new Error('RELEASE_CREDENTIALS_MISSING');
  const signer = new AwsClient({
    accessKeyId,
    secretAccessKey,
    service: 's3',
    region: 'auto',
    retries: 0,
  });
  const signedFetch = options.signedFetch ?? signer.fetch.bind(signer);
  const publicFetch = options.publicFetch ?? fetch;
  const bucket = options.bucket ?? 'mawjivo-releases';
  if (bucket !== 'mawjivo-releases' && !/^mawjivo-release-test-[a-z0-9-]{1,40}$/.test(bucket))
    throw new Error('RELEASE_BUCKET_SCOPE');
  const endpoint = `https://${account}.r2.cloudflarestorage.com/${bucket}/`;
  const location = (key) => endpoint + checkedKey(key).split('/').map(encodeURIComponent).join('/');
  const signed = (url, init = {}) =>
    signedFetch(url, {
      ...init,
      // Cloudflare compression weakens response ETags. Preserve the original
      // representation so If-Match remains a real compare-and-swap condition.
      headers: new Headers({
        ...Object.fromEntries(new Headers(init.headers)),
        'Accept-Encoding': 'identity',
      }),
      signal: AbortSignal.timeout(init.method === 'PUT' ? 300000 : 60000),
    });
  const publicVerified = new Set();
  let owned = false,
    inventory = null,
    lease = null;
  const lockKey = '_mawjivo-release-lock.json',
    leaseMs = 15 * 60000;
  async function readLease() {
    await verifyOwnership();
    const response = await signed(location(lockKey));
    const now = Date.parse(response.headers.get('date') ?? '');
    if (!Number.isFinite(now)) throw new Error('RELEASE_PUBLICATION_CLOCK');
    if (response.status === 404) return { value: null, etag: null, now };
    if (!response.ok) throw new Error('RELEASE_PUBLICATION_LOCK_FAILED');
    const etag = response.headers.get('etag');
    const value = JSON.parse(await bounded(response));
    if (
      !etag ||
      value.schemaVersion !== 1 ||
      typeof value.owner !== 'string' ||
      !Number.isSafeInteger(value.expiresAt) ||
      value.expiresAt < 0
    )
      throw new Error('RELEASE_PUBLICATION_LOCK_INVALID');
    return { value, etag, now };
  }
  async function writeLease(value, etag) {
    const response = await signed(location(lockKey), {
      method: 'PUT',
      body: JSON.stringify(value) + '\n',
      headers: {
        'Content-Type': 'application/json',
        ...(etag === null ? { 'If-None-Match': '*' } : { 'If-Match': etag }),
      },
    });
    if (response.status === 412) throw new Error('RELEASE_PUBLICATION_BUSY');
    if (!response.ok || !response.headers.get('etag'))
      throw new Error('RELEASE_PUBLICATION_LOCK_FAILED');
    return response.headers.get('etag');
  }
  async function guardMutation() {
    if (!lease) throw new Error('RELEASE_PUBLICATION_LOCK_REQUIRED');
    const current = await readLease();
    // Leave more than the maximum five-minute request deadline before expiry.
    if (
      current.value?.owner !== lease.owner ||
      current.etag !== lease.etag ||
      current.value.expiresAt - current.now <= 6 * 60000
    )
      throw new Error('RELEASE_PUBLICATION_LEASE_LOST');
    lease.etag = await writeLease(
      { schemaVersion: 1, owner: lease.owner, expiresAt: current.now + leaseMs },
      current.etag,
    );
  }
  async function withMutationLock(action) {
    if (lease) throw new Error('RELEASE_PUBLICATION_BUSY');
    const current = await readLease();
    if (current.value?.owner && current.value.expiresAt > current.now)
      throw new Error('RELEASE_PUBLICATION_BUSY');
    const owner = randomUUID(),
      value = { schemaVersion: 1, owner, expiresAt: current.now + leaseMs };
    const objects = await listObjects('');
    const oldBytes = objects.find((object) => object.key === lockKey)?.bytes ?? 0;
    if (
      objects.reduce((sum, object) => sum + object.bytes, 0) -
        oldBytes +
        Buffer.byteLength(JSON.stringify(value) + '\n') >
      CAP
    )
      throw new Error('RELEASE_STORAGE_LIMIT');
    lease = { owner, etag: await writeLease(value, current.etag) };
    inventory = null;
    try {
      return await action();
    } finally {
      const held = lease;
      lease = null;
      // A replaced/expired owner must never clear the newer writer's lease.
      try {
        await writeLease({ schemaVersion: 1, owner: '', expiresAt: 0 }, held.etag);
      } catch (error) {
        if (error.message !== 'RELEASE_PUBLICATION_BUSY') throw error;
      }
      inventory = null;
    }
  }
  async function verifyOwnership() {
    if (owned) return;
    const response = await signed(location('_mawjivo-owner.json'));
    if (response.status !== 200) throw new Error('RELEASE_STORE_NOT_OWNED');
    let marker;
    try {
      marker = JSON.parse(await bounded(response));
    } catch {
      throw new Error('RELEASE_STORE_NOT_OWNED');
    }
    if (marker.owner !== 'mawjivo-release-store:v1') throw new Error('RELEASE_STORE_NOT_OWNED');
    owned = true;
  }
  async function listObjects(prefix = '') {
    await verifyOwnership();
    const result = [],
      keys = new Set(),
      tokens = new Set();
    let token = '';
    for (let page = 0; page < 20; page++) {
      const url = new URL(endpoint);
      url.searchParams.set('list-type', '2');
      url.searchParams.set('max-keys', '1000');
      if (prefix) url.searchParams.set('prefix', prefix);
      if (token) url.searchParams.set('continuation-token', token);
      const response = await signed(url);
      if (!response.ok) throw new Error('RELEASE_LIST_UNAVAILABLE');
      const data = xmlResult(await bounded(response), 'ListBucketResult');
      const contents = data.Contents ?? [];
      if (!Array.isArray(contents) || contents.length > 1000)
        throw new Error('RELEASE_LIST_INVALID');
      for (const entry of contents) {
        const key = checkedKey(entry.Key);
        if (
          keys.has(key) ||
          typeof entry.Size !== 'string' ||
          !/^\d+$/.test(entry.Size) ||
          !Number.isSafeInteger(Number(entry.Size)) ||
          typeof entry.LastModified !== 'string' ||
          !Number.isFinite(Date.parse(entry.LastModified))
        )
          throw new Error('RELEASE_LIST_INVALID');
        keys.add(key);
        result.push({
          key,
          bytes: Number(entry.Size),
          lastModified: entry.LastModified,
          etag: entry.ETag ?? null,
        });
      }
      if (data.IsTruncated === 'false') return result;
      if (
        data.IsTruncated !== 'true' ||
        typeof data.NextContinuationToken !== 'string' ||
        !data.NextContinuationToken
      )
        throw new Error('RELEASE_LIST_INVALID');
      token = data.NextContinuationToken;
      if (tokens.has(token)) throw new Error('RELEASE_LIST_LIMIT');
      tokens.add(token);
    }
    throw new Error('RELEASE_LIST_LIMIT');
  }
  async function inspect(object) {
    await verifyOwnership();
    const response = await signed(location(object.key), { method: 'HEAD' });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error('RELEASE_INSPECT_FAILED');
    const length = response.headers.get('content-length');
    if (!/^\d+$/.test(length ?? '') || !Number.isSafeInteger(Number(length)))
      throw new Error('RELEASE_INSPECT_FAILED');
    const bytes = Number(length),
      sha256 = response.headers.get('x-amz-meta-sha256');
    if (sha256 && /^[a-f0-9]{64}$/.test(sha256))
      return { bytes, sha256, etag: response.headers.get('etag') };
    if (bytes !== object.bytes) return { bytes, sha256: null, etag: response.headers.get('etag') };
    const stored = await signed(location(object.key));
    return { bytes, sha256: await responseHash(stored, bytes), etag: response.headers.get('etag') };
  }
  async function verifyPublic(object, options = {}) {
    if (object.url !== `https://downloads.aimansour.com/${object.key}`)
      throw new Error('RELEASE_PUBLIC_URL');
    const identity = JSON.stringify([object.key, object.bytes, object.sha256]);
    if (!options.fresh && publicVerified.has(identity)) return;
    const response = await publicFetch(object.url, {
      redirect: 'error',
      signal: AbortSignal.timeout(300000),
    });
    if ((await responseHash(response, object.bytes)) !== object.sha256)
      throw new Error('RELEASE_PUBLIC_HASH');
    publicVerified.add(identity);
  }
  async function upload(object) {
    await verifyOwnership();
    if (
      !packageKey(object.key) ||
      !Number.isSafeInteger(object.bytes) ||
      object.bytes <= 0 ||
      !/^[a-f0-9]{64}$/.test(object.sha256)
    )
      throw new Error('RELEASE_OBJECT_INVALID');
    const existing = await inspect(object);
    if (existing) {
      if (existing.bytes !== object.bytes || existing.sha256 !== object.sha256)
        throw new Error('RELEASE_IMMUTABLE_CONFLICT');
      await verifyPublic(object);
      return;
    }
    inventory ??= new Map((await listObjects('')).map((item) => [item.key, item.bytes]));
    const used = [...inventory.values()].reduce((sum, value) => sum + value, 0);
    if (!Number.isSafeInteger(used) || used + object.bytes > CAP)
      throw new Error('RELEASE_STORAGE_LIMIT');
    const body = createReadStream(object.path);
    let response;
    try {
      await guardMutation();
      response = await signed(location(object.key), {
        method: 'PUT',
        body,
        duplex: 'half',
        headers: {
          'Content-Length': String(object.bytes),
          'Content-Type': object.contentType,
          'Cache-Control': 'public, max-age=31536000, immutable',
          'If-None-Match': '*',
          'x-amz-content-sha256': object.sha256,
          'x-amz-meta-sha256': object.sha256,
        },
      });
    } finally {
      body.destroy();
    }
    if (response.status === 412) {
      const winner = await inspect(object);
      if (!winner || winner.bytes !== object.bytes || winner.sha256 !== object.sha256)
        throw new Error('RELEASE_IMMUTABLE_CONFLICT');
    } else if (!response.ok) throw new Error('RELEASE_UPLOAD_FAILED');
    await verifyPublic(object);
    inventory.set(object.key, object.bytes);
  }
  async function readJson(key) {
    await verifyOwnership();
    const response = await signed(location(key));
    if (response.status === 404) return { value: null, etag: null };
    if (!response.ok) throw new Error('RELEASE_READ_FAILED');
    const etag = response.headers.get('etag');
    if (!etag) throw new Error('RELEASE_ETAG_MISSING');
    let value;
    try {
      value = JSON.parse(await bounded(response));
    } catch (error) {
      if (error.message === 'RELEASE_RESPONSE_LIMIT') throw error;
      throw new Error('RELEASE_RESPONSE_INVALID');
    }
    return { value, etag };
  }
  async function putJson(key, value, expectedEtag, publicCheck) {
    await verifyOwnership();
    if (expectedEtag !== null && (typeof expectedEtag !== 'string' || !expectedEtag))
      throw new Error('RELEASE_ETAG_MISSING');
    const body = JSON.stringify(value, null, 2) + '\n';
    if (Buffer.byteLength(body) > LIMIT) throw new Error('RELEASE_RESPONSE_LIMIT');
    inventory ??= new Map((await listObjects('')).map((item) => [item.key, item.bytes]));
    const total = [...inventory.values()].reduce((sum, bytes) => sum + bytes, 0);
    if (
      !Number.isSafeInteger(total) ||
      total - (inventory.get(key) ?? 0) + Buffer.byteLength(body) > CAP
    )
      throw new Error('RELEASE_STORAGE_LIMIT');
    const condition =
      expectedEtag === null ? { 'If-None-Match': '*' } : { 'If-Match': expectedEtag };
    await guardMutation();
    const response = await signed(location(key), {
      method: 'PUT',
      body,
      headers: {
        ...condition,
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
    if (response.status === 412) throw new Error('RELEASE_PUBLICATION_CONFLICT');
    if (!response.ok) throw new Error('RELEASE_WRITE_FAILED');
    inventory.set(key, Buffer.byteLength(body));
    if (publicCheck) {
      const published = await publicFetch('https://downloads.aimansour.com/' + key, {
        redirect: 'error',
        signal: AbortSignal.timeout(60000),
      });
      if (!published.ok || (await bounded(published)) !== body)
        throw new Error('RELEASE_MANIFEST_PUBLIC_CHECK');
    }
    return { etag: response.headers.get('etag') };
  }
  async function verifyManifest(channel, value) {
    const response = await publicFetch('https://downloads.aimansour.com/' + manifestKey(channel), {
      redirect: 'error',
      signal: AbortSignal.timeout(60000),
    });
    if (!response.ok || (await bounded(response)) !== JSON.stringify(value, null, 2) + '\n')
      throw new Error('RELEASE_MANIFEST_PUBLIC_CHECK');
  }
  async function deleteObjects(keys) {
    await verifyOwnership();
    if (
      !Array.isArray(keys) ||
      keys.length > 20000 ||
      new Set(keys).size !== keys.length ||
      keys.some((key) => !packageKey(key))
    )
      throw new Error('RELEASE_DELETE_SCOPE');
    const deletedKeys = [],
      errors = [];
    for (let start = 0; start < keys.length; start += 1000) {
      const batch = keys.slice(start, start + 1000);
      const body = new XMLBuilder({ ignoreAttributes: false }).build({
        Delete: { Object: batch.map((Key) => ({ Key })), Quiet: 'false' },
      });
      const url = new URL(endpoint);
      url.searchParams.set('delete', '');
      await guardMutation();
      const response = await signed(url, {
        method: 'POST',
        body,
        headers: {
          'Content-Type': 'application/xml',
          'Content-MD5': createHash('md5').update(body).digest('base64'),
        },
      });
      if (!response.ok) throw new Error('RELEASE_DELETE_FAILED');
      const result = xmlResult(await bounded(response), 'DeleteResult');
      const confirmed = new Set();
      for (const item of result.Deleted ?? []) {
        if (!batch.includes(item.Key) || confirmed.has(item.Key))
          throw new Error('RELEASE_DELETE_RESPONSE');
        confirmed.add(item.Key);
        deletedKeys.push(item.Key);
        inventory?.delete(item.Key);
      }
      for (const item of result.Error ?? []) {
        if (!batch.includes(item.Key) || confirmed.has(item.Key))
          throw new Error('RELEASE_DELETE_RESPONSE');
        confirmed.add(item.Key);
        errors.push({
          key: item.Key,
          code: /^[A-Za-z0-9_-]{1,100}$/.test(item.Code ?? '') ? item.Code : 'DELETE_FAILED',
        });
      }
      for (const key of batch)
        if (!confirmed.has(key)) errors.push({ key, code: 'DELETE_UNCONFIRMED' });
    }
    return { deletedKeys, errors };
  }
  return {
    withMutationLock,
    verifyOwnership,
    listObjects,
    inspect,
    upload,
    verifyPublic,
    readManifest: (channel) => readJson(manifestKey(channel)),
    putManifest: (channel, value, etag) => putJson(manifestKey(channel), value, etag, true),
    verifyManifest,
    readIndex: () => readJson('_mawjivo-release-index.json'),
    putIndex: (value, etag) => putJson('_mawjivo-release-index.json', value, etag, false),
    deleteObjects,
  };
}
