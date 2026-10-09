import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
test('shell_has_arabic_labels_and_unconfigured_service', async ({ page, request }) => {
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByRole('heading', { name: 'Mawjivo', exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'مساحة العمل' })).toBeVisible();
  const health = await request.get('http://127.0.0.1:8787/health');
  expect(health.status()).toBe(503);
});
test('shell uses semantic navigation with no serious accessibility violations', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: 'صفحات التطبيق' })).toBeVisible();
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations.filter(v => v.impact === 'serious' || v.impact === 'critical')).toEqual([]);
});
