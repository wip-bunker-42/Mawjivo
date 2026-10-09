import type { Channel, ChannelLimits, Platform } from '@mawjivo/core';
import type { DecryptedConnection, ProviderAdapter } from './types';
import { providerJson } from './http';
import { ServiceError } from '../errors';
import { channelIdentity, readinessFor } from './types';
interface Organization {
  id: string;
  limits: { scheduledThreadsPerChannel: number | null; scheduledPosts: number | null };
}
interface RemoteChannel {
  id: string;
  name: string;
  service: string;
  isLocked: boolean;
  isDisconnected: boolean;
  allowedActions: string[];
  type: string;
  metadata?: { defaultToReminders?: boolean } | null;
}
interface ChannelConfiguration {
  channelId: string;
  authorizationStatus: { feature: string; status: string }[];
}
export const BUFFER_ORGANIZATIONS_QUERY =
  'query MawjivoOrganizations { account { organizations { id limits { scheduledThreadsPerChannel scheduledPosts } } } }';
export async function bufferQuery<T>(
  connection: DecryptedConnection,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const response = await providerJson<{ data?: T; errors?: unknown[] }>(
    'https://api.buffer.com',
    connection.credentials.apiKey!,
    { query, variables },
  );
  if (!response.data || response.errors?.length)
    throw new ServiceError(
      'BUFFER_PERMISSIONS',
      'تعذر قراءة قنوات Buffer. تحقق من صلاحيات المفتاح.',
      400,
    );
  return response.data;
}
const sources = {
  x: 'https://support.buffer.com/articles/using-xtwitter-with-buffer-nA84XnWtuU',
  threads: 'https://support.buffer.com/articles/using-threads-with-buffer-HN9ZUFnVZv',
  tiktok: 'https://support.buffer.com/articles/using-tiktok-with-buffer-oGEroY9Of2',
  youtube: 'https://support.buffer.com/en-us/articles/using-youtube-shorts-with-buffer-Jl8iR6jIck',
  facebook: 'https://support.buffer.com/en-us/articles/using-facebook-with-buffer-jY1AM9fz2G',
  instagram: 'https://support.buffer.com/en-us/articles/using-instagram-with-buffer-YSjg2dXFV8',
};
/** Conservative verified direct publishing rules; no notification-based fallback. */
export function bufferLimits(platform: Platform, org: Organization, now: string): ChannelLimits {
  const common: ChannelLimits = {
    supportedKinds: ['text', 'image', 'video'],
    textMax: 500,
    textMetric: 'utf16',
    source: sources[platform],
    verifiedAt: now,
  };
  if (platform === 'youtube')
    return {
      ...common,
      supportedKinds: ['video'],
      titleMax: 100,
      textMax: 5000,
      video: {
        mimeTypes: ['video/mp4', 'video/quicktime', 'video/mpeg', 'video/x-msvideo', 'video/webm'],
        maxBytes: 9_000_000_000,
        maxCount: 1,
        maxDurationMs: 180_000,
        minAspectRatio: 9 / 16,
        maxAspectRatio: 1,
      },
    };
  if (platform === 'threads')
    return {
      ...common,
      maxUrls: 5,
      image: {
        mimeTypes: ['image/jpeg', 'image/png'],
        maxBytes: 8_000_000,
        maxCount: 10,
        minAspectRatio: 0.1,
        maxAspectRatio: 10,
      },
      video: {
        mimeTypes: ['video/mp4', 'video/quicktime'],
        maxBytes: 1_000_000_000,
        maxCount: 1,
        maxDurationMs: 300_000,
      },
      ...(typeof org.limits.scheduledThreadsPerChannel === 'number'
        ? { threadParts: 25, scheduledThreadsPerChannel: org.limits.scheduledThreadsPerChannel }
        : {}),
    };
  if (platform === 'x')
    return {
      ...common,
      textMetric: 'weightedX',
      textMax: 280,
      image: {
        mimeTypes: ['image/jpeg', 'image/png', 'image/heic', 'image/webp'],
        maxBytes: 5_000_000,
        maxCount: 4,
        maxWidth: 8192,
        maxHeight: 8192,
      },
      video: {
        mimeTypes: ['video/mp4', 'video/quicktime', 'video/x-msvideo', 'video/x-m4v'],
        maxBytes: 512_000_000,
        maxCount: 1,
        minDurationMs: 500,
        maxDurationMs: 140_000,
      },
      altMax: 1000,
      altKinds: ['image'],
      ...(typeof org.limits.scheduledThreadsPerChannel === 'number'
        ? { threadParts: 25, scheduledThreadsPerChannel: org.limits.scheduledThreadsPerChannel }
        : {}),
    };
  if (platform === 'tiktok')
    return {
      ...common,
      supportedKinds: ['image', 'video'],
      textMax: 4000,
      textMaxByKind: { video: 2200 },
      image: {
        mimeTypes: ['image/jpeg', 'image/webp'],
        maxBytes: 20_000_000,
        maxCount: 10,
        maxWidth: 1920,
        maxHeight: 1920,
      },
      video: {
        mimeTypes: ['video/mp4', 'video/quicktime', 'video/webm'],
        maxBytes: 1_000_000_000,
        maxCount: 1,
        minDurationMs: 3000,
        maxDurationMs: 600_000,
        minWidth: 360,
        minHeight: 360,
      },
    };
  if (platform === 'facebook')
    return {
      ...common,
      textMax: 5000,
      image: {
        mimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
        maxBytes: 10_000_000,
        maxCount: 10,
        maxWidth: 8192,
        maxHeight: 8192,
      },
      video: {
        mimeTypes: ['video/mp4', 'video/quicktime', 'video/x-msvideo', 'video/x-m4v'],
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
    ...common,
    supportedKinds: ['image', 'video'],
    maxHashtags: 5,
    maxMentions: 20,
    textMax: 2196,
    textMetric: 'utf16Instagram',
    image: {
      mimeTypes: ['image/jpeg'],
      maxBytes: 8_000_000,
      maxCount: 10,
      minAspectRatio: 3 / 4,
      maxAspectRatio: 1.91,
      minWidth: 320,
      maxWidth: 1440,
    },
    video: {
      mimeTypes: ['video/mp4', 'video/quicktime'],
      maxBytes: 300_000_000,
      maxCount: 1,
      minDurationMs: 5000,
      maxDurationMs: 900_000,
      minAspectRatio: 9 / 16,
      maxAspectRatio: 4 / 5,
      maxWidth: 1920,
    },
    altMax: 1000,
    altKinds: ['image'],
  };
}
function platformFor(service: string): Platform | null {
  return (
    (
      {
        twitter: 'x',
        x: 'x',
        threads: 'threads',
        youtube: 'youtube',
        tiktok: 'tiktok',
        facebook: 'facebook',
        instagram: 'instagram',
      } as Record<string, Platform>
    )[service] ?? null
  );
}
async function discover(connection: DecryptedConnection, _env: Env): Promise<Channel[]> {
  const { account } = await bufferQuery<{ account: { organizations: Organization[] } }>(
    connection,
    BUFFER_ORGANIZATIONS_QUERY,
  );
  if (!Array.isArray(account?.organizations) || account.organizations.length > 100)
    throw new ServiceError('BUFFER_ORGANIZATIONS', 'تعذر التحقق من مساحات Buffer.', 400);
  const channels: Channel[] = [];
  const now = new Date().toISOString();
  for (let start = 0; start < account.organizations.length; start += 15) {
    const batch = account.organizations.slice(start, start + 15);
    const variables: Record<string, string> = {};
    const fields = batch
      .map((org, index) => {
        variables['o' + index] = org.id;
        return `c${index}:channels(input:{organizationId:$o${index}}){id name service isLocked isDisconnected allowedActions type metadata{...on InstagramMetadata{defaultToReminders}}} f${index}:configuration(input:{organizationId:$o${index}}){channels{channelId authorizationStatus{feature status}}}`;
      })
      .join(' ');
    const query = `query MawjivoChannels(${batch.map((_, i) => `$o${i}:OrganizationId!`).join(',')}) {${fields}}`;
    const data = await bufferQuery<
      Record<string, RemoteChannel[] | { channels: ChannelConfiguration[] }>
    >(connection, query, variables);
    for (const [index, org] of batch.entries()) {
      const remote = data['c' + index] as RemoteChannel[],
        config = data['f' + index] as { channels: ChannelConfiguration[] };
      if (!Array.isArray(remote) || !Array.isArray(config?.channels))
        throw new ServiceError('BUFFER_RESPONSE', 'تعذر التحقق من قنوات Buffer.', 502);
      for (const item of remote) {
        const platform = platformFor(item.service);
        if (!platform) continue;
        const status = config.channels.find((c) => c.channelId === item.id)?.authorizationStatus;
        const limits = bufferLimits(platform, org, now);
        const automatic =
          platform === 'facebook'
            ? item.type === 'page'
            : platform === 'instagram'
              ? item.type === 'business' && item.metadata?.defaultToReminders === false
              : true;
        const ready =
          automatic &&
          !item.isLocked &&
          !item.isDisconnected &&
          item.allowedActions.includes('manageUpdates') &&
          item.allowedActions.includes('scheduleUpdates') &&
          status?.some((s) => s.feature === 'posting' && s.status === 'ok') === true &&
          limits.supportedKinds.length > 0;
        channels.push({
          id: await channelIdentity(connection, item.id),
          connectionId: connection.id,
          remoteId: item.id,
          displayName: item.name.slice(0, 240),
          provider: 'buffer',
          platform,
          ready,
          limits,
          ...(!ready
            ? {
                readinessMessageAr: limits.supportedKinds.length
                  ? 'أعد ربط القناة أو امنح صلاحية النشر في Buffer.'
                  : 'يحتاج هذا الربط إلى التحقق من إعدادات النشر المباشر.',
              }
            : {}),
        });
      }
    }
  }
  return channels;
}
export const bufferAdapter: ProviderAdapter = {
  discover,
  async validate(connection, env) {
    return readinessFor(await discover(connection, env));
  },
};
