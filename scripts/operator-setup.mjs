import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('..', import.meta.url));
const credentialFile = process.argv[2];
if (!credentialFile)
  throw new Error(
    'Specify the private credentials file path. Credentials are never accepted as command arguments.',
  );
const values = {};
for (const line of (await readFile(credentialFile, 'utf8')).split(/\r?\n/)) {
  const match = /^(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line.trim());
  if (match) {
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    )
      value = value.slice(1, -1);
    values[match[1]] = value;
  }
}
const required = [
  'CLOUDFLARE_ACCOUNT_ID',
  'CLOUDFLARE_API_TOKEN',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
];
for (const name of required) if (!values[name]) throw new Error('Missing ' + name + '.');
const exe = path.join(root, 'apps/desktop/src-tauri/target/debug/setup.exe');
const input = {
  accountId: values.CLOUDFLARE_ACCOUNT_ID,
  apiToken: values.CLOUDFLARE_API_TOKEN,
  r2AccessKeyId: values.R2_ACCESS_KEY_ID,
  r2SecretAccessKey: values.R2_SECRET_ACCESS_KEY,
  zoneId: values.CLOUDFLARE_ZONE_ID ?? null,
  domain: values.MAWJIVO_SERVICE_DOMAIN ?? null,
};
const prepared = spawnSync(exe, [], {
  input: JSON.stringify(input),
  encoding: 'utf8',
  windowsHide: true,
  maxBuffer: 65_536,
});
if (prepared.status !== 0) {
  process.stderr.write(prepared.stderr ?? 'Native setup failed. Build the setup binary first.');
  process.exit(prepared.status ?? 1);
}
const state = JSON.parse(prepared.stdout);
const name = 'mawjivo-' + state.profile.serviceId;
const config = {
  name,
  account_id: state.profile.accountId,
  main: path.join(root, 'apps/service/src/index.ts'),
  compatibility_date: '2026-10-09',
  compatibility_flags: ['nodejs_compat'],
  observability: { enabled: true, head_sampling_rate: 0.1 },
  d1_databases: [
    {
      binding: 'DB',
      database_name: name + '-db',
      database_id: state.database_id,
      migrations_dir: path.join(root, 'apps/service/migrations'),
    },
  ],
  r2_buckets: [{ binding: 'MEDIA', bucket_name: name + '-media' }],
  vars: {
    SERVICE_ID: state.profile.serviceId,
    SERVICE_VERSION: state.profile.version,
    R2_ACCOUNT_ID: state.profile.accountId,
    MEDIA_BUCKET: name + '-media',
  },
};
if (input.domain) config.routes = [{ pattern: input.domain, custom_domain: true }];
const directory = path.join(root, '.mawjivo-operator');
await mkdir(directory, { recursive: true });
const configPath = path.join(directory, 'wrangler.json');
await writeFile(configPath, JSON.stringify(config, null, 2));
const pnpmCli = process.env.npm_execpath;
if (!pnpmCli) throw new Error('Run with pnpm operator:setup.');
const isNative = pnpmCli.endsWith('.exe');
const deployed = spawnSync(
  isNative ? pnpmCli : process.execPath,
  [
    ...(isNative ? [] : [pnpmCli]),
    '--filter',
    '@mawjivo/service',
    'exec',
    'wrangler',
    'deploy',
    '--config',
    configPath,
  ],
  {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
    env: {
      ...process.env,
      CLOUDFLARE_API_TOKEN: values.CLOUDFLARE_API_TOKEN,
      CLOUDFLARE_ACCOUNT_ID: values.CLOUDFLARE_ACCOUNT_ID,
    },
  },
);
if (deployed.status !== 0) process.exit(deployed.status ?? 1);
const settingsResponse = await fetch(
  'https://api.cloudflare.com/client/v4/accounts/' +
    state.profile.accountId +
    '/workers/scripts/' +
    name +
    '/settings',
  {
    headers: { Authorization: 'Bearer ' + values.CLOUDFLARE_API_TOKEN },
    signal: AbortSignal.timeout(20_000),
  },
);
if (!settingsResponse.ok) throw new Error('Unable to verify deployed service ownership.');
const settings = await settingsResponse.json();
if (
  !settings.success ||
  !settings.result?.tags?.includes('mawjivo-service:' + state.profile.serviceId)
)
  throw new Error('Deployed service ownership tag is missing. Resources have been preserved.');
const health = await fetch(state.profile.baseUrl + '/health', {
  signal: AbortSignal.timeout(20_000),
});
if (!health.ok) throw new Error('Deployed service is not ready. Run setup again to resume.');
console.log('Service ready: ' + state.profile.baseUrl);
