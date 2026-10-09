export const platforms = ['facebook', 'instagram', 'threads', 'x', 'youtube', 'tiktok'] as const;
export type Platform = (typeof platforms)[number];
export type Provider = 'meta' | 'buffer';
export type ISOInstant = string;
export type MediaKind = 'image' | 'video';
export type ContentKind = 'text' | MediaKind;
export type PublicationState =
  | 'draft'
  | 'preparing'
  | 'scheduled'
  | 'ready'
  | 'sending'
  | 'accepted'
  | 'published'
  | 'failed'
  | 'cancelled'
  | 'uncertain';
export interface Workspace {
  id: string;
  name: string;
  timeZone: string;
  version: number;
  defaultPlatforms: Platform[];
  serviceProfileId: string;
  preferredChannels?: Partial<Record<Platform, string>> | undefined;
}
export type WorkspaceInput = Pick<
  Workspace,
  'name' | 'timeZone' | 'defaultPlatforms' | 'serviceProfileId' | 'preferredChannels'
>;
export interface ConnectionInput {
  provider: Provider;
  label: string;
  credentials: Record<string, string>;
}
export interface ConnectionSummary {
  id: string;
  provider: Provider;
  label: string;
  version: number;
  readiness?: ReadinessItem[] | undefined;
}
export interface MediaAsset {
  id: string;
  originalName: string;
  kind: MediaKind;
  bytes: number;
  mimeType: string;
  sha256?: string | undefined;
  width?: number | undefined;
  height?: number | undefined;
  durationMs?: number | undefined;
  derivedFrom?: string | undefined;
}
export type UploadManifest = Pick<
  MediaAsset,
  'originalName' | 'kind' | 'bytes' | 'mimeType' | 'width' | 'height' | 'durationMs'
> & { sourceAssetId: string; recipeId: string | null };
export interface UploadedPart {
  partNumber: number;
  etag: string;
}
export interface UploadTicket {
  assetId: string;
  multipartId: string | null;
  expiresAt: string;
  parts: { partNumber: number; url: string }[];
}
export interface PlatformOverride {
  text?: string | undefined;
  altTexts?: string[] | undefined;
  threadParts?: string[] | undefined;
}
export interface Draft {
  id: string;
  workspaceId: string;
  workspaceVersion: number;
  timeZone: string;
  revision: number;
  text: string;
  title: string;
  assets: MediaAsset[];
  selections: string[];
  overrides: Partial<Record<Platform, PlatformOverride | undefined>>;
  scheduleLocal: string | null;
  scheduleOffset: string | null;
  createdAt: ISOInstant;
}
export interface MediaLimits {
  mimeTypes: string[];
  maxBytes: number;
  maxCount: number;
  minDurationMs?: number | undefined;
  maxDurationMs?: number | undefined;
  minWidth?: number | undefined;
  maxWidth?: number | undefined;
  minHeight?: number | undefined;
  maxHeight?: number | undefined;
  minAspectRatio?: number | undefined;
  maxAspectRatio?: number | undefined;
}
export interface ChannelLimits {
  supportedKinds: ContentKind[];
  textMax: number;
  titleMax?: number | undefined;
  textMetric: 'codePoints' | 'weightedX' | 'utf16' | 'utf16Instagram';
  textMaxByKind?: Partial<Record<ContentKind, number>> | undefined;
  maxHashtags?: number | undefined;
  maxMentions?: number | undefined;
  maxUrls?: number | undefined;
  image?: MediaLimits | undefined;
  video?: MediaLimits | undefined;
  altMax?: number | undefined;
  altKinds?: MediaKind[] | undefined;
  threadParts?: number | undefined;
  scheduledThreadsPerChannel?: number | undefined;
  source: string;
  verifiedAt: ISOInstant;
}
export interface Channel {
  id: string;
  connectionId: string;
  platform: Platform;
  provider: Provider;
  ready: boolean;
  displayName?: string | undefined;
  remoteId?: string | undefined;
  readinessMessageAr?: string | undefined;
  limits: ChannelLimits;
}
export interface CapabilitySnapshot {
  version: string;
  fetchedAt: ISOInstant;
  channels: Channel[];
}
export interface AssetUse {
  sourceAssetId: string;
  recipeId: string | null;
}
export interface MediaRecipe {
  id: string;
  sourceAssetId: string;
  outputMimeType: string;
  maxDurationMs?: number | undefined;
  maxBytes?: number | undefined;
  minWidth?: number | undefined;
  maxWidth?: number | undefined;
  minHeight?: number | undefined;
  maxHeight?: number | undefined;
  minAspectRatio?: number | undefined;
  maxAspectRatio?: number | undefined;
  frameMode?: 'pad' | undefined;
  quality?: number | undefined;
}
export interface TargetPlan {
  channelId: string;
  connectionId: string;
  platform: Platform;
  provider: Provider;
  text: string;
  title?: string | undefined;
  threadParts: string[];
  assets: AssetUse[];
  altTexts: string[];
}
export interface PlanNote {
  code: string;
  channelId: string;
  messageAr: string;
  facts: Record<string, number | string>;
}
export interface ExcludedTarget {
  channelId: string;
  platform: Platform;
  code: string;
  messageAr: string;
}
export interface PostPlan {
  draftId: string;
  workspaceId: string;
  workspaceVersion: number;
  timeZone: string;
  revision: number;
  policyVersion: string;
  capabilityVersion: string;
  targets: TargetPlan[];
  excluded: ExcludedTarget[];
  mediaRecipes: MediaRecipe[];
  dueAt: ISOInstant | null;
  notes: PlanNote[];
}
export interface PreparedAsset {
  sourceAssetId: string;
  recipeId: string | null;
  assetId: string;
  sha256: string;
}
export interface Submission {
  plan: PostPlan;
  planHash: string;
  preparedAssets: PreparedAsset[];
}
export interface TargetReceipt {
  channelId: string;
  platform: Platform;
  state: PublicationState;
  remoteId?: string;
  publicUrl?: string;
  error?: AppError;
  parts?: { partIndex: number; state: PublicationState; remoteId?: string }[];
}
export interface PublicationReceipt {
  postId: string;
  workspaceId: string;
  revision: number;
  state: PublicationState;
  dueAt: ISOInstant | null;
  targets: TargetReceipt[];
}
export interface AppError {
  code: string;
  messageAr: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}
export interface ReadinessItem {
  code: string;
  state: 'ready' | 'needsAction' | 'failed';
  messageAr: string;
  action?: string;
}
export type ScheduleResolution =
  | { kind: 'instant'; instant: ISOInstant; offset: string }
  | { kind: 'ambiguous'; offsets: [string, string] }
  | { kind: 'invalid'; messageAr: string };
