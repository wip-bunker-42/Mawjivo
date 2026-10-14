import { publishDownloads } from './downloads-publication.mjs';
import { dirname } from 'node:path';
import { verifyReleasePackage } from './verify-release.mjs';
import {
  compareVersions,
  recordRelease,
  stableVersion,
  validateIndex,
} from './release-records.mjs';
import { cleanupReleases } from './release-retention.mjs';

async function verifySignature(release, store) {
  if (store.verifySignature) return store.verifySignature(release);
  if (!release.objects?.[0]?.path) throw new Error('RELEASE_SIGNATURE_INVALID');
  const verified = await verifyReleasePackage(dirname(release.objects[0].path), {
    channel: release.channel,
  });
  if (
    verified.version !== release.version ||
    verified.sourceCommit !== release.sourceCommit ||
    verified.sha256 !== release.sha256 ||
    JSON.stringify(verified.objects) !== JSON.stringify(release.objects)
  )
    throw new Error('RELEASE_SIGNATURE_INVALID');
}
export async function stageRelease(release, store) {
  stableVersion(release.version);
  await verifySignature(release, store);
  await store.verifyOwnership();
  const objects = await store.listObjects('');
  const stored = objects.reduce((sum, object) => sum + object.bytes, 0),
    missing = [];
  for (const object of release.objects) {
    const existing = await store.inspect(object);
    if (
      existing &&
      (existing.sha256 !== object.sha256 ||
        (existing.bytes !== undefined && existing.bytes !== object.bytes))
    )
      throw new Error('RELEASE_IMMUTABLE_CONFLICT');
    if (!existing) missing.push(object);
  }
  if (
    !Number.isSafeInteger(stored) ||
    stored + missing.reduce((sum, object) => sum + object.bytes, 0) > 1_000_000_000
  )
    throw new Error('RELEASE_STORAGE_LIMIT');
  for (const object of missing) await store.upload(object);
  for (const object of release.objects) await store.verifyPublic(object);
  return { release, verifiedObjectKeys: release.objects.map((object) => object.key) };
}
function acceptanceMatches(release, proof) {
  return (
    proof &&
    proof.packageVersion === release.version &&
    proof.sourceCommit === release.sourceCommit &&
    proof.packageSha256 === release.sha256 &&
    /^[a-f0-9]{64}$/.test(proof.installedBinarySha256 ?? '') &&
    proof.installedBinarySha256 === proof.referenceBinarySha256 &&
    [
      'cleanInstall',
      'signedUpdateVerified',
      'profilePreserved',
      'draftPreserved',
      'vaultPreserved',
    ].every((key) => proof[key] === true)
  );
}
export async function activateRelease(staged, proof, store) {
  const { release, verifiedObjectKeys } = staged;
  stableVersion(release.version);
  if (!['production', 'test'].includes(release.channel)) throw new Error('RELEASE_CHANNEL');
  if (
    release.objects.some((object) => !verifiedObjectKeys.includes(object.key)) ||
    verifiedObjectKeys.length !== release.objects.length
  )
    throw new Error('RELEASE_STAGE_REQUIRED');
  if (release.channel === 'production' && !acceptanceMatches(release, proof))
    throw new Error('RELEASE_ACCEPTANCE_REQUIRED');
  const current = await store.readManifest(release.channel);
  if (current.value) {
    const compared = compareVersions(release.version, current.value.version);
    if (compared < 0) throw new Error('RELEASE_VERSION_OLDER');
    if (
      compared === 0 &&
      release.channel === 'production' &&
      (current.value.sourceCommit !== release.sourceCommit ||
        current.value.sha256 !== release.sha256)
    )
      throw new Error('RELEASE_VERSION_CONFLICT');
  }
  const index = await store.readIndex();
  const records = validateIndex(index.value ?? { schemaVersion: 1, records: [] });
  let next = records;
  if (release.channel === 'production') next = recordRelease(records, release, Date.now());
  if (JSON.stringify(current.value) !== JSON.stringify(release.manifest))
    await store.putManifest(release.channel, release.manifest, current.etag);
  if (release.channel === 'production') await store.putIndex(next, index.etag);
  let cleanup;
  try {
    cleanup = await cleanupReleases(store);
  } catch {
    cleanup = {
      deletedKeys: [],
      remainingBytes: null,
      errors: [{ key: '', code: 'RELEASE_CLEANUP_DEFERRED' }],
    };
  }
  return {
    version: release.version,
    sourceCommit: release.sourceCommit,
    channel: release.channel,
    cleanup,
  };
}

export async function publishRelease(release, control) {
  if (release.channel !== 'test' && release.channel !== 'production')
    throw new Error('RELEASE_CHANNEL');
  if (release.channel === 'production') {
    const proof = release.acceptanceProof;
    if (
      !proof ||
      proof.sourceCommit !== release.sourceCommit ||
      !proof.cleanInstall ||
      !proof.signedUpdateVerified ||
      !proof.profilePreserved ||
      !proof.draftPreserved ||
      !proof.vaultPreserved
    ) {
      throw new Error('RELEASE_ACCEPTANCE_REQUIRED');
    }
  }
  await control.verifySignature(release);
  await publishDownloads(release.objects, {
    inspect: async (object) => {
      const existing = await control.inspect(object);
      if (existing?.sha256 === object.sha256) await control.verifyPublic(object);
      return existing;
    },
    upload: async (object) => {
      await control.upload(object);
      await control.verifyPublic(object);
    },
  });
  await control.putManifest(release.channel, release.manifest);
}
