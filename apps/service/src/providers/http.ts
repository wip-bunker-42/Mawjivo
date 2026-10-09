import { ServiceError } from '../errors';
/** Provider error bodies may contain access tokens; never forward or log them. */
export async function providerJson<T>(url: string, token: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new ServiceError(
      'PROVIDER_NETWORK',
      'تعذر فحص الحساب. تحقق من الاتصال ثم أعد الفحص.',
      502,
      true,
    );
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new ServiceError(
      response.status === 429 ? 'PROVIDER_RATE_LIMIT' : 'PROVIDER_AUTH',
      response.status === 429
        ? 'وصل الحساب إلى حد الطلبات. أعد الفحص لاحقًا.'
        : 'تعذر التحقق من الرمز وصلاحياته. أعد ربط الحساب.',
      response.status === 429 ? 429 : 400,
      response.status === 429,
    );
  }
  if (!response.body) throw new ServiceError('PROVIDER_RESPONSE', 'استجابة الحساب غير صالحة.', 502);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 2_097_152) {
        await reader.cancel();
        throw new ServiceError('PROVIDER_RESPONSE', 'استجابة الحساب أكبر من الحد المسموح.', 502);
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes),
    ) as T;
  } catch {
    throw new ServiceError('PROVIDER_RESPONSE', 'استجابة الحساب غير صالحة.', 502);
  }
}
