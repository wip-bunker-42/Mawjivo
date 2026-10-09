import twitterText from 'twitter-text';
import { DraftSchema, CapabilitySnapshotSchema } from './schemas';
import { resolveSchedule } from './time';
import type {
  CapabilitySnapshot,
  Channel,
  ChannelLimits,
  Draft,
  ISOInstant,
  MediaAsset,
  MediaLimits,
  MediaRecipe,
  PostPlan,
  TargetPlan,
} from './contracts';
export const POLICY_VERSION = '2026-10-09.2';
const segmenter = new Intl.Segmenter('ar', { granularity: 'grapheme' });
const names = {
  facebook: 'Facebook',
  instagram: 'Instagram',
  threads: 'Threads',
  x: 'X',
  youtube: 'YouTube',
  tiktok: 'TikTok',
};
type TextMetric = ChannelLimits['textMetric'];
function length(text: string, metric: TextMetric): number {
  if (metric === 'weightedX') return twitterText.parseTweet(text).weightedLength;
  if (metric === 'utf16Instagram') return text.length + (text.match(/\n/g)?.length ?? 0);
  return metric === 'utf16' ? text.length : [...text].length;
}
function truncate(text: string, maximum: number, metric: TextMetric = 'codePoints'): string {
  if (length(text, metric) <= maximum) return text;
  const urls =
    metric === 'weightedX'
      ? new Map(twitterText.extractUrlsWithIndices(text).map((url) => [url.indices[0], url]))
      : new Map();
  let result = '',
    used = 0,
    skipUntil = 0;
  for (const part of segmenter.segment(text)) {
    if (part.index < skipUntil) continue;
    const url = urls.get(part.index);
    const token: string = url ? url.url : part.segment;
    const weight = url ? 23 : length(token, metric);
    if (used + weight > maximum) break;
    result += token;
    used += weight;
    skipUntil = part.index + token.length;
  }
  return result;
}
function makeRecipe(asset: MediaAsset, limits: MediaLimits): MediaRecipe | null {
  const mimeMatches = limits.mimeTypes.includes(asset.mimeType);
  const durationTooLong =
    asset.kind === 'video' &&
    asset.durationMs !== undefined &&
    limits.maxDurationMs !== undefined &&
    asset.durationMs > limits.maxDurationMs;
  const ratio = asset.width && asset.height ? asset.width / asset.height : undefined;
  const badRatio =
    ratio !== undefined &&
    ((limits.minAspectRatio !== undefined && ratio < limits.minAspectRatio) ||
      (limits.maxAspectRatio !== undefined && ratio > limits.maxAspectRatio));
  const badWidth =
    asset.width !== undefined &&
    ((limits.maxWidth !== undefined && asset.width > limits.maxWidth) ||
      (limits.minWidth !== undefined && asset.width < limits.minWidth));
  const badHeight =
    asset.height !== undefined &&
    ((limits.maxHeight !== undefined && asset.height > limits.maxHeight) ||
      (limits.minHeight !== undefined && asset.height < limits.minHeight));
  if (
    mimeMatches &&
    !durationTooLong &&
    !badRatio &&
    !badWidth &&
    !badHeight &&
    asset.bytes <= limits.maxBytes
  )
    return null;
  const outputMimeType = mimeMatches
    ? asset.mimeType
    : limits.mimeTypes.includes(asset.kind === 'image' ? 'image/jpeg' : 'video/mp4')
      ? asset.kind === 'image'
        ? 'image/jpeg'
        : 'video/mp4'
      : limits.mimeTypes[0]!;
  const body: Omit<MediaRecipe, 'id'> = {
    sourceAssetId: asset.id,
    outputMimeType,
    maxBytes: limits.maxBytes,
    ...(durationTooLong ? { maxDurationMs: limits.maxDurationMs } : {}),
    ...(badRatio || badWidth || badHeight
      ? {
          frameMode: 'pad' as const,
          ...(limits.minAspectRatio !== undefined ? { minAspectRatio: limits.minAspectRatio } : {}),
          ...(limits.maxAspectRatio !== undefined ? { maxAspectRatio: limits.maxAspectRatio } : {}),
          ...(limits.maxWidth !== undefined ? { maxWidth: limits.maxWidth } : {}),
          ...(limits.minWidth !== undefined ? { minWidth: limits.minWidth } : {}),
          ...(limits.minHeight !== undefined ? { minHeight: limits.minHeight } : {}),
          ...(limits.maxHeight !== undefined ? { maxHeight: limits.maxHeight } : {}),
        }
      : {}),
    ...(asset.kind === 'image' && outputMimeType === 'image/jpeg' ? { quality: 95 } : {}),
  };
  // Stable reversible identifier: equal recipes share the same local processing/upload job.
  return { ...body, id: 'recipe:' + JSON.stringify(body) };
}
function restrictedPrefix(
  text: string,
  limits: ChannelLimits,
): { text: string; limit?: number; reason?: string } {
  const urls = twitterText.extractUrlsWithIndices(text);
  // The official twitter-text TLD list is older than valid custom/new domains.
  for (const match of text.matchAll(/https?:\/\/[^\s<>"']+/gu)) {
    try {
      new URL(match[0]);
      if (!urls.some((url) => match.index >= url.indices[0] && match.index < url.indices[1]))
        urls.push({ url: match[0], indices: [match.index, match.index + match[0].length] });
    } catch {
      /* not a valid URL */
    }
  }
  urls.sort((a, b) => a.indices[0] - b.indices[0]);
  const outsideUrl = (index: number) =>
    !urls.some((url) => index >= url.indices[0] && index < url.indices[1]);
  const groups = [
    {
      maximum: limits.maxHashtags,
      reason: 'الوسوم',
      items: twitterText
        .extractHashtagsWithIndices(text)
        .filter((item) => outsideUrl(item.indices[0])),
    },
    {
      maximum: limits.maxMentions,
      reason: 'الإشارات',
      items: twitterText
        .extractMentionsWithIndices(text)
        .filter((item) => outsideUrl(item.indices[0])),
    },
    { maximum: limits.maxUrls, reason: 'الروابط', items: urls },
  ];
  const cuts = groups
    .filter((group) => group.maximum !== undefined && group.items.length > group.maximum)
    .map((group) => ({
      at: group.items[group.maximum!]!.indices[0],
      limit: group.maximum!,
      reason: group.reason,
    }))
    .sort((a, b) => a.at - b.at);
  const cut = cuts[0];
  return cut
    ? { text: text.slice(0, cut.at).trimEnd(), limit: cut.limit, reason: cut.reason }
    : { text };
}
export function buildPlan(input: Draft, inputCaps: CapabilitySnapshot, now: ISOInstant): PostPlan {
  const draft = DraftSchema.parse(input),
    caps = CapabilitySnapshotSchema.parse(inputCaps);
  const videos = draft.assets.filter((asset) => asset.kind === 'video');
  if (videos.length && (videos.length !== 1 || draft.assets.length !== 1))
    throw new Error('MIXED_MEDIA');
  if (videos.length && !draft.title.trim()) throw new Error('VIDEO_TITLE_REQUIRED');
  if (
    !draft.assets.length &&
    !draft.text.trim() &&
    !Object.values(draft.overrides).some(
      (o) => o?.text?.trim() || o?.threadParts?.some((p) => p.trim()),
    )
  )
    throw new Error('EMPTY_POST');
  let dueAt: ISOInstant | null = null;
  if (draft.scheduleLocal !== null) {
    const schedule = resolveSchedule(
      draft.scheduleLocal,
      draft.timeZone,
      draft.scheduleOffset ?? undefined,
    );
    if (schedule.kind !== 'instant')
      throw new Error(schedule.kind === 'ambiguous' ? 'SCHEDULE_AMBIGUOUS' : 'SCHEDULE_INVALID');
    dueAt = schedule.instant;
    const wait = Date.parse(dueAt) - Date.parse(now);
    if (wait <= 0) throw new Error('SCHEDULE_IN_PAST');
    if (wait > 365 * 24 * 60 * 60 * 1000) throw new Error('SCHEDULE_TOO_FAR');
  }
  const plan: PostPlan = {
    draftId: draft.id,
    workspaceId: draft.workspaceId,
    workspaceVersion: draft.workspaceVersion,
    timeZone: draft.timeZone,
    revision: draft.revision,
    policyVersion: POLICY_VERSION,
    capabilityVersion: caps.version,
    targets: [],
    excluded: [],
    mediaRecipes: [],
    dueAt,
    notes: [],
  };
  const recipes = new Map<string, MediaRecipe>();
  const note = (
    channel: Channel,
    code: string,
    messageAr: string,
    facts: Record<string, string | number>,
  ) =>
    plan.notes.push({
      channelId: channel.id,
      code,
      messageAr: `${names[channel.platform]}: ${messageAr}`,
      facts,
    });
  const exclude = (channel: Channel, code: string, messageAr: string) =>
    plan.excluded.push({ channelId: channel.id, platform: channel.platform, code, messageAr });
  for (const channelId of new Set(draft.selections)) {
    const channel = caps.channels.find((c) => c.id === channelId);
    if (!channel) throw new Error('CHANNEL_NOT_FOUND');
    if (!channel.ready) {
      exclude(channel, 'CHANNEL_NOT_READY', 'الحساب يحتاج إصلاح الربط.');
      continue;
    }
    const kind = draft.assets[0]?.kind ?? 'text';
    if (!channel.limits.supportedKinds.includes(kind)) {
      exclude(
        channel,
        'CONTENT_UNSUPPORTED',
        kind === 'text'
          ? 'لا يدعم منشورًا نصيًا مستقلًا.'
          : kind === 'image'
            ? 'لا يدعم الصور عبر هذا الربط.'
            : 'لا يدعم الفيديو عبر هذا الربط.',
      );
      continue;
    }
    const override = draft.overrides[channel.platform];
    const raw = override?.threadParts?.[0] ?? override?.text ?? draft.text,
      metric = channel.limits.textMetric,
      textMax = channel.limits.textMaxByKind?.[kind] ?? channel.limits.textMax;
    const target: TargetPlan = {
      channelId: channel.id,
      connectionId: channel.connectionId,
      platform: channel.platform,
      provider: channel.provider,
      text: truncate(raw, textMax, metric),
      threadParts: [],
      assets: [],
      altTexts: [],
    };
    if (videos.length)
      target.title =
        channel.limits.titleMax === undefined
          ? draft.title
          : truncate(
              draft.title,
              channel.limits.titleMax,
              metric === 'weightedX' ? 'utf16' : metric,
            );
    if (target.title !== undefined && target.title !== draft.title)
      note(channel, 'TITLE_TRUNCATED', 'قُص العنوان ليناسب الحد.', {
        original: [...draft.title].length,
        limit: channel.limits.titleMax!,
      });
    if (raw !== target.text)
      note(
        channel,
        'TEXT_TRUNCATED',
        `أول ${length(target.text, metric)} من ${length(raw, metric)} حرف.`,
        {
          original: length(raw, metric),
          sent: length(target.text, metric),
          limit: textMax,
        },
      );
    const parts = override?.threadParts;
    if (parts?.length) {
      if (channel.limits.threadParts === undefined) {
        exclude(channel, 'THREADS_UNVERIFIED', 'لم يُتحقق من دعم السلاسل وحدود الحساب.');
        continue;
      }
      if (parts.some((p) => !p.trim())) throw new Error('EMPTY_THREAD_PART');
      target.threadParts = parts
        .slice(0, channel.limits.threadParts)
        .map((part) => truncate(part, textMax, metric));
      target.text = target.threadParts[0]!;
      if (parts.length > target.threadParts.length)
        note(
          channel,
          'THREAD_PARTS_LIMIT',
          `${target.threadParts.length} أجزاء؛ استُبعد ${parts.length - target.threadParts.length}.`,
          { sent: target.threadParts.length, omitted: parts.length - target.threadParts.length },
        );
      target.threadParts.forEach((part, index) => {
        if (part !== parts[index])
          note(channel, 'THREAD_TEXT_TRUNCATED', `قُص الجزء ${index + 1} إلى الحد المسموح.`, {
            part: index + 1,
            limit: channel.limits.textMax,
          });
      });
    }
    let restriction: { limit?: number; reason?: string } | undefined;
    const restrict = (value: string) => {
      const result = restrictedPrefix(value, channel.limits);
      if (result.reason) restriction = result;
      return result.text;
    };
    target.text = restrict(target.text);
    target.threadParts = target.threadParts.map(restrict);
    if (restriction)
      note(
        channel,
        'CAPTION_PREFIX_LIMIT',
        `قُص النص عند الحد الزائد من ${restriction.reason}؛ الحد ${restriction.limit}.`,
        { limit: restriction.limit!, reason: restriction.reason! },
      );
    const limits =
      kind === 'image' ? channel.limits.image : kind === 'video' ? channel.limits.video : undefined;
    if (kind !== 'text' && !limits) {
      exclude(channel, 'MEDIA_LIMITS_UNVERIFIED', 'حدود الوسائط غير جاهزة.');
      continue;
    }
    if (
      videos.length &&
      (videos[0]!.durationMs === undefined ||
        videos[0]!.width === undefined ||
        videos[0]!.height === undefined)
    )
      throw new Error('MEDIA_PROBE_REQUIRED');
    if (
      videos.length &&
      limits?.minDurationMs !== undefined &&
      videos[0]!.durationMs! < limits.minDurationMs
    ) {
      exclude(channel, 'VIDEO_TOO_SHORT', 'الفيديو أقصر من الحد الأدنى.');
      continue;
    }
    if (limits) {
      const selected = draft.assets.slice(0, limits.maxCount);
      if (selected.length < draft.assets.length)
        note(
          channel,
          'IMAGES_LIMIT',
          `أول ${selected.length} صور؛ استُبعد ${draft.assets.length - selected.length}.`,
          { sent: selected.length, omitted: draft.assets.length - selected.length },
        );
      selected.forEach((asset, index) => {
        const recipe = makeRecipe(asset, limits);
        target.assets.push({ sourceAssetId: asset.id, recipeId: recipe?.id ?? null });
        if (recipe) {
          recipes.set(recipe.id, recipe);
          if (recipe.outputMimeType !== asset.mimeType)
            note(channel, 'MEDIA_CONVERTED', 'نسخة محلية بصيغة متوافقة.', {
              sourceAssetId: asset.id,
              from: asset.mimeType,
              to: recipe.outputMimeType,
            });
          if (recipe.maxDurationMs !== undefined)
            note(
              channel,
              'VIDEO_TRUNCATED',
              `أول ${recipe.maxDurationMs / 1000} ثانية من ${asset.durationMs! / 1000}.`,
              { originalMs: asset.durationMs!, sentMs: recipe.maxDurationMs },
            );
          if (recipe.frameMode)
            note(channel, 'FRAME_PADDED', 'تعديل الإطار بهوامش لحفظ المشهد.', {
              sourceAssetId: asset.id,
            });
          if (recipe.maxBytes !== undefined && asset.bytes > recipe.maxBytes)
            note(channel, 'MEDIA_COMPRESSED', 'تقليل الحجم محليًا ليناسب الحد.', {
              originalBytes: asset.bytes,
              maxBytes: recipe.maxBytes,
            });
        }
        if (
          channel.limits.altMax !== undefined &&
          (channel.limits.altKinds === undefined || channel.limits.altKinds.includes(asset.kind))
        ) {
          const alt = override?.altTexts?.[index] ?? raw;
          target.altTexts.push(
            truncate(alt, channel.limits.altMax, metric === 'weightedX' ? 'utf16' : metric),
          );
          if (target.altTexts[index] !== alt)
            note(channel, 'ALT_TRUNCATED', 'قُص النص البديل ليناسب الحد.', {
              sourceAssetId: asset.id,
              limit: channel.limits.altMax,
            });
        }
      });
    }
    if (kind === 'text' && !target.text.trim() && !target.threadParts.length) {
      exclude(channel, 'EMPTY_TARGET', 'النص الخاص بهذه المنصة فارغ.');
      continue;
    }
    plan.targets.push(target);
  }
  plan.mediaRecipes = [...recipes.values()];
  return plan;
}
