import {
  SubmissionSchema,
  CapabilitySnapshotSchema,
  POLICY_VERSION,
  buildPlan,
  hashPlan,
  videoFilename,
  type Submission,
  type PublicationReceipt,
  type PublicationState,
  type ISOInstant,
  type CapabilitySnapshot,
  type Channel,
  type PreparedAsset,
} from '@mawjivo/core';
import type { AuthContext } from './auth';
import { requireWorkspace } from './auth';
import { getWorkspace } from './workspaces';
import { ServiceError } from './errors';
import { assetDto, type AssetRow } from './assets/model';
export type ClaimResult =
  { kind: 'claimed'; claimId: string } | { kind: 'skipped'; reason: string };
export interface PostRow {
  id: string;
  workspace_id: string;
  draft_id: string;
  revision: number;
  plan_hash: string;
  plan_json: string;
  state: PublicationState;
  due_at_ms: number | null;
  workflow_id: string | null;
  locked_at_ms: number | null;
  cancel_requested_ms: number | null;
  dispatch_generation: number;
  updated_at_ms: number;
  created_at_ms: number;
}
export interface TargetRow {
  post_id: string;
  revision: number;
  workspace_id: string;
  channel_id: string;
  state: PublicationState;
  claim_id: string | null;
  claimed_at_ms: number | null;
  remote_id: string | null;
  public_url: string | null;
  error_json: string | null;
  next_check_ms: number | null;
  updated_at_ms: number;
  provider_state_json: string | null;
  receipt_attempts: number;
  continuation_claim_id: string | null;
  continuation_rejected: number;
}
export interface RevisionRow {
  post_id: string;
  revision: number;
  workspace_id: string;
  draft_id: string;
  plan_hash: string;
  plan_json: string;
  channel_snapshot_json: string;
}
interface FrozenChannel {
  id: string;
  connectionId: string;
  remoteId: string;
  platform: string;
  provider: string;
  limitsJson: string;
}
function reviewRequired(): ServiceError {
  return new ServiceError(
    'REVIEW_REQUIRED',
    'تغيرت إعدادات النشر أو حدود الحساب. أعد المراجعة.',
    409,
  );
}
function invalid(): ServiceError {
  return new ServiceError(
    'PLAN_INVALID',
    'خطة النشر لا تطابق حدود الحساب أو الملفات المرفوعة. أعد المراجعة.',
    409,
  );
}
async function parsed(auth: AuthContext, value: Submission): Promise<Submission> {
  const result = SubmissionSchema.safeParse(value);
  if (!result.success) throw invalid();
  const submission = result.data;
  requireWorkspace(auth, submission.plan.workspaceId);
  if ((await hashPlan(submission.plan)) !== submission.planHash)
    throw new ServiceError('PLAN_HASH_MISMATCH', 'تغير المحتوى بعد المراجعة. راجعه مجددًا.', 409);
  return submission;
}
export async function postRow(auth: AuthContext, id: string, env: Env): Promise<PostRow> {
  const post = await env.DB.prepare('SELECT * FROM posts WHERE id=?').bind(id).first<PostRow>();
  if (!post) throw new ServiceError('NOT_FOUND', 'المنشور غير موجود.', 404);
  requireWorkspace(auth, post.workspace_id);
  return post;
}
async function previous(submission: Submission, env: Env): Promise<RevisionRow | null> {
  return env.DB.prepare(
    'SELECT * FROM post_revisions WHERE workspace_id=? AND draft_id=? AND revision=?',
  )
    .bind(submission.plan.workspaceId, submission.plan.draftId, submission.plan.revision)
    .first<RevisionRow>();
}
async function validate(
  submission: Submission,
  auth: AuthContext,
  env: Env,
): Promise<{ assets: Map<string, AssetRow>; frozen: FrozenChannel[] }> {
  const plan = submission.plan,
    now = Date.now();
  if (plan.dueAt) {
    const due = Date.parse(plan.dueAt);
    if (due <= now) throw new ServiceError('SCHEDULE_IN_PAST', 'اختر وقتًا بعد الوقت الحالي.');
    if (due > now + 365 * 86400000)
      throw new ServiceError('SCHEDULE_TOO_FAR', 'يمكن الجدولة حتى سنة من الآن.');
  }
  const workspace = await getWorkspace(auth, plan.workspaceId, env);
  const cache = await env.DB.prepare('SELECT value_json FROM service_settings WHERE key=?')
    .bind('capabilities:' + plan.workspaceId)
    .first<{ value_json: string }>();
  if (
    !cache ||
    workspace.version !== plan.workspaceVersion ||
    workspace.timeZone !== plan.timeZone ||
    plan.policyVersion !== POLICY_VERSION
  )
    throw reviewRequired();
  let caps: CapabilitySnapshot;
  try {
    caps = CapabilitySnapshotSchema.parse(JSON.parse(cache.value_json));
  } catch {
    throw reviewRequired();
  }
  if (caps.version !== plan.capabilityVersion) throw reviewRequired();
  if (
    !plan.targets.length ||
    plan.targets.length > 30 ||
    new Set(plan.targets.map((t) => t.channelId)).size !== plan.targets.length ||
    submission.preparedAssets.length > 600 ||
    plan.mediaRecipes.length > 600
  )
    throw invalid();
  const prepared = new Map<string, PreparedAsset>();
  for (const asset of submission.preparedAssets) {
    const key = JSON.stringify([asset.sourceAssetId, asset.recipeId]);
    if (prepared.has(key)) throw invalid();
    prepared.set(key, asset);
  }
  const rows = (
    await env.DB.prepare('SELECT * FROM assets WHERE id IN (SELECT value FROM json_each(?))')
      .bind(JSON.stringify(submission.preparedAssets.map((a) => a.assetId)))
      .all<AssetRow>()
  ).results;
  const assets = new Map(rows.map((row) => [row.id, row]));
  for (const item of submission.preparedAssets) {
    const row = assets.get(item.assetId);
    if (!row) throw new ServiceError('ASSET_NOT_READY', 'لم يكتمل رفع الملف.', 409);
    if (
      row.workspace_id !== plan.workspaceId ||
      row.source_asset_id !== item.sourceAssetId ||
      row.recipe_id !== item.recipeId
    )
      throw new ServiceError('ASSET_SCOPE', 'الملف لا يخص هذه المساحة أو نسخة المعالجة.', 403);
    if (row.state !== 'complete' || row.sha256 !== item.sha256)
      throw new ServiceError('ASSET_NOT_READY', 'لم يكتمل رفع الملف والتحقق منه.', 409);
    const head = await env.MEDIA.head(row.object_key);
    if (
      !head ||
      head.size !== row.bytes ||
      head.httpMetadata?.contentType !== row.mime_type ||
      head.customMetadata?.assetId !== row.id
    )
      throw new ServiceError('ASSET_NOT_READY', 'الملف المرفوع يحتاج إعادة تحقق.', 409);
  }
  const channelRows = (
    await env.DB.prepare(
      'SELECT id,connection_id,remote_id,platform,provider,ready,limits_json FROM channels WHERE workspace_id=? AND id IN (SELECT value FROM json_each(?))',
    )
      .bind(plan.workspaceId, JSON.stringify(plan.targets.map((t) => t.channelId)))
      .all<{
        id: string;
        connection_id: string;
        remote_id: string;
        platform: string;
        provider: string;
        ready: number;
        limits_json: string;
      }>()
  ).results;
  const frozen: FrozenChannel[] = [],
    used = new Set<string>();
  for (const target of plan.targets) {
    const channel = caps.channels.find((c) => c.id === target.channelId),
      row = channelRows.find((c) => c.id === target.channelId);
    if (
      !channel?.ready ||
      !row?.ready ||
      row.connection_id !== target.connectionId ||
      row.platform !== target.platform ||
      row.provider !== target.provider ||
      channel.connectionId !== target.connectionId ||
      channel.provider !== target.provider ||
      channel.platform !== target.platform
    )
      throw reviewRequired();
    const limits = CapabilitySnapshotSchema.parse({
      ...caps,
      channels: [{ ...channel, limits: JSON.parse(row.limits_json) }],
    }).channels[0]!.limits;
    if (JSON.stringify(limits) !== JSON.stringify(channel.limits)) throw reviewRequired();
    frozen.push({
      id: row.id,
      connectionId: row.connection_id,
      remoteId: row.remote_id,
      platform: row.platform,
      provider: row.provider,
      limitsJson: row.limits_json,
    });
    if (target.assets.length > 20) throw invalid();
    const actual = target.assets.map((use) => {
      const key = JSON.stringify([use.sourceAssetId, use.recipeId]),
        item = prepared.get(key);
      if (!item)
        throw new ServiceError('ASSET_NOT_READY', 'جهّز كل الملفات المطلوبة قبل الموافقة.', 409);
      used.add(key);
      const asset = assets.get(item.assetId)!;
      const recipe = use.recipeId ? plan.mediaRecipes.find((r) => r.id === use.recipeId) : null;
      if (
        use.recipeId &&
        (!recipe ||
          recipe.sourceAssetId !== use.sourceAssetId ||
          recipe.outputMimeType !== asset.mime_type)
      )
        throw invalid();
      return { ...assetDto(asset), id: use.sourceAssetId };
    });
    let checked;
    try {
      checked = buildPlan(
        {
          id: plan.draftId,
          workspaceId: plan.workspaceId,
          workspaceVersion: plan.workspaceVersion,
          timeZone: plan.timeZone,
          revision: plan.revision,
          createdAt: new Date(now).toISOString(),
          text: target.text,
          title: target.title ?? '',
          assets: actual,
          selections: [channel.id],
          overrides: {
            [channel.platform]: {
              text: target.text,
              altTexts: target.altTexts,
              ...(target.threadParts.length ? { threadParts: target.threadParts } : {}),
            },
          },
          scheduleLocal: null,
          scheduleOffset: null,
        },
        { ...caps, channels: [channel] },
        new Date(now).toISOString(),
      );
    } catch {
      throw invalid();
    }
    const expected = checked.targets[0];
    if (
      !expected ||
      checked.mediaRecipes.length ||
      checked.excluded.length ||
      ['text', 'title', 'threadParts', 'altTexts'].some(
        (field) =>
          JSON.stringify(expected[field as keyof typeof expected]) !==
          JSON.stringify(target[field as keyof typeof target]),
      ) ||
      JSON.stringify(expected.assets.map((a) => a.sourceAssetId)) !==
        JSON.stringify(target.assets.map((a) => a.sourceAssetId))
    )
      throw invalid();
  }
  if (
    used.size !== prepared.size ||
    plan.mediaRecipes.some(
      (recipe) =>
        !plan.targets.some((target) => target.assets.some((use) => use.recipeId === recipe.id)),
    )
  )
    throw invalid();
  return { assets, frozen };
}
const assetGuard =
  "NOT EXISTS(SELECT 1 FROM json_each(?) j LEFT JOIN assets a ON a.id=json_extract(j.value,'$.assetId') WHERE a.id IS NULL OR a.workspace_id!=? OR a.state!='complete' OR a.sha256!=json_extract(j.value,'$.sha256') OR a.source_asset_id!=json_extract(j.value,'$.sourceAssetId') OR COALESCE(a.recipe_id,'')!=COALESCE(json_extract(j.value,'$.recipeId'),''))";
