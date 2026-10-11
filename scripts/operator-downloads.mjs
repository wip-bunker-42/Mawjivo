import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { ensureDownloads, downloadsOwner } from './downloads-setup.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const credentialsPath = process.argv[2];
if (!credentialsPath) throw new Error('Provide the ignored private environment file path.');
const values = {};
for (const line of (await readFile(credentialsPath, 'utf8')).split(/\r?\n/)) {
  const match = /^(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line.trim());
  if (match) values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
}
for (const key of ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'])
  if (!values[key]) throw new Error('Missing private setting: ' + key);
const directory = join(root, '.mawjivo-operator');
await mkdir(directory, { recursive: true });
const bucket = 'mawjivo-releases',
  name = 'mawjivo-downloads';
const configPath = join(directory, 'downloads-wrangler.jsonc');
const config = {
  name,
  account_id: values.CLOUDFLARE_ACCOUNT_ID,
  main: join(root, 'scripts/download-worker.mjs'),
  compatibility_date: '2026-10-11',
  workers_dev: false,
  preview_urls: false,
  r2_buckets: [{ binding: 'RELEASES', bucket_name: bucket }],
  routes: [{ pattern: 'downloads.aimansour.com', custom_domain: true }],
  unsafe: { metadata: { tags: [downloadsOwner] } },
  observability: { enabled: true, head_sampling_rate: 0.01 },
};
await writeFile(configPath, JSON.stringify(config, null, 2) + '\n');
async function api(path, optional = false) {
  const response = await fetch('https://api.cloudflare.com/client/v4' + path, {
    headers: { Authorization: 'Bearer ' + values.CLOUDFLARE_API_TOKEN },
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
  });
  if (optional && response.status === 404) return null;
  if (!response.ok) throw new Error('Cloudflare inspection failed (' + response.status + ').');
  const data = await response.json();
  if (!data.success) throw new Error('Cloudflare inspection did not succeed.');
  return data.result;
}
function wrangler(args, optional = false) {
  const result = spawnSync(
    process.execPath,
    [
      join(root, 'apps/service/node_modules/wrangler/bin/wrangler.js'),
      ...args,
      '--config',
      configPath,
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
  if (result.status !== 0 && !optional)
    throw new Error('Wrangler operation failed. Resources have been preserved.');
  return result.status === 0;
}
const account = '/accounts/' + values.CLOUDFLARE_ACCOUNT_ID;
await ensureDownloads({
  inspect: async () => {
    const [buckets, worker, zones, domains] = await Promise.all([
      api(account + '/r2/buckets'),
      api(account + '/workers/scripts/' + name + '/settings', true),
      api('/zones?name=aimansour.com'),
      api(account + '/workers/domains'),
    ]);
    const zone = zones.find((item) => item.name === 'aimansour.com' && item.status === 'active');
    if (!zone) throw new Error('The downloads domain has no active Cloudflare zone.');
    const domain = domains.find((item) => item.hostname === 'downloads.aimansour.com');
    const records = await api('/zones/' + zone.id + '/dns_records?name=downloads.aimansour.com');
    return {
      bucketExists: buckets.buckets.some((item) => item.name === bucket),
      workerExists: worker !== null,
      workerTags: worker?.tags,
      domainService: domain?.service,
      foreignDns: records.length > 0 && domain?.service !== name,
    };
  },
  readMarker: async () => {
    const path = join(directory, 'downloads-owner-read.json');
    if (
      !wrangler(
        ['r2', 'object', 'get', bucket + '/_mawjivo-owner.json', '--remote', '--file', path],
        true,
      )
    )
      return null;
    return JSON.parse(await readFile(path, 'utf8')).owner;
  },
  createBucket: async () => {
    wrangler(['r2', 'bucket', 'create', bucket, '--update-config=false']);
    console.log('Created the dedicated release store.');
  },
  writeMarker: async (owner) => {
    const path = join(directory, 'downloads-owner.json');
    await writeFile(path, JSON.stringify({ owner }) + '\n');
    wrangler([
      'r2',
      'object',
      'put',
      bucket + '/_mawjivo-owner.json',
      '--remote',
      '--file',
      path,
      '--content-type',
      'application/json',
    ]);
  },
  deploy: async () => {
    wrangler(['deploy']);
    const settings = await api(account + '/workers/scripts/' + name + '/settings');
    if (!settings.tags?.includes(downloadsOwner))
      throw new Error('Downloads ownership tag not retained.');
    const domains = await api(account + '/workers/domains');
    if (
      !domains.some((item) => item.hostname === 'downloads.aimansour.com' && item.service === name)
    )
      throw new Error('Downloads domain not bound to the owned Worker.');
    console.log('Verified https://downloads.aimansour.com and its owned release store.');
  },
});
