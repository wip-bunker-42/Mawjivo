import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
const jsonFiles = [
  'package.json',
  'apps/desktop/package.json',
  'apps/service/package.json',
  'packages/core/package.json',
  'apps/desktop/src-tauri/tauri.conf.json',
];
const optionalArtifact = 'apps/desktop/src-tauri/service-artifact/manifest.json';
const replacements = {
  'apps/desktop/src-tauri/Cargo.toml': /((?:^|\n)version\s*=\s*")([^"\r\n]+)(")/,
  'apps/desktop/src-tauri/Cargo.lock':
    /(\[\[package\]\]\s*name = "mawjivo"\s*version = ")([^"\r\n]+)(")/,
  'apps/service/wrangler.jsonc': /("SERVICE_VERSION"\s*:\s*")([^"\r\n]+)(")/,
};
async function consumers(root) {
  const output = [];
  for (const file of jsonFiles) {
    const text = await readFile(join(root, file), 'utf8'),
      value = JSON.parse(text);
    output.push({
      file,
      text,
      version: value.version,
      rewrite: (v) => JSON.stringify({ ...value, version: v }, null, 2) + '\n',
    });
  }
  for (const [file, pattern] of Object.entries(replacements)) {
    const text = await readFile(join(root, file), 'utf8'),
      match = pattern.exec(text);
    if (!match) throw new Error('Missing version consumer');
    output.push({
      file,
      text,
      version: match[2],
      rewrite: (v) => text.replace(pattern, (_m, a, _old, c) => a + v + c),
    });
  }
  try {
    const text = await readFile(join(root, optionalArtifact), 'utf8'),
      value = JSON.parse(text);
    output.push({
      file: optionalArtifact,
      text,
      version: value.version,
      rewrite: (v) => JSON.stringify({ ...value, version: v }) + '\n',
    });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return output;
}
async function main() {
  const args = process.argv.slice(2).filter((a) => a !== '--'),
    rootAt = args.indexOf('--root');
  const root =
    rootAt < 0
      ? resolve(dirname(fileURLToPath(import.meta.url)), '..')
      : resolve(args[rootAt + 1] ?? '');
  if (rootAt >= 0) args.splice(rootAt, 2);
  const values = await consumers(root);
  if (args[0] === '--check') {
    if (values.some((v) => v.version !== values[0].version)) {
      console.error('VERSION_MISMATCH: synchronize the application and service before building.');
      process.exitCode = 1;
      return;
    }
    console.log(`Versions agree: ${values[0].version}.`);
    return;
  }
  const version = args[0];
  if (
    args.length !== 1 ||
    !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?$/.test(version ?? '')
  )
    throw new Error('Invalid version');
  const prepared = [];
  const changed = [];
  try {
    for (const value of values) {
      const temporary = join(root, value.file + '.' + randomUUID() + '.tmp');
      await writeFile(temporary, value.rewrite(version));
      prepared.push({ value, temporary });
    }
    for (const { value, temporary } of prepared) {
      await rename(temporary, join(root, value.file));
      changed.push(value);
    }
  } catch (error) {
    for (const value of changed) await writeFile(join(root, value.file), value.text);
    throw error;
  } finally {
    for (const { temporary } of prepared) await rm(temporary, { force: true });
  }
  console.log(
    `Synchronized ${values.length} consumers to ${version}. Rebuild the bundled service before releasing.`,
  );
}
main().catch(() => {
  console.error('VERSION_SYNC_FAILED: use a valid version and a complete writable workspace.');
  process.exitCode = 1;
});
