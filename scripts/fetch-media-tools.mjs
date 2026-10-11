import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, writeFile, access, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { mediaArchiveFiles, installMediaArchive } from './media-installation.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(join(root, 'tools/media-tools.json'), 'utf8'));
const target = `${process.platform}-${process.arch}`;
const config = manifest.platforms[target];
if (!config)
  throw new Error(`No verified media tools for ${target}; Windows x64 is the release target.`);
const destination = join(root, 'apps/desktop/src-tauri/media-tools');
async function hash(path) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest('hex');
}
async function valid() {
  try {
    for (const file of mediaArchiveFiles(manifest, target)) {
      if ((await hash(join(destination, file.destination))) !== file.sha256) return false;
    }
    await access(join(destination, 'SOURCE.json'));
    return true;
  } catch {
    return false;
  }
}
if (await valid()) {
  await writeFile(join(destination, 'SOURCE.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`Verified FFmpeg ${manifest.version} (${target}).`);
  process.exit(0);
}
const scratch = await mkdtemp(join(tmpdir(), 'mawjivo-media-tools-'));
try {
  const response = await fetch(config.mirrorUrl ?? config.url, {
    signal: AbortSignal.timeout(300_000),
  });
  if (!response.ok) throw new Error(`Media tools download failed (${response.status}).`);
  const archive = join(scratch, 'media-tools.zip');
  await writeFile(archive, Buffer.from(await response.arrayBuffer()));
  if ((await hash(archive)) !== config.sha256)
    throw new Error('Media tools archive SHA-256 mismatch.');
  const unpack = join(scratch, 'unpack');
  // Constant PowerShell code, paths supplied as environment variables; no shell interpolation.
  const result = spawnSync(
    'pwsh.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Expand-Archive -LiteralPath $env:MAWJIVO_TOOL_ARCHIVE -DestinationPath $env:MAWJIVO_TOOL_UNPACK -ErrorAction Stop',
    ],
    {
      env: { ...process.env, MAWJIVO_TOOL_ARCHIVE: archive, MAWJIVO_TOOL_UNPACK: unpack },
      windowsHide: true,
      stdio: 'inherit',
    },
  );
  if (result.status !== 0) throw new Error('Media tools extraction failed.');
  const extracted = join(unpack, config.archiveRoot);
  await installMediaArchive(extracted, destination, manifest, target);
  await writeFile(join(destination, 'SOURCE.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`Installed verified FFmpeg ${manifest.version} (${manifest.license}).`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
