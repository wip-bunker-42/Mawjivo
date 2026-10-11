import { readFile, readdir, lstat, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { packageManagerInvocation } from './package-manager.mjs';
import { repositoryNotices } from './repository-notices.mjs';
const sections = [await readFile('THIRD_PARTY_NOTICES.md', 'utf8')];
const overrides = JSON.parse(await readFile('tools/license-overrides.json', 'utf8'));
async function appendLicense(directory, label) {
  const files = (await readdir(directory)).filter((name) =>
    /^(?:licen[sc]e|copying|notice|copyright)(?:[._-]|$)/i.test(name),
  );
  let included = 0;
  for (const name of files) {
    const path = join(directory, name);
    if ((await lstat(path)).isFile()) {
      sections.push(label + ' / ' + name + '\n' + (await readFile(path, 'utf8')));
      included++;
    }
  }
  return included > 0;
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
    if (
      pkg.name !== 'mawjivo' &&
      !pkg.name.startsWith('@mawjivo/') &&
      !(await appendLicense(item.path, pkg.name + ' ' + pkg.version))
    )
      throw new Error('Missing runtime JavaScript notices: ' + pkg.name + ' ' + pkg.version);
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
const missing = [],
  provenance = [];
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
  if (!path) {
    missing.push({ crate, reason: 'Missing locked crate source.' });
    continue;
  }
  if (await appendLicense(path, crate)) continue;
  try {
    const manifest = await readFile(join(path, 'Cargo.toml'), 'utf8');
    const override = overrides[crate];
    if (override) {
      const declared = /\nlicense = "([^"]+)"/.exec(manifest)?.[1];
      const text = await readFile(override.licenseFile, 'utf8');
      if (
        declared !== override.license ||
        createHash('sha256').update(text).digest('hex') !== override.licenseSha256
      )
        throw new Error('Reviewed license text does not match this crate.');
      sections.push(
        crate +
          '\nAuthors: ' +
          override.authors +
          '\nUnmodified source: ' +
          override.sourceUrl +
          '\nSource SHA-256: ' +
          override.sourceSha256 +
          '\nLicense: ' +
          override.licenseUrl +
          '\n' +
          text,
      );
      provenance.push({ crate, ...override });
      continue;
    }
    const repository = /\nrepository = "([^"]+)"/.exec(manifest)?.[1];
    const vcs = JSON.parse(await readFile(join(path, '.cargo_vcs_info.json'), 'utf8'));
    const notices = await repositoryNotices({ repository, vcs });
    for (const notice of notices) {
      sections.push(crate + ' / ' + notice.path + '\nSource: ' + notice.url + '\n' + notice.text);
      provenance.push({ crate, path: notice.path, url: notice.url, sha256: notice.sha256 });
    }
  } catch {
    missing.push({
      crate,
      reason: 'Complete license text unavailable from the pinned crate source.',
    });
  }
}
const destination = resolve('.tools/legal');
await mkdir(destination, { recursive: true });
await writeFile(
  join(destination, 'notice-sources.json'),
  JSON.stringify(provenance, null, 2) + '\n',
);
await writeFile(join(destination, 'missing-notices.json'), JSON.stringify(missing, null, 2) + '\n');
if (missing.length)
  throw new Error('Missing notices: ' + missing.map((item) => item.crate).join(', '));
await writeFile(
  join(destination, 'THIRD_PARTY_NOTICES.txt'),
  sections.join('\n\n' + '='.repeat(72) + '\n\n') + '\n',
);
console.log('Generated dependency notices (' + sections.length + ' license sections).');
