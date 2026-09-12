import { parseReceiptResponse, type ReceiptResponse } from './receipt-contract';

export type ReceiptLoad = { state: 'found' | 'not_found'; receipt: ReceiptResponse } | { state: 'unavailable' };

/**
 * Same "transport failure is distinct from a real, named state" discipline
 * as ../../t/[token]/tipintent-loader.ts. This page never requires a
 * viewer account or bearer token — the fetch below carries no
 * Authorization header, by design, since a tipper who never signed up
 * must still be able to open their own receipt link.
 */
export async function loadReceipt(apiOrigin: string | undefined, token: string, fetcher: typeof fetch): Promise<ReceiptLoad> {
  if (!apiOrigin) return { state: 'unavailable' };

  try {
    const response = await fetcher(`${apiOrigin}/v1/public/receipts/${encodeURIComponent(token)}`, { cache: 'no-store' });
    if (response.status !== 200 && response.status !== 404) return { state: 'unavailable' };

    const parsed = parseReceiptResponse(await response.json());
    if (!parsed) return { state: 'unavailable' };
    return { state: parsed.state, receipt: parsed };
  } catch {
    return { state: 'unavailable' };
  }
}
