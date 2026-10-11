import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { verifyReleasePackage } from '../verify-release.mjs';
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'mawjivo-release-'));
  const bytes = Buffer.from('MZ synthetic installer');
  const name = 'Mawjivo-Acceptance_0.1.1_x64-setup.exe';
  const metadata = {
    version: '0.1.1',
    sourceCommit: '1'.repeat(40),
    notesAr: 'تحسين حفظ البيانات.',
    name,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  await writeFile(join(directory, name), bytes);
  await writeFile(join(directory, name + '.sig'), 'synthetic-release-signature');
  await writeFile(join(directory, 'package-info.json'), JSON.stringify(metadata));
  return { directory, metadata };
}
test('release metadata cannot publish an installer whose actual bytes do not match', async () => {
  const { directory, metadata } = await fixture();
  let signatures = 0;
  try {
    metadata.sha256 = '0'.repeat(64);
    await writeFile(join(directory, 'package-info.json'), JSON.stringify(metadata));
    await assert.rejects(
      verifyReleasePackage(directory, { channel: 'test', verifySigned: async () => signatures++ }),
      /RELEASE_DIGEST_MISMATCH/,
    );
    assert.equal(signatures, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test('release file paths are limited to the verified package directory', async () => {
  const { directory, metadata } = await fixture();
  let signatures = 0;
  try {
    metadata.name = '../outside.exe';
    await writeFile(join(directory, 'package-info.json'), JSON.stringify(metadata));
    await assert.rejects(
      verifyReleasePackage(directory, { channel: 'test', verifySigned: async () => signatures++ }),
      /RELEASE_FILENAME/,
    );
    assert.equal(signatures, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test('a verified package produces a public HTTPS updater manifest without private repository authentication', async () => {
  const { directory, metadata } = await fixture();
  let signatures = 0;
  try {
    const result = await verifyReleasePackage(directory, {
      channel: 'test',
      verifySigned: async (input) => {
        assert.equal(input.version, '0.1.1');
        assert.equal(input.signaturePath, join(directory, metadata.name + '.sig'));
        assert.ok(input.publicKey.length > 40);
        signatures++;
      },
    });
    assert.equal(signatures, 1);
    assert.equal(
      result.manifest.platforms['windows-x86_64'].url,
      'https://downloads.aimansour.com/releases/0.1.1/' + metadata.name,
    );
    assert.equal(result.manifest.bytes, metadata.bytes);
    assert.equal(result.manifest.notes, metadata.notesAr);
    assert.equal(JSON.stringify(result.manifest).includes('github.com'), false);
    assert.equal(JSON.stringify(result.manifest).includes('Authorization'), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
