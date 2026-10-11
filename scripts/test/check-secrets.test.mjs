import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const script = resolve('scripts/check-secrets.mjs');
test('a plain Cloudflare token assignment is detected without a vendor prefix', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mawjivo-secret-test-'));
  try {
    const secret = ['a0b1c2d3e4f5g6h7i8j9', 'k0l1m2n3o4p5q6r7s8t9'].join('');
    const path = join(dir, 'candidate.ts');
    await writeFile(path, 'const apiToken = "' + secret + '";');
    const result = spawnSync(process.execPath, [script, path], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.ok(!(result.stdout + result.stderr).includes(secret));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('a synthetic credential fails without exposing its value', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mawjivo-secret-test-'));
  try {
    const secret = ['ghp', '0AbcDeFgHiJkLmNoPqRsTuVwXyZa01234567'].join('_');
    const path = join(dir, 'candidate.txt');
    await writeFile(path, 'api_token=' + secret);
    const result = spawnSync(process.execPath, [script, path], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stdout + result.stderr, /SECRET_DETECTED/);
    assert.ok(!(result.stdout + result.stderr).includes(secret));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('ordinary prose and an example placeholder are accepted', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mawjivo-secret-test-'));
  try {
    const path = join(dir, 'guide.txt');
    await writeFile(path, 'Mawjivo جاهز.\nAPI_TOKEN=YOUR_TOKEN_HERE\n');
    assert.equal(spawnSync(process.execPath, [script, path], { encoding: 'utf8' }).status, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
