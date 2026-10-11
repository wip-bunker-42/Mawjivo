import { beforeEach, expect, test } from 'vitest';
import { initializeService } from '../src/readiness';
import { resetTestData, testEnv } from './helpers';
const admin = { deviceId: 'owner', allowedWorkspaceIds: '*' as const };
beforeEach(resetTestData);
test('initialization_checks_signed_r2_access_before_marking_ready', async () => {
  const env = testEnv();
  await env.DB.prepare(
    "INSERT INTO service_settings(key,value_json,updated_at_ms) VALUES('owner_service_id',?,1)",
  )
    .bind(JSON.stringify(env.SERVICE_ID))
    .run();
  const requests: Request[] = [];
  const fetcher: typeof fetch = async (input) => {
    requests.push(new Request(input));
    return new Response('', { status: 200 });
  };
  const checks = await initializeService(admin, env, fetcher, 'https://mawjivo.service.test');
  expect(checks.length).toBeGreaterThanOrEqual(3);
  expect(checks.every((check) => check.state === 'ready')).toBe(true);
  expect(requests.map((request) => request.method)).toEqual(['PUT', 'DELETE']);
  expect(requests[0]!.headers.get('Authorization')).toMatch(/^AWS4-HMAC-SHA256 /);
  expect(JSON.stringify(checks)).not.toContain(env.R2_SECRET_ACCESS_KEY);
  expect(
    await env.DB.prepare(
      "SELECT value_json FROM service_settings WHERE key='public_base_url'",
    ).first('value_json'),
  ).toBe(JSON.stringify('https://mawjivo.service.test'));
});
test('a_bad_r2_key_leaves_service_unready_and_foreign_marker_is_not_overwritten', async () => {
  const env = testEnv();
  await env.DB.prepare(
    "INSERT INTO service_settings(key,value_json,updated_at_ms) VALUES('owner_service_id',?,1)",
  )
    .bind(JSON.stringify(env.SERVICE_ID))
    .run();
  const fetcher: typeof fetch = async () => new Response('', { status: 403 });
  await expect(initializeService(admin, env, fetcher)).rejects.toMatchObject({
    code: 'R2_CREDENTIALS_INVALID',
  });
  expect(
    await env.DB.prepare("SELECT value_json FROM service_settings WHERE key='initialized'").first(),
  ).toBeNull();
  await env.MEDIA.put('mawjivo/owner-service-id', 'foreign-service');
  await expect(initializeService(admin, env, fetcher)).rejects.toMatchObject({
    code: 'RESOURCE_NOT_OWNED',
  });
  expect(await (await env.MEDIA.get('mawjivo/owner-service-id'))!.text()).toBe('foreign-service');
});
