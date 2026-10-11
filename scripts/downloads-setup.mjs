export const downloadsOwner = 'mawjivo-release-store:v1';
export async function ensureDownloads(control) {
  const state = await control.inspect();
  if (
    (state.workerExists && !state.workerTags?.includes(downloadsOwner)) ||
    (state.domainService && state.domainService !== 'mawjivo-downloads') ||
    state.foreignDns
  )
    throw new Error('DOWNLOADS_OWNERSHIP');
  if (state.bucketExists && (await control.readMarker()) !== downloadsOwner)
    throw new Error('DOWNLOADS_OWNERSHIP');
  if (!state.bucketExists) {
    await control.createBucket();
    await control.writeMarker(downloadsOwner);
  }
  await control.deploy();
}
