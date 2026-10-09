import type { AppError } from '@mawjivo/core';
export class ServiceError extends Error implements AppError {
  constructor(
    public code: string,
    public messageAr: string,
    public status = 400,
    public retryable = false,
  ) {
    super(code);
  }
}
export function errorResponse(error: unknown): Response {
  const safe =
    error instanceof ServiceError
      ? error
      : new ServiceError(
          'INTERNAL_ERROR',
          'تعذر تنفيذ الطلب. افحص جاهزية الخدمة أو حاول مجددًا.',
          500,
          true,
        );
  if (!(error instanceof ServiceError)) console.error({ event: 'request_failed', code: safe.code });
  return Response.json(
    { code: safe.code, messageAr: safe.messageAr, retryable: safe.retryable },
    { status: safe.status, headers: { 'Cache-Control': 'no-store' } },
  );
}
