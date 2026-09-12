/*
 * Thin fetch client for the L17 paid-challenge endpoints
 * (apps/api/src/routes/challenges.ts). Own module, mirrors
 * ../goals/goals-api.ts's exact conventions (bearer token from
 * getAccessToken(), origin from getApiOrigin(), server message surfaced on
 * failure) — this task owns only new files under
 * app/dashboard/challenges/**, not the existing shared api.ts.
 */
import { getAccessToken } from '../../lib/api';
import { getApiOrigin } from '../../lib/api-origin';

export type ChallengeKind = 'stake' | 'bounty';
export type ChallengeState = 'draft' | 'active' | 'succeeded' | 'failed' | 'cancelled';

export type Challenge = {
  schemaVersion: 'v1';
  challengeId: string;
  channelId: string;
  title: string;
  description: string | null;
  kind: ChallengeKind;
  targetAmountPaise: number;
  state: ChallengeState;
  isPublic: boolean;
  progressPaise: number;
  targetReached: boolean;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
};

async function describeFailure(response: Response, fallback: string): Promise<string> {
  if (response.status === 401) return 'Authentication required';
  try {
    const body = await response.json() as { message?: unknown };
    if (typeof body.message === 'string' && body.message.length > 0 && body.message.length <= 180) return body.message;
  } catch { /* keep the bounded fallback */ }
  return fallback;
}

async function challengesFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
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

export function listChallenges(channelId: string): Promise<{ schemaVersion: 'v1'; failureCopy: string; items: Challenge[] }> {
  return challengesFetch(`/v1/channels/${seg(channelId)}/challenges`);
}

export function createChallenge(channelId: string, input: { title: string; description?: string; kind: ChallengeKind; targetAmountPaise: number; isPublic?: boolean }): Promise<Challenge> {
  return challengesFetch(`/v1/channels/${seg(channelId)}/challenges`, { method: 'POST', body: JSON.stringify(input) });
}

export function transitionChallenge(channelId: string, challengeId: string, toState: 'active' | 'succeeded' | 'failed' | 'cancelled'): Promise<Challenge> {
  return challengesFetch(`/v1/channels/${seg(channelId)}/challenges/${seg(challengeId)}/transition`, { method: 'POST', body: JSON.stringify({ toState }) });
}
