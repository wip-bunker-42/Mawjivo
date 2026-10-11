import { beforeEach, afterEach, test, expect, vi } from 'vitest';
import { sendReport, failureReport } from '../src/reports/telegram';
import { saveTelegramSettings } from '../src/reports/settings';
import { evaluateDailySummaries } from '../src/reports/daily';
import { resetTestData, testEnv } from './helpers';
import { auth, publicationFixture } from './publication-fixture';
import { submitPost } from '../src/posts';
const botToken = '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
beforeEach(async () => {
  await resetTestData();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-11T20:50:00Z'));
  await testEnv()
    .DB.prepare('UPDATE workspaces SET created_at_ms=?,updated_at_ms=?')
    .bind(Date.now(), Date.now())
    .run();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const settings = () =>
  saveTelegramSettings(auth, 'workspace-a', { botToken, chatId: '123456', daily: true }, testEnv());
test('telegram_timeout_not_retried_blindly', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('timeout ' + botToken));
  await settings();
  const report = {
    workspaceId: 'workspace-a',
    dedupeKey: 'timeout-test',
    kind: 'failure' as const,
    textAr: 'تعذر النشر. افحص المنصة.',
  };
  expect(await sendReport(report, testEnv())).toMatchObject({ kind: 'uncertain' });
  expect(await sendReport(report, testEnv())).toMatchObject({ kind: 'uncertain' });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
test('midnight_active_day_sends_once', async () => {
  const fetcher = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(Response.json({ ok: true, result: { message_id: 41 } }));
  await settings();
  const fixture = await publicationFixture();
  await submitPost(auth, await fixture.submission(), fixture.env);
  const first = await evaluateDailySummaries('2026-10-11T21:00:00Z', testEnv());
  await evaluateDailySummaries('2026-10-11T21:01:00Z', testEnv());
  expect(first.sent).toBe(1);
  expect(fetcher).toHaveBeenCalledTimes(1);
  const body = JSON.parse(String(fetcher.mock.calls[0]![1]!.body));
  expect(body.text).toContain('2026-10-11');
});
test('inactive_day_pings_but_sends_no_summary', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch');
  await settings();
  const result = await evaluateDailySummaries('2026-10-11T21:00:00Z', testEnv());
  expect(result.inactive).toBe(2);
  expect(result.unresolved).toBe(0);
  expect(fetcher).not.toHaveBeenCalled();
});
test('daily_monitor_timezone_does_not_change_workspace_midnight', async () => {
  const fetcher = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(Response.json({ ok: true, result: { message_id: 42 } }));
  await settings();
  const fixture = await publicationFixture();
  await submitPost(auth, await fixture.submission(), fixture.env);
  const env = { ...testEnv(), MONITOR_TIME_ZONE: 'America/New_York' };
  expect((await evaluateDailySummaries('2026-10-11T20:59:00Z', env)).sent).toBe(0);
  expect((await evaluateDailySummaries('2026-10-11T21:00:00Z', env)).sent).toBe(1);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
test('provider_error_report_has_action_and_no_secret', () => {
  const report = failureReport('workspace-a', 'post-a', 1, {
    channelId: 'ch-a',
    platform: 'instagram',
    state: 'failed',
    error: { code: 'PROVIDER_AUTH', messageAr: 'raw-secret=' + botToken, retryable: false },
  });
  expect(report.textAr).toContain('Instagram');
  expect(report.textAr).toContain('الربط');
  expect(report.textAr).not.toContain(botToken);
  expect(report.textAr).not.toContain('raw-secret');
});
