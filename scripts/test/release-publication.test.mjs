import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publishRelease } from '../release-publication.mjs';
const release = {
  version: '0.1.1',
  channel: 'test',
  objects: [
    { name: 'Mawjivo.exe', sha256: 'installer' },
    { name: 'Mawjivo.exe.sig', sha256: 'signature' },
  ],
  manifest: { version: '0.1.1' },
};
test('matching stored metadata still requires public byte verification before activation', async () => {
  let writes = 0;
  await assert.rejects(
    publishRelease(release, {
      verifySignature: async () => {},
      inspect: async (object) => ({ sha256: object.sha256 }),
      upload: async () => writes++,
      verifyPublic: async () => {
        throw new Error('RELEASE_PUBLIC_HASH');
      },
      putManifest: async () => writes++,
    }),
    /RELEASE_PUBLIC_HASH/,
  );
  assert.equal(writes, 0);
});
test('an invalid signed installer never changes public files or update channels', async () => {
  const calls = [];
  await assert.rejects(
    publishRelease(release, {
      verifySignature: async () => {
        throw new Error('UPDATE_SIGNATURE_INVALID');
      },
      inspect: async () => null,
      upload: async () => calls.push('upload'),
      verifyPublic: async () => {},
      putManifest: async () => calls.push('manifest'),
    }),
    /UPDATE_SIGNATURE_INVALID/,
  );
  assert.deepEqual(calls, []);
});
test('the channel changes only after every versioned file passes anonymous public verification', async () => {
  const calls = [];
  await publishRelease(release, {
    verifySignature: async () => calls.push('signature'),
    inspect: async () => null,
    upload: async (o) => calls.push('upload:' + o.name),
    verifyPublic: async (o) => calls.push('verify:' + o.name),
    putManifest: async () => calls.push('manifest'),
  });
  assert.deepEqual(calls, [
    'signature',
    'upload:Mawjivo.exe',
    'verify:Mawjivo.exe',
    'upload:Mawjivo.exe.sig',
    'verify:Mawjivo.exe.sig',
    'manifest',
  ]);
});
test('a failed public byte check preserves the previous update channel', async () => {
  let manifests = 0;
  await assert.rejects(
    publishRelease(release, {
      verifySignature: async () => {},
      inspect: async () => null,
      upload: async () => {},
      verifyPublic: async () => {
        throw new Error('DOWNLOAD_HASH');
      },
      putManifest: async () => manifests++,
    }),
    /DOWNLOAD_HASH/,
  );
  assert.equal(manifests, 0);
});
test('an initial production publication requires successful installation and preservation proof from the same source commit', async () => {
  let writes = 0;
  await assert.rejects(
    publishRelease(
      { ...release, channel: 'production', sourceCommit: 'source' },
      {
        verifySignature: async () => {},
        inspect: async () => null,
        upload: async () => writes++,
        verifyPublic: async () => {},
        putManifest: async () => writes++,
      },
    ),
    /RELEASE_ACCEPTANCE_REQUIRED/,
  );
  assert.equal(writes, 0);
});
