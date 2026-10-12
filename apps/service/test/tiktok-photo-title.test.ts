import { beforeEach, expect, test } from 'vitest';
import { hashPlan } from '@mawjivo/core';
import { resetTestData } from './helpers';
import { auth, publicationFixture } from './publication-fixture';
import { submitPost } from '../src/posts';
beforeEach(resetTestData);

test('authoritative_photo_validation_preserves_the_title_and_rejects_a_forged_missing_title', async () => {
  const fixture = await publicationFixture(),
    channel = fixture.caps.channels[0]!;
  channel.platform = 'tiktok';
  await fixture.env.DB.prepare("UPDATE channels SET platform='tiktok' WHERE id=?")
    .bind(channel.id)
    .run();
  await fixture.env.DB.prepare('UPDATE service_settings SET value_json=? WHERE key=?')
    .bind(JSON.stringify(fixture.caps), 'capabilities:workspace-a')
    .run();
  fixture.draft.title = 'صور الزيارة';
  const submission = await fixture.imageSubmission();
  const forged = structuredClone(submission);
  delete forged.plan.targets[0]!.title;
  forged.planHash = await hashPlan(forged.plan);
  await expect(submitPost(auth, forged, fixture.env)).rejects.toMatchObject({
    code: 'PLAN_INVALID',
  });
  expect((await submitPost(auth, submission, fixture.env)).state).toBe('ready');
  const stored = await fixture.env.DB.prepare('SELECT plan_json FROM posts WHERE draft_id=?')
    .bind(submission.plan.draftId)
    .first<string>('plan_json');
  expect(JSON.parse(stored!).targets[0].title).toBe('صور الزيارة');
});
