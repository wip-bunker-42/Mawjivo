import { z } from 'zod';
import { platforms } from './contracts';
import type { Draft, PostPlan, Submission, Workspace, CapabilitySnapshot } from './contracts';
const id = z.string().min(1).max(160);
const recipeId = z.string().min(1).max(2048);
const natural = z.number().int().nonnegative();
const positive = z.number().int().positive();
const instant = z.iso.datetime();
export const PlatformSchema = z.enum(platforms);
export const ProviderSchema = z.enum(['meta', 'buffer']);
export const MediaAssetSchema = z.strictObject({
  id,
  originalName: z.string().min(1).max(1024),
  kind: z.enum(['image', 'video']),
  bytes: positive,
  mimeType: z.string().min(1),
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  width: positive.optional(),
  height: positive.optional(),
  durationMs: positive.optional(),
  derivedFrom: id.optional(),
});
const override = z.strictObject({
  text: z.string().max(100_000).optional(),
  altTexts: z.array(z.string().max(100_000)).optional(),
  threadParts: z.array(z.string().max(100_000)).optional(),
});
const timeZone = z
  .string()
  .min(1)
  .max(100)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat('ar', { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, 'INVALID_TIME_ZONE');
export const DraftSchema: z.ZodType<Draft> = z.strictObject({
  id,
  workspaceId: id,
  workspaceVersion: positive,
  timeZone,
  revision: positive,
  text: z.string().max(100_000),
  title: z.string().max(10_000),
  assets: z.array(MediaAssetSchema).max(1000),
  selections: z.array(id).max(100),
  overrides: z.partialRecord(PlatformSchema, override),
  scheduleLocal: z.string().max(100).nullable(),
  scheduleOffset: z.string().max(10).nullable(),
  createdAt: instant,
});
export const WorkspaceSchema: z.ZodType<Workspace> = z.strictObject({
  id,
  name: z.string().trim().min(1).max(120),
  timeZone,
  version: positive,
  defaultPlatforms: z.array(PlatformSchema),
  serviceProfileId: id,
  preferredChannels: z.partialRecord(PlatformSchema, id).optional(),
});
export const ConnectionInputSchema = z.strictObject({
  provider: ProviderSchema,
  label: z.string().trim().min(1).max(120),
  credentials: z.record(z.string().min(1).max(80), z.string().trim().min(1).max(4096)),
});
const mediaLimits = z.strictObject({
  mimeTypes: z.array(z.string().min(1)).min(1),
  maxBytes: positive,
  maxCount: positive,
  minDurationMs: positive.optional(),
  maxDurationMs: positive.optional(),
  minWidth: positive.optional(),
  maxWidth: positive.optional(),
  minHeight: positive.optional(),
  maxHeight: positive.optional(),
  minAspectRatio: z.number().positive().optional(),
  maxAspectRatio: z.number().positive().optional(),
});
const channelLimits = z.strictObject({
  supportedKinds: z.array(z.enum(['text', 'image', 'video'])),
  textMax: positive,
  titleMax: positive.optional(),
  textMetric: z.enum(['codePoints', 'weightedX', 'utf16', 'utf16Instagram']),
  textMaxByKind: z.partialRecord(z.enum(['text', 'image', 'video']), positive).optional(),
  maxHashtags: natural.optional(),
  maxMentions: natural.optional(),
  maxUrls: natural.optional(),
  image: mediaLimits.optional(),
  video: mediaLimits.optional(),
  altMax: positive.optional(),
  altKinds: z.array(z.enum(['image', 'video'])).optional(),
  threadParts: positive.optional(),
  scheduledThreadsPerChannel: natural.optional(),
  source: z.url(),
  verifiedAt: instant,
});
export const CapabilitySnapshotSchema: z.ZodType<CapabilitySnapshot> = z.strictObject({
  version: id,
  fetchedAt: instant,
  channels: z.array(
    z.strictObject({
      id,
      connectionId: id,
      platform: PlatformSchema,
      provider: ProviderSchema,
      ready: z.boolean(),
      displayName: z.string().max(240).optional(),
      remoteId: id.optional(),
      readinessMessageAr: z.string().max(1000).optional(),
      limits: channelLimits,
    }),
  ),
});
const assetUse = z.strictObject({ sourceAssetId: id, recipeId: recipeId.nullable() });
const target = z.strictObject({
  channelId: id,
  connectionId: id,
  platform: PlatformSchema,
  provider: ProviderSchema,
  text: z.string(),
  title: z.string().optional(),
  threadParts: z.array(z.string()),
  assets: z.array(assetUse),
  altTexts: z.array(z.string()),
});
const recipe = z.strictObject({
  id: recipeId,
  sourceAssetId: id,
  outputMimeType: z.string().min(1),
  maxDurationMs: positive.optional(),
  maxBytes: positive.optional(),
  minWidth: positive.optional(),
  maxWidth: positive.optional(),
  minHeight: positive.optional(),
  maxHeight: positive.optional(),
  minAspectRatio: z.number().positive().optional(),
  maxAspectRatio: z.number().positive().optional(),
  frameMode: z.literal('pad').optional(),
  quality: z.number().int().min(1).max(100).optional(),
});
export const PostPlanSchema: z.ZodType<PostPlan> = z.strictObject({
  draftId: id,
  workspaceId: id,
  workspaceVersion: positive,
  timeZone,
  revision: positive,
  policyVersion: id,
  capabilityVersion: id,
  targets: z.array(target),
  excluded: z.array(
    z.strictObject({ channelId: id, platform: PlatformSchema, code: id, messageAr: z.string() }),
  ),
  mediaRecipes: z.array(recipe),
  dueAt: instant.nullable(),
  notes: z.array(
    z.strictObject({
      code: id,
      channelId: id,
      messageAr: z.string(),
      facts: z.record(z.string(), z.union([z.string(), z.number().finite()])),
    }),
  ),
});
export const SubmissionSchema: z.ZodType<Submission> = z.strictObject({
  plan: PostPlanSchema,
  planHash: z.string().regex(/^[a-f0-9]{64}$/),
  preparedAssets: z.array(
    z.strictObject({
      sourceAssetId: id,
      recipeId: recipeId.nullable(),
      assetId: id,
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
    }),
  ),
});
