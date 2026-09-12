// L14 missing-slice types: no-account receipt, platform-identity claiming,
// live-derived badges/streaks, opt-in public profile search. Separate file
// from domain/viewer-store.ts by task boundary (new files prefixed
// "viewer-profile-"); composed into ViewerStore the same way
// domain/viewer-reset-store.ts's ViewerPasswordResetStore already is (see
// db/viewer-store.ts).

export type ReceiptMintResult = { minted: true; token: string } | { minted: false };

export type ResolvedReceipt = {
  channelHandle: string;
  channelDisplayName: string;
  grossAmountPaise: string;
  refundedAmountPaise: string;
  netAmountPaise: string;
  currency: 'INR';
  donorDisplayName: string | null;
  message: string | null;
  paymentStatus: string;
  paidAt: string;
};

export type ClaimResult = 'claimed' | 'already_claimed_by_self' | 'rejected_contested';

export type ClaimOutcome = {
  viewerIdentityId: string;
  result: ClaimResult;
};

export type ViewerChannelBadges = {
  netTipCount: string;
  netLifetimeAmountPaise: string;
  firstSupportedAt: string | null;
  currentStreakDays: number;
  badges: string[];
};

export type PublicProfileSummary = {
  displayName: string | null;
  profileSlug: string;
};

export interface ViewerProfileStore {
  // Public, no-account receipt. `intentId` is payment_order_intents.id —
  // the "orderId" the payer's own browser already polls via GET
  // /v1/public/payment-status (domain/public-payment-status.ts) — never a
  // secret. Idempotent-by-payment: a second mint attempt for an
  // already-minted payment returns { minted: false } rather than a second
  // live token (see migration 0107's find_payment_id_for_intent/
  // create_payment_receipt header comments).
  mintReceipt(intentId: string): Promise<ReceiptMintResult>;
  resolveReceipt(token: string): Promise<ResolvedReceipt | null>;

  // Platform-identity claim. Assumes the caller already completed L15's
  // YouTube OAuth verification and is passing a server-verified
  // providerUserId — this store performs no OAuth handshake itself.
  claimPlatformIdentity(viewerAccountId: string, provider: 'youtube', providerUserId: string, displayName?: string): Promise<ClaimOutcome>;

  getChannelBadges(viewerAccountId: string, channelId: string): Promise<ViewerChannelBadges>;

  searchPublicProfiles(query: string | null): Promise<PublicProfileSummary[]>;
  getPublicProfile(slug: string): Promise<PublicProfileSummary | null>;
  setProfileVisibility(viewerAccountId: string, visibility: 'private' | 'public', slug: string | null): Promise<{ visibility: 'private' | 'public'; slug: string | null }>;
}
