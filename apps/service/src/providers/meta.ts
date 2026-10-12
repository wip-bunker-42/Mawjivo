import type { Channel, ChannelLimits } from '@mawjivo/core';
import type {
  DecryptedConnection,
  ProviderAdapter,
  ProviderResult,
  ProviderReceipt,
  ResolvedTarget,
} from './types';
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
  publishBatch,
  readReceipts,
  continuePublishing,
  async validate(connection, env) {
    return readinessFor(await discover(connection, env));
  },
};
import { boundedJson, remoteChannels } from './publishing';
import { instant, providerError, publicUrl, retryAt } from './redact';
import type { AppError } from '@mawjivo/core';
import type { ProviderState } from './types';
class MetaFailure extends Error {
  constructor(
    public readonly uncertain: boolean,
    public readonly safe: AppError,
    public readonly retryAt?: string,
  ) {
    super(safe.code);
  }
}
interface MetaResponse {
  id?: string;
  status_code?: string;
  status?: { video_status?: string; publishing_phase?: { status?: string } };
  is_published?: boolean;
  published?: boolean;
  created_time?: string;
  timestamp?: string;
  permalink_url?: string;
  permalink?: string;
  error?: { code?: number; error_subcode?: number; is_transient?: boolean };
}
async function metaRequest(
  path: string,
  token: string,
  form?: Record<string, string>,
): Promise<MetaResponse> {
  let response: Response;
  try {
    response = await fetch(origin + '/' + path, {
      method: form ? 'POST' : 'GET',
      headers: {
        Authorization: 'Bearer ' + token,
        ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      },
      ...(form ? { body: new URLSearchParams(form).toString() } : {}),
      redirect: 'manual',
      signal: AbortSignal.timeout(25000),
    });
  } catch {
    throw new MetaFailure(
      Boolean(form),
      providerError(form ? 'PROVIDER_UNCERTAIN' : 'PROVIDER_RECEIPT', !form),
    );
  }
  let body: MetaResponse;
  try {
    body = (await boundedJson(response)) as MetaResponse;
  } catch {
    throw new MetaFailure(
      Boolean(form),
      providerError(form ? 'PROVIDER_UNCERTAIN' : 'PROVIDER_RECEIPT', !form),
    );
  }
  if (!response.ok || body.error) {
    const code = body.error?.code;
    const rate = response.status === 429 || [4, 17, 32, 613].includes(code ?? -1);
    const auth =
      response.status === 401 || response.status === 403 || [10, 190, 200].includes(code ?? -1);
    const ambiguous =
      Boolean(form) &&
      ((response.status >= 300 && response.status < 400) ||
        response.status >= 500 ||
        response.status === 408 ||
        body.error?.is_transient === true);
    throw new MetaFailure(
      ambiguous,
      providerError(
        ambiguous
          ? 'PROVIDER_UNCERTAIN'
          : rate
            ? 'PROVIDER_RATE_LIMIT'
            : auth
              ? 'PROVIDER_AUTH'
              : form
                ? 'PROVIDER_CONTENT'
                : 'PROVIDER_RECEIPT',
        rate || !form,
      ),
      rate ? (retryAt(response.headers) ?? new Date(Date.now() + 60000).toISOString()) : undefined,
    );
  }
  return body;
}
function requireId(response: MetaResponse): string {
  if (typeof response.id !== 'string' || !/^\d{1,40}(_\d{1,40})?$/.test(response.id))
    throw new MetaFailure(true, providerError('PROVIDER_UNCERTAIN'));
  return response.id;
}
async function checkpoint(target: ResolvedTarget, state: ProviderState): Promise<void> {
  target.providerState = structuredClone(state);
  try {
    await target.checkpoint?.(structuredClone(state));
  } catch {
    throw new MetaFailure(true, providerError('PROVIDER_CHECKPOINT'));
  }
}
function failure(target: ResolvedTarget, error: unknown): ProviderResult {
  const safe =
    error instanceof MetaFailure
      ? error
      : new MetaFailure(true, providerError('PROVIDER_UNCERTAIN'));
  return {
    kind: safe.uncertain ? 'uncertain' : 'rejected',
    channelId: target.channelId,
    error: safe.safe,
    ...(!safe.uncertain && safe.retryAt ? { retryAt: safe.retryAt } : {}),
    ...(target.providerState ? { providerState: target.providerState } : {}),
  };
}
async function facebookPublish(
  connection: DecryptedConnection,
  target: ResolvedTarget,
  remoteId: string,
): Promise<ProviderResult> {
  const token = connection.credentials.pageAccessToken!,
    first = target.assets[0];
  let id: string;
  let state = target.providerState;
  if (state?.publishedId)
    return {
      kind: 'accepted',
      channelId: target.channelId,
      remoteId: 'fb-post:' + state.publishedId,
      providerState: state,
    };
  if (first?.mimeType.startsWith('video/')) {
    id = requireId(
      await metaRequest(remoteId + '/videos', token, {
        file_url: first.url,
        title: target.title ?? '',
        description: target.text,
        published: 'true',
      }),
    );
    return { kind: 'accepted', channelId: target.channelId, remoteId: 'fb-video:' + id };
  }
  if (target.assets.length) {
    state ??= { kind: 'facebook-photos', childIds: [] };
    if (state.kind !== 'facebook-photos' || state.childIds.length > target.assets.length)
      throw new MetaFailure(false, providerError('PROVIDER_CONTENT'));
    for (let index = state.childIds.length; index < target.assets.length; index++) {
      const photo = requireId(
        await metaRequest(remoteId + '/photos', token, {
          url: target.assets[index]!.url,
          published: 'false',
          ...(target.altTexts[index] !== undefined
            ? { alt_text_custom: target.altTexts[index]! }
            : {}),
        }),
      );
      state.childIds.push(photo);
      await checkpoint(target, state);
    }
  }
  id = requireId(
    await metaRequest(remoteId + '/feed', token, {
      message: target.text,
      ...(state
        ? { attached_media: JSON.stringify(state.childIds.map((media_fbid) => ({ media_fbid }))) }
        : {}),
    }),
  );
  if (state) {
    state.publishedId = id;
    target.providerState = state;
    // The response already proves acceptance. Return the ID even if a checkpoint cannot be persisted.
    try {
      await target.checkpoint?.(structuredClone(state));
    } catch {
      console.error({ event: 'provider_checkpoint_failed', provider: 'meta', stage: 'accepted' });
    }
  }
  return {
    kind: 'accepted',
    channelId: target.channelId,
    remoteId: 'fb-post:' + id,
    ...(state ? { providerState: state } : {}),
  };
}
async function instagramStage(
  connection: DecryptedConnection,
  target: ResolvedTarget,
  remoteId: string,
): Promise<ProviderResult> {
  const token = connection.credentials.userAccessToken!,
    first = target.assets[0];
  const state = target.providerState ?? { kind: 'instagram' as const, childIds: [] };
  if (state.kind !== 'instagram' || !first || state.childIds.length > target.assets.length)
    throw new MetaFailure(false, providerError('PROVIDER_CONTENT'));
  if (state.publishedId)
    return {
      kind: 'accepted',
      channelId: target.channelId,
      remoteId: 'ig-media:' + state.publishedId,
      providerState: state,
    };
  if (state.containerId)
    return {
      kind: 'accepted',
      channelId: target.channelId,
      remoteId: 'ig-container:' + state.containerId,
      providerState: state,
    };
  let form: Record<string, string>;
  if (first.mimeType.startsWith('video/'))
    form = {
      media_type: 'REELS',
      video_url: first.url,
      caption: target.text,
      share_to_feed: 'true',
    };
  else if (target.assets.length === 1)
    form = {
      image_url: first.url,
      caption: target.text,
      ...(target.altTexts[0] !== undefined ? { alt_text: target.altTexts[0] } : {}),
    };
  else {
    for (let index = state.childIds.length; index < target.assets.length; index++) {
      const child = requireId(
        await metaRequest(remoteId + '/media', token, {
          image_url: target.assets[index]!.url,
          is_carousel_item: 'true',
          ...(target.altTexts[index] !== undefined ? { alt_text: target.altTexts[index]! } : {}),
        }),
      );
      state.childIds.push(child);
      await checkpoint(target, state);
    }
    form = { media_type: 'CAROUSEL', children: state.childIds.join(','), caption: target.text };
  }
  state.containerId = requireId(await metaRequest(remoteId + '/media', token, form));
  target.providerState = state;
  try {
    await target.checkpoint?.(structuredClone(state));
  } catch {
    console.error({ event: 'provider_checkpoint_failed', provider: 'meta', stage: 'container' });
  }
  return {
    kind: 'accepted',
    channelId: target.channelId,
    remoteId: 'ig-container:' + state.containerId,
    providerState: state,
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
      channels = await remoteChannels(connection, batch, env);
    for (const target of batch) {
      const remoteId = channels.get(target.channelId);
      if (!remoteId || !/^\d{1,40}$/.test(remoteId)) {
        results.push({
          kind: 'rejected',
          channelId: target.channelId,
          error: providerError('PROVIDER_CHANNEL'),
        });
        continue;
      }
      try {
        results.push(
          target.platform === 'facebook'
            ? await facebookPublish(connection, target, remoteId)
            : target.platform === 'instagram'
              ? await instagramStage(connection, target, remoteId)
              : {
                  kind: 'rejected',
                  channelId: target.channelId,
                  error: providerError('PROVIDER_CHANNEL'),
                },
        );
      } catch (error) {
        results.push(failure(target, error));
      }
    }
  }
  return results;
}
export async function continuePublishing(
  connection: DecryptedConnection,
  target: ResolvedTarget,
  env: Env,
): Promise<ProviderResult> {
  const channel = (await remoteChannels(connection, [target], env)).get(target.channelId),
    state = target.providerState;
  if (
    !channel ||
    target.platform !== 'instagram' ||
    state?.kind !== 'instagram' ||
    !state.containerId ||
    !/^\d{1,40}$/.test(state.containerId)
  )
    return {
      kind: 'rejected',
      channelId: target.channelId,
      error: providerError('PROVIDER_CHANNEL'),
    };
  if (state.publishedId)
    return {
      kind: 'accepted',
      channelId: target.channelId,
      remoteId: 'ig-media:' + state.publishedId,
      providerState: state,
    };
  try {
    // The caller must durably claim this continuation before invoking it; reads never publish.
    state.publishedId = requireId(
      await metaRequest(channel + '/media_publish', connection.credentials.userAccessToken!, {
        creation_id: state.containerId,
      }),
    );
    target.providerState = state;
    try {
      await target.checkpoint?.(structuredClone(state));
    } catch {
      console.error({ event: 'provider_checkpoint_failed', provider: 'meta', stage: 'accepted' });
    }
    return {
      kind: 'accepted',
      channelId: target.channelId,
      remoteId: 'ig-media:' + state.publishedId,
      providerState: state,
    };
  } catch (error) {
    return failure(target, error);
  }
}
export async function readReceipts(
  connection: DecryptedConnection,
  remoteIds: string[],
  _env: Env,
): Promise<ProviderReceipt[]> {
  const receipts: ProviderReceipt[] = [];
  for (const remoteId of remoteIds) {
    const match = /^(fb-post|fb-video|ig-container|ig-media):(\d{1,40}(?:_\d{1,40})?)$/.exec(
      remoteId,
    );
    if (!match) {
      receipts.push({ remoteId, state: 'unknown', error: providerError('PROVIDER_RECEIPT') });
      continue;
    }
    const kind = match[1]!,
      id = match[2]!,
      instagram = kind.startsWith('ig-'),
      token = instagram
        ? connection.credentials.userAccessToken!
        : connection.credentials.pageAccessToken!;
    const fields =
      kind === 'ig-container'
        ? 'status_code'
        : kind === 'ig-media'
          ? 'id,timestamp,permalink'
          : kind === 'fb-video'
            ? 'id,status,published,created_time,permalink_url'
            : 'id,is_published,created_time,permalink_url';
    try {
      const post = await metaRequest(id + '?fields=' + fields, token);
      if (kind === 'ig-container') {
        if (post.status_code === 'FINISHED')
          receipts.push({
            remoteId,
            state: 'processing',
            continuation: { kind: 'instagram-publish', containerId: id },
          });
        else if (post.status_code === 'IN_PROGRESS')
          receipts.push({ remoteId, state: 'processing' });
        else if (post.status_code === 'ERROR' || post.status_code === 'EXPIRED')
          receipts.push({ remoteId, state: 'failed', error: providerError('PROVIDER_FAILED') });
        else
          receipts.push({ remoteId, state: 'unknown', error: providerError('PROVIDER_RECEIPT') });
        continue;
      }
      const published =
        post.id === id &&
        (kind === 'ig-media'
          ? Boolean(post.permalink)
          : kind === 'fb-post'
            ? post.is_published === true
            : post.published === true &&
              post.status?.video_status === 'ready' &&
              post.status?.publishing_phase?.status === 'complete');
      const url = publicUrl(instagram ? post.permalink : post.permalink_url),
        at = instant(instagram ? post.timestamp : post.created_time);
      if (published)
        receipts.push({
          remoteId,
          state: 'published',
          ...(url ? { publicUrl: url } : {}),
          ...(at ? { publishedAt: at } : {}),
        });
      else if (
        post.status?.video_status === 'error' ||
        post.status?.publishing_phase?.status === 'error'
      )
        receipts.push({ remoteId, state: 'failed', error: providerError('PROVIDER_FAILED') });
      else receipts.push({ remoteId, state: post.id === id ? 'processing' : 'unknown' });
    } catch (error) {
      const safe =
        error instanceof MetaFailure
          ? error
          : new MetaFailure(false, providerError('PROVIDER_RECEIPT', true));
      receipts.push({
        remoteId,
        state: 'unknown',
        error: safe.safe,
        ...(safe.retryAt ? { retryAt: safe.retryAt } : {}),
      });
    }
  }
  return receipts;
}
