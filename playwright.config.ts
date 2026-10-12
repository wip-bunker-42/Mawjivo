import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  use: { baseURL: 'http://127.0.0.1:1420', trace: 'retain-on-failure' },
  webServer: [
    {
      command: 'pnpm --filter @mawjivo/desktop test:serve',
      url: 'http://127.0.0.1:1420',
      reuseExistingServer: false,
    },
    { command: 'pnpm --filter @mawjivo/service dev', port: 8787, reuseExistingServer: false },
  ],
});
