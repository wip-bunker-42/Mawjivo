import { publishDownloads } from './downloads-publication.mjs';

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
