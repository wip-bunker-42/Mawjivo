import { readFile } from 'node:fs/promises';
import { verifyReleasePackage } from './verify-release.mjs';
import { stageRelease, activateRelease } from './release-publication.mjs';
import { createReleaseStore } from './release-store.mjs';
import { cleanupReleases, planReleaseCleanup } from './release-retention.mjs';

const [directory, channel, proofPath] = process.argv.slice(2);
const store = createReleaseStore(process.env);
if (directory === '--plan-cleanup') {
  const [objects, production, test, index] = await Promise.all([
    store.listObjects(''),
    store.readManifest('production'),
    store.readManifest('test'),
    store.readIndex(),
  ]);
  let plan;
  try {
    plan = {
      canClean: true,
      ...planReleaseCleanup({
        objects,
        records: index.value?.records,
        productionManifest: production.value,
        testManifest: test.value,
        nowMs: Date.now(),
      }),
    };
  } catch {
    plan = {
      canClean: false,
      deleteKeys: [],
      protectedKeys: objects.map((object) => object.key),
      reason: 'RELEASE_RETENTION_UNPROVEN',
    };
  }
  console.log(
    JSON.stringify(
      { ...plan, storedBytes: objects.reduce((sum, object) => sum + object.bytes, 0) },
      null,
      2,
    ),
  );
} else if (directory === '--cleanup') {
  console.log(JSON.stringify(await cleanupReleases(store), null, 2));
} else {
  if (!directory || !channel) throw new Error('Provide verified package directory and channel.');
  const release = await verifyReleasePackage(directory, { channel });
  const proof = proofPath ? JSON.parse(await readFile(proofPath, 'utf8')) : null;
  const staged = await stageRelease(release, store);
  console.log(JSON.stringify(await activateRelease(staged, proof, store)));
}
