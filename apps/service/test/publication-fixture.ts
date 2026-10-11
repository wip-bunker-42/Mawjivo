import { vi } from 'vitest';
import type { WorkflowStep } from 'cloudflare:workers';
import {
  buildPlan,
  hashPlan,
  type CapabilitySnapshot,
  type Draft,
  type Submission,
} from '@mawjivo/core';
import { testEnv } from './helpers';
import { seedConnection, bufferConnection } from './publishing-fixtures';
import type { AuthContext } from '../src/auth';
export const auth: AuthContext = { deviceId: 'owner', allowedWorkspaceIds: '*' };
export function workflowMock() {
  const instances = new Map<
    string,
    {
      id: string;
      status: () => Promise<{ status: string }>;
      terminate: ReturnType<typeof vi.fn>;
      restart: ReturnType<typeof vi.fn>;
    }
  >();
  const create = vi.fn(async ({ id }: { id: string; params?: { receiptsOnly?: boolean } }) => {
    if (instances.has(id)) throw Object.assign(new Error('exists'), { code: 10405 });
    const instance = {
      id,
      status: async () => ({ status: 'queued' }),
      terminate: vi.fn(async () => {}),
      restart: vi.fn(async () => {}),
    };
    instances.set(id, instance);
    return instance;
  });
  const get = vi.fn(async (id: string) => {
    const instance = instances.get(id);
    if (!instance) throw new Error('not found');
    return instance;
  });
  return { create, get, instances };
}
export async function publicationFixture(second = false) {
  await seedConnection(bufferConnection);
  const caps: CapabilitySnapshot = {
    version: 'publication-caps',
    fetchedAt: new Date().toISOString(),
    channels: (second ? (['x', 'threads'] as const) : (['x'] as const)).map((platform) => ({
      id: 'publish-' + platform,
      connectionId: bufferConnection.id,
      platform,
      provider: 'buffer',
      ready: true,
      remoteId: 'remote-' + platform,
      limits: {
        supportedKinds: ['text', 'image', 'video'],
        textMax: platform === 'x' ? 280 : 500,
        textMetric: platform === 'x' ? 'weightedX' : 'codePoints',
        altMax: 1000,
        altKinds: ['image'],
        threadParts: 25,
        image: {
          mimeTypes: ['image/jpeg', 'image/png'],
          maxBytes: 8000000,
          maxCount: 4,
          maxWidth: 4096,
          maxHeight: 4096,
        },
        video: {
          mimeTypes: ['video/mp4'],
          maxBytes: 512000000,
          maxCount: 1,
          maxDurationMs: 140000,
        },
        source: 'https://provider.test/documented-rules',
        verifiedAt: new Date().toISOString(),
      },
    })),
  };
  for (const channel of caps.channels)
    await testEnv()
      .DB.prepare(
        'INSERT INTO channels(id,workspace_id,connection_id,remote_id,platform,provider,ready,limits_json,discovered_at_ms) VALUES(?,?,?,?,?,?,1,?,?)',
      )
      .bind(
        channel.id,
        'workspace-a',
        channel.connectionId,
        channel.remoteId!,
        channel.platform,
        channel.provider,
        JSON.stringify(channel.limits),
        Date.now(),
      )
      .run();
  await testEnv()
    .DB.prepare('INSERT INTO service_settings(key,value_json,updated_at_ms) VALUES(?,?,?)')
    .bind('capabilities:workspace-a', JSON.stringify(caps), Date.now())
    .run();
  const draft: Draft = {
    id: crypto.randomUUID(),
    workspaceId: 'workspace-a',
    workspaceVersion: 1,
    timeZone: 'Africa/Cairo',
    revision: 1,
    createdAt: new Date().toISOString(),
    text: 'منشور مؤكد',
    title: '',
    assets: [],
    selections: caps.channels.map((c) => c.id),
    overrides: {},
    scheduleLocal: null,
    scheduleOffset: null,
  };
  const workflow = workflowMock();
  const runtimeEnv = { ...testEnv(), PUBLISH: workflow } as unknown as Env;
  async function submission(patch: Partial<Draft> = {}): Promise<Submission> {
    const plan = buildPlan({ ...draft, ...patch }, caps, new Date().toISOString());
    return { plan, planHash: await hashPlan(plan), preparedAssets: [] };
  }
  async function imageSubmission(workspace = 'workspace-a', state = 'complete') {
    const original = {
      id: 'source-photo',
      originalName: 'صورتنا.PNG',
      kind: 'image' as const,
      mimeType: 'image/png',
      bytes: 32,
      width: 32,
      height: 32,
    };
    const bytes = new Uint8Array(32);
    await testEnv().MEDIA.put('publication/image', bytes, {
      httpMetadata: { contentType: 'image/png' },
      customMetadata: { assetId: 'uploaded-image' },
    });
    await testEnv()
      .DB.prepare(
        'INSERT INTO assets(id,workspace_id,source_asset_id,object_key,original_name,kind,mime_type,bytes,sha256,width,height,state,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      .bind(
        'uploaded-image',
        workspace,
        original.id,
        'publication/image',
        original.originalName,
        original.kind,
        original.mimeType,
        original.bytes,
        'a'.repeat(64),
        32,
        32,
        state,
        Date.now(),
        Date.now(),
      )
      .run();
    const value = await submission({ assets: [original] });
    value.preparedAssets = [
      {
        sourceAssetId: original.id,
        recipeId: null,
        assetId: 'uploaded-image',
        sha256: 'a'.repeat(64),
      },
    ];
    return value;
  }
  return { draft, caps, workflow, env: runtimeEnv, submission, imageSubmission };
}
export function workflowSteps() {
  const sleeps: Date[] = [];
  const configurations: unknown[] = [];
  const step = {
    do: async (_name: string, configOrCallback: unknown, callback?: () => Promise<unknown>) => {
      if (callback) configurations.push(configOrCallback);
      return (callback ?? (configOrCallback as () => Promise<unknown>))();
    },
    sleepUntil: async (_name: string, timestamp: Date | number) => {
      const date = new Date(timestamp);
      sleeps.push(date);
      vi.setSystemTime(date);
    },
    sleep: async (_name: string, milliseconds: number) => {
      vi.setSystemTime(Date.now() + milliseconds);
    },
  } as unknown as WorkflowStep;
  return { step, sleeps, configurations };
}
