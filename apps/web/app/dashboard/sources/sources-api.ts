/*
 * Thin fetch client for the L16c (packages/db/migrations/0117) contribution
 * source endpoints on goals/challenges/interaction definitions
 * (apps/api/src/routes/{goals,challenges,interactions}.ts). Own module,
 * mirrors ../goals/goals-api.ts's exact conventions (bearer token from
 * getAccessToken(), origin from getApiOrigin(), server message surfaced on
 * failure) — this task owns only new files under app/dashboard/sources/**,
 * not the existing shared api.ts or the sibling goals/challenges/
 * interactions api modules (whose list-target functions this panel reuses
 * as-is, unmodified).
 *
 * Include/exclude ONLY. There is no percentage or multiplier field
 * anywhere in this file, on purpose: apps/api/src/domain/
 * contribution-source-types.ts and migration 0117's header explain why a
 * platform-cut multiplier is refused (it would present our arithmetic on
 * someone else's money as fact). Do not add one here either.
 */
import { getAccessToken } from '../../lib/api';
import { getApiOrigin } from '../../lib/api-origin';

export type ContributionSourceType = 'payment' | 'youtube_superchat';
export type ContributionTargetKind = 'goal' | 'challenge' | 'interaction';

export type ContributionSourceInclusion = {
  sourceType: ContributionSourceType;
  included: boolean;
};

const TARGET_PATH_SEGMENT: Record<ContributionTargetKind, string> = {
  goal: 'goals',
  challenge: 'challenges',
  interaction: 'interactions',
};

async function describeFailure(response: Response, fallback: string): Promise<string> {
  if (response.status === 401) return 'Authentication required';
  try {
    const body = await response.json() as { message?: unknown };
    if (typeof body.message === 'string' && body.message.length > 0 && body.message.length <= 180) return body.message;
  } catch { /* keep the bounded fallback */ }
  return fallback;
}

async function sourcesFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
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

export function listSourceInclusions(channelId: string, targetKind: ContributionTargetKind, targetId: string): Promise<{ schemaVersion: 'v1'; sources: ContributionSourceInclusion[] }> {
  return sourcesFetch(`/v1/channels/${seg(channelId)}/${TARGET_PATH_SEGMENT[targetKind]}/${seg(targetId)}/sources`);
}

export function setSourceInclusion(channelId: string, targetKind: ContributionTargetKind, targetId: string, sourceType: ContributionSourceType, included: boolean): Promise<{ schemaVersion: 'v1'; sources: ContributionSourceInclusion[] }> {
  return sourcesFetch(`/v1/channels/${seg(channelId)}/${TARGET_PATH_SEGMENT[targetKind]}/${seg(targetId)}/sources`, {
    method: 'PUT',
    body: JSON.stringify({ sourceType, included }),
  });
}
