import { readFile, writeFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { publishDownloads } from './downloads-publication.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const credentialPath = process.argv[2],
  artifactPath = process.argv[3];
if (!credentialPath || !artifactPath)
  throw new Error('Provide the private environment path and verified artifact directory.');
const values = {};
for (const line of (await readFile(credentialPath, 'utf8')).split(/\r?\n/)) {
  const match = /^(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line.trim());
  if (match) values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
}
for (const key of ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'])
  if (!values[key]) throw new Error('Missing private setting: ' + key);
const artifact = resolve(artifactPath);
const manifest = JSON.parse(await readFile(join(artifact, 'manifest.json'), 'utf8'));
const recipe = JSON.parse(await readFile(join(root, 'tools/media-build.json'), 'utf8'));
if (
  manifest.sourceCommit !== recipe.ffmpegCommit ||
  manifest.version !== recipe.ffmpegVersion ||
  !/^[0-9][A-Za-z0-9.-]{0,100}$/.test(manifest.version)
)
  throw new Error('Artifact does not match the reviewed build recipe.');
const prefix = 'media-tools/' + manifest.version + '/';
const origin = 'https://downloads.aimansour.com/';
manifest.platforms['win32-x64'].url = origin + prefix + 'media-tools-win32-x64.zip';
manifest.sources.url = origin + prefix + 'media-tools-sources.zip';
const publishedManifest = join(artifact, 'published-manifest.json');
await writeFile(publishedManifest, JSON.stringify(manifest, null, 2) + '\n');
async function hash(body) {
  const digest = createHash('sha256');
  for await (const chunk of body) digest.update(chunk);
  return digest.digest('hex');
}
const objects = [
  {
    name: 'media-tools-sources.zip',
    path: join(artifact, 'media-tools-sources.zip'),
    sha256: manifest.sources.sha256,
    contentType: 'application/zip',
  },
  {
    name: 'media-tools-win32-x64.zip',
    path: join(artifact, 'media-tools-win32-x64.zip'),
    sha256: manifest.platforms['win32-x64'].sha256,
    contentType: 'application/zip',
  },
  {
    name: 'manifest.json',
    path: publishedManifest,
    sha256: await hash(createReadStream(publishedManifest)),
    contentType: 'application/json',
  },
];
let bytes = 0;
for (const object of objects) {
  object.key = prefix + object.name;
  object.bytes = (await stat(object.path)).size;
  if (object.name === 'media-tools-sources.zip' && object.bytes !== manifest.sources.bytes)
    throw new Error('Source archive size does not match the reviewed manifest.');
  bytes += object.bytes;
  if ((await hash(createReadStream(object.path))) !== object.sha256)
    throw new Error('Archive does not match the reviewed SHA-256.');
}
if (bytes > 1_000_000_000)
  throw new Error('Media distribution exceeds the reserved release storage budget.');
// The setup checks bucket marker, Worker tag and custom domain before any upload.
const setup = spawnSync(
  process.execPath,
  [join(root, 'scripts/operator-downloads.mjs'), credentialPath],
  { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 },
);
if (setup.status !== 0) throw new Error('Owned downloads infrastructure is not ready.');
await publishDownloads(objects, {
  inspect: async (object) => {
    console.log('Checking versioned download: ' + object.name + '.');
    const response = await fetch(origin + object.key, { signal: AbortSignal.timeout(300_000) });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error('Existing public download could not be verified.');
    return { sha256: await hash(response.body) };
  },
  upload: async (object) => {
    console.log('Uploading verified archive: ' + object.name + ' (' + object.bytes + ' bytes).');
    const result = spawnSync(
      process.execPath,
      [
        join(root, 'apps/service/node_modules/wrangler/bin/wrangler.js'),
        'r2',
        'object',
        'put',
        'mawjivo-releases/' + object.key,
        '--remote',
        '--file',
        object.path,
        '--content-type',
        object.contentType,
        '--cache-control',
        'public, max-age=31536000, immutable',
        '--config',
        join(root, '.mawjivo-operator/downloads-wrangler.jsonc'),
      ],
      {
        cwd: root,
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 256 * 1024,
        env: {
          ...process.env,
          CI: 'true',
          CLOUDFLARE_API_TOKEN: values.CLOUDFLARE_API_TOKEN,
          CLOUDFLARE_ACCOUNT_ID: values.CLOUDFLARE_ACCOUNT_ID,
        },
      },
    );
    if (result.status !== 0)
      throw new Error('Release upload failed. Previously published files have been preserved.');
    const response = await fetch(origin + object.key, { signal: AbortSignal.timeout(300_000) });
    if (!response.ok || (await hash(response.body)) !== object.sha256)
      throw new Error('Public download digest verification failed.');
    console.log('Verified public download: ' + object.name + ' (' + object.bytes + ' bytes).');
  },
});
console.log(
  'Published matching media tools and complete sources: ' + origin + prefix + 'manifest.json',
);
