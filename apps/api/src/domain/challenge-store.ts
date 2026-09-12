// L17: paid challenges (packages/db/migrations/0109). Progress is never
// stored — see the migration's header — so this type never carries a
// "set progress" input anywhere, on any method, by design. Likewise there
// is no refund-related field anywhere on this type: this system cannot
// initiate a refund (see the migration header and
// apps/api/src/domain/payment-provider-creator.ts's ConnectionCapabilities
// .supportsRefunds doc comment), so a challenge RESOLVES rather than
// reverses. See CHALLENGE_FAILURE_COPY below for the exact sentence shown
// wherever a contributor sees a challenge.

export type ChallengeKind = 'stake' | 'bounty';
export type ChallengeState = 'draft' | 'active' | 'succeeded' | 'failed' | 'cancelled';

/**
 * Locked product copy (see this task's report, "The no-refund
 * consequence"). Shown wherever a contributor can see or contribute to a
 * challenge — the dashboard preview and the OBS widget both import this
 * exact string rather than re-typing it, so the sentence can never drift
 * between surfaces.
 */
export const CHALLENGE_FAILURE_COPY =
  'Contributing to a challenge is a tip to the creator, not an escrowed payment — BharatStudio holds no funds and cannot issue a refund. If this challenge fails or is cancelled, your contribution stays with the creator; only the creator can refund you, and only from their own connected payment provider.';

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

export type CreateChallengeInput = {
  title: string;
  description?: string | null;
  kind: ChallengeKind;
  targetAmountPaise: number;
  isPublic?: boolean;
};

export type CreateChallengeResult =
  | { outcome: 'created'; challenge: Challenge }
  | { outcome: 'forbidden' }
  | { outcome: 'tier_limit_reached' }
  | { outcome: 'invalid' };

// Every non-terminal-to-terminal (and draft-to-active) edge this system
// will ever accept. Kept alongside the store as the one client-visible
// restatement of the SQL-side app_private.transition_challenge() edges —
// never a second source of truth to drift from it, just documentation of
// which outcomes a caller can expect.
export type TransitionChallengeResult =
  | { outcome: 'ok'; challenge: Challenge }
  | { outcome: 'forbidden' }
  | { outcome: 'not_found' }
  | { outcome: 'invalid_transition' }
  | { outcome: 'invalid' };

export interface ChallengeStore {
  create(userId: string, channelId: string, input: CreateChallengeInput): Promise<CreateChallengeResult>;
  list(userId: string, channelId: string): Promise<Challenge[]>;
  get(userId: string, channelId: string, challengeId: string): Promise<Challenge | null>;
  transition(userId: string, channelId: string, challengeId: string, toState: 'active' | 'succeeded' | 'failed' | 'cancelled'): Promise<TransitionChallengeResult>;
}

// Overlay/widget read — mirrors apps/api/src/domain/goal-store.ts's
// OverlayGoal/OverlayGoalStore exactly: same overlay_sessions table, same
// token-fingerprint scoping, no new auth path.
export type OverlayChallenge = {
  schemaVersion: 'v1';
  challengeId: string;
  title: string;
  kind: ChallengeKind;
  targetAmountPaise: number;
  state: ChallengeState;
  progressPaise: number;
  targetReached: boolean;
};

export interface OverlayChallengeStore {
  getForOverlay(token: string, overlayId: string): Promise<OverlayChallenge | null>;
}
