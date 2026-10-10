import { expect, test } from 'vitest';
import { UploadInputSchema } from '../src/schemas';
const input = {
  profileId: 'profile',
  workspaceId: 'space',
  fileId: 'file-original',
  sourceAssetId: 'file-original',
  recipeId: null,
  manifest: {
    sourceAssetId: 'file-original',
    recipeId: null,
    originalName: 'صورتي.JPEG',
    kind: 'image',
    bytes: 90_000,
    mimeType: 'image/jpeg',
    width: 320,
    height: 180,
  },
};
test('upload_contract_accepts_original_and_identified_derived_files', () => {
  expect(UploadInputSchema.safeParse(input).success).toBe(true);
  const recipeId = 'recipe-identified';
  expect(
    UploadInputSchema.safeParse({
      ...input,
      fileId: 'file-derived',
      recipeId,
      manifest: { ...input.manifest, recipeId },
    }).success,
  ).toBe(true);
});
test('upload_contract_rejects_mismatched_identity_and_renderer_paths', () => {
  for (const invalid of [
    { ...input, path: 'C:/private.txt' },
    { ...input, sourceAssetId: 'another-source' },
    { ...input, recipeId: 'another-recipe' },
    { ...input, fileId: 'unrelated-original' },
    { ...input, manifest: { ...input.manifest, bytes: 9_000_000_001 } },
  ])
    expect(UploadInputSchema.safeParse(invalid).success).toBe(false);
});
