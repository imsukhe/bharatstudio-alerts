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

// Admin entitlement management — "an operable surface to view/update the
// entitlement registry values introduced under L03/L04, with audit
// history". Deliberately scoped to per-channel support overrides, not a
// bulk tier-value editor — see packages/db/migrations/
// 0074_v1_l03_admin_entitlement_management.sql for why: tier_queue_count()
// stays fixed/code-owned, same care as recurring_price_paise, so an
// accidental edit can never silently change what every creator on a tier
// is charged or entitled to.
export type ChannelEntitlementAdminView = {
  channelId: string;
  channelHandle: string;
  version: number;
  tier: string;
  source: 'individual_plan' | 'admin_override';
  values: Record<string, unknown>;
  effectiveAt: string;
};

export type ChannelEntitlementHistoryEntry = {
  version: number;
  tier: string;
  source: 'individual_plan' | 'admin_override';
  values: Record<string, unknown>;
  effectiveAt: string;
  createdAt: string;
};

export interface AdminStore {
  isPlatformAdmin(userId: string): Promise<boolean>;
  listDlq(userId: string, status: DlqStatusFilter, limit: number): Promise<DlqEntry[]>;
  // Returns null when the delivery does not exist or is not in a
  // replayable/discardable state — the route maps that to 404, never a
  // 5xx, since it is a legitimate outcome (e.g. a double-submitted action).
  replayDlqDelivery(userId: string, deliveryId: string, reason: string | null): Promise<DlqActionResult | null>;
  discardDlqDelivery(userId: string, deliveryId: string, reason: string): Promise<DlqActionResult | null>;
  // Returns null when the channel has no entitlement history at all
  // (should not happen in practice — create_channel always seeds a free
  // entitlement version — but a not-found channel must not 500).
  getChannelEntitlement(userId: string, channelId: string): Promise<ChannelEntitlementAdminView | null>;
  listChannelEntitlementHistory(userId: string, channelId: string, limit: number): Promise<ChannelEntitlementHistoryEntry[]>;
  // Returns null specifically when the channel does not exist — the route
  // maps that to 404; every other failure (a real DB/connectivity error)
  // propagates and is mapped to 503, not misreported as "not found".
  overrideChannelEntitlement(userId: string, channelId: string, queueCount: number, reason: string): Promise<ChannelEntitlementAdminView | null>;
}
