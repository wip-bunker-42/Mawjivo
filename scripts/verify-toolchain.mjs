import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
const dependencies = JSON.parse(
  await readFile(new URL('../tools/dependencies.json', import.meta.url), 'utf8'),
);
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const failures = [];
if (process.versions.node !== dependencies.node) failures.push('Node');
if (
  pkg.packageManager !== 'pnpm@' + dependencies.pnpm ||
  !process.env.npm_config_user_agent?.startsWith('pnpm/' + dependencies.pnpm + ' ')
)
  failures.push('pnpm (run this check through pnpm)');
if (!process.argv.includes('--javascript')) {
  const rust = spawnSync('rustc', ['--version'], { encoding: 'utf8', windowsHide: true });
  if (rust.status !== 0 || !rust.stdout.startsWith('rustc ' + dependencies.rust + ' '))
    failures.push('Rust');
}
if (failures.length) {
  console.error('TOOLCHAIN_MISMATCH: ' + failures.join(', '));
  process.exitCode = 1;
} else
  console.log(
    'Verified pinned ' +
      (process.argv.includes('--javascript') ? 'Node/pnpm' : 'Node/pnpm/Rust') +
      '.',
  );
