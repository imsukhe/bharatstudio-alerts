export type AlertAccepted = {
  schemaVersion: 'v1';
  eventId: string;
  traceId: string;
  status: 'accepted' | 'held';
};

export type HistoryItem = {
  eventId: string;
  sourceType: 'payment' | 'manual' | 'companion';
  status: string;
  createdAt: string;
  grossAmountPaise: number | null;
  currency: 'INR' | null;
  displayName: string | null;
  message: string | null;
};

export type BillingView = {
  schemaVersion: 'v1';
  channelId: string;
  tier: 'free' | 'pro' | 'creator' | 'studio';
  monthlyPricePaise: number;
  // 1/1 for a monthly subscription, 10/12 for annual — matches
  // channel_subscriptions.charged_months/service_months exactly (see
  // packages/db/migrations/0048's CHECK constraint); not a literal 10/12.
  annualMonthsCharged: number;
  annualServiceMonths: number;
  renewalState: 'not_applicable' | 'active' | 'past_due' | 'cancelled';
  nextRenewalAt: string | null;
  billingInterval: 'monthly' | 'annual';
  autoRenew: boolean;
  currentPeriodEndsAt: string | null;
  priceProtectedUntil: string | null;
  priceSource: 'current' | 'grandfathered';
};

export type EntitlementView = {
  schemaVersion: 'v1';
  channelId: string;
  tier: 'free' | 'pro' | 'creator' | 'studio';
  source: 'individual_plan';
  entitlementVersion: number;
  values: Record<string, unknown>;
};

export type CompanionState = {
  schemaVersion: 'v1';
  channelId: string;
  overlayConnected: boolean;
  pendingAlerts: number;
  lastUpdatedAt: string;
  // L24 activation signals (0093). Each answers "is this action group's
  // target actually live right now", independent of entitlement.
  helperPaired: boolean; // a desktop helper currently holds a valid, unexpired control-session lease
  obsConnected: boolean; // that helper's most recent OBS heartbeat is fresh (<= 45s old) and says connected; a stale or missing heartbeat reads false
  obsStatusReportedAt: string | null; // the heartbeat timestamp itself (may be stale relative to now -- see obsConnected), null if never reported
  paymentAccountConnected: boolean; // an active payment account exists for this channel (payment_accounts; not duplicated here)
  // Mirror and Stream live in other repos and report no liveness signal to
  // this API today. Modelled honestly as always false (never omitted) --
  // see packages/db/migrations/0093's header comment.
  mirrorReachable: boolean;
  streamPaired: boolean;
};

export type CompanionActionSlot = {
  slotIndex: number;
  page: number;
  label: string;
  action: CompanionAction;
  targetId: string;
};

export type CompanionLayout = {
  schemaVersion: 'v1';
  channelId: string;
  version: number;
  tier: 'free' | 'pro' | 'creator' | 'studio';
  maxSlots: number;
  pageSize: 4 | 8 | 16;
  slots: CompanionActionSlot[];
  createdAt: string | null;
};

export type CompanionControlSession = {
  schemaVersion: 'v1';
  sessionId: string;
  channelId: string;
  clientType: 'web' | 'mobile' | 'desktop';
  clientInstanceId: string;
  leaseUntil: string;
  createdAt: string;
  reused: boolean;
};

// Companion v1 exposes only actions with an implemented server-side effect.
// Alert approve/hold/replay remain on the moderation route until their
// Companion-specific target and transition semantics are implemented.
// The full 17-action catalogue (migration 0089's
// `companion_commands_v1_action_check` CHECK constraint and
// `app_private.companion_action_group()`). This union was stuck at the
// original three 'alerts' verbs long after 0089 widened the database, which
// forced `apps/api/src/routes/companion.ts` to launder every other action
// through `as unknown as CompanionAction` -- a compile-time lie that also
// hid a real typing error in the OpenAPI conformance test. The database
// CHECK remains the enforcement; this type now simply tells the truth about
// what the enforcement allows.
export type CompanionAction =
  | 'pause_queue' | 'resume_queue' | 'send_test_alert'
  | 'obs_set_scene' | 'obs_toggle_source' | 'obs_toggle_mute'
  | 'obs_start_stream' | 'obs_stop_stream' | 'obs_start_record' | 'obs_stop_record'
  | 'obs_save_replay_buffer' | 'obs_set_transition'
  | 'mirror_start' | 'mirror_stop' | 'mirror_screenshot'
  | 'stream_go_live' | 'stream_end';

export type CompanionActionResult = {
  schemaVersion: 'v1';
  commandId: string;
  status: 'accepted' | 'rejected';
  acceptedAt: string;
  eventId?: string;
};

export interface AlertStore {
  createTestAlert(userId: string, channelId: string, displayName: string, message: string, queueIds: string[] | undefined): Promise<AlertAccepted>;
  listHistory(userId: string, channelId: string, cursor: string | undefined, pageSize: number): Promise<{ items: HistoryItem[]; nextCursor: string | null }>;
  moderate(userId: string, channelId: string, eventId: string, action: 'approve' | 'hold' | 'suppress' | 'replay', reason: string | null): Promise<{ eventId: string; action: string; appliedAt: string } | null>;
  getBilling(userId: string, channelId: string): Promise<BillingView | null>;
  getEntitlements(userId: string, channelId: string): Promise<EntitlementView | null>;
  getCompanionState(userId: string, channelId: string): Promise<CompanionState | null>;
  getCompanionLayout(userId: string, channelId: string): Promise<CompanionLayout | null>;
  updateCompanionLayout(userId: string, channelId: string, expectedVersion: number, pageSize: 4 | 8 | 16, slots: CompanionActionSlot[]): Promise<CompanionLayout | null>;
  acquireCompanionControlSession(userId: string, channelId: string, clientType: CompanionControlSession['clientType'], clientInstanceId: string): Promise<CompanionControlSession>;
  revokeCompanionControlSession(userId: string, channelId: string, sessionId: string): Promise<boolean>;
  executeCompanionAction(userId: string, channelId: string, action: CompanionAction, targetId: string | null, idempotencyKey: string): Promise<CompanionActionResult>;
  // Desktop-helper self-report of local OBS connection state (0093). No
  // userId parameter: this is authenticated by the control session's own
  // id, not the bearer/session-cookie auth every other method here uses --
  // see companion.ts and migration 0093 for why. Returns false when
  // sessionId is not a currently-valid desktop session on channelId (also
  // true for a session that belongs to a *different* channel), so this can
  // never report on behalf of another channel's helper.
  reportCompanionObsConnection(channelId: string, sessionId: string, connected: boolean): Promise<boolean>;
}
