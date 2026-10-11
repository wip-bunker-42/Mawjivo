import test from 'node:test';
import assert from 'node:assert/strict';
import { setupHealthchecks } from '../setup-healthchecks.mjs';
test('healthchecks_uses_tagged_upserts_and_email_with_no_runtime_management_key', async () => {
  const original = globalThis.fetch,
    calls = [],
    checks = new Map();
  globalThis.fetch = async (url, input) => {
    calls.push({ url, input });
    if (url.endsWith('/channels/'))
      return Response.json({
        channels: [
          { id: 'email-id', kind: 'email' },
          { id: 'tg-id', kind: 'telegram' },
        ],
      });
    if (url.includes('checks/?slug='))
      return Response.json({
        checks: [...checks.values()].filter(
          (check) => check.slug === new URL(url).searchParams.get('slug'),
        ),
      });
    const data = JSON.parse(input.body);
    if (!checks.has(data.slug))
      checks.set(data.slug, {
        ...data,
        uuid: '00000000-0000-4000-8000-' + String(checks.size + 1).padStart(12, '0'),
        ping_url:
          'https://hc-ping.com/00000000-0000-4000-8000-' +
          String(checks.size + 1).padStart(12, '0'),
      });
    return Response.json(checks.get(data.slug), { status: 201 });
  };
  try {
    const first = await setupHealthchecks(
      'owner-service',
      'synthetic-management-secret',
      'Africa/Cairo',
    );
    const second = await setupHealthchecks(
      'owner-service',
      'synthetic-management-secret',
      'Africa/Cairo',
    );
    assert.equal(checks.size, 2);
    assert.equal(first.heartbeatPingUrl, second.heartbeatPingUrl);
    assert.equal(first.heartbeatPeriodSeconds, 300);
    assert.equal(first.heartbeatGraceSeconds, 600);
    assert.equal(first.dailyGraceSeconds, 900);
    assert.equal(first.integrationState, 'email-ready');
    assert.ok(!JSON.stringify(first).includes('synthetic-management-secret'));
    const payloads = calls
      .filter((c) => c.input?.method === 'POST')
      .map((c) => JSON.parse(c.input.body));
    assert.ok(
      payloads.every(
        (p) =>
          p.channels === 'email-id' &&
          p.tags.includes('owner-service') &&
          p.unique.includes('slug'),
      ),
    );
    assert.ok(payloads.some((p) => p.schedule === '0 0 * * *' && p.tz === 'Africa/Cairo'));
  } finally {
    globalThis.fetch = original;
  }
});
