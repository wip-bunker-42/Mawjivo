import type { UploadManifest } from '@mawjivo/core';
import { beginUpload, completeUpload, createMediaAlias } from '../src/assets';
import { testEnv } from './helpers';
export const assetAuth = { deviceId: 'owner', allowedWorkspaceIds: '*' as const };
export const manifest = (bytes = 10): UploadManifest => ({
  sourceAssetId: 'file-synthetic',
  recipeId: null,
  originalName: 'صورتي العربية.jpg',
  kind: 'image',
  mimeType: 'image/jpeg',
  bytes,
  width: 320,
  height: 180,
});
export async function uploaded(workspace = 'workspace-a', input = manifest()) {
  const env = testEnv();
  input = { ...input, sourceAssetId: 'source-' + crypto.randomUUID() };
  const ticket = await beginUpload(assetAuth, workspace, input, env);
  const row = await env.DB.prepare('SELECT object_key FROM assets WHERE id=?')
    .bind(ticket.assetId)
    .first<{ object_key: string }>();
  const multipart = env.MEDIA.resumeMultipartUpload(row!.object_key, ticket.multipartId!);
  const part = await multipart.uploadPart(
    1,
    new Uint8Array(input.bytes).map((_, i) => i),
  );
  const asset = await completeUpload(assetAuth, ticket.assetId, [part], 'a'.repeat(64), env);
  return { asset, key: row!.object_key, ticket };
}
export async function postReference(
  assetId: string,
  postState = 'published',
  targetState = 'published',
  name = 'صورتي العربية.jpg',
) {
  const env = testEnv();
  const id = 'post-' + crypto.randomUUID(),
    channel = 'channel-' + crypto.randomUUID(),
    connection = 'conn-' + crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO connections(id,workspace_id,provider,label,secret_cipher,updated_at_ms) VALUES(?,'workspace-a','buffer','synthetic','unused',1)",
  )
    .bind(connection)
    .run();
  await env.DB.prepare(
    "INSERT INTO channels(id,workspace_id,connection_id,remote_id,platform,provider,ready,limits_json,discovered_at_ms) VALUES(?,'workspace-a',?,'synthetic','x','buffer',1,'{}',1)",
  )
    .bind(channel, connection)
    .run();
  await env.DB.prepare(
    "INSERT INTO posts(id,workspace_id,draft_id,revision,plan_hash,plan_json,state,created_at_ms,updated_at_ms) VALUES(?,'workspace-a',?,1,'synthetic','{}',?,1,1)",
  )
    .bind(id, id, postState)
    .run();
  await env.DB.prepare(
    "INSERT INTO targets(post_id,revision,channel_id,workspace_id,state,updated_at_ms) VALUES(?,1,?,'workspace-a',?,1)",
  )
    .bind(id, channel, targetState)
    .run();
  const alias = await createMediaAlias(assetAuth, assetId, id, 1, channel, name, env);
  return { ...alias, id, channel };
}
