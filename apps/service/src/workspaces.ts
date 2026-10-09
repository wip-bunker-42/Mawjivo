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
}
function fromRow(row: WorkspaceRow): Workspace {
  return WorkspaceSchema.parse({
    id: row.id,
    name: row.name,
    timeZone: row.time_zone,
    version: row.version,
    defaultPlatforms: JSON.parse(row.default_platforms),
    serviceProfileId: row.service_profile_id,
  });
}
export function validateWorkspaceInput(value: unknown): WorkspaceInput {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ServiceError('INVALID_INPUT', 'راجع بيانات مساحة العمل.');
  const fields = Object.keys(value);
  if (
    fields.some(
      (field) =>
        !['name', 'timeZone', 'defaultPlatforms', 'serviceProfileId', 'expectedVersion'].includes(
          field,
        ),
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
  };
}
export async function listWorkspaces(auth: AuthContext, env: Env): Promise<Workspace[]> {
  const result = await env.DB.prepare(
    'SELECT id,name,time_zone,version,default_platforms,service_profile_id FROM workspaces ORDER BY created_at_ms,id',
  ).all<WorkspaceRow>();
  return result.results
    .filter((row) => auth.allowedWorkspaceIds === '*' || auth.allowedWorkspaceIds.includes(row.id))
    .map(fromRow);
}
export async function getWorkspace(auth: AuthContext, id: string, env: Env): Promise<Workspace> {
  requireWorkspace(auth, id);
  const row = await env.DB.prepare(
    'SELECT id,name,time_zone,version,default_platforms,service_profile_id FROM workspaces WHERE id=?',
  )
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
  const row = await env.DB.prepare(
    'UPDATE workspaces SET name=?,time_zone=?,default_platforms=?,service_profile_id=?,version=version+1,updated_at_ms=? WHERE id=? AND version=? RETURNING id,name,time_zone,version,default_platforms,service_profile_id',
  )
    .bind(
      valid.name,
      valid.timeZone,
      JSON.stringify(valid.defaultPlatforms),
      valid.serviceProfileId,
      Date.now(),
      id,
      expectedVersion,
    )
    .first<WorkspaceRow>();
  if (!row) {
    await getWorkspace(auth, id, env);
    throw new ServiceError(
      'VERSION_CONFLICT',
      'تغيرت المساحة من نافذة أخرى. حدّثها قبل حفظ التعديل.',
      409,
    );
  }
  return fromRow(row);
}
