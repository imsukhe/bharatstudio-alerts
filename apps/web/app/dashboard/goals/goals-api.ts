/*
 * Thin fetch client for the L16 support-goal endpoints
 * (apps/api/src/routes/goals.ts). Deliberately its own module rather than
 * an addition to ../../lib/api.ts — this task owns only new files under
 * app/dashboard/goals/**, not the existing shared api.ts. Mirrors that
 * file's own conventions (bearer token from getAccessToken(), origin from
 * getApiOrigin(), server message surfaced on failure) so behaviour matches
 * every other page even though the code lives in its own file.
 */
import { getAccessToken } from '../../lib/api';
import { getApiOrigin } from '../../lib/api-origin';

export type GoalWindow = 'stream' | 'daily' | 'monthly' | 'open';

export type SupportGoal = {
  schemaVersion: 'v1';
  goalId: string;
  channelId: string;
  title: string;
  targetAmountPaise: number;
  window: GoalWindow;
  isPublic: boolean;
  progressPaise: number;
  reached: boolean;
  ended: boolean;
  startedAt: string;
  endedAt: string | null;
};

async function describeFailure(response: Response, fallback: string): Promise<string> {
  if (response.status === 401) return 'Authentication required';
  try {
    const body = await response.json() as { message?: unknown };
    if (typeof body.message === 'string' && body.message.length > 0 && body.message.length <= 180) return body.message;
  } catch { /* keep the bounded fallback */ }
  return fallback;
}

async function goalsFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
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

export function listGoals(channelId: string): Promise<{ schemaVersion: 'v1'; items: SupportGoal[] }> {
  return goalsFetch(`/v1/channels/${seg(channelId)}/goals`);
}

export function createGoal(channelId: string, input: { title: string; targetAmountPaise: number; window: GoalWindow; isPublic?: boolean }): Promise<SupportGoal> {
  return goalsFetch(`/v1/channels/${seg(channelId)}/goals`, { method: 'POST', body: JSON.stringify(input) });
}

export function updateGoal(channelId: string, goalId: string, input: { title?: string; targetAmountPaise?: number }): Promise<SupportGoal> {
  return goalsFetch(`/v1/channels/${seg(channelId)}/goals/${seg(goalId)}`, { method: 'PATCH', body: JSON.stringify(input) });
}

export function endGoal(channelId: string, goalId: string): Promise<SupportGoal> {
  return goalsFetch(`/v1/channels/${seg(channelId)}/goals/${seg(goalId)}/end`, { method: 'POST' });
}
