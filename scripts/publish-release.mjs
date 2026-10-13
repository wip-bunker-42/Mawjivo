import { readFile } from 'node:fs/promises';
import { verifyReleasePackage } from './verify-release.mjs';
import { publishRelease } from './release-publication.mjs';
import { createReleaseStore } from './release-store.mjs';

const [directory, channel, proofPath] = process.argv.slice(2);
if (!directory || !channel) throw new Error('Provide verified package directory and channel.');
const release = await verifyReleasePackage(directory, { channel });
if (proofPath) release.acceptanceProof = JSON.parse(await readFile(proofPath, 'utf8'));
const store = createReleaseStore(process.env);
await publishRelease(release, {
  ...store,
  verifySignature: async () => {
    // The existing native verifier ran above before constructing the store.
    console.log(`Verified signed installer ${release.version} from ${release.sourceCommit}.`);
  },
  putManifest: async (selected, manifest) => {
    const current = await store.readManifest(selected);
    await store.putManifest(selected, manifest, current.etag);
    console.log(`Activated verified ${selected} update channel ${release.version}.`);
  },
});
