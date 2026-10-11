import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { POLICY_VERSION, type PostPlan, type AppError } from '@mawjivo/core';
import { claimTarget, aggregatePost, type TargetRow, type RevisionRow } from '../posts';
import { loadConnection } from '../connections';
import { bufferAdapter } from '../providers/buffer';
import { metaAdapter } from '../providers/meta';
import type {
  ProviderAdapter,
  ProviderState,
  ResolvedTarget,
  ProviderResult,
  ProviderReceipt,
} from '../providers/types';
import type { AssetRow } from '../assets/model';
export interface PublishJob {
  postId: string;
  revision: number;
  receiptsOnly?: boolean;
}
const noWriteRetry = { retries: { limit: 0, delay: 1000 }, timeout: '5 minutes' as const };
const safeReadRetry = {
  retries: { limit: 2, delay: 1000, backoff: 'exponential' as const },
  timeout: '1 minute' as const,
};
const adapters: Record<string, ProviderAdapter> = { buffer: bufferAdapter, meta: metaAdapter };
function uncertain(): AppError {
  return {
    code: 'PUBLICATION_UNCERTAIN',
    messageAr: 'تعذر حسم نتيجة الإرسال. افحص المنصة قبل إعادة النشر.',
    retryable: false,
  };
}
async function rows(job: PublishJob, env: Env): Promise<TargetRow[]> {
  return (
    await env.DB.prepare('SELECT * FROM targets WHERE post_id=? AND revision=?')
      .bind(job.postId, job.revision)
      .all<TargetRow>()
  ).results;
}
async function resolved(
  job: PublishJob,
  target: PostPlan['targets'][number],
  row: TargetRow,
  claimId: string,
  env: Env,
): Promise<ResolvedTarget> {
  const assets = (
    await env.DB.prepare(
      'SELECT a.*,u.alias_nonce,u.sent_name FROM asset_uses u JOIN assets a ON a.id=u.asset_id AND a.workspace_id=u.workspace_id WHERE u.post_id=? AND u.revision=? AND u.channel_id=?',
    )
      .bind(job.postId, job.revision, target.channelId)
      .all<AssetRow & { alias_nonce: string; sent_name: string }>()
  ).results;
  const origin = target.assets.length
    ? await env.DB.prepare(
        "SELECT value_json FROM service_settings WHERE key='public_base_url'",
      ).first<{ value_json: string }>()
    : null;
  if (target.assets.length && !origin) throw new Error('MEDIA_ORIGIN_MISSING');
  const base = origin ? (JSON.parse(origin.value_json) as string) : '';
  if (base && !/^https:\/\/[^\s/?#]+$/.test(base)) throw new Error('MEDIA_ORIGIN_INVALID');
  return {
    ...target,
    assets: target.assets.map((use) => {
      const asset = assets.find(
        (a) => a.source_asset_id === use.sourceAssetId && a.recipe_id === use.recipeId,
      );
      if (!asset || asset.state !== 'complete' || !asset.sha256) throw new Error('MEDIA_NOT_READY');
      return {
        ...use,
        assetId: asset.id,
        bytes: asset.bytes,
        mimeType: asset.mime_type,
        url: base + '/media/' + asset.alias_nonce + '/' + encodeURIComponent(asset.sent_name),
      };
    }),
    providerState: row.provider_state_json
      ? (JSON.parse(row.provider_state_json) as ProviderState)
      : undefined,
    checkpoint: async (state) => {
      const saved = await env.DB.prepare(
        "UPDATE targets SET provider_state_json=?,updated_at_ms=? WHERE post_id=? AND revision=? AND channel_id=? AND claim_id=? AND state IN ('sending','accepted')",
      )
        .bind(
          JSON.stringify(state),
          Date.now(),
          job.postId,
          job.revision,
          target.channelId,
          claimId,
        )
        .run();
      if (!saved.meta.changes) throw new Error('CLAIM_LOST');
    },
  };
}
async function saveResult(
  job: PublishJob,
  result: ProviderResult,
  claimId: string,
  env: Env,
): Promise<void> {
  const accepted = result.kind === 'accepted',
    retryAt =
      result.kind === 'rejected' && result.error.code === 'PROVIDER_RATE_LIMIT' && result.retryAt
        ? Date.parse(result.retryAt)
        : NaN,
    deferred = Number.isFinite(retryAt) && retryAt > Date.now(),
    state = accepted
      ? 'accepted'
      : deferred
        ? 'ready'
        : result.kind === 'uncertain'
          ? 'uncertain'
          : 'failed';
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE targets SET state=?,remote_id=?,error_json=?,provider_state_json=COALESCE(?,provider_state_json),next_check_ms=?,claim_id=?,updated_at_ms=? WHERE post_id=? AND revision=? AND channel_id=? AND claim_id=? AND state='sending'",
    ).bind(
      state,
      accepted ? result.remoteId : null,
      accepted ? null : JSON.stringify(result.error),
      result.providerState ? JSON.stringify(result.providerState) : null,
      accepted ? Date.now() + 60000 : deferred ? retryAt : null,
      result.kind === 'rejected' ? null : claimId,
      Date.now(),
      job.postId,
      job.revision,
      result.channelId,
      claimId,
    ),
    env.DB.prepare(
      'UPDATE target_parts SET state=? WHERE post_id=? AND revision=? AND channel_id=? AND EXISTS(SELECT 1 FROM targets WHERE post_id=? AND revision=? AND channel_id=? AND state=?)',
    ).bind(
      state,
      job.postId,
      job.revision,
      result.channelId,
      job.postId,
      job.revision,
      result.channelId,
      state,
    ),
  ]);
}
async function saveReceipt(
  job: PublishJob,
  target: PostPlan['targets'][number],
  row: TargetRow,
  receipt: ProviderReceipt,
  env: Env,
): Promise<void> {
  const failedThread =
    receipt.state === 'failed' && target.threadParts.length > 1 && !receipt.partReceipts;
  const rateWait =
    receipt.state === 'unknown' &&
    receipt.error?.code === 'PROVIDER_RATE_LIMIT' &&
    receipt.retryAt &&
    Number.isFinite(Date.parse(receipt.retryAt)) &&
    Date.parse(receipt.retryAt) > Date.now();
  const state = rateWait
    ? 'accepted'
    : failedThread || receipt.state === 'unknown'
      ? 'uncertain'
      : receipt.state === 'processing'
        ? 'accepted'
        : receipt.state === 'published'
          ? 'published'
          : 'failed';
  const error = state === 'uncertain' ? (receipt.error ?? uncertain()) : receipt.error;
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE targets SET state=?,public_url=COALESCE(?,public_url),error_json=?,next_check_ms=?,receipt_attempts=receipt_attempts+1,published_at_ms=COALESCE(?,published_at_ms),updated_at_ms=? WHERE post_id=? AND revision=? AND channel_id=? AND remote_id=? AND state='accepted'",
    ).bind(
      state,
      receipt.publicUrl ?? null,
      error ? JSON.stringify(error) : null,
      state === 'accepted'
        ? Date.parse(
            receipt.retryAt ??
              new Date(
                Date.now() + Math.min(3600000, 60000 * 5 ** Math.min(row.receipt_attempts, 3)),
              ).toISOString(),
          )
        : null,
      state === 'published'
        ? receipt.publishedAt && Number.isFinite(Date.parse(receipt.publishedAt))
          ? Date.parse(receipt.publishedAt)
          : Date.now()
        : null,
      Date.now(),
      job.postId,
      job.revision,
      target.channelId,
      row.remote_id,
    ),
    env.DB.prepare(
      'UPDATE target_parts SET state=? WHERE post_id=? AND revision=? AND channel_id=? AND EXISTS(SELECT 1 FROM targets WHERE post_id=? AND revision=? AND channel_id=? AND state=?)',
    ).bind(
      state,
      job.postId,
      job.revision,
      target.channelId,
      job.postId,
      job.revision,
      target.channelId,
      state,
    ),
  ]);
  for (const part of receipt.partReceipts ?? [])
    await env.DB.prepare(
      'UPDATE target_parts SET state=?,remote_id=?,public_url=NULL WHERE post_id=? AND revision=? AND channel_id=? AND part_index=?',
    )
      .bind(
        part.state === 'processing'
          ? 'accepted'
          : part.state === 'unknown'
            ? 'uncertain'
            : part.state,
        part.remoteId,
        job.postId,
        job.revision,
        target.channelId,
        part.partIndex,
      )
      .run();
}
async function publishConnection(
  job: PublishJob,
  plan: PostPlan,
  frozen: RevisionRow['channel_snapshot_json'],
  connectionId: string,
  env: Env,
): Promise<void> {
  const snapshots = JSON.parse(frozen) as {
      id: string;
      connectionId: string;
      remoteId: string;
      limitsJson: string;
      provider: string;
      platform: string;
    }[],
    candidates = plan.targets.filter((t) => t.connectionId === connectionId),
    claimed: { target: ResolvedTarget; claimId: string }[] = [];
  for (const target of candidates) {
    const current = (await rows(job, env)).find((r) => r.channel_id === target.channelId);
    if (current?.state !== 'ready') continue;
    const frozenChannel = snapshots.find((s) => s.id === target.channelId),
      channel = await env.DB.prepare(
        'SELECT connection_id,remote_id,ready,limits_json,provider,platform FROM channels WHERE workspace_id=? AND id=?',
      )
        .bind(plan.workspaceId, target.channelId)
        .first<{
          connection_id: string;
          remote_id: string;
          ready: number;
          limits_json: string;
          provider: string;
          platform: string;
        }>();
    if (
      plan.policyVersion !== POLICY_VERSION ||
      !frozenChannel ||
      !channel?.ready ||
      channel.connection_id !== frozenChannel.connectionId ||
      channel.remote_id !== frozenChannel.remoteId ||
      channel.limits_json !== frozenChannel.limitsJson ||
      channel.provider !== frozenChannel.provider ||
      channel.platform !== frozenChannel.platform
    ) {
      await env.DB.prepare(
        "UPDATE targets SET state='failed',error_json=?,updated_at_ms=? WHERE post_id=? AND revision=? AND channel_id=? AND state='ready' AND claim_id IS NULL",
      )
        .bind(
          JSON.stringify({
            code: 'REVIEW_REQUIRED',
            messageAr: 'تغيرت حدود الحساب أو ربطه. أعد مراجعة هذه الوجهة.',
            retryable: false,
          }),
          Date.now(),
          job.postId,
          job.revision,
          target.channelId,
        )
        .run();
      continue;
    }
    const claim = await claimTarget(job.postId, job.revision, target.channelId, env);
    if (claim.kind !== 'claimed') continue;
    try {
      claimed.push({
        target: await resolved(job, target, current, claim.claimId, env),
        claimId: claim.claimId,
      });
    } catch {
      await saveResult(
        job,
        {
          kind: 'rejected',
          channelId: target.channelId,
          error: {
            code: 'ASSET_NOT_READY',
            messageAr: 'الملف المرفوع أو رابط الوسائط يحتاج إصلاحًا.',
            retryable: true,
          },
        },
        claim.claimId,
        env,
      );
    }
  }
  if (!claimed.length) return;
  let results: ProviderResult[];
  try {
    const connection = await loadConnection(plan.workspaceId, connectionId, env);
    results = await adapters[connection.provider]!.publishBatch(
      connection,
      claimed.map((c) => c.target),
      env,
    );
  } catch {
    results = claimed.map((c) => ({
      kind: 'uncertain',
      channelId: c.target.channelId,
      error: uncertain(),
    }));
  }
  for (const item of claimed) {
    const matching = results.filter((r) => r.channelId === item.target.channelId);
    await saveResult(
      job,
      matching.length === 1
        ? matching[0]!
        : { kind: 'uncertain', channelId: item.target.channelId, error: uncertain() },
      item.claimId,
      env,
    );
  }
  await aggregatePost(job.postId, job.revision, env);
}
async function receiptConnection(
  job: PublishJob,
  plan: PostPlan,
  connectionId: string,
  env: Env,
): Promise<void> {
  const current = (await rows(job, env)).filter(
      (r) =>
        r.state === 'accepted' &&
        r.remote_id &&
        r.next_check_ms !== null &&
        r.next_check_ms <= Date.now(),
    ),
    targets = plan.targets.filter(
      (t) => t.connectionId === connectionId && current.some((r) => r.channel_id === t.channelId),
    );
  if (!targets.length) return;
  const connection = await loadConnection(plan.workspaceId, connectionId, env),
    adapter = adapters[connection.provider]!,
    receipts = await adapter.readReceipts(
      connection,
      targets.map((t) => current.find((r) => r.channel_id === t.channelId)!.remote_id!),
      env,
    );
  for (const target of targets) {
    const row = current.find((r) => r.channel_id === target.channelId)!,
      receipt = receipts.find((r) => r.remoteId === row.remote_id);
    if (!receipt)
      await saveReceipt(
        job,
        target,
        row,
        { remoteId: row.remote_id!, state: 'unknown', error: uncertain() },
        env,
      );
    else if (!receipt.continuation) await saveReceipt(job, target, row, receipt, env);
    else
      await env.DB.prepare(
        "UPDATE targets SET next_check_ms=?,receipt_attempts=receipt_attempts+1,updated_at_ms=? WHERE post_id=? AND revision=? AND channel_id=? AND state='accepted' AND remote_id=?",
      )
        .bind(Date.now(), Date.now(), job.postId, job.revision, target.channelId, row.remote_id)
        .run();
  }
  await aggregatePost(job.postId, job.revision, env);
}
async function continueMeta(job: PublishJob, plan: PostPlan, env: Env): Promise<void> {
  for (const target of plan.targets.filter(
    (t) => t.provider === 'meta' && t.platform === 'instagram',
  )) {
    const row = (await rows(job, env)).find((r) => r.channel_id === target.channelId);
    if (
      row?.state !== 'accepted' ||
      !row.provider_state_json ||
      row.next_check_ms === null ||
      row.next_check_ms > Date.now()
    )
      continue;
    const claimId = crypto.randomUUID(),
      claimed = await env.DB.prepare(
        "UPDATE targets SET continuation_claim_id=?,updated_at_ms=? WHERE post_id=? AND revision=? AND channel_id=? AND state='accepted' AND continuation_claim_id IS NULL",
      )
        .bind(claimId, Date.now(), job.postId, job.revision, target.channelId)
        .run();
    if (!claimed.meta.changes) continue;
    const connection = await loadConnection(plan.workspaceId, target.connectionId, env),
      adapter = adapters[connection.provider]!;
    let result: ProviderResult;
    try {
      result = await adapter.continuePublishing!(
        connection,
        await resolved(job, target, row, row.claim_id!, env),
        env,
      );
    } catch {
      result = { kind: 'uncertain', channelId: target.channelId, error: uncertain() };
    }
    await env.DB.prepare(
      "UPDATE targets SET state=?,remote_id=COALESCE(?,remote_id),error_json=?,provider_state_json=COALESCE(?,provider_state_json),next_check_ms=?,continuation_rejected=?,updated_at_ms=? WHERE post_id=? AND revision=? AND channel_id=? AND continuation_claim_id=? AND state='accepted'",
    )
      .bind(
        result.kind === 'accepted'
          ? 'accepted'
          : result.kind === 'uncertain'
            ? 'uncertain'
            : 'failed',
        result.kind === 'accepted' ? result.remoteId : null,
        result.kind === 'accepted' ? null : JSON.stringify(result.error),
        result.providerState ? JSON.stringify(result.providerState) : null,
        result.kind === 'accepted' ? Date.now() + 60000 : null,
        result.kind === 'rejected' ? 1 : 0,
        Date.now(),
        job.postId,
        job.revision,
        target.channelId,
        claimId,
      )
      .run();
  }
  await aggregatePost(job.postId, job.revision, env);
}
export async function runPublication(job: PublishJob, step: WorkflowStep, env: Env): Promise<void> {
  const snapshot = await step.do('confirmed-plan', safeReadRetry, async () =>
    env.DB.prepare(
      'SELECT r.* FROM post_revisions r JOIN posts p ON p.id=r.post_id WHERE r.post_id=? AND r.revision=? AND p.revision=r.revision AND (p.cancel_requested_ms IS NULL OR ?=1)',
    )
      .bind(job.postId, job.revision, job.receiptsOnly ? 1 : 0)
      .first<RevisionRow>(),
  );
  if (!snapshot) return;
  const plan = JSON.parse(snapshot.plan_json) as PostPlan;
  if (plan.dueAt && Date.parse(plan.dueAt) > Date.now())
    await step.sleepUntil('publication-time', new Date(plan.dueAt));
  const connections = [...new Set(plan.targets.map((t) => t.connectionId))];
  if (!job.receiptsOnly)
    for (const connection of connections)
      await step.do('send-' + connection, noWriteRetry, () =>
        publishConnection(job, plan, snapshot.channel_snapshot_json, connection, env),
      );
  for (let cycle = 0; cycle < 100; cycle++) {
    const pending = await step.do('pending-' + cycle, safeReadRetry, async () => {
      const list = (await rows(job, env)).filter(
        (r) =>
          (r.state === 'accepted' || (!job.receiptsOnly && r.state === 'ready')) &&
          r.next_check_ms !== null,
      );
      return list.length ? Math.min(...list.map((r) => r.next_check_ms!)) : null;
    });
    if (pending === null) break;
    if (pending > Date.now()) await step.sleepUntil('receipt-time-' + cycle, new Date(pending));
    if (!job.receiptsOnly)
      for (const connection of connections)
        await step.do('deferred-send-' + cycle + '-' + connection, noWriteRetry, () =>
          publishConnection(job, plan, snapshot.channel_snapshot_json, connection, env),
        );
    for (const connection of connections)
      await step.do('receipt-' + cycle + '-' + connection, safeReadRetry, () =>
        receiptConnection(job, plan, connection, env),
      );
    if (!job.receiptsOnly)
      await step.do('meta-continuation-' + cycle, noWriteRetry, () => continueMeta(job, plan, env));
  }
  await step.do('final-state', safeReadRetry, () => aggregatePost(job.postId, job.revision, env));
}
export class PublishWorkflow extends WorkflowEntrypoint<Env, PublishJob> {
  async run(event: WorkflowEvent<PublishJob>, step: WorkflowStep): Promise<void> {
    await runPublication(event.payload, step, this.env);
  }
}
