import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
test('connections_have_private_labeled_fields_without_automatic_announcements', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'الإعدادات', exact: true }).click();
  await page.getByRole('button', { name: 'حسابات النشر', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'ربط حساب نشر' })).toBeVisible();
  await page.getByLabel('اسم الربط').fill('Buffer الشخصي');
  const token = page.getByLabel('مفتاح Buffer API');
  await expect(token).toHaveAttribute('type', 'password');
  await token.fill('synthetic-private');
  await expect(page.getByRole('button', { name: 'حفظ وفحص الحساب' })).toBeDisabled();
  await page.getByLabel('طريقة الربط').selectOption('meta');
  await expect(page.getByLabel('رمز وصول صفحة Facebook')).toHaveAttribute('type', 'password');
  await expect(page.getByLabel('رمز وصول مستخدم Meta')).toHaveAttribute('type', 'password');
  await expect(page.locator('[aria-live]')).toHaveCount(0);
  expect(
    (await new AxeBuilder({ page }).analyze()).violations.filter(
      (v) => v.impact === 'serious' || v.impact === 'critical',
    ),
  ).toEqual([]);
});
test('workspace_defaults_and_provider_choice_survive_save_and_workspace_switch', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const profiles = [
      {
        id: 'profile-1',
        baseUrl: 'https://service.test',
        serviceId: 'synthetic',
        accountId: 'synthetic',
        deviceCredentialRef: 'synthetic-ref',
        version: '0.1.0',
      },
    ];
    let workspaces = [
      {
        id: 'space-a',
        name: 'مساحتي',
        timeZone: 'Africa/Cairo',
        version: 1,
        defaultPlatforms: ['x'],
        preferredChannels: {},
        serviceProfileId: 'profile-1',
      },
      {
        id: 'space-b',
        name: 'مساحة ثانية',
        timeZone: 'Africa/Cairo',
        version: 1,
        defaultPlatforms: ['threads'],
        preferredChannels: {},
        serviceProfileId: 'profile-1',
      },
    ];
    Object.assign(globalThis, {
      isTauri: true,
      __TAURI_INTERNALS__: {
        invoke: async (command: string, args?: Record<string, unknown>) => {
          if (command === 'list_profiles') return profiles;
          if (command !== 'service_request') throw new Error('Unexpected synthetic command');
          const path = String(args!.path);
          if (path.endsWith('/capabilities'))
            return {
              version: 'caps',
              fetchedAt: new Date().toISOString(),
              channels: [
                {
                  id: 'x-buffer',
                  platform: 'x',
                  provider: 'buffer',
                  displayName: 'حساب X',
                  ready: true,
                },
                {
                  id: 'fb-meta',
                  platform: 'facebook',
                  provider: 'meta',
                  displayName: 'صفحتي',
                  ready: true,
                },
                {
                  id: 'fb-buffer',
                  platform: 'facebook',
                  provider: 'buffer',
                  displayName: 'صفحتي على Buffer',
                  ready: true,
                },
              ],
            };
          if (args!.method === 'GET') return workspaces;
          const body = args!.body as Record<string, unknown>;
          workspaces = workspaces.map((item) =>
            path.endsWith(item.id) ? { ...item, ...body, version: item.version + 1 } : item,
          );
          return workspaces.find((item) => path.endsWith(item.id));
        },
      },
    });
  });
  await page.goto('/');
  await expect(page.getByLabel('مساحة العمل', { exact: true })).toHaveValue('space-a');
  await page.getByRole('button', { name: 'الإعدادات', exact: true }).click();
  await page.getByRole('button', { name: 'مساحات العمل', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: 'x', exact: true })).toBeChecked();
  await page.getByRole('checkbox', { name: 'youtube', exact: true }).check();
  await page.getByLabel('حساب facebook الافتراضي').selectOption('fb-buffer');
  await page.getByRole('button', { name: 'حفظ إعدادات المساحة' }).click();
  await expect(page.getByText('حُفظت إعدادات المساحة.')).toBeVisible();
  await page.getByLabel('مساحة العمل', { exact: true }).selectOption('space-b');
  await expect(page.getByRole('checkbox', { name: 'threads', exact: true })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'youtube', exact: true })).not.toBeChecked();
  await page.getByLabel('مساحة العمل', { exact: true }).selectOption('space-a');
  await expect(page.getByRole('checkbox', { name: 'youtube', exact: true })).toBeChecked();
  await expect(page.getByLabel('حساب facebook الافتراضي')).toHaveValue('fb-buffer');
});
test('new_workspace_uses_its_selected_cloudflare_profile', async ({ page }) => {
  await page.addInitScript(() => {
    Object.assign(globalThis, {
      isTauri: true,
      __TAURI_INTERNALS__: {
        invoke: async (command: string, args?: Record<string, unknown>) => {
          if (command === 'list_profiles')
            return ['profile-1', 'profile-2'].map((id) => ({
              id,
              baseUrl: 'https://' + id + '.test',
              serviceId: id,
              accountId: id,
              deviceCredentialRef: id,
              version: '0.1.0',
            }));
          if (command === 'service_request' && args!.method === 'GET')
            return String(args!.path).endsWith('capabilities')
              ? { version: 'caps', fetchedAt: new Date().toISOString(), channels: [] }
              : [];
          if (command === 'service_request' && args!.method === 'POST') {
            if (args!.profileId !== 'profile-2') throw { messageAr: 'wrong synthetic profile' };
            return { ...(args!.body as object), id: 'new-space', version: 1 };
          }
          throw new Error('Unexpected synthetic request');
        },
      },
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'الإعدادات', exact: true }).click();
  await page.getByRole('button', { name: 'مساحات العمل', exact: true }).click();
  await page.getByLabel('خدمة Cloudflare لهذه المساحة').selectOption('profile-2');
  await page.getByLabel('اسم مساحة العمل', { exact: true }).fill('مساحة حساب آخر');
  await page.getByRole('button', { name: 'حفظ إعدادات المساحة' }).click();
  await expect(page.getByLabel('مساحة العمل', { exact: true })).toHaveValue('new-space');
});
