import { UploadManifestSchema } from '@mawjivo/core';
import type { UploadManifest, UploadTicket, UploadedPart, MediaAsset } from '@mawjivo/core';
import { AwsClient } from 'aws4fetch';
import type { AuthContext } from '../auth';
import { requireWorkspace } from '../auth';
import { getWorkspace } from '../workspaces';
import { ServiceError } from '../errors';
import {
  type AssetRow,
  PART_BYTES,
  TICKET_MS,
  SIGNING_BATCH,
  PROJECT_BYTES,
  RELEASE_RESERVE,
  ownedAsset,
  assetDto,
  eraseClaimedAsset,
} from './model';
export function validateUpload(value: unknown): UploadManifest {
  const parsed = UploadManifestSchema.safeParse(value);
  if (!parsed.success) throw new ServiceError('INVALID_MEDIA', 'راجع اسم الملف وحجمه وصيغته.');
  return parsed.data;
}
async function existingSource(
  workspace: string,
  input: UploadManifest,
  env: Env,
): Promise<AssetRow | null> {
  return env.DB.prepare(
    "SELECT * FROM assets WHERE workspace_id=? AND source_asset_id=? AND COALESCE(recipe_id,'')=? AND state!='deleted'",
  )
    .bind(workspace, input.sourceAssetId, input.recipeId ?? '')
    .first<AssetRow>();
}
function sameManifest(row: AssetRow, input: UploadManifest): void {
  if (
    row.original_name !== input.originalName ||
    row.kind !== input.kind ||
    row.bytes !== input.bytes ||
    row.mime_type !== input.mimeType ||
    row.width !== (input.width ?? null) ||
    row.height !== (input.height ?? null) ||
    row.duration_ms !== (input.durationMs ?? null)
  )
    throw new ServiceError('UPLOAD_SOURCE_CHANGED', 'تغيرت بيانات الملف؛ اختره مجددًا.', 409);
}
async function ticket(row: AssetRow, env: Env, numbers?: number[]): Promise<UploadTicket> {
  if (row.state === 'complete')
    return {
      assetId: row.id,
      multipartId: null,
      expiresAt: new Date(Date.now() + TICKET_MS).toISOString(),
      parts: [],
    };
  if (row.state !== 'uploading' || !row.multipart_id)
    throw new ServiceError(
      'UPLOAD_NOT_ACTIVE',
      'عملية الرفع غير نشطة؛ اختر الملف مجددًا.',
      409,
      true,
    );
  const count = Math.ceil(row.bytes / PART_BYTES),
    selected = numbers ?? Array.from({ length: Math.min(count, SIGNING_BATCH) }, (_, i) => i + 1);
  if (
    !Array.isArray(selected) ||
    selected.length < 1 ||
    selected.length > SIGNING_BATCH ||
    new Set(selected).size !== selected.length ||
    selected.some((n) => !Number.isSafeInteger(n) || n < 1 || n > count)
  )
    throw new ServiceError('INVALID_UPLOAD_PARTS', 'أجزاء الرفع المطلوبة غير صالحة.');
  const signer = new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    service: 's3',
    region: 'auto',
    retries: 0,
  });
  const parts: { partNumber: number; url: string }[] = [];
  for (const n of selected) {
    const url = new URL(
      `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${encodeURIComponent(env.MEDIA_BUCKET)}/${row.object_key}`,
    );
    url.searchParams.set('partNumber', String(n));
    url.searchParams.set('uploadId', row.multipart_id);
    url.searchParams.set('X-Amz-Expires', '900');
    const request = await signer.sign(url, {
      method: 'PUT',
      headers: { 'Content-Length': String(Math.min(PART_BYTES, row.bytes - (n - 1) * PART_BYTES)) },
      aws: { signQuery: true, allHeaders: true },
    });
    parts.push({ partNumber: n, url: request.url });
  }
  const now = Date.now(),
    expires = now + TICKET_MS;
  const updated = await env.DB.batch([
    env.DB.prepare(
      "UPDATE assets SET updated_at_ms=? WHERE id=? AND state='uploading' AND multipart_id=?",
    ).bind(now, row.id, row.multipart_id),
    env.DB.prepare(
      "UPDATE upload_reservations SET expires_at_ms=? WHERE asset_id=? AND state='active' AND EXISTS(SELECT 1 FROM assets WHERE id=? AND state='uploading')",
    ).bind(expires, row.id, row.id),
  ]);
  if (updated[0]!.meta.changes !== 1)
    throw new ServiceError('UPLOAD_NOT_ACTIVE', 'توقفت عملية الرفع قبل تجديدها.', 409);
  return {
    assetId: row.id,
    multipartId: row.multipart_id,
    expiresAt: new Date(expires).toISOString(),
    parts,
  };
}
export async function beginUpload(
  auth: AuthContext,
  workspace: string,
  value: UploadManifest,
  env: Env,
): Promise<UploadTicket> {
  requireWorkspace(auth, workspace);
  await getWorkspace(auth, workspace, env);
  const input = validateUpload(value);
  const existing = await existingSource(workspace, input, env);
  if (existing) {
    sameManifest(existing, input);
    return ticket(existing, env);
  }
  const id = crypto.randomUUID(),
    key = `mawjivo/media/${crypto.randomUUID()}/${crypto.randomUUID()}`,
    now = Date.now();
  let inserted: D1Result[];
  try {
    inserted = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO assets(id,workspace_id,source_asset_id,recipe_id,object_key,original_name,kind,mime_type,bytes,width,height,duration_ms,state,created_at_ms,updated_at_ms)
    SELECT ?,?,?,?,?,?,?,?,?,?,?,?,'reserved',?,? WHERE
    (SELECT COALESCE(SUM(bytes),0) FROM assets WHERE state!='deleted') + ? + MAX(?,COALESCE((SELECT CAST(value_json AS INTEGER) FROM service_settings WHERE key='release_storage_bytes'),?)) <= ?`,
      ).bind(
        id,
        workspace,
        input.sourceAssetId,
        input.recipeId,
        key,
        input.originalName,
        input.kind,
        input.mimeType,
        input.bytes,
        input.width ?? null,
        input.height ?? null,
        input.durationMs ?? null,
        now,
        now,
        input.bytes,
        RELEASE_RESERVE,
        RELEASE_RESERVE,
        PROJECT_BYTES,
      ),
      env.DB.prepare(
        "INSERT INTO upload_reservations(asset_id,workspace_id,bytes,expires_at_ms,state) SELECT id,workspace_id,bytes,?,'active' FROM assets WHERE id=?",
      ).bind(now + TICKET_MS, id),
    ]);
  } catch {
    const winner = await existingSource(workspace, input, env);
    if (winner) {
      sameManifest(winner, input);
      return ticket(winner, env);
    }
    throw new ServiceError('STORAGE_RESERVATION', 'تعذر حجز سعة الرفع؛ حاول مجددًا.', 503, true);
  }
  if (inserted[0]!.meta.changes !== 1)
    throw new ServiceError(
      'STORAGE_FULL',
      'سعة التخزين لا تكفي؛ احذف ملفات غير مستخدمة أو انتظر التنظيف.',
      409,
    );
  let multipart: R2MultipartUpload;
  try {
    multipart = await env.MEDIA.createMultipartUpload(key, {
      httpMetadata: { contentType: input.mimeType },
      customMetadata: { assetId: id, workspaceId: workspace },
    });
  } catch {
    // No upload grant has been issued, so no client can have uploaded parts.
    await env.DB.prepare("UPDATE assets SET state='deleting' WHERE id=? AND state='reserved'")
      .bind(id)
      .run();
    await eraseClaimedAsset(await ownedAsset(auth, id, env), env);
    throw new ServiceError('R2_UPLOAD_CREATE', 'تعذر بدء الرفع إلى Cloudflare.', 503, true);
  }
  await env.DB.prepare(
    "UPDATE assets SET state='uploading',multipart_id=?,updated_at_ms=? WHERE id=? AND state='reserved'",
  )
    .bind(multipart.uploadId, Date.now(), id)
    .run();
  return ticket(await ownedAsset(auth, id, env), env);
}
export async function renewUpload(
  auth: AuthContext,
  id: string,
  env: Env,
  numbers?: number[],
): Promise<UploadTicket> {
  return ticket(await ownedAsset(auth, id, env), env, numbers);
}
function checkedParts(value: UploadedPart[], count: number): UploadedPart[] {
  if (!Array.isArray(value) || value.length !== count)
    throw new ServiceError('INVALID_UPLOAD_PARTS', 'أكمل جميع أجزاء الرفع قبل النشر.');
  const sorted = value
    .map((part) => ({
      partNumber: part?.partNumber,
      etag: typeof part?.etag === 'string' ? part.etag.replace(/^"(.*)"$/, '$1') : '',
    }))
    .sort((a, b) => a.partNumber - b.partNumber);
  // R2 defines these ETags as opaque strings; local Workers ETags are longer than an MD5 digest.
  if (
    sorted.some(
      (part, i) =>
        part.partNumber !== i + 1 ||
        part.etag.length < 1 ||
        part.etag.length > 2048 ||
        /[\u0000-\u001f\u007f]/.test(part.etag),
    )
  )
    throw new ServiceError('INVALID_UPLOAD_PARTS', 'بيانات أجزاء الرفع غير صالحة.');
  return sorted;
}
export async function completeUpload(
  auth: AuthContext,
  id: string,
  parts: UploadedPart[],
  sha256: string,
  env: Env,
): Promise<MediaAsset> {
  let row = await ownedAsset(auth, id, env);
  if (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256))
    throw new ServiceError('INVALID_UPLOAD_HASH', 'بصمة الملف غير صالحة.');
  if (row.sha256 && row.sha256 !== sha256)
    throw new ServiceError(
      'UPLOAD_HASH_MISMATCH',
      'تختلف بصمة الملف عن محاولة الإكمال السابقة.',
      409,
    );
  if (row.state === 'complete') return assetDto(row);
  const valid = checkedParts(parts, Math.ceil(row.bytes / PART_BYTES));
  if (!['uploading', 'completing'].includes(row.state) || !row.multipart_id)
    throw new ServiceError('UPLOAD_NOT_ACTIVE', 'عملية الرفع غير نشطة.', 409);
  const claimed = await env.DB.prepare(
    "UPDATE assets SET state='completing',sha256=?,updated_at_ms=? WHERE id=? AND state='uploading'",
  )
    .bind(sha256, Date.now(), id)
    .run();
  let object: R2Object | null = null;
  if (!claimed.meta.changes) {
    row = await ownedAsset(auth, id, env);
    if (row.sha256 !== sha256)
      throw new ServiceError('UPLOAD_HASH_MISMATCH', 'بصمة الإكمال تغيرت.', 409);
    if (row.state === 'complete') return assetDto(row);
    if (row.state !== 'completing')
      throw new ServiceError('UPLOAD_NOT_ACTIVE', 'توقفت عملية الرفع.', 409);
    object = await env.MEDIA.head(row.object_key);
    if (!object && Date.now() - row.updated_at_ms < 30_000)
      throw new ServiceError(
        'UPLOAD_FINALIZING',
        'يجري تثبيت الملف؛ أعد الفحص بعد قليل.',
        409,
        true,
      );
  }
  if (!object) {
    try {
      object = await env.MEDIA.resumeMultipartUpload(row.object_key, row.multipart_id!).complete(
        valid,
      );
    } catch {
      object = await env.MEDIA.head(row.object_key);
      if (!object)
        throw new ServiceError(
          'UPLOAD_FINALIZING',
          'لم يُحسم إكمال الرفع؛ أعد الفحص دون رفع الملف من البداية.',
          503,
          true,
        );
    }
  }
  if (
    object.size !== row.bytes ||
    object.httpMetadata?.contentType !== row.mime_type ||
    object.customMetadata?.assetId !== row.id
  ) {
    await env.DB.prepare("UPDATE assets SET state='deleting' WHERE id=? AND state='completing'")
      .bind(id)
      .run();
    await eraseClaimedAsset({ ...row, multipart_id: null }, env);
    throw new ServiceError(
      'UPLOAD_SIZE_MISMATCH',
      'الملف المرفوع لا يطابق بياناته؛ أعد رفعه.',
      409,
    );
  }
  const completed = await env.DB.batch([
    env.DB.prepare(
      "UPDATE assets SET state='complete',multipart_id=NULL,updated_at_ms=? WHERE id=? AND state='completing' AND sha256=?",
    ).bind(Date.now(), id, sha256),
    env.DB.prepare(
      "UPDATE upload_reservations SET state='completed' WHERE asset_id=? AND EXISTS(SELECT 1 FROM assets WHERE id=? AND state='complete')",
    ).bind(id, id),
  ]);
  row = await ownedAsset(auth, id, env);
  if (!completed[0]!.meta.changes && row.state !== 'complete')
    throw new ServiceError('UPLOAD_NOT_ACTIVE', 'توقفت عملية الرفع قبل تثبيتها.', 409);
  return assetDto(row);
}
export async function abortUpload(auth: AuthContext, id: string, env: Env): Promise<void> {
  const row = await ownedAsset(auth, id, env);
  if (row.state === 'deleted') return;
  const claimed = await env.DB.prepare(
    "UPDATE assets SET state='deleting' WHERE id=? AND state IN ('reserved','uploading','completing','complete','deleting') AND NOT EXISTS(SELECT 1 FROM asset_uses WHERE asset_id=?)",
  )
    .bind(id, id)
    .run();
  if (!claimed.meta.changes)
    throw new ServiceError('ASSET_IN_USE', 'الملف مرتبط بمنشور؛ ألغِ المنشور أولًا.', 409);
  await eraseClaimedAsset(row, env);
}
export async function createMediaAlias(
  auth: AuthContext,
  assetId: string,
  postId: string,
  revision: number,
  channelId: string,
  sentName: string,
  env: Env,
): Promise<{ nonce: string; path: string }> {
  const asset = await ownedAsset(auth, assetId, env);
  if (asset.state !== 'complete' || !asset.sha256)
    throw new ServiceError('ASSET_NOT_READY', 'الملف لم يكتمل رفعه بعد.', 409);
  if (
    !Number.isSafeInteger(revision) ||
    revision < 1 ||
    !sentName ||
    sentName.length > 255 ||
    /[\u0000-\u001f\u007f/\\]/.test(sentName) ||
    sentName === '.' ||
    sentName === '..'
  )
    throw new ServiceError('INVALID_MEDIA_NAME', 'اسم الإرسال غير صالح.');
  const nonce = crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO asset_uses(asset_id,workspace_id,post_id,revision,channel_id,alias_nonce,sent_name)
   SELECT a.id,a.workspace_id,t.post_id,t.revision,t.channel_id,?,? FROM assets a JOIN targets t ON t.workspace_id=a.workspace_id
   WHERE a.id=? AND a.state='complete' AND t.post_id=? AND t.revision=? AND t.channel_id=?`,
    ).bind(nonce, sentName, assetId, postId, revision, channelId),
    env.DB.prepare(
      'UPDATE assets SET updated_at_ms=? WHERE id=? AND EXISTS(SELECT 1 FROM asset_uses WHERE alias_nonce=?)',
    ).bind(Date.now(), assetId, nonce),
  ]);
  const use = await env.DB.prepare(
    'SELECT alias_nonce,sent_name FROM asset_uses WHERE asset_id=? AND post_id=? AND revision=? AND channel_id=?',
  )
    .bind(assetId, postId, revision, channelId)
    .first<{ alias_nonce: string; sent_name: string }>();
  if (!use)
    throw new ServiceError('MEDIA_TARGET_NOT_FOUND', 'حساب المنشور لا يخص هذه المساحة.', 403);
  if (use.sent_name !== sentName)
    throw new ServiceError('MEDIA_ALIAS_CHANGED', 'اسم الإرسال تغير؛ راجع نسخة المنشور.', 409);
  return {
    nonce: use.alias_nonce,
    path: `/media/${use.alias_nonce}/${encodeURIComponent(use.sent_name)}`,
  };
}
