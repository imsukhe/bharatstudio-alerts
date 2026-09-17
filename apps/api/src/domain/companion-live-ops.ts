// CMP-94/CMP-22/CMP-30 (migration 0161): Companion live-ops -- Recent
// Actions on the Live Deck, quick-note stream markers, and the
// server-only half of Wrap Stream.
//
// Deliberately its own file, not folded into domain/alert-store.ts
// (companion.ts's own dependency, unowned by this task) or
// domain/companion-feature-store.ts (a different, existing lane's file
// this task does not touch). See packages/db/migrations/
// 0161_v1_cmp_live_ops_recent_actions_markers_wrap.sql's own header for
// the full scope-cut reasoning (what is built, what is explicitly out
// and why, the closed reversible set).

export type CompanionStreamMarker = {
  markerId: string;
  markerType: 'note' | 'clip_moment' | 'sponsor_mention' | 'technical_issue';
  label: string;
  markerAt: string;
  actorUserId?: string;
  createdAt: string;
};

export type CompanionRecentAction = {
  actionId: string;
  action: string;
  category: 'operational' | 'financial';
  targetType: string;
  targetId: string | null;
  actorUserId: string | null;
  occurredAt: string;
  reversible: boolean;
  reason: string | null;
};

export type CompanionWrapPreparedItem = {
  itemId: string;
  itemKind: 'vod_chapters' | 'supporter_thankyou_comment' | 'finance_delta_summary' | 'followup_clip_review_task';
  fireMode: 'prepare' | 'fire';
  content: unknown;
  createdAt: string;
};

export type CompanionStreamWrapSession = {
  wrapSessionId: string;
  status: 'confirming_stop' | 'stop_confirmed' | 'summary_ready';
  obsStoppedConfirmed: boolean;
  broadcastCompleteConfirmed: boolean;
  confirmedStopAt: string | null;
  windowSince: string | null;
  windowUntil: string | null;
  summary: unknown;
  createdAt: string;
  updatedAt: string;
};

// `not_found` covers a channel the caller cannot see AND a caller
// without a qualifying role, collapsed to one answer the same way
// safe-mode-store.ts's own SafeModeResult does -- a distinguishing 403
// would itself leak the channel's existence.
export type CompanionLiveOpsResult<T> =
  | { outcome: 'ok'; value: T }
  | { outcome: 'not_found' }
  // A caller-facing rule was violated (cap reached, already deleted,
  // wrong wrap-session state) -- app_private's own raised exception
  // message is safe to surface, it never carries PII or secrets.
  | { outcome: 'rejected'; message: string };

export interface CompanionLiveOpsStore {
  createStreamMarker(
    userId: string,
    channelId: string,
    label: string,
    markerType: string,
    markerAt: string | null,
  ): Promise<CompanionLiveOpsResult<CompanionStreamMarker>>;

  deleteStreamMarker(userId: string, channelId: string, markerId: string): Promise<CompanionLiveOpsResult<{ markerId: string; deletedAt: string }>>;

  listStreamMarkers(userId: string, channelId: string): Promise<CompanionLiveOpsResult<CompanionStreamMarker[]>>;

  getRecentActions(userId: string, channelId: string, limit: number | null): Promise<CompanionLiveOpsResult<CompanionRecentAction[]>>;

  beginWrapStream(userId: string, channelId: string): Promise<CompanionLiveOpsResult<{ wrapSessionId: string; status: string; createdAt: string }>>;

  confirmWrapStreamStop(
    userId: string,
    channelId: string,
    wrapSessionId: string,
    obsStoppedConfirmed: boolean,
    broadcastCompleteConfirmed: boolean,
  ): Promise<CompanionLiveOpsResult<{ wrapSessionId: string; status: string; confirmedStopAt: string | null }>>;

  generateWrapStreamSummary(userId: string, channelId: string, wrapSessionId: string): Promise<CompanionLiveOpsResult<CompanionStreamWrapSession>>;

  getWrapStreamSession(
    userId: string,
    channelId: string,
    wrapSessionId: string,
  ): Promise<CompanionLiveOpsResult<{ session: CompanionStreamWrapSession; preparedItems: CompanionWrapPreparedItem[] }>>;
}
