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

export interface GoalStore {
  create(userId: string, channelId: string, input: CreateGoalInput): Promise<CreateGoalResult>;
  list(userId: string, channelId: string): Promise<SupportGoal[]>;
  get(userId: string, channelId: string, goalId: string): Promise<SupportGoal | null>;
  update(userId: string, channelId: string, goalId: string, input: UpdateGoalInput): Promise<MutateGoalResult>;
  end(userId: string, channelId: string, goalId: string): Promise<MutateGoalResult>;
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
