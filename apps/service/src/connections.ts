import { CapabilitySnapshotSchema, ConnectionInputSchema } from '@mawjivo/core';
import type {
  CapabilitySnapshot,
  Channel,
  ConnectionInput,
  ConnectionSummary,
  ReadinessItem,
} from '@mawjivo/core';
import type { AuthContext } from './auth';
import { getWorkspace } from './workspaces';
import { encryptSecret, decryptSecret } from './secrets';
import { ServiceError } from './errors';
import { discoverChannels, readinessFor, stableIdentity } from './providers/types';
import type { DecryptedConnection } from './providers/types';
interface ConnectionRow {
  id: string;
  workspace_id: string;
  provider: 'buffer' | 'meta';
  label: string;
  secret_cipher: string;
  key_version: number;
  version: number;
}
type StoredCheck = ReadinessItem & { connectionId: string };
function publicCheck({ connectionId: _id, ...check }: StoredCheck): ReadinessItem {
  return check;
}
const CACHE_AGE_MS = 24 * 60 * 60 * 1000;
const cacheKey = (workspaceId: string) => 'capabilities:' + workspaceId;
export function validateConnectionInputs(value: unknown): ConnectionInput[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20)
    throw new ServiceError('INVALID_INPUT', 'أضف من حساب إلى عشرين حسابًا في الطلب.');
  const seen = new Set<string>();
  return value.map((input) => {
    const parsed = ConnectionInputSchema.safeParse(input);
    if (!parsed.success) throw new ServiceError('INVALID_INPUT', 'راجع اسم الربط والرموز.');
    const connection = parsed.data,
      keys = Object.keys(connection.credentials);
    const required =
      connection.provider === 'buffer'
        ? ['apiKey']
        : ['pageId', 'pageAccessToken', 'userAccessToken'];
    const allowed = connection.provider === 'buffer' ? required : [...required, 'instagramId'];
    if (
      required.some((k) => !connection.credentials[k]) ||
      keys.some((k) => !allowed.includes(k)) ||
      (connection.provider === 'meta' &&
        [connection.credentials.pageId, connection.credentials.instagramId].some(
          (v) => v !== undefined && !/^\d{1,40}$/.test(v),
        ))
    )
      throw new ServiceError('INVALID_INPUT', 'بيانات الربط ناقصة أو غير صالحة.');
    const key = connection.provider + ':' + connection.label;
    if (seen.has(key)) throw new ServiceError('INVALID_INPUT', 'اسم الربط مكرر في الطلب.');
    seen.add(key);
    return connection;
  });
}
async function connectionRows(workspaceId: string, env: Env): Promise<ConnectionRow[]> {
  return (
    await env.DB.prepare(
      'SELECT id,workspace_id,provider,label,secret_cipher,key_version,version FROM connections WHERE workspace_id=? ORDER BY id',
    )
      .bind(workspaceId)
      .all<ConnectionRow>()
  ).results;
}
export async function listConnections(
  auth: AuthContext,
  workspaceId: string,
  env: Env,
): Promise<ConnectionSummary[]> {
  await getWorkspace(auth, workspaceId, env);
  const cache = await env.DB.prepare('SELECT value_json FROM service_settings WHERE key=?')
    .bind(cacheKey(workspaceId))
    .first<{ value_json: string }>();
  const previous = await env.DB.prepare('SELECT value_json FROM service_settings WHERE key=?')
    .bind('connection-checks:' + workspaceId)
    .first<{ value_json: string }>();
  const parsed = cache ? CapabilitySnapshotSchema.safeParse(JSON.parse(cache.value_json)) : null;
  const channels = parsed?.success ? parsed.data.channels : [];
  const checks = previous ? (JSON.parse(previous.value_json) as StoredCheck[]) : [];
  return (await connectionRows(workspaceId, env)).map(({ id, provider, label, version }) => ({
    id,
    provider,
    label,
    version,
    readiness: [
      ...readinessFor(channels.filter((channel) => channel.connectionId === id)),
      ...checks.filter((check) => check.connectionId === id).map(publicCheck),
    ],
  }));
}
export async function loadConnection(
  workspaceId: string,
  id: string,
  env: Env,
): Promise<DecryptedConnection> {
  const row = await env.DB.prepare(
    'SELECT id,workspace_id,provider,label,secret_cipher,key_version,version FROM connections WHERE workspace_id=? AND id=?',
  )
    .bind(workspaceId, id)
    .first<ConnectionRow>();
  if (!row) throw new ServiceError('CONNECTION_NOT_FOUND', 'حساب النشر غير موجود.', 404);
  const value: unknown = JSON.parse(
    await decryptSecret(
      row.secret_cipher,
      { workspaceId, connectionId: id, keyVersion: row.key_version },
      env,
    ),
  );
  const parsed = ConnectionInputSchema.safeParse({
    provider: row.provider,
    label: row.label,
    credentials: value,
  });
  if (!parsed.success)
    throw new ServiceError('CONNECTION_INVALID', 'أعد إدخال بيانات الحساب.', 400);
  return { ...parsed.data, id, workspaceId };
}
export async function saveConnections(
  auth: AuthContext,
  workspaceId: string,
  inputs: ConnectionInput[],
  env: Env,
): Promise<ReadinessItem[]> {
  await getWorkspace(auth, workspaceId, env);
  const valid = validateConnectionInputs(inputs),
    existing = await connectionRows(workspaceId, env);
  const statements: D1PreparedStatement[] = [];
  for (const input of valid) {
    const same = existing.find((c) => c.provider === input.provider && c.label === input.label);
    const id =
      same?.id ?? (await stableIdentity('connection', [workspaceId, input.provider, input.label]));
    const secret = await encryptSecret(
      JSON.stringify(input.credentials),
      { workspaceId, connectionId: id, keyVersion: 1 },
      env,
    );
    statements.push(
      env.DB.prepare(
        'INSERT INTO connections(id,workspace_id,provider,label,secret_cipher,key_version,version,updated_at_ms) VALUES(?,?,?,?,?,1,1,?) ON CONFLICT(id) DO UPDATE SET secret_cipher=excluded.secret_cipher,version=connections.version+1,updated_at_ms=excluded.updated_at_ms',
      ).bind(id, workspaceId, input.provider, input.label, secret, Date.now()),
    );
  }
  statements.push(
    env.DB.prepare('UPDATE channels SET ready=0 WHERE workspace_id=?').bind(workspaceId),
    env.DB.prepare('DELETE FROM service_settings WHERE key=?').bind(cacheKey(workspaceId)),
  );
  await env.DB.batch(statements);
  const snapshot = await getCapabilities(auth, workspaceId, env);
  const storedChecks = await env.DB.prepare('SELECT value_json FROM service_settings WHERE key=?')
    .bind('connection-checks:' + workspaceId)
    .first<{ value_json: string }>();
  const failures = storedChecks ? (JSON.parse(storedChecks.value_json) as StoredCheck[]) : [];
  if (failures.length) return [...readinessFor(snapshot.channels), ...failures.map(publicCheck)];
  return snapshot.channels.length
    ? readinessFor(snapshot.channels)
    : [
        {
          code: 'NO_CHANNELS',
          state: 'needsAction',
          messageAr: 'لم تظهر قنوات نشر. اربط المنصات داخل Buffer ثم أعد الفحص.',
        },
      ];
}
export async function getCapabilities(
  auth: AuthContext,
  workspaceId: string,
  env: Env,
  refresh = false,
): Promise<CapabilitySnapshot> {
  await getWorkspace(auth, workspaceId, env);
  const cache = await env.DB.prepare('SELECT value_json FROM service_settings WHERE key=?')
    .bind(cacheKey(workspaceId))
    .first<{ value_json: string }>();
  if (!refresh && cache) {
    const parsed = CapabilitySnapshotSchema.safeParse(JSON.parse(cache.value_json));
    if (parsed.success && Date.now() - Date.parse(parsed.data.fetchedAt) < CACHE_AGE_MS)
      return parsed.data;
  }
  const rows = await connectionRows(workspaceId, env),
    channels: Channel[] = [],
    checks: StoredCheck[] = [];
  for (const row of rows) {
    try {
      channels.push(
        ...(await discoverChannels(await loadConnection(workspaceId, row.id, env), env)),
      );
    } catch (error) {
      if (!(error instanceof ServiceError)) throw error;
      checks.push({
        connectionId: row.id,
        code: error.code,
        state: 'needsAction',
        messageAr: row.label + ': ' + error.messageAr,
      });
      const previous = await env.DB.prepare(
        'SELECT id,remote_id,platform,provider,limits_json FROM channels WHERE workspace_id=? AND connection_id=?',
      )
        .bind(workspaceId, row.id)
        .all<{
          id: string;
          remote_id: string;
          platform: Channel['platform'];
          provider: Channel['provider'];
          limits_json: string;
        }>();
      channels.push(
        ...previous.results.map((c) => ({
          id: c.id,
          remoteId: c.remote_id,
          connectionId: row.id,
          platform: c.platform,
          provider: c.provider,
          ready: false,
          limits: JSON.parse(c.limits_json) as Channel['limits'],
          readinessMessageAr: error.messageAr,
        })),
      );
    }
  }
  const snapshot = CapabilitySnapshotSchema.parse({
    version: crypto.randomUUID(),
    fetchedAt: new Date().toISOString(),
    channels,
  });
  // Discard results if credentials changed while requests were in flight.
  const signature = JSON.stringify(rows.map((row) => [row.id, row.version]));
  const guard =
    '(SELECT json_group_array(json_array(id,version)) FROM (SELECT id,version FROM connections WHERE workspace_id=? ORDER BY id))=?';
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(`UPDATE channels SET ready=0 WHERE workspace_id=? AND ${guard}`).bind(
      workspaceId,
      workspaceId,
      signature,
    ),
  ];
  for (const channel of snapshot.channels)
    statements.push(
      env.DB.prepare(
        `INSERT INTO channels(id,workspace_id,connection_id,remote_id,platform,provider,ready,limits_json,discovered_at_ms) SELECT ?,?,?,?,?,?,?,?,? WHERE ${guard} ON CONFLICT(id) DO UPDATE SET ready=excluded.ready,limits_json=excluded.limits_json,discovered_at_ms=excluded.discovered_at_ms`,
      ).bind(
        channel.id,
        workspaceId,
        channel.connectionId,
        channel.remoteId!,
        channel.platform,
        channel.provider,
        Number(channel.ready),
        JSON.stringify(channel.limits),
        Date.now(),
        workspaceId,
        signature,
      ),
    );
  statements.push(
    env.DB.prepare(
      `INSERT INTO service_settings(key,value_json,updated_at_ms) SELECT ?,?,? WHERE ${guard} ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at_ms=excluded.updated_at_ms`,
    ).bind(cacheKey(workspaceId), JSON.stringify(snapshot), Date.now(), workspaceId, signature),
  );
  statements.push(
    env.DB.prepare(
      `INSERT INTO service_settings(key,value_json,updated_at_ms) SELECT ?,?,? WHERE ${guard} ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at_ms=excluded.updated_at_ms`,
    ).bind(
      'connection-checks:' + workspaceId,
      JSON.stringify(checks),
      Date.now(),
      workspaceId,
      signature,
    ),
  );
  const result = await env.DB.batch(statements);
  if (!result.at(-1)?.meta.changes)
    throw new ServiceError(
      'CONNECTION_CHANGED',
      'تغير ربط الحساب أثناء الفحص. أعد الفحص.',
      409,
      true,
    );
  return snapshot;
}
