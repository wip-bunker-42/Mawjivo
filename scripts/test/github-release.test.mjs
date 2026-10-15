import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { archiveGithubRelease, createGithubReleaseClient } from '../github-release.mjs';
const sourceCommit = 'a'.repeat(40),
  version = '0.1.1';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function fixture() {
  const packageDirectory = await mkdtemp(join(tmpdir(), 'mawjivo-gh-archive-'));
  const name = 'Mawjivo_0.1.1_x64-setup.exe',
    bytes = Buffer.from('signed installer');
  const release = {
    name,
    version,
    sourceCommit,
    bytes: bytes.length,
    sha256: sha(bytes),
    notesAr: 'نقل الإعدادات والتحديث.',
  };
  await writeFile(join(packageDirectory, name), bytes);
  await writeFile(join(packageDirectory, name + '.sig'), 'production signature');
  await writeFile(join(packageDirectory, 'package-info.json'), JSON.stringify(release) + '\n');
  await writeFile(join(packageDirectory, 'mawjivo.secrets.env'), 'MUST_NOT_ARCHIVE=secret');
  const acceptanceProof = {
    sourceCommit,
    packageVersion: version,
    packageSha256: release.sha256,
    installedBinarySha256: 'b'.repeat(64),
    referenceBinarySha256: 'b'.repeat(64),
    cleanInstall: true,
    signedUpdateVerified: true,
    profilePreserved: true,
    draftPreserved: true,
    vaultPreserved: true,
    productionCandidate: true,
    verifiedAt: '2026-10-14T00:00:00.000Z',
  };
  const state = { release: null, assets: [], contents: new Map(), creates: 0, uploads: [], published: 0, failAt: null };
  const client = {
    repository: async () => ({ private: true }),
    resolveTag: async () => (state.release ? sourceCommit : null),
    getRelease: async () => state.release,
    createDraft: async (body) => {
      state.creates++;
      state.release = { id: 9, ...body };
      return state.release;
    },
    listAssets: async () => state.assets,
    uploadAsset: async (id, asset) => {
      if (state.failAt === asset.name) throw new Error('NETWORK_FAILED');
      state.contents.set(asset.name, await readFile(asset.path, 'utf8'));
      state.uploads.push(asset.name);
      const uploaded = {
        id: 10 + state.assets.length,
        name: asset.name,
        size: asset.bytes,
        state: 'uploaded',
        digest: 'sha256:' + asset.sha256,
      };
      state.assets.push(uploaded);
      return uploaded;
    },
    publishRelease: async (id, body) => {
      state.published++;
      Object.assign(state.release, body);
      return state.release;
    },
    deleteAsset: async (id) => { state.assets = state.assets.filter((asset) => asset.id !== id); },
  };
  return {
    packageDirectory,
    release,
    acceptanceProof,
    state,
    client,
    input: { tag: 'v0.1.1', packageDirectory, acceptanceProof, sourceCommit, mode: 'production' },
    deps: {
      client,
      isActions: false,
      verifyPackage: async () => release,
      validateProject: async () => version,
    },
    close: () => rm(packageDirectory, { recursive: true, force: true }),
  };
}
test('invalid production tag, project version and foreign proof prevent creating an archive', async () => {
  const f = await fixture();
  try {
    for (const input of [
      { ...f.input, tag: 'v0.1.1-rc.1' },
      { ...f.input, acceptanceProof: { ...f.acceptanceProof, sourceCommit: 'c'.repeat(40) } },
    ])
      await assert.rejects(archiveGithubRelease(input, f.deps), /GITHUB_RELEASE_INPUT/);
    await assert.rejects(
      archiveGithubRelease(f.input, { ...f.deps, validateProject: async () => '0.1.0' }),
      /GITHUB_RELEASE_INPUT/,
    );
    assert.equal(f.state.creates, 0);
  } finally {
    await f.close();
  }
});
test('production mismatched package or binary digest cannot reach archive publication', async () => {
  const f = await fixture();
  try {
    for (const change of [
      { packageSha256: 'c'.repeat(64) },
      { referenceBinarySha256: 'c'.repeat(64) },
      { vaultPreserved: false },
    ])
      await assert.rejects(
        archiveGithubRelease(
          { ...f.input, acceptanceProof: { ...f.acceptanceProof, ...change } },
          f.deps,
        ),
        /GITHUB_RELEASE_INPUT/,
      );
    assert.equal(f.state.published, 0);
  } finally {
    await f.close();
  }
});
test('a partial draft resumes matching assets and publishes its signed GitHub update manifest', async () => {
  const f = await fixture();
  try {
    f.state.failAt = f.release.name + '.sig';
    await assert.rejects(archiveGithubRelease(f.input, f.deps), /NETWORK_FAILED/);
    assert.equal(f.state.release.draft, true);
    assert.equal(f.state.published, 0);
    f.state.failAt = null;
    const result = await archiveGithubRelease(f.input, f.deps);
    assert.equal(result.releaseId, 9);
    assert.equal(result.assetIds.length, 5);
    await archiveGithubRelease(f.input, f.deps);
    assert.equal(f.state.creates, 1);
    assert.equal(f.state.uploads.filter((n) => n === f.release.name).length, 1);
    assert.deepEqual(
      f.state.uploads.sort(),
      [
        f.release.name,
        f.release.name + '.sig',
        'package-info.json',
        'acceptance-proof.json',
        'latest.json',
      ].sort(),
    );
    assert.ok(!f.state.uploads.some((n) => n.endsWith('.secrets.env')));
    const manifest = JSON.parse(f.state.contents.get('latest.json'));
    assert.deepEqual(manifest, {
      version: '0.1.1', notes: 'نقل الإعدادات والتحديث.', bytes: 16,
      sha256: sha(Buffer.from('signed installer')), sourceCommit,
      platforms: { 'windows-x86_64': {
        url: 'https://github.com/wip-bunker-42/Mawjivo/releases/download/v0.1.1/Mawjivo_0.1.1_x64-setup.exe',
        signature: 'production signature',
      } },
    });
  } finally {
    await f.close();
  }
});
test('an existing asset with different bytes is refused without clobbering it', async () => {
  const f = await fixture();
  try {
    f.state.failAt = f.release.name + '.sig';
    await assert.rejects(archiveGithubRelease(f.input, f.deps));
    f.state.failAt = null;
    f.state.assets[0].digest = 'sha256:' + 'c'.repeat(64);
    await assert.rejects(archiveGithubRelease(f.input, f.deps), /GITHUB_RELEASE_ASSET_CONFLICT/);
    assert.equal(f.state.uploads.length, 1);
    assert.equal(f.state.published, 0);
  } finally {
    await f.close();
  }
});
test('a matching draft recovers a zero-byte starter left by a failed GitHub upload', async () => {
  const f = await fixture();
  try {
    f.state.failAt = f.release.name + '.sig';
    await assert.rejects(archiveGithubRelease(f.input, f.deps));
    f.state.failAt = null;
    f.state.assets.push({
      id: 99,
      name: f.release.name + '.sig',
      state: 'starter',
      size: 0,
      digest: null,
    });
    const deleted = [];
    f.client.deleteAsset = async (id) => {
      deleted.push(id);
      f.state.assets = f.state.assets.filter((asset) => asset.id !== id);
    };
    const result = await archiveGithubRelease(f.input, f.deps);
    assert.deepEqual(deleted, [99]);
    assert.equal(result.assetIds.length, 5);
    assert.equal(f.state.release.draft, false);
    assert.equal(f.state.uploads.filter((name) => name === f.release.name).length, 1);
  } finally {
    await f.close();
  }
});
test('starter recovery refuses nonempty assets and already-published releases', async () => {
  for (const change of [{ size: 1 }, { published: true }]) {
    const f = await fixture();
    try {
      await archiveGithubRelease(f.input, f.deps);
      if (!change.published) f.state.release.draft = true;
      Object.assign(f.state.assets[0], { state: 'starter', size: change.size ?? 0, digest: null });
      let deletes = 0;
      f.client.deleteAsset = async () => {
        deletes++;
      };
      await assert.rejects(archiveGithubRelease(f.input, f.deps), /GITHUB_RELEASE_ASSET_CONFLICT/);
      assert.equal(deletes, 0);
    } finally {
      await f.close();
    }
  }
});
test('acceptance archive uses a specific prerelease tag and never production release semantics', async () => {
  const f = await fixture();
  try {
    await archiveGithubRelease(
      { ...f.input, mode: 'acceptance', tag: 'acceptance-v0.1.1-aaaaaaaa' },
      f.deps,
    );
    assert.equal(f.state.release.prerelease, true);
    assert.equal(f.state.release.make_latest, 'false');
    assert.equal(f.state.release.draft, false);
    await assert.rejects(
      archiveGithubRelease({ ...f.input, mode: 'acceptance' }, f.deps),
      /GITHUB_RELEASE_INPUT/,
    );
  } finally {
    await f.close();
  }
});
test('an explicitly public repository archives only the proven signed package and safe proof', async () => {
  const f = await fixture();
  try {
    const result = await archiveGithubRelease(f.input, {
      ...f.deps,
      client: { ...f.client, repository: async () => ({ private: false }) },
    });
    assert.equal(result.assetIds.length, 5);
    assert.equal(f.state.published, 1);
    assert.ok(!f.state.uploads.some((name) => name.endsWith('.secrets.env')));
    await assert.rejects(
      archiveGithubRelease(f.input, {
        ...f.deps,
        client: { ...f.client, repository: async () => ({}) },
      }),
      /GITHUB_RELEASE_API_FAILED/,
    );
  } finally {
    await f.close();
  }
});
test('a tag resolving to a different commit is refused regardless of repository visibility', async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      archiveGithubRelease(f.input, {
        ...f.deps,
        client: { ...f.client, resolveTag: async () => 'c'.repeat(40) },
      }),
      /GITHUB_RELEASE_SOURCE_CONFLICT/,
    );
    assert.equal(f.state.creates, 0);
  } finally {
    await f.close();
  }
});
test('an existing tag commit is authoritative when unused target_commitish metadata names a branch', async () => {
  const f = await fixture();
  try {
    await archiveGithubRelease(f.input, f.deps);
    f.state.release.target_commitish = 'abdo/initial';
    await archiveGithubRelease(f.input, f.deps);
    assert.equal(f.state.creates, 1);
  } finally {
    await f.close();
  }
});
test('the API client includes drafts in bounded authenticated release listing', async () => {
  const calls = [];
  const client = createGithubReleaseClient({
    repository: 'aimansour/Mawjivo',
    run: (args) => {
      calls.push(args);
      return args.some((arg) => arg.includes('/releases?'))
        ? [{ id: 9, tag_name: 'v0.1.1', draft: true }]
        : null;
    },
  });
  const found = await client.getRelease('v0.1.1');
  assert.equal(found?.id, 9);
  assert.ok(calls[0].some((arg) => arg.includes('/releases?per_page=100&page=1')));
});
test('deleting a recoverable starter accepts the GitHub empty 204 response', async () => {
  const calls = [];
  const client = createGithubReleaseClient({
    repository: 'aimansour/Mawjivo',
    spawn: (executable, args) => {
      calls.push([executable, ...args]);
      return { status: 0, stdout: '', stderr: '' };
    },
  });
  assert.equal(await client.deleteAsset(99), null);
  assert.ok(calls[0].includes('repos/aimansour/Mawjivo/releases/assets/99'));
  assert.ok(calls[0].includes('DELETE'));
});
test('Actions never implicitly creates a new tag requiring permanent workflow credentials', async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      archiveGithubRelease(f.input, { ...f.deps, isActions: true }),
      /GITHUB_RELEASE_EXISTING_TAG_REQUIRED/,
    );
    assert.equal(f.state.creates, 0);
  } finally {
    await f.close();
  }
});

