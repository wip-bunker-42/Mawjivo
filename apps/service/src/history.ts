import { Temporal } from '@js-temporal/polyfill';
import type {
  PostPage,
  Summary,
  PostDetail,
  PreparedAsset,
  TargetReceipt,
  Platform,
  PublicationState,
} from '@mawjivo/core';
import type { AuthContext } from './auth';
import { getWorkspace } from './workspaces';
import { ServiceError } from './errors';
import { postRow, getPublicationReceipt, type TargetRow } from './posts';
import { assetDto, type AssetRow } from './assets/model';
function invalidCursor(): ServiceError {
  return new ServiceError('INVALID_CURSOR', 'حدّث القائمة؛ موضع الصفحة غير صالح.');
}
export async function listPosts(
  auth: AuthContext,
  workspaceId: string,
  filter: 'all' | 'scheduled' | 'needsAction',
  cursor: string | undefined,
  env: Env,
  range?: { start: number; end: number },
): Promise<PostPage> {
  await getWorkspace(auth, workspaceId, env);
  if (!['all', 'scheduled', 'needsAction'].includes(filter))
    throw new ServiceError('INVALID_FILTER', 'اختر قائمة صالحة.');
  let boundary: { t: number; id: string } | undefined;
  if (cursor) {
    try {
      if (!/^[A-Za-z0-9_-]{1,160}$/.test(cursor)) throw invalidCursor();
      boundary = JSON.parse(
        atob(cursor.replaceAll('-', '+').replaceAll('_', '/')),
      ) as typeof boundary;
      if (
        !boundary ||
        !Number.isSafeInteger(boundary.t) ||
        typeof boundary.id !== 'string' ||
        !/^[A-Za-z0-9_-]{1,160}$/.test(boundary.id)
      )
        throw invalidCursor();
      const owned = await env.DB.prepare(
        'SELECT 1 FROM posts WHERE workspace_id=? AND id=? AND created_at_ms=?',
      )
        .bind(workspaceId, boundary.id, boundary.t)
        .first();
      if (!owned) throw invalidCursor();
    } catch {
      throw invalidCursor();
    }
  }
  const conditions =
    filter === 'scheduled'
      ? " AND p.cancel_requested_ms IS NULL AND p.due_at_ms>? AND p.state IN ('scheduled','preparing','ready')"
      : filter === 'needsAction'
        ? " AND (EXISTS(SELECT 1 FROM targets t WHERE t.post_id=p.id AND t.revision=p.revision AND t.state IN ('failed','uncertain')) OR EXISTS(SELECT 1 FROM dispatch_outbox d WHERE d.post_id=p.id AND d.revision=p.revision AND d.action='create' AND d.state='pending'))"
        : '';
  const items = (
    await env.DB.prepare(
      'SELECT p.id,p.workspace_id,p.revision,p.state,p.due_at_ms,p.created_at_ms,p.plan_json FROM posts p WHERE p.workspace_id=?' +
        conditions +
        (range
          ? ' AND (p.created_at_ms>=? AND p.created_at_ms<? OR p.updated_at_ms>=? AND p.updated_at_ms<? OR EXISTS(SELECT 1 FROM targets a WHERE a.post_id=p.id AND a.revision=p.revision AND a.updated_at_ms>=? AND a.updated_at_ms<?))'
          : '') +
        (boundary ? ' AND (p.created_at_ms<? OR (p.created_at_ms=? AND p.id<?))' : '') +
        ' ORDER BY p.created_at_ms DESC,p.id DESC LIMIT 21',
    )
      .bind(
        workspaceId,
        ...(filter === 'scheduled' ? [Date.now()] : []),
        ...(range ? [range.start, range.end, range.start, range.end, range.start, range.end] : []),
        ...(boundary ? [boundary.t, boundary.t, boundary.id] : []),
      )
      .all<{
        id: string;
        workspace_id: string;
        revision: number;
        state: PublicationState;
        due_at_ms: number | null;
        created_at_ms: number;
        plan_json: string;
      }>()
  ).results;
  const page = items.slice(0, 20),
    last = page.at(-1);
  const targetsByPost = new Map<string, TargetReceipt[]>(),
    partsByTarget = new Map<string, NonNullable<TargetReceipt['parts']>>();
  if (page.length) {
    const ids = JSON.stringify(page.map((post) => post.id));
    const batch = await env.DB.batch([
      env.DB.prepare(
        "SELECT t.*,COALESCE(json_extract(f.value,'$.platform'),c.platform) AS platform FROM targets t JOIN posts p ON p.id=t.post_id AND p.revision=t.revision JOIN post_revisions r ON r.post_id=p.id AND r.revision=p.revision LEFT JOIN json_each(r.channel_snapshot_json) f ON json_extract(f.value,'$.id')=t.channel_id JOIN channels c ON c.id=t.channel_id WHERE p.workspace_id=? AND p.id IN (SELECT value FROM json_each(?)) ORDER BY t.post_id,CAST(f.key AS INTEGER),t.channel_id",
      ).bind(workspaceId, ids),
      env.DB.prepare(
        'SELECT v.post_id,v.channel_id,v.part_index,v.state,v.remote_id FROM target_parts v JOIN posts p ON p.id=v.post_id AND p.revision=v.revision WHERE p.workspace_id=? AND p.id IN (SELECT value FROM json_each(?)) ORDER BY v.post_id,v.channel_id,v.part_index',
      ).bind(workspaceId, ids),
    ]);
    for (const raw of batch[1]!.results) {
      const part = raw as {
          post_id: string;
          channel_id: string;
          part_index: number;
          state: PublicationState;
          remote_id: string | null;
        },
        key = part.post_id + ':' + part.channel_id;
      const parts = partsByTarget.get(key) ?? [];
      parts.push({
        partIndex: part.part_index,
        state: part.state,
        ...(part.remote_id ? { remoteId: part.remote_id } : {}),
      });
      partsByTarget.set(key, parts);
    }
    for (const raw of batch[0]!.results) {
      const row = raw as unknown as TargetRow & { platform: Platform },
        target: TargetReceipt = {
          channelId: row.channel_id,
          platform: row.platform,
          state: row.state,
          ...(row.remote_id ? { remoteId: row.remote_id } : {}),
          ...(row.public_url ? { publicUrl: row.public_url } : {}),
          ...(row.error_json ? { error: JSON.parse(row.error_json) } : {}),
          ...(partsByTarget.has(row.post_id + ':' + row.channel_id)
            ? { parts: partsByTarget.get(row.post_id + ':' + row.channel_id)! }
            : {}),
        };
      const targets = targetsByPost.get(row.post_id) ?? [];
      targets.push(target);
      targetsByPost.set(row.post_id, targets);
    }
  }
  return {
    items: page.map((post) => ({
      preview: [
        ...((JSON.parse(post.plan_json).targets[0]?.title ||
          JSON.parse(post.plan_json).targets[0]?.text ||
          'منشور بلا نص') as string),
      ]
        .slice(0, 120)
        .join(''),
      postId: post.id,
      workspaceId: post.workspace_id,
      revision: post.revision,
      state: post.state,
      dueAt: post.due_at_ms === null ? null : new Date(post.due_at_ms).toISOString(),
      targets: targetsByPost.get(post.id) ?? [],
    })),
    nextCursor:
      items.length > 20 && last
        ? btoa(JSON.stringify({ t: last.created_at_ms, id: last.id }))
            .replaceAll('+', '-')
            .replaceAll('/', '_')
            .replaceAll('=', '')
        : null,
  };
}
export async function getSummary(
  auth: AuthContext,
  workspaceId: string,
  localDate: string,
  env: Env,
): Promise<Summary> {
  const workspace = await getWorkspace(auth, workspaceId, env);
  let start: number, end: number;
  try {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(localDate)) throw new Error();
    const date = Temporal.PlainDate.from(localDate);
    start = date.toZonedDateTime(workspace.timeZone).epochMilliseconds;
    end = date.add({ days: 1 }).toZonedDateTime(workspace.timeZone).epochMilliseconds;
  } catch {
    throw new ServiceError('INVALID_DATE', 'اختر تاريخًا صالحًا للملخص.');
  }
  const counts = await env.DB.prepare(
    `WITH day(start_ms,end_ms) AS (VALUES(?,?)),
    logical AS (SELECT p.id,p.created_at_ms,p.due_at_ms,COUNT(t.channel_id) AS total,
      SUM(t.state IN ('preparing','ready','sending','accepted')) AS processing,
      SUM(t.state='published') AS published,SUM(t.state='uncertain') AS unknown,SUM(t.state='failed') AS failed,
      SUM(t.state='published' AND COALESCE(t.published_at_ms,t.updated_at_ms)>=day.start_ms AND COALESCE(t.published_at_ms,t.updated_at_ms)<day.end_ms) AS today,
      MAX(CASE WHEN t.state='published' THEN COALESCE(t.published_at_ms,t.updated_at_ms) END) AS completed_at,
      MAX(p.updated_at_ms,COALESCE(MAX(t.updated_at_ms),0)) AS activity_at
      FROM posts p JOIN targets t ON t.post_id=p.id AND t.revision=p.revision CROSS JOIN day WHERE p.workspace_id=? GROUP BY p.id)
    SELECT COALESCE(SUM(created_at_ms>=day.start_ms AND created_at_ms<day.end_ms),0) AS receivedPosts,
      COALESCE(SUM(processing>0 AND (due_at_ms IS NULL OR due_at_ms<=?) AND activity_at>=day.start_ms AND activity_at<day.end_ms),0) AS processingPosts,
      COALESCE(SUM(total=published AND completed_at>=day.start_ms AND completed_at<day.end_ms),0) AS completePosts,
      COALESCE(SUM(published<total AND unknown=0 AND published>0 AND activity_at>=day.start_ms AND activity_at<day.end_ms),0) AS partialPosts,
      COALESCE(SUM(unknown=0 AND published=0 AND failed>0 AND activity_at>=day.start_ms AND activity_at<day.end_ms),0) AS failedPosts,
      COALESCE(SUM(published<total AND unknown>0 AND activity_at>=day.start_ms AND activity_at<day.end_ms),0) AS unknownPosts,
      COALESCE(SUM(today),0) AS publishedTargets FROM logical CROSS JOIN day`,
  )
    .bind(start, end, workspaceId, Date.now())
    .first<
      Pick<
        Summary,
        | 'completePosts'
        | 'partialPosts'
        | 'failedPosts'
        | 'unknownPosts'
        | 'publishedTargets'
        | 'receivedPosts'
        | 'processingPosts'
      >
    >();
  const result: Summary = {
    localDate,
    timeZone: workspace.timeZone,
    completePosts: 0,
    partialPosts: 0,
    failedPosts: 0,
    unknownPosts: 0,
    publishedTargets: 0,
    ...counts,
    upcomingScheduled: 0,
  };
  const future = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM posts p WHERE workspace_id=? AND due_at_ms>? AND cancel_requested_ms IS NULL AND EXISTS(SELECT 1 FROM targets t WHERE t.post_id=p.id AND t.revision=p.revision AND t.state IN ('ready','scheduled','preparing'))",
  )
    .bind(workspaceId, Date.now())
    .first<{ count: number }>();
  result.upcomingScheduled = future?.count ?? 0;
  const page = await listPosts(auth, workspaceId, 'all', undefined, env, { start, end });
  result.items = page.items;
  result.hasMore = page.nextCursor !== null;
  return result;
}
export async function getPostDetail(
  auth: AuthContext,
  postId: string,
  env: Env,
): Promise<PostDetail> {
  const post = await postRow(auth, postId, env),
    plan = JSON.parse(post.plan_json) as PostDetail['plan'];
  const sourceIds = [
    ...new Set(plan.targets.flatMap((target) => target.assets.map((asset) => asset.sourceAssetId))),
  ];
  const all = (
    await env.DB.prepare(
      "SELECT * FROM assets WHERE workspace_id=? AND source_asset_id IN (SELECT value FROM json_each(?)) ORDER BY (recipe_id IS NULL) DESC,(state='complete') DESC,created_at_ms DESC,id",
    )
      .bind(post.workspace_id, JSON.stringify(sourceIds))
      .all<AssetRow>()
  ).results;
  const uses = (
    await env.DB.prepare(
      "SELECT a.* FROM asset_uses u JOIN assets a ON a.id=u.asset_id AND a.workspace_id=u.workspace_id WHERE u.post_id=? AND u.revision=? AND a.state='complete'",
    )
      .bind(postId, post.revision)
      .all<AssetRow>()
  ).results;
  const prepared = new Map<string, PreparedAsset>();
  for (const row of uses)
    if (row.sha256)
      prepared.set(JSON.stringify([row.source_asset_id, row.recipe_id]), {
        sourceAssetId: row.source_asset_id,
        recipeId: row.recipe_id,
        assetId: row.id,
        sha256: row.sha256,
      });
  return {
    receipt: await getPublicationReceipt(auth, postId, env),
    plan,
    sources: sourceIds.flatMap((id) => {
      const row = all.find((asset) => asset.source_asset_id === id);
      return row ? [{ ...assetDto(row), id }] : [];
    }),
    preparedAssets: [...prepared.values()],
    editable:
      post.locked_at_ms === null &&
      post.cancel_requested_ms === null &&
      ['preparing', 'scheduled', 'ready', 'failed'].includes(post.state),
  };
}
