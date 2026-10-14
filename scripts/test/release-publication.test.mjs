import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publishRelease, stageRelease, activateRelease } from '../release-publication.mjs';
const release = {
  version: '0.1.1',
  channel: 'test',
  objects: [
    { name: 'Mawjivo.exe', sha256: 'installer' },
    { name: 'Mawjivo.exe.sig', sha256: 'signature' },
  ],
  manifest: { version: '0.1.1' },
};

function candidate(version = '1.0.2') {
  const name = `Mawjivo_${version}_x64-setup.exe`,
    key = `releases/${version}/${name}`;
  return {
    version,
    channel: 'production',
    sourceCommit: 'a'.repeat(40),
    sha256: 'b'.repeat(64),
    objects: [
      {
        name,
        key,
        bytes: 100,
        sha256: 'b'.repeat(64),
        url: 'https://downloads.aimansour.com/' + key,
      },
      {
        name: name + '.sig',
        key: key + '.sig',
        bytes: 20,
        sha256: 'c'.repeat(64),
        url: 'https://downloads.aimansour.com/' + key + '.sig',
      },
    ],
    manifest: {
      version,
      sourceCommit: 'a'.repeat(40),
      sha256: 'b'.repeat(64),
      platforms: {
        'windows-x86_64': {
          url: 'https://downloads.aimansour.com/' + key,
          signature: 'TEST_public_signature',
        },
      },
    },
  };
}
function proof(release) {
  return {
    packageVersion: release.version,
    sourceCommit: release.sourceCommit,
    packageSha256: release.sha256,
    installedBinarySha256: 'd'.repeat(64),
    referenceBinarySha256: 'd'.repeat(64),
    cleanInstall: true,
    signedUpdateVerified: true,
    profilePreserved: true,
    draftPreserved: true,
    vaultPreserved: true,
  };
}
function control(initial = null) {
  let active = initial,
    index = { schemaVersion: 1, records: [] };
  const calls = [];
  return {
    calls,
    verifyOwnership: async () => {},
    verifySignature: async () => calls.push('signature'),
    listObjects: async () => [],
    inspect: async () => null,
    upload: async (object) => calls.push('upload:' + object.key),
    verifyPublic: async (object) => calls.push('verify:' + object.key),
    verifyManifest: async () => calls.push('verify-manifest'),
    readManifest: async () => ({ value: active, etag: active ? '"active"' : null }),
    putManifest: async (channel, value, etag) => {
      calls.push('manifest');
      assert.equal(etag, active ? '"active"' : null);
      active = value;
    },
    readIndex: async () => ({ value: index, etag: '"index"' }),
    putIndex: async (value, etag) => {
      assert.equal(etag, '"index"');
      index = value;
      calls.push('index');
    },
    deleteObjects: async () => ({ deletedKeys: [], errors: [] }),
  };
}
test('staging verifies the candidate without activating a channel or deleting files', async () => {
  const release = candidate(),
    store = control();
  const staged = await stageRelease(release, store);
  assert.deepEqual(
    staged.verifiedObjectKeys,
    release.objects.map((object) => object.key),
  );
  assert.ok(!store.calls.includes('manifest'));
});
test('quota is checked for all missing bytes before any upload and without pre-deletion', async () => {
  const store = control();
  store.listObjects = async () => [{ key: 'media-tools/sources.zip', bytes: 999999900 }];
  await assert.rejects(stageRelease(candidate(), store), /RELEASE_STORAGE_LIMIT/);
  assert.ok(!store.calls.some((call) => call.startsWith('upload:')));
});
test('activation rejects old versions and mismatched binary/package proof without touching the channel', async () => {
  const release = candidate(),
    store = control(candidate('2.0.0').manifest);
  const staged = { release, verifiedObjectKeys: release.objects.map((object) => object.key) };
  await assert.rejects(activateRelease(staged, proof(release), store), /RELEASE_VERSION_OLDER/);
  for (const bad of [
    { ...proof(release), packageSha256: 'f'.repeat(64) },
    { ...proof(release), referenceBinarySha256: 'e'.repeat(64) },
  ]) {
    await assert.rejects(activateRelease(staged, bad, control()), /RELEASE_ACCEPTANCE_REQUIRED/);
  }
  assert.ok(!store.calls.includes('manifest'));
});
test('a concurrent manifest CAS change prevents index updates and cleanup', async () => {
  const release = candidate(),
    store = control();
  store.putManifest = async () => {
    throw new Error('RELEASE_PUBLICATION_CONFLICT');
  };
  await assert.rejects(
    activateRelease(
      { release, verifiedObjectKeys: release.objects.map((object) => object.key) },
      proof(release),
      store,
    ),
    /RELEASE_PUBLICATION_CONFLICT/,
  );
  assert.ok(!store.calls.includes('index'));
});
test('an unchanged manifest must still be anonymously verified before index updates or cleanup', async () => {
  const release = candidate(),
    store = control(release.manifest);
  store.verifyManifest = async () => {
    throw new Error('RELEASE_MANIFEST_PUBLIC_CHECK');
  };
  await assert.rejects(
    activateRelease(
      { release, verifiedObjectKeys: release.objects.map((object) => object.key) },
      proof(release),
      store,
    ),
    /RELEASE_MANIFEST_PUBLIC_CHECK/,
  );
  assert.ok(!store.calls.includes('index'));
});

test('cleanup failures after activation report their error and keep the accepted channel active', async () => {
  const release = candidate(),
    store = control();
  const result = await activateRelease(
    { release, verifiedObjectKeys: release.objects.map((object) => object.key) },
    proof(release),
    store,
  );
  assert.equal(result.version, release.version);
  assert.equal(store.calls.filter((call) => call === 'manifest').length, 1);
  assert.equal(store.calls.filter((call) => call === 'index').length, 1);
  assert.ok(result.cleanup.errors.some((error) => error.code === 'RELEASE_CLEANUP_DEFERRED'));
});
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
