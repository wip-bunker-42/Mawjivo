import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyProduction } from '../verify-production.mjs';
function boundary({
  ready = true,
  monitor = true,
  platforms = ['facebook', 'instagram', 'threads', 'x', 'youtube', 'tiktok'],
} = {}) {
  const calls = [];
  return {
    calls,
    read: async (request) => {
      calls.push(request);
      assert.equal(request.method, 'GET');
      if (request.path === '/api/workspaces') return [{ id: 'a' }];
      if (request.path === '/api/monitoring')
        return { configured: monitor, lastCheckedAt: '2026-10-12T00:00:00Z', readiness: [] };
      if (request.path.endsWith('/capabilities'))
        return {
          channels: platforms.map((platform) => ({
            platform,
            ready,
            limits: { supportedKinds: ['text'], textMax: 280 },
          })),
        };
      if (request.path.endsWith('/telegram'))
        return { configured: true, botToken: 'must-never-appear', reports: [] };
      throw new Error('Unexpected read');
    },
    probe: async ({ method, headers }) => ({
      status: headers?.Range ? 206 : 200,
      body: method === 'GET' && !headers ? { state: 'ready' } : null,
      headers: { 'content-length': headers?.Range ? '4' : '32', 'content-range': 'bytes 0-3/32' },
      bytes: headers?.Range ? 4 : 32,
    }),
  };
}
test('production verification reads service and media without publishing or leaking credentials', async () => {
  const io = boundary();
  const report = await verifyProduction(
    {
      profileId: 'p',
      baseUrl: 'https://service.test',
      mediaUrls: ['https://service.test/media/' + 'a'.repeat(64) + '/photo.PNG'],
    },
    io,
  );
  assert.equal(report.passed, true);
  assert.equal(report.readyPlatforms, 6);
  assert.equal(report.mediaVerified, 1);
  assert.equal(JSON.stringify(report).includes('must-never-appear'), false);
  assert.equal(
    io.calls.some((call) => call.path.includes('/posts')),
    false,
  );
});
test('missing platform or monitoring fails verification with useful Arabic findings', async () => {
  const report = await verifyProduction(
    { profileId: 'p', baseUrl: 'https://service.test', mediaUrls: [] },
    boundary({ monitor: false, platforms: ['x'] }),
  );
  assert.equal(report.passed, false);
  assert.ok(report.findings.some((item) => item.code === 'PLATFORMS_INCOMPLETE'));
  assert.ok(report.findings.some((item) => item.code === 'MONITORING_NOT_READY'));
  assert.ok(
    report.findings.every(
      (item) => typeof item.messageAr === 'string' && item.messageAr.length > 0,
    ),
  );
});
test('a wrong media range and a foreign URL are never accepted as owner delivery evidence', async () => {
  const io = boundary();
  io.probe = async () => ({
    status: 200,
    body: { state: 'ready' },
    headers: { 'content-length': '32' },
    bytes: 32,
  });
  const report = await verifyProduction(
    {
      profileId: 'p',
      baseUrl: 'https://service.test',
      mediaUrls: [
        'https://service.test/media/' + 'a'.repeat(64) + '/photo.PNG',
        'https://foreign.test/a',
      ],
    },
    io,
  );
  assert.equal(report.passed, false);
  assert.equal(report.mediaVerified, 0);
  assert.ok(report.findings.some((item) => item.code === 'MEDIA_DELIVERY_FAILED'));
  assert.ok(report.findings.some((item) => item.code === 'MEDIA_SCOPE'));
});
