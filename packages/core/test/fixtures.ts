import fixture from './contract-fixture.json';
import type {
  CapabilitySnapshot,
  Draft,
  MediaAsset,
  MediaLimits,
  Platform,
} from '../src/contracts';
import { DraftSchema } from '../src/schemas';
export function draft(overrides: Partial<Draft> = {}): Draft {
  return {
    ...DraftSchema.parse(fixture),
    text: 'منشور عربي',
    title: '',
    assets: [],
    overrides: { youtube: { youtubeCategoryId: '25' } },
    ...overrides,
  };
}
export function video(durationMs = 300_000): MediaAsset {
  return {
    id: 'video-1',
    originalName: 'الأصل.mp4',
    kind: 'video',
    bytes: 10_000_000,
    mimeType: 'video/mp4',
    width: 1920,
    height: 1080,
    durationMs,
  };
}
export function photo(index = 1): MediaAsset {
  return {
    id: `photo-${index}`,
    originalName: `صورة-${index}.png`,
    kind: 'image',
    bytes: 100_000,
    mimeType: 'image/png',
    width: 1024,
    height: 768,
  };
}
const image: MediaLimits = {
  mimeTypes: ['image/png', 'image/jpeg'],
  maxBytes: 20_000_000,
  maxCount: 10,
};
export function caps(): CapabilitySnapshot {
  return {
    version: 'caps-1',
    fetchedAt: '2026-10-09T09:00:00Z',
    channels: (['facebook', 'instagram', 'threads', 'x', 'youtube', 'tiktok'] as Platform[]).map(
      (platform) => ({
        id: platform,
        connectionId: platform === 'facebook' || platform === 'instagram' ? 'meta' : 'buffer-1',
        platform,
        provider: platform === 'facebook' || platform === 'instagram' ? 'meta' : 'buffer',
        ready: true,
        limits: {
          supportedKinds:
            platform === 'youtube'
              ? ['video']
              : platform === 'instagram' || platform === 'tiktok'
                ? ['image', 'video']
                : ['text', 'image', 'video'],
          textMax: platform === 'x' ? 280 : platform === 'threads' ? 500 : 2200,
          textMetric: platform === 'x' ? 'weightedX' : 'codePoints',
          titleMax: 100,
          image: {
            ...image,
            maxCount: platform === 'x' ? 4 : 10,
            mimeTypes: platform === 'instagram' ? ['image/jpeg'] : image.mimeTypes,
          },
          video: {
            mimeTypes: ['video/mp4'],
            maxBytes: 1_000_000_000,
            maxCount: 1,
            minDurationMs: 3000,
            maxDurationMs: platform === 'x' ? 140_000 : platform === 'youtube' ? 180_000 : 600_000,
            ...(platform === 'youtube' ? { minAspectRatio: 0.5625, maxAspectRatio: 1 } : {}),
          },
          ...(platform !== 'youtube' && platform !== 'tiktok' ? { altMax: 1000 } : {}),
          ...(platform === 'x' || platform === 'threads' ? { threadParts: 2 } : {}),
          source: 'https://example.test/verified-fixture',
          verifiedAt: '2026-10-09T09:00:00Z',
        },
      }),
    ),
  };
}
