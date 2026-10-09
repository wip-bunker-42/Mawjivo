import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
const root = fileURLToPath(new URL('..', import.meta.url));
const pnpmCli = process.env.npm_execpath;
if (!pnpmCli) throw new Error('Run this script with pnpm service:artifact.');
const executable = pnpmCli.endsWith('.exe') ? pnpmCli : process.execPath;
const args = [
  ...(executable === process.execPath ? [pnpmCli] : []),
  '--filter',
  '@mawjivo/service',
  'build',
];
const result = spawnSync(executable, args, { cwd: root, stdio: 'inherit', windowsHide: true });
if (result.status !== 0) process.exit(result.status ?? 1);
const checksum = (text) => createHash('sha256').update(text).digest('hex');
const version = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;
const moduleSource = await readFile(path.join(root, 'apps/service/dist/index.js'), 'utf8');
const migrations = [];
for (const name of (await readdir(path.join(root, 'apps/service/migrations')))
  .filter((name) => /^\d+_[a-z_]+\.sql$/.test(name))
  .sort()) {
  const source = await readFile(path.join(root, 'apps/service/migrations', name), 'utf8');
  migrations.push({ name, source, sha256: checksum(source) });
}
const manifest = {
  version,
  compatibilityDate: '2026-10-09',
  compatibilityFlags: ['nodejs_compat'],
  mainModule: 'index.js',
  modules: [{ name: 'index.js', source: moduleSource, sha256: checksum(moduleSource) }],
  migrations,
  workflowClass: moduleSource.includes('PublishWorkflow') ? 'PublishWorkflow' : null,
};
const output = path.join(root, 'apps/desktop/src-tauri/service-artifact');
await mkdir(output, { recursive: true });
await writeFile(path.join(output, 'manifest.json'), JSON.stringify(manifest));
console.log(
  'Bundled service ' +
    version +
    ' with ' +
    migrations.length +
    ' migration(s); SHA-256 ' +
    checksum(JSON.stringify(manifest)),
);
