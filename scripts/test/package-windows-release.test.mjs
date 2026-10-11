import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packageWindowsRelease } from '../package-windows-release.mjs';

test('packaging retains installer and signature bytes under a safe immutable acceptance name', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mawjivo-package-'));
  const bundle = join(root, 'bundle'),
    destination = join(root, 'package');
  try {
    await mkdir(bundle);
    await writeFile(join(bundle, 'Mawjivo Acceptance_0.1.1_x64-setup.exe'), 'MZ exact build bytes');
    await writeFile(join(bundle, 'Mawjivo Acceptance_0.1.1_x64-setup.exe.sig'), 'exact signature');
    const metadata = await packageWindowsRelease({
      bundle,
      destination,
      version: '0.1.1',
      sourceCommit: 'a'.repeat(40),
      channel: 'test',
      notesAr: 'حفظ المسودات.',
    });
    assert.equal(metadata.name, 'Mawjivo-Acceptance_0.1.1_aaaaaaaa_x64-setup.exe');
    assert.equal(await readFile(join(destination, metadata.name), 'utf8'), 'MZ exact build bytes');
    assert.equal(
      await readFile(join(destination, metadata.name + '.sig'), 'utf8'),
      'exact signature',
    );
    assert.equal(metadata.bytes, 20);
    assert.equal(
      JSON.parse(await readFile(join(destination, 'package-info.json'), 'utf8')).sourceCommit,
      'a'.repeat(40),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('packaging refuses multiple ambiguous installer outputs without publishing metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mawjivo-package-'));
  try {
    await writeFile(join(root, 'one.exe'), 'MZ');
    await writeFile(join(root, 'two.exe'), 'MZ');
    await assert.rejects(
      packageWindowsRelease({
        bundle: root,
        destination: join(root, 'output'),
        version: '0.1.1',
        sourceCommit: 'a'.repeat(40),
        channel: 'test',
        notesAr: 'تحديث.',
      }),
      /RELEASE_BUNDLE_AMBIGUOUS/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
