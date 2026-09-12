import type { ViewerProfileStore } from './viewer-profile-store.js';

export type ViewerSessionPrincipal = { sessionId: string; viewerAccountId: string; expiresAt: string };

export type ViewerSessionSummary = {
  sessionId: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  deviceLabel: string | null;
};

export type ViewerDashboardRow = {
  channelId: string;
  channelHandle: string;
  channelDisplayName: string;
  firstSupportedAt: string;
  lastSupportedAt: string;
  lifetimeAmountPaise: string;
  tipCount: string;
  challengeCount: string;
  memberState: 'none' | 'active' | 'lapsed';
};

export type ViewerDeletionResult = {
  schemaVersion: 'v1';
  erased: string[];
  retained: string[];
  legalDispositionOpen: true;
};

export type ViewerSignupResult = { accessToken: string; viewerAccountId: string; expiresAt: string };

// L14 missing-slice re-export: kept in domain/viewer-profile-store.ts by
// task ownership boundary, composed into ViewerStore below exactly like
// ViewerPasswordResetStore already is (db/viewer-store.ts composes it in,
// since index.ts's createSqlViewerStore(sql) call site is frozen).
export type {
  ClaimOutcome,
  ClaimResult,
  PublicProfileSummary,
  ReceiptMintResult,
  ResolvedReceipt,
  ViewerChannelBadges,
  ViewerProfileStore,
} from './viewer-profile-store.js';

/**
 * Backend half of L14 Level 3 identity. Deliberately narrow: signup, login,
 * session lifecycle, the viewer's own cross-creator dashboard, and DPDP-style
 * deletion. Platform-account OAuth linking/historical claiming, badges and
 * streaks are out of this batch's scope (see L14 task's own boundary — those
 * are gated on L15 connectors landing per-provider).
 */
export interface ViewerStore {
  signup(email: string, password: string, displayName: string | undefined, deviceLabel: string): Promise<ViewerSignupResult>;
  login(email: string, password: string, deviceLabel: string): Promise<ViewerSignupResult | null>;
  lookup(accessToken: string): Promise<ViewerSessionPrincipal | null>;
  listSessions(viewerAccountId: string): Promise<ViewerSessionSummary[]>;
  revokeSession(viewerAccountId: string, sessionId: string): Promise<boolean>;
  getDashboard(viewerAccountId: string): Promise<ViewerDashboardRow[]>;
  requestDeletion(viewerAccountId: string): Promise<ViewerDeletionResult>;
  // Batch 3 addition — see domain/viewer-reset-store.ts's ViewerPasswordResetStore
  // for the full contract these two delegate to (db/viewer-store.ts composes
  // it in, since index.ts's createSqlViewerStore(sql) call site is frozen).
  requestPasswordReset(email: string): Promise<void>;
  resetPassword(token: string, newPassword: string): Promise<boolean>;
  // L14 missing-slice addition (receipt, claim, badges, public profile) —
  // composed from ViewerProfileStore the same way the two methods above
  // are composed from ViewerPasswordResetStore. Optional so every existing
  // hand-built test ViewerStore (which predates this addition) keeps
  // compiling unchanged — routes below check for its presence exactly
  // like they already check for `viewer` itself.
  profile?: ViewerProfileStore;
}
