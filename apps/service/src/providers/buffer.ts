import type { Channel, ChannelLimits, Platform } from '@mawjivo/core';
import type {
  DecryptedConnection,
  ProviderAdapter,
  ProviderResult,
  ProviderReceipt,
  ResolvedTarget,
} from './types';

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
  variables: Record<string, unknown>,
  env: Env,
): Promise<T> {
  const reply = await exchange<T>(connection, query, variables, 'discovery', env);
  if (reply.kind === 'deferred')
    throw new ServiceError(
      'PROVIDER_RATE_LIMIT',
      'وصل الحساب إلى حد الطلبات. أعد الفحص لاحقًا.',
      429,
      true,
    );
  if (reply.kind === 'uncertain')
    throw new ServiceError(
      'PROVIDER_NETWORK',
      'تعذر فحص الحساب. تحقق من الاتصال ثم أعد الفحص.',
      502,
      true,
    );
  if (!reply.response.ok)
    throw new ServiceError(
      reply.response.status === 429 ? 'PROVIDER_RATE_LIMIT' : 'PROVIDER_AUTH',
      reply.response.status === 429
        ? 'وصل الحساب إلى حد الطلبات. أعد الفحص لاحقًا.'
        : 'تعذر التحقق من الرمز وصلاحياته. أعد ربط الحساب.',
      reply.response.status === 429 ? 429 : 400,
      reply.response.status === 429,
    );
  if (!reply.body?.data || reply.body.errors?.length)
    throw new ServiceError(
      'BUFFER_PERMISSIONS',
      'تعذر قراءة قنوات Buffer. تحقق من صلاحيات المفتاح.',
      400,
    );
  return reply.body.data;
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
async function discover(connection: DecryptedConnection, env: Env): Promise<Channel[]> {
  const { account } = await bufferQuery<{ account: { organizations: Organization[] } }>(
    connection,
    BUFFER_ORGANIZATIONS_QUERY,
    {},
    env,
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
    >(connection, query, variables, env);
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
  publishBatch,
  readReceipts,
  async validate(connection, env) {
    return readinessFor(await discover(connection, env));
  },
};
import { boundedJson, remoteChannels } from './publishing';
import { observeRateLimits, reserveRequests } from './rate-budget';
import { instant, providerError, publicUrl, retryAt } from './redact';
interface BufferPayload<
  T = Record<
    string,
    {
      __typename?: string;
      post?: { id?: string };
      id?: string;
      status?: string;
      sentAt?: string;
      externalLink?: string;
    }
  >,
> {
  data?: T;
  errors?: { extensions?: { code?: string }; path?: unknown[] }[];
}
type BufferExchange<T> =
  | { kind: 'response'; response: Response; body?: BufferPayload<T> }
  | { kind: 'deferred'; retryAt: string }
  | { kind: 'uncertain' };
async function exchange<T = NonNullable<BufferPayload['data']>>(
  connection: DecryptedConnection,
  query: string,
  variables: Record<string, unknown>,
  purpose: 'publish' | 'receipt' | 'discovery',
  env: Env,
): Promise<BufferExchange<T>> {
  const now = new Date().toISOString();
  const budget = await reserveRequests(connection.id, 1, purpose, now, env);
  if (budget.kind === 'deferred') return budget;
  let response: Response;
  try {
    response = await fetch('https://api.buffer.com', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + connection.credentials.apiKey!,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
      redirect: 'manual',
      // Video mutations may synchronously fetch media for several aliases.
      // Read requests stay short; writes get time to return their accepted IDs.
      signal: AbortSignal.timeout(purpose === 'publish' ? 120000 : 25000),
    });
  } catch {
    try {
      await observeRateLimits(
        connection.id,
        new Headers(),
        new Date().toISOString(),
        env,
        budget.reservationId,
      );
    } catch {
      console.error({ event: 'provider_budget_update_failed', provider: 'buffer' });
    }
    return { kind: 'uncertain' };
  }
  // A bookkeeping failure after a write must not discard an accepted remote ID.
  try {
    await observeRateLimits(
      connection.id,
      response.headers,
      new Date().toISOString(),
      env,
      budget.reservationId,
    );
  } catch {
    console.error({ event: 'provider_budget_update_failed', provider: 'buffer' });
  }
  let body: BufferPayload<T> | undefined;
  if (response.ok)
    try {
      body = (await boundedJson(response)) as BufferPayload<T>;
    } catch {
      return { kind: 'uncertain' };
    }
  else await response.body?.cancel();
  return { kind: 'response', response, ...(body ? { body } : {}) };
}
function postInput(target: ResolvedTarget, remoteId: string): Record<string, unknown> {
  const assets = target.assets.map((asset, index) =>
    asset.mimeType.startsWith('image/')
      ? {
          image: {
            url: asset.url,
            ...(target.altTexts[index] !== undefined
              ? { metadata: { altText: target.altTexts[index] } }
              : {}),
          },
        }
      : { video: { url: asset.url, metadata: { title: target.title ?? '' } } },
  );
  const metadata: Record<string, unknown> = {};
  if ((target.platform === 'x' || target.platform === 'threads') && target.threadParts.length)
    metadata[target.platform === 'x' ? 'twitter' : 'threads'] = {
      thread: target.threadParts.map((text, index) => ({
        text,
        assets: index === 0 ? assets : [],
      })),
    };
  if (target.platform === 'youtube')
    metadata.youtube = {
      categoryId: '22',
      title: target.title ?? '',
      privacy: 'public',
      madeForKids: false,
      notifySubscribers: true,
    };
  if (target.platform === 'tiktok')
    metadata.tiktok = { ...(target.title ? { title: target.title } : {}), isAiGenerated: false };
  if (target.platform === 'instagram')
    metadata.instagram = {
      type: target.assets[0]?.mimeType.startsWith('video/') ? 'reel' : 'post',
      shouldShareToFeed: true,
    };
  if (target.platform === 'facebook') metadata.facebook = { type: 'post' };
  return {
    channelId: remoteId,
    text: target.text,
    assets,
    mode: 'shareNow',
    schedulingType: 'automatic',
    needsApproval: false,
    ...(Object.keys(metadata).length ? { metadata } : {}),
  };
}
export async function publishBatch(
  connection: DecryptedConnection,
  targets: ResolvedTarget[],
  env: Env,
): Promise<ProviderResult[]> {
  const results: ProviderResult[] = [];
  for (let start = 0; start < targets.length; start += 30) {
    const batch = targets.slice(start, start + 30),
      channels = await remoteChannels(connection, batch, env),
      valid = batch.filter((t) => channels.has(t.channelId));
    const byChannel = new Map<string, ProviderResult>();
    for (const t of batch)
      if (!channels.has(t.channelId))
        byChannel.set(t.channelId, {
          kind: 'rejected',
          channelId: t.channelId,
          error: providerError('PROVIDER_CHANNEL'),
        });
    if (valid.length) {
      const variables: Record<string, unknown> = {};
      valid.forEach((t, i) => {
        variables['i' + i] = postInput(t, channels.get(t.channelId)!);
      });
      const query =
        'mutation MawjivoPublish(' +
        valid.map((_, i) => '$i' + i + ':CreatePostInput!').join(',') +
        '){' +
        valid
          .map(
            (_, i) =>
              'p' +
              i +
              ':createPost(input:$i' +
              i +
              '){__typename ...on PostActionSuccess{post{id status}} ...on MutationError{message}}',
          )
          .join(' ') +
        '}';
      const reply = await exchange(connection, query, variables, 'publish', env);
      for (const [i, t] of valid.entries()) {
        let result: ProviderResult;
        if (reply.kind === 'deferred')
          result = {
            kind: 'rejected',
            channelId: t.channelId,
            error: providerError('PROVIDER_RATE_LIMIT', true),
            retryAt: reply.retryAt,
          };
        else if (reply.kind === 'uncertain')
          result = {
            kind: 'uncertain',
            channelId: t.channelId,
            error: providerError('PROVIDER_UNCERTAIN'),
          };
        else if (!reply.response.ok) {
          const status = reply.response.status;
          result =
            (status >= 300 && status < 400) || status >= 500 || status === 408
              ? {
                  kind: 'uncertain',
                  channelId: t.channelId,
                  error: providerError('PROVIDER_UNCERTAIN'),
                }
              : {
                  kind: 'rejected',
                  channelId: t.channelId,
                  error: providerError(
                    status === 429
                      ? 'PROVIDER_RATE_LIMIT'
                      : status === 401 || status === 403
                        ? 'PROVIDER_AUTH'
                        : 'PROVIDER_CONTENT',
                    status === 429,
                  ),
                  ...(status === 429
                    ? {
                        retryAt:
                          retryAt(reply.response.headers) ??
                          new Date(Date.now() + 60000).toISOString(),
                      }
                    : {}),
                };
        } else {
          const payload = reply.body?.data?.['p' + i];
          if (
            payload?.__typename === 'PostActionSuccess' &&
            typeof payload.post?.id === 'string' &&
            payload.post.id.length <= 256
          )
            result = { kind: 'accepted', channelId: t.channelId, remoteId: payload.post.id };
          else if (
            payload?.__typename &&
            [
              'InvalidInputError',
              'NotFoundError',
              'UnauthorizedError',
              'LimitReachedError',
            ].includes(payload.__typename)
          )
            result = {
              kind: 'rejected',
              channelId: t.channelId,
              error: providerError(
                payload.__typename === 'UnauthorizedError'
                  ? 'PROVIDER_AUTH'
                  : payload.__typename === 'LimitReachedError'
                    ? 'PROVIDER_RATE_LIMIT'
                    : 'PROVIDER_CONTENT',
                payload.__typename === 'LimitReachedError',
              ),
            };
          else if (
            reply.body?.errors?.every((e) => e.extensions?.code === 'GRAPHQL_VALIDATION_FAILED') &&
            reply.body.errors.length
          )
            result = {
              kind: 'rejected',
              channelId: t.channelId,
              error: providerError('PROVIDER_CONTENT'),
            };
          else
            result = {
              kind: 'uncertain',
              channelId: t.channelId,
              error: providerError('PROVIDER_UNCERTAIN'),
            };
        }
        byChannel.set(t.channelId, result);
      }
    }
    results.push(...batch.map((t) => byChannel.get(t.channelId)!));
  }
  return results;
}
export async function readReceipts(
  connection: DecryptedConnection,
  remoteIds: string[],
  env: Env,
): Promise<ProviderReceipt[]> {
  const receipts: ProviderReceipt[] = [];
  for (let start = 0; start < remoteIds.length; start += 30) {
    const ids = remoteIds.slice(start, start + 30);
    if (!ids.length) continue;
    const variables: Record<string, unknown> = {};
    ids.forEach((id, i) => {
      variables['i' + i] = { id };
    });
    const query =
      'query MawjivoReceipts(' +
      ids.map((_, i) => '$i' + i + ':PostInput!').join(',') +
      '){' +
      ids
        .map((_, i) => 'r' + i + ':post(input:$i' + i + '){id status sentAt externalLink}')
        .join(' ') +
      '}';
    const reply = await exchange(connection, query, variables, 'receipt', env);
    for (const [i, remoteId] of ids.entries()) {
      const post =
        reply.kind === 'response' && reply.response.ok ? reply.body?.data?.['r' + i] : undefined;
      if (post?.id === remoteId && post.status === 'sent')
        receipts.push({
          remoteId,
          state: 'published',
          ...(instant(post.sentAt) ? { publishedAt: instant(post.sentAt) } : {}),
          ...(publicUrl(post.externalLink) ? { publicUrl: publicUrl(post.externalLink) } : {}),
        });
      else if (post?.id === remoteId && ['sending', 'scheduled'].includes(post.status ?? ''))
        receipts.push({ remoteId, state: 'processing' });
      else if (post?.id === remoteId && post.status === 'error')
        receipts.push({ remoteId, state: 'failed', error: providerError('PROVIDER_FAILED') });
      else
        receipts.push({
          remoteId,
          state: 'unknown',
          error: providerError(
            reply.kind === 'deferred' ||
              (reply.kind === 'response' && reply.response.status === 429)
              ? 'PROVIDER_RATE_LIMIT'
              : 'PROVIDER_RECEIPT',
            true,
          ),
          ...(reply.kind === 'deferred'
            ? { retryAt: reply.retryAt }
            : reply.kind === 'response' && reply.response.status === 429
              ? { retryAt: retryAt(reply.response.headers) }
              : {}),
        });
    }
  }
  return receipts;
}
