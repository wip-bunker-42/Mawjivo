import { readFile, readdir, lstat, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { packageManagerInvocation } from './package-manager.mjs';
const sections = [await readFile('THIRD_PARTY_NOTICES.md', 'utf8')];
async function appendLicense(directory, label) {
  const files = (await readdir(directory)).filter((name) =>
    /^(?:licen[sc]e|copying|notice|copyright)(?:[._-]|$)/i.test(name),
  );
  for (const name of files) {
    const path = join(directory, name);
    if ((await lstat(path)).isFile())
      sections.push(label + ' / ' + name + '\n' + (await readFile(path, 'utf8')));
  }
  if (!files.length) throw new Error('Missing notices: ' + label);
}
const invocation = packageManagerInvocation(process.env.npm_execpath, [
  'list',
  '--prod',
  '--depth',
  'Infinity',
  '--json',
  '--recursive',
]);
const listed = spawnSync(invocation.executable, invocation.args, {
  encoding: 'utf8',
  windowsHide: true,
});
if (listed.status !== 0) throw new Error('Runtime JavaScript inventory failed.');
const seen = new Set();
async function visit(item) {
  if (item.path && !seen.has(item.path)) {
    seen.add(item.path);
    const pkg = JSON.parse(await readFile(join(item.path, 'package.json'), 'utf8'));
    if (pkg.name !== 'mawjivo' && !pkg.name.startsWith('@mawjivo/'))
      await appendLicense(item.path, pkg.name + ' ' + pkg.version);
  }
  for (const child of Object.values(item.dependencies ?? {})) await visit(child);
  for (const child of Object.values(item.optionalDependencies ?? {})) await visit(child);
}
for (const item of JSON.parse(listed.stdout)) await visit(item);
if (process.argv.includes('--javascript')) {
  console.log('JavaScript runtime notices verified (' + sections.length + ' license sections).');
  process.exit(0);
}
const tree = spawnSync(
  'cargo',
  [
    'tree',
    '--manifest-path',
    'apps/desktop/src-tauri/Cargo.toml',
    '--locked',
    '--target',
    'x86_64-pc-windows-msvc',
    '--edges',
    'normal',
    '--prefix',
    'none',
  ],
  { encoding: 'utf8', windowsHide: true },
);
if (tree.status !== 0)
  throw new Error('Native dependency inventory failed. Run cargo fetch --locked before packaging.');
const registry = join(process.env.CARGO_HOME ?? join(homedir(), '.cargo'), 'registry', 'src');
const indexes = await readdir(registry),
  crates = new Set(
    tree.stdout
      .split('\n')
      .map((line) => /^([a-zA-Z0-9_-]+) v([^ ]+)/.exec(line))
      .filter(Boolean)
      .map((m) => m[1] + '-' + m[2]),
  );
for (const crate of crates) {
  if (crate.startsWith('mawjivo-')) continue;
  let path;
  for (const index of indexes) {
    const candidate = join(registry, index, crate);
    try {
      if ((await lstat(candidate)).isDirectory()) {
        path = candidate;
        break;
      }
    } catch {}
  }
  if (!path) throw new Error('Missing locked crate source: ' + crate);
  await appendLicense(path, crate);
}
const destination = resolve('.tools/legal');
await mkdir(destination, { recursive: true });
await writeFile(
  join(destination, 'THIRD_PARTY_NOTICES.txt'),
  sections.join('\n\n' + '='.repeat(72) + '\n\n') + '\n',
);
console.log('Generated dependency notices (' + sections.length + ' license sections).');
