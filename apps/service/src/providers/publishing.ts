import type { DecryptedConnection, ResolvedTarget } from './types';
import { ServiceError } from '../errors';
export async function remoteChannels(
  connection: DecryptedConnection,
  targets: ResolvedTarget[],
  env: Env,
): Promise<Map<string, string>> {
  if (targets.length > 30)
    throw new ServiceError('PROVIDER_BATCH', 'دفعة النشر أكبر من الحد المسموح.');
  if (!targets.length) return new Map();
  const rows = (
    await env.DB.prepare(
      'SELECT id,remote_id,platform FROM channels WHERE workspace_id=? AND connection_id=? AND provider=? AND ready=1 AND id IN (' +
        targets.map(() => '?').join(',') +
        ')',
    )
      .bind(
        connection.workspaceId,
        connection.id,
        connection.provider,
        ...targets.map((t) => t.channelId),
      )
      .all<{ id: string; remote_id: string; platform: string }>()
  ).results;
  return new Map(
    rows
      .filter((row) =>
        targets.some(
          (t) =>
            t.channelId === row.id &&
            t.platform === row.platform &&
            t.provider === connection.provider,
        ),
      )
      .map((row) => [row.id, row.remote_id]),
  );
}
export async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error('INVALID_PROVIDER_RESPONSE');
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 2097152) {
        await reader.cancel();
        throw new Error('PROVIDER_RESPONSE_LIMIT');
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.length;
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(all));
}
