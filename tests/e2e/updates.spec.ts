import { test, expect } from '@playwright/test';
import { composerFixture } from './composer-fixture';

test('upgrades only the selected user service after an explicit action', async ({ page }) => {
  await composerFixture(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'الإعدادات', exact: true }).click();
  await page.getByRole('button', { name: 'التحديثات', exact: true }).click();
  const calls = () => page.evaluate(() => (globalThis as any).__MAWJIVO_TEST__.calls);
  expect((await calls()).filter((call: any) => call.command === 'upgrade_service')).toHaveLength(0);
  const upgrade = page.getByRole('button', { name: 'تحديث خدمة Cloudflare', exact: true });
  await upgrade.click();
  await expect(page.getByText('تم تحديث الخدمة. مساحاتك ومنشوراتك المجدولة محفوظة.')).toBeVisible();
  await expect(upgrade).toBeFocused();
  expect((await calls()).filter((call: any) => call.command === 'upgrade_service')).toEqual([
    {
      command: 'upgrade_service',
      args: { profileId: 'profile-1', packageId: 'synthetic-service-package' },
    },
  ]);
  await expect(page.getByLabel('مساحة العمل', { exact: true })).toHaveValue('space-a');
});

test('updates require explicit check, download and install without automatic announcements or focus moves', async ({
  page,
}) => {
  await composerFixture(page, { update: 'available' });
  await page.goto('/');
  await page.getByRole('button', { name: 'الإعدادات', exact: true }).click();
  await page.getByRole('button', { name: 'التحديثات', exact: true }).click();
  const calls = () => page.evaluate(() => (globalThis as any).__MAWJIVO_TEST__.calls);
  expect((await calls()).filter((call: any) => call.command === 'check_update')).toHaveLength(0);
  const check = page.getByRole('button', { name: 'فحص التحديثات', exact: true });
  await check.click();
  await expect(page.getByText('0.1.1', { exact: true })).toBeVisible();
  await expect(check).toBeFocused();
  await page.getByRole('button', { name: 'تنزيل التحديث', exact: true }).click();
  await expect(page.getByText('تم التحقق من التحديث. يمكنك تثبيته الآن.')).toBeVisible();
  expect((await calls()).filter((call: any) => call.command === 'install_update')).toHaveLength(0);
  await expect(page.locator('[aria-live]')).toHaveCount(0);
  await page.getByRole('button', { name: 'تثبيت التحديث', exact: true }).click();
  const installs = (await calls()).filter((call: any) => call.command === 'install_update');
  expect(installs).toHaveLength(1);
  expect(installs[0].args.updateId).toBe('synthetic-update');
});

test('a signature error prevents installation until another explicit check', async ({ page }) => {
  await composerFixture(page, { update: 'signature-invalid' });
  await page.goto('/');
  await page.getByRole('button', { name: 'الإعدادات', exact: true }).click();
  await page.getByRole('button', { name: 'التحديثات', exact: true }).click();
  await page.getByRole('button', { name: 'فحص التحديثات', exact: true }).click();
  const download = page.getByRole('button', { name: 'تنزيل التحديث', exact: true });
  await download.click();
  await expect(page.getByText('توقيع التحديث غير صالح. أعد الفحص.')).toBeVisible();
  await expect(download).toBeFocused();
  await expect(page.getByRole('button', { name: 'تثبيت التحديث', exact: true })).toHaveAttribute(
    'aria-disabled',
    'true',
  );
  const calls = await page.evaluate(() => (globalThis as any).__MAWJIVO_TEST__.calls);
  expect(calls.filter((call: any) => call.command === 'install_update')).toHaveLength(0);
});

test('an active upload prevents installation without silently retrying', async ({ page }) => {
  await composerFixture(page, { update: 'busy' });
  await page.goto('/');
  await page.getByRole('button', { name: 'الإعدادات', exact: true }).click();
  await page.getByRole('button', { name: 'التحديثات', exact: true }).click();
  await page.getByRole('button', { name: 'فحص التحديثات', exact: true }).click();
  await page.getByRole('button', { name: 'تنزيل التحديث', exact: true }).click();
  const install = page.getByRole('button', { name: 'تثبيت التحديث', exact: true });
  await install.click();
  await expect(
    page.getByText('انتظر انتهاء الرفع أو معالجة الوسائط، ثم أعد التثبيت.'),
  ).toBeVisible();
  await expect(install).toBeFocused();
  await expect(install).toHaveAttribute('aria-disabled', 'false');
  const calls = await page.evaluate(() => (globalThis as any).__MAWJIVO_TEST__.calls);
  expect(calls.filter((call: any) => call.command === 'install_update')).toHaveLength(1);
});
