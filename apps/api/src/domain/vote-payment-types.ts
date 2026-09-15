// L16 gap closure (packages/db/migrations/0108): paid support votes.
// Separate types file from domain/interaction-types.ts (not edited by this
// task — see the delivery report's ownership boundary) so every existing
// consumer of SupportVoteStore/InteractionOverlayStore keeps compiling and
// behaving unchanged. A support_vote definition opts into this path only
// via its own config.votingMode === 'paid' (see 0108's header); the
// existing free/headcount VoteTally/SupportVoteStore/PublicVoteStore in
// interaction-types.ts are untouched by this file.

// A tip that should count toward a paid vote option. Tagged BEFORE the
// payment is created (apps/api/src/routes/public.ts, at tip-order time),
// keyed by the same (channelId, environment, idempotencyKey) triple that
// row already computes for the payment itself — see 0108's header for the
// full join chain from this tag to the real payment/refund rows.
export type TagVotePaymentInput = {
  channelId: string;
  environment: 'test' | 'live';
  idempotencyKey: string;
  interactionDefinitionId: string;
  optionKey: string;
};

export type TagVotePaymentResult = { outcome: 'tagged' } | { outcome: 'invalid' } | { outcome: 'unavailable' };

export interface VotePaymentTagStore {
  tag(input: TagVotePaymentInput): Promise<TagVotePaymentResult>;
}

// Narrow unauthenticated projection for the public tip form. It remains
// deliberately separate from creator interaction definitions so queue,
// moderation, visual/configuration, tally and viewer fields cannot reach a
// public response by accident.
export type PublicPaidVoteOption = { optionKey: string; label: string };
export type PublicPaidVoteDefinition = {
  definitionId: string;
  label: string;
  options: PublicPaidVoteOption[];
};

export interface PublicPaidVoteStore {
  listForChannel(channelId: string): Promise<PublicPaidVoteDefinition[]>;
}

// Money-derived tally — never a stored counter (app_private.
// paid_support_vote_tally sums real payments minus processed refunds live,
// on every read, exactly like 0102/0105's other tallies).
export type PaidVoteTallyRow = { optionKey: string; label: string; amountPaise: number };
export type PaidVoteTally = {
  schemaVersion: 'v1';
  votingMode: 'paid';
  options: PaidVoteTallyRow[];
  resolved: boolean;
  resolvedOptionKey: string | null;
};

export interface PaidSupportVoteStore {
  tally(userId: string, channelId: string, definitionId: string): Promise<PaidVoteTally | null>;
}

// Overlay browser-source read — same overlay_sessions/token-fingerprint
// scoping as every other overlay read in this codebase (see
// db/interaction-sql-store.ts's createSqlInteractionOverlayStore). No new
// auth path.
export interface PaidVoteOverlayStore {
  getPaidVoteTally(token: string, overlayId: string, definitionId: string): Promise<PaidVoteTally | null>;
}
