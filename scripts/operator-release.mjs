import { readFile, mkdir, mkdtemp, copyFile, stat, realpath, rm } from 'node:fs/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, resolve, dirname } from 'node:path';
import { loadReleaseEnv } from './release-env.mjs';
import { packageManagerInvocation } from './package-manager.mjs';
import { packageWindowsRelease } from './package-windows-release.mjs';
import { verifyReleasePackage } from './verify-release.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
export async function isolateSignedBundle({ bundle, parent, name, afterMs }) {
  if (!/^Mawjivo[A-Za-z0-9 _.-]+_x64-setup\.exe$/.test(name))
    throw new Error('RELEASE_BUNDLE_NAME');
  const source = await realpath(bundle);
  for (const file of [name, name + '.sig']) {
    const path = join(source, file),
      info = await stat(path);
    if (!info.isFile() || dirname(await realpath(path)) !== source || info.mtimeMs < afterMs - 2000)
      throw new Error('RELEASE_BUNDLE_STALE');
  }
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(resolve(parent), '.mawjivo-build-'));
  try {
    for (const file of [name, name + '.sig'])
      await copyFile(join(source, file), join(directory, file));
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return { directory, cleanup: () => rm(directory, { recursive: true, force: true }) };
}
export function redactBuildOutput(text, values) {
  const secrets = new Set(
    Object.values(values).filter((value) => typeof value === 'string' && value.length >= 8),
  );
  for (const name of ['MAWJIVO_SIGNING_PRIVATE_KEY', 'MAWJIVO_TEST_SIGNING_PRIVATE_KEY']) {
    const value = values[name];
    if (typeof value !== 'string') continue;
    const decoded = Buffer.from(value, 'base64').toString('utf8');
    if (decoded.startsWith('untrusted comment:')) {
      secrets.add(decoded);
      for (const line of decoded.split(/\r?\n/)) if (line.length >= 16) secrets.add(line);
    }
  }
  for (const secret of [...secrets].sort((a, b) => b.length - a.length))
    text = text.split(secret).join('[REDACTED]');
  return text;
}
export async function buildSignedRelease(
  { envFile, output, channel, sourceCommit },
  dependencies = {},
) {
  if (
    !envFile ||
    !output ||
    !['test', 'production'].includes(channel) ||
    !/^[a-f0-9]{40}$/.test(sourceCommit ?? '')
  )
    throw new Error('RELEASE_BUILD_INPUT');
  const values = await loadReleaseEnv(envFile);
  const env = {
    ...process.env,
    TAURI_SIGNING_PRIVATE_KEY:
      channel === 'test'
        ? values.MAWJIVO_TEST_SIGNING_PRIVATE_KEY
        : values.MAWJIVO_SIGNING_PRIVATE_KEY,
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: values.TAURI_SIGNING_PRIVATE_KEY_PASSWORD,
  };
  const run = dependencies.run ?? spawnSync;
  const options = {
    cwd: root,
    env,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    timeout: 1800000,
  };
  const check = (executable, args) => {
    const result = run(executable, args, options);
    if (result.status !== 0) {
      const diagnostic = redactBuildOutput(
        String(result.stdout ?? '') +
          '\n' +
          String(result.stderr ?? '') +
          '\n' +
          String(result.error?.code ?? ''),
        values,
      );
      const parent = dirname(resolve(output));
      mkdirSync(parent, { recursive: true });
      writeFileSync(join(parent, 'build-diagnostics.log'), diagnostic);
      throw new Error(
        'RELEASE_BUILD_FAILED: ' +
          (args.find((arg) => ['tauri:build', 'notices', 'sync-version'].includes(arg)) ??
            executable),
      );
    }
    return result;
  };
  const commit = check('git', ['rev-parse', 'HEAD']).stdout.trim();
  if (commit !== sourceCommit) throw new Error('RELEASE_SOURCE_MISMATCH');
  const cli = dependencies.packageManagerPath ?? process.env.npm_execpath;
  const pnpm = (args) => {
    const invocation = packageManagerInvocation(cli, args);
    return check(invocation.executable, invocation.args);
  };
  pnpm(['sync-version', '--check']);
  pnpm(['notices']);
  check('cargo', [
    'build',
    '--manifest-path',
    'apps/desktop/src-tauri/Cargo.toml',
    '--locked',
    '--release',
    '--features',
    'operator-tools',
    '--bin',
    'verify_update',
  ]);
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const started = Date.now();
  const args = ['tauri:build'];
  if (channel === 'test') args.push('--config', join(root, 'tools/acceptance-tauri.json'));
  pnpm(args);
  const isolated = await (dependencies.prepareBundle ?? isolateSignedBundle)({
    bundle: join(root, 'apps/desktop/src-tauri/target/release/bundle/nsis'),
    parent: dirname(resolve(output)),
    name: `${channel === 'test' ? 'Mawjivo Acceptance' : 'Mawjivo'}_${pkg.version}_x64-setup.exe`,
    afterMs: started,
  });
  try {
    const metadata = await (dependencies.packageRelease ?? packageWindowsRelease)({
      bundle: isolated.directory,
      destination: resolve(output),
      version: pkg.version,
      sourceCommit,
      channel,
      notesAr: 'نقل الإعدادات والحسابات إلى جهاز جديد وتحسين إعداد الإصدارات.',
    });
    await (dependencies.verifyPackage ?? verifyReleasePackage)(resolve(output), { channel });
    return metadata;
  } finally {
    await isolated.cleanup();
  }
}
async function cli() {
  const [envFile, output, channel = 'production', explicitCommit] = process.argv.slice(2);
  if (!envFile || !output) throw new Error('حدد ملف أسرار التطوير ومجلد الحزمة الجديدة.');
  const git = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (git.status !== 0) throw new Error('RELEASE_SOURCE_UNAVAILABLE');
  process.stdout.write('Building and verifying signed Windows release.\n');
  const metadata = await buildSignedRelease({
    envFile,
    output,
    channel,
    sourceCommit: explicitCommit ?? git.stdout.trim(),
  });
  process.stdout.write(JSON.stringify(metadata) + '\n');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  cli().catch((error) => {
    process.stderr.write((error instanceof Error ? error.message : 'RELEASE_BUILD_FAILED') + '\n');
    process.exitCode = 1;
  });
}
