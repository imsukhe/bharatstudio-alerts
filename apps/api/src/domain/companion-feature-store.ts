// L07 Companion remaining feature list (master plan 7.11 items 2, 5, 8-10).
//
// New, additive interface -- deliberately NOT a change to
// apps/api/src/domain/alert-store.ts (unowned by this task; see this
// task's file-ownership boundary). `buildApp` and the production entrypoint
// now provide the SQL-backed dependency. It remains optional only for focused
// callers; routes fail closed with `503 companion_store_unavailable` if a
// caller intentionally omits it.

export type CompanionTtsMuteState = {
  schemaVersion: 'v1';
  queueId: string;
  ttsMuted: boolean;
  ttsMutedAt: string | null;
};

export type CompanionTtsCancelResult = {
  schemaVersion: 'v1';
  deliveryId: string;
  eventId: string;
  status: 'tts_cancelled';
  cancelledAt: string;
};

export type CompanionTestReportHop = {
  hop: string;
  status: string;
  occurredAt: string | null;
  detail: string | null;
};

export type CompanionTestReport = {
  schemaVersion: 'v1';
  channelId: string;
  eventId: string;
  hops: CompanionTestReportHop[];
};

export type CompanionPaymentStatusItem = {
  paymentId: string;
  status: string;
  grossAmountPaise: number;
  currency: string;
  refundStatus: string | null;
  refundAmountPaise: number | null;
  createdAt: string;
  updatedAt: string;
};

export type CompanionPaymentStatusView = {
  schemaVersion: 'v1';
  channelId: string;
  items: CompanionPaymentStatusItem[];
};

export type CompanionRecentTipItem = {
  eventId: string;
  displayName: string | null;
  message: string | null;
  grossAmountPaise: number | null;
  currency: string | null;
  createdAt: string;
};

export type CompanionRecentTipsView = {
  schemaVersion: 'v1';
  channelId: string;
  items: CompanionRecentTipItem[];
};

export interface CompanionFeatureStore {
  // Mute is forward-looking and per-queue (item 5, half 1): affects
  // deliveries not yet dispatched. Distinct from cancel below -- see
  // migration 0098's header comment.
  setCompanionTtsMuted(userId: string, channelId: string, queueId: string, muted: boolean): Promise<CompanionTtsMuteState>;
  // Cancel is a one-shot transition of one specific in-flight delivery
  // (item 5, half 2): affects only the targeted delivery, never the
  // queue's future deliveries. Returns null when the target delivery does
  // not exist in this channel or is not currently cancellable (not
  // 'ready'/'displayed').
  cancelCompanionTts(userId: string, channelId: string, deliveryId: string): Promise<CompanionTtsCancelResult | null>;
  // Hop-by-hop report for one event already created via the existing
  // 'send_test_alert' Companion action (item 2). Does not create the
  // event itself -- the caller (companion.ts) creates it first via the
  // existing AlertStore.executeCompanionAction, then asks for the report.
  getCompanionTestReport(userId: string, channelId: string, eventId: string): Promise<CompanionTestReport | null>;
  // Read-only, finance-role-gated (item 9-10).
  getCompanionPaymentStatus(userId: string, channelId: string, limit: number): Promise<CompanionPaymentStatusView>;
  // Read-only, donor-visibility-scoped (item 8).
  getCompanionRecentTips(userId: string, channelId: string, limit: number): Promise<CompanionRecentTipsView>;
}
