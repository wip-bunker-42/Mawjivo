import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root = fileURLToPath(new URL('..', import.meta.url));
const values = {};
for (const line of (await readFile(process.argv[2], 'utf8')).split(/\r?\n/)) {
  const match = /^(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line.trim());
  if (match) values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
}
if (!values.CLOUDFLARE_API_TOKEN || !values.CLOUDFLARE_ACCOUNT_ID)
  throw new Error('Missing Cloudflare settings.');
const name = 'mawjivo-desktop-acceptance',
  owner = 'mawjivo-desktop-acceptance:v1';
async function api(path, optional = false) {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${values.CLOUDFLARE_ACCOUNT_ID}${path}`,
    {
      headers: { Authorization: 'Bearer ' + values.CLOUDFLARE_API_TOKEN },
      redirect: 'error',
      signal: AbortSignal.timeout(20000),
    },
  );
  if (optional && response.status === 404) return null;
  if (!response.ok) throw new Error('Fixture preflight failed: ' + response.status);
  const result = await response.json();
  if (!result.success) throw new Error('Fixture preflight unsuccessful.');
  return result.result;
}
const existing = await api(`/workers/scripts/${name}/settings`, true);
if (existing && !existing.tags?.includes(owner)) throw new Error('RESOURCE_NOT_OWNED');
const subdomain = (await api('/workers/subdomain')).subdomain;
if (!subdomain) throw new Error('WORKERS_SUBDOMAIN_MISSING');
const directory = join(root, '.mawjivo-operator');
await mkdir(directory, { recursive: true });
const configPath = join(directory, 'desktop-acceptance-wrangler.jsonc');
await writeFile(
  configPath,
  JSON.stringify(
    {
      name,
      account_id: values.CLOUDFLARE_ACCOUNT_ID,
      main: join(root, 'scripts/desktop-acceptance-worker.mjs'),
      compatibility_date: '2026-10-11',
      workers_dev: true,
      preview_urls: false,
      unsafe: { metadata: { tags: [owner] } },
    },
    null,
    2,
  ),
);
const result = spawnSync(
  process.execPath,
  [
    join(root, 'apps/service/node_modules/wrangler/bin/wrangler.js'),
    'deploy',
    '--config',
    configPath,
  ],
  {
    cwd: root,
    stdio: 'pipe',
    env: {
      ...process.env,
      CI: 'true',
      CLOUDFLARE_API_TOKEN: values.CLOUDFLARE_API_TOKEN,
      CLOUDFLARE_ACCOUNT_ID: values.CLOUDFLARE_ACCOUNT_ID,
    },
  },
);
if (result.status !== 0) throw new Error('Fixture deploy failed; existing resources preserved.');
if (!(await api(`/workers/scripts/${name}/settings`)).tags?.includes(owner))
  throw new Error('Fixture ownership missing.');
const url = `https://${name}.${subdomain}.workers.dev`;
const response = await fetch(url + '/api/workspaces', { signal: AbortSignal.timeout(20000) });
const publicBody = await response.text();
if (!response.ok || JSON.parse(publicBody)[0].id !== 'acceptance-space')
  throw new Error(
    'Fixture public verification failed: ' + response.status + ' ' + publicBody.slice(0, 300),
  );
const variable = spawnSync(
  'gh.exe',
  ['variable', 'set', 'MAWJIVO_ACCEPTANCE_FIXTURE_URL', '--body', url],
  { cwd: root, stdio: 'pipe' },
);
if (variable.status !== 0) throw new Error('Fixture CI variable not stored.');
console.log('Verified owned read-only desktop acceptance fixture and public CI URL.');