test('a signed candidate is anonymous prerelease only until actual acceptance permits promotion', async () => {
  const f = await fixture();
  try {
    const testSignaturePath = join(f.packageDirectory, 'supplemental.sig');
    await writeFile(testSignaturePath, 'test signature');
    let verifiedTest = false;
    const deps = { ...f.deps, verifyTestSignature: async () => { verifiedTest = true; } };
    await archiveGithubRelease({ ...f.input, stageOnly: true, acceptanceProof: null, testSignaturePath }, deps);
    assert.equal(verifiedTest, true);
    assert.equal(f.state.release.draft, false);
    assert.equal(f.state.release.prerelease, true);
    assert.equal(f.state.release.make_latest, 'false');
    assert.equal(f.state.contents.has('latest.json'), false);
    const candidate = JSON.parse(f.state.contents.get('update-test.json'));
    assert.equal(candidate.platforms['windows-x86_64'].signature, 'test signature');
    assert.equal(candidate.platforms['windows-x86_64'].url, 'https://github.com/wip-bunker-42/Mawjivo/releases/download/v0.1.1/Mawjivo_0.1.1_x64-setup.exe');
    assert.equal(f.state.contents.get(f.release.name + '.sig'), 'production signature');
    await assert.rejects(archiveGithubRelease({ ...f.input, acceptanceProof: { ...f.acceptanceProof, vaultPreserved: false } }, f.deps));
    assert.equal(f.state.release.prerelease, true);
    await archiveGithubRelease(f.input, f.deps);
    assert.equal(f.state.release.prerelease, false);
    assert.equal(f.state.release.make_latest, 'true');
    assert.equal(f.state.assets.some((asset) => asset.name === 'update-test.json'), false);
    assert.equal(f.state.assets.length, 5);
  } finally { await f.close(); }
});

test('an invalid supplemental signature prevents any candidate publication', async () => {
  const f = await fixture();
  try {
    const testSignaturePath = join(f.packageDirectory, 'supplemental.sig');
    await writeFile(testSignaturePath, 'test signature');
    await assert.rejects(archiveGithubRelease({ ...f.input, stageOnly: true, acceptanceProof: null, testSignaturePath }, {
      ...f.deps, verifyTestSignature: async () => { throw new Error('RELEASE_SIGNATURE_INVALID'); },
    }), /RELEASE_SIGNATURE_INVALID/);
    assert.equal(f.state.creates, 0);
  } finally { await f.close(); }
});
