import { ServiceError } from './errors';
export interface AuthContext {
  deviceId: string;
  allowedWorkspaceIds: '*' | string[];
}
interface DeviceRow {
  id: string;
  allowed_workspace_ids: string;
}
export async function authenticate(request: Request, env: Env): Promise<AuthContext> {
  const match = /^Bearer ([A-Za-z0-9_-]{20,256})$/.exec(request.headers.get('Authorization') ?? '');
  if (!match) throw new ServiceError('UNAUTHORIZED', 'اربط هذا الجهاز بالخدمة مجددًا.', 401);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(match[1]!));
  const tokenHash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  const row = await env.DB.prepare(
    'SELECT id,allowed_workspace_ids FROM devices WHERE token_hash=? AND revoked_at_ms IS NULL',
  )
    .bind(tokenHash)
    .first<DeviceRow>();
  if (!row) throw new ServiceError('UNAUTHORIZED', 'انتهى ربط الجهاز أو أُلغي. اربطه مجددًا.', 401);
  const allowed: unknown = JSON.parse(row.allowed_workspace_ids);
  if (
    allowed !== '*' &&
    (!Array.isArray(allowed) || !allowed.every((id) => typeof id === 'string'))
  )
    throw new ServiceError('UNAUTHORIZED', 'صلاحيات الجهاز تحتاج إصلاحًا.', 401);
  return { deviceId: row.id, allowedWorkspaceIds: allowed };
}
export function requireWorkspace(auth: AuthContext, workspaceId: string): void {
  if (auth.allowedWorkspaceIds !== '*' && !auth.allowedWorkspaceIds.includes(workspaceId))
    throw new ServiceError('FORBIDDEN', 'هذا الجهاز غير مخول لهذه المساحة.', 403);
}
