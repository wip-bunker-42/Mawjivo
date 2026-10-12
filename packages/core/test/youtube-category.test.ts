import { expect, test } from 'vitest';
import { buildPlan } from '../src/policy';
import { hashPlan } from '../src/plan-hash';
import { DraftSchema, PostPlanSchema } from '../src/schemas';
import { caps, draft, video } from './fixtures';
const now = '2026-10-09T10:00:00Z';

test('the_selected_youtube_category_is_frozen_in_the_reviewed_plan_and_hash', async () => {
  const input = draft({ title: 'خبر', assets: [video(10000)], selections: ['youtube'] });
  input.overrides.youtube = { youtubeCategoryId: '25' };
  const news = buildPlan(input, caps(), now);
  expect(news.targets[0]).toHaveProperty('youtubeCategoryId', '25');
  expect(PostPlanSchema.safeParse(news).success).toBe(true);
  input.overrides.youtube = { youtubeCategoryId: '20' };
  const games = buildPlan(input, caps(), now);
  expect(await hashPlan(games)).not.toBe(await hashPlan(news));
  expect(news.targets[0]).toHaveProperty('youtubeCategoryId', '25');
});

test('youtube_video_requires_an_explicit_category_without_blocking_other_platforms', () => {
  const input = draft({
    title: 'خبر',
    assets: [video(10000)],
    selections: ['youtube'],
    overrides: {},
  });
  expect(() => buildPlan(input, caps(), now)).toThrow('YOUTUBE_CATEGORY_REQUIRED');
  input.selections = ['x'];
  expect(buildPlan(input, caps(), now).targets[0]?.platform).toBe('x');
});

test('draft_category_accepts_supported_ids_and_rejects_unknown_categories', () => {
  const input = draft();
  expect(
    DraftSchema.safeParse({ ...input, overrides: { youtube: { youtubeCategoryId: '25' } } })
      .success,
  ).toBe(true);
  expect(
    DraftSchema.safeParse({ ...input, overrides: { youtube: { youtubeCategoryId: '999' } } })
      .success,
  ).toBe(false);
});
