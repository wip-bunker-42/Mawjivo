import { describe, expect, test } from 'vitest';
import twitterText from 'twitter-text';
import { buildPlan } from '../src/policy';
import { hashPlan } from '../src/plan-hash';
import { DraftSchema, PostPlanSchema } from '../src/schemas';
import { caps, draft, photo, video } from './fixtures';
const now = '2026-10-09T10:00:00Z';
describe('publication plans', () => {
  test('the_reviewed_video_filename_uses_the_full_shared_title_before_platform_truncation', () => {
    const title = 'ع'.repeat(120),
      capabilities = caps();
    const plan = buildPlan(
      draft({ title, assets: [video(10000)], selections: ['youtube', 'x'] }),
      capabilities,
      now,
    );
    expect(plan.targets.find((target) => target.platform === 'youtube')!.title).toHaveLength(100);
    for (const target of plan.targets)
      expect(target.assets[0]).toHaveProperty('sentName', title + '.mp4');
    expect(PostPlanSchema.safeParse(plan).success).toBe(true);
    const withoutYoutube = buildPlan(
      draft({ title, assets: [video(10000)], selections: ['x'] }),
      capabilities,
      now,
    );
    expect(withoutYoutube.targets[0]!.assets[0]).toHaveProperty('sentName', title + '.mp4');
  });
  test('gif_to_jpeg_reports_first_frame_before_confirmation', () => {
    const source = { ...photo(), mimeType: 'image/gif' };
    const plan = buildPlan(draft({ assets: [source], selections: ['instagram'] }), caps(), now);
    expect(
      plan.notes.some(
        (n) => n.code === 'ANIMATION_FIRST_FRAME' && n.facts.sourceAssetId === source.id,
      ),
    ).toBe(true);
  });
  test('text_only_targets_three_supported_platforms', () => {
    const plan = buildPlan(draft(), caps(), now);
    expect(plan.targets.map((t) => t.platform).sort()).toEqual(['facebook', 'threads', 'x']);
    expect(plan.excluded).toHaveLength(3);
  });
  test('x_truncates_weighted_text_and_140000ms_video', () => {
    const plan = buildPlan(
      draft({ text: '👩🏽‍💻'.repeat(200), title: 'عنوان', assets: [video()] }),
      caps(),
      now,
    );
    const target = plan.targets.find((t) => t.platform === 'x')!;
    expect(twitterText.parseTweet(target.text).weightedLength).toBeLessThanOrEqual(280);
    expect(target.text).toBe('👩🏽‍💻'.repeat(140));
    expect(plan.mediaRecipes.find((r) => r.id === target.assets[0]?.recipeId)?.maxDurationMs).toBe(
      140_000,
    );
    expect(plan.notes.some((n) => n.code === 'TEXT_TRUNCATED' && n.channelId === 'x')).toBe(true);
  });
  test('youtube_shorts_caps_180000ms_and_pads_landscape', () => {
    const plan = buildPlan(draft({ title: 'عنوان', assets: [video()] }), caps(), now);
    const target = plan.targets.find((t) => t.platform === 'youtube')!;
    const recipe = plan.mediaRecipes.find((r) => r.id === target.assets[0]?.recipeId)!;
    expect(recipe.maxDurationMs).toBe(180_000);
    expect(recipe.frameMode).toBe('pad');
  });
  test('x_uses_first_four_images', () => {
    const plan = buildPlan(draft({ assets: [1, 2, 3, 4, 5].map(photo) }), caps(), now);
    expect(
      plan.targets.find((t) => t.platform === 'x')?.assets.map((a) => a.sourceAssetId),
    ).toEqual(['photo-1', 'photo-2', 'photo-3', 'photo-4']);
    expect(plan.notes.some((n) => n.code === 'IMAGES_LIMIT' && n.facts.omitted === 1)).toBe(true);
  });
  test('instagram_conversion_reuses_a_single_recipe_for_matching_channels', () => {
    const capabilities = caps();
    capabilities.channels.push({
      ...capabilities.channels.find((c) => c.platform === 'instagram')!,
      id: 'instagram-2',
    });
    const plan = buildPlan(
      draft({ assets: [photo()], selections: ['instagram', 'instagram-2'] }),
      capabilities,
      now,
    );
    expect(plan.mediaRecipes).toHaveLength(1);
    expect(plan.mediaRecipes[0]?.outputMimeType).toBe('image/jpeg');
    expect(plan.targets[0]?.assets).toEqual(plan.targets[1]?.assets);
  });
  test('caption_alt_respects_provider_support_and_override', () => {
    const plan = buildPlan(
      draft({
        text: 'أ'.repeat(1200),
        assets: [photo()],
        overrides: { x: { altTexts: ['بديل مخصص'] } },
      }),
      caps(),
      now,
    );
    expect(plan.targets.find((t) => t.platform === 'x')?.altTexts).toEqual(['بديل مخصص']);
    expect(plan.targets.find((t) => t.platform === 'instagram')?.altTexts[0]).toHaveLength(1000);
    expect(plan.targets.find((t) => t.platform === 'tiktok')?.altTexts).toEqual([]);
  });
  test('threads_excess_is_reported_not_detached', () => {
    const plan = buildPlan(
      draft({ overrides: { threads: { threadParts: ['أول', 'ثان', 'ثالث'] } } }),
      caps(),
      now,
    );
    expect(plan.targets.filter((t) => t.platform === 'threads')).toHaveLength(1);
    expect(plan.targets.find((t) => t.platform === 'threads')?.threadParts).toEqual(['أول', 'ثان']);
    expect(plan.notes.find((n) => n.code === 'THREAD_PARTS_LIMIT')?.facts.omitted).toBe(1);
  });
  test('unverified_threads_are_excluded_instead_of_silently_split', () => {
    const capabilities = caps();
    delete capabilities.channels.find((c) => c.platform === 'threads')!.limits.threadParts;
    const plan = buildPlan(
      draft({ overrides: { threads: { threadParts: ['أول', 'ثان'] } } }),
      capabilities,
      now,
    );
    expect(
      plan.excluded.some((t) => t.platform === 'threads' && t.code === 'THREADS_UNVERIFIED'),
    ).toBe(true);
  });
  test('video_title_is_required_when_youtube_is_excluded', () => {
    expect(() => buildPlan(draft({ assets: [video()], selections: ['x'] }), caps(), now)).toThrow(
      'VIDEO_TITLE_REQUIRED',
    );
  });
  test('mixed_media_and_empty_posts_are_rejected', () => {
    expect(() =>
      buildPlan(draft({ title: 'عنوان', assets: [photo(), video()] }), caps(), now),
    ).toThrow('MIXED_MEDIA');
    expect(() => buildPlan(draft({ text: '   ' }), caps(), now)).toThrow('EMPTY_POST');
  });
  test('provider_and_workspace_versions_are_bound_to_confirmation', async () => {
    const original = buildPlan(draft(), caps(), now);
    expect(await hashPlan({ ...original, workspaceVersion: 2 })).not.toBe(await hashPlan(original));
    expect(await hashPlan({ ...original, capabilityVersion: 'caps-2' })).not.toBe(
      await hashPlan(original),
    );
  });
  test('changed_text_changes_plan_hash_but_object_key_order_does_not', async () => {
    const original = buildPlan(draft(), caps(), now);
    const edited = buildPlan(draft({ text: 'محتوى آخر' }), caps(), now);
    expect(await hashPlan(edited)).not.toBe(await hashPlan(original));
    expect(
      await hashPlan({
        ...original,
        targets: original.targets.map(
          (t) => Object.fromEntries(Object.entries(t).reverse()) as typeof t,
        ),
      }),
    ).toBe(await hashPlan(original));
  });
  test('x_preserves_urls_and_graphemes_while_truncating', () => {
    const text = 'ن'.repeat(250) + ' https://example.com/' + 'a'.repeat(100) + ' 👩🏽‍💻'.repeat(30);
    const plan = buildPlan(draft({ text }), caps(), now);
    const x = plan.targets.find((t) => t.platform === 'x')!;
    expect(x.text).toContain('https://example.com/' + 'a'.repeat(100));
    expect(twitterText.parseTweet(x.text).weightedLength).toBeLessThanOrEqual(280);
    expect(x.text.endsWith('\u200d')).toBe(false);
  });
  test('schema_rejects_invalid_sizes_and_unknown_fields', () => {
    expect(DraftSchema.safeParse({ ...draft(), assets: [{ ...photo(), bytes: -1 }] }).success).toBe(
      false,
    );
    expect(DraftSchema.safeParse({ ...draft(), unexpected: true }).success).toBe(false);
  });
  test('transformation_plan_can_cross_the_validated_json_boundary', () => {
    const plan = buildPlan(
      draft({ title: 'عنوان', assets: [{ ...video(), id: 'v'.repeat(150) }] }),
      caps(),
      now,
    );
    expect(PostPlanSchema.safeParse(JSON.parse(JSON.stringify(plan))).success).toBe(true);
  });
  test('conversion_carries_output_size_limit_even_when_source_is_small', () => {
    const plan = buildPlan(draft({ assets: [photo()], selections: ['instagram'] }), caps(), now);
    expect(plan.mediaRecipes[0]?.maxBytes).toBe(20_000_000);
    expect(plan.notes.some((n) => n.code === 'MEDIA_COMPRESSED')).toBe(false);
  });
});
test('local_clipping_of_a_supported_mov_requests_the_bundled_mp4_encoder', () => {
  const capabilities = caps();
  capabilities.channels
    .find((c) => c.platform === 'x')!
    .limits.video!.mimeTypes.push('video/quicktime');
  const plan = buildPlan(
    draft({
      title: 'عنوان',
      assets: [{ ...video(), mimeType: 'video/quicktime', originalName: 'الأصل.mov' }],
      selections: ['x'],
    }),
    capabilities,
    now,
  );
  expect(plan.mediaRecipes[0]?.outputMimeType).toBe('video/mp4');
});

test.each(['image/webp', 'image/gif'])(
  'processing %s selects an available image encoder and explains the conversion',
  (mimeType) => {
    const capabilities = caps();
    const imageLimits = capabilities.channels.find((channel) => channel.platform === 'x')!.limits
      .image!;
    imageLimits.mimeTypes.push(mimeType);
    imageLimits.maxWidth = 1000;
    const source = { ...photo(), mimeType };
    const plan = buildPlan(draft({ assets: [source], selections: ['x'] }), capabilities, now);
    expect(plan.mediaRecipes[0]?.outputMimeType).toBe('image/jpeg');
    expect(
      plan.notes.some((note) => note.code === 'MEDIA_CONVERTED' && note.facts.to === 'image/jpeg'),
    ).toBe(true);
    delete imageLimits.maxWidth;
    const unchanged = buildPlan(draft({ assets: [source], selections: ['x'] }), capabilities, now);
    expect(unchanged.mediaRecipes).toEqual([]);
  },
);
