import { exports } from 'cloudflare:workers';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { getCapabilities, saveConnections } from '../src/connections';
import { discoverChannels } from '../src/providers/types';
import { resetTestData, testEnv, requestAs, ownerToken, limitedToken } from './helpers';
const auth = { deviceId: 'owner', allowedWorkspaceIds: '*' as const };
const buffer = (label: string) => ({
  provider: 'buffer' as const,
  label,
  credentials: { apiKey: 'synthetic-' + label },
});
const meta = {
  provider: 'meta' as const,
  label: 'Meta',
  credentials: {
    pageId: '12345',
    instagramId: '67890',
    pageAccessToken: 'synthetic-page',
    userAccessToken: 'synthetic-user',
  },
};
let disconnected = false,
  missingScope = false,
  expired = false,
  wrongPage = false;
let providerFetch: MockInstance<typeof globalThis.fetch>;
beforeEach(async () => {
  await resetTestData();
  disconnected = missingScope = expired = wrongPage = false;
  providerFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init?.headers);
    if (url === 'https://api.buffer.com') {
      const body = JSON.parse(String(init?.body)) as { query: string };
      if (body.query.includes('account'))
        return Response.json({
          data: {
            account: {
              organizations: [
                {
                  id: 'org-synthetic',
                  name: 'Personal',
                  limits: { scheduledThreadsPerChannel: 1, scheduledPosts: 10 },
                },
              ],
            },
          },
        });
      const services = headers.get('Authorization')?.endsWith('first')
        ? ['youtube', 'threads']
        : ['tiktok', 'twitter'];
      return Response.json({
        data: {
          c0: services.map((service) => ({
            id: 'remote-' + service,
            name: 'My ' + service,
            service,
            isLocked: false,
            isDisconnected: disconnected,
            allowedActions: ['manageUpdates', 'scheduleUpdates'],
            type: 'profile',
          })),
          f0: {
            channels: services.map((service) => ({
              channelId: 'remote-' + service,
              service,
              authorizationStatus: [{ feature: 'posting', status: 'ok' }],
              content: [
                {
                  configurationContentTypes: ['comment'],
                  supportedProperties: ['text'],
                  rules: [],
                },
              ],
            })),
          },
        },
      });
    }
    expect(url).toMatch(/^https:\/\/graph.facebook.com\/v26.0\//);
    if (expired)
      return Response.json(
        { error: { code: 190, message: 'unsafe synthetic-page' } },
        { status: 400 },
      );
    if (url.includes('/me/permissions')) {
      expect(headers.get('Authorization')).toBe('Bearer synthetic-user');
      return Response.json({
        data: [
          'pages_show_list',
          'pages_read_engagement',
          'pages_manage_posts',
          'instagram_basic',
          'instagram_content_publish',
        ]
          .filter((scope) => !missingScope || scope !== 'pages_manage_posts')
          .map((permission) => ({ permission, status: 'granted' })),
      });
    }
    if (url.includes('/me/accounts')) {
      expect(headers.get('Authorization')).toBe('Bearer synthetic-user');
      return Response.json({ data: [{ id: '12345', name: 'My Page', tasks: ['CREATE_CONTENT'] }] });
    }
    if (url.includes('/12345?')) {
      expect(headers.get('Authorization')).toBe('Bearer synthetic-page');
      return Response.json({
        id: wrongPage ? '99999' : '12345',
        name: 'My Page',
        instagram_business_account: { id: '67890', username: 'my_instagram' },
      });
    }
    if (url.includes('/67890?'))
      return Response.json({ id: '67890', username: 'my_instagram', account_type: 'BUSINESS' });
    throw new Error('Unexpected synthetic provider URL');
  });
});
afterEach(() => vi.restoreAllMocks());
test('two_buffer_clients_map_four_channels_correctly', async () => {
  const checks = await saveConnections(
    auth,
    'workspace-a',
    [buffer('first'), buffer('second')],
    testEnv(),
  );
  const caps = await getCapabilities(auth, 'workspace-a', testEnv());
  expect(caps.channels.map((c) => c.platform).sort()).toEqual([
    'threads',
    'tiktok',
    'x',
    'youtube',
  ]);
  expect(caps.channels.every((c) => c.ready)).toBe(true);
  expect(checks.every((c) => c.state === 'ready')).toBe(true);
  expect(new Set(caps.channels.map((c) => c.connectionId)).size).toBe(2);
});
test('facebook_instagram_share_page_link_but_not_token_types', async () => {
  const channels = await discoverChannels(
    { ...meta, id: 'meta-connection', workspaceId: 'workspace-a' },
    testEnv(),
  );
  expect(channels.map((c) => c.platform)).toEqual(['facebook', 'instagram']);
  expect(channels.every((c) => c.ready)).toBe(true);
  expect(channels[1]?.limits.image?.mimeTypes).toEqual(['image/jpeg']);
});
test('expired_or_missing_scope_is_not_ready', async () => {
  missingScope = true;
  let channels = await discoverChannels(
    { ...meta, id: 'meta-connection', workspaceId: 'workspace-a' },
    testEnv(),
  );
  expect(channels.find((c) => c.platform === 'facebook')?.ready).toBe(false);
  expect(channels.find((c) => c.platform === 'instagram')?.ready).toBe(true);
  missingScope = false;
  expired = true;
  channels = await discoverChannels(
    { ...meta, id: 'meta-connection', workspaceId: 'workspace-a' },
    testEnv(),
  );
  expect(channels.every((c) => !c.ready)).toBe(true);
});
test('foreign_page_token_is_rejected_despite_matching_user_permissions', async () => {
  wrongPage = true;
  const channels = await discoverChannels(
    { ...meta, id: 'meta-connection', workspaceId: 'workspace-a' },
    testEnv(),
  );
  expect(channels).toHaveLength(2);
  expect(channels.every((c) => !c.ready)).toBe(true);
});
test('unconnected_buffer_fallback_is_not_selectable', async () => {
  disconnected = true;
  await saveConnections(auth, 'workspace-a', [buffer('second')], testEnv());
  const caps = await getCapabilities(auth, 'workspace-a', testEnv());
  expect(caps.channels).toHaveLength(2);
  expect(caps.channels.every((c) => !c.ready)).toBe(true);
  const response = await exports.default.fetch(
    requestAs(
      ownerToken,
      '/api/workspaces/workspace-a',
      {
        name: 'Test',
        timeZone: 'Africa/Cairo',
        serviceProfileId: 'profile-1',
        defaultPlatforms: ['x'],
        preferredChannels: { x: caps.channels.find((c) => c.platform === 'x')!.id },
        expectedVersion: 1,
      },
      'PATCH',
    ),
  );
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ code: 'CHANNEL_NOT_READY' });
});
test('cached_channels_do_not_refetch_on_new_window', async () => {
  await saveConnections(auth, 'workspace-a', [buffer('first')], testEnv());
  const calls = providerFetch.mock.calls.length;
  const first = await getCapabilities(auth, 'workspace-a', testEnv());
  const second = await getCapabilities(auth, 'workspace-a', testEnv());
  expect(providerFetch.mock.calls).toHaveLength(calls);
  expect(first).toEqual(second);
  expect(calls).toBe(2);
});
test('free_threads_limit_is_exposed_before_confirm', async () => {
  await saveConnections(auth, 'workspace-a', [buffer('first')], testEnv());
  const channel = (await getCapabilities(auth, 'workspace-a', testEnv())).channels.find(
    (c) => c.platform === 'threads',
  )!;
  expect(channel.limits.threadParts).toBe(25);
  expect(channel.limits.scheduledThreadsPerChannel).toBe(1);
});
test('credentials_are_encrypted_and_never_returned', async () => {
  await saveConnections(auth, 'workspace-a', [buffer('first')], testEnv());
  const row = await testEnv()
    .DB.prepare('SELECT secret_cipher FROM connections')
    .first<{ secret_cipher: string }>();
  expect(row?.secret_cipher).not.toContain('synthetic-first');
  const response = await exports.default.fetch(
    requestAs(ownerToken, '/api/workspaces/workspace-a/connections'),
  );
  const text = await response.text();
  expect(response.status).toBe(200);
  expect(text).not.toContain('synthetic-first');
  expect(text).not.toContain('secret_cipher');
  const foreign = await exports.default.fetch(
    requestAs(limitedToken, '/api/workspaces/workspace-b/connections', [buffer('first')]),
  );
  expect(foreign.status).toBe(403);
});
test('workspace_preferred_channel_survives_reload_and_stale_edit', async () => {
  await saveConnections(auth, 'workspace-a', [buffer('second')], testEnv());
  const channel = (await getCapabilities(auth, 'workspace-a', testEnv())).channels.find(
    (c) => c.platform === 'x',
  )!;
  const input = {
    name: 'New',
    timeZone: 'Africa/Cairo',
    serviceProfileId: 'profile-1',
    defaultPlatforms: ['x'],
    preferredChannels: { x: channel.id },
    expectedVersion: 1,
  };
  const first = await exports.default.fetch(
    requestAs(ownerToken, '/api/workspaces/workspace-a', input, 'PATCH'),
  );
  expect(first.status).toBe(200);
  const second = await exports.default.fetch(
    requestAs(
      ownerToken,
      '/api/workspaces/workspace-a',
      { ...input, preferredChannels: {} },
      'PATCH',
    ),
  );
  expect(second.status).toBe(409);
  const saved = await exports.default.fetch(requestAs(ownerToken, '/api/workspaces/workspace-a'));
  expect(await saved.json()).toMatchObject({ preferredChannels: { x: channel.id }, version: 2 });
});
test('expired_cache_and_explicit_refresh_recheck_channels', async () => {
  await saveConnections(auth, 'workspace-a', [buffer('first')], testEnv());
  const first = await getCapabilities(auth, 'workspace-a', testEnv());
  await testEnv()
    .DB.prepare("UPDATE service_settings SET value_json=? WHERE key='capabilities:workspace-a'")
    .bind(JSON.stringify({ ...first, fetchedAt: '2020-01-01T00:00:00Z' }))
    .run();
  await getCapabilities(auth, 'workspace-a', testEnv());
  expect(providerFetch.mock.calls).toHaveLength(4);
  await getCapabilities(auth, 'workspace-a', testEnv(), true);
  expect(providerFetch.mock.calls).toHaveLength(6);
});
test('buffer_facebook_groups_and_personal_instagram_are_not_automatic_fallbacks', async () => {
  providerFetch.mockImplementation(async () =>
    Response.json({
      data: {
        account: {
          organizations: [
            { id: 'org', limits: { scheduledThreadsPerChannel: 1, scheduledPosts: 10 } },
          ],
        },
        c0: [
          {
            id: 'page',
            name: 'Page',
            service: 'facebook',
            type: 'page',
            isLocked: false,
            isDisconnected: false,
            allowedActions: ['manageUpdates', 'scheduleUpdates'],
          },
          {
            id: 'group',
            name: 'Group',
            service: 'facebook',
            type: 'group',
            isLocked: false,
            isDisconnected: false,
            allowedActions: ['manageUpdates', 'scheduleUpdates'],
          },
          {
            id: 'ig-business',
            name: 'IG business',
            service: 'instagram',
            type: 'business',
            isLocked: false,
            isDisconnected: false,
            allowedActions: ['manageUpdates', 'scheduleUpdates'],
            metadata: { defaultToReminders: false },
          },
          {
            id: 'ig-personal',
            name: 'IG personal',
            service: 'instagram',
            type: 'profile',
            isLocked: false,
            isDisconnected: false,
            allowedActions: ['manageUpdates', 'scheduleUpdates'],
            metadata: { defaultToReminders: true },
          },
        ],
        f0: {
          channels: ['page', 'group', 'ig-business', 'ig-personal'].map((channelId) => ({
            channelId,
            authorizationStatus: [{ feature: 'posting', status: 'ok' }],
          })),
        },
      },
    }),
  );
  const channels = await discoverChannels(
    { ...buffer('first'), id: 'buffer', workspaceId: 'workspace-a' },
    testEnv(),
  );
  expect(
    channels
      .filter((c) => c.ready)
      .map((c) => c.remoteId)
      .sort(),
  ).toEqual(['ig-business', 'page']);
});
test('meta_video_permissions_use_the_page_route_not_obsolete_publish_video', async () => {
  const channels = await discoverChannels(
    { ...meta, id: 'meta', workspaceId: 'workspace-a' },
    testEnv(),
  );
  expect(channels.find((c) => c.platform === 'facebook')?.limits.supportedKinds).toContain('video');
  expect(channels.find((c) => c.platform === 'instagram')?.limits.video?.maxDurationMs).toBe(
    900_000,
  );
  expect(channels.find((c) => c.platform === 'instagram')?.limits.altKinds).toEqual(['image']);
});
test('first_invalid_buffer_key_reports_an_actionable_failure_without_echoing_token', async () => {
  providerFetch.mockResolvedValue(Response.json({ error: 'synthetic-first' }, { status: 401 }));
  const checks = await saveConnections(auth, 'workspace-a', [buffer('first')], testEnv());
  expect(checks[0]?.code).toBe('PROVIDER_AUTH');
  expect(checks[0]?.messageAr).toContain('الرمز');
  expect(JSON.stringify(checks)).not.toContain('synthetic-first');
  const saved = await exports.default.fetch(
    requestAs(ownerToken, '/api/workspaces/workspace-a/connections'),
  );
  expect(await saved.json()).toMatchObject([{ readiness: [{ code: 'PROVIDER_AUTH' }] }]);
});
test('facebook_login_instagram_user_does_not_query_instagram_login_only_fields', async () => {
  const previous = providerFetch.getMockImplementation()!;
  providerFetch.mockImplementation(async (input, init) =>
    String(input).includes('/67890?') && String(input).includes('account_type')
      ? Response.json({ error: { code: 100 } }, { status: 400 })
      : previous(input, init),
  );
  const channels = await discoverChannels(
    { ...meta, id: 'meta', workspaceId: 'workspace-a' },
    testEnv(),
  );
  expect(channels.find((c) => c.platform === 'instagram')?.ready).toBe(true);
});
test('instagram_permission_failure_does_not_disable_a_verified_facebook_page', async () => {
  const previous = providerFetch.getMockImplementation()!;
  providerFetch.mockImplementation(async (input, init) =>
    String(input).includes('/67890?')
      ? Response.json({ error: { code: 200 } }, { status: 403 })
      : previous(input, init),
  );
  const channels = await discoverChannels(
    { ...meta, id: 'meta', workspaceId: 'workspace-a' },
    testEnv(),
  );
  expect(channels.find((c) => c.platform === 'facebook')?.ready).toBe(true);
  expect(channels.find((c) => c.platform === 'instagram')?.ready).toBe(false);
});
test('two_windows_saving_the_same_named_connection_do_not_create_duplicate_accounts', async () => {
  await Promise.allSettled([
    saveConnections(auth, 'workspace-a', [buffer('first')], testEnv()),
    saveConnections(auth, 'workspace-a', [buffer('first')], testEnv()),
  ]);
  const saved = await testEnv()
    .DB.prepare('SELECT id FROM connections WHERE workspace_id=?')
    .bind('workspace-a')
    .all();
  expect(saved.results).toHaveLength(1);
});
