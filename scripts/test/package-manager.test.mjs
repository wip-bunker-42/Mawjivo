import { test } from 'node:test';
import assert from 'node:assert/strict';
import { packageManagerInvocation } from '../package-manager.mjs';
test('the real Linux pnpm native binary is invoked directly instead of parsed as JavaScript', () => {
  const path = '/opt/hostedtoolcache/node/24.21.0/x64/lib/node_modules/pnpm/pnpm';
  const result = packageManagerInvocation(path, ['--filter', '@mawjivo/service', 'build']);
  assert.equal(result.executable, path);
  assert.deepEqual(result.args, ['--filter', '@mawjivo/service', 'build']);
});
test('pnpm JavaScript shims remain compatible', () => {
  const result = packageManagerInvocation('/tools/pnpm.cjs', ['--version']);
  assert.equal(result.executable, process.execPath);
  assert.deepEqual(result.args, ['/tools/pnpm.cjs', '--version']);
});
