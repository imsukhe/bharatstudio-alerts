const DEFAULT_TIP_REQUEST_TIMEOUT_MS = 10_000;

export function getOrCreateTipIdempotencyKey(current: string | null, createKey: () => string): string {
  return current ?? createKey();
}

export function shouldRetainTipIdempotencyKey(status: number, parsedOrder: boolean): boolean {
  if (parsedOrder) return false;
  return status < 400 || status >= 500;
}

export function tipRequestTimeoutMs(value = DEFAULT_TIP_REQUEST_TIMEOUT_MS): number {
  if (!Number.isFinite(value) || value < 1_000 || value > 60_000) return DEFAULT_TIP_REQUEST_TIMEOUT_MS;
  return Math.floor(value);
}

/**
 * Bounds the browser-to-API wait. A timeout is deliberately not a payment
 * verdict: the caller keeps its idempotency key and may safely retry the same
 * local intent. Razorpay/webhook state remains authoritative.
 */
export async function fetchTipOrder(
  input: { url: string; init: RequestInit; timeoutMs?: number; fetchImpl?: typeof fetch },
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), tipRequestTimeoutMs(input.timeoutMs));
  try {
    const fetchImpl = input.fetchImpl ?? fetch;
    return await fetchImpl(input.url, { ...input.init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}
