import { fetchTipOrder } from './tip-client';

const receiptTokenPattern = /^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{16}$/;

export async function mintReceiptForConfirmedTip(
  apiOrigin: string,
  intentId: string,
  fetchImpl?: typeof fetch,
): Promise<string | null> {
  try {
    const response = await fetchTipOrder({
      url: `${apiOrigin}/v1/public/receipts`,
      init: {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ intentId }),
      },
      timeoutMs: 5_000,
      fetchImpl,
    });
    if (!response.ok) return null;
    const value = await response.json() as unknown;
    const token = value && typeof value === 'object' ? (value as { token?: unknown }).token : undefined;
    if (typeof token !== 'string' || !receiptTokenPattern.test(token)) return null;
    return token;
  } catch {
    // Receipt creation is deliberately advisory. Payment confirmation has
    // already been established by the durable server-side status endpoint.
    return null;
  }
}

export function receiptPath(token: string): string {
  return `/r/${encodeURIComponent(token)}`;
}
