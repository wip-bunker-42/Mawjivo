import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, copyFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';

export function mediaArchiveFiles(manifest, target) {
  const config = manifest.platforms[target];
  if (!config?.files) throw new Error('MEDIA_MANIFEST_TARGET');
  const files = [
    { source: 'LICENSE.txt', destination: 'LICENSE.txt', sha256: manifest.licenseSha256 },
  ];
  for (const [name, sha256] of Object.entries(config.files)) {
    if (!/^[\w.-]+$/.test(name) || name === '.' || name === '..')
      throw new Error('MEDIA_MANIFEST_PATH');
    files.push({ source: 'bin/' + name, destination: name, sha256 });
  }
  for (const [name, sha256] of Object.entries(manifest.licenseFiles ?? {})) {
    if (
      !name.startsWith('licenses/') ||
      !/^[\w./-]+$/.test(name) ||
      name.split('/').some((part) => !part || part === '.' || part === '..')
    )
      throw new Error('MEDIA_MANIFEST_PATH');
    files.push({ source: name, destination: name, sha256 });
  }
  if (files.some((file) => !/^[a-f0-9]{64}$/.test(file.sha256 ?? '')))
    throw new Error('MEDIA_MANIFEST_DIGEST');
  return files;
}
async function hash(path) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest('hex');
}
export async function installMediaArchive(source, destination, manifest, target) {
  const files = mediaArchiveFiles(manifest, target);
  for (const file of files) {
    if ((await hash(join(source, file.source))) !== file.sha256)
      throw new Error('MEDIA_COMPONENT_MISMATCH');
  }
  for (const file of files) {
    const path = join(destination, file.destination);
    await mkdir(dirname(path), { recursive: true });
    await copyFile(join(source, file.source), path);
  }
}
