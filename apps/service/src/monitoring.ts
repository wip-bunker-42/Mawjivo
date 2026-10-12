import type { ISOInstant, ReadinessItem } from '@mawjivo/core';
import { Temporal } from '@js-temporal/polyfill';
import { drainDispatchOutbox, aggregatePost, getPublicationReceipt, type PostRow } from './posts';
import { collectExpiredAssets } from './assets/retention';
import { evaluateDailySummaries } from './reports/daily';
import { sendReport, failureReport } from './reports/telegram';
import { facebookLikeError } from './providers/meta';
export interface MonitorResult {
  serviceHealthy: boolean;
  dailyEvaluated: boolean;
  readiness: ReadinessItem[];
}
const systemAuth = { deviceId: 'monitor', allowedWorkspaceIds: '*' as const };
async function tick(key: string, value: string, now: number, env: Env): Promise<boolean> {
  const owned = await env.DB.prepare(
    'INSERT INTO service_settings(key,value_json,updated_at_ms) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at_ms=excluded.updated_at_ms WHERE service_settings.value_json!=excluded.value_json',
  )
    .bind(key, JSON.stringify(value), now)
    .run();
  return owned.meta.changes > 0;
}
async function ping(base: string | undefined, suffix = ''): Promise<boolean> {
  if (!base) return true;
  if (!/^https:\/\/hc-ping\.com\/[a-f0-9-]{36}$/.test(base)) return false;
  try {
    const response = await fetch(base + suffix, {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(10000),
    });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}
async function recoverProgress(now: number, env: Env): Promise<boolean> {
  let healthy = true;
  const candidates = await env.DB.prepare(
    "SELECT DISTINCT p.* FROM targets t JOIN posts p ON p.id=t.post_id AND p.revision=t.revision WHERE t.state IN ('sending','accepted','ready') AND t.updated_at_ms<? AND (t.next_check_ms IS NULL OR t.next_check_ms<=?) AND (p.due_at_ms IS NULL OR p.due_at_ms<=?) ORDER BY p.updated_at_ms LIMIT 10",
  )
    .bind(now - 300000, now, now)
    .all<PostRow>();
  for (const post of candidates.results) {
    if (!post.workflow_id) {
      healthy = false;
      continue;
    }
    let status: string;
    try {
      status = (await (await env.PUBLISH.get(post.workflow_id)).status()).status;
    } catch {
      healthy = false;
      continue;
    }
    if (!['complete', 'errored', 'terminated'].includes(status)) {
      if (post.updated_at_ms < now - 900000) healthy = false;
      continue;
    }
    // A stopped write cannot be proven rejected. Never turn it back into a new write.
    await env.DB.prepare(
      "UPDATE targets SET state='uncertain',error_json=?,updated_at_ms=? WHERE post_id=? AND revision=? AND (state='sending' OR (state='accepted' AND continuation_claim_id IS NOT NULL AND continuation_rejected=0 AND COALESCE(json_extract(provider_state_json,'$.publishedId'),'')=''))",
    )
      .bind(
        JSON.stringify({
          code: 'PUBLICATION_UNCERTAIN',
          messageAr: 'توقف عمل الخدمة أثناء الإرسال. افحص المنصة قبل إعادة النشر.',
          retryable: false,
        }),
        now,
        post.id,
        post.revision,
      )
      .run();
    await aggregatePost(post.id, post.revision, env);
    const work = await env.DB.prepare(
      "SELECT SUM(state='accepted') AS accepted,SUM(state='ready' AND claim_id IS NULL AND (next_check_ms IS NULL OR next_check_ms<=?)) AS ready FROM targets WHERE post_id=? AND revision=?",
    )
      .bind(now, post.id, post.revision)
      .first<{ accepted: number; ready: number }>();
    if (!work?.accepted && (!work?.ready || post.cancel_requested_ms !== null)) continue;
    const jobId = `post-${post.id}-r${post.revision}-g${post.dispatch_generation + 1}-${crypto.randomUUID()}`;
    // CAS ties the outbox rewrite to one winner. Existing accepted ids and target claims are retained.
    const results = await env.DB.batch([
      env.DB.prepare(
        'UPDATE posts SET workflow_id=?,dispatch_generation=dispatch_generation+1,updated_at_ms=? WHERE id=? AND revision=? AND workflow_id=? AND dispatch_generation=?',
      ).bind(jobId, now, post.id, post.revision, post.workflow_id, post.dispatch_generation),
      env.DB.prepare(
        "UPDATE dispatch_outbox SET workflow_id=?,receipts_only=?,state='pending',next_attempt_ms=?,claim_id=NULL,claimed_at_ms=NULL,attempt_count=0,error_code=NULL WHERE post_id=? AND revision=? AND action='create' AND EXISTS(SELECT 1 FROM posts WHERE id=? AND workflow_id=?)",
      ).bind(
        jobId,
        work.accepted > 0 || post.cancel_requested_ms !== null ? 1 : 0,
        now,
        post.id,
        post.revision,
        post.id,
        jobId,
      ),
    ]);
    if (results[0]!.meta.changes) await drainDispatchOutbox(new Date(now).toISOString(), env);
  }
  return healthy;
}
async function notifyOutcomes(now: number, env: Env): Promise<void> {
  await env.DB.prepare(
    "UPDATE targets SET facebook_like_state='unknown',error_json=?,updated_at_ms=? WHERE state='published' AND facebook_like_state='sending' AND facebook_like_claimed_at_ms<?",
  )
    .bind(JSON.stringify(facebookLikeError(true)), now, now - 300000)
    .run();
  const rows = await env.DB.prepare(
    "SELECT t.post_id,t.revision,t.workspace_id,p.plan_json FROM targets t JOIN post_revisions p ON p.post_id=t.post_id AND p.revision=t.revision WHERE t.state IN ('failed','uncertain') AND NOT EXISTS(SELECT 1 FROM report_outbox r WHERE r.workspace_id=t.workspace_id AND r.dedupe_key='target:'||t.post_id||':'||t.revision||':'||t.channel_id||':'||t.state||':'||COALESCE(json_extract(t.error_json,'$.code'),'PROVIDER_FAILED')) GROUP BY t.post_id,t.revision,t.workspace_id LIMIT 20",
  ).all<{ post_id: string; revision: number; workspace_id: string; plan_json: string }>();
  for (const row of rows.results) {
    const receipt = await getPublicationReceipt(systemAuth, row.post_id, env, row.revision);
    for (const target of receipt.targets)
      if (['failed', 'uncertain'].includes(target.state))
        await sendReport(
          failureReport(
            row.workspace_id,
            row.post_id,
            row.revision,
            target,
            JSON.parse(row.plan_json).targets[0]?.title ||
              JSON.parse(row.plan_json).targets[0]?.text,
          ),
          env,
        );
  }
  const likes = await env.DB.prepare(
    "SELECT t.post_id,t.revision,t.workspace_id,p.plan_json FROM targets t JOIN post_revisions p ON p.post_id=t.post_id AND p.revision=t.revision WHERE t.state='published' AND t.facebook_like_state IN ('failed','unknown') AND NOT EXISTS(SELECT 1 FROM report_outbox r WHERE r.workspace_id=t.workspace_id AND r.dedupe_key='facebook-like:'||t.post_id||':'||t.revision||':'||t.channel_id||':'||json_extract(t.error_json,'$.code')) GROUP BY t.post_id,t.revision,t.workspace_id LIMIT 20",
  ).all<{ post_id: string; revision: number; workspace_id: string; plan_json: string }>();
  for (const row of likes.results) {
    const receipt = await getPublicationReceipt(systemAuth, row.post_id, env, row.revision);
    for (const target of receipt.targets)
      if (
        target.state === 'published' &&
        ['FACEBOOK_LIKE_FAILED', 'FACEBOOK_LIKE_UNCERTAIN'].includes(target.error?.code ?? '')
      )
        await sendReport(
          failureReport(
            row.workspace_id,
            row.post_id,
            row.revision,
            target,
            JSON.parse(row.plan_json).targets[0]?.title ||
              JSON.parse(row.plan_json).targets[0]?.text,
          ),
          env,
        );
  }
  const recoveries = await env.DB.prepare(
    "SELECT t.post_id,t.revision,t.workspace_id,t.channel_id,c.platform FROM targets t JOIN channels c ON c.id=t.channel_id WHERE t.state='published' AND EXISTS(SELECT 1 FROM report_outbox r WHERE r.workspace_id=t.workspace_id AND r.kind='failure' AND substr(r.dedupe_key,1,length('target:'||t.post_id||':'||t.revision||':'||t.channel_id||':'))='target:'||t.post_id||':'||t.revision||':'||t.channel_id||':') AND NOT EXISTS(SELECT 1 FROM report_outbox r WHERE r.workspace_id=t.workspace_id AND r.dedupe_key='recovery:'||t.post_id||':'||t.revision||':'||t.channel_id) LIMIT 20",
  ).all<{
    post_id: string;
    revision: number;
    workspace_id: string;
    channel_id: string;
    platform: string;
  }>();
  for (const row of recoveries.results)
    await sendReport(
      {
        workspaceId: row.workspace_id,
        dedupeKey: `recovery:${row.post_id}:${row.revision}:${row.channel_id}`,
        kind: 'recovery',
        textAr: `Mawjivo — حُسمت نتيجة ${row.platform}: نُشر المنشور ${row.post_id}.`,
      },
      env,
    );
  const pending = await env.DB.prepare(
    "SELECT workspace_id,dedupe_key,kind,text_ar FROM report_outbox WHERE (state='pending' AND next_attempt_ms<=?) OR (state='sending' AND claimed_at_ms<?) ORDER BY updated_at_ms LIMIT 10",
  )
    .bind(now, now - 60000)
    .all<{
      workspace_id: string;
      dedupe_key: string;
      kind: 'failure' | 'daily' | 'recovery';
      text_ar: string;
    }>();
  for (const row of pending.results)
    await sendReport(
      {
        workspaceId: row.workspace_id,
        dedupeKey: row.dedupe_key,
        kind: row.kind,
        textAr: row.text_ar,
      },
      env,
    );
}
export async function runMonitor(instant: ISOInstant, env: Env): Promise<MonitorResult> {
  const now = Date.parse(instant),
    result: MonitorResult = { serviceHealthy: true, dailyEvaluated: false, readiness: [] };
  if (!Number.isSafeInteger(now)) throw new Error('INVALID_MONITOR_TIME');
  const heartbeatDue = Math.floor(now / 60000) % 5 === 0;
  let heartbeatClaimed = false;
  try {
    if (heartbeatDue)
      heartbeatClaimed = await tick(
        'monitor:heartbeat',
        String(Math.floor(now / 300000)),
        now,
        env,
      );
    await env.DB.prepare('SELECT 1 AS ok').first();
    const marker = await env.MEDIA.get('mawjivo/owner-service-id');
    if (!marker || (await marker.text()) !== env.SERVICE_ID) result.serviceHealthy = false;
    // Test both writing and reading the binding with a private, stable tiny object.
    if (heartbeatClaimed) {
      const probe = 'mawjivo/monitor-probe';
      await env.MEDIA.put(probe, env.SERVICE_ID);
      const read = await env.MEDIA.get(probe);
      if (!read || (await read.text()) !== env.SERVICE_ID) result.serviceHealthy = false;
    }
    await drainDispatchOutbox(instant, env);
    if (!(await recoverProgress(now, env))) result.serviceHealthy = false;
    await notifyOutcomes(now, env);
    await evaluateDailySummaries(instant, env);
    result.dailyEvaluated = !(await env.DB.prepare(
      'SELECT 1 AS overdue FROM workspace_daily WHERE next_due_ms<=? LIMIT 1',
    )
      .bind(now)
      .first());
    if (
      Math.floor(now / 60000) % 60 === 0 &&
      (await tick('monitor:cleanup', String(Math.floor(now / 3600000)), now, env))
    ) {
      const cleanup = await collectExpiredAssets(instant, env);
      if (cleanup.failedCount)
        result.readiness.push({
          code: 'MEDIA_CLEANUP',
          state: 'needsAction',
          messageAr: 'تعذر حذف بعض الملفات المنتهية؛ ستعاد المحاولة.',
        });
    }
  } catch {
    result.serviceHealthy = false;
  }
  if (heartbeatDue && (heartbeatClaimed || !result.serviceHealthy)) {
    await ping(env.HEARTBEAT_PING_URL, '/start');
    if (!(await ping(env.HEARTBEAT_PING_URL, result.serviceHealthy ? '' : '/fail')))
      result.readiness.push({
        code: 'HEALTHCHECKS',
        state: 'needsAction',
        messageAr: 'تعذر إرسال نبضة المراقبة الخارجية.',
      });
  }
  const local = Temporal.Instant.fromEpochMilliseconds(now).toZonedDateTimeISO(
    env.MONITOR_TIME_ZONE ?? 'Africa/Cairo',
  );
  if (local.hour === 0 && local.minute < 15) {
    const date = local.toPlainDate().toString();
    try {
      const previous = await env.DB.prepare(
        "SELECT value_json FROM service_settings WHERE key='monitor:daily-success'",
      ).first<{ value_json: string }>();
      if (
        previous?.value_json !== JSON.stringify(date) &&
        (await tick('monitor:daily-attempt', String(Math.floor(now / 60000)), now, env))
      ) {
        await ping(env.DAILY_PING_URL, '/start');
        const success = await ping(env.DAILY_PING_URL, result.dailyEvaluated ? '' : '/fail');
        if (success && result.dailyEvaluated) await tick('monitor:daily-success', date, now, env);
      }
    } catch {
      await ping(env.DAILY_PING_URL, '/fail');
    }
  }
  result.readiness.push({
    code: 'SERVICE_PROGRESS',
    state: result.serviceHealthy ? 'ready' : 'failed',
    messageAr: result.serviceHealthy
      ? 'الخدمة والتخزين ومتابعة النشر تعمل.'
      : 'تعذر فحص الخدمة أو توجد مهام بلا تقدم. راجع المراقبة وتفاصيل المنشورات.',
  });
  return result;
}
