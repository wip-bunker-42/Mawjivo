import type { Channel, ConnectionInput, ReadinessItem } from '@mawjivo/core';
import { bufferAdapter } from './buffer';
import { metaAdapter } from './meta';
export type DecryptedConnection = ConnectionInput & { id: string; workspaceId: string };
export interface ProviderAdapter {
  discover(connection: DecryptedConnection, env: Env): Promise<Channel[]>;
  validate(connection: DecryptedConnection, env: Env): Promise<ReadinessItem[]>;
}
export async function discoverChannels(
  connection: DecryptedConnection,
  env: Env,
): Promise<Channel[]> {
  return (connection.provider === 'buffer' ? bufferAdapter : metaAdapter).discover(connection, env);
}
export async function channelIdentity(
  connection: DecryptedConnection,
  remoteId: string,
): Promise<string> {
  return stableIdentity('channel', [connection.workspaceId, connection.id, remoteId]);
}
export async function stableIdentity(prefix: string, parts: string[]): Promise<string> {
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(parts)),
  );
  return (
    prefix +
    '-' +
    Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('')
  );
}
export function readinessFor(channels: Channel[]): ReadinessItem[] {
  return channels.map((channel) => ({
    code: channel.id,
    state: channel.ready ? 'ready' : 'needsAction',
    messageAr: `${channel.displayName ?? channel.platform}: ${channel.ready ? 'جاهز للنشر.' : (channel.readinessMessageAr ?? 'أعد ربط الحساب.')}`,
  }));
}
