import { beforeEach, afterEach, test, expect, vi, inject } from 'vitest';
import {
  hashPlan,
  type Submission,
  type Draft,
  type Workspace,
  type CapabilitySnapshot,
} from '@mawjivo/core';
import { resetTestData, testEnv } from './helpers';
import { auth, publicationFixture, workflowSteps, workflowMock } from './publication-fixture';
import { bufferConnection, seedConnection } from './publishing-fixtures';
import { submitPost, cancelPost, retryPost, getPublicationReceipt } from '../src/posts';
import { runPublication } from '../src/workflows/publish';
import { bufferAdapter } from '../src/providers/buffer';
import { getSummary } from '../src/history';

interface CapturedFlow {
  submission: Submission;
  draft: Draft;
  workspace: Workspace;
  caps: CapabilitySnapshot;
  originalUploads: number;
}
declare module 'vitest' {
  interface ProvidedContext {
    fullFlow: CapturedFlow | null;
  }
}
beforeEach(async () => {
  await resetTestData();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-11T09:23:37.123Z'));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function capturedFixture(input: CapturedFlow) {
  const runtime = testEnv(),
    workspace = input.workspace;
  await runtime.DB.prepare(
    'INSERT INTO workspaces(id,name,time_zone,version,default_platforms,service_profile_id,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?,?)',
  )
    .bind(
      workspace.id,
      workspace.name,
      workspace.timeZone,
      workspace.version,
      JSON.stringify(workspace.defaultPlatforms),
      workspace.serviceProfileId,
      Date.now(),
      Date.now(),
    )
    .run();
  for (const target of input.submission.plan.targets) {
    const channel = input.caps.channels.find((item) => item.id === target.channelId)!;
    await seedConnection({
      ...bufferConnection,
      id: channel.connectionId,
      workspaceId: workspace.id,
    });
    await runtime.DB.prepare(
      'INSERT INTO channels(id,workspace_id,connection_id,remote_id,platform,provider,ready,limits_json,discovered_at_ms) VALUES(?,?,?,?,?,?,1,?,?)',
    )
      .bind(
        channel.id,
        workspace.id,
        channel.connectionId,
        'remote-' + channel.platform,
        channel.platform,
        channel.provider,
        JSON.stringify(channel.limits),
        Date.now(),
      )
      .run();
  }
  await runtime.DB.prepare(
    'INSERT INTO service_settings(key,value_json,updated_at_ms) VALUES(?,?,?)',
  )
    .bind('capabilities:' + workspace.id, JSON.stringify(input.caps), Date.now())
    .run();
  for (const prepared of input.submission.preparedAssets) {
    const asset = input.draft.assets.find((item) => item.id === prepared.sourceAssetId)!;
    expect(prepared.recipeId).toBeNull();
    const key = 'full-flow/' + prepared.assetId;
    await runtime.MEDIA.put(key, new Uint8Array(asset.bytes), {
      httpMetadata: { contentType: asset.mimeType },
      customMetadata: { assetId: prepared.assetId },
    });
    await runtime.DB.prepare(
      'INSERT INTO assets(id,workspace_id,source_asset_id,object_key,original_name,kind,mime_type,bytes,sha256,width,height,state,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    )
      .bind(
        prepared.assetId,
        workspace.id,
        asset.id,
        key,
        asset.originalName,
        asset.kind,
        asset.mimeType,
        asset.bytes,
        prepared.sha256,
        asset.width,
        asset.height,
        'complete',
        Date.now(),
        Date.now(),
      )
      .run();
  }
  return { ...runtime, PUBLISH: workflowMock() } as unknown as Env;
}

test('full_flow_preserves_confirmed_content_across_restart', async () => {
  const captured = inject('fullFlow');
  let env: Env, submission: Submission, created: number;
  if (captured) {
    expect(captured.originalUploads).toBe(1);
    env = await capturedFixture(captured);
    submission = captured.submission;
    created = Date.parse(captured.draft.createdAt);
  } else {
    const fixture = await publicationFixture();
    env = fixture.env;
    submission = await fixture.imageSubmission();
    created = Date.now();
    submission.plan.dueAt = '2026-10-11T19:23:37.123Z';
    submission.planHash = await hashPlan(submission.plan);
  }
  expect(Date.parse(submission.plan.dueAt!) - created).toBe(36_000_000);
  const confirmed = structuredClone(submission.plan);
  await env.DB.prepare('INSERT INTO service_settings(key,value_json,updated_at_ms) VALUES(?,?,?)')
    .bind('public_base_url', JSON.stringify('https://service.test'), Date.now())
    .run();
  const receipt = await submitPost(auth, submission, env);
  // Restart the consumer from durable rows after the desktop is closed. No desktop callback exists.
  const restart = { ...env };
  const stored = await restart.DB.prepare(
    'SELECT plan_json FROM post_revisions WHERE post_id=? AND revision=?',
  )
    .bind(receipt.postId, receipt.revision)
    .first<string>('plan_json');
  expect(JSON.parse(stored!)).toEqual(confirmed);
  const write = vi
    .spyOn(bufferAdapter, 'publishBatch')
    .mockImplementation(async (_connection, targets) =>
      targets.map((target) => ({
        kind: 'accepted' as const,
        channelId: target.channelId,
        remoteId: 'full-flow-receipt',
      })),
    );
  vi.spyOn(bufferAdapter, 'readReceipts').mockResolvedValue([
    { remoteId: 'full-flow-receipt', state: 'published' },
  ]);
  await runPublication(
    { postId: receipt.postId, revision: receipt.revision },
    workflowSteps().step,
    restart,
  );
  const summary = await getSummary(auth, submission.plan.workspaceId, '2026-10-11', restart);
  expect(summary.completePosts).toBe(1);
  expect(write).toHaveBeenCalledTimes(1);
  expect(write.mock.calls[0]![1][0]).toMatchObject(confirmed.targets[0]!);
  expect(write.mock.calls[0]![1][0]!.assets[0]!.url).toContain(
    encodeURIComponent(captured?.draft.assets[0]!.originalName ?? 'صورتنا.PNG'),
  );
  expect(
    await restart.DB.prepare('SELECT COUNT(*) FROM assets WHERE workspace_id=?')
      .bind(submission.plan.workspaceId)
      .first<number>('COUNT(*)'),
  ).toBe(1);
  expect((await getPublicationReceipt(auth, receipt.postId, restart)).state).toBe('published');
});

test('full_flow_cancel_and_retry_do_not_duplicate', async () => {
  const fixture = await publicationFixture(),
    cancelled = await submitPost(auth, await fixture.submission(), fixture.env);
  await cancelPost(auth, cancelled.postId, cancelled.revision, fixture.env);
  const writes = vi
    .spyOn(bufferAdapter, 'publishBatch')
    .mockImplementation(async (_connection, targets) =>
      targets.map((target) => ({
        kind: 'uncertain' as const,
        channelId: target.channelId,
        error: { code: 'PROVIDER_TIMEOUT', messageAr: 'تعذر تحديد النتيجة.', retryable: false },
      })),
    );
  await runPublication(
    { postId: cancelled.postId, revision: cancelled.revision },
    workflowSteps().step,
    fixture.env,
  );
  expect(writes.mock.calls.length).toBe(0);
  const submission = await fixture.submission({ id: 'other-draft' }),
    uncertain = await submitPost(auth, submission, fixture.env);
  await runPublication(
    { postId: uncertain.postId, revision: uncertain.revision },
    workflowSteps().step,
    fixture.env,
  );
  await retryPost(auth, uncertain.postId, uncertain.revision, fixture.env);
  await runPublication(
    { postId: uncertain.postId, revision: uncertain.revision },
    workflowSteps().step,
    fixture.env,
  );
  expect(writes).toHaveBeenCalledTimes(1);
  expect((await getPublicationReceipt(auth, uncertain.postId, fixture.env)).state).toBe(
    'uncertain',
  );
});
