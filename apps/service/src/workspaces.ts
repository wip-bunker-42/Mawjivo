import { WorkspaceSchema } from '@mawjivo/core';
import type { Workspace, WorkspaceInput } from '@mawjivo/core';
import type { AuthContext } from './auth';
import { requireWorkspace } from './auth';
import { ServiceError } from './errors';
interface WorkspaceRow {
  id: string;
  name: string;
  time_zone: string;
  version: number;
  default_platforms: string;
  service_profile_id: string;
  preferences_json: string;
}
const projection =
  "SELECT w.id,w.name,w.time_zone,w.version,w.default_platforms,w.service_profile_id,COALESCE(s.value_json,'{}') AS preferences_json FROM workspaces w LEFT JOIN service_settings s ON s.key='workspace-preferences:'||w.id";
function fromRow(row: WorkspaceRow): Workspace {
  return WorkspaceSchema.parse({
    id: row.id,
    name: row.name,
    timeZone: row.time_zone,
    version: row.version,
    defaultPlatforms: JSON.parse(row.default_platforms),
    serviceProfileId: row.service_profile_id,
    preferredChannels: JSON.parse(row.preferences_json),
  });
}
export function validateWorkspaceInput(value: unknown): WorkspaceInput {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ServiceError('INVALID_INPUT', 'راجع بيانات مساحة العمل.');
  const fields = Object.keys(value);
  if (
    fields.some(
      (field) =>
        ![
          'name',
          'timeZone',
          'defaultPlatforms',
          'serviceProfileId',
          'preferredChannels',
          'expectedVersion',
        ].includes(field),
    )
  )
    throw new ServiceError('INVALID_INPUT', 'بيانات مساحة العمل غير صالحة.');
  const { expectedVersion: _version, ...rest } = value as Record<string, unknown>;
  const candidate = WorkspaceSchema.safeParse({ id: 'validation', version: 1, ...rest });
  if (!candidate.success)
    throw new ServiceError('INVALID_INPUT', 'راجع الاسم والمنطقة الزمنية والمنصات.');
  return {
    name: candidate.data.name,
    timeZone: candidate.data.timeZone,
    defaultPlatforms: [...new Set(candidate.data.defaultPlatforms)],
    serviceProfileId: candidate.data.serviceProfileId,
    preferredChannels: candidate.data.preferredChannels ?? {},
  };
}
export async function listWorkspaces(auth: AuthContext, env: Env): Promise<Workspace[]> {
  const result = await env.DB.prepare(
    projection + ' ORDER BY w.created_at_ms,w.id',
  ).all<WorkspaceRow>();
  return result.results
    .filter((row) => auth.allowedWorkspaceIds === '*' || auth.allowedWorkspaceIds.includes(row.id))
    .map(fromRow);
}
export async function getWorkspace(auth: AuthContext, id: string, env: Env): Promise<Workspace> {
  requireWorkspace(auth, id);
  const row = await env.DB.prepare(projection + ' WHERE w.id=?')
    .bind(id)
    .first<WorkspaceRow>();
  if (!row) throw new ServiceError('NOT_FOUND', 'مساحة العمل غير موجودة.', 404);
  return fromRow(row);
}
export async function createWorkspace(
  auth: AuthContext,
  input: WorkspaceInput,
  env: Env,
): Promise<Workspace> {
  if (auth.allowedWorkspaceIds !== '*')
    throw new ServiceError('FORBIDDEN', 'إنشاء المساحات يتطلب جهازًا مخولًا بالإدارة.', 403);
  const valid = validateWorkspaceInput(input),
    id = crypto.randomUUID(),
    now = Date.now();
  if (Object.keys(valid.preferredChannels ?? {}).length)
    throw new ServiceError('CHANNEL_NOT_READY', 'اربط الحسابات قبل تعيين الحسابات الافتراضية.');
  await env.DB.prepare(
    'INSERT INTO workspaces(id,name,time_zone,version,default_platforms,service_profile_id,created_at_ms,updated_at_ms) VALUES(?,?,?,1,?,?,?,?)',
  )
    .bind(
      id,
      valid.name,
      valid.timeZone,
      JSON.stringify(valid.defaultPlatforms),
      valid.serviceProfileId,
      now,
      now,
    )
    .run();
  return { id, ...valid, version: 1 };
}
export async function updateWorkspace(
  auth: AuthContext,
  id: string,
  expectedVersion: number,
  input: WorkspaceInput,
  env: Env,
): Promise<Workspace> {
  requireWorkspace(auth, id);
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)
    throw new ServiceError('INVALID_INPUT', 'إصدار المساحة غير صالح.');
  const valid = validateWorkspaceInput(input);
  for (const [platform, channelId] of Object.entries(valid.preferredChannels ?? {})) {
    const channel = await env.DB.prepare(
      'SELECT ready FROM channels WHERE id=? AND workspace_id=? AND platform=?',
    )
      .bind(channelId, id, platform)
      .first<{ ready: number }>();
    if (channel?.ready !== 1)
      throw new ServiceError(
        'CHANNEL_NOT_READY',
        'الحساب المختار غير جاهز لهذه المنصة. أصلح الربط أو اختر حسابًا آخر.',
      );
  }
  const preferences = env.DB.prepare(
    'INSERT INTO service_settings(key,value_json,updated_at_ms) SELECT ?,?,? FROM workspaces WHERE id=? AND version=? ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at_ms=excluded.updated_at_ms',
  ).bind(
    'workspace-preferences:' + id,
    JSON.stringify(valid.preferredChannels ?? {}),
    Date.now(),
    id,
    expectedVersion,
  );
  const update = env.DB.prepare(
    'UPDATE workspaces SET name=?,time_zone=?,default_platforms=?,service_profile_id=?,version=version+1,updated_at_ms=? WHERE id=? AND version=? RETURNING id,name,time_zone,version,default_platforms,service_profile_id',
  ).bind(
    valid.name,
    valid.timeZone,
    JSON.stringify(valid.defaultPlatforms),
    valid.serviceProfileId,
    Date.now(),
    id,
    expectedVersion,
  );
  const result = await env.DB.batch([preferences, update]);
  if (!result[1]?.meta.changes) {
    await getWorkspace(auth, id, env);
    throw new ServiceError(
      'VERSION_CONFLICT',
      'تغيرت المساحة من نافذة أخرى. حدّثها قبل حفظ التعديل.',
      409,
    );
  }
  return getWorkspace(auth, id, env);
}
