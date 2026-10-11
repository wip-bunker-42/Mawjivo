import { readFile, readdir, lstat, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
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
const store = 'node_modules/.pnpm';
for (const entry of await readdir(store)) {
  const modules = join(store, entry, 'node_modules');
  let names;
  try {
    names = await readdir(modules);
  } catch {
    continue;
  }
  for (const name of names) {
    const path = join(modules, name);
    if ((await lstat(path)).isSymbolicLink()) continue;
    const paths = name.startsWith('@') ? (await readdir(path)).map((n) => join(path, n)) : [path];
    for (const item of paths) {
      if ((await lstat(item)).isSymbolicLink()) continue;
      let pkg;
      try {
        pkg = JSON.parse(await readFile(join(item, 'package.json'), 'utf8'));
      } catch {
        continue;
      }
      await appendLicense(item, pkg.name + ' ' + pkg.version);
    }
  }
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
