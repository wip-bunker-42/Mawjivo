import type {
  AppError,
  AssetUse,
  Channel,
  ConnectionInput,
  ReadinessItem,
  TargetPlan,
} from '@mawjivo/core';
import { bufferAdapter } from './buffer';
import { metaAdapter } from './meta';
export type DecryptedConnection = ConnectionInput & { id: string; workspaceId: string };
export interface ProviderState {
  kind: 'facebook-photos' | 'instagram';
  childIds: string[];
  containerId?: string | undefined;
  publishedId?: string | undefined;
}
export type ResolvedTarget = Omit<TargetPlan, 'assets'> & {
  assets: (AssetUse & { assetId: string; url: string; bytes: number; mimeType: string })[];
  providerState?: ProviderState | undefined;
  checkpoint?: ((state: ProviderState) => Promise<void>) | undefined;
};
export type ProviderResult =
  | {
      kind: 'accepted';
      channelId: string;
      remoteId: string;
      providerState?: ProviderState | undefined;
    }
  | {
      kind: 'rejected';
      channelId: string;
      error: AppError;
      retryAt?: string | undefined;
      providerState?: ProviderState | undefined;
    }
  | {
      kind: 'uncertain';
      channelId: string;
      error: AppError;
      providerState?: ProviderState | undefined;
    };
export interface ProviderReceipt {
  remoteId: string;
  state: 'processing' | 'published' | 'failed' | 'unknown';
  publishedAt?: string | undefined;
  publicUrl?: string | undefined;
  error?: AppError | undefined;
  retryAt?: string | undefined;
  continuation?: { kind: 'instagram-publish'; containerId: string } | undefined;
  partReceipts?:
    | {
        partIndex: number;
        remoteId: string;
        state: 'processing' | 'published' | 'failed' | 'unknown';
      }[]
    | undefined;
}
export interface ProviderAdapter {
  discover(connection: DecryptedConnection, env: Env): Promise<Channel[]>;
  validate(connection: DecryptedConnection, env: Env): Promise<ReadinessItem[]>;
  publishBatch(
    connection: DecryptedConnection,
    targets: ResolvedTarget[],
    env: Env,
  ): Promise<ProviderResult[]>;
  readReceipts(
    connection: DecryptedConnection,
    remoteIds: string[],
    env: Env,
  ): Promise<ProviderReceipt[]>;
  continuePublishing?(
    connection: DecryptedConnection,
    target: ResolvedTarget,
    env: Env,
  ): Promise<ProviderResult>;
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
