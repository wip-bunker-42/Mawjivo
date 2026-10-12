import type { Platform } from '@mawjivo/core';
import type { DecryptedConnection, ResolvedTarget } from '../src/providers/types';
import { encryptSecret } from '../src/secrets';
import { testEnv } from './helpers';
export const bufferConnection: DecryptedConnection = {
  id: 'buffer-first',
  workspaceId: 'workspace-a',
  provider: 'buffer',
  label: 'first',
  credentials: { apiKey: 'synthetic-buffer-first' },
};
export const metaConnection: DecryptedConnection = {
  id: 'meta-first',
  workspaceId: 'workspace-a',
  provider: 'meta',
  label: 'Meta',
  credentials: {
    pageId: '12345',
    instagramId: '67890',
    pageAccessToken: 'synthetic-page-secret',
    userAccessToken: 'synthetic-user-secret',
  },
};
export async function seedConnection(connection: DecryptedConnection) {
  const env = testEnv();
  const cipher = await encryptSecret(
    JSON.stringify(connection.credentials),
    { workspaceId: connection.workspaceId, connectionId: connection.id, keyVersion: 1 },
    env,
  );
  await env.DB.prepare(
    'INSERT INTO connections(id,workspace_id,provider,label,secret_cipher,updated_at_ms) VALUES(?,?,?,?,?,1)',
  )
    .bind(connection.id, connection.workspaceId, connection.provider, connection.label, cipher)
    .run();
}
export async function target(
  platform: Platform,
  connection = bufferConnection,
  id = 'channel-' + platform,
): Promise<ResolvedTarget> {
  const remoteId =
    connection.provider === 'buffer'
      ? 'remote-' + platform
      : platform === 'facebook'
        ? '12345'
        : '67890';
  await testEnv()
    .DB.prepare(
      'INSERT INTO channels(id,workspace_id,connection_id,remote_id,platform,provider,ready,limits_json,discovered_at_ms) VALUES(?,?,?,?,?,?,1,?,1)',
    )
    .bind(id, connection.workspaceId, connection.id, remoteId, platform, connection.provider, '{}')
    .run();
  return {
    channelId: id,
    connectionId: connection.id,
    platform,
    provider: connection.provider,
    text: 'منشور عربي',
    threadParts: [],
    altTexts: [],
    assets: [],
  };
}
export function images(t: ResolvedTarget): ResolvedTarget {
  return {
    ...t,
    altTexts: ['الصورة الأولى', 'الصورة الثانية'],
    assets: [1, 2].map((n) => ({
      sourceAssetId: 'source-' + n,
      recipeId: null,
      assetId: 'asset-' + n,
      url: 'https://service.test/media/nonce' + n + '/صورتي' + n + '.JPEG',
      bytes: 9000,
      mimeType: 'image/jpeg',
    })),
  };
}
export function video(t: ResolvedTarget): ResolvedTarget {
  return {
    ...t,
    ...(t.platform === 'youtube' ? { youtubeCategoryId: '25' as const } : {}),
    title: 'عنوان الفيديو',
    assets: [
      {
        sourceAssetId: 'source-video',
        recipeId: null,
        assetId: 'asset-video',
        url: 'https://service.test/media/nonce/عنوان%20الفيديو.mp4',
        bytes: 35000000,
        mimeType: 'video/mp4',
      },
    ],
  };
}
