import { test, expect } from '@playwright/test';
import { composerFixture } from './composer-fixture';

test('accepted_edit_waits_for_fresh_draft_storage_before_remounting_the_composer', async ({
  page,
}) => {
  await composerFixture(page, { history: true });
  await page.goto('/');
  await page.getByRole('button', { name: 'المجدولة', exact: true }).click();
  await page.getByRole('button', { name: 'تفاصيل المنشور scheduled-post' }).click();
  await page.getByRole('button', { name: 'تعديل المنشور', exact: true }).click();
  await page.getByLabel('النص أو الوصف', { exact: true }).fill('تعديل وافقت عليه');
  await page.getByRole('button', { name: 'مراجعة النشر' }).click();
  await page.evaluate(() => {
    const api = (globalThis as any).__TAURI_INTERNALS__,
      original = api.invoke;
    api.invoke = async (command: string, args: any) => {
      if (command === 'save_draft' && args.draft.text === '')
        await new Promise((resolve) => setTimeout(resolve, 700));
      return original(command, args);
    };
  });
  await page.getByRole('button', { name: 'موافق، انشر' }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'تمت جدولة المنشور' })).toBeVisible();
  await expect(page.getByLabel('النص أو الوصف', { exact: true })).toHaveValue('');
  await expect(page.getByRole('heading', { name: 'تفاصيل المنشور', exact: true })).toBeVisible();
});

test('schedule_accepts_a_date_and_time_typed_character_by_character', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-12T09:00:00Z'));
  await composerFixture(page);
  await page.goto('/');
  await page.getByLabel('النص أو الوصف', { exact: true }).fill('توقيت مكتوب');
  await page.getByRole('checkbox', { name: 'Instagram', exact: true }).uncheck();
  await page.getByRole('checkbox', { name: 'YouTube', exact: true }).uncheck();
  await page.getByRole('checkbox', { name: 'جدولة النشر' }).check();
  const input = page.getByRole('textbox', { name: 'وقت النشر', exact: true });
  await input.fill('');
  await input.pressSequentially('12/10/2026 20:30');
  await expect(input).toHaveValue('12/10/2026 20:30');
  await page.getByRole('button', { name: 'مراجعة النشر' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
});

test('restoring_an_accepted_draft_opens_a_fresh_enabled_composer_without_resending_it', async ({
  page,
}) => {
  await composerFixture(page, { acceptedSavedDraft: true });
  await page.goto('/');
  await expect(page.getByLabel('النص أو الوصف', { exact: true })).toBeEnabled();
  await expect(page.getByLabel('النص أو الوصف', { exact: true })).toHaveValue('');
  expect(
    await page.evaluate(
      () =>
        (globalThis as any).__MAWJIVO_TEST__.calls.filter(
          (c: any) =>
            c.command === 'service_request' &&
            c.args.method === 'POST' &&
            c.args.path.endsWith('/posts'),
        ).length,
    ),
  ).toBe(0);
});

test('summary_follows_a_pending_platform_quietly_without_moving_the_reading_focus', async ({
  page,
}) => {
  await page.clock.install();
  await composerFixture(page, { history: true, historyProgress: true });
  await page.goto('/');
  await page.getByRole('button', { name: 'ملخص', exact: true }).click();
  await expect(page.getByText('X: قبلته المنصة؛ ننتظر النتيجة', { exact: true })).toBeVisible();
  const date = page.getByRole('textbox', { name: 'تاريخ الملخص' });
  await date.focus();
  await page.clock.runFor(15010);
  await expect(page.getByText('X: نُشر', { exact: true })).toBeVisible();
  await expect(page.getByText('نتائج مؤكدة: 1 من 1 منصات', { exact: true })).toBeVisible();
  await expect(date).toBeFocused();
  await expect(page.locator('[aria-live]')).toHaveCount(0);
});

test('plain_schedule_field_accepts_arabic_digits_and_rejects_a_past_time', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-12T09:00:00Z'));
  await composerFixture(page);
  await page.goto('/');
  await page.getByLabel('النص أو الوصف', { exact: true }).fill('منشور بتوقيت واضح');
  await page.getByRole('checkbox', { name: 'Instagram', exact: true }).uncheck();
  await page.getByRole('checkbox', { name: 'YouTube', exact: true }).uncheck();
  await page.getByRole('checkbox', { name: 'جدولة النشر' }).check();
  const time = page.getByRole('textbox', { name: 'وقت النشر', exact: true });
  await expect(time).toBeVisible();
  await time.fill('١٢/١٠/٢٠٢٦ ١٠:٣٠');
  await page.getByRole('button', { name: 'مراجعة النشر' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText('اختر موعدًا بعد الوقت الحالي.', { exact: true })).toBeVisible();
  await time.fill('12/10/2026 20:30');
  await page.getByRole('button', { name: 'مراجعة النشر' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
});

test('acceptance_announces_once_keeps_a_30_second_h2_receipt_and_unlocks_a_new_draft', async ({
  page,
}) => {
  await page.clock.install();
  await composerFixture(page);
  await page.goto('/');
  await page.getByLabel('النص أو الوصف', { exact: true }).fill('أول منشور');
  await page.getByRole('checkbox', { name: 'Instagram', exact: true }).uncheck();
  await page.getByRole('checkbox', { name: 'YouTube', exact: true }).uncheck();
  await page.getByRole('button', { name: 'مراجعة النشر' }).click();
  await page.getByRole('button', { name: 'موافق، انشر' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 2, name: 'تم استلام المنشور' })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('ستتابع');
  await expect(page.getByLabel('النص أو الوصف', { exact: true })).toBeEnabled();
  await expect(page.getByLabel('النص أو الوصف', { exact: true })).toHaveValue('');
  await expect(page.getByRole('button', { name: 'مراجعة النشر' })).toBeEnabled();
  await page.getByLabel('النص أو الوصف', { exact: true }).fill('ثاني منشور');
  await page.clock.runFor(29900);
  await expect(page.getByRole('heading', { level: 2, name: 'تم استلام المنشور' })).toBeVisible();
  await page.clock.runFor(200);
  await expect(page.getByRole('heading', { level: 2, name: 'تم استلام المنشور' })).toHaveCount(0);
  const count = await page.evaluate(
    () =>
      (globalThis as any).__MAWJIVO_TEST__.calls.filter(
        (c: any) =>
          c.command === 'service_request' &&
          c.args.method === 'POST' &&
          c.args.path.endsWith('/posts'),
      ).length,
  );
  expect(count).toBe(1);
});

test('upload_percent_is_readable_without_exposing_an_automatic_progressbar_to_nvda', async ({
  page,
}) => {
  await composerFixture(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'اختيار صور أو فيديو' }).click();
  await page.evaluate(() => (globalThis as any).__MAWJIVO_TEST__.progress());
  await expect(page.getByRole('progressbar')).toHaveCount(0);
  await expect(page.locator('.upload-progress').first()).toContainText('%');
  await expect(page.locator('.upload-progress [aria-hidden="true"]')).not.toHaveCount(0);
});

test('summary_has_one_date_textbox_and_explains_each_platform_and_processing_progress', async ({
  page,
}) => {
  await composerFixture(page, { history: true });
  await page.goto('/');
  await page.getByRole('button', { name: 'ملخص', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'تاريخ الملخص' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'نص مجدول محفوظ' })).toBeVisible();
  await expect(page.getByText('نتائج مؤكدة: 0 من 1 منصات', { exact: true })).toBeVisible();
  await expect(page.getByText('X: ينتظر موعد النشر', { exact: true })).toBeVisible();
  await expect(page.locator('[aria-live]')).toHaveCount(0);
});
