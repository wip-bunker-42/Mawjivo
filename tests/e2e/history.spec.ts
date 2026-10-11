import { test, expect } from '@playwright/test';
import { composerFixture } from './composer-fixture';

test('a_repaired_known_rejection_offers_an_explicit_safe_retry', async ({ page }) => {
  await composerFixture(page, { history: true, repairedRejection: true });
  await page.goto('/');
  await page.getByRole('button', { name: 'المجدولة', exact: true }).click();
  await page.getByRole('button', { name: 'تفاصيل المنشور scheduled-post' }).click();
  await expect(page.getByRole('button', { name: 'إعادة محاولة الوجهات الآمنة' })).toBeVisible();
});
test('opening_a_newer_server_revision_does_not_restore_an_older_local_caption', async ({
  page,
}) => {
  await composerFixture(page, { history: true, olderNativeDraft: true });
  await page.goto('/');
  await page.getByRole('button', { name: 'المجدولة', exact: true }).click();
  await page.getByRole('button', { name: 'تفاصيل المنشور scheduled-post' }).click();
  await page.getByRole('button', { name: 'تعديل المنشور' }).click();
  await expect(page.getByLabel('النص أو الوصف', { exact: true })).toHaveValue('نص مجدول محفوظ');
});
test('scheduled_edit_uses_the_server_revision_and_preserves_a_conflicted_local_draft', async ({
  page,
}) => {
  await composerFixture(page, { history: true, revisionConflict: true });
  await page.goto('/');
  await page.getByRole('button', { name: 'المجدولة', exact: true }).click();
  await page.getByRole('button', { name: 'تفاصيل المنشور scheduled-post' }).click();
  await page.getByRole('button', { name: 'تعديل المنشور' }).click();
  await expect(page.getByLabel('النص أو الوصف', { exact: true })).toHaveValue('نص مجدول محفوظ');
  const originalDraftId = await page.evaluate(
    () => (globalThis as any).__MAWJIVO_TEST__.drafts.get('space-a').id,
  );
  await page.getByLabel('النص أو الوصف', { exact: true }).fill('تعديلي الذي يجب حفظه');
  await page.getByRole('button', { name: 'مراجعة النشر' }).click();
  await page.getByRole('button', { name: 'موافق، انشر' }).click();
  await expect(
    page.getByRole('dialog').getByText('تغير المنشور من نافذة أخرى. حدّثه قبل التعديل.'),
  ).toBeVisible();
  const edit = await page.evaluate(() => {
    const api = (globalThis as any).__MAWJIVO_TEST__;
    return {
      calls: api.calls.filter(
        (c: any) => c.command === 'service_request' && c.args.method === 'PATCH',
      ),
      draft: api.drafts.get('space-a'),
    };
  });
  expect(edit.calls[0].args.body.expectedRevision).toBe(3);
  expect(edit.calls[0].args.body.submission.plan.revision).toBe(4);
  expect(edit.draft.id).toBe(originalDraftId);
  expect(edit.draft.text).toBe('تعديلي الذي يجب حفظه');
  await page.getByRole('button', { name: 'رجوع للتعديل' }).click();
  await expect(page.getByLabel('النص أو الوصف', { exact: true })).toHaveValue(
    'تعديلي الذي يجب حفظه',
  );
});
test('cancel_works_by_keyboard_and_workspace_switch_removes_previous_results', async ({ page }) => {
  await composerFixture(page, { history: true });
  await page.goto('/');
  await page.getByRole('button', { name: 'المجدولة', exact: true }).click();
  const details = page.getByRole('button', { name: 'تفاصيل المنشور scheduled-post' });
  await details.focus();
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'إلغاء الوجهات التي لم تبدأ' }).click();
  await expect(page.getByText('أُلغي النشر للوجهات التي لم تبدأ.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'إلغاء الوجهات التي لم تبدأ' })).toBeFocused();
  await expect(page.getByRole('button', { name: 'إلغاء الوجهات التي لم تبدأ' })).toHaveAttribute(
    'aria-disabled',
    'true',
  );
  await page.getByRole('button', { name: 'إغلاق التفاصيل' }).click();
  await expect(page.getByRole('button', { name: 'تحديث القائمة' })).toBeFocused();
  await page.getByLabel('مساحة العمل', { exact: true }).selectOption('space-b');
  await expect(page.getByText('لا توجد منشورات في هذه القائمة.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'تفاصيل المنشور scheduled-post' })).toHaveCount(0);
});
test('summary_distinguishes_logical_posts_from_published_platforms_without_announcements', async ({
  page,
}) => {
  await composerFixture(page, { history: true });
  await page.goto('/');
  await page.getByRole('button', { name: 'ملخص', exact: true }).click();
  await expect(page.getByText('منشورات مكتملة: 1', { exact: true })).toBeVisible();
  await expect(page.getByText('وجهات منشورة: 6', { exact: true })).toBeVisible();
  await expect(page.getByText('نتائج غير محسومة: 1', { exact: true })).toBeVisible();
  await expect(page.locator('[aria-live]')).toHaveCount(0);
  const calls = await page.evaluate(() =>
    (globalThis as any).__MAWJIVO_TEST__.calls.filter(
      (c: any) => c.command === 'service_request' && c.args.path.endsWith('/capabilities'),
    ),
  );
  expect(calls).toHaveLength(1);
});
