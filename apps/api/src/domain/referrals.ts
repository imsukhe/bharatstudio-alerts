// Creator-to-creator referral/growth engine — v1 scope addendum item. The
// credit mechanism is a service-time credit (extends a subscription's
// current_period_end), never a refund — see migration 0076 and
// bharatstudio-requirements' "Referral credit mechanism addendum —
// 2026-08-16" for the full design rationale.

export type ReferralOverview = {
  schemaVersion: 'v1';
  pendingCount: number;
  paidPendingHoldCount: number;
  creditedCount: number;
  flaggedOrRevokedCount: number;
  bankedCreditDays: number;
  lifetimeCreditedDays: number;
};

export type ReferralStatus = 'pending' | 'paid_pending_hold' | 'credited' | 'flagged_fraud' | 'revoked' | 'expired';

export type ReferralHistoryEntry = {
  referralId: string;
  status: ReferralStatus;
  attributedAt: string;
  creditedAt: string | null;
  creditDays: number | null;
};

export type ReferralHistory = {
  schemaVersion: 'v1';
  items: ReferralHistoryEntry[];
};

export type ReferralAttributionResult =
  | 'attributed'
  | 'flagged_fraud'
  | 'self_referral_rejected'
  | 'already_referred'
  | 'unknown_referrer_code';

export interface ReferralStore {
  getOverview(userId: string, channelId: string): Promise<ReferralOverview>;
  listHistory(userId: string, channelId: string): Promise<ReferralHistory>;
  // Best-effort: never throws for an expected outcome (bad code,
  // self-referral, already-referred) — the caller logs the result and
  // moves on. Called from its own transaction, separate from channel
  // creation, so a referral-attribution failure can never roll back or
  // fail the channel-creation request that triggered it.
  attribute(referredChannelId: string, referrerHandle: string, ipSubnetHash: string | null): Promise<ReferralAttributionResult>;
}
