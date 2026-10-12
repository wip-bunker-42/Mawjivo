import type { AppError, TargetReceipt } from '@mawjivo/core';
import { telegramSettings } from './settings';
import { providerError } from '../providers/redact';
export interface ReportMessage {
  workspaceId: string;
  dedupeKey: string;
  kind: 'failure' | 'daily' | 'recovery';
  textAr: string;
}
export type ReportDelivery =
  { kind: 'sent'; messageId: string } | { kind: 'failed'; error: AppError } | { kind: 'uncertain' };
function rejected(code = 'TELEGRAM_REJECTED'): ReportDelivery {
  return {
    kind: 'failed',
    error: {
      code,
      messageAr:
        code === 'TELEGRAM_RATE_LIMIT'
          ? 'ينتظر التقرير حصة تليجرام.'
          : 'تعذر إرسال التقرير. راجع ربط بوت تليجرام ومعرف المحادثة.',
      retryable: code === 'TELEGRAM_RATE_LIMIT',
    },
  };
}
interface ReportRow {
  id: string;
  state: string;
  remote_message_id: string | null;
  claim_id: string | null;
  claimed_at_ms: number | null;
  next_attempt_ms: number | null;
  error_code: string | null;
  text_ar: string;
}
async function responseJson(response: Response): Promise<any> {
  if (!response.body) throw new Error('NO_BODY');
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > 32768) {
        await reader.cancel();
        throw new Error('RESPONSE_LIMIT');
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}
export async function sendReport(report: ReportMessage, env: Env): Promise<ReportDelivery> {
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO report_outbox(id,workspace_id,dedupe_key,kind,text_ar,state,next_attempt_ms,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,'pending',?,?,?) ON CONFLICT(workspace_id,dedupe_key) DO NOTHING",
  )
    .bind(
      crypto.randomUUID(),
      report.workspaceId,
      report.dedupeKey,
      report.kind,
      [...report.textAr].slice(0, 4000).join(''),
      now,
      now,
      now,
    )
    .run();
  const row = await env.DB.prepare(
    'SELECT * FROM report_outbox WHERE workspace_id=? AND dedupe_key=?',
  )
    .bind(report.workspaceId, report.dedupeKey)
    .first<ReportRow>();
  if (!row) return rejected();
  if (row.state === 'sent') return { kind: 'sent', messageId: row.remote_message_id! };
  if (row.state === 'uncertain' || row.state === 'sending') {
    if (row.state === 'sending' && (row.claimed_at_ms ?? now) < now - 60000)
      await env.DB.prepare(
        "UPDATE report_outbox SET state='uncertain',error_code='TELEGRAM_UNCERTAIN',updated_at_ms=? WHERE id=? AND state='sending'",
      )
        .bind(now, row.id)
        .run();
    return { kind: 'uncertain' };
  }
  if (row.state === 'failed') return rejected(row.error_code ?? undefined);
  if ((row.next_attempt_ms ?? 0) > now) return rejected('TELEGRAM_RATE_LIMIT');
  const config = await telegramSettings(report.workspaceId, env);
  if (!config) {
    await env.DB.prepare(
      "UPDATE report_outbox SET state='failed',error_code='TELEGRAM_NOT_CONFIGURED',updated_at_ms=? WHERE id=? AND state='pending'",
    )
      .bind(now, row.id)
      .run();
    return rejected('TELEGRAM_NOT_CONFIGURED');
  }
  const claim = crypto.randomUUID();
  const owned = await env.DB.prepare(
    "UPDATE report_outbox SET state='sending',claim_id=?,claimed_at_ms=?,updated_at_ms=? WHERE id=? AND state='pending' AND next_attempt_ms<=?",
  )
    .bind(claim, now, now, row.id, now)
    .run();
  if (!owned.meta.changes) return { kind: 'uncertain' };
  let state = 'uncertain',
    remote: string | null = null,
    error = 'TELEGRAM_UNCERTAIN',
    next: number | null = null;
  try {
    const response = await fetch(
      'https://api.telegram.org/bot' + config.botToken + '/sendMessage',
      {
        method: 'POST',
        redirect: 'manual',
        signal: AbortSignal.timeout(20000),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: config.chatId,
          text: row.text_ar,
          link_preview_options: { is_disabled: true },
        }),
      },
    );
    if ((response.status >= 300 && response.status < 400) || response.status >= 500) {
      await response.body?.cancel();
      throw new Error('AMBIGUOUS');
    }
    const result = await responseJson(response);
    if (response.ok && result.ok === true && Number.isSafeInteger(result.result?.message_id)) {
      state = 'sent';
      remote = String(result.result.message_id);
      error = '';
    } else if (result.ok === false && Number.isSafeInteger(result.error_code)) {
      if (result.error_code === 429) {
        state = 'pending';
        error = 'TELEGRAM_RATE_LIMIT';
        next =
          now +
          Math.max(1000, Math.min(86400000, Number(result.parameters?.retry_after || 60) * 1000));
      } else {
        state = 'failed';
        error = 'TELEGRAM_REJECTED';
      }
    }
  } catch {
    /* A timeout or malformed success may have delivered. Do not resend. */
  }
  await env.DB.prepare(
    'UPDATE report_outbox SET state=?,remote_message_id=?,error_code=?,next_attempt_ms=?,updated_at_ms=? WHERE id=? AND claim_id=?',
  )
    .bind(state, remote, error || null, next, Date.now(), row.id, claim)
    .run();
  return state === 'sent'
    ? { kind: 'sent', messageId: remote! }
    : state === 'uncertain'
      ? { kind: 'uncertain' }
      : rejected(error);
}
export function failureReport(
  workspaceId: string,
  postId: string,
  revision: number,
  target: TargetReceipt,
  preview?: string,
): ReportMessage {
  const names = {
    facebook: 'Facebook',
    instagram: 'Instagram',
    threads: 'Threads',
    x: 'X',
    youtube: 'YouTube',
    tiktok: 'TikTok',
  };
  const reason = providerError(target.error?.code ?? 'PROVIDER_FAILED').messageAr;
  const likeWarning =
    target.state === 'published' &&
    ['FACEBOOK_LIKE_FAILED', 'FACEBOOK_LIKE_UNCERTAIN'].includes(target.error?.code ?? '');
  if (likeWarning)
    return {
      workspaceId,
      dedupeKey: `facebook-like:${postId}:${revision}:${target.channelId}:${target.error!.code}`,
      kind: 'failure',
      textAr: `Mawjivo — Facebook\nالمنشور: ${preview ? [...preview].slice(0, 120).join('') : postId}\nالخطوة: الإعجاب باسم الصفحة.\n${reason}\nافتح «ملخص» لقراءة تفاصيل المنشور.`,
    };
  return {
    workspaceId,
    dedupeKey: `target:${postId}:${revision}:${target.channelId}:${target.state}:${target.error?.code ?? 'PROVIDER_FAILED'}`,
    kind: 'failure',
    textAr: `Mawjivo — ${names[target.platform]}\nالمنشور: ${preview ? [...preview].slice(0, 120).join('') : postId}\nالخطوة: ${target.state === 'uncertain' ? 'تأكيد نتيجة الإرسال' : 'النشر'}.\n${reason}\nافتح «ملخص» لقراءة حالة كل منصة ورابط المنشور. ${target.state === 'uncertain' ? 'تحقق من الحساب قبل إعادة الإرسال لتجنب التكرار.' : 'يمكن إصلاح الوجهة التي فشلت من تفاصيل المنشور في «المجدولة». '}الوجهات الناجحة محفوظة.`,
  };
}
