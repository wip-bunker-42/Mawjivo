import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { composerFixture } from './composer-fixture';
test('defaults_can_be_changed_and_schedule_starts_ten_hours_from_page_creation', async ({
  page,
}) => {
  await composerFixture(page);
  await page.goto('/');
  await expect(page.getByRole('checkbox', { name: 'X', exact: true })).toBeChecked();
  await page.getByRole('checkbox', { name: 'X', exact: true }).uncheck();
  await page.getByRole('checkbox', { name: 'Threads', exact: true }).check();
  await expect(page.getByLabel('وقت النشر')).toHaveCount(0);
  const created = Date.now();
  await page.getByRole('checkbox', { name: 'جدولة النشر' }).check();
  const local = await page.getByLabel('وقت النشر').inputValue();
  expect(Math.abs(Date.parse(local + '+03:00') - created - 36000000)).toBeLessThan(90000);
  await page.getByRole('checkbox', { name: 'جدولة النشر' }).uncheck();
  await expect(page.getByLabel('وقت النشر')).toHaveCount(0);
});
test('video_title_is_required_without_youtube_and_review_explains_clips', async ({ page }) => {
  await composerFixture(page, { media: 'video' });
  await page.goto('/');
  await page.getByRole('checkbox', { name: 'YouTube', exact: true }).uncheck();
  await page.getByRole('button', { name: 'اختيار صور أو فيديو' }).click();
  await expect(page.getByLabel('عنوان الفيديو')).toHaveAttribute('required', '');
  await page.getByRole('button', { name: 'مراجعة النشر' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByLabel('عنوان الفيديو').fill('عنواني');
  await page.getByLabel('النص أو الوصف', { exact: true }).fill('الوصف');
  await page.getByRole('button', { name: 'مراجعة النشر' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('dialog')).toContainText('140');
  await expect(page.getByRole('button', { name: 'موافق، انشر' })).toBeDisabled();
  await page.evaluate(() => {
    (globalThis as any).__MAWJIVO_TEST__.finish();
  });
  await expect(page.getByRole('button', { name: 'موافق، انشر' })).toBeEnabled();
});
test('upload_is_early_quiet_and_ordered_image_alts_and_text_are_reviewable', async ({ page }) => {
  await composerFixture(page);
  await page.goto('/');
  await page.getByLabel('النص أو الوصف', { exact: true }).fill('وصف الصور');
  await page.getByRole('button', { name: 'اختيار صور أو فيديو' }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (globalThis as any).__MAWJIVO_TEST__.calls.filter(
            (c: any) => c.command === 'start_upload',
          ).length,
      ),
    )
    .toBeGreaterThan(0);
  const text = page.getByLabel('النص أو الوصف', { exact: true });
  await text.focus();
  await page.evaluate(() => {
    (globalThis as any).__MAWJIVO_TEST__.progress();
  });
  await expect(text).toBeFocused();
  await expect(page.locator('[aria-live]')).toHaveCount(0);
  await page.getByText('تخصيص X', { exact: true }).click();
  await page.getByLabel('نص X').fill('نص خاص');
  await page.getByLabel('النص البديل X للصورة 1').fill('بديل خاص');
  await page.getByRole('button', { name: 'مراجعة النشر' }).click();
  await expect(page.getByRole('dialog')).toContainText('تحويل');
  await expect(page.getByRole('dialog')).toContainText('نص خاص');
  await expect(page.getByRole('dialog')).toContainText('بديل خاص');
  await expect(page.getByRole('dialog')).toContainText('استبعاد');
  expect(
    (await new AxeBuilder({ page }).analyze()).violations.filter(
      (v) => v.impact === 'serious' || v.impact === 'critical',
    ),
  ).toEqual([]);
  await page.getByRole('button', { name: 'رجوع للتعديل' }).click();
  await expect(page.getByRole('button', { name: 'مراجعة النشر' })).toBeFocused();
});
test('editing_after_review_changes_the_submitted_hash', async ({ page }) => {
  await composerFixture(page);
  await page.goto('/');
  await page.getByLabel('النص أو الوصف', { exact: true }).fill('النص الأول');
  await page.getByRole('button', { name: 'مراجعة النشر' }).click();
  const first = await page.getByRole('dialog').getAttribute('data-plan-hash');
  await page.getByRole('button', { name: 'رجوع للتعديل' }).click();
  await page.getByLabel('النص أو الوصف', { exact: true }).fill('النص الثاني');
  await page.getByRole('button', { name: 'مراجعة النشر' }).click();
  await expect(page.getByRole('dialog')).not.toHaveAttribute('data-plan-hash', first!);
  await page.getByRole('button', { name: 'موافق، انشر' }).click();
  await expect(page.getByText('تم إرسال المنشور. ستتابع الخدمة نتائج المنصات.')).toBeVisible();
  const submitted = await page.evaluate(
    () =>
      (globalThis as any).__MAWJIVO_TEST__.calls.find(
        (c: any) => c.command === 'service_request' && c.args.method === 'POST',
      ).args.body,
  );
  expect(submitted.plan.targets.find((t: any) => t.platform === 'x').text).toBe('النص الثاني');
  expect(submitted.planHash).not.toBe(first);
});
test('late_file_selection_cannot_attach_to_another_workspace', async ({ page }) => {
  await composerFixture(page, { deferredPick: true });
  await page.goto('/');
  await page.getByRole('button', { name: 'اختيار صور أو فيديو' }).click();
  await page.getByLabel('مساحة العمل', { exact: true }).selectOption('space-b');
  await page.evaluate(() => {
    (globalThis as any).__MAWJIVO_TEST__.resolvePick();
  });
  await expect(page.getByText('صورتي.PNG')).toHaveCount(0);
  expect(
    await page.evaluate(
      () =>
        (globalThis as any).__MAWJIVO_TEST__.calls.filter((c: any) => c.command === 'start_upload')
          .length,
    ),
  ).toBe(0);
});

test('platform_alt_defaults_match_the_description_shown_for_that_platform', async ({ page }) => {
  await composerFixture(page);
  await page.goto('/');
  await page.getByLabel('النص أو الوصف', { exact: true }).fill('وصف مشترك');
  await page.getByRole('button', { name: 'اختيار صور أو فيديو' }).click();
  await page.getByText('تخصيص X', { exact: true }).click();
  await page.getByLabel('نص X', { exact: true }).fill('وصف منصة X');
  await expect(page.getByLabel('النص البديل X للصورة 1')).toHaveValue('وصف منصة X');
  await page.getByRole('button', { name: 'مراجعة النشر' }).click();
  await expect(page.getByRole('dialog')).toContainText('وصف منصة X');
});

test('failed_local_preparation_can_be_retried_without_resuming_an_unknown_upload', async ({
  page,
}) => {
  await composerFixture(page, { prepareFailureOnce: true });
  await page.goto('/');
  await page.getByLabel('النص أو الوصف', { exact: true }).fill('وصف');
  await page.getByRole('button', { name: 'اختيار صور أو فيديو' }).click();
  await page.getByRole('button', { name: 'استئناف رفع صورتي.PNG' }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (globalThis as any).__MAWJIVO_TEST__.calls.filter(
            (c: any) => c.command === 'prepare_media',
          ).length,
      ),
    )
    .toBe(2);
  expect(
    await page.evaluate(() =>
      (globalThis as any).__MAWJIVO_TEST__.calls.some(
        (c: any) => c.command === 'resume_upload' && c.args.jobId.startsWith('local-'),
      ),
    ),
  ).toBe(false);
});

test('source_restore_failure_is_visible_and_keeps_confirmation_unavailable', async ({ page }) => {
  await composerFixture(page, { restoreError: true });
  await page.goto('/');
  await expect(page.getByText('تغير الملف بعد اختياره؛ اختره مجددًا.')).toBeVisible();
  await page.getByRole('button', { name: 'مراجعة النشر' }).click();
  await expect(page.getByRole('button', { name: 'موافق، انشر' })).toBeDisabled();
});

test('image_order_moves_the_corresponding_alt_text_and_chain_parts_are_editable', async ({
  page,
}) => {
  await composerFixture(page, { images: 2 });
  await page.goto('/');
  await page.getByLabel('النص أو الوصف', { exact: true }).fill('أ'.repeat(400));
  await page.getByRole('button', { name: 'اختيار صور أو فيديو' }).click();
  await expect(page.getByRole('button', { name: 'نقل الصورة-2.PNG لأعلى' })).toBeVisible();
  await page.getByText('تخصيص X', { exact: true }).click();
  await page.getByLabel('النص البديل X للصورة 1').fill('بديل الصورة الأولى');
  await page.getByLabel('النص البديل X للصورة 2').fill('بديل الصورة الثانية');
  await page.getByRole('button', { name: 'نقل الصورة-2.PNG لأعلى' }).click();
  await expect(page.getByLabel('النص البديل X للصورة 1')).toHaveValue('بديل الصورة الثانية');
  await page.getByRole('checkbox', { name: 'نشر سلسلة متصلة على X' }).check();
  await page.getByRole('button', { name: 'تقسيم النص تلقائيًا لـX' }).click();
  await expect(page.getByLabel('جزء 1 من سلسلة X')).toHaveValue('أ'.repeat(280));
  await expect(page.getByLabel('جزء 2 من سلسلة X')).toHaveValue('أ'.repeat(120));
  await page.getByLabel('جزء 2 من سلسلة X').fill('الجزء المعدل');
  await page.getByRole('button', { name: 'نقل جزء 2 من X لأعلى' }).click();
  await expect(page.getByLabel('جزء 1 من سلسلة X')).toHaveValue('الجزء المعدل');
  await page.getByRole('button', { name: 'مراجعة النشر' }).click();
  await page.evaluate(() => {
    (globalThis as any).__MAWJIVO_TEST__.finish();
  });
  await expect(page.getByRole('button', { name: 'موافق، انشر' })).toBeEnabled();
  await page.getByRole('button', { name: 'موافق، انشر' }).click();
  const plan = await page.evaluate(
    () =>
      (globalThis as any).__MAWJIVO_TEST__.calls.find(
        (c: any) => c.command === 'service_request' && c.args.method === 'POST',
      ).args.body.plan,
  );
  const target = plan.targets.find((t: any) => t.platform === 'x');
  expect(target.assets.map((a: any) => a.sourceAssetId)).toEqual(['file-2', 'file-1']);
  expect(target.altTexts).toEqual(['بديل الصورة الثانية', 'بديل الصورة الأولى']);
  expect(target.threadParts[0]).toBe('الجزء المعدل');
});
