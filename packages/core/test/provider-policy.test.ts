import { expect, test } from 'vitest';
import { CapabilitySnapshotSchema, buildPlan } from '../src';
import { caps, draft, photo, video } from './fixtures';
const now = '2026-10-09T10:00:00Z';
test('buffer_utf16_and_instagram_line_break_metrics_are_accepted_and_crop_whole_graphemes', () => {
  const input = caps();
  const channel = input.channels.find((c) => c.platform === 'instagram')!;
  Object.assign(channel.limits, { textMax: 8, textMetric: 'utf16Instagram' });
  expect(CapabilitySnapshotSchema.safeParse(input).success).toBe(true);
  const plan = buildPlan(
    draft({ text: '😀\n😀😀', assets: [photo()], selections: ['instagram'] }),
    input,
    now,
  );
  expect(plan.targets[0]?.text).toBe('😀\n😀😀');
  Object.assign(channel.limits, { textMax: 7 });
  expect(
    buildPlan(draft({ text: '😀\n😀😀', assets: [photo()], selections: ['instagram'] }), input, now)
      .targets[0]?.text,
  ).toBe('😀\n😀');
});
test('kind_specific_caption_limits_and_image_only_alt_are_enforced', () => {
  const input = caps();
  const channel = input.channels.find((c) => c.platform === 'x')!;
  Object.assign(channel.limits, {
    textMetric: 'utf16',
    textMax: 6,
    textMaxByKind: { video: 4 },
    altKinds: ['image'],
  });
  expect(CapabilitySnapshotSchema.safeParse(input).success).toBe(true);
  const plan = buildPlan(
    draft({ text: '😀😀😀', title: 'Title', assets: [video()], selections: ['x'] }),
    input,
    now,
  );
  expect(plan.targets[0]?.text).toBe('😀😀');
  expect(plan.targets[0]?.altTexts).toEqual([]);
});
test('minimum_video_height_is_included_in_local_recipe', () => {
  const input = caps();
  const channel = input.channels.find((c) => c.platform === 'tiktok')!;
  Object.assign(channel.limits.video!, { minHeight: 360 });
  expect(CapabilitySnapshotSchema.safeParse(input).success).toBe(true);
  const source = { ...video(10_000), height: 200 };
  const plan = buildPlan(
    draft({ title: 'Title', assets: [source], selections: ['tiktok'] }),
    input,
    now,
  );
  expect(plan.mediaRecipes[0]?.minHeight).toBe(360);
});
test('excess_caption_hashtags_use_a_clear_prefix_without_counting_url_fragments', () => {
  const input = caps();
  const channel = input.channels.find((c) => c.platform === 'instagram')!;
  Object.assign(channel.limits, { maxHashtags: 2 });
  expect(CapabilitySnapshotSchema.safeParse(input).success).toBe(true);
  const text = 'https://example.test/#fragment نص #أول #ثان #ثالث نهاية';
  const plan = buildPlan(draft({ text, assets: [photo()], selections: ['instagram'] }), input, now);
  expect(plan.targets[0]?.text).toBe('https://example.test/#fragment نص #أول #ثان');
  expect(plan.notes.find((n) => n.code === 'CAPTION_PREFIX_LIMIT')?.facts.limit).toBe(2);
});
