import { spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdtemp, realpath, stat, unlink, rmdir } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { verifyReleasePackage, hashFile } from './verify-release.mjs';
import { stableVersion } from './release-records.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));
function gh(args) {
  const result = spawnSync('gh', args, {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 2 * 1048576,
    timeout: 120000,
    cwd: root,
  });
  if (result.status !== 0) {
    if (/HTTP 404/.test(result.stderr ?? '')) return null;
    throw new Error('GITHUB_RELEASE_API_FAILED');
  }
  return JSON.parse(result.stdout);
}
async function bodyRequest(endpoint, method, body) {
  const directory = await mkdtemp(join(tmpdir(), 'mawjivo-gh-body-'));
  const path = join(directory, 'body.json');
  try {
    await writeFile(path, JSON.stringify(body) + '\n');
    return gh([
      'api',
      endpoint,
      '--method',
      method,
      '--input',
      path,
      '-H',
      'X-GitHub-Api-Version: 2026-03-10',
    ]);
  } finally {
    await unlink(path).catch(() => {});
    await rmdir(directory).catch(() => {});
  }
}
export function createGithubReleaseClient(options = {}) {
  const execute = options.run ?? gh;
  const repository = options.repository ?? process.env.GITHUB_REPOSITORY ?? 'aimansour/Mawjivo';
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))
    throw new Error('GITHUB_RELEASE_REPOSITORY');
  const base = `repos/${repository}`;
  return {
    repository: async () => execute(['api', base]),
    getRelease: async (tag) => {
      for (let page = 1; page <= 5; page++) {
        const releases = await execute(['api', `${base}/releases?per_page=100&page=${page}`]);
        if (!Array.isArray(releases)) throw new Error('GITHUB_RELEASE_API_FAILED');
        const found = releases.find((release) => release.tag_name === tag);
        if (found) return found;
        if (releases.length < 100) return null;
      }
      throw new Error('GITHUB_RELEASE_LIST_LIMIT');
    },
    resolveTag: async (tag) => {
      let ref = execute(['api', `${base}/git/ref/tags/${encodeURIComponent(tag)}`]);
      if (!ref) return null;
      let object = ref.object;
      for (let depth = 0; depth < 5; depth++) {
        if (object.type === 'commit' && /^[a-f0-9]{40}$/.test(object.sha)) return object.sha;
        if (object.type !== 'tag' || !/^[a-f0-9]{40}$/.test(object.sha)) break;
        object = execute(['api', `${base}/git/tags/${object.sha}`])?.object;
      }
      throw new Error('GITHUB_RELEASE_SOURCE_CONFLICT');
    },
    createDraft: async (body) => bodyRequest(`${base}/releases`, 'POST', body),
    listAssets: async (id) => {
      const assets = [];
      for (let page = 1; page <= 5; page++) {
        const batch = execute(['api', `${base}/releases/${id}/assets?per_page=100&page=${page}`]);
        if (!Array.isArray(batch)) throw new Error('GITHUB_RELEASE_API_FAILED');
        assets.push(...batch);
        if (batch.length < 100) return assets;
      }
      throw new Error('GITHUB_RELEASE_ASSET_LIMIT');
    },
    uploadAsset: async (id, asset) =>
      execute([
        'api',
        `https://uploads.github.com/${base}/releases/${id}/assets?name=${encodeURIComponent(asset.name)}`,
        '--method',
        'POST',
        '--input',
        asset.path,
        '-H',
        `Content-Type: ${asset.contentType}`,
        '-H',
        'X-GitHub-Api-Version: 2026-03-10',
      ]),
    publishRelease: async (id, body) => bodyRequest(`${base}/releases/${id}`, 'PATCH', body),
  };
}
function proofMatches(release, proof) {
  return (
    proof &&
    proof.sourceCommit === release.sourceCommit &&
    proof.packageVersion === release.version &&
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
function safeProof(proof) {
  const result = {};
  for (const key of [
    'sourceCommit',
    'packageVersion',
    'packageSha256',
    'installedBinarySha256',
    'referenceBinarySha256',
    'cleanInstall',
    'signedUpdateVerified',
    'profilePreserved',
    'draftPreserved',
    'vaultPreserved',
    'publicDownloadVerified',
    'backupCreated',
    'fromVersion',
    'toVersion',
    'productionCandidate',
    'verifiedAt',
  ])
    if (Object.hasOwn(proof, key)) result[key] = proof[key];
  return result;
}
function assetMatches(actual, expected) {
  return (
    actual &&
    actual.state === 'uploaded' &&
    actual.size === expected.bytes &&
    actual.digest === 'sha256:' + expected.sha256 &&
    Number.isSafeInteger(actual.id) &&
    actual.id > 0
  );
}
async function projectVersion(sourceCommit) {
  const head = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15000,
  });
  if (head.status !== 0 || head.stdout.trim() !== sourceCommit)
    throw new Error('GITHUB_RELEASE_INPUT');
  const config = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  return config.version;
}
export async function archiveGithubRelease(input, overrides = {}) {
  const dependencies = {
    client: createGithubReleaseClient(),
    isActions: process.env.GITHUB_ACTIONS === 'true',
    verifyPackage: verifyReleasePackage,
    validateProject: projectVersion,
    ...overrides,
  };
  const { tag, packageDirectory, acceptanceProof, sourceCommit, mode } = input;
  if (!['production', 'acceptance'].includes(mode) || !/^[a-f0-9]{40}$/.test(sourceCommit ?? ''))
    throw new Error('GITHUB_RELEASE_INPUT');
  const release = await dependencies.verifyPackage(packageDirectory, { channel: 'production' });
  stableVersion(release.version);
  const expectedTag =
    mode === 'production'
      ? `v${release.version}`
      : `acceptance-v${release.version}-${sourceCommit.slice(0, 8)}`;
  if (
    tag !== expectedTag ||
    sourceCommit !== release.sourceCommit ||
    (await dependencies.validateProject(sourceCommit)) !== release.version ||
    !proofMatches(release, acceptanceProof)
  )
    throw new Error('GITHUB_RELEASE_INPUT');
  const client = dependencies.client;
  if ((await client.repository())?.private !== true)
    throw new Error('GITHUB_RELEASE_PRIVATE_REQUIRED');
  const tagCommit = await client.resolveTag(tag);
  if (dependencies.isActions && !tagCommit) throw new Error('GITHUB_RELEASE_EXISTING_TAG_REQUIRED');
  if (tagCommit && tagCommit !== sourceCommit) throw new Error('GITHUB_RELEASE_SOURCE_CONFLICT');
  const body = `Mawjivo ${mode === 'acceptance' ? 'قبول تجريبي' : 'إصدار'} ${release.version}\n\n${release.notesAr}\n\n<!-- mawjivo-release:v1 ${Buffer.from(JSON.stringify({ sourceCommit, version: release.version, sha256: release.sha256, mode })).toString('base64')} -->`;
  let archived = await client.getRelease(tag);
  if (
    archived &&
    (archived.tag_name !== tag ||
      (!tagCommit && archived.target_commitish !== sourceCommit) ||
      archived.prerelease !== (mode === 'acceptance') ||
      archived.body !== body)
  )
    throw new Error('GITHUB_RELEASE_SOURCE_CONFLICT');
  const packageRoot = await realpath(packageDirectory);
  const temporary = await mkdtemp(join(tmpdir(), 'mawjivo-gh-proof-')),
    proofPath = join(temporary, 'acceptance-proof.json');
  try {
    await writeFile(proofPath, JSON.stringify(safeProof(acceptanceProof), null, 2) + '\n');
    const assets = [];
    for (const name of [release.name, release.name + '.sig', 'package-info.json']) {
      const path = join(packageRoot, name);
      if (dirname(await realpath(path)) !== packageRoot || !(await stat(path)).isFile())
        throw new Error('GITHUB_RELEASE_INPUT');
      assets.push({
        name,
        path,
        bytes: (await stat(path)).size,
        sha256: await hashFile(path),
        contentType: name.endsWith('.exe')
          ? 'application/vnd.microsoft.portable-executable'
          : name.endsWith('.sig')
            ? 'text/plain; charset=utf-8'
            : 'application/json',
      });
    }
    assets.push({
      name: 'acceptance-proof.json',
      path: proofPath,
      bytes: (await stat(proofPath)).size,
      sha256: await hashFile(proofPath),
      contentType: 'application/json',
    });
    if (!archived)
      archived = await client.createDraft({
        tag_name: tag,
        ...(tagCommit ? {} : { target_commitish: sourceCommit }),
        name: `Mawjivo ${release.version}${mode === 'acceptance' ? ' — اختبار القبول' : ''}`,
        body,
        draft: true,
        prerelease: mode === 'acceptance',
        make_latest: 'false',
      });
    if (!Number.isSafeInteger(archived?.id) || archived.id <= 0)
      throw new Error('GITHUB_RELEASE_API_FAILED');
    const existing = await client.listAssets(archived.id);
    if (
      existing.some((asset) => !assets.some((expected) => expected.name === asset.name)) ||
      new Set(existing.map((asset) => asset.name)).size !== existing.length
    )
      throw new Error('GITHUB_RELEASE_ASSET_CONFLICT');
    const assetIds = [];
    for (const asset of assets) {
      let actual = existing.find((item) => item.name === asset.name);
      if (actual && !assetMatches(actual, asset)) throw new Error('GITHUB_RELEASE_ASSET_CONFLICT');
      if (!actual) actual = await client.uploadAsset(archived.id, asset);
      if (!assetMatches(actual, asset)) throw new Error('GITHUB_RELEASE_ASSET_CONFLICT');
      assetIds.push(actual.id);
    }
    if (archived.draft)
      await client.publishRelease(archived.id, {
        draft: false,
        prerelease: mode === 'acceptance',
        make_latest: mode === 'acceptance' ? 'false' : 'true',
      });
    return { releaseId: archived.id, assetIds };
  } finally {
    await unlink(proofPath).catch(() => {});
    await rmdir(temporary).catch(() => {});
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [tag, packageDirectory, proofPath, sourceCommit, mode] = process.argv.slice(2);
  console.log(
    JSON.stringify(
      await archiveGithubRelease({
        tag,
        packageDirectory,
        acceptanceProof: JSON.parse(await readFile(proofPath, 'utf8')),
        sourceCommit,
        mode,
      }),
    ),
  );
}
