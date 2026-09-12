// L16 (packages/db/migrations/0105): interaction_definitions, widget_configs,
// support votes, hype mode, leaderboard. See that migration's header for the
// two scope-boundary decisions (votes are a free tally, not money-gated;
// hype mode IS money-derived) and the leaderboard privacy design (never an
// exact amount, in any configuration).

export type InteractionType =
  | 'tip' | 'tts_tip' | 'sticker' | 'mega_alert' | 'priority_question'
  | 'support_vote' | 'community_goal' | 'hype_mode';

export type ModerationRule = 'none' | 'review' | 'block_list';

export type InteractionDefinition = {
  schemaVersion: 'v1';
  definitionId: string;
  channelId: string;
  interactionType: InteractionType;
  label: string;
  amountPaise: number | null;
  queueId: string;
  ttsEnabled: boolean;
  moderationRule: ModerationRule;
  visual: Record<string, unknown>;
  config: Record<string, unknown>;
  isEnabled: boolean;
  closed: boolean;
  createdAt: string;
  updatedAt: string;
};

export type CreateInteractionDefinitionInput = {
  interactionType: InteractionType;
  label: string;
  amountPaise?: number | null;
  queueId: string;
  ttsEnabled?: boolean;
  moderationRule?: ModerationRule;
  visual?: Record<string, unknown>;
  config?: Record<string, unknown>;
};

export type UpdateInteractionDefinitionInput = {
  label?: string;
  amountPaise?: number | null;
  ttsEnabled?: boolean;
  moderationRule?: ModerationRule;
  visual?: Record<string, unknown>;
  isEnabled?: boolean;
};

export type CreateDefinitionResult =
  | { outcome: 'created'; definition: InteractionDefinition }
  | { outcome: 'forbidden' }
  | { outcome: 'tier_limit_reached' }
  | { outcome: 'invalid' };

export type MutateDefinitionResult =
  | { outcome: 'ok'; definition: InteractionDefinition }
  | { outcome: 'forbidden' }
  | { outcome: 'not_found' }
  | { outcome: 'invalid' };

export interface InteractionDefinitionStore {
  create(userId: string, channelId: string, input: CreateInteractionDefinitionInput): Promise<CreateDefinitionResult>;
  list(userId: string, channelId: string): Promise<InteractionDefinition[]>;
  update(userId: string, channelId: string, definitionId: string, input: UpdateInteractionDefinitionInput): Promise<MutateDefinitionResult>;
  close(userId: string, channelId: string, definitionId: string): Promise<MutateDefinitionResult>;
}

// --- Support votes --------------------------------------------------------

export type VoteTallyRow = { optionKey: string; label: string; voteCount: number };
export type VoteTally = { schemaVersion: 'v1'; options: VoteTallyRow[]; resolved: boolean; resolvedOptionKey: string | null };

export type CreateVoteOptionResult =
  | { outcome: 'created'; optionId: string }
  | { outcome: 'forbidden' }
  | { outcome: 'not_found' }
  | { outcome: 'invalid' };

export interface SupportVoteStore {
  createOption(userId: string, channelId: string, definitionId: string, optionKey: string, label: string): Promise<CreateVoteOptionResult>;
  tally(userId: string, channelId: string, definitionId: string): Promise<VoteTally | null>;
}

export type CastVoteResult = { outcome: 'counted' | 'already_voted' } | { outcome: 'invalid' };

export interface PublicVoteStore {
  cast(definitionId: string, optionKey: string, voterFingerprint: string): Promise<CastVoteResult>;
}

// --- Hype mode --------------------------------------------------------

export type HypeModeState = {
  schemaVersion: 'v1';
  meterPaise: number;
  thresholdPaise: number;
  reached: boolean;
  startedAt: string;
  endsAt: string;
  ended: boolean;
} | null;

export type HypeLifecycleResult = { outcome: 'ok' } | { outcome: 'forbidden' } | { outcome: 'not_found' } | { outcome: 'invalid' };

export interface HypeModeStore {
  start(userId: string, channelId: string, definitionId: string, durationSeconds: number): Promise<HypeLifecycleResult>;
  end(userId: string, channelId: string, definitionId: string): Promise<HypeLifecycleResult>;
  get(userId: string, channelId: string, definitionId: string): Promise<HypeModeState>;
}

// --- Widget configs --------------------------------------------------------

export type WidgetType =
  | 'main_alert' | 'support_goal' | 'recent_tips' | 'top_supporters'
  | 'supporter_ticker' | 'public_leaderboard' | 'mega_tip_banner';

export type PrivacyScope = 'private' | 'public';

export type WidgetConfig = {
  schemaVersion: 'v1';
  widgetConfigId: string;
  channelId: string;
  widgetType: WidgetType;
  placement: Record<string, unknown>;
  style: Record<string, unknown>;
  dataSource: Record<string, unknown>;
  privacyScope: PrivacyScope;
  isEnabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type CreateWidgetConfigInput = {
  widgetType: WidgetType;
  placement?: Record<string, unknown>;
  style?: Record<string, unknown>;
  dataSource?: Record<string, unknown>;
  privacyScope?: PrivacyScope;
};

export type UpdateWidgetConfigInput = {
  placement?: Record<string, unknown>;
  style?: Record<string, unknown>;
  dataSource?: Record<string, unknown>;
  privacyScope?: PrivacyScope;
  isEnabled?: boolean;
};

export type CreateWidgetResult =
  | { outcome: 'created'; widget: WidgetConfig }
  | { outcome: 'forbidden' }
  | { outcome: 'tier_limit_reached' }
  | { outcome: 'invalid' };

export type MutateWidgetResult =
  | { outcome: 'ok'; widget?: WidgetConfig }
  | { outcome: 'forbidden' }
  | { outcome: 'not_found' }
  | { outcome: 'invalid' };

export interface WidgetConfigStore {
  create(userId: string, channelId: string, input: CreateWidgetConfigInput): Promise<CreateWidgetResult>;
  list(userId: string, channelId: string): Promise<WidgetConfig[]>;
  update(userId: string, channelId: string, widgetConfigId: string, input: UpdateWidgetConfigInput): Promise<MutateWidgetResult>;
  remove(userId: string, channelId: string, widgetConfigId: string): Promise<MutateWidgetResult>;
}

// --- Leaderboard --------------------------------------------------------

export type LeaderboardWindow = 'weekly' | 'monthly' | 'all';
export type LeaderboardRow = { rank: number; viewerRef: string; tierLabel: string };
export type Leaderboard = { schemaVersion: 'v1'; window: LeaderboardWindow; rows: LeaderboardRow[] };

export interface LeaderboardStore {
  get(userId: string, channelId: string, window: LeaderboardWindow): Promise<Leaderboard>;
}

// --- Overlay reads (bearer token, no session cookie — same shape as
// OverlayGoalStore in domain/goal-store.ts) --------------------------------

export interface InteractionOverlayStore {
  getWidgetConfig(token: string, overlayId: string, widgetType: WidgetType): Promise<Pick<WidgetConfig, 'widgetConfigId' | 'widgetType' | 'placement' | 'style' | 'dataSource'> | null>;
  getVoteTally(token: string, overlayId: string, definitionId: string): Promise<VoteTally | null>;
  getHypeMode(token: string, overlayId: string, definitionId: string): Promise<HypeModeState>;
  getLeaderboard(token: string, overlayId: string, window: LeaderboardWindow): Promise<Leaderboard | null>;
}
