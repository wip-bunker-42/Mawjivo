import { env, exports } from 'cloudflare:workers';
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

test('a_missing_database_schema_reports_unavailable_without_exposing_database_errors', async () => {
  await env.DB.prepare('DROP TABLE service_settings').run();
  const response = await exports.default.fetch(new Request('https://service.test/health'));
  expect(response.status).toBe(503);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(await response.json()).toEqual({
    state: 'unavailable',
    messageAr: 'تعذر فحص قاعدة الخدمة. افحص إعداد Cloudflare ثم حاول مجددًا.',
  });
});
