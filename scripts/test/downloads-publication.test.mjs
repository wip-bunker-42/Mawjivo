import assert from 'node:assert/strict';
import { test } from 'node:test';
import { publishDownloads } from '../downloads-publication.mjs';
const objects = [
  { key: 'media-tools/1.0/media-tools-win32-x64.zip', sha256: 'a'.repeat(64) },
  { key: 'media-tools/1.0/media-tools-sources.zip', sha256: 'b'.repeat(64) },
];
test('a published immutable file with different bytes prevents every upload in the batch', async () => {
  const uploads = [];
  await assert.rejects(
    publishDownloads(objects, {
      inspect: async (object) => (object === objects[0] ? null : { sha256: 'c'.repeat(64) }),
      upload: async (object) => uploads.push(object.key),
    }),
    /DOWNLOADS_IMMUTABLE/,
  );
  assert.deepEqual(uploads, []);
});
test('a resumed publication reuses verified objects and only uploads missing files', async () => {
  const uploads = [];
  await publishDownloads(objects, {
    inspect: async (object) => (object === objects[0] ? { sha256: object.sha256 } : null),
    upload: async (object) => uploads.push(object.key),
  });
  assert.deepEqual(uploads, [objects[1].key]);
});
