import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadReleaseEnv } from '../release-env.mjs';
import {
  buildSignedRelease,
  isolateSignedBundle,
  redactBuildOutput,
} from '../operator-release.mjs';

const keys = {
  MAWJIVO_SIGNING_PRIVATE_KEY: 'TEST_production_signing_value',
  MAWJIVO_TEST_SIGNING_PRIVATE_KEY: 'TEST_testing_signing_value',
  MAWJIVO_RELEASE_ACCOUNT_ID: 'a'.repeat(32),
  MAWJIVO_RELEASE_ACCESS_KEY_ID: 'TEST_release_access',
  MAWJIVO_RELEASE_SECRET_KEY: 'TEST_release_secret',
};
async function withFile(values, run) {
  const directory = await mkdtemp(join(tmpdir(), 'mawjivo-release-env-'));
  const file = join(directory, 'secrets.env');
  try {
    await writeFile(
      file,
      Object.entries(values)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n'),
    );
    await run(file);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
test('loads the existing plaintext release fields and keeps other account secrets outside the result', async () => {
  await withFile(
    {
      ...keys,
      TAURI_SIGNING_PRIVATE_KEY: keys.MAWJIVO_SIGNING_PRIVATE_KEY,
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: '',
      BUFFER_API_KEY: 'TEST_private_buffer',
    },
    async (file) => {
      const loaded = await loadReleaseEnv(file);
      assert.equal(loaded.MAWJIVO_SIGNING_PRIVATE_KEY, keys.MAWJIVO_SIGNING_PRIVATE_KEY);
      assert.equal(loaded.MAWJIVO_TEST_SIGNING_PRIVATE_KEY, keys.MAWJIVO_TEST_SIGNING_PRIVATE_KEY);
      assert.equal(loaded.BUFFER_API_KEY, undefined);
      assert.equal(loaded.TAURI_SIGNING_PRIVATE_KEY_PASSWORD, '');
    },
  );
});
test('accepts the Tauri production alias when the Mawjivo key is missing', async () => {
  const { MAWJIVO_SIGNING_PRIVATE_KEY, ...rest } = keys;
  await withFile(
    { ...rest, TAURI_SIGNING_PRIVATE_KEY: MAWJIVO_SIGNING_PRIVATE_KEY },
    async (file) =>
      assert.equal(
        (await loadReleaseEnv(file)).MAWJIVO_SIGNING_PRIVATE_KEY,
        MAWJIVO_SIGNING_PRIVATE_KEY,
      ),
  );
});
test('rejects conflicting signing aliases without exposing either value', async () => {
  await withFile(
    { ...keys, TAURI_SIGNING_PRIVATE_KEY: 'TEST_conflicting_signing_value' },
    async (file) => {
      await assert.rejects(
        loadReleaseEnv(file),
        (error) =>
          error.message === 'RELEASE_SIGNING_KEY_CONFLICT' &&
          !error.message.includes(keys.MAWJIVO_SIGNING_PRIVATE_KEY),
      );
    },
  );
});
test('reports a missing field name without exposing the other credentials', async () => {
  const { MAWJIVO_RELEASE_SECRET_KEY, ...rest } = keys;
  await withFile(
    rest,
    async (file) =>
      await assert.rejects(
        loadReleaseEnv(file),
        (error) =>
          error.message === 'RELEASE_ENV_MISSING: MAWJIVO_RELEASE_SECRET_KEY' &&
          !error.message.includes(rest.MAWJIVO_SIGNING_PRIVATE_KEY),
      ),
  );
});
test('rejects duplicate env fields and preserves quoted equals signs without evaluating values', async () => {
  await withFile(keys, async (file) => {
    await writeFile(file, 'MAWJIVO_SIGNING_PRIVATE_KEY=first\nMAWJIVO_SIGNING_PRIVATE_KEY=second');
    await assert.rejects(loadReleaseEnv(file), /RELEASE_ENV_DUPLICATE/);
  });
  await withFile({ ...keys, MAWJIVO_SIGNING_PRIVATE_KEY: '"TEST_base64_key=="' }, async (file) =>
    assert.equal((await loadReleaseEnv(file)).MAWJIVO_SIGNING_PRIVATE_KEY, 'TEST_base64_key=='),
  );
});

test('the build passes signing material through child env only and verifies the package without DPAPI', async () => {
  await withFile(keys, async (envFile) => {
    const calls = [];
    let packaged = null,
      verified = null;
    const metadata = { version: 'test-version' };
    const result = await buildSignedRelease(
      { envFile, output: 'unused-output', channel: 'production', sourceCommit: 'c'.repeat(40) },
      {
        packageManagerPath: '/tools/pnpm.cjs',
        prepareBundle: async () => ({
          directory: '/synthetic/current-bundle',
          cleanup: async () => {},
        }),
        run: (executable, args, options) => {
          calls.push({ executable, args, options });
          return { status: 0, stdout: args[0] === 'rev-parse' ? 'c'.repeat(40) : '' };
        },
        packageRelease: async (options) => {
          packaged = options;
          return metadata;
        },
        verifyPackage: async (directory, options) => {
          verified = { directory, options };
          return {};
        },
      },
    );
    assert.deepEqual(result, metadata);
    const build = calls.find((call) => call.args.includes('tauri:build'));
    assert.equal(build.options.env.TAURI_SIGNING_PRIVATE_KEY, keys.MAWJIVO_SIGNING_PRIVATE_KEY);
    assert.equal(build.options.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD, '');
    assert.ok(
      calls.every((call) => !call.args.join(' ').includes(keys.MAWJIVO_SIGNING_PRIVATE_KEY)),
    );
    assert.ok(calls.every((call) => !call.executable.toLowerCase().includes('powershell')));
    assert.equal(packaged.sourceCommit, 'c'.repeat(40));
    assert.equal(verified.options.channel, 'production');
  });
});

test('a shared output with older installers isolates only the new installer and its signature', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mawjivo-shared-bundle-'));
  try {
    const name = 'Mawjivo_0.1.0_x64-setup.exe';
    for (const file of [name, name + '.sig', 'Mawjivo Acceptance_0.1.1_x64-setup.exe'])
      await writeFile(join(directory, file), 'synthetic bytes');
    const isolated = await isolateSignedBundle({
      bundle: directory,
      parent: directory,
      name,
      afterMs: Date.now() - 10000,
    });
    const { readdir } = await import('node:fs/promises');
    assert.deepEqual((await readdir(isolated.directory)).sort(), [name, name + '.sig'].sort());
    await isolated.cleanup();
    assert.ok((await readdir(directory)).includes('Mawjivo Acceptance_0.1.1_x64-setup.exe'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test('a stale same-version installer or signature cannot be relabeled as the current source', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mawjivo-stale-bundle-'));
  try {
    const name = 'Mawjivo_0.1.0_x64-setup.exe';
    for (const file of [name, name + '.sig']) await writeFile(join(directory, file), 'old bytes');
    await assert.rejects(
      isolateSignedBundle({
        bundle: directory,
        parent: directory,
        name,
        afterMs: Date.now() + 10000,
      }),
      /RELEASE_BUNDLE_STALE/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('build diagnostics retain useful errors but remove signing material including its decoded lines', () => {
  const decoded = 'untrusted comment: synthetic key\nTEST_private_key_payload_not_real\n';
  const encoded = Buffer.from(decoded).toString('base64');
  const result = redactBuildOutput(
    'compiler error: missing resource\n' + encoded + '\n' + decoded,
    { ...keys, MAWJIVO_SIGNING_PRIVATE_KEY: encoded },
  );
  assert.ok(result.includes('compiler error: missing resource'));
  assert.ok(!result.includes(encoded));
  assert.ok(!result.includes('TEST_private_key_payload_not_real'));
});
