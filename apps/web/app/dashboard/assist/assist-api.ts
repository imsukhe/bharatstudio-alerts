/*
 * Thin fetch client for the L23 AI-assist endpoints
 * (apps/api/src/routes/assist.ts). Deliberately its own module rather than
 * an addition to ../../lib/api.ts — this task owns only new files under
 * app/dashboard/assist/**, not the existing shared api.ts. Mirrors
 * ../goals/goals-api.ts's exact conventions (bearer token from
 * getAccessToken(), origin from getApiOrigin(), server message surfaced on
 * failure) so behaviour matches every other page even though the code
 * lives in its own file.
 */
import { getAccessToken } from '../../lib/api';
import { getApiOrigin } from '../../lib/api-origin';

export type AssistSurface = 'config' | 'challenge_copy' | 'translation' | 'alert_style' | 'moderation';
export type AssistStatus = 'pending' | 'accepted' | 'rejected';
export type AssistDecision = 'accepted' | 'rejected';
export type ChannelRole = 'owner' | 'admin' | 'operator' | 'moderator' | 'viewer';

export type AssistSuggestion = {
  schemaVersion: 'v1';
  suggestionId: string;
  channelId: string;
  surface: AssistSurface;
  status: AssistStatus;
  suggestedPayload: Record<string, unknown>;
  basis: string;
  requestedByUserId: string;
  createdAt: string;
  decidedAt: string | null;
};

export type AssistConfirmation = {
  schemaVersion: 'v1';
  confirmationId: string;
  suggestionId: string;
  decision: AssistDecision;
  decidedByUserId: string;
  decidedByRole: ChannelRole;
  appliedPayload: Record<string, unknown> | null;
  decidedAt: string;
};

export type AssistSuggestionAudit = AssistSuggestion & { confirmation: AssistConfirmation | null };

async function describeFailure(response: Response, fallback: string): Promise<string> {
  if (response.status === 401) return 'Authentication required';
  try {
    const body = await response.json() as { message?: unknown };
    if (typeof body.message === 'string' && body.message.length > 0 && body.message.length <= 180) return body.message;
  } catch { /* keep the bounded fallback */ }
  return fallback;
}

async function assistFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
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

export function listAssistSuggestions(channelId: string): Promise<{ schemaVersion: 'v1'; items: AssistSuggestion[] }> {
  return assistFetch(`/v1/channels/${seg(channelId)}/assist/suggestions`);
}

export function generateAssistSuggestion(
  channelId: string,
  input: { surface: AssistSurface; tier: 'free' | 'pro' | 'creator' | 'studio'; signal?: Record<string, string | number | boolean> },
): Promise<AssistSuggestion> {
  return assistFetch(`/v1/channels/${seg(channelId)}/assist/suggestions`, { method: 'POST', body: JSON.stringify(input) });
}

export function decideAssistSuggestion(
  channelId: string,
  suggestionId: string,
  input: { decision: AssistDecision; appliedPayload?: Record<string, unknown> },
): Promise<AssistConfirmation> {
  return assistFetch(`/v1/channels/${seg(channelId)}/assist/suggestions/${seg(suggestionId)}/decide`, { method: 'POST', body: JSON.stringify(input) });
}

export function getAssistSuggestionAudit(channelId: string, suggestionId: string): Promise<AssistSuggestionAudit> {
  return assistFetch(`/v1/channels/${seg(channelId)}/assist/suggestions/${seg(suggestionId)}/audit`);
}
