import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
const files = [
  'package.json',
  'apps/desktop/package.json',
  'apps/service/package.json',
  'packages/core/package.json',
  'apps/desktop/src-tauri/tauri.conf.json',
  'apps/desktop/src-tauri/Cargo.toml',
  'apps/desktop/src-tauri/Cargo.lock',
  'apps/service/wrangler.jsonc',
];
const script = resolve('scripts/sync-version.mjs');
test('version_manifest_matches_all_consumers and synchronization repairs drift', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mawjivo-version-test-'));
  try {
    for (const file of files) {
      await mkdir(dirname(join(dir, file)), { recursive: true });
      await writeFile(join(dir, file), await readFile(file));
    }
    const artifact = join(dir, 'apps/desktop/src-tauri/service-artifact/manifest.json');
    await mkdir(dirname(artifact), { recursive: true });
    await writeFile(artifact, JSON.stringify({ version: '0.1.0' }));
    const config = join(dir, 'apps/desktop/src-tauri/tauri.conf.json');
    const value = JSON.parse(await readFile(config, 'utf8'));
    value.version = '9.8.7';
    await writeFile(config, JSON.stringify(value));
    const broken = spawnSync(process.execPath, [script, '--check', '--root', dir], {
      encoding: 'utf8',
    });
    assert.equal(broken.status, 1);
    assert.match(broken.stdout + broken.stderr, /VERSION_MISMATCH/);
    const synced = spawnSync(process.execPath, [script, '0.2.3', '--root', dir], {
      encoding: 'utf8',
    });
    assert.equal(synced.status, 0, synced.stderr);
    assert.equal(
      spawnSync(process.execPath, [script, '--check', '--root', dir], { encoding: 'utf8' }).status,
      0,
    );
    for (const file of files.filter(
      (p) => p.endsWith('package.json') || p.endsWith('tauri.conf.json'),
    ))
      assert.equal(JSON.parse(await readFile(join(dir, file), 'utf8')).version, '0.2.3');
    assert.equal(JSON.parse(await readFile(artifact, 'utf8')).version, '0.2.3');
    assert.match(
      await readFile(join(dir, 'apps/service/wrangler.jsonc'), 'utf8'),
      /"SERVICE_VERSION":\s*"0.2.3"/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
