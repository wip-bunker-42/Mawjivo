import type { AuthContext } from '../auth';
import { getWorkspace } from '../workspaces';
import { encryptSecret, decryptSecret } from '../secrets';
import { ServiceError } from '../errors';
export interface TelegramSettings {
  botToken: string;
  chatId: string;
  daily: boolean;
}
export async function telegramSettings(
  workspaceId: string,
  env: Env,
): Promise<TelegramSettings | null> {
  const row = await env.DB.prepare('SELECT value_json FROM service_settings WHERE key=?')
    .bind('telegram:' + workspaceId)
    .first<{ value_json: string }>();
  if (!row) return null;
  return JSON.parse(
    await decryptSecret(
      JSON.parse(row.value_json).cipher,
      { workspaceId, connectionId: 'telegram', keyVersion: 1 },
      env,
    ),
  ) as TelegramSettings;
}
export async function telegramStatus(auth: AuthContext, workspaceId: string, env: Env) {
  await getWorkspace(auth, workspaceId, env);
  const config = await telegramSettings(workspaceId, env);
  const reports = await env.DB.prepare(
    'SELECT kind,state,error_code,updated_at_ms FROM report_outbox WHERE workspace_id=? ORDER BY updated_at_ms DESC LIMIT 10',
  )
    .bind(workspaceId)
    .all();
  return {
    configured: config !== null,
    chatId: config?.chatId ?? '',
    daily: config?.daily ?? true,
    reports: reports.results,
  };
}
export async function saveTelegramSettings(
  auth: AuthContext,
  workspaceId: string,
  input: TelegramSettings,
  env: Env,
): Promise<void> {
  await getWorkspace(auth, workspaceId, env);
  if (
    !input ||
    Object.keys(input).some((key) => !['botToken', 'chatId', 'daily'].includes(key)) ||
    typeof input.botToken !== 'string' ||
    typeof input.chatId !== 'string' ||
    typeof input.daily !== 'boolean'
  )
    throw new ServiceError('INVALID_TELEGRAM', 'راجع بيانات بوت تليجرام.');
  const botToken = input.botToken || (await telegramSettings(workspaceId, env))?.botToken || '';
  if (
    !/^\d{6,20}:[A-Za-z0-9_-]{30,100}$/.test(botToken) ||
    !/^(?:-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$/.test(input.chatId)
  )
    throw new ServiceError('INVALID_TELEGRAM', 'راجع رمز البوت ومعرف محادثة تليجرام.');
  const cipher = await encryptSecret(
    JSON.stringify({ ...input, botToken }),
    { workspaceId, connectionId: 'telegram', keyVersion: 1 },
    env,
  );
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO service_settings(key,value_json,updated_at_ms) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at_ms=excluded.updated_at_ms',
    ).bind('telegram:' + workspaceId, JSON.stringify({ cipher }), Date.now()),
    env.DB.prepare(
      "UPDATE report_outbox SET state='pending',next_attempt_ms=?,error_code=NULL WHERE workspace_id=? AND state='failed'",
    ).bind(Date.now(), workspaceId),
  ]);
}
