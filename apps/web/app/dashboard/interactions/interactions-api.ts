/*
 * Thin fetch client for the L16 interaction/widget endpoints
 * (apps/api/src/routes/interactions.ts). Own module, not an addition to
 * ../../lib/api.ts — mirrors ../goals/goals-api.ts's own conventions
 * (bearer token from getAccessToken(), origin from getApiOrigin(), server
 * message surfaced on failure).
 */
import { getAccessToken } from '../../lib/api';
import { getApiOrigin } from '../../lib/api-origin';

export type InteractionType = 'tip' | 'tts_tip' | 'sticker' | 'mega_alert' | 'priority_question' | 'support_vote' | 'community_goal' | 'hype_mode';
export type ModerationRule = 'none' | 'review' | 'block_list';
export type WidgetType = 'main_alert' | 'support_goal' | 'recent_tips' | 'top_supporters' | 'supporter_ticker' | 'public_leaderboard' | 'mega_tip_banner';
export type PrivacyScope = 'private' | 'public';
export type LeaderboardWindow = 'weekly' | 'monthly' | 'all';

export type InteractionDefinition = {
  schemaVersion: 'v1'; definitionId: string; channelId: string; interactionType: InteractionType; label: string;
  amountPaise: number | null; queueId: string; ttsEnabled: boolean; moderationRule: ModerationRule;
  visual: Record<string, unknown>; config: Record<string, unknown>; isEnabled: boolean; closed: boolean;
  createdAt: string; updatedAt: string;
};

export type WidgetConfig = {
  schemaVersion: 'v1'; widgetConfigId: string; channelId: string; widgetType: WidgetType;
  placement: Record<string, unknown>; style: Record<string, unknown>; dataSource: Record<string, unknown>;
  privacyScope: PrivacyScope; isEnabled: boolean; createdAt: string; updatedAt: string;
};

export type VoteTally = { schemaVersion: 'v1'; options: { optionKey: string; label: string; voteCount: number }[]; resolved: boolean; resolvedOptionKey: string | null };
export type HypeModeState = { schemaVersion: 'v1'; meterPaise: number; thresholdPaise: number; reached: boolean; startedAt: string; endsAt: string; ended: boolean } | null;
export type Leaderboard = { schemaVersion: 'v1'; window: LeaderboardWindow; rows: { rank: number; viewerRef: string; tierLabel: string }[] };

async function describeFailure(response: Response, fallback: string): Promise<string> {
  if (response.status === 401) return 'Authentication required';
  try {
    const body = await response.json() as { message?: unknown };
    if (typeof body.message === 'string' && body.message.length > 0 && body.message.length <= 180) return body.message;
  } catch { /* keep the bounded fallback */ }
  return fallback;
}

async function interactionsFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
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

export function listInteractionDefinitions(channelId: string): Promise<{ schemaVersion: 'v1'; items: InteractionDefinition[] }> {
  return interactionsFetch(`/v1/channels/${seg(channelId)}/interactions`);
}

export function createInteractionDefinition(channelId: string, input: {
  interactionType: InteractionType; label: string; amountPaise?: number | null; queueId: string;
  ttsEnabled?: boolean; moderationRule?: ModerationRule; visual?: Record<string, unknown>; config?: Record<string, unknown>;
}): Promise<InteractionDefinition> {
  return interactionsFetch(`/v1/channels/${seg(channelId)}/interactions`, { method: 'POST', body: JSON.stringify(input) });
}

export function closeInteractionDefinition(channelId: string, definitionId: string): Promise<InteractionDefinition> {
  return interactionsFetch(`/v1/channels/${seg(channelId)}/interactions/${seg(definitionId)}/close`, { method: 'POST' });
}

export function createVoteOption(channelId: string, definitionId: string, optionKey: string, label: string): Promise<{ schemaVersion: 'v1'; optionId: string }> {
  return interactionsFetch(`/v1/channels/${seg(channelId)}/interactions/${seg(definitionId)}/vote-options`, { method: 'POST', body: JSON.stringify({ optionKey, label }) });
}

export function getVoteTally(channelId: string, definitionId: string): Promise<{ schemaVersion: 'v1'; tally: VoteTally | null }> {
  return interactionsFetch(`/v1/channels/${seg(channelId)}/interactions/${seg(definitionId)}/vote-tally`);
}

export function startHypeMode(channelId: string, definitionId: string, durationSeconds: number): Promise<{ schemaVersion: 'v1'; ok: true }> {
  return interactionsFetch(`/v1/channels/${seg(channelId)}/interactions/${seg(definitionId)}/hype/start`, { method: 'POST', body: JSON.stringify({ durationSeconds }) });
}

export function endHypeMode(channelId: string, definitionId: string): Promise<{ schemaVersion: 'v1'; ok: true }> {
  return interactionsFetch(`/v1/channels/${seg(channelId)}/interactions/${seg(definitionId)}/hype/end`, { method: 'POST' });
}

export function getHypeMode(channelId: string, definitionId: string): Promise<{ schemaVersion: 'v1'; hype: HypeModeState }> {
  return interactionsFetch(`/v1/channels/${seg(channelId)}/interactions/${seg(definitionId)}/hype`);
}

export function listWidgetConfigs(channelId: string): Promise<{ schemaVersion: 'v1'; items: WidgetConfig[] }> {
  return interactionsFetch(`/v1/channels/${seg(channelId)}/widgets`);
}

export function createWidgetConfig(channelId: string, input: { widgetType: WidgetType; placement?: Record<string, unknown>; style?: Record<string, unknown>; dataSource?: Record<string, unknown>; privacyScope?: PrivacyScope }): Promise<WidgetConfig> {
  return interactionsFetch(`/v1/channels/${seg(channelId)}/widgets`, { method: 'POST', body: JSON.stringify(input) });
}

export function deleteWidgetConfig(channelId: string, widgetConfigId: string): Promise<{ schemaVersion: 'v1'; ok: true }> {
  return interactionsFetch(`/v1/channels/${seg(channelId)}/widgets/${seg(widgetConfigId)}`, { method: 'DELETE' });
}

export function getLeaderboard(channelId: string, window: LeaderboardWindow = 'all'): Promise<Leaderboard> {
  return interactionsFetch(`/v1/channels/${seg(channelId)}/leaderboard?window=${seg(window)}`);
}
