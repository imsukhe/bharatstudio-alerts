import { parseTipIntentResponse, type TipIntentResponse } from './tipintent-contract';

export type TipIntentLoad =
  | { state: 'ready' | 'used' | 'expired' | 'unknown'; intent: TipIntentResponse }
  | { state: 'unavailable' };

/**
 * Same "transport failure is distinct from a real, named state" discipline
 * as ../../tips/[handle]/public-channel-loader.ts: an API outage or a
 * malformed/tampered response must never be presented to a viewer as
 * "used" or "expired" — those are specific, honest states this loader
 * only reports when the server actually said so.
 */
export async function loadTipIntent(
  apiOrigin: string | undefined,
  token: string,
  fetcher: typeof fetch,
): Promise<TipIntentLoad> {
  if (!apiOrigin) return { state: 'unavailable' };

  try {
    const response = await fetcher(`${apiOrigin}/v1/public/tip-intents/${encodeURIComponent(token)}`, { cache: 'no-store' });
    if (response.status !== 200 && response.status !== 404) return { state: 'unavailable' };

    const parsed = parseTipIntentResponse(await response.json());
    if (!parsed) return { state: 'unavailable' };
    return { state: parsed.state, intent: parsed };
  } catch {
    return { state: 'unavailable' };
  }
}
