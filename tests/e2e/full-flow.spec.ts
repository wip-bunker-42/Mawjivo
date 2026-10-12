import { expect, test } from '@playwright/test';
import { composerFixture } from './composer-fixture';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

test('a_restored_unscheduled_draft_defaults_to_ten_hours_after_reopening', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-11T09:23:37.123Z'));
  await composerFixture(page, { oldDraftCreatedAt: '2026-10-09T00:00:00Z' });
  await page.goto('/');
  await expect(page.getByLabel('النص أو الوصف', { exact: true })).toHaveValue('مسودة محفوظة');
  await page.getByRole('checkbox', { name: 'جدولة النشر' }).check();
  await expect(page.getByLabel('وقت النشر')).toHaveValue('2026-10-11T22:23:37.123');
});

async function runWorkerContract(captured: unknown): Promise<void> {
  await new Promise<void>((resolveRun, reject) => {
    const child = spawn(
      process.execPath,
      [resolve('node_modules/vitest/vitest.mjs'), 'run', 'test/full-flow.test.ts'],
      {
        cwd: resolve('apps/service'),
        windowsHide: true,
        env: { ...process.env, MAWJIVO_FULL_FLOW_INPUT_JSON: JSON.stringify(captured) },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let output = '';
    for (const stream of [child.stdout, child.stderr])
      stream.on('data', (chunk) => {
        output = (output + chunk).slice(-20000);
      });
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('Worker integration timeout\n' + output));
    }, 120000);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      code === 0 ? resolveRun() : reject(new Error('Real Worker integration failed\n' + output));
    });
  });
}

test('full_flow_preserves_confirmed_content_across_restart', async ({ page }) => {
  test.setTimeout(150000);
  await page.clock.setFixedTime(new Date('2026-10-11T09:23:37.123Z'));
  await composerFixture(page);
  await page.goto('/');
  await expect(page.getByLabel('النص أو الوصف', { exact: true })).toBeVisible();
  await page.getByRole('checkbox', { name: 'Instagram', exact: true }).uncheck();
  await page.getByRole('checkbox', { name: 'YouTube', exact: true }).uncheck();
  await page.getByLabel('النص أو الوصف', { exact: true }).fill('وصف الصورة الأصلي');
  await page.getByRole('button', { name: 'اختيار صور أو فيديو' }).click();
  await expect
    .poll(() => page.evaluate(() => (globalThis as any).__MAWJIVO_TEST__.jobs.size))
    .toBe(1);
  await page.getByText('تخصيص X', { exact: true }).click();
  await page.getByLabel('نص X', { exact: true }).fill('النص الخاص الذي وافقت عليه');
  await page.getByRole('checkbox', { name: 'جدولة النشر' }).check();
  await page.evaluate(() => (globalThis as any).__MAWJIVO_TEST__.finish());
  await page.getByRole('button', { name: 'مراجعة النشر' }).click();
  const reviewedHash = await page.getByRole('dialog').getAttribute('data-plan-hash');
  await expect(page.getByRole('dialog')).toContainText('النص الخاص الذي وافقت عليه');
  await page.getByRole('button', { name: 'موافق، انشر' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const captured = await page.evaluate(async () => {
    const api = (globalThis as any).__MAWJIVO_TEST__;
    const invoke = (globalThis as any).__TAURI_INTERNALS__.invoke;
    const workspaces = await invoke('service_request', { path: '/api/workspaces', method: 'GET' });
    const caps = await invoke('service_request', {
      path: '/api/workspaces/space-a/capabilities',
      method: 'GET',
    });
    return {
      workspace: workspaces[0],
      caps,
      submission: api.calls.find(
        (call: any) =>
          call.command === 'service_request' &&
          call.args.method === 'POST' &&
          call.args.path.endsWith('/posts'),
      ).args.body,
      draft: [...api.drafts.values()][0] as any,
      originalUploads: api.calls.filter(
        (call: any) => call.command === 'start_upload' && call.args.input.recipeId === null,
      ).length,
    };
  });
  expect(captured.submission.planHash).toBe(reviewedHash);
  expect(captured.submission.plan.targets[0].text).toBe('النص الخاص الذي وافقت عليه');
  expect(captured.originalUploads).toBe(1);
  expect(Date.parse(captured.submission.plan.dueAt) - Date.parse(captured.draft.createdAt)).toBe(
    36_000_000,
  );
  await page.close();
  await runWorkerContract(captured);
});

test('full_flow_cancel_and_retry_do_not_duplicate', async ({ page }) => {
  test.setTimeout(150000);
  await page.close();
  await runWorkerContract(null);
});
