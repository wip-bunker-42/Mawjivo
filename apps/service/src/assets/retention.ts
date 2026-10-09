import { type AssetRow, eraseClaimedAsset } from './model';
import { ServiceError } from '../errors';
export interface CleanupResult {
  deletedCount: number;
  releasedBytes: number;
  retainedUnknownCount: number;
  failedCount: number;
}
const day = 86_400_000;
// Unsafe remote outcomes survive revision changes. Current unsent references survive their entire schedule.
const protectedReference = `EXISTS(SELECT 1 FROM asset_uses u JOIN targets t ON t.post_id=u.post_id AND t.revision=u.revision AND t.channel_id=u.channel_id
 JOIN posts p ON p.id=u.post_id AND p.workspace_id=u.workspace_id WHERE u.asset_id=a.id AND
 (t.state IN ('sending','accepted','uncertain','unknown','publishing','pending_provider') OR
 (p.revision=u.revision AND t.state NOT IN ('published','failed','cancelled'))))`;
const eligible = `NOT (${protectedReference}) AND (
 (NOT EXISTS(SELECT 1 FROM asset_uses u WHERE u.asset_id=a.id) AND a.updated_at_ms <= (SELECT now FROM cutoff)-${day}) OR
 (EXISTS(SELECT 1 FROM asset_uses u WHERE u.asset_id=a.id) AND NOT EXISTS(
  SELECT 1 FROM asset_uses u JOIN targets t ON t.post_id=u.post_id AND t.revision=u.revision AND t.channel_id=u.channel_id WHERE u.asset_id=a.id AND
  MAX(a.updated_at_ms,t.updated_at_ms,COALESCE(u.consumed_at_ms,0)) > (SELECT now FROM cutoff) - CASE WHEN t.state='failed' THEN ${7 * day} WHEN t.state='cancelled' THEN ${day} ELSE ${2 * day} END
 )))`;
export async function collectExpiredAssets(instant: string, env: Env): Promise<CleanupResult> {
  const now = Date.parse(instant);
  if (!Number.isSafeInteger(now))
    throw new ServiceError('INVALID_CLEANUP_TIME', 'وقت التنظيف غير صالح.');
  const unknown = await env.DB.prepare(
    `SELECT COUNT(DISTINCT a.id) AS count FROM assets a JOIN asset_uses u ON u.asset_id=a.id JOIN targets t ON t.post_id=u.post_id AND t.revision=u.revision AND t.channel_id=u.channel_id WHERE a.state!='deleted' AND t.state IN ('sending','accepted','uncertain','unknown','publishing','pending_provider')`,
  ).first<{ count: number }>();
  const result: CleanupResult = {
    deletedCount: 0,
    releasedBytes: 0,
    retainedUnknownCount: unknown?.count ?? 0,
    failedCount: 0,
  };
  const candidates = await env.DB.prepare(
    `WITH cutoff(now) AS (VALUES(?)) SELECT a.* FROM assets a WHERE a.state!='deleted' AND (a.state='deleting' OR (${eligible})) ORDER BY a.created_at_ms LIMIT 100`,
  )
    .bind(now)
    .all<AssetRow>();
  for (const row of candidates.results) {
    // Re-evaluate reference timestamps and states atomically when claiming deletion.
    const claimed = await env.DB.prepare(
      `WITH cutoff(now) AS (VALUES(?)) UPDATE assets AS a SET state='deleting' WHERE a.id=? AND a.state!='deleted' AND (a.state='deleting' OR (${eligible}))`,
    )
      .bind(now, row.id)
      .run();
    if (!claimed.meta.changes) continue;
    try {
      if (await eraseClaimedAsset(row, env)) {
        result.deletedCount++;
        result.releasedBytes += row.bytes;
      }
    } catch {
      result.failedCount++;
      console.warn({ event: 'media_cleanup_retry', assetId: row.id });
    }
  }
  return result;
}
