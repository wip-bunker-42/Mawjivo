import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';
export default defineConfig(async () => ({
  test: { provide: { migrations: await readD1Migrations('./migrations') } },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          SERVICE_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
          R2_ACCESS_KEY_ID: 'test-access',
          R2_SECRET_ACCESS_KEY: 'test-secret',
        },
      },
    }),
  ],
}));
