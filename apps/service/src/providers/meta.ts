import type { Channel, ChannelLimits } from '@mawjivo/core';
import type { DecryptedConnection, ProviderAdapter } from './types';
import { channelIdentity, readinessFor } from './types';
import { providerJson } from './http';
import { ServiceError } from '../errors';
export const META_VERSION = 'v26.0';
const origin = `https://graph.facebook.com/${META_VERSION}`;
export function metaGet<T>(path: string, token: string): Promise<T> {
  return providerJson<T>(origin + '/' + path, token);
}
interface Permission {
  permission: string;
  status: string;
}
interface Page {
  id: string;
  name: string;
  instagram_business_account?: { id: string; username?: string };
}
interface ManagedPage {
  id: string;
  tasks: string[];
}
interface ManagedPageResult {
  data: ManagedPage[];
  paging?: { cursors?: { after?: string }; next?: string };
}
export function metaLimits(platform: 'facebook' | 'instagram', now: string): ChannelLimits {
  // Conservative app limits for videos; /page/videos verifies the actual token requirements.
  if (platform === 'facebook')
    return {
      supportedKinds: ['text', 'image', 'video'],
      textMax: 5000,
      textMetric: 'utf16',
      source: 'https://developers.facebook.com/docs/graph-api/reference/page/videos/',
      verifiedAt: now,
      image: {
        mimeTypes: ['image/jpeg', 'image/png', 'image/bmp', 'image/gif', 'image/tiff'],
        maxBytes: 10_000_000,
        maxCount: 10,
      },
      video: {
        mimeTypes: ['video/mp4', 'video/quicktime'],
        maxBytes: 1_000_000_000,
        maxCount: 1,
        maxDurationMs: 14_400_000,
        minAspectRatio: 9 / 16,
        maxAspectRatio: 16 / 9,
      },
      altMax: 1000,
      altKinds: ['image'],
    };
  return {
    supportedKinds: ['image', 'video'],
    textMax: 2200,
    maxHashtags: 30,
    maxMentions: 20,
    textMetric: 'utf16',
    source:
      'https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media',
    verifiedAt: now,
    image: {
      mimeTypes: ['image/jpeg'],
      maxBytes: 8_000_000,
      maxCount: 10,
      minWidth: 320,
      maxWidth: 1440,
      minAspectRatio: 4 / 5,
      maxAspectRatio: 1.91,
    },
    video: {
      mimeTypes: ['video/mp4', 'video/quicktime'],
      maxBytes: 300_000_000,
      maxCount: 1,
      minDurationMs: 3000,
      maxDurationMs: 900_000,
      maxWidth: 1920,
      minAspectRatio: 0.01,
      maxAspectRatio: 10,
    },
    altMax: 1000,
    altKinds: ['image'],
  };
}
async function discover(connection: DecryptedConnection, _env: Env): Promise<Channel[]> {
  const credentials = connection.credentials,
    now = new Date().toISOString();
  const channels: Channel[] = [];
  for (const platform of ['facebook', 'instagram'] as const) {
    const remoteId = platform === 'facebook' ? credentials.pageId! : credentials.instagramId!;
    if (!remoteId) continue;
    channels.push({
      id: await channelIdentity(connection, remoteId),
      connectionId: connection.id,
      remoteId,
      platform,
      provider: 'meta',
      ready: false,
      limits: metaLimits(platform, now),
      readinessMessageAr: 'تحقق من الرموز وصلاحيات النشر وربط صفحة Facebook.',
    });
  }
  try {
    const permissions = await metaGet<{ data: Permission[] }>(
      'me/permissions',
      credentials.userAccessToken!,
    );
    const granted = new Set(
      permissions.data.filter((p) => p.status === 'granted').map((p) => p.permission),
    );
    let managed: ManagedPage[] = [];
    let next: string | null = 'me/accounts?fields=id,tasks&limit=100';
    for (let pages = 0; next !== null; pages++) {
      if (pages >= 20)
        throw new ServiceError(
          'META_PAGE_LIMIT',
          'عدد الصفحات يتجاوز حد الفحص. استخدم حسابًا محددًا.',
          400,
        );
      const result: ManagedPageResult = await metaGet<ManagedPageResult>(
        next,
        credentials.userAccessToken!,
      );
      managed = managed.concat(result.data);
      const after = result.paging?.cursors?.after;
      next =
        result.paging?.next && after
          ? 'me/accounts?fields=id,tasks&limit=100&after=' + encodeURIComponent(after)
          : null;
    }
    const page = await metaGet<Page>(
      encodeURIComponent(credentials.pageId!) +
        '?fields=id,name,instagram_business_account{id,username}',
      credentials.pageAccessToken!,
    );
    const task =
      managed
        .find((p) => p.id === credentials.pageId)
        ?.tasks?.some((t) => t === 'CREATE_CONTENT' || t === 'MANAGE') === true;
    const baseReady =
      page.id === credentials.pageId &&
      task &&
      granted.has('pages_read_engagement') &&
      granted.has('pages_show_list');
    const facebook = channels.find((c) => c.platform === 'facebook');
    if (facebook) {
      facebook.displayName = page.name.slice(0, 240);
      facebook.ready =
        baseReady &&
        managed.find((p) => p.id === credentials.pageId)?.tasks.includes('CREATE_CONTENT') ===
          true &&
        granted.has('pages_manage_posts');
      if (facebook.ready) delete facebook.readinessMessageAr;
    }
    const instagram = channels.find((c) => c.platform === 'instagram');
    if (instagram && page.instagram_business_account?.id === credentials.instagramId) {
      try {
        // The linked instagram_business_account edge proves this is a professional account.
        const account = await metaGet<{ id: string; username: string }>(
          encodeURIComponent(credentials.instagramId!) + '?fields=id,username',
          credentials.userAccessToken!,
        );
        instagram.displayName = account.username.slice(0, 240);
        instagram.ready =
          baseReady &&
          account.id === credentials.instagramId &&
          granted.has('instagram_basic') &&
          granted.has('instagram_content_publish');
        if (instagram.ready) delete instagram.readinessMessageAr;
      } catch (error) {
        if (!(error instanceof ServiceError)) throw error;
        instagram.ready = false;
        instagram.readinessMessageAr = error.messageAr;
      }
    }
  } catch (error) {
    if (!(error instanceof ServiceError)) throw error;
    for (const channel of channels) {
      channel.ready = false;
      channel.readinessMessageAr = error.messageAr;
    }
  }
  return channels;
}
export const metaAdapter: ProviderAdapter = {
  discover,
  async validate(connection, env) {
    return readinessFor(await discover(connection, env));
  },
};
