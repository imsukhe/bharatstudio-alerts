// CMP-21: goal controls from Companion (packages/db/migrations/0162).
// See that migration's header for the full design rationale --
// in particular why "increase target"/"mark complete" reuse 0102/0150's
// existing goal/completion state instead of adding a second copy of it,
// and why "trigger celebration" can only ever prepare (never fire).
//
// Every method here enforces the THIRD layer of the Companion
// authorisation model (entitlement + activation are the route layer's
// job, exactly like companion.ts's own /actions route) -- the caller
// must present a currently active companion control-session lease
// (0053), checked inside the database function itself.

export type GoalControlOutcome =
  | { outcome: 'ok' }
  | { outcome: 'forbidden' }
  | { outcome: 'not_found' }
  | { outcome: 'ended' }
  | { outcome: 'invalid' }
  | { outcome: 'session_inactive' };

export type IncreaseGoalTargetInput = {
  sessionId: string;
  idempotencyKey: string;
  newTargetAmountPaise: number;
};

export type GoalControlInput = {
  sessionId: string;
  idempotencyKey: string;
};

export interface CompanionGoalControlStore {
  increaseTarget(userId: string, channelId: string, goalId: string, input: IncreaseGoalTargetInput): Promise<GoalControlOutcome>;
  startTimer(userId: string, channelId: string, goalId: string, input: GoalControlInput): Promise<GoalControlOutcome>;
  markComplete(userId: string, channelId: string, goalId: string, input: GoalControlInput): Promise<GoalControlOutcome>;
  prepareCelebration(userId: string, channelId: string, goalId: string, input: GoalControlInput): Promise<GoalControlOutcome>;
}
