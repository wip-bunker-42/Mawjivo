import type { MediaAsset } from '@mawjivo/core';
import type { AuthContext } from '../auth';
import { requireWorkspace } from '../auth';
import { ServiceError } from '../errors';
export const PART_BYTES = 16_777_216,
  TICKET_MS = 900_000,
  SIGNING_BATCH = 16,
  PROJECT_BYTES = 9_000_000_000,
  RELEASE_RESERVE = 1_000_000_000;
export interface AssetRow {
  id: string;
  workspace_id: string;
  source_asset_id: string;
  recipe_id: string | null;
  object_key: string;
  original_name: string;
  kind: 'image' | 'video';
  mime_type: string;
  bytes: number;
  sha256: string | null;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  state: string;
  multipart_id: string | null;
  created_at_ms: number;
  updated_at_ms: number;
  delete_after_ms: number | null;
}
export async function ownedAsset(auth: AuthContext, id: string, env: Env): Promise<AssetRow> {
  const row = await env.DB.prepare('SELECT * FROM assets WHERE id=?').bind(id).first<AssetRow>();
  if (!row) throw new ServiceError('ASSET_NOT_FOUND', 'الملف المرفوع غير موجود.', 404);
  requireWorkspace(auth, row.workspace_id);
  return row;
}
export function assetDto(row: AssetRow): MediaAsset {
  return {
    id: row.id,
    originalName: row.original_name,
    kind: row.kind,
    bytes: row.bytes,
    mimeType: row.mime_type,
    ...(row.sha256 ? { sha256: row.sha256 } : {}),
    ...(row.width !== null ? { width: row.width } : {}),
    ...(row.height !== null ? { height: row.height } : {}),
    ...(row.duration_ms !== null ? { durationMs: row.duration_ms } : {}),
    ...(row.recipe_id ? { derivedFrom: row.source_asset_id } : {}),
  };
}
export async function releaseDeleted(row: AssetRow, env: Env): Promise<boolean> {
  const results = await env.DB.batch([
    env.DB.prepare(
      "UPDATE assets SET state='deleted',multipart_id=NULL,updated_at_ms=? WHERE id=? AND state='deleting'",
    ).bind(Date.now(), row.id),
    env.DB.prepare(
      "UPDATE upload_reservations SET state='released' WHERE asset_id=? AND EXISTS(SELECT 1 FROM assets WHERE id=? AND state='deleted')",
    ).bind(row.id, row.id),
  ]);
  return results[0]!.meta.changes === 1;
}
export async function eraseClaimedAsset(row: AssetRow, env: Env): Promise<boolean> {
  // An existing object proves multipart completion; an incomplete upload must be aborted before releasing its reservation.
  if (row.multipart_id && !(await env.MEDIA.head(row.object_key)))
    await env.MEDIA.resumeMultipartUpload(row.object_key, row.multipart_id).abort();
  await env.MEDIA.delete(row.object_key); // R2's successful delete is strongly consistent.
  return releaseDeleted(row, env);
}
