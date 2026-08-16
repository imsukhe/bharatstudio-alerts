// Admin DLQ tooling — "v1 scope addendum — 2026-08-16": cross-channel
// quarantined/held alert-event review, replay (including content_flagged
// release) and terminal discard, for platform admins. API-only, no admin
// UI — matching BharatStudio Alerts legacy's own scope boundary for this
// exact feature. See packages/db/migrations/0073_v1_l03_admin_dlq_tooling.sql
// for the reachability decisions (which delivery states are genuinely
// reachable today) this type set reflects.
export type DlqStatusFilter = 'held' | 'suppressed' | 'quarantined_outbox' | 'all';

export type DlqEntry = {
  deliveryId: string;
  eventId: string;
  channelId: string;
  channelHandle: string;
  queueId: string;
  status: string;
  holdReason: string | null;
  attemptCount: number;
  lastErrorCode: string | null;
  createdAt: string;
  updatedAt: string;
};

export type DlqActionResult = {
  deliveryId: string;
  status: string;
};

export interface AdminStore {
  isPlatformAdmin(userId: string): Promise<boolean>;
  listDlq(userId: string, status: DlqStatusFilter, limit: number): Promise<DlqEntry[]>;
  // Returns null when the delivery does not exist or is not in a
  // replayable/discardable state — the route maps that to 404, never a
  // 5xx, since it is a legitimate outcome (e.g. a double-submitted action).
  replayDlqDelivery(userId: string, deliveryId: string, reason: string | null): Promise<DlqActionResult | null>;
  discardDlqDelivery(userId: string, deliveryId: string, reason: string): Promise<DlqActionResult | null>;
}
