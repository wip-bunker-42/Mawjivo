import { invoke, isTauri } from '@tauri-apps/api/core';
export interface ServiceProfile {
  id: string;
  baseUrl: string;
  serviceId: string;
  accountId: string;
  deviceCredentialRef: string;
  version: string;
}
export interface ProvisionInput {
  accountId: string;
  apiToken: string;
  r2AccessKeyId: string;
  r2SecretAccessKey: string;
  zoneId: string | null;
  domain: string | null;
}
export interface NativeError {
  code: string;
  messageAr: string;
  retryable: boolean;
}
export function errorMessage(error: unknown): string {
  if (
    typeof error === 'object' &&
    error !== null &&
    'messageAr' in error &&
    typeof error.messageAr === 'string'
  )
    return error.messageAr;
  return 'تعذر إكمال العملية. حاول مرة أخرى.';
}
export async function native<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri())
    throw {
      code: 'DESKTOP_REQUIRED',
      messageAr: 'افتح نسخة التطبيق المثبتة لتجهيز حسابك.',
      retryable: false,
    } satisfies NativeError;
  return invoke<T>(command, args);
}
export function provisionService(input: ProvisionInput): Promise<ServiceProfile> {
  return native('provision_service', { input });
}
export async function listProfiles(): Promise<ServiceProfile[]> {
  return isTauri() ? native('list_profiles') : [];
}
export function serviceRequest<T>(
  profileId: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  return native('service_request', { profileId, method, path, body: body ?? null });
}
