// L02b: supporter reputation (packages/db/migrations/0120).
//
// There is no "set score" method anywhere in this file, on purpose. The
// score is computed live in the database from signal history (the same
// discipline goal-store.ts's progress uses, see that file's header) — this
// interface is read-only by design.
//
// CROSS-CREATOR BOUNDARY: getVerdict is the only creator-facing read. It
// returns a verdict and a recommended action for a supporter of the
// CALLER's own channel — never the signals or sources behind it, even
// though the underlying score may have been raised by behaviour on another
// creator's channel entirely (see migration 0120's header for why that
// asymmetry is intentional, not a bug).

export type ReputationVerdict = 'clear' | 'flagged';
export type ReputationRecommendedAction = 'none' | 'review_before_payout';

export type SupporterReputationVerdict = {
  schemaVersion: 'v1';
  viewerIdentityId: string;
  verdict: ReputationVerdict;
  recommendedAction: ReputationRecommendedAction;
};

export type GetVerdictResult =
  | { outcome: 'ok'; verdict: SupporterReputationVerdict }
  | { outcome: 'forbidden' }
  | { outcome: 'not_found' };

export interface ReputationStore {
  /**
   * Channel-scoped, verdict-only read. Structurally cannot return
   * cross-creator evidence: the caller must be able to access
   * `channelId`, and `viewerIdentityId` must actually be a supporter of
   * that channel (see app_private.get_supporter_reputation_verdict, 0120).
   */
  getVerdict(userId: string, channelId: string, viewerIdentityId: string): Promise<GetVerdictResult>;
}
