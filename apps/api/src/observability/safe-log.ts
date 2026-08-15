import type { FastifyRequest } from 'fastify';

const SAFE_VALUE = /^[A-Za-z0-9._:-]{1,128}$/;
const ALLOWED_CONTEXT_KEYS = new Set(['job']);

function bounded(value: unknown): string {
  if (typeof value !== 'string') return 'unknown';
  return SAFE_VALUE.test(value) ? value : 'other';
}

export function safeErrorFields(error: unknown): { error_type: string } {
  if (error instanceof Error) return { error_type: bounded(error.name || 'Error') };
  if (typeof error === 'string') return { error_type: 'string_error' };
  return { error_type: 'unknown' };
}

/**
 * Record an operational failure without serialising provider, database, or
 * user-controlled error messages and stacks. The trace id is the only
 * request correlation value retained; callers may add only bounded labels.
 */
export function logSafeError(
  request: FastifyRequest,
  event: string,
  error: unknown,
  context: Record<string, string> = {},
): void {
  const labels = Object.fromEntries(
    Object.entries(context)
      .filter(([key]) => ALLOWED_CONTEXT_KEYS.has(key))
      .map(([key, value]) => [key, bounded(value)]),
  );
  request.log.error({
    event: bounded(event),
    trace_id: bounded(request.id),
    ...safeErrorFields(error),
    ...labels,
  }, bounded(event));
}
