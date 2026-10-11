import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { installMediaArchive, mediaArchiveFiles } from '../media-installation.mjs';
const hash = (value) => createHash('sha256').update(value).digest('hex');
test('all pinned runtime licenses are installed with the tools and a corrupted license leaves the installation untouched', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mawjivo-tool-installer-'));
  const source = join(root, 'archive'),
    destination = join(root, 'installed');
  const manifest = {
    licenseSha256: hash('FFmpeg license'),
    licenseFiles: { 'licenses/decoder-LICENSE': hash('Decoder copyright and full license') },
    platforms: { 'win32-x64': { files: { 'ffmpeg.exe': hash('fixture executable') } } },
  };
  try {
    await mkdir(join(source, 'bin'), { recursive: true });
    await mkdir(join(source, 'licenses'), { recursive: true });
    await mkdir(destination);
    await writeFile(join(destination, 'ffmpeg.exe'), 'previous verified executable');
    await writeFile(join(source, 'bin/ffmpeg.exe'), 'fixture executable');
    await writeFile(join(source, 'LICENSE.txt'), 'FFmpeg license');
    await writeFile(join(source, 'licenses/decoder-LICENSE'), 'corrupted');
    await assert.rejects(
      installMediaArchive(source, destination, manifest, 'win32-x64'),
      /MEDIA_COMPONENT_MISMATCH/,
    );
    assert.equal(
      await readFile(join(destination, 'ffmpeg.exe'), 'utf8'),
      'previous verified executable',
    );
    await writeFile(join(source, 'licenses/decoder-LICENSE'), 'Decoder copyright and full license');
    await installMediaArchive(source, destination, manifest, 'win32-x64');
    assert.equal(
      await readFile(join(destination, 'licenses/decoder-LICENSE'), 'utf8'),
      'Decoder copyright and full license',
    );
    assert.equal(await readFile(join(destination, 'ffmpeg.exe'), 'utf8'), 'fixture executable');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('untrusted archive paths cannot escape the installation directory', () => {
  const manifest = {
    licenseSha256: 'a'.repeat(64),
    licenseFiles: { '../outside/LICENSE': 'b'.repeat(64) },
    platforms: { 'win32-x64': { files: { 'ffmpeg.exe': 'c'.repeat(64) } } },
  };
  assert.throws(() => mediaArchiveFiles(manifest, 'win32-x64'), /MEDIA_MANIFEST_PATH/);
});
