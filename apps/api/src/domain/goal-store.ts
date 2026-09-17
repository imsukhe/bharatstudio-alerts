// L16: support goals (packages/db/migrations/0102). Progress is never
// stored — see the migration's header — so this type never carries a
// "set progress" input anywhere, on any method, by design.

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

export type CreateGoalInput = {
  title: string;
  targetAmountPaise: number;
  window: GoalWindow;
  isPublic?: boolean;
};

export type UpdateGoalInput = {
  title?: string;
  targetAmountPaise?: number;
};

export type CreateGoalResult =
  | { outcome: 'created'; goal: SupportGoal }
  | { outcome: 'forbidden' }
  | { outcome: 'tier_limit_reached' }
  | { outcome: 'invalid' };

export type MutateGoalResult =
  | { outcome: 'ok'; goal: SupportGoal }
  | { outcome: 'forbidden' }
  | { outcome: 'not_found' }
  | { outcome: 'ended' }
  | { outcome: 'invalid' };

// GOA-01/GOA-02/GOA-03 (packages/db/migrations/0150). Completion is a
// LATCHED, AUDITED EVENT, not a second copy of `reached` above — `reached`
// stays exactly as it always was (purely derived, can flip back false after
// a refund); `completed` here is written once and a refund never un-writes
// it (GOA-02). `completedProgressPaise`/`targetAmountPaiseAtCompletion` are
// frozen at the moment the latch fired; `progressPaise`/`targetAmountPaise`
// stay live, so a creator can see both numbers side by side.
export type GoalCompletion = {
  schemaVersion: 'v1';
  goalId: string;
  completed: boolean;
  completedAt: string | null;
  completedProgressPaise: number | null;
  targetAmountPaiseAtCompletion: number | null;
  progressPaise: number;
  targetAmountPaise: number;
  lastReopenedAt: string | null;
  lastReopenedByUserId: string | null;
  lastReopenReason: string | null;
};

export type GetGoalCompletionResult =
  | { outcome: 'ok'; completion: GoalCompletion }
  | { outcome: 'not_found' };

export type ReopenGoalCompletionInput = {
  reason: string;
};

// GOA-03: manual reopen is explicit and reason-required. `not_completed`
// is its own outcome, distinct from `not_found` — reopening a goal that
// exists but was never completed (or was already reopened) is a 409, not a
// 404 and not a validation error.
export type ReopenGoalCompletionResult =
  | { outcome: 'ok'; completion: GoalCompletion }
  | { outcome: 'forbidden' }
  | { outcome: 'not_found' }
  | { outcome: 'not_completed' }
  | { outcome: 'invalid' };

export interface GoalStore {
  create(userId: string, channelId: string, input: CreateGoalInput): Promise<CreateGoalResult>;
  list(userId: string, channelId: string): Promise<SupportGoal[]>;
  get(userId: string, channelId: string, goalId: string): Promise<SupportGoal | null>;
  update(userId: string, channelId: string, goalId: string, input: UpdateGoalInput): Promise<MutateGoalResult>;
  end(userId: string, channelId: string, goalId: string): Promise<MutateGoalResult>;
  getCompletion(userId: string, channelId: string, goalId: string): Promise<GetGoalCompletionResult>;
  reopenCompletion(userId: string, channelId: string, goalId: string, input: ReopenGoalCompletionInput): Promise<ReopenGoalCompletionResult>;
}

// Overlay/widget read — see list_overlay_goal (0102), which mirrors
// list_overlay_lottie_assets's exact session/token-fingerprint scoping
// (apps/api/src/domain/branding.ts's OverlayBrandingStore). No new auth
// path is invented here.
export type OverlayGoal = {
  schemaVersion: 'v1';
  goalId: string;
  title: string;
  targetAmountPaise: number;
  window: GoalWindow;
  progressPaise: number;
  reached: boolean;
};

export interface OverlayGoalStore {
  getForOverlay(token: string, overlayId: string): Promise<OverlayGoal | null>;
}
