export function stableVersion(version) {
  if (
    typeof version !== 'string' ||
    version.length > 64 ||
    !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(version)
  )
    throw new Error('RELEASE_VERSION_INVALID');
  const parts = version.split('.').map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part))) throw new Error('RELEASE_VERSION_INVALID');
  return parts;
}
export function compareVersions(left, right) {
  const a = stableVersion(left),
    b = stableVersion(right);
  for (let index = 0; index < 3; index++)
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  return 0;
}
export function packageIdentity(key) {
  if (typeof key !== 'string') return null;
  const parts = key.split('/');
  if (parts.length !== 3 || parts[0] !== 'releases') return null;
  const [, version, file] = parts;
  try {
    stableVersion(version);
  } catch {
    return null;
  }
  const name = file.endsWith('.sig') ? file.slice(0, -4) : file;
  if (name === `Mawjivo_${version}_x64-setup.exe`)
    return { version, base: `releases/${version}/${name}`, testing: false };
  const prefix = `Mawjivo-Acceptance_${version}_`;
  if (
    name.startsWith(prefix) &&
    /^[a-f0-9]{8}_[a-f0-9]{8}_x64-setup\.exe$/.test(name.slice(prefix.length))
  )
    return { version, base: `releases/${version}/${name}`, testing: true };
  return null;
}
export function validateIndex(value) {
  if (!value || value.schemaVersion !== 1 || !Array.isArray(value.records))
    throw new Error('RELEASE_INDEX_INVALID');
  const versions = new Set();
  const records = value.records.map((record) => {
    stableVersion(record.version);
    if (
      versions.has(record.version) ||
      !/^[a-f0-9]{40}$/.test(record.sourceCommit ?? '') ||
      typeof record.activatedAt !== 'string' ||
      !Number.isFinite(Date.parse(record.activatedAt)) ||
      !Array.isArray(record.objects) ||
      !record.objects.length
    )
      throw new Error('RELEASE_INDEX_INVALID');
    versions.add(record.version);
    const keys = new Set();
    const objects = record.objects.map((object) => {
      const identity = packageIdentity(object.key);
      if (
        !identity ||
        identity.version !== record.version ||
        keys.has(object.key) ||
        !Number.isSafeInteger(object.bytes) ||
        object.bytes <= 0 ||
        !/^[a-f0-9]{64}$/.test(object.sha256 ?? '')
      )
        throw new Error('RELEASE_INDEX_INVALID');
      keys.add(object.key);
      return { key: object.key, bytes: object.bytes, sha256: object.sha256 };
    });
    return {
      version: record.version,
      sourceCommit: record.sourceCommit,
      activatedAt: record.activatedAt,
      objects,
    };
  });
  return { schemaVersion: 1, records };
}
export function recordRelease(index, release, nowMs) {
  const current = validateIndex(index ?? { schemaVersion: 1, records: [] });
  const existing = current.records.find((record) => record.version === release.version);
  const objects = release.objects.map(({ key, bytes, sha256 }) => ({ key, bytes, sha256 }));
  if (existing) {
    if (
      existing.sourceCommit !== release.sourceCommit ||
      JSON.stringify(existing.objects) !== JSON.stringify(objects)
    )
      throw new Error('RELEASE_VERSION_CONFLICT');
    return current;
  }
  return validateIndex({
    schemaVersion: 1,
    records: [
      ...current.records,
      {
        version: release.version,
        sourceCommit: release.sourceCommit,
        activatedAt: new Date(nowMs).toISOString(),
        objects,
      },
    ],
  });
}
