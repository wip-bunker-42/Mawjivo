import { mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

function parseReport(stdout, fresh) {
  let result;
  try {
    result = JSON.parse(stdout);
  } catch {
    throw new Error('TRANSFER_REPORT_INVALID');
  }
  const fields = [
    'schema',
    'verified',
    'freshVault',
    'freshDatabase',
    'cloudWrites',
    'summary',
    'identities',
    'resourcesUnchanged',
    'repeatImportStable',
  ];
  const identityFields = [
    'serviceId',
    'databaseId',
    'worker',
    'mediaBucket',
    'workflow',
    'workspaceIds',
    'connectionIds',
    'postIds',
  ];
  if (
    !result ||
    typeof result !== 'object' ||
    Object.keys(result).some((field) => !fields.includes(field)) ||
    result.schema !== 1 ||
    result.verified !== true ||
    result.cloudWrites !== 0 ||
    result.freshVault !== fresh ||
    result.freshDatabase !== fresh ||
    (fresh && (result.resourcesUnchanged !== true || result.repeatImportStable !== true)) ||
    !result.summary ||
    Object.keys(result.summary).length !== 3 ||
    ['services', 'workspaces', 'connections'].some(
      (field) => !Number.isSafeInteger(result.summary[field]) || result.summary[field] < 0,
    ) ||
    !Array.isArray(result.identities) ||
    result.identities.some(
      (item) =>
        !item ||
        typeof item !== 'object' ||
        Object.keys(item).some((field) => !identityFields.includes(field)),
    )
  ) {
    throw new Error('TRANSFER_REPORT_INVALID');
  }
  return result;
}
export async function acceptSettingsTransfer(credentialFile, freshDirectory, executeNative) {
  const verified = await executeNative(['--verify-transfer-file', credentialFile]);
  if (verified.status !== 0) throw new Error('TRANSFER_VERIFY_FAILED');
  const verification = parseReport(verified.stdout, false);
  const accepted = await executeNative(['--accept-transfer', freshDirectory, credentialFile]);
  if (accepted.status !== 0) throw new Error('TRANSFER_ACCEPTANCE_FAILED');
  const restored = parseReport(accepted.stdout, true);
  return { verification, restored };
}
async function cli() {
  const file = process.argv[2];
  if (!file) throw new Error('حدد مسار ملف إعدادات الجهاز.');
  const evidence = resolve(
    process.argv[3] ?? '.superpowers/sdd/2026-10-13-mawjivo-device-transfer/transfer-proof',
  );
  await mkdir(evidence, { recursive: true });
  const directory = join(evidence, 'fresh-' + randomUUID());
  const binary = resolve(
    process.env.MAWJIVO_OPERATOR_EXE ?? 'apps/desktop/src-tauri/target/debug/setup.exe',
  );
  const result = await acceptSettingsTransfer(resolve(file), directory, async (args) =>
    spawnSync(binary, args, {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
      timeout: 600000,
    }),
  );
  const output = join(
    evidence,
    'settings-transfer-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json',
  );
  await writeFile(output, JSON.stringify(result, null, 2) + '\n');
  process.stdout.write(
    `TRANSFER_ACCEPTANCE_OK: ${result.restored.summary.services} service(s), ${result.restored.summary.workspaces} workspace(s), ${result.restored.summary.connections} connection(s); report: ${output}\n`,
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  cli().catch((error) => {
    process.stderr.write(
      (error instanceof Error ? error.message : 'TRANSFER_ACCEPTANCE_FAILED') + '\n',
    );
    process.exitCode = 1;
  });
}
