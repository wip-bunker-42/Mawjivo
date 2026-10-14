import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseR2 } from './helpers/release-r2.mjs';
import { activateRelease } from '../release-publication.mjs';
import { cleanupReleases } from '../release-retention.mjs';
test('release mutations without a shared lease fail before changing storage', async () => {
  const r2 = releaseR2();
  await assert.rejects(
    r2.store().putIndex({ schemaVersion: 1, records: [] }, null),
    /RELEASE_PUBLICATION_LOCK_REQUIRED/,
  );
  assert.equal(r2.state.objects.has('_mawjivo-release-index.json'), false);
});

test('independent local and CI stores cannot mutate releases concurrently', async () => {
  const r2 = releaseR2(),
    first = r2.store(),
    second = r2.store();
  await first.withMutationLock(async () => {
    await assert.rejects(
      second.withMutationLock(async () => assert.fail('Concurrent mutation')),
      /RELEASE_PUBLICATION_BUSY/,
    );
    await first.putIndex({ schemaVersion: 1, records: [] }, null);
  });
  await second.withMutationLock(async () => {
    const current = await second.readIndex();
    await second.putIndex(current.value, current.etag);
  });
});
test('simultaneous lease creation has only one winner', async () => {
  const r2 = releaseR2();
  let release;
  const hold = new Promise((resolve) => {
    release = resolve;
  });
  let entered = 0;
  const attempts = [r2.store(), r2.store()].map((store) =>
    store.withMutationLock(async () => {
      entered++;
      await hold;
    }),
  );
  await assert.rejects(Promise.race(attempts), /RELEASE_PUBLICATION_BUSY/);
  release();
  const results = await Promise.allSettled(attempts);
  assert.equal(entered, 1);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
});
test('an expired or replaced lease cannot perform a later write or clear its new owner', async () => {
  const r2 = releaseR2(),
    first = r2.store(),
    second = r2.store();
  await first.withMutationLock(async () => {
    r2.state.now += 60 * 60 * 1000;
    await second.withMutationLock(async () => {
      await assert.rejects(
        first.putIndex({ schemaVersion: 1, records: [] }, null),
        /RELEASE_PUBLICATION_LEASE_LOST/,
      );
    });
  });
  assert.equal(r2.state.objects.has('_mawjivo-release-index.json'), false);
});
test('cleanup cannot delete an installer activated in its final deletion interval', async () => {
  const r2 = releaseR2();
  const digest = 'b'.repeat(64),
    sourceCommit = 'a'.repeat(40),
    week = 7 * 86400000;
  const key = (v) => `releases/${v}/Mawjivo_${v}_x64-setup.exe`;
  const manifest = (v) => ({
    version: v,
    sourceCommit,
    sha256: digest,
    platforms: {
      'windows-x86_64': {
        url: 'https://downloads.aimansour.com/' + key(v),
        signature: 'TEST_signature',
      },
    },
  });
  for (const v of ['1.0.2', '1.0.3', '1.0.4', '1.0.5']) {
    r2.put(key(v), 'TEST_installer', 2 * week, digest);
    r2.put(key(v) + '.sig', 'TEST_signature', 2 * week, digest);
  }
  const records = ['1.0.3', '1.0.4'].map((version) => ({
    version,
    sourceCommit,
    activatedAt: new Date(r2.state.now - week).toISOString(),
    objects: [key(version), key(version) + '.sig'].map((key) => ({
      key,
      bytes: r2.state.objects.get(key).body.length,
      sha256: digest,
    })),
  }));
  r2.put('_mawjivo-release-index.json', { schemaVersion: 1, records });
  r2.put('updates/windows-x86_64.json', manifest('1.0.4'));
  r2.put('updates/windows-x86_64-test.json', manifest('1.0.2'));
  const release = {
    version: '1.0.5',
    sourceCommit,
    sha256: digest,
    channel: 'test',
    manifest: manifest('1.0.5'),
    objects: [key('1.0.5'), key('1.0.5') + '.sig'].map((key) => ({
      key,
      bytes: r2.state.objects.get(key).body.length,
      sha256: digest,
      url: 'https://downloads.aimansour.com/' + key,
    })),
  };
  const staged = { release, verifiedObjectKeys: release.objects.map((o) => o.key) };
  let blocked = false;
  r2.state.beforeDelete = async () => {
    r2.state.beforeDelete = null;
    try {
      await activateRelease(staged, null, r2.store());
    } catch (e) {
      assert.match(e.message, /RELEASE_PUBLICATION_BUSY/);
      blocked = true;
    }
  };
  await cleanupReleases(r2.store(), r2.state.now);
  assert.equal(blocked, true);
  assert.equal(
    JSON.parse(r2.state.objects.get('updates/windows-x86_64-test.json').body).version,
    '1.0.2',
  );
  assert.ok(r2.state.objects.has(key('1.0.2')));
  assert.ok(!r2.state.objects.has(key('1.0.5')));
  await assert.rejects(activateRelease(staged, null, r2.store()), /RELEASE_STAGE_EXPIRED/);
});
