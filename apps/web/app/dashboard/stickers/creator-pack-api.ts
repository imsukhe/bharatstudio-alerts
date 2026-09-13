/*
 * Thin fetch client for the L22 gap-fill creator-pack endpoints
 * (apps/api/src/routes/stickers.ts's sticker-pack routes). Mirrors
 * sticker-api.ts's own conventions exactly — own module, not an addition
 * to ../../lib/api.ts, this task owns only new files under
 * app/dashboard/stickers/**.
 */
import { getAccessToken } from '../../lib/api';
import { getApiOrigin } from '../../lib/api-origin';

export type CreatorPackStatus = 'active' | 'pending_review';

export type CreatorPackSticker = {
  schemaVersion: 'v1';
  id: string;
  displayName: string;
  category: string;
  byteSize: number;
  enabled: boolean;
  status: CreatorPackStatus;
  creatorAttested: boolean;
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

async function creatorPackFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
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

export function listCreatorPack(channelId: string): Promise<{ schemaVersion: 'v1'; items: CreatorPackSticker[] }> {
  return creatorPackFetch(`/v1/channels/${seg(channelId)}/sticker-pack`);
}

export function uploadCreatorPackSticker(
  channelId: string, displayName: string, category: string, renderDocument: unknown, creatorAttested: boolean,
): Promise<{ schemaVersion: 'v1'; id: string; status: CreatorPackStatus }> {
  return creatorPackFetch(`/v1/channels/${seg(channelId)}/sticker-pack`, {
    method: 'POST', body: JSON.stringify({ displayName, category, renderDocument, creatorAttested }),
  });
}

export function setCreatorPackStickerEnabled(channelId: string, packStickerId: string, enabled: boolean): Promise<{ schemaVersion: 'v1'; id: string; enabled: boolean }> {
  return creatorPackFetch(`/v1/channels/${seg(channelId)}/sticker-pack/${seg(packStickerId)}`, { method: 'PATCH', body: JSON.stringify({ enabled }) });
}
