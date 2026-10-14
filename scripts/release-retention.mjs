import {
  compareVersions,
  packageIdentity,
  stableVersion,
  validateIndex,
} from './release-records.mjs';
const week = 7 * 86400000;
function unproven() {
  return new Error('RELEASE_RETENTION_UNPROVEN');
}
export function manifestPackage(manifest) {
  try {
    stableVersion(manifest?.version);
    const entry = manifest.platforms?.['windows-x86_64'];
    if (
      !entry ||
      typeof entry.signature !== 'string' ||
      !entry.signature ||
      entry.signature.length > 4096 ||
      !/^[a-f0-9]{40}$/.test(manifest.sourceCommit ?? '') ||
      !/^[a-f0-9]{64}$/.test(manifest.sha256 ?? '')
    )
      throw unproven();
    const url = new URL(entry.url);
    if (
      url.origin !== 'https://downloads.aimansour.com' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw unproven();
    const key = decodeURIComponent(url.pathname.slice(1)),
      identity = packageIdentity(key);
    if (
      !identity ||
      key.endsWith('.sig') ||
      identity.version !== manifest.version ||
      entry.url !== `https://downloads.aimansour.com/${key}`
    )
      throw unproven();
    return { key, identity };
  } catch {
    throw unproven();
  }
}
export function planReleaseCleanup({ objects, records, productionManifest, testManifest, nowMs }) {
  const index = validateIndex({ schemaVersion: 1, records });
  const production = manifestPackage(productionManifest),
    testing = manifestPackage(testManifest);
  if (!Number.isSafeInteger(nowMs) || !Array.isArray(objects)) throw unproven();
  const current = index.records.find((record) => record.version === productionManifest.version);
  if (
    index.records.some((record) => compareVersions(record.version, productionManifest.version) > 0)
  )
    throw unproven();
  if (
    !current ||
    current.sourceCommit !== productionManifest.sourceCommit ||
    !current.objects.some(
      (object) => object.key === production.key && object.sha256 === productionManifest.sha256,
    )
  )
    throw unproven();
  const keys = new Set(),
    groups = new Map();
  let total = 0;
  for (const object of objects) {
    if (
      typeof object.key !== 'string' ||
      keys.has(object.key) ||
      !Number.isSafeInteger(object.bytes) ||
      object.bytes < 0 ||
      typeof object.lastModified !== 'string' ||
      !Number.isFinite(Date.parse(object.lastModified))
    )
      throw unproven();
    keys.add(object.key);
    total += object.bytes;
    const identity = packageIdentity(object.key);
    if (identity) {
      const group = groups.get(identity.base) ?? [];
      group.push(object);
      groups.set(identity.base, group);
    }
  }
  if (!Number.isSafeInteger(total)) throw unproven();
  for (const selected of [production, testing])
    if (!keys.has(selected.key) || !keys.has(selected.key + '.sig')) throw unproven();
  const protectedKeys = new Set(keys);
  const protectedGroups = new Set([production.identity.base, testing.identity.base]);
  for (const record of [...index.records]
    .sort((a, b) => compareVersions(b.version, a.version))
    .slice(0, 2)) {
    for (const object of record.objects) protectedGroups.add(packageIdentity(object.key).base);
  }
  const deleteKeys = [];
  let candidateBytes = 0;
  for (const [base, group] of groups) {
    if (
      protectedGroups.has(base) ||
      Math.max(...group.map((object) => Date.parse(object.lastModified))) > nowMs - week
    )
      continue;
    for (const object of group) {
      deleteKeys.push(object.key);
      protectedKeys.delete(object.key);
      candidateBytes += object.bytes;
    }
  }
  return {
    deleteKeys: deleteKeys.sort(),
    protectedKeys: [...protectedKeys].sort(),
    candidateBytes,
  };
}
export async function cleanupReleases(store, nowMs = Date.now()) {
  return store.withMutationLock(() => cleanupLocked(store, nowMs));
}
async function cleanupLocked(store, nowMs) {
  await store.verifyOwnership();
  const [objects, production, test, index] = await Promise.all([
    store.listObjects(''),
    store.readManifest('production'),
    store.readManifest('test'),
    store.readIndex(),
  ]);
  const validated = validateIndex(index.value);
  const plan = planReleaseCleanup({
    objects,
    records: validated.records,
    productionManifest: production.value,
    testManifest: test.value,
    nowMs,
  });
  // Re-read channel etags immediately before deletion, then leave changed channels alone.
  const [latestProduction, latestTest] = await Promise.all([
    store.readManifest('production'),
    store.readManifest('test'),
  ]);
  if (latestProduction.etag !== production.etag || latestTest.etag !== test.etag)
    throw new Error('RELEASE_PUBLICATION_CONFLICT');
  const result = plan.deleteKeys.length
    ? await store.deleteObjects(plan.deleteKeys)
    : { deletedKeys: [], errors: [] };
  const deleted = new Set(result.deletedKeys);
  if (
    result.deletedKeys.some((key) => !plan.deleteKeys.includes(key)) ||
    deleted.size !== result.deletedKeys.length
  )
    throw new Error('RELEASE_DELETE_RESPONSE');
  const errors = [...result.errors];
  const next = {
    schemaVersion: 1,
    records: validated.records
      .map((record) => ({
        ...record,
        objects: record.objects.filter((object) => !deleted.has(object.key)),
      }))
      .filter((record) => record.objects.length),
  };
  if (deleted.size) {
    try {
      await store.putIndex(next, index.etag);
    } catch {
      errors.push({ key: '_mawjivo-release-index.json', code: 'RELEASE_INDEX_UPDATE_FAILED' });
    }
  }
  let remainingBytes = null;
  try {
    const remaining = await store.listObjects('');
    const total = remaining.reduce((sum, object) => sum + object.bytes, 0);
    if (!Number.isSafeInteger(total)) throw new Error('RELEASE_QUOTA_UNAVAILABLE');
    remainingBytes = total;
  } catch {
    errors.push({ key: '', code: 'RELEASE_QUOTA_UNAVAILABLE' });
  }
  return {
    deletedKeys: result.deletedKeys,
    remainingBytes,
    errors,
  };
}
