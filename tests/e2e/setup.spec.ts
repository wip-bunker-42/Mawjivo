import { expect, test } from '@playwright/test';
test('setup_has_labeled_private_fields_and_useful_failure', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'الإعدادات', exact: true }).click();
  await expect(page.getByLabel('معرف حساب Cloudflare')).toBeVisible();
  const token = page.getByLabel('رمز Cloudflare API');
  await expect(token).toHaveAttribute('type', 'password');
  await page.getByLabel('معرف حساب Cloudflare').fill('a'.repeat(32));
  await token.fill('synthetic-token');
  await page.getByLabel('معرف مفتاح R2').fill('synthetic-access');
  await page.getByLabel('مفتاح R2 السري').fill('synthetic-secret');
  await page.getByRole('button', { name: 'فحص وتجهيز الخدمة' }).click();
  await expect(page.getByText('افتح نسخة التطبيق المثبتة لتجهيز حسابك.')).toBeVisible();
  await expect(token).toHaveValue('');
  await expect(page.getByLabel('مفتاح R2 السري')).toHaveValue('');
  await expect(page.getByRole('heading', { name: 'حالة فحص الخدمة' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'يحتاج إجراء' })).toBeVisible();
});
