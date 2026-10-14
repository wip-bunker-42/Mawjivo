import { readFile, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { verifyReleasePackage, verifyDetachedSignature } from './verify-release.mjs';
import { stageRelease, activateRelease } from './release-publication.mjs';
import { createReleaseStore } from './release-store.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));
export async function publishAcceptanceCandidate(
  { directory, testSignaturePath },
  store,
  overrides = {},
) {
  const dependencies = {
    verifyPackage: verifyReleasePackage,
    readSignature: async (path) => {
      if ((await stat(path)).size > 4096) throw new Error('RELEASE_SIGNATURE_INVALID');
      return (await readFile(path, 'utf8')).trim();
    },
    verifyTestSignature: async (input) => {
      const config = JSON.parse(await readFile(join(root, 'tools/acceptance-tauri.json'), 'utf8'));
      await verifyDetachedSignature({ ...input, publicKey: config.plugins.updater.pubkey });
    },
    stage: stageRelease,
    activate: activateRelease,
    ...overrides,
  };
  const release = await dependencies.verifyPackage(directory, { channel: 'production' });
  const signature = await dependencies.readSignature(testSignaturePath);
  if (!signature || signature.length > 4096) throw new Error('RELEASE_SIGNATURE_INVALID');
  await dependencies.verifyTestSignature({
    installerPath: release.objects[0].path,
    signaturePath: testSignaturePath,
    version: release.version,
  });
  const staged = await dependencies.stage(release, store);
  const testRelease = {
    ...release,
    channel: 'test',
    manifest: {
      ...release.manifest,
      platforms: {
        ...release.manifest.platforms,
        'windows-x86_64': { ...release.manifest.platforms['windows-x86_64'], signature },
      },
    },
  };
  return dependencies.activate({ ...staged, release: testRelease }, null, store);
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [directory, testSignaturePath] = process.argv.slice(2);
  if (!directory || !testSignaturePath) throw new Error('ACCEPTANCE_CANDIDATE_INPUT');
  console.log(
    JSON.stringify(
      await publishAcceptanceCandidate(
        { directory, testSignaturePath },
        createReleaseStore(process.env),
      ),
    ),
  );
}
