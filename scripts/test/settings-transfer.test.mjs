import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptSettingsTransfer } from '../accept-settings-transfer.mjs';

const report = (fresh) => ({
  schema: 1,
  verified: true,
  freshVault: fresh,
  freshDatabase: fresh,
  cloudWrites: 0,
  summary: { services: 1, workspaces: 1, connections: 3 },
  identities: [],
  ...(fresh ? { resourcesUnchanged: true, repeatImportStable: true } : {}),
});
test('runs verification then isolated acceptance without transporting credentials through Node', async () => {
  const calls = [];
  const result = await acceptSettingsTransfer(
    'device.secrets.env',
    'fresh-directory',
    async (args) => {
      calls.push(args);
      return { status: 0, stdout: JSON.stringify(report(args[0] === '--accept-transfer')) };
    },
  );
  assert.deepEqual(calls, [
    ['--verify-transfer-file', 'device.secrets.env'],
    ['--accept-transfer', 'fresh-directory', 'device.secrets.env'],
  ]);
  assert.equal(result.restored.summary.connections, 3);
});
test('unavailable verification does not start acceptance', async () => {
  let calls = 0;
  await assert.rejects(
    acceptSettingsTransfer('file', 'fresh', async () => {
      calls++;
      return { status: 1, stdout: '', stderr: 'TEST_internal_secret' };
    }),
    /TRANSFER_VERIFY_FAILED/,
  );
  assert.equal(calls, 1);
});
test('refuses a success-shaped native report containing secret fields', async () => {
  await assert.rejects(
    acceptSettingsTransfer('file', 'fresh', async () => ({
      status: 0,
      stdout: JSON.stringify({ ...report(false), credentials: { apiKey: 'TEST_do_not_report' } }),
    })),
    /TRANSFER_REPORT_INVALID/,
  );
});
test('does not accept a nonempty vault or unproved resource comparison', async () => {
  let count = 0;
  await assert.rejects(
    acceptSettingsTransfer('file', 'fresh', async () => ({
      status: 0,
      stdout: JSON.stringify(report(++count === 1 ? false : false)),
    })),
    /TRANSFER_REPORT_INVALID/,
  );
});
