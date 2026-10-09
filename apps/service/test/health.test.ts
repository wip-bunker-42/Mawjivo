import { exports } from 'cloudflare:workers';
import { beforeEach, expect, test } from 'vitest';
import { resetTestData } from './helpers';
beforeEach(resetTestData);
test('unconfigured service does not claim readiness', async () => {
  const response = await exports.default.fetch(new Request('https://service.test/health'));
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({
    state: 'unconfigured',
    messageAr: 'أكمل إعداد الخدمة قبل النشر.',
  });
});
