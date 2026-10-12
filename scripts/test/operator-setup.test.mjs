import test from 'node:test';
import assert from 'node:assert/strict';
import { operatorSetup } from '../operator-setup.mjs';
const values = {
  CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
  CLOUDFLARE_API_TOKEN: 'private-token',
  R2_ACCESS_KEY_ID: 'private-access',
  R2_SECRET_ACCESS_KEY: 'private-secret',
};
test('operator setup delegates once to native complete provisioning without a second deployment', async () => {
  const calls = [];
  const state = {
    profile: { id: 'owner-profile', baseUrl: 'https://service.test' },
    database_id: 'database',
    bucket_created: true,
  };
  const result = await operatorSetup(values, (invocation) => {
    calls.push(invocation);
    return { status: 0, stdout: JSON.stringify(state) };
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, []);
  assert.equal(JSON.parse(calls[0].input).apiToken, 'private-token');
  assert.equal(calls[0].args.join(' ').includes('private'), false);
  assert.equal(result.profile.baseUrl, 'https://service.test');
});
test('incomplete credentials and a failed native provision do not report a ready service', async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      operatorSetup({ ...values, R2_SECRET_ACCESS_KEY: '' }, () => {
        calls++;
      }),
    /R2_SECRET_ACCESS_KEY/,
  );
  assert.equal(calls, 0);
  await assert.rejects(
    () => operatorSetup(values, () => ({ status: 1, stderr: 'private-token' })),
    /NATIVE_SETUP_FAILED/,
  );
});
