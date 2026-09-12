/*
 * Thin fetch client for the L22 sticker endpoints
 * (apps/api/src/routes/stickers.ts). Its own module rather than an
 * addition to ../../lib/api.ts — this task owns only new files under
 * app/dashboard/stickers/**, not the existing shared api.ts. Mirrors
 * goals-api.ts's own conventions (bearer token from getAccessToken(),
 * origin from getApiOrigin(), server message surfaced on failure).
 */
import { getAccessToken } from '../../lib/api';
import { getApiOrigin } from '../../lib/api-origin';

export type StickerTier = 'free' | 'pro' | 'creator' | 'studio';

export type Sticker = {
  schemaVersion: 'v1';
  id: string;
  externalKey: string;
  displayName: string;
  category: string;
  minTier: StickerTier;
  byteSize: number;
  enabled: boolean;
  updatedAt: string;
};

async function describeFailure(response: Response, fallback: string): Promise<string> {
  if (response.status === 401) return 'Authentication required';
  try {
    const body = await response.json() as { message?: unknown };
    if (typeof body.message === 'string' && body.message.length > 0 && body.message.length <= 180) return body.message;
  } catch { /* keep the bounded fallback */ }
  return fallback;
}

async function stickersFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getAccessToken();
  if (!token) throw new Error('Authentication required');
  const response = await fetch(`${getApiOrigin()}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers },
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(await describeFailure(response, 'Request could not be completed'));
  return response.json() as Promise<T>;
}

function seg(value: string): string {
  return encodeURIComponent(value);
}

export function listStickers(channelId: string): Promise<{ schemaVersion: 'v1'; items: Sticker[] }> {
  return stickersFetch(`/v1/channels/${seg(channelId)}/stickers`);
}

export function setStickerEnabled(channelId: string, stickerId: string, enabled: boolean): Promise<{ schemaVersion: 'v1'; stickerId: string; enabled: boolean }> {
  return stickersFetch(`/v1/channels/${seg(channelId)}/stickers/${seg(stickerId)}`, { method: 'PATCH', body: JSON.stringify({ enabled }) });
}
