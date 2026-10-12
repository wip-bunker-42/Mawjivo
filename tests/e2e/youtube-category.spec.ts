import { expect, test } from '@playwright/test';
import { composerFixture } from './composer-fixture';
test('video_category_starts_from_workspace_default_and_review_uses_the_override', async ({
  page,
}) => {
  await composerFixture(page, { media: 'video' });
  await page.goto('/');
  await page.getByRole('button', { name: 'اختيار صور أو فيديو' }).click();
  const category = page.getByRole('combobox', { name: 'فئة هذا الفيديو على يوتيوب', exact: true });
  await expect(category).toHaveValue('25');
  await category.selectOption('20');
  await page.getByLabel('عنوان الفيديو').fill('عنوان');
  await page.getByRole('button', { name: 'مراجعة النشر' }).click();
  await expect(page.getByRole('dialog')).toContainText('فئة يوتيوب: الألعاب');
  await page.evaluate(() => (globalThis as any).__MAWJIVO_TEST__.finish());
  await page.getByRole('button', { name: 'موافق، انشر' }).click();
  const submitted = await page.evaluate(
    () =>
      (globalThis as any).__MAWJIVO_TEST__.calls.find(
        (c: any) =>
          c.command === 'service_request' &&
          c.args.method === 'POST' &&
          c.args.path.endsWith('/posts'),
      ).args.body.plan,
  );
  expect(submitted.targets.find((t: any) => t.platform === 'youtube').youtubeCategoryId).toBe('20');
});
test('workspace_category_setting_is_a_labeled_select_and_survives_switching', async ({ page }) => {
  await composerFixture(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'الإعدادات', exact: true }).click();
  await page.getByRole('button', { name: 'مساحات العمل', exact: true }).click();
  const category = page.getByRole('combobox', { name: 'فئة يوتيوب الافتراضية', exact: true });
  await expect(category).toHaveValue('25');
  await category.selectOption('27');
  await page.getByRole('button', { name: 'حفظ إعدادات المساحة' }).click();
  await expect(page.getByText('حُفظت إعدادات المساحة.')).toBeVisible();
  await page.getByLabel('مساحة العمل', { exact: true }).selectOption('space-b');
  await expect(category).toHaveValue('20');
  await page.getByLabel('مساحة العمل', { exact: true }).selectOption('space-a');
  await expect(category).toHaveValue('27');
});
test('video_without_a_category_requires_choice_and_hides_the_field_when_youtube_is_excluded', async ({
  page,
}) => {
  await composerFixture(page, { media: 'video', youtubeCategory: null });
  await page.goto('/');
  await page.getByRole('button', { name: 'اختيار صور أو فيديو' }).click();
  await page.getByLabel('عنوان الفيديو').fill('عنوان');
  const category = page.getByRole('combobox', { name: 'فئة هذا الفيديو على يوتيوب', exact: true });
  await expect(category).toHaveValue('');
  await page.getByRole('button', { name: 'مراجعة النشر' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('checkbox', { name: 'YouTube', exact: true }).uncheck();
  await expect(category).toHaveCount(0);
  await page.getByRole('button', { name: 'مراجعة النشر' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
});
