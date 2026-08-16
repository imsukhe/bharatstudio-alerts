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
export type CompanionAction = 'pause_queue' | 'resume_queue' | 'send_test_alert';

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
}
