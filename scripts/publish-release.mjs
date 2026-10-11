import { readFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { AwsClient } from '../apps/service/node_modules/aws4fetch/dist/aws4fetch.esm.mjs';
import { verifyReleasePackage } from './verify-release.mjs';
import { publishRelease } from './release-publication.mjs';

const directory = process.argv[2],
  channel = process.argv[3],
  proofPath = process.argv[4];
if (!directory || !channel) throw new Error('Provide verified package directory and channel.');
const account = process.env.MAWJIVO_RELEASE_ACCOUNT_ID,
  accessKeyId = process.env.MAWJIVO_RELEASE_ACCESS_KEY_ID,
  secretAccessKey = process.env.MAWJIVO_RELEASE_SECRET_KEY;
if (!/^[a-f0-9]{32}$/.test(account ?? '') || !accessKeyId || !secretAccessKey)
  throw new Error('Missing scoped release credentials.');
const release = await verifyReleasePackage(directory, { channel });
if (proofPath) release.acceptanceProof = JSON.parse(await readFile(proofPath, 'utf8'));
const signer = new AwsClient({
  accessKeyId,
  secretAccessKey,
  service: 's3',
  region: 'auto',
  retries: 2,
});
const endpoint = `https://${account}.r2.cloudflarestorage.com/mawjivo-releases/`;
const marker = await signer.fetch(endpoint + '_mawjivo-owner.json');
if (marker.status !== 200 || (await marker.json()).owner !== 'mawjivo-release-store:v1')
  throw new Error('RELEASE_STORE_NOT_OWNED');
let storedBytes = 0,
  token = '';
for (let page = 0; page < 20; page++) {
  const url = new URL(endpoint);
  url.searchParams.set('list-type', '2');
  url.searchParams.set('max-keys', '1000');
  if (token) url.searchParams.set('continuation-token', token);
  const response = await signer.fetch(url);
  if (!response.ok) throw new Error('RELEASE_QUOTA_UNAVAILABLE');
  const xml = await response.text();
  for (const size of xml.matchAll(/<Size>(\d+)<\/Size>/g)) storedBytes += Number(size[1]);
  if (!xml.includes('<IsTruncated>true</IsTruncated>')) break;
  token = xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/)?.[1];
  if (!token || page === 19) throw new Error('RELEASE_QUOTA_SCAN_LIMIT');
  token = token
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}
if (!Number.isSafeInteger(storedBytes) || storedBytes > 1_000_000_000)
  throw new Error('RELEASE_STORAGE_LIMIT');
async function publicHash(response, expectedBytes) {
  if (!response.ok || !response.body) throw new Error('RELEASE_PUBLIC_UNAVAILABLE');
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > expectedBytes) throw new Error('RELEASE_PUBLIC_HASH');
    hash.update(chunk);
  }
  if (bytes !== expectedBytes) throw new Error('RELEASE_PUBLIC_HASH');
  return hash.digest('hex');
}
let reserved = storedBytes;
await publishRelease(release, {
  verifySignature: async () => {
    // verifyReleasePackage above calls the native minisign verifier before any writes.
    console.log(
      'Verified signed installer ' + release.version + ' from ' + release.sourceCommit + '.',
    );
  },
  inspect: async (object) => {
    const response = await fetch(object.url, { signal: AbortSignal.timeout(300000) });
    if (response.status === 404) {
      reserved += object.bytes;
      if (reserved > 1_000_000_000) throw new Error('RELEASE_STORAGE_LIMIT');
      return null;
    }
    return { sha256: await publicHash(response, object.bytes) };
  },
  upload: async (object) => {
    console.log('Uploading signed release file: ' + object.name + '.');
    const response = await signer.fetch(endpoint + object.key, {
      method: 'PUT',
      body: createReadStream(object.path),
      duplex: 'half',
      headers: {
        'Content-Length': String(object.bytes),
        'Content-Type': object.contentType,
        'Cache-Control': 'public, max-age=31536000, immutable',
        'If-None-Match': '*',
        'x-amz-content-sha256': object.sha256,
        'x-amz-meta-sha256': object.sha256,
      },
      signal: AbortSignal.timeout(300000),
    });
    // Another attempt may have completed the exact immutable file. Public verification decides.
    if (!response.ok && response.status !== 412) throw new Error('RELEASE_UPLOAD_FAILED');
  },
  verifyPublic: async (object) => {
    const response = await fetch(object.url, { signal: AbortSignal.timeout(300000) });
    if ((await publicHash(response, object.bytes)) !== object.sha256)
      throw new Error('RELEASE_PUBLIC_HASH');
  },
  putManifest: async (selected, manifest) => {
    const key =
      selected === 'test' ? 'updates/windows-x86_64-test.json' : 'updates/windows-x86_64.json';
    const text = JSON.stringify(manifest, null, 2) + '\n';
    const response = await signer.fetch(endpoint + key, {
      method: 'PUT',
      body: text,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error('RELEASE_MANIFEST_FAILED');
    const published = await fetch('https://downloads.aimansour.com/' + key, {
      signal: AbortSignal.timeout(30000),
    });
    if (!published.ok || (await published.text()) !== text)
      throw new Error('RELEASE_MANIFEST_PUBLIC_CHECK');
    console.log('Activated verified ' + selected + ' update channel ' + release.version + '.');
  },
});
