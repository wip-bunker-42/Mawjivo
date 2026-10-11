import type { AuthContext } from './auth';
import type { ReadinessItem } from '@mawjivo/core';
import { AwsClient } from 'aws4fetch';
import { ServiceError } from './errors';
import { encryptSecret, decryptSecret } from './secrets';
export async function initializeService(
  auth: AuthContext,
  env: Env,
  fetcher: typeof fetch = fetch,
  publicBaseUrl?: string,
): Promise<ReadinessItem[]> {
  if (auth.allowedWorkspaceIds !== '*')
    throw new ServiceError('FORBIDDEN', 'إعداد الخدمة يتطلب جهازًا مخولًا بالإدارة.', 403);
  if (publicBaseUrl && !/^https:\/\/[^\s/?#]+$/.test(publicBaseUrl))
    throw new ServiceError('INVALID_SERVICE_URL', 'رابط الخدمة يجب أن يكون نطاق HTTPS صالحًا.');
  const row = await env.DB.prepare(
    "SELECT value_json FROM service_settings WHERE key='owner_service_id'",
  ).first<{ value_json: string }>();
  if (!row || JSON.parse(row.value_json) !== env.SERVICE_ID)
    throw new ServiceError(
      'RESOURCE_NOT_OWNED',
      'قاعدة البيانات لا تحمل علامة ملكية هذه الخدمة.',
      409,
    );
  const marker = await env.MEDIA.get('mawjivo/owner-service-id');
  if (marker && (await marker.text()) !== env.SERVICE_ID)
    throw new ServiceError('RESOURCE_NOT_OWNED', 'حاوية الوسائط مرتبطة بخدمة أخرى. لم تُعدل.', 409);
  const context = { workspaceId: 'service', connectionId: env.SERVICE_ID, keyVersion: 1 };
  await decryptSecret(await encryptSecret('probe', context, env), context, env);
  const signer = new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    service: 's3',
    region: 'auto',
    retries: 0,
  });
  const objectUrl =
    'https://' +
    env.R2_ACCOUNT_ID +
    '.r2.cloudflarestorage.com/' +
    env.MEDIA_BUCKET +
    '/mawjivo/probe/' +
    crypto.randomUUID();
  try {
    const put = await fetcher(
      await signer.sign(objectUrl, {
        method: 'PUT',
        body: 'probe',
        headers: { 'Content-Type': 'text/plain' },
        signal: AbortSignal.timeout(15_000),
      }),
    );
    if (!put.ok) throw new Error('PUT_FAILED');
    await put.body?.cancel();
    const remove = await fetcher(
      await signer.sign(objectUrl, { method: 'DELETE', signal: AbortSignal.timeout(15_000) }),
    );
    if (!remove.ok) throw new Error('DELETE_FAILED');
    await remove.body?.cancel();
  } catch {
    throw new ServiceError(
      'R2_CREDENTIALS_INVALID',
      'راجع مفتاح R2 وصلاحية كتابة وحذف الوسائط في حاوية الخدمة.',
      503,
    );
  }
  await env.MEDIA.put('mawjivo/owner-service-id', env.SERVICE_ID, {
    httpMetadata: { contentType: 'text/plain' },
  });
  await env.DB.prepare(
    "INSERT INTO service_settings(key,value_json,updated_at_ms) VALUES('initialized','true',?) ON CONFLICT(key) DO UPDATE SET value_json='true',updated_at_ms=excluded.updated_at_ms",
  )
    .bind(Date.now())
    .run();
  if (publicBaseUrl)
    await env.DB.prepare(
      "INSERT INTO service_settings(key,value_json,updated_at_ms) VALUES('public_base_url',?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at_ms=excluded.updated_at_ms",
    )
      .bind(JSON.stringify(publicBaseUrl), Date.now())
      .run();
  return [
    { code: 'DB', state: 'ready', messageAr: 'قاعدة البيانات جاهزة.' },
    { code: 'MEDIA', state: 'ready', messageAr: 'تخزين الوسائط جاهز.' },
    { code: 'R2_KEYS', state: 'ready', messageAr: 'مفاتيح رفع الوسائط صالحة.' },
    { code: 'ENCRYPTION', state: 'ready', messageAr: 'تشفير بيانات الربط جاهز.' },
  ];
}
