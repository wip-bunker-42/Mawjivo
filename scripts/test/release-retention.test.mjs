import test from 'node:test';
import assert from 'node:assert/strict';
import { planReleaseCleanup, cleanupReleases } from '../release-retention.mjs';
const nowMs = Date.parse('2026-10-13T00:00:00Z'),
  week = 7 * 86400000;
const key = (version, test = false) =>
  `releases/${version}/${test ? `Mawjivo-Acceptance_${version}_12345678_abcdef12` : `Mawjivo_${version}`}_x64-setup.exe`;
const items = (version, age = 10 * 86400000, testing = false) =>
  [key(version, testing), key(version, testing) + '.sig'].map((key, index) => ({
    key,
    bytes: index ? 20 : 100,
    lastModified: new Date(nowMs - age).toISOString(),
  }));
const record = (version) => ({
  version,
  sourceCommit: 'a'.repeat(40),
  activatedAt: new Date(nowMs - 10 * 86400000).toISOString(),
  objects: items(version).map((object) => ({ ...object, sha256: 'b'.repeat(64) })),
});
const manifest = (version, testing = false) => ({
  version,
  sourceCommit: 'a'.repeat(40),
  sha256: 'b'.repeat(64),
  platforms: {
    'windows-x86_64': {
      url: 'https://downloads.aimansour.com/' + key(version, testing),
      signature: 'TEST_public_signature',
    },
  },
});
function fixture() {
  return {
    nowMs,
    records: ['1.0.1', '1.0.2', '1.0.3', '1.0.4'].map(record),
    productionManifest: manifest('1.0.4'),
    testManifest: manifest('1.0.2', true),
    objects: [
      ...['1.0.1', '1.0.2', '1.0.3', '1.0.4'].flatMap((version) => items(version)),
      ...items('1.0.2', 10 * 86400000, true),
      ...items('1.0.5', 2 * 86400000, true),
      { key: 'media-tools/sources.zip', bytes: 1000, lastModified: new Date(0).toISOString() },
      {
        key: 'releases/1.0.1/Mawjivo&amp;.exe',
        bytes: 30,
        lastModified: new Date(0).toISOString(),
      },
      {
        key: 'releases/1.0.1/other/Mawjivo_1.0.1_x64-setup.exe',
        bytes: 30,
        lastModified: new Date(0).toISOString(),
      },
    ],
  };
}
test('protects newest two activated packages, test channel and every young group', () => {
  const input = fixture(),
    plan = planReleaseCleanup(input);
  assert.deepEqual(
    plan.deleteKeys.sort(),
    [...items('1.0.1'), ...items('1.0.2')].map((object) => object.key).sort(),
  );
  assert.ok(plan.protectedKeys.includes(key('1.0.4')));
  assert.ok(plan.protectedKeys.includes(key('1.0.3') + '.sig'));
  assert.ok(plan.protectedKeys.includes(key('1.0.2', true) + '.sig'));
  assert.equal(plan.candidateBytes, 240);
});
test('the newest file determines the grace period for the entire package', () => {
  const input = fixture();
  input.objects.find((object) => object.key === key('1.0.1') + '.sig').lastModified = new Date(
    nowMs - week + 1,
  ).toISOString();
  assert.ok(!planReleaseCleanup(input).deleteKeys.includes(key('1.0.1')));
  input.objects.find((object) => object.key === key('1.0.1') + '.sig').lastModified = new Date(
    nowMs - week,
  ).toISOString();
  assert.ok(planReleaseCleanup(input).deleteKeys.includes(key('1.0.1')));
});
test('unknown files, sources and XML-looking keys cannot become deletion targets', () => {
  const plan = planReleaseCleanup(fixture());
  assert.ok(
    !plan.deleteKeys.some(
      (key) => key.includes('media-tools') || key.includes('&') || key.includes('/other/'),
    ),
  );
});
test('missing or forged channel evidence stops cleanup', () => {
  for (const field of ['productionManifest', 'testManifest']) {
    const input = fixture();
    input[field] = null;
    assert.throws(() => planReleaseCleanup(input), /RELEASE_RETENTION_UNPROVEN/);
  }
  const input = fixture();
  input.productionManifest.platforms['windows-x86_64'].url =
    'https://elsewhere.test/' + key('1.0.4');
  assert.throws(() => planReleaseCleanup(input), /RELEASE_RETENTION_UNPROVEN/);
});

