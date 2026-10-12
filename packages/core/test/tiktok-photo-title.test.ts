import { expect, test } from 'vitest';
import { buildPlan } from '../src/policy';
import { hashPlan } from '../src/plan-hash';
import { caps, draft, photo } from './fixtures';
const now = '2026-10-12T12:00:00Z';

test.each(['', '   '])('tiktok_photos_require_an_explicit_nonblank_title_%j', (title) => {
  expect(() =>
    buildPlan(draft({ title, assets: [photo()], selections: ['tiktok'] }), caps(), now),
  ).toThrow('TIKTOK_PHOTO_TITLE_REQUIRED');
});

test('tiktok_photo_title_is_frozen_in_the_review_and_hash_without_renaming_images', async () => {
  const input = draft({
    title: 'عنوان ألبوم الصور',
    assets: [photo(), photo(2)],
    selections: ['tiktok', 'facebook'],
  });
  const plan = buildPlan(input, caps(), now);
  expect(plan.targets.find((t) => t.platform === 'tiktok')?.title).toBe('عنوان ألبوم الصور');
  expect(plan.targets.find((t) => t.platform === 'facebook')?.title).toBeUndefined();
  expect(plan.targets.find((t) => t.platform === 'tiktok')?.assets).toEqual([
    { sourceAssetId: 'photo-1', recipeId: null },
    { sourceAssetId: 'photo-2', recipeId: null },
  ]);
  const first = await hashPlan(plan);
  input.title = 'عنوان آخر';
  expect(await hashPlan(buildPlan(input, caps(), now))).not.toBe(first);
  expect(plan.targets.find((t) => t.platform === 'tiktok')?.title).toBe('عنوان ألبوم الصور');
});

test('tiktok_photo_title_uses_90_utf16_units_without_splitting_an_emoji_and_reports_the_cut', () => {
  const plan = buildPlan(
    draft({ title: 'أ'.repeat(89) + '😀ب', assets: [photo()], selections: ['tiktok'] }),
    caps(),
    now,
  );
  expect(plan.targets[0]?.title).toBe('أ'.repeat(89));
  expect(plan.notes.find((n) => n.code === 'TITLE_TRUNCATED')?.facts.limit).toBe(90);
});

test('photos_without_tiktok_do_not_require_a_title', () => {
  expect(
    buildPlan(draft({ assets: [photo()], selections: ['facebook', 'instagram'] }), caps(), now)
      .targets,
  ).toHaveLength(2);
});
