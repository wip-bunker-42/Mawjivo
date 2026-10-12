import { exports } from 'cloudflare:workers';
import { beforeEach, expect, test } from 'vitest';
import { resetTestData, requestAs, ownerToken } from './helpers';
import { testEnv } from './helpers';
import { auth, publicationFixture } from './publication-fixture';
import { submitPost } from '../src/posts';
beforeEach(resetTestData);
const input = {
  name: 'مساحتي',
  timeZone: 'Africa/Cairo',
  defaultPlatforms: ['youtube'],
  serviceProfileId: 'profile-1',
};
test('category_default_is_persisted_for_new_workspaces', async () => {
  const response = await exports.default.fetch(
    requestAs(ownerToken, '/api/workspaces', { ...input, defaultYoutubeCategoryId: '25' }),
  );
  expect(response.status).toBe(201);
  const created = (await response.json()) as { id: string };
  const saved = await exports.default.fetch(requestAs(ownerToken, '/api/workspaces/' + created.id));
  expect(await saved.json()).toMatchObject({ defaultYoutubeCategoryId: '25' });
});
test('category_changes_are_workspace_scoped_versioned_and_preserved_for_older_clients', async () => {
  const patch = (body: unknown) =>
    exports.default.fetch(requestAs(ownerToken, '/api/workspaces/workspace-a', body, 'PATCH'));
  expect(
    (await patch({ ...input, expectedVersion: 1, defaultYoutubeCategoryId: '25' })).status,
  ).toBe(200);
  expect(
    (await patch({ ...input, expectedVersion: 1, defaultYoutubeCategoryId: '20' })).status,
  ).toBe(409);
  expect((await patch({ ...input, expectedVersion: 2 })).status).toBe(200);
  const current = await exports.default.fetch(requestAs(ownerToken, '/api/workspaces/workspace-a'));
  expect(await current.json()).toMatchObject({ version: 3, defaultYoutubeCategoryId: '25' });
  const other = await exports.default.fetch(requestAs(ownerToken, '/api/workspaces/workspace-b'));
  expect(await other.json()).toMatchObject({ defaultYoutubeCategoryId: null });
  expect(
    (await patch({ ...input, expectedVersion: 3, defaultYoutubeCategoryId: null })).status,
  ).toBe(200);
  const cleared = await exports.default.fetch(requestAs(ownerToken, '/api/workspaces/workspace-a'));
  expect(await cleared.json()).toMatchObject({ defaultYoutubeCategoryId: null });
});
test('the_service_accepts_and_preserves_the_category_in_a_confirmed_video_plan', async () => {
  const fixture = await publicationFixture(),
    channel = fixture.caps.channels[0]!;
  channel.platform = 'youtube';
  await testEnv()
    .DB.prepare('UPDATE channels SET platform=? WHERE id=?')
    .bind('youtube', channel.id)
    .run();
  await testEnv()
    .DB.prepare('UPDATE service_settings SET value_json=? WHERE key=?')
    .bind(JSON.stringify(fixture.caps), 'capabilities:workspace-a')
    .run();
  await testEnv().MEDIA.put('category-video', new Uint8Array(32), {
    httpMetadata: { contentType: 'video/mp4' },
    customMetadata: { assetId: 'uploaded-video' },
  });
  await testEnv()
    .DB.prepare(
      'INSERT INTO assets(id,workspace_id,source_asset_id,object_key,original_name,kind,mime_type,bytes,sha256,width,height,duration_ms,state,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    )
    .bind(
      'uploaded-video',
      'workspace-a',
      'source-video',
      'category-video',
      'original.mp4',
      'video',
      'video/mp4',
      32,
      'a'.repeat(64),
      1080,
      1920,
      10000,
      'complete',
      Date.now(),
      Date.now(),
    )
    .run();
  const submission = await fixture.submission({
    selections: [channel.id],
    title: 'خبر',
    assets: [
      {
        id: 'source-video',
        originalName: 'original.mp4',
        kind: 'video',
        mimeType: 'video/mp4',
        bytes: 32,
        width: 1080,
        height: 1920,
        durationMs: 10000,
      },
    ],
    overrides: { youtube: { youtubeCategoryId: '25' } },
  });
  submission.preparedAssets = [
    {
      sourceAssetId: 'source-video',
      recipeId: null,
      assetId: 'uploaded-video',
      sha256: 'a'.repeat(64),
    },
  ];
  const receipt = await submitPost(auth, submission, fixture.env);
  const stored = await testEnv()
    .DB.prepare('SELECT plan_json FROM posts WHERE id=?')
    .bind(receipt.postId)
    .first<{ plan_json: string }>();
  expect(JSON.parse(stored!.plan_json).targets[0]).toHaveProperty('youtubeCategoryId', '25');
});
test('unsupported_category_is_rejected_without_changing_the_workspace', async () => {
  const response = await exports.default.fetch(
    requestAs(
      ownerToken,
      '/api/workspaces/workspace-a',
      { ...input, expectedVersion: 1, defaultYoutubeCategoryId: '999' },
      'PATCH',
    ),
  );
  expect(response.status).toBe(400);
  const saved = await exports.default.fetch(requestAs(ownerToken, '/api/workspaces/workspace-a'));
  expect(await saved.json()).toMatchObject({ version: 1, defaultYoutubeCategoryId: null });
});
