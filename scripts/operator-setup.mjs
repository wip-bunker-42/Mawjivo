import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
export async function operatorSetup(values, executeNative) {
  for (const name of [
    'CLOUDFLARE_ACCOUNT_ID',
    'CLOUDFLARE_API_TOKEN',
    'R2_ACCESS_KEY_ID',
    'R2_SECRET_ACCESS_KEY',
  ])
    if (typeof values[name] !== 'string' || !values[name]) throw new Error('Missing ' + name);
  const input = {
    accountId: values.CLOUDFLARE_ACCOUNT_ID,
    apiToken: values.CLOUDFLARE_API_TOKEN,
    r2AccessKeyId: values.R2_ACCESS_KEY_ID,
    r2SecretAccessKey: values.R2_SECRET_ACCESS_KEY,
    zoneId: values.CLOUDFLARE_ZONE_ID ?? null,
    domain: values.MAWJIVO_SERVICE_DOMAIN ?? null,
  };
  // Native provisioning already deploys the complete bundled Worker, Workflow,
  // Cron, secrets and migrations. A second Wrangler upload would replace them.
  const result = await executeNative({ args: [], input: JSON.stringify(input) });
  if (result.status !== 0) throw new Error('NATIVE_SETUP_FAILED');
  let state;
  try {
    state = JSON.parse(result.stdout);
  } catch {
    throw new Error('NATIVE_SETUP_RESPONSE');
  }
  if (
    typeof state.profile?.id !== 'string' ||
    !/^https:\/\/[^\s/?#]+$/.test(state.profile.baseUrl) ||
    !state.database_id ||
    state.bucket_created !== true
  )
    throw new Error('NATIVE_SETUP_RESPONSE');
  return state;
}
async function cli() {
  const credentialFile = process.argv[2];
  if (!credentialFile) throw new Error('حدد مسار ملف الكريدينشلز الخاص.');
  const values = {};
  for (const line of (await readFile(credentialFile, 'utf8')).split(/\r?\n/)) {
    const match = /^(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line.trim());
    if (match) values[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
  }
  const state = await operatorSetup(values, (invocation) =>
    spawnSync(
      resolve(process.env.MAWJIVO_OPERATOR_EXE ?? 'apps/desktop/src-tauri/target/debug/setup.exe'),
      invocation.args,
      {
        input: invocation.input,
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 65536,
        timeout: 600000,
      },
    ),
  );
  await mkdir('.mawjivo-operator', { recursive: true });
  await writeFile('.mawjivo-operator/owner-provision-state.json', JSON.stringify(state, null, 2));
  console.log('Service ready: ' + state.profile.baseUrl);
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  await cli().catch((error) => {
    console.error(
      error.message === 'NATIVE_SETUP_FAILED'
        ? 'تعذر التجهيز؛ أعد الفحص من واجهة التطبيق لاستكمال الخطوات المحفوظة.'
        : error.message,
    );
    process.exitCode = 1;
  });
