import type { ISOInstant } from '@mawjivo/core';
import { Temporal } from '@js-temporal/polyfill';
import { getSummary } from '../history';
import { sendReport } from './telegram';
import { telegramSettings } from './settings';
export interface DailyEvaluation {
  evaluated: number;
  sent: number;
  inactive: number;
  unresolved: number;
}
export async function evaluateDailySummaries(
  instant: ISOInstant,
  env: Env,
): Promise<DailyEvaluation> {
  const now = Date.parse(instant),
    result: DailyEvaluation = { evaluated: 0, sent: 0, inactive: 0, unresolved: 0 };
  const missing = await env.DB.prepare(
    'SELECT w.id,w.time_zone,w.created_at_ms FROM workspaces w LEFT JOIN workspace_daily d ON d.workspace_id=w.id WHERE d.workspace_id IS NULL LIMIT 20',
  ).all<{ id: string; time_zone: string; created_at_ms: number }>();
  for (const w of missing.results) {
    const first = Temporal.Instant.fromEpochMilliseconds(w.created_at_ms)
      .toZonedDateTimeISO(w.time_zone)
      .startOfDay()
      .add({ days: 1 });
    await env.DB.prepare(
      'INSERT OR IGNORE INTO workspace_daily(workspace_id,next_due_ms,local_date) VALUES(?,?,?)',
    )
      .bind(w.id, first.epochMilliseconds, first.toPlainDate().subtract({ days: 1 }).toString())
      .run();
  }
  const due = await env.DB.prepare(
    'SELECT d.*,w.time_zone FROM workspace_daily d JOIN workspaces w ON w.id=d.workspace_id WHERE next_due_ms<=? AND (lease_until_ms IS NULL OR lease_until_ms<=?) ORDER BY next_due_ms,workspace_id LIMIT 20',
  )
    .bind(now, now)
    .all<{ workspace_id: string; time_zone: string; local_date: string; next_due_ms: number }>();
  for (const row of due.results) {
    const claim = crypto.randomUUID(),
      owned = await env.DB.prepare(
        'UPDATE workspace_daily SET claim_id=?,lease_until_ms=? WHERE workspace_id=? AND next_due_ms=? AND (lease_until_ms IS NULL OR lease_until_ms<=?)',
      )
        .bind(claim, now + 60000, row.workspace_id, row.next_due_ms, now)
        .run();
    if (!owned.meta.changes) continue;
    try {
      const date = Temporal.PlainDate.from(row.local_date),
        start = date.toZonedDateTime(row.time_zone),
        end = date.add({ days: 1 }).toZonedDateTime(row.time_zone);
      const activity = await env.DB.prepare(
        'SELECT 1 AS active FROM workspace_activity WHERE workspace_id=? AND occurred_at_ms>=? AND occurred_at_ms<? LIMIT 1',
      )
        .bind(row.workspace_id, start.epochMilliseconds, end.epochMilliseconds)
        .first();
      const config = await telegramSettings(row.workspace_id, env);
      if (!activity || !config?.daily) result.inactive++;
      else {
        const summary = await getSummary(
          { deviceId: 'monitor', allowedWorkspaceIds: '*' },
          row.workspace_id,
          row.local_date,
          env,
        );
        const sent = await sendReport(
          {
            workspaceId: row.workspace_id,
            dedupeKey: 'daily:' + row.local_date,
            kind: 'daily',
            textAr: `Mawjivo — ملخص ${row.local_date}\nمنشورات مكتملة: ${summary.completePosts}. جزئية: ${summary.partialPosts}. لم تكتمل: ${summary.failedPosts}. غير محسومة: ${summary.unknownPosts}.\nوجهات نُشر عليها: ${summary.publishedTargets}. مجدولة قادمة: ${summary.upcomingScheduled}.`,
          },
          env,
        );
        if (sent.kind === 'sent') result.sent++;
        else result.unresolved++;
      }
      const nextDate = date.add({ days: 1 }),
        nextDue = nextDate.add({ days: 1 }).toZonedDateTime(row.time_zone).epochMilliseconds;
      await env.DB.prepare(
        'UPDATE workspace_daily SET last_evaluated_date=?,local_date=?,next_due_ms=?,claim_id=NULL,lease_until_ms=NULL WHERE workspace_id=? AND claim_id=?',
      )
        .bind(row.local_date, nextDate.toString(), nextDue, row.workspace_id, claim)
        .run();
      result.evaluated++;
    } catch {
      result.unresolved++;
      await env.DB.prepare(
        'UPDATE workspace_daily SET claim_id=NULL,lease_until_ms=? WHERE workspace_id=? AND claim_id=?',
      )
        .bind(now + 60000, row.workspace_id, claim)
        .run();
    }
  }
  return result;
}
