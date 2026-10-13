import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { composerFixture } from './composer-fixture';

async function transferFixture(
  page: Page,
  outcome: 'ok' | 'cancel' | 'error' = 'ok',
  empty = true,
): Promise<void> {
  await composerFixture(page);
  await page.addInitScript(
    ({ outcome, empty }) => {
      const runtime = (globalThis as any).__TAURI_INTERNALS__;
      const api = (globalThis as any).__MAWJIVO_TEST__;
      const invoke = runtime.invoke;
      let imported = !empty;
      runtime.invoke = async (command: string, args: any) => {
        if (command === 'list_profiles' && !imported) return [];
        if (command === 'import_settings' || command === 'export_settings') {
          api.calls.push({ command, args });
          if (outcome === 'cancel') return null;
          if (outcome === 'error')
            throw {
              code: 'NETWORK',
              messageAr: 'تعذر التحقق من الخدمة. راجع الاتصال.',
              details: { secret: 'TEST_hidden_transfer_secret' },
            };
          if (command === 'import_settings') imported = true;
          return { services: 1, workspaces: 2, connections: 3 };
        }
        const result = await invoke(command, args);
        if (
          command === 'service_request' &&
          args.method === 'GET' &&
          args.path === '/api/workspaces'
        ) {
          return result.map((workspace: any) => ({
            ...workspace,
            defaultYoutubeCategoryId: '25',
            preferredChannels: { youtube: 'ch-youtube' },
          }));
        }
        return result;
      };
      const announcements: string[] = [];
      const observer = new MutationObserver(() => {
        const text = document
          .querySelector('[role="status"][aria-label="نتيجة نقل الإعدادات"]')
          ?.textContent?.trim();
        if (text && announcements.at(-1) !== text) announcements.push(text);
      });
      observer.observe(document, { subtree: true, childList: true, characterData: true });
      api.transferAnnouncements = announcements;
    },
    { outcome, empty },
  );
}

async function openTransfer(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'نقل الإعدادات والحسابات', exact: true }).click();
}

test('empty_install_exposes_transfer_and_two_native_buttons_in_tab_order', async ({ page }) => {
  await transferFixture(page);
  await openTransfer(page);
  await expect(
    page.getByRole('heading', { name: 'نقل الإعدادات والحسابات', exact: true }),
  ).toBeVisible();
  const exportButton = page.getByRole('button', { name: 'تصدير الإعدادات والحسابات', exact: true });
  const importButton = page.getByRole('button', {
    name: 'استيراد الإعدادات والحسابات',
    exact: true,
  });
  await exportButton.focus();
  await page.keyboard.press('Tab');
  await expect(importButton).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(exportButton).toBeFocused();
});

test('file_cancellation_is_silent_and_keeps_focus', async ({ page }) => {
  await transferFixture(page, 'cancel');
  await openTransfer(page);
  const importButton = page.getByRole('button', {
    name: 'استيراد الإعدادات والحسابات',
    exact: true,
  });
  await importButton.click();
  await expect(importButton).toHaveAttribute('aria-disabled', 'false');
  await expect(importButton).toBeFocused();
  await expect(page.getByRole('status', { name: 'نتيجة نقل الإعدادات' })).toBeEmpty();
  expect(
    await page.evaluate(() => (globalThis as any).__MAWJIVO_TEST__.transferAnnouncements),
  ).toEqual([]);
});

test('import_announces_once_keeps_focus_and_reads_current_workspaces_without_writes', async ({
  page,
}) => {
  await transferFixture(page);
  await openTransfer(page);
  const importButton = page.getByRole('button', {
    name: 'استيراد الإعدادات والحسابات',
    exact: true,
  });
  await importButton.click();
  await expect(page.getByRole('status', { name: 'نتيجة نقل الإعدادات' })).toContainText('3 حسابات');
  await expect(importButton).toBeFocused();
  await expect(page.getByLabel('مساحة العمل', { exact: true })).toHaveValue('space-a');
  expect(
    await page.evaluate(() => (globalThis as any).__MAWJIVO_TEST__.transferAnnouncements),
  ).toHaveLength(1);
  expect(
    await page.evaluate(() =>
      (globalThis as any).__MAWJIVO_TEST__.calls.filter(
        (call: any) => call.command === 'service_request' && call.args.method !== 'GET',
      ),
    ),
  ).toEqual([]);
  await page.getByRole('button', { name: 'مساحات العمل', exact: true }).click();
  await expect(page.getByLabel('فئة يوتيوب الافتراضية', { exact: true })).toHaveValue('25');
  await expect(page.getByLabel('حساب youtube الافتراضي', { exact: true })).toHaveValue(
    'ch-youtube',
  );
});

test('transfer_failure_displays_only_the_safe_arabic_message', async ({ page }) => {
  await transferFixture(page, 'error');
  await openTransfer(page);
  await page.getByRole('button', { name: 'استيراد الإعدادات والحسابات', exact: true }).click();
  await expect(page.getByRole('status', { name: 'نتيجة نقل الإعدادات' })).toHaveText(
    'تعذر التحقق من الخدمة. راجع الاتصال.',
  );
  await expect(page.getByText('TEST_hidden_transfer_secret')).toHaveCount(0);
});

test('export_does_not_change_selected_workspace_and_preserves_saved_draft', async ({ page }) => {
  await transferFixture(page, 'ok', false);
  await page.goto('/');
  await page.getByLabel('النص أو الوصف', { exact: true }).fill('مسودتي قبل نقل الجهاز');
  await page.getByRole('button', { name: 'الإعدادات', exact: true }).click();
  await page.getByRole('button', { name: 'نقل الإعدادات والحسابات', exact: true }).click();
  const exportButton = page.getByRole('button', { name: 'تصدير الإعدادات والحسابات', exact: true });
  await exportButton.click();
  await expect(page.getByRole('status', { name: 'نتيجة نقل الإعدادات' })).toContainText('حُفظ ملف');
  await expect(exportButton).toBeFocused();
  await expect(page.getByLabel('مساحة العمل', { exact: true })).toHaveValue('space-a');
  await page.getByRole('button', { name: 'منشور جديد', exact: true }).click();
  await expect(page.getByLabel('النص أو الوصف', { exact: true })).toHaveValue(
    'مسودتي قبل نقل الجهاز',
  );
});