const channelGuard =
  "NOT EXISTS(SELECT 1 FROM json_each(?) j LEFT JOIN channels c ON c.id=json_extract(j.value,'$.id') AND c.workspace_id=? WHERE c.id IS NULL OR c.ready!=1 OR c.connection_id!=json_extract(j.value,'$.connectionId') OR c.remote_id!=json_extract(j.value,'$.remoteId') OR c.limits_json!=json_extract(j.value,'$.limitsJson'))";
const settingsGuard =
  "(SELECT version FROM workspaces WHERE id=?)=? AND (SELECT json_extract(value_json,'$.version') FROM service_settings WHERE key=?)=?";
function guardValues(s: Submission, frozen: FrozenChannel[]): unknown[] {
  return [
    JSON.stringify(s.preparedAssets),
    s.plan.workspaceId,
    JSON.stringify(frozen),
    s.plan.workspaceId,
    s.plan.workspaceId,
    s.plan.workspaceVersion,
    'capabilities:' + s.plan.workspaceId,
    s.plan.capabilityVersion,
  ];
}
function workflowId(id: string, revision: number, generation = 0): string {
  return `post-${id}-r${revision}-g${generation}`;
}
function dispatchStatement(
  id: string,
  revision: number,
  jobId: string,
  action: 'create' | 'terminate',
  env: Env,
  committed?: { revision: number; planHash: string },
): D1PreparedStatement {
  return env.DB.prepare(
    "INSERT INTO dispatch_outbox(id,post_id,revision,workflow_id,action,state,next_attempt_ms) SELECT ?,?,?,?,?, 'pending',? WHERE EXISTS(SELECT 1 FROM post_revisions WHERE post_id=? AND revision=?)" +
      (committed
        ? ' AND EXISTS(SELECT 1 FROM posts WHERE id=? AND revision=? AND plan_hash=?)'
        : '') +
      ' ON CONFLICT(post_id,revision,action) DO NOTHING',
  ).bind(
    crypto.randomUUID(),
    id,
    revision,
    jobId,
    action,
    Date.now(),
    id,
    revision,
    ...(committed ? [id, committed.revision, committed.planHash] : []),
  );
}
function revisionStatements(
  id: string,
  s: Submission,
  assets: Map<string, AssetRow>,
  frozen: FrozenChannel[],
  env: Env,
): D1PreparedStatement[] {
  const p = s.plan,
    now = Date.now(),
    statements = [
      env.DB.prepare(
        'INSERT OR IGNORE INTO post_revisions(post_id,revision,workspace_id,draft_id,plan_hash,plan_json,channel_snapshot_json,created_at_ms) SELECT id,revision,workspace_id,draft_id,plan_hash,plan_json,?,? FROM posts WHERE id=? AND revision=? AND plan_hash=?',
      ).bind(JSON.stringify(frozen), now, id, p.revision, s.planHash),
    ];
  for (const target of p.targets) {
    statements.push(
      env.DB.prepare(
        "INSERT OR IGNORE INTO targets(post_id,revision,channel_id,workspace_id,state,updated_at_ms) SELECT ?,?,?,?,'ready',? WHERE EXISTS(SELECT 1 FROM posts WHERE id=? AND revision=? AND plan_hash=?)",
      ).bind(id, p.revision, target.channelId, p.workspaceId, now, id, p.revision, s.planHash),
    );
    for (let index = 0; index < target.threadParts.length; index++)
      statements.push(
        env.DB.prepare(
          "INSERT OR IGNORE INTO target_parts(post_id,revision,channel_id,part_index,state) SELECT ?,?,?,?,'ready' WHERE EXISTS(SELECT 1 FROM targets WHERE post_id=? AND revision=? AND channel_id=?)",
        ).bind(id, p.revision, target.channelId, index, id, p.revision, target.channelId),
      );
    for (const use of target.assets) {
      const asset = s.preparedAssets.find(
          (a) => a.sourceAssetId === use.sourceAssetId && a.recipeId === use.recipeId,
        )!,
        row = assets.get(asset.assetId)!;
      const name =
        row.kind === 'image'
          ? row.original_name
          : (use.sentName ??
            videoFilename(
              target.title!,
              row.mime_type === 'video/quicktime'
                ? 'mov'
                : row.mime_type === 'video/webm'
                  ? 'webm'
                  : 'mp4',
            ));
      const nonce =
        crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
      statements.push(
        env.DB.prepare(
          'INSERT OR IGNORE INTO asset_uses(asset_id,workspace_id,post_id,revision,channel_id,alias_nonce,sent_name) SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM targets WHERE post_id=? AND revision=? AND channel_id=?)',
        ).bind(
          row.id,
          p.workspaceId,
          id,
          p.revision,
          target.channelId,
          nonce,
          name,
          id,
          p.revision,
          target.channelId,
        ),
      );
    }
  }
  statements.push(dispatchStatement(id, p.revision, workflowId(id, p.revision), 'create', env));
  return statements;
}
export async function submitPost(
  auth: AuthContext,
  value: Submission,
  env: Env,
): Promise<PublicationReceipt> {
  const s = await parsed(auth, value),
    found = await previous(s, env);
  if (found) {
    if (found.plan_hash !== s.planHash)
      throw new ServiceError(
        'REVISION_CONFLICT',
        'نسخة المسودة محفوظة بمحتوى مختلف. أعد المراجعة.',
        409,
      );
    return getPublicationReceipt(auth, found.post_id, env, found.revision);
  }
  const { assets, frozen } = await validate(s, auth, env),
    id = crypto.randomUUID(),
    p = s.plan,
    now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO posts(id,workspace_id,draft_id,revision,plan_hash,plan_json,state,due_at_ms,created_at_ms,updated_at_ms,workflow_id) SELECT ?,?,?,?,?,?,'preparing',?,?,?,? WHERE ${assetGuard} AND ${channelGuard} AND ${settingsGuard} AND NOT EXISTS(SELECT 1 FROM post_revisions WHERE workspace_id=? AND draft_id=?)`,
    ).bind(
      id,
      p.workspaceId,
      p.draftId,
      p.revision,
      s.planHash,
      JSON.stringify(p),
      p.dueAt ? Date.parse(p.dueAt) : null,
      now,
      now,
      workflowId(id, p.revision),
      ...guardValues(s, frozen),
      p.workspaceId,
      p.draftId,
    ),
    ...revisionStatements(id, s, assets, frozen, env),
  ]);
  const saved = await previous(s, env);
  if (!saved || saved.plan_hash !== s.planHash) throw reviewRequired();
  await drainDispatchOutbox(new Date().toISOString(), env);
  return getPublicationReceipt(auth, saved.post_id, env, saved.revision);
}
export async function revisePost(
  auth: AuthContext,
  id: string,
  expected: number,
  value: Submission,
  env: Env,
): Promise<PublicationReceipt> {
  const s = await parsed(auth, value),
    post = await postRow(auth, id, env);
  if (
    s.plan.workspaceId !== post.workspace_id ||
    s.plan.draftId !== post.draft_id ||
    s.plan.revision !== expected + 1
  )
    throw invalid();
  const prior = await previous(s, env);
  if (prior && prior.post_id === id && prior.plan_hash === s.planHash)
    return getPublicationReceipt(auth, id, env, prior.revision);
  if (post.revision !== expected)
    throw new ServiceError(
      'REVISION_CONFLICT',
      'تغير المنشور من نافذة أخرى. حدّثه قبل التعديل.',
      409,
    );
  if (post.locked_at_ms !== null)
    throw new ServiceError(
      'POST_LOCKED',
      'بدأ إرسال المنشور؛ يمكن إلغاء الوجهات التي لم تبدأ فقط.',
      409,
    );
  if (post.cancel_requested_ms !== null)
    throw new ServiceError('POST_CANCELLED', 'المنشور ملغى. ابدأ منشورًا جديدًا.', 409);
  const { assets, frozen } = await validate(s, auth, env),
    p = s.plan,
    now = Date.now();
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE posts SET revision=?,plan_hash=?,plan_json=?,state='preparing',due_at_ms=?,workflow_id=?,dispatch_generation=0,updated_at_ms=? WHERE id=? AND revision=? AND locked_at_ms IS NULL AND cancel_requested_ms IS NULL AND ${assetGuard} AND ${channelGuard} AND ${settingsGuard}`,
    ).bind(
      p.revision,
      s.planHash,
      JSON.stringify(p),
      p.dueAt ? Date.parse(p.dueAt) : null,
      workflowId(id, p.revision),
      now,
      id,
      expected,
      ...guardValues(s, frozen),
    ),
    env.DB.prepare(
      "UPDATE targets SET state='cancelled',updated_at_ms=? WHERE post_id=? AND revision=? AND claim_id IS NULL AND EXISTS(SELECT 1 FROM posts WHERE id=? AND revision=? AND plan_hash=?)",
    ).bind(now, id, expected, id, p.revision, s.planHash),
    env.DB.prepare(
      "UPDATE target_parts SET state='cancelled' WHERE post_id=? AND revision=? AND EXISTS(SELECT 1 FROM posts WHERE id=? AND revision=? AND plan_hash=?)",
    ).bind(id, expected, id, p.revision, s.planHash),
    ...revisionStatements(id, s, assets, frozen, env),
    dispatchStatement(
      id,
      expected,
      post.workflow_id ?? workflowId(id, expected),
      'terminate',
      env,
      { revision: p.revision, planHash: s.planHash },
    ),
  ]);
  if (!results[0]!.meta.changes) {
    const current = await postRow(auth, id, env);
    if (current.revision === p.revision && current.plan_hash === s.planHash)
      return getPublicationReceipt(auth, id, env);
    throw new ServiceError(
      current.locked_at_ms !== null ? 'POST_LOCKED' : 'REVISION_CONFLICT',
      'تغير المنشور أو بدأ إرساله. حدّثه قبل التعديل.',
      409,
    );
  }
  await drainDispatchOutbox(new Date().toISOString(), env);
  return getPublicationReceipt(auth, id, env);
}
export async function cancelPost(
  auth: AuthContext,
  id: string,
  expected: number,
  env: Env,
): Promise<PublicationReceipt> {
  const post = await postRow(auth, id, env);
  if (post.revision !== expected)
    throw new ServiceError('REVISION_CONFLICT', 'تغير المنشور. حدّثه قبل الإلغاء.', 409);
  const now = Date.now();
  const results = await env.DB.batch([
    env.DB.prepare(
      'UPDATE posts SET cancel_requested_ms=COALESCE(cancel_requested_ms,?),updated_at_ms=? WHERE id=? AND revision=?',
    ).bind(now, now, id, expected),
    env.DB.prepare(
      "UPDATE targets SET state='cancelled',updated_at_ms=? WHERE post_id=? AND revision=? AND claim_id IS NULL AND state IN ('ready','scheduled','preparing','failed') AND EXISTS(SELECT 1 FROM posts WHERE id=? AND revision=? AND cancel_requested_ms IS NOT NULL)",
    ).bind(now, id, expected, id, expected),
    env.DB.prepare(
      "UPDATE target_parts SET state='cancelled' WHERE post_id=? AND revision=? AND channel_id IN (SELECT channel_id FROM targets WHERE post_id=? AND revision=? AND state='cancelled')",
    ).bind(id, expected, id, expected),
  ]);
  if (!results[0]!.meta.changes)
    throw new ServiceError('REVISION_CONFLICT', 'تغير المنشور. حدّثه قبل الإلغاء.', 409);
  await aggregatePost(id, expected, env);
  const active = await env.DB.prepare(
    "SELECT 1 AS active FROM targets WHERE post_id=? AND revision=? AND state IN ('sending','accepted','uncertain') LIMIT 1",
  )
    .bind(id, expected)
    .first();
  if (!active) {
    await dispatchStatement(
      id,
      expected,
      post.workflow_id ?? workflowId(id, expected),
      'terminate',
      env,
    ).run();
    await drainDispatchOutbox(new Date().toISOString(), env);
  }
  return getPublicationReceipt(auth, id, env);
}
export async function claimTarget(
  id: string,
  revision: number,
  channel: string,
  env: Env,
): Promise<ClaimResult> {
  const claim = crypto.randomUUID(),
    now = Date.now();
  const results = await env.DB.batch([
    env.DB.prepare(
      "UPDATE targets SET state='sending',claim_id=?,claimed_at_ms=?,updated_at_ms=?,error_json=NULL WHERE post_id=? AND revision=? AND channel_id=? AND state='ready' AND claim_id IS NULL AND (next_check_ms IS NULL OR next_check_ms<=?) AND EXISTS(SELECT 1 FROM posts WHERE id=? AND revision=? AND cancel_requested_ms IS NULL AND (due_at_ms IS NULL OR due_at_ms<=?))",
    ).bind(claim, now, now, id, revision, channel, now, id, revision, now),
    env.DB.prepare(
      "UPDATE posts SET locked_at_ms=COALESCE(locked_at_ms,?),state='sending',updated_at_ms=? WHERE id=? AND revision=? AND EXISTS(SELECT 1 FROM targets WHERE post_id=? AND revision=? AND channel_id=? AND claim_id=?)",
    ).bind(now, now, id, revision, id, revision, channel, claim),
    env.DB.prepare(
      "UPDATE target_parts SET state='sending' WHERE post_id=? AND revision=? AND channel_id=? AND EXISTS(SELECT 1 FROM targets WHERE post_id=? AND revision=? AND channel_id=? AND claim_id=?)",
    ).bind(id, revision, channel, id, revision, channel, claim),
  ]);
  return results[0]!.meta.changes
    ? { kind: 'claimed', claimId: claim }
    : { kind: 'skipped', reason: 'cancelled-stale-or-already-claimed' };
}
function combined(states: PublicationState[], due: number | null): PublicationState {
  if (!states.length) return 'cancelled';
  if (states.every((s) => s === 'published')) return 'published';
  if (states.every((s) => s === 'cancelled')) return 'cancelled';
  if (states.includes('uncertain')) return 'uncertain';
  if (states.includes('sending')) return 'sending';
  if (states.includes('accepted')) return 'accepted';
  if (states.includes('ready') || states.includes('scheduled'))
    return due !== null && due > Date.now() ? 'scheduled' : 'ready';
  return 'failed';
}
export async function aggregatePost(id: string, revision: number, env: Env): Promise<void> {
  const post = await env.DB.prepare('SELECT due_at_ms FROM posts WHERE id=? AND revision=?')
    .bind(id, revision)
    .first<{ due_at_ms: number | null }>();
  if (!post) return;
  const states = (
    await env.DB.prepare('SELECT state FROM targets WHERE post_id=? AND revision=?')
      .bind(id, revision)
      .all<{ state: PublicationState }>()
  ).results.map((t) => t.state);
  await env.DB.prepare('UPDATE posts SET state=?,updated_at_ms=? WHERE id=? AND revision=?')
    .bind(combined(states, post.due_at_ms), Date.now(), id, revision)
    .run();
}
export async function getPublicationReceipt(
  auth: AuthContext,
  id: string,
  env: Env,
  revision?: number,
): Promise<PublicationReceipt> {
  const post = await postRow(auth, id, env),
    number = revision ?? post.revision;
  const saved = await env.DB.prepare('SELECT * FROM post_revisions WHERE post_id=? AND revision=?')
    .bind(id, number)
    .first<RevisionRow>();
  if (!saved) throw new ServiceError('NOT_FOUND', 'نسخة المنشور غير موجودة.', 404);
  const plan = JSON.parse(saved.plan_json) as Submission['plan'],
    rows = (
      await env.DB.prepare('SELECT * FROM targets WHERE post_id=? AND revision=?')
        .bind(id, number)
        .all<TargetRow>()
    ).results;
  const parts = (
    await env.DB.prepare(
      'SELECT channel_id,part_index,state,remote_id FROM target_parts WHERE post_id=? AND revision=? ORDER BY channel_id,part_index',
    )
      .bind(id, number)
      .all<{
        channel_id: string;
        part_index: number;
        state: PublicationState;
        remote_id: string | null;
      }>()
  ).results;
  return {
    postId: id,
    workspaceId: post.workspace_id,
    revision: number,
    dueAt: plan.dueAt,
    canRetry:
      number === post.revision &&
      post.cancel_requested_ms === null &&
      !rows.some((row) => ['sending', 'accepted', 'uncertain'].includes(row.state)) &&
      rows.some(
        (row) =>
          row.state === 'failed' &&
          ((row.remote_id === null && row.claim_id === null) || row.continuation_rejected === 1),
      ),
    state:
      number === post.revision
        ? post.state
        : combined(
            rows.map((t) => t.state),
            plan.dueAt ? Date.parse(plan.dueAt) : null,
          ),
    targets: plan.targets.map((target) => {
      const row = rows.find((t) => t.channel_id === target.channelId)!;
      return {
        channelId: target.channelId,
        platform: target.platform,
        state: row.state,
        ...(row.remote_id ? { remoteId: row.remote_id } : {}),
        ...(row.public_url ? { publicUrl: row.public_url } : {}),
        ...(row.error_json ? { error: JSON.parse(row.error_json) } : {}),
        ...(target.threadParts.length
          ? {
              parts: parts
                .filter((part) => part.channel_id === target.channelId)
                .map((part) => ({
                  partIndex: part.part_index,
                  state: part.state,
                  ...(part.remote_id ? { remoteId: part.remote_id } : {}),
                })),
            }
          : {}),
      };
    }),
  };
}
export async function drainDispatchOutbox(instant: ISOInstant, env: Env): Promise<number> {
  const now = Date.parse(instant);
  if (!Number.isSafeInteger(now)) throw new ServiceError('INVALID_TIME', 'وقت الاستئناف غير صالح.');
  const rows = (
    await env.DB.prepare(
      "SELECT * FROM dispatch_outbox WHERE (state='pending' AND next_attempt_ms<=?) OR (state='dispatching' AND claimed_at_ms<=?) ORDER BY next_attempt_ms,id LIMIT 20",
    )
      .bind(now, now - 60000)
      .all<{
        id: string;
        post_id: string;
        revision: number;
        workflow_id: string;
        action: 'create' | 'terminate';
        state: string;
        attempt_count: number;
      }>()
  ).results;
  let sent = 0;
  for (const row of rows) {
    const claim = crypto.randomUUID();
    const owned = await env.DB.prepare(
      "UPDATE dispatch_outbox SET state='dispatching',claim_id=?,claimed_at_ms=? WHERE id=? AND ((state='pending' AND next_attempt_ms<=?) OR (state='dispatching' AND claimed_at_ms<=?))",
    )
      .bind(claim, now, row.id, now, now - 60000)
      .run();
    if (!owned.meta.changes) continue;
    try {
      if (row.action === 'create') {
        const post = await env.DB.prepare(
          'SELECT revision,cancel_requested_ms FROM posts WHERE id=?',
        )
          .bind(row.post_id)
          .first<{ revision: number; cancel_requested_ms: number | null }>();
        if (post?.revision === row.revision && post.cancel_requested_ms === null) {
          try {
            await env.PUBLISH.create({
              id: row.workflow_id,
              params: { postId: row.post_id, revision: row.revision },
            });
          } catch {
            const instance = await env.PUBLISH.get(row.workflow_id);
            await instance.status();
          }
        }
      } else {
        const instance = await env.PUBLISH.get(row.workflow_id);
        await instance.terminate();
      }
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE dispatch_outbox SET state='done',claim_id=NULL,claimed_at_ms=NULL,error_code=NULL WHERE id=? AND claim_id=?",
        ).bind(row.id, claim),
        env.DB.prepare(
          "UPDATE posts SET state=CASE WHEN due_at_ms>? THEN 'scheduled' ELSE 'ready' END,updated_at_ms=? WHERE id=? AND revision=? AND state='preparing' AND locked_at_ms IS NULL AND cancel_requested_ms IS NULL AND EXISTS(SELECT 1 FROM dispatch_outbox WHERE id=? AND state='done' AND action='create')",
        ).bind(now, now, row.post_id, row.revision, row.id),
      ]);
      sent++;
    } catch {
      await env.DB.prepare(
        "UPDATE dispatch_outbox SET state='pending',claim_id=NULL,claimed_at_ms=NULL,attempt_count=attempt_count+1,error_code='WORKFLOW_DISPATCH',next_attempt_ms=? WHERE id=? AND claim_id=?",
      )
        .bind(now + Math.min(300000, 15000 * 2 ** Math.min(row.attempt_count, 4)), row.id, claim)
        .run();
    }
  }
  return sent;
}
export async function retryPost(
  auth: AuthContext,
  id: string,
  expected: number,
  env: Env,
): Promise<PublicationReceipt> {
  const post = await postRow(auth, id, env);
  if (post.revision !== expected || post.cancel_requested_ms !== null)
    throw new ServiceError('REVISION_CONFLICT', 'تغير المنشور أو أُلغي. حدّثه قبل المحاولة.', 409);
  const generation = post.dispatch_generation + 1,
    jobId = workflowId(id, expected, generation) + '-' + crypto.randomUUID(),
    now = Date.now();
  const results = await env.DB.batch([
    env.DB.prepare(
      "UPDATE posts SET dispatch_generation=?,workflow_id=?,state='preparing',updated_at_ms=? WHERE id=? AND revision=? AND dispatch_generation=? AND cancel_requested_ms IS NULL AND NOT EXISTS(SELECT 1 FROM targets WHERE post_id=? AND revision=? AND state IN ('sending','accepted','uncertain')) AND EXISTS(SELECT 1 FROM targets WHERE post_id=? AND revision=? AND state='failed' AND ((remote_id IS NULL AND claim_id IS NULL) OR continuation_rejected=1))",
    ).bind(
      generation,
      jobId,
      now,
      id,
      expected,
      post.dispatch_generation,
      id,
      expected,
      id,
      expected,
    ),
    env.DB.prepare(
      "UPDATE targets SET state='ready',error_json=NULL,next_check_ms=NULL,updated_at_ms=? WHERE post_id=? AND revision=? AND state='failed' AND remote_id IS NULL AND claim_id IS NULL AND EXISTS(SELECT 1 FROM posts WHERE id=? AND revision=? AND workflow_id=? AND dispatch_generation=?)",
    ).bind(now, id, expected, id, expected, jobId, generation),
    env.DB.prepare(
      "UPDATE targets SET state='accepted',error_json=NULL,next_check_ms=?,continuation_claim_id=NULL,continuation_rejected=0,updated_at_ms=? WHERE post_id=? AND revision=? AND state='failed' AND continuation_rejected=1 AND EXISTS(SELECT 1 FROM posts WHERE id=? AND revision=? AND workflow_id=? AND dispatch_generation=?)",
    ).bind(now, now, id, expected, id, expected, jobId, generation),
    env.DB.prepare(
      "UPDATE target_parts SET state='ready',error_json=NULL WHERE post_id=? AND revision=? AND channel_id IN (SELECT channel_id FROM targets WHERE post_id=? AND revision=? AND state='ready' AND updated_at_ms=?)",
    ).bind(id, expected, id, expected, now),
    env.DB.prepare(
      "UPDATE dispatch_outbox SET workflow_id=?,state='pending',next_attempt_ms=?,attempt_count=0,error_code=NULL,claim_id=NULL,claimed_at_ms=NULL WHERE post_id=? AND revision=? AND action='create' AND EXISTS(SELECT 1 FROM posts WHERE id=? AND revision=? AND workflow_id=? AND dispatch_generation=?)",
    ).bind(jobId, now, id, expected, id, expected, jobId, generation),
  ]);
  if (!results[0]!.meta.changes) return getPublicationReceipt(auth, id, env);
  await drainDispatchOutbox(new Date().toISOString(), env);
  return getPublicationReceipt(auth, id, env);
}
