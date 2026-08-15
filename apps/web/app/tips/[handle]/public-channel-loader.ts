import { parsePublicChannel, type PublicChannelResponse } from '../../lib/public-channel-contract';

export type PublicChannelLoad =
  | { state: 'ready'; channel: PublicChannelResponse }
  | { state: 'not_found' }
  | { state: 'unavailable' };

/**
 * Keep transport failure distinct from a creator intentionally closing tips.
 * The donor surface must not turn an API outage, bad response, or missing
 * deployment variable into a misleading policy message.
 */
export async function loadPublicChannel(
  apiOrigin: string | undefined,
  handle: string,
  fetcher: typeof fetch,
): Promise<PublicChannelLoad> {
  if (!apiOrigin) return { state: 'unavailable' };

  try {
    const response = await fetcher(`${apiOrigin}/v1/public/channels/${encodeURIComponent(handle)}`, { cache: 'no-store' });
    if (response.status === 404) return { state: 'not_found' };
    if (!response.ok) return { state: 'unavailable' };

    const channel = parsePublicChannel(await response.json());
    return channel ? { state: 'ready', channel } : { state: 'unavailable' };
  } catch {
    return { state: 'unavailable' };
  }
}
