import { spawnSync } from 'node:child_process';
const jsOnly = process.argv.includes('--javascript');
function run(command, args) {
  console.log('Verification: ' + command + ' ' + args.join(' '));
  const windowsPnpm = process.platform === 'win32' && command === 'pnpm';
  const result = windowsPnpm
    ? spawnSync('cmd.exe', ['/d', '/s', '/c', 'pnpm.cmd ' + args.join(' ')], {
        stdio: 'inherit',
        windowsHide: true,
      })
    : spawnSync(command, args, { stdio: 'inherit', windowsHide: true });
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    return false;
  }
  return true;
}
const checks = [
  ['node', ['scripts/verify-toolchain.mjs', ...(jsOnly ? ['--javascript'] : [])]],
  ['node', ['scripts/sync-version.mjs', '--check']],
  ['node', ['scripts/check-secrets.mjs']],
  ['pnpm', ['test:scripts']],
  ['pnpm', ['typecheck']],
  ['pnpm', ['test']],
  ['pnpm', ['build']],
  ['pnpm', ['service:artifact']],
];
if (!jsOnly)
  checks.push(
    ['pnpm', ['media:tools']],
    ['cargo', ['fmt', '--manifest-path', 'apps/desktop/src-tauri/Cargo.toml', '--check']],
    [
      'cargo',
      [
        'test',
        '--manifest-path',
        'apps/desktop/src-tauri/Cargo.toml',
        '--locked',
        '--no-fail-fast',
      ],
    ],
    [
      'cargo',
      [
        'clippy',
        '--manifest-path',
        'apps/desktop/src-tauri/Cargo.toml',
        '--locked',
        '--all-targets',
        '--',
        '-D',
        'warnings',
      ],
    ],
  );
for (const [command, args] of checks) if (!run(command, args)) break;
