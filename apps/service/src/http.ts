import { ServiceError } from './errors';
export async function readControlJson(request: Request, maxBytes = 1_048_576): Promise<unknown> {
  if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json'))
    throw new ServiceError('INVALID_INPUT', 'صيغة الطلب غير صالحة.', 415);
  if (!request.body) throw new ServiceError('INVALID_INPUT', 'الطلب فارغ.');
  const reader = request.body.getReader(),
    chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new ServiceError('REQUEST_TOO_LARGE', 'بيانات المنشور أكبر من حد الطلب.', 413);
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body));
  } catch {
    throw new ServiceError('INVALID_INPUT', 'بيانات الطلب غير صالحة.');
  }
}
