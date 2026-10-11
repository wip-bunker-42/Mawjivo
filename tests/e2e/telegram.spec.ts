import { test, expect } from '@playwright/test';
import { composerFixture } from './composer-fixture';

test('healthchecks_management_credentials_are_sent_only_to_native_setup', async ({ page }) => {
  await composerFixture(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'الإعدادات', exact: true }).click();
  await page.getByRole('button', { name: 'تليجرام والمراقبة', exact: true }).click();
  const key = page.getByLabel('مفتاح إدارة Healthchecks', { exact: true });
  await key.fill('synthetic-healthchecks-management-key');
  await page.getByRole('button', { name: 'تجهيز Healthchecks على بريدي' }).click();
  await expect(key).toHaveValue('');
  const calls = await page.evaluate(() => (globalThis as any).__MAWJIVO_TEST__.calls);
  expect(calls.filter((call: any) => call.command === 'configure_monitoring')).toHaveLength(1);
  expect(
    calls
      .filter((call: any) => call.command === 'service_request')
      .every(
        (call: any) => !JSON.stringify(call).includes('synthetic-healthchecks-management-key'),
      ),
  ).toBe(true);
});
test('telegram_settings_keep_the_bot_private_and_clear_it_after_save_or_workspace_switch', async ({
  page,
}) => {
  await composerFixture(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'الإعدادات', exact: true }).click();
  await page.getByRole('button', { name: 'تليجرام والمراقبة', exact: true }).click();
  const token = page.getByLabel('رمز بوت تليجرام', { exact: true });
  await expect(token).toHaveAttribute('type', 'password');
  await token.fill('123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
  await page.getByLabel('معرف المحادثة', { exact: true }).fill('123456');
  await page.getByRole('button', { name: 'حفظ ربط تليجرام' }).click();
  await expect(token).toHaveValue('');
  await expect(page.getByText('حُفظ ربط تليجرام لهذه المساحة.')).toBeVisible();
  await token.fill('secret-for-a');
  await page.getByLabel('مساحة العمل', { exact: true }).selectOption('space-b');
  await expect(token).toHaveValue('');
  await expect(page.locator('[aria-live]')).toHaveCount(0);
});
