import { expect, test } from '@playwright/test';
import { composerFixture } from './composer-fixture';
test('ctrl_shift_n_opens_independent_windows_and_workspace_drafts_stay_local', async ({
  page,
  context,
}) => {
  await composerFixture(page, { windowId: 'main' });
  await page.goto('/');
  await page.getByLabel('النص أو الوصف', { exact: true }).fill('مسودة الأولى');
  await page.keyboard.press('Control+Shift+N');
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (globalThis as any).__MAWJIVO_TEST__.calls.filter(
            (c: any) => c.command === 'open_composer_window',
          ).length,
      ),
    )
    .toBe(1);
  const second = await context.newPage();
  await composerFixture(second, { windowId: 'composer-second' });
  await second.goto('/');
  await second.getByLabel('النص أو الوصف', { exact: true }).fill('مسودة الثانية');
  await page.getByLabel('مساحة العمل', { exact: true }).selectOption('space-b');
  await expect(second.getByLabel('مساحة العمل', { exact: true })).toHaveValue('space-a');
  await page.getByLabel('مساحة العمل', { exact: true }).selectOption('space-a');
  await expect(page.getByLabel('النص أو الوصف', { exact: true })).toHaveValue('مسودة الأولى');
  await expect(second.getByLabel('النص أو الوصف', { exact: true })).toHaveValue('مسودة الثانية');
  const ids = await Promise.all(
    [page, second].map((p) =>
      p.evaluate(() => (globalThis as any).__MAWJIVO_TEST__.drafts.get('space-a')?.id),
    ),
  );
  expect(ids[0]).toBeTruthy();
  expect(ids[1]).toBeTruthy();
  expect(ids[0]).not.toBe(ids[1]);
});

test('an_unavailable_profile_does_not_hide_healthy_workspaces', async ({ page }) => {
  await composerFixture(page, { unavailableProfile: true });
  await page.goto('/');
  await expect(page.getByLabel('مساحة العمل', { exact: true })).toHaveValue('space-a');
  await page.getByLabel('النص أو الوصف', { exact: true }).fill('الخدمة الأخرى تعمل');
  await page.getByLabel('مساحة العمل', { exact: true }).selectOption('space-b');
  await expect(page.getByLabel('مساحة العمل', { exact: true })).toHaveValue('space-b');
  await expect(page.getByText(/unavailable\.test/)).toBeVisible();
});

test('closed_secondary_drafts_reopen_through_saved_drafts_after_restart', async ({
  page,
  context,
}) => {
  await composerFixture(page, { savedWindows: true });
  await page.goto('/');
  await page.reload();
  await page.getByLabel('مساحة العمل', { exact: true }).selectOption('space-b');
  await expect(page.getByRole('button', { name: 'عرض المسودات المحفوظة' })).toBeVisible();
  await page.getByRole('button', { name: 'عرض المسودات المحفوظة' }).click();
  for (const index of [1, 2]) {
    const windowId = 'composer-' + String(index).repeat(32);
    await page.getByLabel('المسودة المحفوظة', { exact: true }).selectOption(windowId);
    await page.getByRole('button', { name: 'فتح المسودة في نافذة' }).click();
    const calls = await page.evaluate(() =>
      (globalThis as any).__MAWJIVO_TEST__.calls.filter(
        (c: any) => c.command === 'open_saved_composer',
      ),
    );
    expect(calls.at(-1).args).toEqual({
      profileId: 'profile-1',
      workspaceId: 'space-b',
      windowId,
      draftId: 'saved-secondary-' + index,
    });
    const restored = await context.newPage();
    await composerFixture(restored, { windowId, restoredWindow: index });
    await restored.goto('/');
    await expect(restored.getByLabel('مساحة العمل', { exact: true })).toHaveValue('space-b');
    await expect(restored.getByLabel('النص أو الوصف', { exact: true })).toHaveValue(
      'مسودة النافذة ' + index,
    );
    await restored.close();
  }
});