test('an active channel older than an activated record is not trusted for cleanup', () => {
  const input = fixture();
  input.records.push(record('2.0.0'));
  input.objects.push(...items('2.0.0'));
  assert.throws(() => planReleaseCleanup(input), /RELEASE_RETENTION_UNPROVEN/);
});
test('a staged orphan never displaces the newest two activated production records', () => {
  const input = fixture();
  input.objects.push(...items('9.0.0'));
  const plan = planReleaseCleanup(input);
  assert.ok(plan.protectedKeys.includes(key('1.0.3')));
  assert.ok(!plan.protectedKeys.includes(key('9.0.0')));
});
test('partial bulk deletion retains failed files in the index and computes actual remaining bytes', async () => {
  const input = fixture(),
    failed = key('1.0.1') + '.sig';
  let index = { schemaVersion: 1, records: input.records };
  const deleted = [];
  const store = {
    withMutationLock: async (action) => action(),
    verifyOwnership: async () => {},
    listObjects: async () => input.objects.filter((object) => !deleted.includes(object.key)),
    readManifest: async (channel) => ({
      value: channel === 'production' ? input.productionManifest : input.testManifest,
      etag: '"manifest"',
    }),
    readIndex: async () => ({ value: index, etag: '"index"' }),
    deleteObjects: async (keys) => {
      deleted.push(...keys.filter((key) => key !== failed));
      return { deletedKeys: deleted, errors: [{ key: failed, code: 'AccessDenied' }] };
    },
    putIndex: async (value, etag) => {
      assert.equal(etag, '"index"');
      index = value;
    },
  };
  const result = await cleanupReleases(store, nowMs);
  assert.equal(result.deletedKeys.length, 3);
  assert.equal(
    result.remainingBytes,
    input.objects.reduce((sum, object) => sum + object.bytes, 0) - 220,
  );
  assert.deepEqual(
    index.records.find((record) => record.version === '1.0.1').objects.map((object) => object.key),
    [failed],
  );
});
test('index conflict never hides the already confirmed deletions', async () => {
  const input = fixture();
  const store = {
    withMutationLock: async (action) => action(),
    verifyOwnership: async () => {},
    listObjects: async () => input.objects,
    readManifest: async (channel) => ({
      value: channel === 'production' ? input.productionManifest : input.testManifest,
      etag: '"manifest"',
    }),
    readIndex: async () => ({
      value: { schemaVersion: 1, records: input.records },
      etag: '"index"',
    }),
    deleteObjects: async (keys) => ({ deletedKeys: keys, errors: [] }),
    putIndex: async () => {
      throw new Error('RELEASE_PUBLICATION_CONFLICT');
    },
  };
  const result = await cleanupReleases(store, nowMs);
  assert.equal(result.deletedKeys.length, 4);
  assert.ok(result.errors.some((error) => error.code === 'RELEASE_INDEX_UPDATE_FAILED'));
});

test('remaining bytes include the updated index size from the actual post-cleanup inventory', async () => {
  const input = fixture();
  let objects = [
    ...input.objects,
    {
      key: '_mawjivo-release-index.json',
      bytes: 5000,
      lastModified: new Date(nowMs).toISOString(),
    },
  ];
  const store = {
    withMutationLock: async (action) => action(),
    verifyOwnership: async () => {},
    listObjects: async () => objects,
    readManifest: async (channel) => ({
      value: channel === 'production' ? input.productionManifest : input.testManifest,
      etag: '"manifest"',
    }),
    readIndex: async () => ({
      value: { schemaVersion: 1, records: input.records },
      etag: '"index"',
    }),
    deleteObjects: async (keys) => {
      objects = objects.filter((object) => !keys.includes(object.key));
      return { deletedKeys: keys, errors: [] };
    },
    putIndex: async (value) => {
      objects = objects.map((object) =>
        object.key === '_mawjivo-release-index.json'
          ? { ...object, bytes: Buffer.byteLength(JSON.stringify(value, null, 2) + '\n') }
          : object,
      );
    },
  };
  const result = await cleanupReleases(store, nowMs);
  assert.equal(
    result.remainingBytes,
    objects.reduce((sum, object) => sum + object.bytes, 0),
  );
});
