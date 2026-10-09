export interface SecretContext {
  workspaceId: string;
  connectionId: string;
  keyVersion: number;
}
import { ServiceError } from './errors';
function encode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}
function decode(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error('INVALID_BASE64');
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}
async function serviceKey(env: Env): Promise<CryptoKey> {
  try {
    const key = decode(env.SERVICE_ENCRYPTION_KEY);
    if (key.length !== 32) throw new Error('KEY_LENGTH');
    return await crypto.subtle.importKey('raw', key, { name: 'AES-GCM' }, false, [
      'encrypt',
      'decrypt',
    ]);
  } catch {
    throw new ServiceError('SERVICE_KEY_MISSING', 'مفتاح تشفير الخدمة يحتاج إصلاحًا.', 503);
  }
}
function aad(context: SecretContext): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(
    new TextEncoder().encode(
      JSON.stringify([context.workspaceId, context.connectionId, context.keyVersion]),
    ),
  );
}
export async function encryptSecret(
  plain: string,
  context: SecretContext,
  env: Env,
): Promise<string> {
  if (context.keyVersion !== 1)
    throw new ServiceError('SERVICE_KEY_VERSION_INVALID', 'إصدار مفتاح الخدمة غير مدعوم.', 503);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: aad(context) },
    await serviceKey(env),
    new TextEncoder().encode(plain),
  );
  return `v1.${context.keyVersion}.${encode(nonce)}.${encode(new Uint8Array(cipher))}`;
}
export async function decryptSecret(
  cipher: string,
  context: SecretContext,
  env: Env,
): Promise<string> {
  const key = await serviceKey(env);
  try {
    const [version, keyVersion, nonce, body, ...rest] = cipher.split('.');
    if (
      version !== 'v1' ||
      keyVersion !== String(context.keyVersion) ||
      rest.length ||
      !nonce ||
      !body
    )
      throw new Error('ENVELOPE');
    const iv = decode(nonce);
    if (iv.length !== 12) throw new Error('NONCE');
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: aad(context) },
      key,
      decode(body),
    );
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(plain);
  } catch {
    throw new ServiceError(
      'SECRET_INVALID',
      'تعذر قراءة بيانات الربط. أعد إدخالها أو استعد مفتاح الخدمة.',
      503,
    );
  }
}
